"""Offline, bounded photo composition with repository-owned PNG overlays.

Only the caller downloads source photos. This module never opens URLs, makes
provider calls, or writes source images to disk.
"""

from __future__ import annotations

from dataclasses import dataclass
import io
import json
from pathlib import Path
import re
import warnings

try:
    from PIL import Image, ImageOps
except ImportError:  # Keep health and the independent AI route available.
    Image = ImageOps = None


MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_PIXELS = 25_000_000
REPOSITORY_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_ASSET_ROOT = REPOSITORY_ROOT / "assets" / "filters"
DEFAULT_MANIFEST_PATH = DEFAULT_ASSET_ROOT / "render-presets.json"
CANONICAL_PRESET_IDS = frozenset((
    "frame_berry_days", "frame_happy_snap", "frame_sky_diary",
    "photobooth_4cut", "photobooth_cute", "pb_holo_4cut",
    "pb_scrapbook_ripped_4cut", "pb_ripped_paper_4cut", "pb_denim_ripped_2x2",
    "frame_classic_pb", "sticker_b_nh_lu_n_minh_tu", "cmt_locket",
    "khung_hello_kitty_pastel_ng_t_ng_o", "khung_hello_kitty_h_ng_pastel",
    "khung_nh_n_pastel_vi_n_ren", "khung_nh_hoa_pastel_vi_n_xanh_m_nh",
    "khung_nh_vu_ng_m_ng_nh_n_b_c", "khung_kh_ng_gian_xanh_pastel",
    "khung_vu_ng_ng_i_sao_h_ng_pastel", "khung_nh_pastel_vi_n_s_h_i_c_u",
    "khung_nh_shin_chan_vi_n_m_nh", "khung_anh_o_kitty_v_sao",
    "khung_xanh_v_tay_sao_v_ng", "sinh_nh_t_hello_kitty_ho_i_c",
    "pb_single_y2k_silver_holo", "pb_single_denim_ripped", "pb_single_film_nostalgia",
))
ASSET_PATH = re.compile(r"assets/filters/[a-f0-9]{64}\.png\Z")
MIME_FORMAT = {"image/png": "PNG", "image/jpeg": "JPEG", "image/webp": "WEBP"}


class CompositionError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def _fail(status, code, message):
    raise CompositionError(status, code, message)


@dataclass(frozen=True)
class Preset:
    asset: Path
    size: tuple[int, int]
    slots: tuple[tuple[int, int, int, int], ...]


def _dimensions(value):
    return (isinstance(value, list) and len(value) == 2
            and all(type(part) is int and part > 0 for part in value)
            and value[0] * value[1] <= MAX_PIXELS)


def _load_preset(preset_id, manifest_path=None, asset_root=None):
    if not isinstance(preset_id, str) or not re.fullmatch(r"[a-z0-9_]{1,100}", preset_id):
        _fail(400, "unknown_preset", "Choose a supported frame or Photobooth preset.")
    try:
        manifest_file = Path(manifest_path or DEFAULT_MANIFEST_PATH)
        if manifest_file.stat().st_size > 256 * 1024:
            raise ValueError()
        manifest = json.loads(manifest_file.read_bytes())
        if not isinstance(manifest, dict) or manifest.get("version") != 1:
            raise ValueError()
        presets = manifest["presets"]
        aliases = manifest.get("aliases", {})
        if not isinstance(presets, dict) or not isinstance(aliases, dict):
            raise ValueError()
        canonical = aliases.get(preset_id, preset_id)
        if canonical not in CANONICAL_PRESET_IDS:
            _fail(400, "unknown_preset", "Choose a supported frame or Photobooth preset.")
        if canonical not in presets:
            raise ValueError()
        entry = presets[canonical]
        if not isinstance(entry, dict) or entry.get("kind") not in ("frame", "photobooth"):
            raise ValueError()
        size, slots, asset = entry.get("size"), entry.get("slots"), entry.get("asset")
        if not _dimensions(size) or not isinstance(slots, list) or len(slots) not in (1, 4):
            raise ValueError()
        if (entry["kind"] == "frame" and len(slots) != 1
                or entry["kind"] == "photobooth" and len(slots) != 4):
            raise ValueError()
        if not isinstance(asset, str) or not ASSET_PATH.fullmatch(asset):
            raise ValueError()
        checked_slots = []
        for slot in slots:
            if (not isinstance(slot, list) or len(slot) != 4
                    or any(type(part) is not int for part in slot)):
                raise ValueError()
            x, y, width, height = slot
            if x < 0 or y < 0 or width <= 0 or height <= 0 or x + width > size[0] or y + height > size[1]:
                raise ValueError()
            # Overlapping slots would silently obscure one of the source photos.
            if any(x < bx + bw and bx < x + width and y < by + bh and by < y + height
                   for bx, by, bw, bh in checked_slots):
                raise ValueError()
            checked_slots.append(tuple(slot))
        root = Path(asset_root or DEFAULT_ASSET_ROOT).resolve()
        asset_path = (root / Path(asset).name).resolve()
        if not asset_path.is_relative_to(root) or not asset_path.is_file():
            raise ValueError()
        if asset_path.stat().st_size > MAX_IMAGE_BYTES:
            raise ValueError()
        return Preset(asset_path, tuple(size), tuple(checked_slots))
    except CompositionError:
        raise
    except (ValueError, TypeError, KeyError, OSError, OverflowError):
        _fail(503, "composition_unavailable", "The local composition preset is unavailable.")


