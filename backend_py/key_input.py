"""Masked desktop key entry; no programmatic clipboard reads or persisted input."""

from __future__ import annotations


class KeyDialogUnavailable(RuntimeError):
    """A safe error when the desktop key dialog cannot be opened."""


_UNAVAILABLE_MESSAGE = "Secure key dialog is unavailable. Use --console-key in a terminal."
_TITLE = "Locket AI - Nhap khoa OpenAI"


def read_masked_key(*, problem: str | None = None) -> str | None:
    """Return entered text, or None for cancellation, using a temporary Tk root."""
    try:
        import tkinter as tk
    except ImportError:
        raise KeyDialogUnavailable(_UNAVAILABLE_MESSAGE) from None

    root = None
    try:
        from tkinter import simpledialog

        root = tk.Tk()
        root.withdraw()
        try:
            root.attributes("-topmost", True)
        except tk.TclError:
            # Some window managers cannot set this optional focus hint.
            pass
        instructions = (
            "Dán khóa OpenAI đầy đủ bằng Ctrl+V vào ô bên dưới.\n"
            "Khóa được che bằng dấu *. Bấm OK để tiếp tục hoặc Cancel để hủy."
        )
        if problem:
            instructions = problem + "\n\n" + instructions
        return simpledialog.askstring(_TITLE, instructions, show="*", parent=root)
    except (ImportError, tk.TclError):
        raise KeyDialogUnavailable(_UNAVAILABLE_MESSAGE) from None
    finally:
        if root is not None:
            try:
                root.destroy()
            except tk.TclError:
                pass
