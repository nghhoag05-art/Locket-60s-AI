"""Offline dialog tests: fake Tk only, without clipboard access or real input."""

import builtins
import sys
import types
import unittest
from unittest.mock import MagicMock, patch

from backend_py.key_input import KeyDialogUnavailable, read_masked_key


class FakeTclError(Exception):
    pass


class KeyInputTests(unittest.TestCase):
    def fake_tk(self, *, result="test-only-dialog-input"):
        root = MagicMock()
        tk = types.ModuleType("tkinter")
        tk.TclError = FakeTclError
        tk.Tk = MagicMock(return_value=root)
        dialog = types.ModuleType("tkinter.simpledialog")
        dialog.askstring = MagicMock(return_value=result)
        tk.simpledialog = dialog
        return tk, dialog, root

    def test_dialog_masks_input_and_destroys_temporary_root(self):
        tk, dialog, root = self.fake_tk()
        with patch.dict(sys.modules, {"tkinter": tk, "tkinter.simpledialog": dialog}):
            self.assertEqual(read_masked_key(), "test-only-dialog-input")
        tk.Tk.assert_called_once_with()
        root.withdraw.assert_called_once_with()
        root.attributes.assert_called_once_with("-topmost", True)
        root.destroy.assert_called_once_with()
        args, kwargs = dialog.askstring.call_args
        self.assertEqual(args[0], "Locket AI - Nhap khoa OpenAI")
        for instruction in ("Ctrl+V", "OK", "Cancel"):
            self.assertIn(instruction, args[1])
        self.assertEqual(kwargs, {"show": "*", "parent": root})
        self.assertNotIn("initialvalue", kwargs)

    def test_safe_retry_diagnostic_is_included(self):
        tk, dialog, root = self.fake_tk()
        diagnostic = "The local format check failed."
        with patch.dict(sys.modules, {"tkinter": tk, "tkinter.simpledialog": dialog}):
            read_masked_key(problem=diagnostic)
        self.assertTrue(dialog.askstring.call_args.args[1].startswith(diagnostic + "\n\n"))
        root.destroy.assert_called_once_with()

    def test_cancel_and_empty_input_remain_distinct(self):
        for result in (None, ""):
            with self.subTest(cancelled=result is None):
                tk, dialog, root = self.fake_tk(result=result)
                with patch.dict(sys.modules, {"tkinter": tk, "tkinter.simpledialog": dialog}):
                    self.assertEqual(read_masked_key(), result)
                root.destroy.assert_called_once_with()

    def test_each_call_owns_a_new_root(self):
        tk, dialog, first = self.fake_tk()
        second = MagicMock()
        tk.Tk.side_effect = [first, second]
        with patch.dict(sys.modules, {"tkinter": tk, "tkinter.simpledialog": dialog}):
            read_masked_key()
            read_masked_key()
        self.assertEqual(tk.Tk.call_count, 2)
        first.destroy.assert_called_once_with()
        second.destroy.assert_called_once_with()

    def test_optional_topmost_failure_does_not_prevent_masked_entry(self):
        tk, dialog, root = self.fake_tk()
        root.attributes.side_effect = FakeTclError("test-only-window-manager-detail")
        with patch.dict(sys.modules, {"tkinter": tk, "tkinter.simpledialog": dialog}):
            self.assertEqual(read_masked_key(), "test-only-dialog-input")
        dialog.askstring.assert_called_once()
        root.destroy.assert_called_once_with()

    def test_tk_failure_is_sanitized_and_created_root_is_destroyed(self):
        for operation in ("Tk", "withdraw", "askstring"):
            with self.subTest(operation=operation):
                tk, dialog, root = self.fake_tk()
                marker = "test-only-sensitive-error-detail"
                target = {"Tk": tk.Tk, "withdraw": root.withdraw, "askstring": dialog.askstring}[operation]
                target.side_effect = FakeTclError(marker)
                with patch.dict(sys.modules, {"tkinter": tk, "tkinter.simpledialog": dialog}):
                    with self.assertRaises(KeyDialogUnavailable) as caught:
                        read_masked_key()
                self.assertNotIn(marker, str(caught.exception))
                self.assertIn("--console-key", str(caught.exception))
                self.assertTrue(caught.exception.__suppress_context__)
                if operation == "Tk":
                    root.destroy.assert_not_called()
                else:
                    root.destroy.assert_called_once_with()

    def test_cleanup_error_does_not_disclose_exception_or_override_result(self):
        tk, dialog, root = self.fake_tk()
        root.destroy.side_effect = FakeTclError("test-only-cleanup-detail")
        with patch.dict(sys.modules, {"tkinter": tk, "tkinter.simpledialog": dialog}):
            self.assertEqual(read_masked_key(), "test-only-dialog-input")

    def test_missing_tk_import_is_sanitized_without_creating_a_window(self):
        real_import = builtins.__import__

        def missing_tk(name, *args, **kwargs):
            if name == "tkinter":
                raise ImportError("test-only-import-detail")
            return real_import(name, *args, **kwargs)

        with patch("builtins.__import__", side_effect=missing_tk):
            with self.assertRaises(KeyDialogUnavailable) as caught:
                read_masked_key()
        self.assertNotIn("test-only-import-detail", str(caught.exception))
        self.assertTrue(caught.exception.__suppress_context__)

    def test_simpledialog_import_failure_is_sanitized(self):
        tk, dialog, root = self.fake_tk()
        real_import = builtins.__import__

        def missing_dialog(name, globals=None, locals=None, fromlist=(), level=0):
            if name == "tkinter" and "simpledialog" in (fromlist or ()):
                raise ImportError("test-only-dialog-import-detail")
            return real_import(name, globals, locals, fromlist, level)

        with patch.dict(sys.modules, {"tkinter": tk, "tkinter.simpledialog": dialog}), patch("builtins.__import__", side_effect=missing_dialog):
            with self.assertRaises(KeyDialogUnavailable) as caught:
                read_masked_key()
        self.assertNotIn("test-only-dialog-import-detail", str(caught.exception))
        self.assertIn("--console-key", str(caught.exception))
        tk.Tk.assert_not_called()


if __name__ == "__main__":
    unittest.main()
