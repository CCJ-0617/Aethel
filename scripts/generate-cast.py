#!/usr/bin/env python3

import json
import time
import random
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
docs = ROOT / "docs"
docs.mkdir(parents=True, exist_ok=True)
CAST_FILE = docs / "setup.cast"

def write_cast():
    with open(CAST_FILE, "w") as f:
        # Header
        header = {
            "version": 2,
            "width": 100,
            "height": 22,
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
            # handle empty lines correctly
            if text == "":
                add_event("\r\n")
            else:
                add_event(text + "\r\n")
            current_time += delay_after

        # Start delay
        current_time += 1.0

        # Command 1: auth
        type_text("aethel auth")
        current_time += 1.5
        log("OAuth initialization completed.", 0.2)
        log("\x1b[36mCredentials path:\x1b[0m /Users/demo/.config/aethel/credentials.json")
        log("\x1b[36mToken path:\x1b[0m /Users/demo/.config/aethel/token.json")
        log("\x1b[36mAuthenticated user:\x1b[0m Demo User")
        log("\x1b[36mAuthenticated email:\x1b[0m demo@example.com")
        log("\x1b[36mStorage usage:\x1b[0m 1.2 GB")
        log("\x1b[36mStorage limit:\x1b[0m 15.0 GB")
        # Empty line before next prompt
        log("")
        current_time += 1.5

        # Command 2: init
        type_text("aethel init --local-path ./my-drive     # sync entire My Drive")
        current_time += 0.6
        log("")
        log("Initialised Aethel workspace at \x1b[32m/Users/demo/my-drive\x1b[0m", 0.4)
        log("  Created \x1b[33m.aethelignore\x1b[0m with default patterns", 0.2)
        log("  Syncing entire My Drive", 0.1)
        log("")
        current_time += 1.5

        # Command 3: pull
        type_text("aethel pull --all -m \"initial pull\"     # hydrate local files from Drive")
        current_time += 0.5
        log("Staged 25 remote item(s). Committing...", 1.8)
        log("Commit complete: 25 downloaded, 0 uploaded", 0.2)
        log("")
        log("Everything up to date.")
        log("")
        current_time += 3.0 # hold final screen
        
        # Last prompt so it doesn't just cut off on a log line
        add_event("\x1b[32m$\x1b[0m ")

    print(f"Generated {CAST_FILE}")

write_cast()
