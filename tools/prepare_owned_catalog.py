"""Mirror public catalog art and build locally owned, renderable frame presets.

Run with the project's virtualenv. Only --download makes public static-image GETs.
No API credentials, account data, user photographs or generation endpoints are used.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import io
import json
from pathlib import Path
from urllib.parse import urlsplit
import urllib.request

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
DIRECTORY = ROOT / "assets" / "filters"
PREFIX = "https://raw.githubusercontent.com/nghhoag05-art/Locket-60s-AI/main/"
SOURCE_HOSTS = {"locket-vip.mhiep20077.workers.dev", "uplocket.io.vn"}
FOUR = {"frame_berry_days", "frame_happy_snap", "frame_sky_diary", "photobooth_4cut", "photobooth_cute", "pb_holo_4cut", "pb_scrapbook_ripped_4cut", "pb_ripped_paper_4cut", "pb_denim_ripped_2x2"}
MAXIMUM = 8 * 1024 * 1024


def urls(value):
    if isinstance(value, str) and value.startswith("https://"):
        yield value
    elif isinstance(value, dict):
        for child in value.values():
            yield from urls(child)
    elif isinstance(value, list):
        for child in value:
            yield from urls(child)


def safe_image_url(value):
    parts = urlsplit(value)
    if parts.scheme != "https" or parts.hostname not in SOURCE_HOSTS or parts.username or parts.password or parts.port or parts.query or parts.fragment or not parts.path.endswith(".png"):
        raise ValueError("Only pinned public catalog PNG URLs are supported")


class StaticRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        safe_image_url(new_url)
        return super().redirect_request(request, fp, code, message, headers, new_url)


def download(value):
    safe_image_url(value)
    opener = urllib.request.build_opener(StaticRedirects())
    request = urllib.request.Request(value, headers={"User-Agent": "HuyHoang-Locket-Catalog/1.0"})
    fallback = False
    try:
        with opener.open(request, timeout=15) as response:
            if response.headers.get_content_type() != "image/png":
                raise ValueError("Catalog asset is not PNG")
            data = response.read(MAXIMUM + 1)
        if len(data) > MAXIMUM:
            raise ValueError("Catalog asset is too large")
        with Image.open(io.BytesIO(data)) as image:
            if image.format != "PNG" or image.width * image.height > 12_000_000:
                raise ValueError("Invalid catalog image")
            image.verify()
    except (OSError, ValueError):
        # The source may remove old preview URLs. A local icon avoids an external
        # runtime dependency; composition frames receive real photo holes below.
        fallback = True
        digest = hashlib.sha256(value.encode()).digest()
        color = tuple(130 + channel // 2 for channel in digest[:3])
        image = Image.new("RGBA", (512, 512), color + (255,))
        draw = ImageDraw.Draw(image)
        draw.rounded_rectangle((25, 25, 487, 487), radius=90, outline="white", width=12)
        font_path = Path("C:/Windows/Fonts/segoeuib.ttf")
        font = ImageFont.truetype(str(font_path), 210) if font_path.is_file() else ImageFont.load_default(size=210)
        draw.text((168, 90), "H", font=font, fill="white")
        small = ImageFont.truetype(str(font_path), 24) if font_path.is_file() else ImageFont.load_default(size=24)
        label = Path(urlsplit(value).path).stem.removeprefix("stk_").replace("_", " ").upper()[:25]
        box = draw.textbbox((0, 0), label, font=small)
        draw.text(((512 - box[2] + box[0]) / 2, 390), label, font=small, fill=(45, 35, 55, 255))
        buffer = io.BytesIO()
        image.save(buffer, "PNG")
        data = buffer.getvalue()
    digest = hashlib.sha256(data).hexdigest()
    relative = f"assets/filters/{digest}.png"
    (ROOT / relative).write_bytes(data)
    return {"source": value, "path": relative, "sha256": digest, "bytes": len(data), "generatedFallback": fallback}


def holes(image, count):
    """Find substantial transparent components; reject unusable preview artwork."""
    small = image.getchannel("A")
    small.thumbnail((256, 256))
    width, height = small.size
    work = small.point(lambda value: 255 if value < 24 else 0)
    found = []
    while (box := work.getbbox()) is not None:
        # getbbox's left/top need not be a filled pixel; locate one on its top row.
        y = box[1]
        x = next(x for x in range(box[0], box[2]) if work.getpixel((x, y)))
        ImageDraw.floodfill(work, (x, y), 128, thresh=0)
        component = work.point(lambda value: 255 if value == 128 else 0)
        bounds = component.getbbox()
        area = component.histogram()[255]
        work = work.point(lambda value: 0 if value == 128 else value)
        if area < width * height * 0.02 or bounds[2] - bounds[0] < width * 0.14 or bounds[3] - bounds[1] < height * 0.12:
            continue
        # Outer transparent margins are not a photo slot.
        if bounds[0] == 0 or bounds[1] == 0 or bounds[2] == width or bounds[3] == height:
            continue
        found.append((area, bounds))
    if len(found) < count:
        return None
    found = sorted(found, reverse=True)[:count]
    boxes = [item[1] for item in found]
    boxes.sort(key=lambda box: (round(box[1] / max(1, height * 0.15)), box[0]))
    sx, sy = image.width / width, image.height / height
    return [[round(x0 * sx), round(y0 * sy), round((x1 - x0) * sx), round((y1 - y0) * sy)] for x0, y0, x1, y1 in boxes]


def make_frame(filter_data, count):
    """Code-drawn Hoang frame used when source artwork has no usable photo holes."""
    width, height = (1000, 1400)
    colors = filter_data.get("colors") or ["#F4D9E5", "#DCE9F8"]
    color = colors[0] if isinstance(colors[0], str) and len(colors[0]) in (7, 9) else "#F4D9E5"
    canvas = Image.new("RGBA", (width, height), color)
    draw = ImageDraw.Draw(canvas)
    second = colors[-1] if isinstance(colors[-1], str) and len(colors[-1]) in (7, 9) else "#DCE9F8"
    from PIL import ImageColor
    top, bottom = ImageColor.getrgb(color)[:3], ImageColor.getrgb(second)[:3]
    for y in range(height):
        rgb = tuple(round(a + (b - a) * y / (height - 1)) for a, b in zip(top, bottom))
        draw.line((0, y, width - 1, y), fill=rgb + (255,))
    seed = hashlib.sha256(filter_data["id"].encode()).digest()
    for index in range(16):
        x = 25 + seed[index] * 950 // 255
        y = 20 + seed[(index + 8) % len(seed)] * 1350 // 255
        radius = 5 + seed[(index + 16) % len(seed)] % 12
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), outline=(255, 255, 255, 210), width=3)
    draw.rounded_rectangle((15, 15, width - 16, height - 16), radius=45, outline=(255, 255, 255, 230), width=8)
    if count == 4:
        slots = [[55, 70, 430, 570], [515, 70, 430, 570], [55, 670, 430, 570], [515, 670, 430, 570]]
    else:
        slots = [[55, 65, 890, 1165]]
    for x, y, w, h in slots:
        draw.rectangle((x, y, x + w - 1, y + h - 1), fill=(0, 0, 0, 0))
        draw.rectangle((x - 5, y - 5, x + w + 4, y + h + 4), outline=(255, 255, 255, 255), width=5)
    font_path = Path("C:/Windows/Fonts/segoeuib.ttf")
    font = ImageFont.truetype(str(font_path), 38) if font_path.is_file() else ImageFont.load_default(size=38)
    text = "HOANG  /  PHOTOBOOTH" if count == 4 else "HOANG  /  LOCKET"
    bounds = draw.textbbox((0, 0), text, font=font)
    draw.text(((width - (bounds[2] - bounds[0])) / 2, 1285), text, fill=(65, 45, 65, 255), font=font)
    return canvas, slots


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--download", action="store_true")
    args = parser.parse_args()
    DIRECTORY.mkdir(parents=True, exist_ok=True)
    catalog = json.loads((ROOT / "references/hakaiz-ai-catalog.json").read_text(encoding="utf-8"))
    origins_path = ROOT / "references/owned-asset-origins.json"
    if args.download:
        values = sorted(set(urls(catalog["filters"])))
        records = []
        with ThreadPoolExecutor(max_workers=4) as pool:
            for number, record in enumerate(pool.map(download, values), 1):
                records.append(record)
                if number % 10 == 0 or number == len(values):
                    print(f"Mirrored {number}/{len(values)} public catalog images", flush=True)
        origins_path.write_text(json.dumps({"source": catalog["source"], "assets": records}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"Unavailable source previews replaced with local icons: {sum(record['generatedFallback'] for record in records)}", flush=True)
    records = json.loads(origins_path.read_text(encoding="utf-8"))["assets"]
    replacements = {record["source"]: PREFIX + record["path"] for record in records}
    local_by_url = {record["source"]: record["path"] for record in records}
    presets, aliases, generated = {}, {}, []
    frame_number = booth_number = 0
    for entry in catalog["filters"]:
        if entry.get("category", "").lower() not in ("photobooth", "frames"):
            continue
        identifier = entry["id"]
        count = 4 if identifier in FOUR else 1
        if count == 4:
            booth_number += 1
            entry["name"] = f"Photobooth Hoàng {booth_number:02d}"
        else:
            frame_number += 1
            entry["name"] = f"Khung Hoàng {frame_number:02d}"
        local = local_by_url[entry["overlayImageUrl"]]
        try:
            with Image.open(ROOT / local) as original:
                image = original.convert("RGBA")
                slots = holes(image, count)
        except FileNotFoundError:
            slots = None
        if slots is None:
            image, slots = make_frame(entry, count)
            buffer = io.BytesIO()
            image.save(buffer, format="PNG")
            data = buffer.getvalue()
            digest = hashlib.sha256(data).hexdigest()
            local = f"assets/filters/{digest}.png"
            (ROOT / local).write_bytes(data)
            generated.append(identifier)
        presets[identifier] = {"kind": "photobooth" if count == 4 else "frame", "asset": local, "size": list(image.size), "slots": slots}
        aliases[entry["prompt"]] = identifier
        for key in ("imageUrl", "iconUrl", "overlayImageUrl", "overlayImageURL"):
            entry[key] = PREFIX + local
        for key in ("url", "iconUrl", "remoteImage"):
            if key in entry.get("icon", {}):
                entry["icon"][key] = PREFIX + local
        entry["ptbFrameId"] = identifier
        entry["captureCountHint"] = count
        entry["filterType"] = "cutout"
    aliases["photobooth"] = "photobooth_4cut"

    def replace(value):
        if isinstance(value, str):
            return replacements.get(value, value)
        if isinstance(value, list):
            return [replace(child) for child in value]
        if isinstance(value, dict):
            return {key: replace(child) for key, child in value.items()}
        return value

    catalog = replace(catalog)
    catalog["owner"] = "nghhoag05-art"
    catalog["assetBaseUrl"] = PREFIX + "assets/filters/"
    for group in catalog["groups"]:
        if group["id"] == "group_photobooth":
            group["title"] = {"en": "Photobooth Hoàng 📸", "vi": "Photobooth Hoàng 📸"}
        elif group["id"] == "group_frames":
            group["title"] = {"en": "Khung ảnh Hoàng 🖼️", "vi": "Khung ảnh Hoàng 🖼️"}
    (DIRECTORY / "catalog.json").write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (DIRECTORY / "render-presets.json").write_text(json.dumps({"version": 1, "presets": presets, "aliases": aliases}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    script_file = ROOT / "scripts/forceGold4.3_60s_full.js"
    script = script_file.read_text(encoding="utf-8")
    decoder = json.JSONDecoder()
    for variable, value in (("locketAIFilters", catalog["filters"]), ("locketAIGroups", catalog["groups"]), ("locketAIPickerIds", catalog["pickerIds"])):
        marker = "var " + variable + " = "
        start = script.index(marker) + len(marker)
        _, end = decoder.raw_decode(script[start:])
        script = script[:start] + json.dumps(value, ensure_ascii=False, indent=4) + script[start + end:]
    script = script.replace("hakaiz-9c2ea58-83", "hoang-own-ai-ptb-v1")
    script = script.replace("Hakaiz camera catalog, imported as JSON data only.", "Hoang-owned camera catalog and local assets; source attribution is in SOURCES.md.")
    script_file.write_text(script, encoding="utf-8")
    print(f"Owned catalog: {len(catalog['filters'])} filters; renderable presets: {len(presets)}; code-drawn fallback frames: {len(generated)}", flush=True)
    print("Fallback IDs: " + ", ".join(generated), flush=True)


if __name__ == "__main__":
    main()
