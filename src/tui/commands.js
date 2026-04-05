function parseShellWords(input) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escaping = false;

  for (const char of input.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaping) {
    current += "\\";
  }

  if (quote) {
    throw new Error("Unterminated quote in command.");
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

export function parseCommandInput(input) {
  const tokens = parseShellWords(input);
  if (tokens[0] === "aethel") {
    tokens.shift();
  }

  if (tokens.length === 0) {
    return [];
  }

  if (tokens[0] === "tui") {
    throw new Error("Cannot launch `tui` from inside the TUI.");
  }

  return tokens;
}
