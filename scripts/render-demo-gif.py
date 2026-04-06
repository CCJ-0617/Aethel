#!/usr/bin/env python3

from pathlib import Path
from subprocess import run
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "docs" / "demo.gif"
DISPLAY_WIDTH = 1320
DISPLAY_MIN_HEIGHT = 760
LINE_HEIGHT = 30
SCALE = 2


def load_lines():
    result = run(
        ["node", "scripts/demo.js", "--cleanup", "--redact-workspace"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.rstrip("\n").splitlines()


def load_font(size):
    for candidate in [
        "/System/Library/Fonts/Supplemental/Times New Roman.ttf",
        "/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf",
    ]:
        path = Path(candidate)
        if path.exists():
            return ImageFont.truetype(str(path), size)
    return ImageFont.load_default()


def load_title_font(size):
    for candidate in [
        "/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf",
        "/System/Library/Fonts/Supplemental/Times New Roman.ttf",
    ]:
        path = Path(candidate)
        if path.exists():
            return ImageFont.truetype(str(path), size)
    return ImageFont.load_default()


def build_frame(lines, font, title_font, visible):
    shown = lines[:visible]
    width = DISPLAY_WIDTH * SCALE
    height = max(DISPLAY_MIN_HEIGHT, 180 + len(lines) * LINE_HEIGHT) * SCALE
    image = Image.new("RGB", (width, height), "#0b1324")
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((40, 40, width - 40, height - 40), 44, fill="#0a0f1a", outline="#243044", width=4)
    draw.rounded_rectangle((40, 40, width - 40, 108), 44, fill="#10192a")
    draw.ellipse((84, 62, 108, 86), fill="#fb7185")
    draw.ellipse((124, 62, 148, 86), fill="#f59e0b")
    draw.ellipse((164, 62, 188, 86), fill="#22c55e")
    draw.text((236, 52), "Aethel demo", font=title_font, fill="#dbe4f0")
    y = 176
    for line in shown:
        draw.text((104, y), line, font=font, fill="#dbe4f0")
        y += LINE_HEIGHT * SCALE
    if visible < len(lines):
        draw.rounded_rectangle((104, y + 8, 134, y + 48), 6, fill="#38bdf8")
    return image.resize((DISPLAY_WIDTH, height // SCALE), Image.Resampling.LANCZOS)


def main():
    lines = load_lines()
    font = load_font(24 * SCALE)
    title_font = load_title_font(22 * SCALE)
    checkpoints = [3, 7, 13, 21, 27, len(lines)]
    frames = [build_frame(lines, font, title_font, count) for count in checkpoints]
    durations = [500, 600, 700, 800, 900, 1800]
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    frames[0].save(
        OUTPUT,
        save_all=True,
        append_images=frames[1:],
        duration=durations,
        loop=0,
        optimize=False,
        disposal=2,
    )
    print(OUTPUT)


if __name__ == "__main__":
    main()
