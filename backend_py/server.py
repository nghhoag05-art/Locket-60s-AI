"""Run with ``python -m backend_py.server``. No third-party packages required.

Secrets are read exclusively from the supplied environment. Importing this module
does not read .env files, start a listener, or make network requests.
"""

from __future__ import annotations

import base64
from collections import deque
from dataclasses import dataclass, field
import hmac
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
import os
from pathlib import Path
import queue
import re
import socket
import ssl
import threading
import time
from typing import Mapping
from urllib.parse import urlsplit

from .storage import FileImageStore, image_type


MIB = 1024 * 1024
DEFAULT_HOSTS = ("firebasestorage.googleapis.com", "storage.googleapis.com", "cdn.locketcamera.com")
OPENAI_EDIT_URL = "https://api.openai.com/v1/images/edits"
DNS_NAME = re.compile(r"(?=.{1,253}\Z)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?\Z")


class AppError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def fail(status: int, code: str, message: str):
    raise AppError(status, code, message)


def _integer(env, name, default, minimum, maximum):
    value = env.get(name, "")
    if value == "":
        return default
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]+", value):
        raise ValueError(f"Invalid {name}")
    number = int(value)
    if not minimum <= number <= maximum:
        raise ValueError(f"Invalid {name}")
    return number


def _dns_name(value: str) -> bool:
    try:
        ipaddress.ip_address(value)
        return False
    except ValueError:
        return bool(DNS_NAME.fullmatch(value)) and value != "localhost" and not value.endswith(".localhost")


def _split_https(value: str):
    if not isinstance(value, str) or not value or re.search(r"[\x00-\x20\x7f\\]", value):
        raise ValueError("Invalid HTTPS URL")
    parts = urlsplit(value)
    # Explicit ports, including :443, and even empty query/fragment delimiters
    # are rejected for origins. Image query strings remain supported below.
    if (parts.scheme != "https" or not parts.netloc or not parts.hostname
            or parts.username is not None or parts.password is not None
            or ":" in parts.netloc or "@" in parts.netloc
            or not _dns_name(parts.hostname.lower())):
        raise ValueError("Invalid HTTPS URL")
    return parts


def _public_origin(value: str) -> str:
    if not value:
        return ""
    try:
        parts = _split_https(value)
        if parts.path not in ("", "/") or "?" in value or "#" in value:
            raise ValueError()
    except (ValueError, TypeError):
        raise ValueError("PUBLIC_BASE_URL must be an HTTPS DNS origin without port, credentials, path, query or fragment") from None
    return f"https://{parts.hostname.lower()}"


@dataclass(frozen=True)
class Config:
    host: str = "127.0.0.1"
    port: int = 8787
    api_key: str = field(default="", repr=False)
    access_token: str = field(default="", repr=False)
    public_base_url: str = ""
    model: str = "gpt-image-2.5-flare"
    allowed_hosts: tuple[str, ...] = DEFAULT_HOSTS
    data_dir: Path = field(default_factory=lambda: Path("data/generated").resolve())
    max_image_bytes: int = 10 * MIB
    max_body_bytes: int = 16 * 1024
    max_provider_bytes: int = 32 * MIB
    download_timeout: float = 8
    provider_timeout: float = 32
    image_ttl_seconds: int = 900
    rate_limit: int = 3
    max_concurrent: int = 1

    @property
    def configured(self) -> bool:
        return bool(self.api_key.strip() and len(self.access_token) >= 24 and self.public_base_url)


