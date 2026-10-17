# /// script
# requires-python = ">=3.12"
# dependencies = ["pymupdf>=1.26,<2", "pillow>=11,<13"]
# ///
"""Isolated crop renderer for build-banks.mjs; regions arrive as JSON on stdin."""

import io
import json
import sys
from pathlib import Path

import pymupdf
from PIL import Image


# Ink is darker than the NITE watermark, so the trim keeps the text and drops the empty page margin.
INK_LEVEL = 170
TRIM_MARGIN = 16


def trim(image):
    ink = image.convert("L").point(lambda v: 255 if v < INK_LEVEL else 0)
    box = ink.getbbox()
    if not box:
        return image
    left, top, right, bottom = box
    return image.crop((max(0, left - TRIM_MARGIN), max(0, top - TRIM_MARGIN),
                       min(image.width, right + TRIM_MARGIN), min(image.height, bottom + TRIM_MARGIN)))


def render(pdf, region):
    # parts already follow the importer's page/column reading order.
    scale = 2
    for _ in range(24):
        images = []
        for part in region["parts"]:
            page = pdf[part["page"] - 1]
            b = part["box"]
            rect = pymupdf.Rect(b["x"], b["y"], b["x"] + b["width"], b["y"] + b["height"])
            # Same PDF-user-space boxes as renderQuestion(), including rotation.
            rect = rect * page.transformation_matrix * page.rotation_matrix
            pix = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), clip=rect,
                                  colorspace=pymupdf.csRGB, alpha=False)
            images.append(Image.frombytes("RGB", (pix.width, pix.height), pix.samples))
        height = sum(image.height for image in images)
        if height > 8000:
            scale *= (8000 - len(images)) / height
            continue
        stacked = Image.new("RGB", (max(image.width for image in images), height), "white")
        offset = 0
        for image in images:
            x = 0 if region["section"] == "english" else stacked.width - image.width
            stacked.paste(image, (x, offset))
            offset += image.height
        stacked = trim(stacked)
        for quality in [85, 70, 55, 40, 25]:
            encoded = io.BytesIO()
            stacked.save(encoded, format="WEBP", quality=quality)
            data = encoded.getvalue()
            if len(data) <= 1_000_000:
                return data
        scale *= 0.8
        if scale < 0.05:
            break
    raise RuntimeError(f"image-size-limit: {region['id']} could not fit the byte/height limits")


def main():
    source, destination = sys.argv[1:]
    directory = Path(destination)
    regions = json.load(sys.stdin)
    report = []
    with pymupdf.open(source) as pdf:
        for region in regions:
            data = render(pdf, region)
            path = directory / region["file"]
            path.write_bytes(data)
            # Decode the on-disk file, not just the encoder's in-memory image.
            with Image.open(path) as image:
                image.load()
                if image.format != "WEBP" or not 0 < image.height <= 8000 or image.width <= 0:
                    raise RuntimeError(f"Invalid WebP image: {path}")
                size = path.stat().st_size
                if not 0 < size <= 1_000_000:
                    raise RuntimeError(f"Invalid image size: {path}")
                report.append({"file": region["file"], "bytes": size,
                               "width": image.width, "height": image.height})
    print(json.dumps({"images": report}))


if __name__ == "__main__":
    main()
