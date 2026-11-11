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
import warnings

from backend_py.server import create_server, read_config
from backend_py.key_input import KeyDialogUnavailable, read_masked_key


ROOT = Path(__file__).resolve().parent
WINDOWS_KEY_DIALOG = os.name == "nt"
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


def api_key_input_error(value: str) -> str | None:
    """Describe only the input problem; never include any part of a credential."""
    if not value:
        return "No key was entered. Paste the complete new key before pressing Enter."
    if any(ord(char) < 32 or ord(char) == 127 for char in value):
        return "A control character was received. Use your terminal's Paste command instead of Ctrl+V."
    if any(char.isspace() for char in value):
        return "The input contains spaces. Paste only the complete key, without other text."
    if any(char in value for char in "\"'`"):
        return "Remove quotes or backticks; paste only the complete key."
    if "*" in value or "..." in value or "\u2026" in value:
        return "This looks like a masked or shortened key. Copy the complete secret when you create it."
    if (not value.startswith("sk-") or len(value) < 20
            or value.lower() in {"sk-your-openai-api-key", "sk-your-api-key-here"}):
        return "The local format check failed. Copy the complete OpenAI secret key from the key-creation dialog."
    return None


def valid_api_key(value: str) -> bool:
    """Only a local format check; provider acceptance is checked on a real edit."""
    return api_key_input_error(value) is None


def prompt_api_key(*, console_key: bool = False) -> str:
    use_dialog = WINDOWS_KEY_DIALOG and not console_key
    if use_dialog:
        print("A separate Locket AI key window will open. Paste with Ctrl+V, then click OK; Cancel stops startup.", flush=True)
    else:
        print("Paste the complete new key; input is masked with *. Press Ctrl+C to cancel.", flush=True)
        print("Use the terminal's Paste command. Windows users can reopen without --console-key for a key window.", flush=True)
    problem = None
    for attempt in range(3):
        if use_dialog:
            try:
                candidate = read_masked_key(problem=problem)
            except KeyDialogUnavailable:
                raise LauncherError("The key window could not open. Check Python's Tcl/Tk installation; --console-key explicitly selects terminal input.") from None
            if candidate is None:
                raise EOFError()
        else:
            try:
                with warnings.catch_warnings():
                    # Stop before getpass can fall back to echoing the secret.
                    warnings.simplefilter("error", getpass.GetPassWarning)
                    candidate = getpass.getpass("Enter a fresh OpenAI API key (masked): ", echo_char="*")
            except getpass.GetPassWarning:
                raise LauncherError("Secure key input is unavailable. Reopen Start-Locket-Backend.cmd in a terminal.") from None
        candidate = candidate.strip()
        problem = api_key_input_error(candidate)
        if problem is None:
            return candidate
        del candidate
        print(problem, flush=True)
        if attempt < 2:
            print("Please try again. No API request was made.", flush=True)
    raise LauncherError("No valid key was entered after three attempts. Reopen the launcher to try again; no key was saved.")


def prepare_credentials(env: dict[str, str], *, no_prompt: bool, console_key: bool = False) -> None:
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
    if use_existing and not valid_api_key(env["OPENAI_API_KEY"]):
        print("The existing environment key failed the local format check. Enter a fresh key below.", flush=True)
        use_existing = False
    if not use_existing:
        env.pop("OPENAI_API_KEY", None)
        env["OPENAI_API_KEY"] = prompt_api_key(console_key=console_key)
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
    parser.add_argument("--console-key", action="store_true", help="Explicitly enter the API key in the terminal instead of the Windows key window.")
    args = parser.parse_args(argv)
    tunnel = server = None
    try:
        env = dict(os.environ)
        load_public_settings(ROOT / ".env", env)
        env.setdefault("HOST", "127.0.0.1")
        env.setdefault("DATA_DIR", str(ROOT / "data" / "generated"))
        prepare_credentials(env, no_prompt=args.no_prompt, console_key=args.console_key)
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
