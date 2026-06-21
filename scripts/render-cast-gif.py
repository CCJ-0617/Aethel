#!/usr/bin/env python3

import argparse
import json
import re
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ANSI_RE = re.compile(r"\x1b\[([0-9;]*)m")

THEME = {
    "bg": "#0b1020",
    "panel": "#111827",
    "chrome": "#1f2937",
    "text": "#e5e7eb",
    "dim": "#94a3b8",
    "green": "#22c55e",
    "cyan": "#38bdf8",
    "yellow": "#f59e0b",
    "red": "#fb7185",
    "blue": "#60a5fa",
    "magenta": "#c084fc",
}

COLORS = {
    "31": THEME["red"],
    "32": THEME["green"],
    "33": THEME["yellow"],
    "34": THEME["blue"],
    "35": THEME["magenta"],
    "36": THEME["cyan"],
}


def load_font(size, bold=False):
    candidates = [
        "/System/Library/Fonts/Menlo.ttc",
        "/System/Library/Fonts/SFNSMono.ttf",
        "/System/Library/Fonts/Supplemental/Courier New.ttf",
    ]
    for candidate in candidates:
        path = Path(candidate)
        if path.exists():
            return ImageFont.truetype(str(path), size)
    return ImageFont.load_default()


def strip_ansi(text):
    return ANSI_RE.sub("", text)


def split_ansi(text, default_color):
    color = default_color
    dim = False
    position = 0
    for match in ANSI_RE.finditer(text):
        if match.start() > position:
            yield text[position:match.start()], color, dim
        codes = [code for code in match.group(1).split(";") if code]
        if not codes or "0" in codes:
            color = default_color
            dim = False
        if "2" in codes:
            dim = True
        for code in codes:
            if code in COLORS:
                color = COLORS[code]
        position = match.end()
    if position < len(text):
        yield text[position:], color, dim


def apply_output(lines, chunk, height):
    if not lines:
        lines.append("")

    for piece in chunk.splitlines(True):
        if piece.endswith("\r\n") or piece.endswith("\n") or piece.endswith("\r"):
            text = piece.rstrip("\r\n")
            lines[-1] += text
            lines.append("")
        else:
            lines[-1] += piece

    while len(lines) > height:
        lines.pop(0)


def collect_frames(cast_path):
    with open(cast_path) as handle:
        header = json.loads(handle.readline())
        events = [json.loads(line) for line in handle if line.strip()]

    lines = [""]
    frames = []
    last_frame_time = -1.0
    min_delta = 0.09
    height = header.get("height", 24)

    for timestamp, stream, data in events:
        if stream != "o":
            continue
        apply_output(lines, data, height)
        if timestamp - last_frame_time >= min_delta:
            frames.append((timestamp, list(lines)))
            last_frame_time = timestamp

    if not frames or frames[-1][1] != lines:
        frames.append((events[-1][0] if events else 0, list(lines)))

    return header, frames


def render_frame(lines, header, font, title_font):
    cols = header.get("width", 90)
    rows = header.get("height", 24)
    cell_width = 18
    cell_height = 42
    left = 78
    top = 118
    width = cols * cell_width + left * 2
    height = rows * cell_height + top + 44

    image = Image.new("RGB", (width, height), THEME["bg"])
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((28, 28, width - 28, height - 28), 28, fill=THEME["panel"], outline="#334155", width=3)
    draw.rounded_rectangle((28, 28, width - 28, 94), 28, fill=THEME["chrome"])
    draw.ellipse((64, 52, 86, 74), fill=THEME["red"])
    draw.ellipse((102, 52, 124, 74), fill=THEME["yellow"])
    draw.ellipse((140, 52, 162, 74), fill=THEME["green"])
    draw.text((194, 47), "Aethel demo", font=title_font, fill=THEME["text"])

    visible = lines[-rows:]
    y = top
    for raw_line in visible:
        x = left
        for part, color, dim in split_ansi(raw_line, THEME["text"]):
            draw.text((x, y), strip_ansi(part), font=font, fill=THEME["dim"] if dim else color)
            x += draw.textlength(strip_ansi(part), font=font)
        y += cell_height

    return image


def frame_durations(frames):
    durations = []
    for index, (timestamp, _) in enumerate(frames):
        if index + 1 < len(frames):
            next_timestamp = frames[index + 1][0]
            durations.append(max(80, min(int((next_timestamp - timestamp) * 1000), 900)))
        else:
            durations.append(2200)
    return durations


def main():
    parser = argparse.ArgumentParser(description="Render an asciinema cast to a GIF demo.")
    parser.add_argument("cast", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    header, frames = collect_frames(args.cast)
    font = load_font(28)
    title_font = load_font(27, bold=True)
    rendered = [render_frame(lines, header, font, title_font) for _, lines in frames]
    args.output.parent.mkdir(parents=True, exist_ok=True)
    rendered[0].save(
        args.output,
        save_all=True,
        append_images=rendered[1:],
        duration=frame_durations(frames),
        loop=0,
        optimize=True,
        disposal=2,
    )
    print(args.output)


if __name__ == "__main__":
    main()
