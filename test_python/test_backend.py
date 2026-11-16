"""All tests are offline: only a loopback HTTP listener is used."""

import base64
from contextlib import contextmanager, redirect_stderr, redirect_stdout
from dataclasses import replace
import http.client
import io
import json
from pathlib import Path
import socket
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit
import zlib

from backend_py.server import (
    AppError, Config, OPENAI_EDIT_URL, Response, create_openai_editor,
    create_server, download_image, is_public_address, read_config,
    request_https, validate_input_url,
)
from backend_py import server as backend_module
from backend_py.storage import FileImageStore
from test_python.test_composition import composition_fixture, FOUR_SLOTS, image_bytes
from PIL import Image


def png(rgb):
    def chunk(kind, payload):
        return len(payload).to_bytes(4, "big") + kind + payload + zlib.crc32(kind + payload).to_bytes(4, "big")
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", b"\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00")
            + chunk(b"IDAT", zlib.compress(b"\x00" + bytes(rgb))) + chunk(b"IEND", b""))


SOURCE = png((255, 0, 0))
GENERATED = png((0, 0, 255))
FAKE_API_KEY = "fake-openai-key-for-offline-tests"
FAKE_ACCESS_TOKEN = "fake-backend-token-for-offline-tests"
SOURCE_URL = "https://cdn.locketcamera.com/private-original.png?token=fake-original-token"


def public_resolver(host, timeout):
    return ("8.8.8.8",)


def make_config(directory, **overrides):
    return replace(Config(port=0, api_key=FAKE_API_KEY, access_token=FAKE_ACCESS_TOKEN,
                          public_base_url="https://images.example.com", data_dir=Path(directory)), **overrides)


class Provider:
    def __init__(self, status=200, payload=None, source=SOURCE, mime="image/png"):
        self.calls = []
        self.status, self.source, self.mime = status, source, mime
        self.payload = payload if payload is not None else {"data": [{"b64_json": base64.b64encode(GENERATED).decode()}]}

    def __call__(self, url, **kwargs):
        self.calls.append((url, kwargs))
        if url == OPENAI_EDIT_URL:
            return Response(self.status, {"content-type": "application/json"}, json.dumps(self.payload).encode())
        return Response(200, {"content-type": self.mime}, self.source)


@contextmanager
def running(config, **kwargs):
    server = create_server(config=config, **kwargs)
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def call(server, method="GET", path="/health", data=None, headers=None, raw=None):
    request_headers = dict(headers or {})
    if data is not None:
        raw = json.dumps(data).encode()
        request_headers.setdefault("Content-Type", "application/json")
    connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=4)
    try:
        connection.request(method, path, body=raw, headers=request_headers)
        response = connection.getresponse()
        return response.status, dict(response.getheaders()), response.read()
    finally:
        connection.close()


def edit_request(server, **kwargs):
    return call(server, "POST", "/v1/images/edit", data={"imageUrl": SOURCE_URL, "prompt": "Turn the image blue"},
                headers={"Authorization": "Bearer " + FAKE_ACCESS_TOKEN}, **kwargs)


def code(result):
    return json.loads(result[2])["error"]["code"]


