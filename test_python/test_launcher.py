"""Launcher unit tests: no listeners, subprocesses, real keys or network calls."""

import contextlib
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock, patch

import run_backend as launcher


class LauncherTests(unittest.TestCase):
    def test_public_dotenv_keeps_environment_precedence_and_quotes(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as folder:
            path = Path(folder) / ".env"
            path.write_text('PORT=8787\nHOST="127.0.0.1" # local\nDATA_DIR=./data\\images\nPUBLIC_BASE_URL=${NO_EXPANSION}\n', encoding="utf-8")
            env = {"PORT": "9000"}
            with contextlib.redirect_stdout(io.StringIO()) as output:
                launcher.load_public_settings(path, env)
            self.assertEqual(env["PORT"], "9000")
            self.assertEqual(env["HOST"], "127.0.0.1")
            self.assertEqual(env["DATA_DIR"], r"./data\images")
            self.assertEqual(env["PUBLIC_BASE_URL"], "${NO_EXPANSION}")
            self.assertEqual(output.getvalue(), "")

    def test_dotenv_rejects_secret_without_revealing_value(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as folder:
            path = Path(folder) / ".env"
            marker = "test-only-never-real-secret"
            path.write_text("OPENAI_API_KEY=" + marker, encoding="utf-8")
            with self.assertRaises(ValueError) as error:
                launcher.load_public_settings(path, {})
            self.assertNotIn(marker, str(error.exception))

    def test_empty_dotenv_secret_is_not_loaded(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as folder:
            path = Path(folder) / ".env"
            path.write_text("OPENAI_API_KEY=\nBACKEND_ACCESS_TOKEN=\n", encoding="utf-8")
            env = {}
            launcher.load_public_settings(path, env)
            self.assertEqual(env, {})

    def test_tunnel_url_requires_actual_cloudflare_hostname(self):
        url = "https://test-session.trycloudflare.com"
        self.assertEqual(launcher.parse_tunnel_url("INF | " + url + " |"), url)
        for value in (
            url + ".evil.example", url + "@evil.example", url + ":443", url + "/attack",
            "http://test-session.trycloudflare.com", "https://-bad.trycloudflare.com",
        ):
            with self.subTest(value=value):
                self.assertIsNone(launcher.parse_tunnel_url(value))

    def test_cloudflared_environment_omits_all_credential_names(self):
        env = {"OPENAI_API_KEY": "test-only-a", "gemini_api_key": "test-only-b",
               "Backend_Access_Token": "test-only-c", "PATH": "test-path"}
        self.assertEqual(launcher.tunnel_environment(env), {"PATH": "test-path"})
        self.assertEqual(len(env), 4)

    def test_no_prompt_does_not_generate_or_request_credentials(self):
        with patch.object(launcher.getpass, "getpass") as hidden, patch.object(launcher.secrets, "token_urlsafe") as generate, patch("builtins.input") as prompt:
            env = {}
            launcher.prepare_credentials(env, no_prompt=True)
            self.assertEqual(env, {})
            hidden.assert_not_called()
            generate.assert_not_called()
            prompt.assert_not_called()

    def test_existing_token_format_is_checked_before_prompt_mode(self):
        for no_prompt in (False, True):
            for token in ("too-short", "x" * 24 + " space", "x" * 257, "x" * 24 + "\n"):
                with self.subTest(no_prompt=no_prompt, length=len(token)):
                    with patch.object(launcher.getpass, "getpass") as hidden, patch.object(launcher.secrets, "token_urlsafe") as generate, patch("builtins.input") as prompt:
                        with self.assertRaisesRegex(launcher.LauncherError, "bearer token"):
                            launcher.prepare_credentials({"BACKEND_ACCESS_TOKEN": token}, no_prompt=no_prompt)
                        hidden.assert_not_called()
                        generate.assert_not_called()
                        prompt.assert_not_called()
        for token in ("x" * 24, "x" * 256 + "==", "Ab01._~+/-" * 3):
            with self.subTest(valid_length=len(token)):
                env = {"BACKEND_ACCESS_TOKEN": token}
                launcher.prepare_credentials(env, no_prompt=True)
                self.assertEqual(env["BACKEND_ACCESS_TOKEN"], token)

    def test_no_prompt_main_uses_only_environment_with_mock_server(self):
        config = MagicMock(configured=False, host="127.0.0.1", port=8787)
        server = MagicMock(server_port=8787)
        with patch.dict(launcher.os.environ, {}, clear=True), patch.object(launcher, "load_public_settings"), patch.object(launcher, "read_config", return_value=config) as read, patch.object(launcher, "create_server", return_value=server), patch.object(launcher, "QuickTunnel") as tunnel, patch.object(launcher.getpass, "getpass") as hidden, patch.object(launcher.secrets, "token_urlsafe") as generate, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(launcher.main(["--no-prompt"]), 0)
        env = read.call_args.args[0]
        self.assertEqual(env["HOST"], "127.0.0.1")
        self.assertFalse(launcher.SECRET_NAMES.intersection(env))
        server.serve_forever.assert_called_once_with(poll_interval=0.5)
        server.server_close.assert_called_once()
        tunnel.assert_not_called()
        hidden.assert_not_called()
        generate.assert_not_called()

    def test_interactive_secrets_require_console(self):
        with patch.object(launcher.sys.stdin, "isatty", return_value=False), patch.object(launcher.getpass, "getpass") as hidden, patch.object(launcher.secrets, "token_urlsafe") as generate:
            with self.assertRaises(ValueError):
                launcher.prepare_credentials({}, no_prompt=False)
            hidden.assert_not_called()
            generate.assert_not_called()

    def test_tunnel_timeout_terminates_only_owned_mock_process(self):
        process = MagicMock(stdout=io.StringIO(""))
        process.poll.return_value = None
        with patch.object(launcher.shutil, "which", return_value="test-cloudflared.exe"), patch.object(launcher.subprocess, "Popen", return_value=process) as popen:
            with self.assertRaisesRegex(launcher.LauncherError, "Timed out"):
                launcher.QuickTunnel({"OPENAI_API_KEY": "test-only", "PATH": "test-path"}, timeout=0)
        self.assertEqual(popen.call_args.kwargs["env"], {"PATH": "test-path"})
        self.assertNotIn("test-only", str(popen.call_args.args))
        process.terminate.assert_called_once()
        process.wait.assert_called_once_with(timeout=5)

    def test_tunnel_url_is_set_before_backend_creation(self):
        server = MagicMock(server_port=8787)
        config = MagicMock(host="127.0.0.1", port=8787, configured=False)
        tunnel = MagicMock(url="https://test-session.trycloudflare.com")
        observed = []

        def read(env):
            observed.append(dict(env))
            return config

        with patch.dict(launcher.os.environ, {}, clear=True), patch.object(launcher, "load_public_settings"), patch.object(launcher, "read_config", side_effect=read), patch.object(launcher, "create_server", return_value=server), patch.object(launcher, "QuickTunnel", return_value=tunnel), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(launcher.main(["--no-prompt", "--tunnel"]), 0)
        self.assertEqual(observed[-1]["PUBLIC_BASE_URL"], tunnel.url)
        tunnel.close.assert_called_once()

    def test_local_key_format_validation(self):
        self.assertTrue(launcher.valid_api_key("sk-" + "x" * 30))
        for value in ("", "sk-short", "sk-your-openai-api-key", "sk-" + "x" * 30 + "\n"):
            self.assertFalse(launcher.valid_api_key(value))


if __name__ == "__main__":
    unittest.main()
