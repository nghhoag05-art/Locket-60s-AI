"""Local Windows launcher; credentials stay in this process's environment."""

from __future__ import annotations

import argparse
import getpass
import os
from pathlib import Path
import queue
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time

from backend_py.server import create_server, read_config


ROOT = Path(__file__).resolve().parent
SECRET_NAMES = frozenset({"OPENAI_API_KEY", "GEMINI_API_KEY", "BACKEND_ACCESS_TOKEN"})
PUBLIC_SETTINGS = frozenset({
    "HOST", "PORT", "PUBLIC_BASE_URL", "OPENAI_IMAGE_MODEL", "DATA_DIR",
    "INPUT_IMAGE_HOSTS", "IMAGE_TTL_SECONDS", "RATE_LIMIT_PER_MINUTE",
    "MAX_CONCURRENT", "DOWNLOAD_TIMEOUT_MS", "PROVIDER_TIMEOUT_MS", "MAX_IMAGE_BYTES",
})
TUNNEL_URL = re.compile(
    r"https://[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com"
    r"(?![a-zA-Z0-9._:@%/-])"
)


class LauncherError(ValueError):
    """A safe, credential-free message suitable for the user's console."""


def load_public_settings(path: Path, env: dict[str, str]) -> None:
    """Read simple dotenv assignments, without interpolation or secret storage."""
    if not path.is_file():
        return
    for number, line in enumerate(path.read_text(encoding="utf-8-sig").splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        name, separator, value = line.partition("=")
        name, value = name.strip(), value.strip()
        if not separator or not re.fullmatch(r"[A-Z][A-Z0-9_]*", name):
            raise LauncherError(f"Invalid .env assignment on line {number}.")
        if value.startswith(("'", '"')):
            match = re.fullmatch(r"(['\"])(.*?)\1(?:\s+#.*)?", value)
            if not match:
                raise LauncherError(f"Invalid .env quoting on line {number}.")
            value = match.group(2)
        else:
            value = value.split(" #", 1)[0].rstrip()
        if name in SECRET_NAMES:
            if value:
                raise LauncherError(f"Remove {name} from .env; use the hidden prompt or process environment.")
            continue
        if name not in PUBLIC_SETTINGS:
            raise LauncherError(f"Unsupported public setting {name} on line {number}.")
        env.setdefault(name, value)


def valid_api_key(value: str) -> bool:
    """Only a local format check; provider acceptance is checked on a real edit."""
    return (value.startswith("sk-") and len(value) >= 20
            and not any(char.isspace() or ord(char) < 32 or ord(char) == 127 for char in value)
            and value.lower() not in {"sk-your-openai-api-key", "sk-your-api-key-here"})


def prepare_credentials(env: dict[str, str], *, no_prompt: bool) -> None:
    token = env.get("BACKEND_ACCESS_TOKEN", "")
    if token and not re.fullmatch(r"[A-Za-z0-9._~+/-]{24,256}={0,2}", token):
        raise LauncherError("BACKEND_ACCESS_TOKEN must be a 24-256 character bearer token compatible with Shadowrocket.")
    if no_prompt:
        return
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        raise LauncherError("Open this launcher in a terminal, or use --no-prompt with environment settings.")
    use_existing = bool(env.get("OPENAI_API_KEY"))
    if use_existing:
        use_existing = input("Use OPENAI_API_KEY already in the environment? [Y/n]: ").strip().lower() in ("", "y", "yes")
    if not use_existing:
        key = getpass.getpass("Enter a fresh OpenAI API key (hidden): ").strip()
        env["OPENAI_API_KEY"] = key
    if not valid_api_key(env["OPENAI_API_KEY"]):
        raise LauncherError("The API key format is invalid; the key was not displayed or saved.")
    if not env.get("BACKEND_ACCESS_TOKEN"):
        env["BACKEND_ACCESS_TOKEN"] = secrets.token_urlsafe(32)
        print("\nCopy this backend token into Shadowrocket; it is shown once for this session:", flush=True)
        print(env["BACKEND_ACCESS_TOKEN"], flush=True)
    if not re.fullmatch(r"[A-Za-z0-9._~+/-]{24,256}={0,2}", env["BACKEND_ACCESS_TOKEN"]):
        raise LauncherError("BACKEND_ACCESS_TOKEN must be a 24-256 character bearer token compatible with Shadowrocket.")


def parse_tunnel_url(line: str) -> str | None:
    match = TUNNEL_URL.search(line)
    return match.group(0) if match else None


def tunnel_environment(env: dict[str, str]) -> dict[str, str]:
    return {name: value for name, value in env.items() if name.upper() not in SECRET_NAMES}


class QuickTunnel:
    """Own only the cloudflared process created by this launcher."""

    def __init__(self, env: dict[str, str], timeout: float = 40):
        executable = shutil.which("cloudflared")
        fallback = Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / "cloudflared" / "cloudflared.exe"
        if not executable and fallback.is_file():
            executable = str(fallback)
        if not executable:
            raise LauncherError("cloudflared was not found. Install it or start without --tunnel.")
        try:
            self.process = subprocess.Popen(
                [executable, "tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:8787"],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                text=True, encoding="utf-8", errors="replace", bufsize=1,
                env=tunnel_environment(env),
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            )
        except OSError:
            raise LauncherError("Could not start cloudflared. Check its installation and execution permissions.") from None
        found: queue.Queue[str] = queue.Queue(maxsize=1)

        def drain():
            try:
                while line := self.process.stdout.readline(8192):
                    url = parse_tunnel_url(line)
                    if url:
                        try:
                            found.put_nowait(url)
                        except queue.Full:
                            pass
            except (OSError, ValueError):
                pass

        self.reader = threading.Thread(target=drain, daemon=True, name="cloudflared-output")
        self.reader.start()
        deadline = time.monotonic() + timeout
        try:
            while time.monotonic() < deadline:
                if self.process.poll() is not None:
                    raise LauncherError("cloudflared stopped before the tunnel was ready. Check your Internet connection.")
                try:
                    self.url = found.get(timeout=min(0.25, max(0.01, deadline - time.monotonic())))
                    return
                except queue.Empty:
                    pass
            raise LauncherError("Timed out waiting for cloudflared's public URL. Check your Internet connection.")
        except BaseException:
            self.close()
            raise

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        self.reader.join(timeout=1)
        # A blocked daemon reader must never hold up launcher shutdown.
        if not self.reader.is_alive() and self.process.stdout is not None:
            self.process.stdout.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run the local Locket AI backend (Python 3.14).")
    parser.add_argument("--no-prompt", action="store_true", help="Use existing environment settings without prompting or generating credentials.")
    parser.add_argument("--tunnel", action="store_true", help="Start a public Cloudflare Quick Tunnel for this session.")
    args = parser.parse_args(argv)
    tunnel = server = None
    try:
        env = dict(os.environ)
        load_public_settings(ROOT / ".env", env)
        env.setdefault("HOST", "127.0.0.1")
        env.setdefault("DATA_DIR", str(ROOT / "data" / "generated"))
        prepare_credentials(env, no_prompt=args.no_prompt)
        config = read_config(env)
        if args.tunnel:
            if config.host != "127.0.0.1" or config.port != 8787:
                raise LauncherError("--tunnel requires HOST=127.0.0.1 and PORT=8787.")
            tunnel = QuickTunnel(env)
            env["PUBLIC_BASE_URL"] = tunnel.url
            config = read_config(env)
        server = create_server(config=config)
        print(f"Locket backend: http://127.0.0.1:{server.server_port}/health", flush=True)
        if tunnel:
            print(f"Shadowrocket backend URL: {tunnel.url}", flush=True)
        if not config.configured:
            print("AI editing is not configured. Set OPENAI_API_KEY, BACKEND_ACCESS_TOKEN and PUBLIC_BASE_URL.", flush=True)
        print("Keep this window open. Press Ctrl+C to stop.", flush=True)
        server.serve_forever(poll_interval=0.5)
        return 0
    except (KeyboardInterrupt, EOFError):
        return 0
    except LauncherError as error:
        print(f"Startup failed: {error}", file=sys.stderr)
        return 1
    except (OSError, ValueError):
        # Do not echo exception text: OS errors can contain sensitive environment values.
        print("Startup failed. Check public .env settings, API key format, token, port and cloudflared installation/Internet connection.", file=sys.stderr)
        return 1
    finally:
        try:
            if server is not None:
                server.server_close()
        finally:
            if tunnel is not None:
                tunnel.close()


if __name__ == "__main__":
    raise SystemExit(main())