class ConfigTests(unittest.TestCase):
    def test_defaults_are_local_unconfigured_and_openai(self):
        config = read_config({})
        self.assertEqual(config.host, "127.0.0.1")
        self.assertEqual(config.port, 8787)
        self.assertFalse(config.configured)
        self.assertFalse(config.composition_configured)
        self.assertEqual(config.model, "gpt-image-2.5-flare")
        self.assertEqual(config.image_ttl_seconds, 900)
        self.assertEqual(config.max_concurrent, 1)
        self.assertEqual(config.rate_limit, 3)

    def test_config_accepts_only_openai_key_and_configurable_model(self):
        legacy = read_config({"GEMINI_API_KEY": "not-a-supported-secret"})
        self.assertFalse(legacy.configured)
        config = read_config({"OPENAI_API_KEY": FAKE_API_KEY, "BACKEND_ACCESS_TOKEN": FAKE_ACCESS_TOKEN,
                              "PUBLIC_BASE_URL": "https://EXAMPLE.com/", "OPENAI_IMAGE_MODEL": "my-model"})
        self.assertTrue(config.configured)
        self.assertEqual(config.public_base_url, "https://example.com")
        self.assertEqual(config.model, "my-model")
        self.assertNotIn(FAKE_API_KEY, repr(config))
        self.assertNotIn(FAKE_ACCESS_TOKEN, repr(config))
        self.assertTrue(replace(config, api_key="").composition_configured)

    def test_unsafe_public_origin_and_config_fail_without_secret_echo(self):
        for origin in ("http://example.com", "https://127.0.0.1", "https://localhost", "https://example.com:443",
                       "https://user:pass@example.com", "https://example.com/path", "https://example.com?", "https://example.com#"):
            with self.subTest(origin=origin), self.assertRaises(ValueError):
                read_config({"PUBLIC_BASE_URL": origin})
        for env in ({"INPUT_IMAGE_HOSTS": "127.0.0.1"}, {"INPUT_IMAGE_HOSTS": "*.example.com"},
                    {"INPUT_IMAGE_HOSTS": "localhost"}, {"PORT": "-1"}, {"PROVIDER_TIMEOUT_MS": "35001"},
                    {"OPENAI_API_KEY": FAKE_API_KEY + "\n"}, {"OPENAI_IMAGE_MODEL": "bad/model"}):
            with self.subTest(env=list(env)), self.assertRaises(ValueError) as caught:
                read_config(env)
            self.assertNotIn(FAKE_API_KEY, str(caught.exception))


class UrlSafetyTests(unittest.TestCase):
    def setUp(self):
        self.config = Config()

    def test_exact_hosts_https_and_no_credentials_port_fragment_ip(self):
        bad = ("http://cdn.locketcamera.com/a.png", "https://cdn.locketcamera.com.evil.com/a.png",
               "https://user:pass@cdn.locketcamera.com/a.png", "https://cdn.locketcamera.com:443/a.png",
               "https://cdn.locketcamera.com/a.png#", "https://127.0.0.1/a.png", "https://[::1]/a.png",
               "https://cdn.locketcamera.com/a\r\n.png", "https://cdn.locketcamera.com\\@evil.com/a")
        for url in bad:
            with self.subTest(url=url), self.assertRaises(AppError) as caught:
                validate_input_url(url, self.config, lambda *_: self.fail("DNS should not run"))
            self.assertEqual(caught.exception.status, 400)

    def test_private_or_mixed_dns_fails_closed(self):
        for addresses in (("127.0.0.1",), ("10.0.0.1",), ("169.254.169.254",), ("::1",),
                          ("fc00::1",), ("8.8.8.8", "192.168.1.1"), ()):
            with self.subTest(addresses=addresses), self.assertRaises(AppError):
                validate_input_url(SOURCE_URL, self.config, lambda *_: addresses)

    def test_all_public_answers_are_pinned_and_preserve_signed_query(self):
        result = validate_input_url(SOURCE_URL, self.config, public_resolver)
        self.assertEqual(result.addresses, ("8.8.8.8",))
        self.assertEqual(result.url, SOURCE_URL)

    def test_public_address_classification(self):
        self.assertTrue(is_public_address("8.8.8.8"))
        self.assertTrue(is_public_address("2606:4700:4700::1111"))
        for ip in ("0.0.0.0", "100.64.0.1", "192.0.2.1", "198.18.0.1", "224.0.0.1", "::ffff:127.0.0.1", "2001:db8::1"):
            self.assertFalse(is_public_address(ip), ip)


