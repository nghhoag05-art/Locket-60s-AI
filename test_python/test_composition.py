"""Pixel-level, offline tests for owned-overlay photo composition."""

import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

from backend_py import composition
from backend_py.composition import CompositionError, compose_images, validate_composition_request


FOUR_SLOTS = [[1, 1, 4, 4], [7, 1, 4, 4], [1, 7, 4, 4], [7, 7, 4, 4]]


def image_bytes(color, size=(4, 4), mime="PNG", **options):
    with Image.new("RGB", size, color) as image, io.BytesIO() as output:
        image.save(output, format=mime, **options)
        return output.getvalue()


def composition_fixture(directory, four=False, *, overlay=None, slots=None, size=(12, 12)):
    """Create a tiny real local overlay and trusted manifest, never a URL."""
    root = Path(directory) / "assets" / "filters"
    root.mkdir(parents=True, exist_ok=True)
    slots = slots if slots is not None else (FOUR_SLOTS if four else [[2, 2, 8, 8]])
    if overlay is None:
        overlay = Image.new("RGBA", size, (240, 240, 240, 255))
        for x, y, width, height in slots:
            overlay.paste((0, 0, 0, 0), (x, y, x + width, y + height))
    with overlay, io.BytesIO() as output:
        overlay.save(output, format="PNG")
        data = output.getvalue()
    filename = hashlib.sha256(data).hexdigest() + ".png"
    asset = root / filename
    asset.write_bytes(data)
    preset_id = "photobooth_4cut" if four else "frame_classic_pb"
    manifest = {"version": 1, "presets": {preset_id: {
        "kind": "photobooth" if four else "frame", "asset": "assets/filters/" + filename,
        "size": list(size), "slots": slots}}, "aliases": {"photoboot": "frame_classic_pb"}}
    path = root / "render-presets.json"
    path.write_text(json.dumps(manifest), encoding="utf-8")
    return {"manifest_path": path, "asset_root": root}, preset_id, manifest, asset


class CompositionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent)
        self.addCleanup(self.temp.cleanup)

    def test_real_frame_pixels_preserve_source_color_and_overlay_border(self):
        options, preset_id, _, _ = composition_fixture(self.temp.name)
        source = image_bytes((255, 20, 10))
        data, mime, metadata = compose_images([(source, "image/png")], preset_id, **options)
        self.assertEqual(mime, "image/png")
        self.assertEqual(metadata, {"sourceImageCount": 1, "slotCount": 1})
        self.assertNotEqual(data, source)
        with Image.open(io.BytesIO(data)) as result:
            self.assertEqual(result.size, (12, 12))
            self.assertEqual(result.getpixel((5, 5)), (255, 20, 10, 255))
            self.assertEqual(result.getpixel((0, 0)), (240, 240, 240, 255))

    def test_one_source_fills_four_windows_and_reports_only_one_source(self):
        options, preset_id, _, _ = composition_fixture(self.temp.name, four=True)
        data, _, metadata = compose_images([(image_bytes((255, 0, 0)), "image/png")], preset_id, **options)
        self.assertEqual(metadata, {"sourceImageCount": 1, "slotCount": 4})
        with Image.open(io.BytesIO(data)) as result:
            for x, y, _, _ in FOUR_SLOTS:
                self.assertEqual(result.getpixel((x + 1, y + 1)), (255, 0, 0, 255))

    def test_four_distinct_sources_keep_input_order_and_pixel_colors(self):
        options, preset_id, _, _ = composition_fixture(self.temp.name, four=True)
        colors = [(255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 0)]
        data, _, metadata = compose_images([(image_bytes(color), "image/png") for color in colors], preset_id, **options)
        self.assertEqual(metadata, {"sourceImageCount": 4, "slotCount": 4})
        with Image.open(io.BytesIO(data)) as result:
            for (x, y, _, _), color in zip(FOUR_SLOTS, colors):
                self.assertEqual(result.getpixel((x + 1, y + 1)), color + (255,))

    def test_overlay_alpha_blends_on_top_of_photo(self):
        overlay = Image.new("RGBA", (4, 4), (0, 255, 0, 128))
        options, preset_id, _, _ = composition_fixture(self.temp.name, overlay=overlay, slots=[[0, 0, 4, 4]], size=(4, 4))
        data, _, _ = compose_images([(image_bytes((255, 0, 0)), "image/png")], preset_id, **options)
        with Image.open(io.BytesIO(data)) as result:
            self.assertEqual(result.getpixel((2, 2)), (127, 128, 0, 255))

    def test_exif_orientation_is_applied_and_metadata_is_removed(self):
        options, preset_id, _, _ = composition_fixture(self.temp.name, slots=[[0, 0, 3, 2]], size=(3, 2))
        with Image.new("RGB", (2, 3), (255, 0, 0)) as source, io.BytesIO() as output:
            source.putpixel((0, 2), (0, 0, 255))
            exif = Image.Exif()
            exif[274] = 6  # Clockwise rotation: bottom-left becomes top-left.
            exif[270] = "private metadata marker"
            source.save(output, format="PNG", exif=exif)
            encoded = output.getvalue()
        data, _, _ = compose_images([(encoded, "image/png")], preset_id, **options)
        with Image.open(io.BytesIO(data)) as result:
            self.assertEqual(result.getpixel((0, 0)), (0, 0, 255, 255))
            self.assertEqual(result.getpixel((2, 0)), (255, 0, 0, 255))
            self.assertFalse(result.getexif())
            self.assertNotIn("exif", result.info)
        self.assertNotIn(b"private metadata marker", data)

    def test_valid_jpeg_and_webp_inputs_are_decoded(self):
        options, preset_id, _, _ = composition_fixture(self.temp.name)
        for file_format, mime in (("JPEG", "image/jpeg"), ("WEBP", "image/webp")):
            with self.subTest(format=file_format):
                data, _, _ = compose_images([(image_bytes((255, 0, 0), mime=file_format), mime)], preset_id, **options)
                with Image.open(io.BytesIO(data)) as result:
                    self.assertGreater(result.getpixel((5, 5))[0], 245)

    def test_invalid_counts_unknown_ids_and_manifest_alias(self):
        options, preset_id, _, _ = composition_fixture(self.temp.name, four=True)
        for count in (0, 2, 3, 5):
            with self.subTest(count=count), self.assertRaises(CompositionError) as caught:
                compose_images([(image_bytes((0, 0, 0)), "image/png")] * count, preset_id, **options)
            self.assertEqual(caught.exception.status, 400)
        with self.assertRaises(CompositionError) as caught:
            validate_composition_request("does_not_exist", 1, **options)
        self.assertEqual(caught.exception.code, "unknown_preset")
        options, preset_id, _, _ = composition_fixture(self.temp.name)
        validate_composition_request("photoboot", 1, **options)
        with self.assertRaises(CompositionError):
            validate_composition_request(preset_id, 4, **options)

    def test_invalid_real_images_and_oversized_dimensions_fail_generically(self):
        options, preset_id, _, _ = composition_fixture(self.temp.name)
        valid = image_bytes((255, 0, 0))
        for encoded, mime in ((valid[:24], "image/png"), (valid[:-10], "image/png"),
                              (valid, "image/jpeg"), (b"not image", "image/png")):
            with self.subTest(mime=mime, length=len(encoded)), self.assertRaises(CompositionError) as caught:
                compose_images([(encoded, mime)], preset_id, **options)
            self.assertEqual(caught.exception.status, 415)
        # Make the pixel cap small to test actual decoder dimensions cheaply.
        with patch.object(composition, "MAX_PIXELS", 20), self.assertRaises(ValueError):
            composition._decode(image_bytes((0, 0, 0), (5, 5)), "image/png")

    def test_malformed_assets_manifest_dimensions_and_traversal_are_generic(self):
        bad_entries = ({"asset": "https://example.com/overlay.png"}, {"asset": "assets/filters/../../private.png"},
                       {"asset": "C:/private.png"}, {"size": [99999, 99999]}, {"size": [True, 12]},
                       {"slots": [[-1, 0, 4, 4]]}, {"slots": [[11, 11, 4, 4]]}, {"kind": "url"})
        for change in bad_entries:
            options, preset_id, manifest, _ = composition_fixture(self.temp.name)
            manifest["presets"][preset_id].update(change)
            options["manifest_path"].write_text(json.dumps(manifest))
            with self.subTest(change=change), self.assertRaises(CompositionError) as caught:
                validate_composition_request(preset_id, 1, **options)
            self.assertEqual(caught.exception.status, 503)
            self.assertNotIn(str(self.temp.name), str(caught.exception))
        for overlay in (Image.new("RGB", (12, 12)), Image.new("RGBA", (12, 12), (0, 0, 0, 255)),
                        Image.new("RGBA", (10, 10), (0, 0, 0, 0))):
            options, preset_id, _, _ = composition_fixture(self.temp.name, overlay=overlay)
            with self.assertRaises(CompositionError) as caught:
                compose_images([(image_bytes((0, 0, 0)), "image/png")], preset_id, **options)
            self.assertEqual(caught.exception.code, "composition_unavailable")
        options, preset_id, _, asset = composition_fixture(self.temp.name)
        asset.write_bytes(b"not a PNG")
        with self.assertRaises(CompositionError):
            compose_images([(image_bytes((0, 0, 0)), "image/png")], preset_id, **options)

    def test_missing_decoder_and_bounded_png_output_fail_without_fallback(self):
        options, preset_id, _, _ = composition_fixture(self.temp.name)
        with patch.object(composition, "Image", None), self.assertRaises(CompositionError) as caught:
            compose_images([(image_bytes((0, 0, 0)), "image/png")], preset_id, **options)
        self.assertEqual(caught.exception.status, 503)
        output = composition._BoundedOutput()
        with patch.object(composition, "MAX_IMAGE_BYTES", 3):
            output.write(b"abc")
            with self.assertRaises(ValueError):
                output.write(b"d")
        output.close()

    def test_decompression_bomb_is_rejected_as_invalid_source_pixels(self):
        options, preset_id, _, _ = composition_fixture(self.temp.name, slots=[[0, 0, 2, 2]], size=(2, 2))
        source = image_bytes((255, 0, 0), (4, 4))
        with patch.object(Image, "MAX_IMAGE_PIXELS", 5), self.assertRaises(CompositionError) as caught:
            compose_images([(source, "image/png")], preset_id, **options)
        self.assertEqual(caught.exception.code, "invalid_image")


class RepositoryPresetTests(unittest.TestCase):
    def test_all_27_bundled_presets_render_real_photo_windows(self):
        manifest = json.loads(composition.DEFAULT_MANIFEST_PATH.read_bytes())
        self.assertEqual(set(manifest["presets"]), composition.CANONICAL_PRESET_IDS)
        self.assertEqual(sum(entry["kind"] == "photobooth" for entry in manifest["presets"].values()), 9)
        source = image_bytes((239, 31, 47))
        for preset_id, entry in manifest["presets"].items():
            with self.subTest(preset_id=preset_id):
                data, mime, metadata = compose_images([(source, "image/png")], preset_id)
                self.assertEqual(mime, "image/png")
                self.assertEqual(metadata, {"sourceImageCount": 1, "slotCount": len(entry["slots"])})
                with Image.open(io.BytesIO(data)) as result:
                    self.assertEqual(result.size, tuple(entry["size"]))
                    for x, y, width, height in entry["slots"]:
                        self.assertEqual(result.getpixel((x + width // 2, y + height // 2)), (239, 31, 47, 255))


if __name__ == "__main__":
    unittest.main()
