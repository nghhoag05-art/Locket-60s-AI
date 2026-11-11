"""Launcher unit tests: no listeners, subprocesses, real keys or network calls."""

import contextlib
import io
from pathlib import Path
import tempfile
import unittest
import warnings
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
        for value in ("", "sk-short", "sk-your-openai-api-key", "sk-" + "x" * 30 + "\n", "sk-proj-" + "*" * 30, "sk-" + "x" * 30 + "...", "sk-" + "x" * 30 + "\u2026"):
            self.assertFalse(launcher.valid_api_key(value))

    def test_bad_paste_then_valid_key_retries_without_saving_or_echoing_candidates(self):
        key = "sk-" + "test-only-key-" * 3
        bad = "private test-only bad input"
        env = {}
        output = io.StringIO()

        def hidden(prompt, *, echo_char):
            self.assertEqual(echo_char, "*")
            self.assertNotIn("OPENAI_API_KEY", env)
            return next(candidates)

        candidates = iter([bad, "\x16", "  " + key + "  "])
        with contextlib.redirect_stdout(output), patch.object(launcher.sys.stdin, "isatty", return_value=True), patch.object(launcher.sys.stdout, "isatty", return_value=True), patch.object(launcher.getpass, "getpass", side_effect=hidden) as getpass_mock, patch.object(launcher.secrets, "token_urlsafe", return_value="test-only-token-" * 3) as generate:
            launcher.prepare_credentials(env, no_prompt=False, console_key=True)
        self.assertEqual(env["OPENAI_API_KEY"], key)
        self.assertEqual(getpass_mock.call_count, 3)
        generate.assert_called_once_with(32)
        self.assertIn("Please try again", output.getvalue())
        self.assertIn("control character", output.getvalue())
        self.assertNotIn(key, output.getvalue())
        self.assertNotIn(bad, output.getvalue())
        self.assertNotIn("\x16", output.getvalue())

    def test_three_invalid_attempts_stop_without_storing_key_or_generating_token(self):
        for candidate in ("", "\x16", "private test-only invalid value"):
            with self.subTest(empty=not candidate):
                env = {}
                output = io.StringIO()
                with contextlib.redirect_stdout(output), patch.object(launcher.sys.stdin, "isatty", return_value=True), patch.object(launcher.sys.stdout, "isatty", return_value=True), patch.object(launcher.getpass, "getpass", return_value=candidate) as hidden, patch.object(launcher.secrets, "token_urlsafe") as generate:
                    with self.assertRaisesRegex(launcher.LauncherError, "three attempts") as error:
                        launcher.prepare_credentials(env, no_prompt=False, console_key=True)
                self.assertEqual(hidden.call_count, 3)
                self.assertEqual(env, {})
                generate.assert_not_called()
                if candidate:
                    self.assertNotIn(candidate, output.getvalue() + str(error.exception))

    def test_safe_key_diagnostics_do_not_include_candidates(self):
        samples = [
            ("", "No key"), ("\x16", "control character"),
            ("private test-only value", "spaces"),
            ('"sk-' + "test-only-" * 3 + '"', "quotes"),
            ("sk-proj-" + "*" * 30, "masked"),
            ("sk-" + "test-only-" * 3 + "...", "shortened"),
            ("private-test-only-invalid-key", "local format"),
        ]
        for candidate, expected in samples:
            with self.subTest(reason=expected):
                message = launcher.api_key_input_error(candidate)
                self.assertIn(expected, message)
                if candidate:
                    self.assertNotIn(candidate, message)

    def test_getpass_warning_stops_before_visible_fallback(self):
        def unsafe_fallback(*args, **kwargs):
            warnings.warn("test-only warning", launcher.getpass.GetPassWarning)
            self.fail("A visible fallback must not execute")

        with patch.object(launcher.getpass, "getpass", side_effect=unsafe_fallback), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(launcher.LauncherError, "Secure key input"):
                launcher.prompt_api_key(console_key=True)

    def test_cancelled_prompt_does_not_store_credentials_or_generate_token(self):
        for exception in (KeyboardInterrupt, EOFError):
            with self.subTest(exception=exception.__name__):
                env = {}
                with contextlib.redirect_stdout(io.StringIO()), patch.object(launcher.sys.stdin, "isatty", return_value=True), patch.object(launcher.sys.stdout, "isatty", return_value=True), patch.object(launcher.getpass, "getpass", side_effect=exception), patch.object(launcher.secrets, "token_urlsafe") as generate:
                    with self.assertRaises(exception):
                        launcher.prepare_credentials(env, no_prompt=False, console_key=True)
                self.assertEqual(env, {})
                generate.assert_not_called()

    def test_existing_valid_key_is_used_without_secret_prompt(self):
        key = "sk-" + "test-only-existing-" * 2
        token = "test-only-token-" * 3
        env = {"OPENAI_API_KEY": key, "BACKEND_ACCESS_TOKEN": token}
        with contextlib.redirect_stdout(io.StringIO()) as output, patch.object(launcher.sys.stdin, "isatty", return_value=True), patch.object(launcher.sys.stdout, "isatty", return_value=True), patch("builtins.input", return_value="y"), patch.object(launcher.getpass, "getpass") as hidden, patch.object(launcher.secrets, "token_urlsafe") as generate:
            launcher.prepare_credentials(env, no_prompt=False, console_key=True)
        self.assertEqual(env, {"OPENAI_API_KEY": key, "BACKEND_ACCESS_TOKEN": token})
        hidden.assert_not_called()
        generate.assert_not_called()
        self.assertNotIn(key, output.getvalue())
        self.assertNotIn(token, output.getvalue())

    def test_invalid_existing_environment_key_requests_a_replacement(self):
        bad = "private test-only invalid environment value"
        key = "sk-" + "test-only-fresh-" * 2
        token = "test-only-token-" * 3
        env = {"OPENAI_API_KEY": bad, "BACKEND_ACCESS_TOKEN": token}
        with contextlib.redirect_stdout(io.StringIO()) as output, patch.object(launcher.sys.stdin, "isatty", return_value=True), patch.object(launcher.sys.stdout, "isatty", return_value=True), patch("builtins.input", return_value="y"), patch.object(launcher.getpass, "getpass", return_value=key) as hidden:
            launcher.prepare_credentials(env, no_prompt=False, console_key=True)
        self.assertEqual(env["OPENAI_API_KEY"], key)
        hidden.assert_called_once()
        self.assertNotIn(bad, output.getvalue())
        self.assertNotIn(key, output.getvalue())

    def test_windows_default_uses_masked_dialog_without_getpass(self):
        key = "sk-" + "test-only-dialog-" * 2
        env = {"BACKEND_ACCESS_TOKEN": "test-only-token-" * 3}
        with contextlib.redirect_stdout(io.StringIO()) as output, patch.object(launcher.sys.stdin, "isatty", return_value=True), patch.object(launcher.sys.stdout, "isatty", return_value=True), patch.object(launcher, "WINDOWS_KEY_DIALOG", True), patch.object(launcher, "read_masked_key", return_value=key) as dialog, patch.object(launcher.getpass, "getpass") as hidden:
            launcher.prepare_credentials(env, no_prompt=False)
        self.assertEqual(env["OPENAI_API_KEY"], key)
        dialog.assert_called_once_with(problem=None)
        hidden.assert_not_called()
        self.assertNotIn(key, output.getvalue())

    def test_windows_dialog_retries_include_safe_diagnostic_without_secret_echo(self):
        bad = "private test-only bad dialog value"
        key = "sk-" + "test-only-dialog-" * 2
        env = {"BACKEND_ACCESS_TOKEN": "test-only-token-" * 3}
        with contextlib.redirect_stdout(io.StringIO()) as output, patch.object(launcher.sys.stdin, "isatty", return_value=True), patch.object(launcher.sys.stdout, "isatty", return_value=True), patch.object(launcher, "WINDOWS_KEY_DIALOG", True), patch.object(launcher, "read_masked_key", side_effect=[bad, key]) as dialog, patch.object(launcher.getpass, "getpass") as hidden:
            launcher.prepare_credentials(env, no_prompt=False)
        self.assertEqual(dialog.call_count, 2)
        self.assertIn("spaces", dialog.call_args.kwargs["problem"])
        self.assertEqual(env["OPENAI_API_KEY"], key)
        hidden.assert_not_called()
        self.assertNotIn(key, output.getvalue())
        self.assertNotIn(bad, output.getvalue())

    def test_cancelled_windows_dialog_keeps_credentials_empty(self):
        env = {}
        with contextlib.redirect_stdout(io.StringIO()), patch.object(launcher.sys.stdin, "isatty", return_value=True), patch.object(launcher.sys.stdout, "isatty", return_value=True), patch.object(launcher, "WINDOWS_KEY_DIALOG", True), patch.object(launcher, "read_masked_key", return_value=None), patch.object(launcher.getpass, "getpass") as hidden, patch.object(launcher.secrets, "token_urlsafe") as generate:
            with self.assertRaises(EOFError):
                launcher.prepare_credentials(env, no_prompt=False)
        self.assertEqual(env, {})
        hidden.assert_not_called()
        generate.assert_not_called()

    def test_unavailable_dialog_stops_without_automatic_console_fallback(self):
        env = {}
        with contextlib.redirect_stdout(io.StringIO()), patch.object(launcher.sys.stdin, "isatty", return_value=True), patch.object(launcher.sys.stdout, "isatty", return_value=True), patch.object(launcher, "WINDOWS_KEY_DIALOG", True), patch.object(launcher, "read_masked_key", side_effect=launcher.KeyDialogUnavailable("private-test-only-error")), patch.object(launcher.getpass, "getpass") as hidden:
            with self.assertRaisesRegex(launcher.LauncherError, "key window") as error:
                launcher.prepare_credentials(env, no_prompt=False)
        self.assertEqual(env, {})
        self.assertNotIn("private-test-only-error", str(error.exception))
        hidden.assert_not_called()

    def test_explicit_console_mode_bypasses_windows_dialog(self):
        key = "sk-" + "test-only-console-" * 2
        with contextlib.redirect_stdout(io.StringIO()), patch.object(launcher, "WINDOWS_KEY_DIALOG", True), patch.object(launcher, "read_masked_key") as dialog, patch.object(launcher.getpass, "getpass", return_value=key) as hidden:
            self.assertEqual(launcher.prompt_api_key(console_key=True), key)
        hidden.assert_called_once()
        dialog.assert_not_called()

    def test_no_prompt_does_not_open_windows_dialog(self):
        with patch.object(launcher, "WINDOWS_KEY_DIALOG", True), patch.object(launcher, "read_masked_key") as dialog, patch.object(launcher.getpass, "getpass") as hidden:
            launcher.prepare_credentials({}, no_prompt=True)
        dialog.assert_not_called()
        hidden.assert_not_called()

    def test_console_key_cli_flag_is_forwarded_without_starting_real_server(self):
        server = MagicMock(server_port=8787)
        config = MagicMock(configured=False)
        with patch.dict(launcher.os.environ, {}, clear=True), patch.object(launcher, "load_public_settings"), patch.object(launcher, "prepare_credentials") as prepare, patch.object(launcher, "read_config", return_value=config), patch.object(launcher, "create_server", return_value=server), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(launcher.main(["--no-prompt", "--console-key"]), 0)
        self.assertEqual(prepare.call_args.kwargs, {"no_prompt": True, "console_key": True})


if __name__ == "__main__":
    unittest.main()