class ProviderTests(unittest.TestCase):
    def setUp(self):
        self.config = Config(api_key=FAKE_API_KEY)

    def test_official_json_edit_contract_and_generated_bytes(self):
        provider = Provider()
        generated, mime = create_openai_editor(self.config, provider)((SOURCE, "image/png"), "Edit this")
        self.assertEqual(generated, GENERATED)
        self.assertNotEqual(generated, SOURCE)
        self.assertEqual(mime, "image/png")
        url, request = provider.calls[0]
        self.assertEqual(url, OPENAI_EDIT_URL)
        self.assertEqual(request["method"], "POST")
        self.assertEqual(request["headers"], {"Content-Type": "application/json", "Authorization": "Bearer " + FAKE_API_KEY})
        body = json.loads(request["body"])
        self.assertEqual(body, {"model": "gpt-image-2.5-flare", "images": [{"image_url": "data:image/png;base64," + base64.b64encode(SOURCE).decode()}],
                                "prompt": "Edit this", "n": 1, "size": "1024x1024", "quality": "low", "output_format": "png"})
        self.assertEqual(request["timeout"], 32)
        self.assertEqual(request["maximum"], 32 * 1024 * 1024)

    def test_invalid_or_url_only_provider_response_never_falls_back(self):
        payloads = ({"data": [{"url": SOURCE_URL}]}, {"data": []}, {"data": [{"b64_json": "%%%"}]},
                    {"data": [{"b64_json": base64.b64encode(b"not an image").decode()}]}, {}, [],
                    {"data": [{"b64_json": base64.b64encode(GENERATED).decode() + "="}]})
        for payload in payloads:
            with self.subTest(payload=payload), self.assertRaises(AppError):
                create_openai_editor(self.config, Provider(payload=payload))((SOURCE, "image/png"), "Edit")

    def test_provider_rejection_rate_limit_block_and_failure_are_generic(self):
        cases = ((401, {"error": {"message": FAKE_API_KEY + SOURCE_URL}}, "provider_rejected_request", 502),
                 (429, {}, "provider_rate_limited", 429),
                 (400, {"error": {"code": "content_policy_violation", "message": SOURCE_URL}}, "generation_blocked", 422),
                 (302, {}, "provider_rejected_request", 502))
        for status, payload, expected, app_status in cases:
            with self.subTest(status=status), self.assertRaises(AppError) as caught:
                create_openai_editor(self.config, Provider(status, payload))((SOURCE, "image/png"), "Edit")
            self.assertEqual(caught.exception.code, expected)
            self.assertEqual(caught.exception.status, app_status)
            self.assertNotIn(SOURCE_URL, str(caught.exception))
            self.assertNotIn(FAKE_API_KEY, str(caught.exception))
        def unavailable(*args, **kwargs):
            raise OSError(FAKE_API_KEY)
        with self.assertRaises(AppError) as caught:
            create_openai_editor(self.config, unavailable)((SOURCE, "image/png"), "Edit")
        self.assertEqual(caught.exception.code, "provider_unavailable")
        self.assertNotIn(FAKE_API_KEY, str(caught.exception))

    def test_download_does_not_forward_credentials_and_rejects_redirect_mime_or_size(self):
        url = validate_input_url(SOURCE_URL, self.config, public_resolver)
        provider = Provider()
        self.assertEqual(download_image(url, self.config, provider), (SOURCE, "image/png"))
        request = provider.calls[0][1]
        self.assertEqual(request["headers"], {"Accept": "image/png,image/jpeg,image/webp"})
        self.assertEqual(request["addresses"], ("8.8.8.8",))
        self.assertLessEqual(request["timeout"], 8)
        for response in (Response(302, {"location": "http://127.0.0.1/"}, b""),
                         Response(200, {"content-type": "text/html"}, SOURCE),
                         Response(200, {"content-type": "image/png"}, b"not image"),
                         Response(200, {"content-type": "image/png", "content-length": str(11 * 1024 * 1024)}, SOURCE)):
            with self.subTest(response=response.status), self.assertRaises(AppError):
                download_image(url, self.config, lambda *args, **kwargs: response)

    def test_transport_rejects_unsafe_url_and_private_pins_without_network(self):
        for url, addresses in (("http://api.openai.com/v1/images/edits", None),
                               (OPENAI_EDIT_URL, ("127.0.0.1",)),
                               ("https://api.openai.com:443/v1/images/edits", ("8.8.8.8",))):
            with self.subTest(url=url), self.assertRaises(ValueError):
                request_https(url, method="POST", headers={}, body=b"", maximum=100, timeout=1, addresses=addresses)

    def test_tls_uses_pinned_ip_and_original_hostname_for_certificate_check(self):
        class RawSocket:
            def settimeout(self, timeout):
                self.timeout = timeout
            def close(self):
                pass
        raw = RawSocket()
        context = unittest.mock.Mock()
        context.wrap_socket.return_value = raw
        with patch.object(backend_module.ssl, "create_default_context", return_value=context), \
                patch.object(backend_module.socket, "create_connection", return_value=raw) as connect:
            connection = backend_module._PinnedHTTPSConnection("api.openai.com", ("8.8.8.8",), backend_module.time.monotonic() + 1)
            connection.connect()
            self.assertEqual(connect.call_args.args[0], ("8.8.8.8", 443))
            context.wrap_socket.assert_called_once_with(raw, server_hostname="api.openai.com")

    def test_transport_bounds_body_and_never_follows_redirects(self):
        class FakeSocket:
            def settimeout(self, value):
                pass
        class FakeResponse:
            status = 200
            chunks = [b"abc", b"def", b""]
            def getheaders(self):
                return [("Content-Type", "application/json")]
            def read1(self, maximum):
                return self.chunks.pop(0)
        class FakeConnection:
            latest = None
            def __init__(self, host, addresses, deadline):
                self.sock = self._active_socket = FakeSocket()
                self.response = FakeResponse()
                self.response.chunks = list(FakeResponse.chunks)
                self.requests, self.closed = [], False
                FakeConnection.latest = self
            def request(self, method, path, body, headers):
                self.requests.append((method, path, body, headers))
            def getresponse(self):
                return self.response
            def close(self):
                self.closed = True
        with patch.object(backend_module, "_PinnedHTTPSConnection", FakeConnection):
            result = request_https(SOURCE_URL, method="GET", headers={}, body=None, maximum=6, timeout=1, addresses=("8.8.8.8",))
            self.assertEqual(result.body, b"abcdef")
            self.assertEqual(FakeConnection.latest.requests[0][1], "/private-original.png?token=fake-original-token")
            self.assertTrue(FakeConnection.latest.closed)
            with self.assertRaises(ValueError):
                request_https(SOURCE_URL, method="GET", headers={}, body=None, maximum=5, timeout=1, addresses=("8.8.8.8",))
            self.assertTrue(FakeConnection.latest.closed)
            with patch.object(FakeResponse, "status", 302):
                result = request_https(SOURCE_URL, method="GET", headers={}, body=None, maximum=6, timeout=1, addresses=("8.8.8.8",))
                self.assertEqual(result.status, 302)
                self.assertEqual(result.body, b"")
                self.assertEqual(len(FakeConnection.latest.requests), 1)

    def test_transport_deadline_interrupts_stalled_response(self):
        interrupted = threading.Event()
        class FakeSocket:
            def settimeout(self, value):
                pass
            def shutdown(self, how):
                interrupted.set()
            def close(self):
                pass
        class FakeResponse:
            status = 200
            def getheaders(self):
                return []
            def read1(self, maximum):
                interrupted.wait(timeout=1)
                raise OSError("socket interrupted")
        class FakeConnection:
            def __init__(self, *args):
                self.sock = self._active_socket = FakeSocket()
            def request(self, *args, **kwargs):
                pass
            def getresponse(self):
                return FakeResponse()
            def close(self):
                pass
        start = backend_module.time.monotonic()
        with patch.object(backend_module, "_PinnedHTTPSConnection", FakeConnection), self.assertRaises(OSError):
            request_https(SOURCE_URL, method="GET", headers={}, body=None, maximum=100, timeout=0.05, addresses=("8.8.8.8",))
        self.assertTrue(interrupted.is_set())
        self.assertLess(backend_module.time.monotonic() - start, 0.5)


class HttpIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent)
        self.addCleanup(self.temp.cleanup)
        self.config = make_config(self.temp.name)

    def test_real_local_http_end_to_end_provider_result_get_and_ttl(self):
        clock = [1_800_000_000.0]
        provider = Provider()
        with running(self.config, fetch=provider, resolver=public_resolver, now=lambda: clock[0]) as server:
            self.assertEqual(json.loads(call(server)[2]), {"ok": True, "configured": True, "compositionConfigured": True})
            status, headers, body = edit_request(server)
            self.assertEqual(status, 200, body)
            result = json.loads(body)
            self.assertEqual(result["expiresInSeconds"], 900)
            self.assertRegex(result["outputUrl"], r"^https://images\.example\.com/images/[a-f0-9]{48}\.png$")
            self.assertNotIn(SOURCE_URL.encode(), body)
            path = urlsplit(result["outputUrl"]).path
            get_status, get_headers, data = call(server, path=path)
            self.assertEqual(get_status, 200)
            self.assertEqual(get_headers["Content-Type"], "image/png")
            self.assertEqual(get_headers["Cache-Control"], "no-store")
            self.assertEqual(data, GENERATED)
            self.assertNotEqual(data, SOURCE)
            self.assertEqual(len(list(Path(self.temp.name).iterdir())), 1)
            clock[0] += 900
            self.assertEqual(call(server, path=path)[0], 404)
            self.assertEqual(list(Path(self.temp.name).iterdir()), [])
        self.assertEqual(len(provider.calls), 2)
        self.assertNotIn("Authorization", provider.calls[0][1]["headers"])
        self.assertEqual(provider.calls[1][1]["headers"]["Authorization"], "Bearer " + FAKE_API_KEY)

    def test_missing_key_token_or_public_url_is_unconfigured_without_fetch(self):
        for config in (replace(self.config, api_key=""), replace(self.config, access_token="short"), replace(self.config, public_base_url="")):
            with self.subTest(configured=config.configured), running(config, fetch=lambda *_args, **_kwargs: self.fail("No fetch allowed")) as server:
                self.assertFalse(json.loads(call(server)[2])["configured"])
                result = edit_request(server)
                self.assertEqual(result[0], 503)
                self.assertEqual(code(result), "not_configured")

    def test_authentication_precedes_body_dns_and_provider_access(self):
        provider = Provider()
        with running(self.config, fetch=provider, resolver=lambda *_: self.fail("No DNS allowed")) as server:
            for headers in ({}, {"Authorization": "Bearer wrong"}, {"Authorization": "Bearer " + FAKE_API_KEY}):
                result = call(server, "POST", "/v1/images/edit", raw=b"invalid JSON", headers=headers)
                self.assertEqual(result[0], 401)
                self.assertEqual(code(result), "unauthorized")
        self.assertEqual(provider.calls, [])

    def test_unsafe_url_or_provider_failure_never_persists_input_or_echoes_secrets(self):
        for provider in (Provider(payload={"data": [{"url": SOURCE_URL}]}),
                         Provider(401, {"error": {"message": FAKE_API_KEY + SOURCE_URL}})):
            capture = io.StringIO()
            with redirect_stdout(capture), redirect_stderr(capture), running(self.config, fetch=provider, resolver=public_resolver) as server:
                result = edit_request(server)
                self.assertEqual(result[0], 502)
                for secret in (SOURCE_URL, FAKE_API_KEY, FAKE_ACCESS_TOKEN, base64.b64encode(SOURCE).decode()):
                    self.assertNotIn(secret, result[2].decode())
                    self.assertNotIn(secret, capture.getvalue())
                self.assertEqual(list(Path(self.temp.name).iterdir()), [])
        provider = Provider()
        with running(self.config, fetch=provider, resolver=public_resolver) as server:
            result = call(server, "POST", "/v1/images/edit", data={"imageUrl": "https://evil.example/a.png", "prompt": "Edit"},
                          headers={"Authorization": "Bearer " + FAKE_ACCESS_TOKEN})
            self.assertEqual(result[0], 400)
        self.assertEqual(provider.calls, [])

    def test_rate_limit_three_per_minute_and_recovery(self):
        clock = [1_800_000_000.0]
        provider = Provider()
        with running(self.config, fetch=provider, resolver=public_resolver, now=lambda: clock[0]) as server:
            for _ in range(3):
                self.assertEqual(edit_request(server)[0], 200)
            result = edit_request(server)
            self.assertEqual(result[0], 429)
            self.assertEqual(code(result), "backend_rate_limited")
            self.assertEqual(len(provider.calls), 6)
            clock[0] += 60
            self.assertEqual(edit_request(server)[0], 200)

    def test_single_generation_concurrency_and_recovery(self):
        entered, release = threading.Event(), threading.Event()
        def editor(image, prompt):
            entered.set()
            if not release.wait(timeout=3):
                raise TimeoutError()
            return GENERATED, "image/png"
        with running(self.config, fetch=Provider(), resolver=public_resolver, edit_image=editor) as server:
            first = []
            thread = threading.Thread(target=lambda: first.append(edit_request(server)))
            thread.start()
            try:
                self.assertTrue(entered.wait(timeout=1))
                result = edit_request(server)
                self.assertEqual(result[0], 429)
                self.assertEqual(code(result), "backend_busy")
            finally:
                release.set()
                thread.join(timeout=2)
            self.assertEqual(first[0][0], 200)
            self.assertEqual(edit_request(server)[0], 200)

    def test_content_type_json_input_size_methods_and_traversal(self):
        headers = {"Authorization": "Bearer " + FAKE_ACCESS_TOKEN, "Content-Type": "application/json"}
        with running(self.config, fetch=Provider(), resolver=public_resolver) as server:
            self.assertEqual(call(server, "POST", "/v1/images/edit", raw=b"x", headers=headers)[0], 400)
            self.assertEqual(call(server, "POST", "/v1/images/edit", raw=b"x" * (16 * 1024 + 1), headers=headers)[0], 413)
            self.assertEqual(call(server, "POST", "/v1/images/edit", raw=b"{}", headers={"Authorization": headers["Authorization"]})[0], 415)
            for data in ({}, [], {"imageUrl": SOURCE_URL, "prompt": " "}, {"imageUrl": SOURCE_URL, "prompt": "x" * 4097}):
                self.assertEqual(call(server, "POST", "/v1/images/edit", data=data, headers=headers)[0], 400)
            self.assertEqual(call(server, path="/v1/images/edit")[0], 405)
            for path in ("/images/../server.py", "/images/%2e%2e%2f.env", "/images/" + "a" * 47 + ".png", "/.env"):
                self.assertEqual(call(server, path=path)[0], 404)

    def test_duplicate_authorization_and_chunked_requests_rejected_without_fetch(self):
        provider = Provider()
        with running(self.config, fetch=provider, resolver=public_resolver) as server:
            conn = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
            conn.putrequest("POST", "/v1/images/edit")
            conn.putheader("Authorization", "Bearer " + FAKE_ACCESS_TOKEN)
            conn.putheader("Authorization", "Bearer " + FAKE_ACCESS_TOKEN)
            conn.putheader("Content-Type", "application/json")
            conn.putheader("Content-Length", "0")
            conn.endheaders()
            response = conn.getresponse()
            self.assertEqual(response.status, 401)
            response.read()
            conn.close()
            result = call(server, "POST", "/v1/images/edit", raw=b"0\r\n\r\n", headers={
                "Authorization": "Bearer " + FAKE_ACCESS_TOKEN, "Content-Type": "application/json", "Transfer-Encoding": "chunked"})
            self.assertEqual(result[0], 400)
        self.assertEqual(provider.calls, [])


class CompositionHttpTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent)
        self.addCleanup(self.temp.cleanup)
        self.config = make_config(Path(self.temp.name) / "output", api_key="")
        options, self.preset_id, _, _ = composition_fixture(self.temp.name, four=True)
        self.options = {"composition_manifest_path": options["manifest_path"],
                        "composition_asset_root": options["asset_root"]}

    def request(self, server, payload=None, headers=None):
        return call(server, "POST", "/v1/images/compose",
                    data=payload if payload is not None else {"presetId": self.preset_id, "imageUrl": SOURCE_URL},
                    headers=headers if headers is not None else {"Authorization": "Bearer " + FAKE_ACCESS_TOKEN})

    def test_without_openai_key_composes_stores_real_pixels_and_expires(self):
        provider = Provider()
        clock = [1_800_000_000.0]
        with running(self.config, fetch=provider, resolver=public_resolver, now=lambda: clock[0], **self.options) as server:
            self.assertEqual(json.loads(call(server)[2]), {"ok": True, "configured": False, "compositionConfigured": True})
            result = self.request(server)
            self.assertEqual(result[0], 200, result[2])
            body = json.loads(result[2])
            self.assertEqual(set(body), {"outputUrl", "expiresInSeconds", "sourceImageCount", "slotCount"})
            self.assertEqual(body["sourceImageCount"], 1)
            self.assertEqual(body["slotCount"], 4)
            self.assertEqual(body["expiresInSeconds"], 900)
            path = urlsplit(body["outputUrl"]).path
            downloaded = call(server, path=path)
            self.assertEqual(downloaded[0], 200)
            self.assertNotEqual(downloaded[2], SOURCE)
            with Image.open(io.BytesIO(downloaded[2])) as composite:
                self.assertEqual(composite.size, (12, 12))
                for x, y, _, _ in FOUR_SLOTS:
                    self.assertEqual(composite.getpixel((x + 1, y + 1)), (255, 0, 0, 255))
            self.assertNotIn(SOURCE_URL.encode(), result[2])
            clock[0] += 900
            self.assertEqual(call(server, path=path)[0], 404)
        self.assertEqual(len(provider.calls), 1)
        self.assertEqual(provider.calls[0][0], SOURCE_URL)
        self.assertNotIn("Authorization", provider.calls[0][1]["headers"])
        self.assertEqual(provider.calls[0][1]["addresses"], ("8.8.8.8",))

    def test_four_input_urls_download_only_sources_and_preserve_order(self):
        urls = ["https://cdn.locketcamera.com/" + str(index) + ".png" for index in range(4)]
        colors = [(255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 0)]
        calls = []
        def fetch(url, **kwargs):
            calls.append((url, kwargs))
            self.assertIn(url, urls)
            return Response(200, {"content-type": "image/png"}, image_bytes(colors[urls.index(url)]))
        with running(self.config, fetch=fetch, resolver=public_resolver, **self.options) as server:
            result = self.request(server, {"presetId": self.preset_id, "imageUrls": urls})
            self.assertEqual(result[0], 200, result[2])
            payload = json.loads(result[2])
            self.assertEqual(payload["sourceImageCount"], 4)
            self.assertEqual(payload["slotCount"], 4)
            data = call(server, path=urlsplit(payload["outputUrl"]).path)[2]
            with Image.open(io.BytesIO(data)) as composite:
                for (x, y, _, _), color in zip(FOUR_SLOTS, colors):
                    self.assertEqual(composite.getpixel((x + 1, y + 1)), color + (255,))
        self.assertEqual([url for url, _ in calls], urls)
        self.assertTrue(all(request["method"] == "GET" for _, request in calls))

    def test_authentication_counts_unknown_id_and_unsafe_urls_fail_before_download(self):
        provider = Provider()
        no_dns = lambda *_: self.fail("No DNS allowed")
        with running(self.config, fetch=provider, resolver=no_dns, **self.options) as server:
            self.assertEqual(self.request(server, headers={})[0], 401)
            bad = ({"presetId": "unsupported", "imageUrl": SOURCE_URL},
                   {"presetId": self.preset_id, "imageUrls": [SOURCE_URL] * 2},
                   {"presetId": self.preset_id, "imageUrls": [SOURCE_URL] * 3},
                   {"presetId": self.preset_id, "imageUrls": [SOURCE_URL] * 5},
                   {"presetId": self.preset_id, "imageUrl": SOURCE_URL, "imageUrls": [SOURCE_URL]},
                   {"presetId": self.preset_id, "imageUrls": SOURCE_URL},
                   {"presetId": self.preset_id, "imageUrl": SOURCE_URL, "overlayUrl": "https://evil.example/asset.png"},
                   {"presetId": self.preset_id, "imageUrl": "https://evil.example/photo.png"})
            for payload in bad:
                with self.subTest(fields=list(payload)):
                    result = self.request(server, payload)
                    self.assertEqual(result[0], 400, result[2])
        self.assertEqual(provider.calls, [])

    def test_invalid_source_pixels_no_fallback_no_output_and_no_sensitive_logs(self):
        provider = Provider(source=SOURCE[:24])  # Plausible signature, no real pixels.
        capture = io.StringIO()
        with redirect_stdout(capture), redirect_stderr(capture), running(
                self.config, fetch=provider, resolver=public_resolver, **self.options) as server:
            result = self.request(server)
            self.assertEqual(result[0], 415)
            self.assertEqual(code(result), "invalid_image")
        self.assertFalse(self.config.data_dir.exists())
        for sensitive in (SOURCE_URL, FAKE_ACCESS_TOKEN, str(self.options["composition_manifest_path"])):
            self.assertNotIn(sensitive, result[2].decode())
            self.assertNotIn(sensitive, capture.getvalue())

    def test_download_timeout_is_shared_by_all_four_sources(self):
        urls = ["https://cdn.locketcamera.com/" + str(index) + ".png" for index in range(4)]
        calls = []
        def slow_fetch(url, **kwargs):
            calls.append(kwargs)
            time.sleep(0.02)
            return Response(200, {"content-type": "image/png"}, SOURCE)
        with running(replace(self.config, download_timeout=0.03), fetch=slow_fetch,
                     resolver=public_resolver, **self.options) as server:
            result = self.request(server, {"presetId": self.preset_id, "imageUrls": urls})
            self.assertEqual(result[0], 502)
            self.assertEqual(code(result), "image_download_failed")
        self.assertLessEqual(len(calls), 2)
        if len(calls) == 2:
            self.assertLess(calls[1]["timeout"], calls[0]["timeout"])
        self.assertFalse(self.config.data_dir.exists())

    def test_ai_and_composition_share_rate_and_concurrency_limits(self):
        config = replace(self.config, api_key=FAKE_API_KEY)
        with running(config, fetch=Provider(), resolver=public_resolver, **self.options) as server:
            self.assertEqual(self.request(server)[0], 200)
            self.assertEqual(edit_request(server)[0], 200)
            self.assertEqual(self.request(server)[0], 200)
            result = edit_request(server)
            self.assertEqual(result[0], 429)
            self.assertEqual(code(result), "backend_rate_limited")
        entered, release = threading.Event(), threading.Event()
        def editor(image, prompt):
            entered.set()
            release.wait(timeout=3)
            return GENERATED, "image/png"
        with running(config, fetch=Provider(), resolver=public_resolver, edit_image=editor, **self.options) as server:
            first = []
            worker = threading.Thread(target=lambda: first.append(edit_request(server)))
            worker.start()
            try:
                self.assertTrue(entered.wait(timeout=1))
                result = self.request(server)
                self.assertEqual(result[0], 429)
                self.assertEqual(code(result), "backend_busy")
            finally:
                release.set()
                worker.join(timeout=2)
            self.assertEqual(first[0][0], 200)


class StorageTests(unittest.TestCase):
    def test_cleanup_expired_only_and_no_path_traversal(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as directory:
            clock = [1_800_000_000.0]
            store = FileImageStore(directory, 30, lambda: clock[0])
            name = store.save(GENERATED, "image/png")
            keep = Path(directory) / "keep.txt"
            keep.write_text("keep")
            self.assertIsNone(store.read("../keep.txt"))
            self.assertEqual(store.read(name), (GENERATED, "image/png"))
            clock[0] += 30
            store.cleanup()
            self.assertIsNone(store.read(name))
            self.assertEqual(keep.read_text(), "keep")


if __name__ == "__main__":
    unittest.main()