def read_config(env: Mapping[str, str] | None = None) -> Config:
    env = os.environ if env is None else env
    hosts = tuple(host.strip().lower() for host in env.get("INPUT_IMAGE_HOSTS", ",".join(DEFAULT_HOSTS)).split(",") if host.strip())
    if not hosts or any(not _dns_name(host) for host in hosts):
        raise ValueError("INPUT_IMAGE_HOSTS must contain exact trusted DNS hostnames")
    model = env.get("OPENAI_IMAGE_MODEL", "gpt-image-2.5-flare")
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,100}", model):
        raise ValueError("Invalid OPENAI_IMAGE_MODEL")
    api_key = env.get("OPENAI_API_KEY", "")
    token = env.get("BACKEND_ACCESS_TOKEN", "")
    if any(char in api_key + token for char in "\r\n\x00"):
        raise ValueError("Invalid credential format")
    host = env.get("HOST", "127.0.0.1")
    if not host or re.search(r"[\x00-\x20\x7f]", host):
        raise ValueError("Invalid HOST")
    return Config(
        host=host, port=_integer(env, "PORT", 8787, 0, 65535),
        api_key=api_key, access_token=token,
        public_base_url=_public_origin(env.get("PUBLIC_BASE_URL", "")), model=model,
        allowed_hosts=hosts, data_dir=Path(env.get("DATA_DIR", "./data/generated")).resolve(),
        max_image_bytes=_integer(env, "MAX_IMAGE_BYTES", 10 * MIB, 1024, 20 * MIB),
        download_timeout=_integer(env, "DOWNLOAD_TIMEOUT_MS", 8000, 100, 8000) / 1000,
        provider_timeout=_integer(env, "PROVIDER_TIMEOUT_MS", 32000, 100, 35000) / 1000,
        image_ttl_seconds=_integer(env, "IMAGE_TTL_SECONDS", 900, 30, 86400),
        rate_limit=_integer(env, "RATE_LIMIT_PER_MINUTE", 3, 1, 60),
        max_concurrent=_integer(env, "MAX_CONCURRENT", 1, 1, 4),
    )


def is_public_address(address: str) -> bool:
    try:
        ip = ipaddress.ip_address(address)
        if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
            ip = ip.ipv4_mapped
        return ip.is_global and not ip.is_multicast and not ip.is_reserved and not ip.is_unspecified
    except ValueError:
        return False


def resolve_public_addresses(host: str, timeout: float = 2) -> tuple[str, ...]:
    """Bound DNS waiting and fail closed if any answer is not public."""
    output = queue.Queue(maxsize=1)

    def lookup():
        try:
            output.put(tuple(dict.fromkeys(item[4][0] for item in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM))))
        except Exception:
            output.put(None)

    threading.Thread(target=lookup, daemon=True).start()
    try:
        addresses = output.get(timeout=max(0.001, timeout))
    except queue.Empty:
        addresses = None
    if not addresses:
        fail(400, "image_dns_failed", "The image host could not be resolved.")
    if any(not is_public_address(address) for address in addresses):
        fail(400, "unsafe_image_host", "The image host must resolve to public addresses.")
    return addresses


@dataclass(frozen=True)
class ValidatedUrl:
    url: str
    hostname: str
    addresses: tuple[str, ...]


def validate_input_url(value: str, config: Config, resolver=resolve_public_addresses, timeout=2) -> ValidatedUrl:
    try:
        parts = _split_https(value)
    except (ValueError, TypeError):
        fail(400, "unsafe_image_url", "The image URL must use an approved HTTPS image host.")
    host = parts.hostname.lower()
    if "#" in value or host not in config.allowed_hosts:
        fail(400, "unsafe_image_url", "The image URL must use an approved HTTPS image host.")
    try:
        addresses = tuple(resolver(host, timeout))
    except AppError:
        raise
    except Exception:
        fail(400, "image_dns_failed", "The image host could not be resolved.")
    if not addresses or any(not is_public_address(address) for address in addresses):
        fail(400, "unsafe_image_host", "The image host must resolve to public addresses.")
    return ValidatedUrl(value, host, addresses)


@dataclass(frozen=True)
class Response:
    status: int
    headers: Mapping[str, str]
    body: bytes


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    """Connect to a validated address, preserving TLS SNI/certificate checks."""
    def __init__(self, host, addresses, deadline):
        super().__init__(host, timeout=max(0.001, deadline - time.monotonic()), context=ssl.create_default_context())
        self.addresses, self.deadline = addresses, deadline
        self._active_socket = None

    def connect(self):
        last_error = None
        for address in self.addresses:
            raw = None
            try:
                remaining = self.deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError()
                raw = socket.create_connection((address, 443), timeout=remaining)
                raw.settimeout(max(0.001, self.deadline - time.monotonic()))
                self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
                self._active_socket = self.sock
                return
            except OSError as error:
                last_error = error
                if raw is not None:
                    raw.close()
        raise last_error or OSError("No public address")


