"""Short-lived storage for images returned by the configured image provider."""

from __future__ import annotations

import os
from pathlib import Path
import re
import secrets
import stat
import threading
import time


MIME_EXT = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}
SAFE_NAME = re.compile(r"[a-f0-9]{48}\.(?:png|jpg|webp)\Z")


def image_type(data: bytes) -> str | None:
    """Recognize supported container signatures; this does not decode pixels."""
    if not isinstance(data, bytes):
        return None
    if (len(data) >= 24 and data[:8] == b"\x89PNG\r\n\x1a\n"
            and data[12:16] == b"IHDR"
            and int.from_bytes(data[16:20], "big") > 0
            and int.from_bytes(data[20:24], "big") > 0):
        return "image/png"
    if len(data) > 4 and data[:3] == b"\xff\xd8\xff" and data[-2:] == b"\xff\xd9":
        return "image/jpeg"
    if (len(data) >= 16 and data[:4] == b"RIFF" and data[8:12] == b"WEBP"
            and int.from_bytes(data[4:8], "little") + 8 == len(data)):
        return "image/webp"
    return None


class FileImageStore:
    def __init__(self, directory: str | Path, ttl_seconds: int = 900, now=time.time):
        self.directory = Path(directory).resolve()
        self.ttl_seconds = ttl_seconds
        self.now = now
        self._lock = threading.Lock()

    def save(self, data: bytes, mime: str) -> str:
        if mime not in MIME_EXT or image_type(data) != mime:
            raise ValueError("Unsupported generated image")
        self.directory.mkdir(parents=True, exist_ok=True)
        for _ in range(3):
            name = f"{secrets.token_hex(24)}.{MIME_EXT[mime]}"
            try:
                with (self.directory / name).open("xb") as handle:
                    try:
                        os.chmod(handle.name, 0o600)
                    except OSError:
                        pass  # Windows ACLs control local access instead.
                    handle.write(data)
                stamp = self.now()
                os.utime(self.directory / name, (stamp, stamp))
                return name
            except FileExistsError:
                continue
        raise OSError("Could not allocate an image filename")

    def read(self, filename: str) -> tuple[bytes, str] | None:
        if not SAFE_NAME.fullmatch(filename):
            return None
        path = self.directory / filename
        with self._lock:
            try:
                info = path.lstat()
                if not stat.S_ISREG(info.st_mode) or path.is_symlink():
                    return None
                if self.now() - info.st_mtime >= self.ttl_seconds:
                    path.unlink(missing_ok=True)
                    return None
                mime = next(mime for mime, ext in MIME_EXT.items() if filename.endswith("." + ext))
                return path.read_bytes(), mime
            except FileNotFoundError:
                return None

    def cleanup(self) -> None:
        with self._lock:
            try:
                paths = list(self.directory.iterdir())
            except FileNotFoundError:
                return
            for path in paths:
                if not SAFE_NAME.fullmatch(path.name):
                    continue
                try:
                    info = path.lstat()
                    if stat.S_ISREG(info.st_mode) and self.now() - info.st_mtime >= self.ttl_seconds:
                        path.unlink(missing_ok=True)
                except FileNotFoundError:
                    pass

    def close(self) -> None:
        pass
