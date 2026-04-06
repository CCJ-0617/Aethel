#!/usr/bin/env python3

import json
import time
import random
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
docs = ROOT / "docs"
docs.mkdir(parents=True, exist_ok=True)
CAST_FILE = docs / "usage.cast"

def write_cast():
    with open(CAST_FILE, "w") as f:
        # Header
        header = {
            "version": 2,
            "width": 90,
            "height": 26, # a bit taller for the diff output
            "timestamp": int(time.time()),
            "env": {"SHELL": "/bin/bash", "TERM": "xterm-256color"}
        }
        f.write(json.dumps(header) + "\n")

        current_time = 0.0

        def add_event(data):
            f.write(json.dumps([current_time, "o", data]) + "\n")

        def prompt():
            nonlocal current_time
            current_time += 0.1
            add_event("\x1b[32m$\x1b[0m ")
            current_time += 0.2

        def type_text(text, type_speed=0.06, end_delay=0.5):
            nonlocal current_time
            prompt()
            for c in text:
                current_time += type_speed * random.uniform(0.7, 1.3)
                add_event(c)
            current_time += type_speed * 5
            add_event("\r\n")
            current_time += end_delay

        def log(text, delay_after=0.1):
            nonlocal current_time
            if text == "":
                add_event("\r\n")
            else:
                add_event(text + "\r\n")
            current_time += delay_after

        # Start delay
        current_time += 1.0

        # Command 1: aethel status
        type_text("aethel status")
        current_time += 0.3
        log("\x1b[36mRemote changes (2):\x1b[0m", 0.1)
        log("  \x1b[33mMR\x1b[0m docs/spec.txt  (modified on Drive)", 0.05)
        log("  \x1b[32m+R\x1b[0m design/roadmap.txt  (new on Drive)", 0.05)
        log("\x1b[36mLocal changes (2):\x1b[0m", 0.1)
        log("  \x1b[33mML\x1b[0m notes/ideas.txt  (modified locally)", 0.05)
        log("  \x1b[32m+L\x1b[0m drafts/todo.txt  (new locally)", 0.1)
        log("")
        current_time += 1.5

        # Command 2: aethel diff --side all
        type_text("aethel diff --side all")
        current_time += 0.3
        log("Remote changes:", 0.1)
        log("  \x1b[33mMR\x1b[0m docs/spec.txt", 0.05)
        log("       modified on Drive", 0.05)
        log("  \x1b[32m+R\x1b[0m design/roadmap.txt", 0.05)
        log("       new on Drive", 0.05)
        log("Local changes:", 0.1)
        log("  \x1b[33mML\x1b[0m notes/ideas.txt", 0.05)
        log("       modified locally", 0.05)
        log("  \x1b[32m+L\x1b[0m drafts/todo.txt", 0.05)
        log("       new locally", 0.1)
        log("")
        current_time += 1.5

        # Command 3: aethel add --all
        type_text("aethel add --all")
        current_time += 0.4
        log("Staged 4 change(s).", 0.2)
        log("")
        current_time += 1.0

        # Command 4: aethel status (staged)
        type_text("aethel status")
        current_time += 0.3
        log("\x1b[36mStaged changes (4):\x1b[0m", 0.1)
        log("       \x1b[34mdownload\x1b[0m  docs/spec.txt", 0.05)
        log("       \x1b[34mdownload\x1b[0m  design/roadmap.txt", 0.05)
        log("         \x1b[35mupload\x1b[0m  notes/ideas.txt", 0.05)
        log("         \x1b[35mupload\x1b[0m  drafts/todo.txt", 0.1)
        log("")
        current_time += 1.5

        # Command 5: aethel commit
        type_text("aethel commit -m \"demo sync\"")
        current_time += 0.5
        log("Syncing 4 change(s)...", 1.2)
        log("Commit complete: 2 downloaded, 2 uploaded", 0.2)
        log("")
        current_time += 1.0

        # Command 6: aethel status (clean)
        type_text("aethel status")
        current_time += 0.3
        log("Everything up to date.", 0.2)
        log("")
        current_time += 3.0 # hold final screen
        
        # Last prompt so it doesn't just cut off on a log line
        add_event("\x1b[32m$\x1b[0m ")

    print(f"Generated {CAST_FILE}")

write_cast()