def validate_composition_request(preset_id, source_count, *, manifest_path=None, asset_root=None):
    """Validate local preset/count before any source DNS lookup or download."""
    preset = _load_preset(preset_id, manifest_path, asset_root)
    if type(source_count) is not int or source_count not in (1, len(preset.slots)):
        _fail(400, "invalid_source_count", "Provide one source photo, or four photos for a four-slot preset.")
    return preset


def _decode(data, mime, *, overlay=False):
    if (not isinstance(data, bytes) or not data or len(data) > MAX_IMAGE_BYTES
            or mime not in MIME_FORMAT):
        raise ValueError()
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        with Image.open(io.BytesIO(data), formats=(MIME_FORMAT[mime],)) as check:
            if (check.format != MIME_FORMAT[mime] or check.width * check.height > MAX_PIXELS
                    or check.width < 1 or check.height < 1 or getattr(check, "n_frames", 1) != 1):
                raise ValueError()
            if overlay and "A" not in check.getbands() and "transparency" not in check.info:
                raise ValueError()
            check.verify()
        with Image.open(io.BytesIO(data), formats=(MIME_FORMAT[mime],)) as source:
            source.load()  # Signature checks alone cannot establish valid pixels.
            oriented = ImageOps.exif_transpose(source)
            try:
                return oriented.convert("RGBA")
            finally:
                if oriented is not source:
                    oriented.close()


class _BoundedOutput(io.BytesIO):
    def write(self, value):
        if self.tell() + len(value) > MAX_IMAGE_BYTES:
            raise ValueError()
        return super().write(value)


def compose_images(images, preset_id, *, manifest_path=None, asset_root=None):
    """Return a real PNG composite and truthful source/slot counts.

    A single source is deliberately reused in every slot. Four inputs preserve
    their order and fill the four slots independently; this does not manufacture
    additional captures or apply an AI effect.
    """
    if Image is None:
        _fail(503, "composition_unavailable", "The local image composer is unavailable.")
    if not isinstance(images, list) or not 1 <= len(images) <= 4:
        _fail(400, "invalid_source_count", "Provide one source photo, or four photos for a four-slot preset.")
    preset = validate_composition_request(preset_id, len(images), manifest_path=manifest_path, asset_root=asset_root)
    overlay = None
    try:
        overlay = _decode(preset.asset.read_bytes(), "image/png", overlay=True)
        if overlay.size != preset.size:
            raise ValueError()
        alpha = overlay.getchannel("A")
        try:
            if any(alpha.crop((x, y, x + w, y + h)).getextrema()[0] == 255 for x, y, w, h in preset.slots):
                raise ValueError()
        finally:
            alpha.close()
    except Exception:
        if overlay is not None:
            overlay.close()
        _fail(503, "composition_unavailable", "The local composition preset is unavailable.")
    canvas = Image.new("RGBA", preset.size, (255, 255, 255, 255))
    try:
        for source_index, image in enumerate(images):
            try:
                if not isinstance(image, tuple) or len(image) != 2:
                    raise ValueError()
                source = _decode(*image)
            except Exception:
                _fail(415, "invalid_image", "The source must be a valid PNG, JPEG or WebP image.")
            try:
                slots = preset.slots if len(images) == 1 else (preset.slots[source_index],)
                for x, y, width, height in slots:
                    fitted = ImageOps.fit(source, (width, height), method=Image.Resampling.LANCZOS)
                    try:
                        canvas.alpha_composite(fitted, (x, y))
                    finally:
                        fitted.close()
            finally:
                source.close()
        canvas.alpha_composite(overlay)
        try:
            with _BoundedOutput() as output:
                # New canvas and explicit options exclude input EXIF, ICC, text,
                # GPS and orientation metadata from the public output.
                canvas.save(output, format="PNG")
                generated = output.getvalue()
        except Exception:
            _fail(413, "composition_too_large", "The composed image exceeds the output size limit.")
        return generated, "image/png", {"sourceImageCount": len(images), "slotCount": len(preset.slots)}
    finally:
        canvas.close()
        overlay.close()