def request_https(url: str, *, method: str, headers: Mapping[str, str], body: bytes | None,
                  maximum: int, timeout: float, addresses: tuple[str, ...] | None = None) -> Response:
    """Direct HTTPS only: no ambient proxy, redirect, credential or cookie reuse."""
    deadline = time.monotonic() + timeout
    parts = _split_https(url)
    if "#" in url:
        raise ValueError("URL fragments are not supported")
    if addresses is None:
        addresses = resolve_public_addresses(parts.hostname, min(2, max(0.001, deadline - time.monotonic())))
    if not addresses or any(not is_public_address(address) for address in addresses):
        raise ValueError("Non-public upstream address")
    connection = _PinnedHTTPSConnection(parts.hostname, addresses, deadline)
    def interrupt_at_deadline():
        # http.client may detach connection.sock after a Connection: close
        # response. Retain the TLS socket so status/header trickles cannot extend
        # the total deadline beyond the configured provider/download budget.
        active = connection._active_socket
        if active is not None:
            try:
                active.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            active.close()

    watchdog = threading.Timer(max(0.001, deadline - time.monotonic()), interrupt_at_deadline)
    watchdog.daemon = True
    watchdog.start()
    try:
        target = parts.path or "/"
        if parts.query:
            target += "?" + parts.query
        connection.request(method, target, body=body, headers=dict(headers))
        connection.sock.settimeout(max(0.001, deadline - time.monotonic()))
        response = connection.getresponse()
        response_headers = {key.lower(): value for key, value in response.getheaders()}
        length = response_headers.get("content-length")
        if length is not None and (not length.isdigit() or int(length) > maximum):
            raise ValueError("Upstream response too large or invalid")
        if 300 <= response.status < 400:
            return Response(response.status, response_headers, b"")
        body_limit = maximum if 200 <= response.status < 300 else min(maximum, 16 * 1024)
        chunks, size = [], 0
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError()
            if connection.sock is not None:
                connection.sock.settimeout(remaining)
            # read1 returns after one available read, so a trickle cannot reset
            # the overall deadline indefinitely.
            chunk = response.read1(min(64 * 1024, body_limit + 1 - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
            if size > body_limit:
                raise ValueError("Upstream response too large")
        return Response(response.status, response_headers, b"".join(chunks))
    finally:
        watchdog.cancel()
        connection.close()


def _bounded_response(response: Response, maximum: int, code: str) -> bytes:
    length = response.headers.get("content-length")
    if ((length is not None and (not str(length).isdigit() or int(length) > maximum))
            or not isinstance(response.body, bytes) or len(response.body) > maximum):
        fail(413, code, "The image or response is too large.")
    return response.body


def download_image(url: ValidatedUrl, config: Config, fetch=request_https, timeout=None) -> tuple[bytes, str]:
    try:
        response = fetch(url.url, method="GET", headers={"Accept": "image/png,image/jpeg,image/webp"}, body=None,
                         maximum=config.max_image_bytes, timeout=timeout or config.download_timeout, addresses=url.addresses)
    except Exception:
        fail(502, "image_download_failed", "The input image could not be downloaded.")
    if not 200 <= response.status < 300:
        fail(502, "image_download_failed", "The input image could not be downloaded.")
    mime = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if mime not in ("image/png", "image/jpeg", "image/webp"):
        fail(415, "unsupported_image", "Use a PNG, JPEG or WebP image.")
    data = _bounded_response(response, config.max_image_bytes, "input_too_large")
    if image_type(data) != mime:
        fail(415, "invalid_image", "The downloaded bytes are not a supported image.")
    return data, mime


def create_openai_editor(config: Config, fetch=request_https):
    def edit(image: tuple[bytes, str], prompt: str) -> tuple[bytes, str]:
        data, mime = image
        payload = {
            "model": config.model,
            "images": [{"image_url": f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"}],
            "prompt": prompt, "n": 1, "size": "1024x1024", "quality": "low", "output_format": "png",
        }
        try:
            response = fetch(OPENAI_EDIT_URL, method="POST",
                             headers={"Content-Type": "application/json", "Authorization": "Bearer " + config.api_key},
                             body=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
                             maximum=config.max_provider_bytes, timeout=config.provider_timeout)
        except Exception:
            fail(502, "provider_unavailable", "The image provider is unavailable or timed out.")
        if response.status == 429:
            fail(429, "provider_rate_limited", "The image provider rate limit was reached.")
        if not 200 <= response.status < 300:
            # Parse only a bounded error code; provider text is never forwarded.
            blocked = False
            try:
                error = json.loads(response.body[:config.max_body_bytes]).get("error", {})
                blocked = error.get("code") in ("content_policy_violation", "moderation_blocked", "safety_violation")
            except (ValueError, TypeError, AttributeError):
                pass
            if blocked:
                fail(422, "generation_blocked", "The image provider blocked this request.")
            fail(502, "provider_rejected_request", "The image provider rejected the request. Check its key, billing and model configuration.")
        raw = _bounded_response(response, config.max_provider_bytes, "provider_response_too_large")
        try:
            payload = json.loads(raw)
            encoded = payload["data"][0]["b64_json"]
            if not isinstance(encoded, str) or not encoded:
                raise ValueError()
        except (ValueError, TypeError, KeyError, IndexError):
            fail(502, "invalid_provider_response", "The image provider did not return an edited image.")
        if len(encoded) > 4 * ((config.max_image_bytes + 2) // 3):
            fail(502, "invalid_generated_image", "The provider returned invalid image data.")
        try:
            generated = base64.b64decode(encoded, validate=True)
        except (ValueError, TypeError):
            fail(502, "invalid_generated_image", "The provider returned invalid image data.")
        detected = image_type(generated)
        if (detected != "image/png" or len(generated) > config.max_image_bytes
                or base64.b64encode(generated).decode("ascii") != encoded):
            fail(502, "invalid_generated_image", "The provider returned invalid image data.")
        return generated, detected
    return edit


class BackendServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def handle_error(self, request, client_address):
        # Do not log exception messages, URLs, photos, credentials, or prompts.
        pass

    def service_actions(self):
        if time.monotonic() - self._last_cleanup >= 60:
            self._last_cleanup = time.monotonic()
            try:
                self.image_store.cleanup()
            except OSError:
                pass

    def server_close(self):
        super().server_close()
        if hasattr(self, "image_store"):
            self.image_store.close()


def create_server(*, config: Config | None = None, env: Mapping[str, str] | None = None,
                  fetch=request_https, resolver=resolve_public_addresses, edit_image=None,
                  image_store=None, now=time.time) -> BackendServer:
    config = config or read_config(env)
    store = image_store or FileImageStore(config.data_dir, config.image_ttl_seconds, now)
    edit = edit_image or create_openai_editor(config, fetch)
    state_lock, request_times = threading.Lock(), deque()
    in_flight = 0

    class Handler(BaseHTTPRequestHandler):
        server_version = "LocketBackend"
        sys_version = ""
        protocol_version = "HTTP/1.1"

        def setup(self):
            super().setup()
            self.connection.settimeout(10)

        def log_message(self, format, *args):
            pass

        def _json(self, status, body, extra=None):
            encoded = json.dumps(body, separators=(",", ":")).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(encoded)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Connection", "close")
            for key, value in (extra or {}).items():
                self.send_header(key, value)
            self.end_headers()
            self.close_connection = True
            if self.command != "HEAD":
                self.wfile.write(encoded)

        def _error(self, status, code, message, extra=None):
            self._json(status, {"error": {"code": code, "message": message}}, extra)

        def send_error(self, code, message=None, explain=None):
            # BaseHTTPRequestHandler normally reflects request text in HTML.
            self._error(code, "invalid_request", "The request could not be processed.")

        def _dispatch(self):
            nonlocal in_flight
            try:
                path = self.path.split("?", 1)[0]
                if self.command == "GET" and path == "/health":
                    return self._json(200, {"ok": True, "configured": config.configured})
                if self.command == "GET" and path.startswith("/images/"):
                    result = store.read(path[len("/images/"):])
                    if result is None:
                        return self._error(404, "image_not_found", "The image does not exist or has expired.")
                    data, mime = result
                    self.send_response(200)
                    self.send_header("Content-Type", mime)
                    self.send_header("Content-Length", str(len(data)))
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("X-Content-Type-Options", "nosniff")
                    self.send_header("Connection", "close")
                    self.end_headers()
                    self.close_connection = True
                    self.wfile.write(data)
                    return
                if path != "/v1/images/edit":
                    return self._error(404, "not_found", "Not found.")
                if self.command != "POST":
                    return self._error(405, "method_not_allowed", "Use POST.", {"Allow": "POST"})
                if not config.configured:
                    fail(503, "not_configured", "The backend needs its API key, access token and public HTTPS URL.")
                auth = self.headers.get_all("Authorization", [])
                expected = ("Bearer " + config.access_token).encode("utf-8")
                if len(auth) != 1 or not hmac.compare_digest(auth[0].encode("utf-8"), expected):
                    fail(401, "unauthorized", "A valid backend access token is required.")
                if not re.match(r"application/json(?:\s*;|$)", self.headers.get("Content-Type", ""), re.I):
                    fail(415, "invalid_content_type", "Use application/json.")
                lengths = self.headers.get_all("Content-Length", [])
                if self.headers.get("Transfer-Encoding") is not None or len(lengths) != 1 or not lengths[0].isdigit():
                    fail(400, "invalid_request", "A valid Content-Length is required.")
                length = int(lengths[0])
                if length > config.max_body_bytes:
                    fail(413, "request_too_large", "The request is too large.")
                try:
                    raw = self.rfile.read(length)
                    if len(raw) != length:
                        raise ValueError()
                    body = json.loads(raw)
                except (ValueError, OSError):
                    fail(400, "invalid_json", "The request body must be valid JSON.")
                if (not isinstance(body, dict) or not isinstance(body.get("imageUrl"), str)
                        or len(body["imageUrl"]) > 4096 or not isinstance(body.get("prompt"), str)
                        or not body["prompt"].strip() or len(body["prompt"]) > 4096):
                    fail(400, "invalid_input", "Provide imageUrl and a non-empty prompt of at most 4096 characters.")
                with state_lock:
                    if in_flight >= config.max_concurrent:
                        fail(429, "backend_busy", "An image is already being generated. Try again later.")
                    stamp = now()
                    while request_times and stamp - request_times[0] >= 60:
                        request_times.popleft()
                    if len(request_times) >= config.rate_limit:
                        fail(429, "backend_rate_limited", "The backend request limit was reached.")
                    request_times.append(stamp)
                    in_flight += 1
                try:
                    download_deadline = time.monotonic() + config.download_timeout
                    url = validate_input_url(body["imageUrl"], config, resolver, min(2, config.download_timeout))
                    remaining = download_deadline - time.monotonic()
                    if remaining <= 0:
                        fail(502, "image_download_failed", "The input image could not be downloaded.")
                    image = download_image(url, config, fetch, remaining)
                    generated, mime = edit(image, body["prompt"].strip())
                    if (not isinstance(generated, bytes) or len(generated) > config.max_image_bytes
                            or image_type(generated) != mime):
                        fail(502, "invalid_generated_image", "The image provider did not return a valid image.")
                    filename = store.save(generated, mime)
                    self._json(200, {"outputUrl": f"{config.public_base_url}/images/{filename}",
                                     "expiresInSeconds": config.image_ttl_seconds})
                finally:
                    with state_lock:
                        in_flight -= 1
            except AppError as error:
                self._error(error.status, error.code, error.message)
            except (BrokenPipeError, ConnectionResetError):
                self.close_connection = True
            except Exception:
                self._error(500, "internal_error", "The image request failed.")

        do_GET = _dispatch
        do_POST = _dispatch
        do_PUT = _dispatch
        do_DELETE = _dispatch
        do_PATCH = _dispatch
        do_HEAD = _dispatch
        do_OPTIONS = _dispatch

    server = BackendServer((config.host, config.port), Handler)
    server.image_store = store
    server._last_cleanup = 0
    server.config = config
    return server


def main():
    try:
        server = create_server()
    except (ValueError, OSError):
        raise SystemExit("Backend configuration or listener setup failed. Check environment settings.") from None
    print(f"Locket AI backend listening on port {server.server_port}. See /health for configuration status.", flush=True)
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
