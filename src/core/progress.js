/**
 * Lightweight terminal progress indicators (spinner + bar).
 * Writes to stderr so stdout stays clean for piped output.
 */

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL = 80;
const BAR_WIDTH = 25;

const isTTY = process.stderr.isTTY;

function clearLine() {
  if (isTTY) process.stderr.write("\r\x1b[K");
}

export function createSpinner(message) {
  if (!isTTY) {
    process.stderr.write(`${message}\n`);
    return {
      update() {},
      succeed(msg) { if (msg) process.stderr.write(`${msg}\n`); },
      fail(msg) { if (msg) process.stderr.write(`${msg}\n`); },
      stop() {},
    };
  }

  let frame = 0;
  let currentMessage = message;

  const timer = setInterval(() => {
    clearLine();
    process.stderr.write(`${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} ${currentMessage}`);
    frame++;
  }, SPINNER_INTERVAL);

  return {
    update(msg) { currentMessage = msg; },
    succeed(msg) {
      clearInterval(timer);
      clearLine();
      process.stderr.write(`✔ ${msg || currentMessage}\n`);
    },
    fail(msg) {
      clearInterval(timer);
      clearLine();
      process.stderr.write(`✖ ${msg || currentMessage}\n`);
    },
    stop() {
      clearInterval(timer);
      clearLine();
    },
  };
}

export function createProgressBar(label, total) {
  let lastRendered = -1;

  function render(current) {
    if (current === lastRendered) return;
    lastRendered = current;

    const ratio = total > 0 ? Math.min(current / total, 1) : 0;
    const filled = Math.round(BAR_WIDTH * ratio);
    const empty = BAR_WIDTH - filled;
    const pct = Math.round(ratio * 100);
    const bar = "█".repeat(filled) + "░".repeat(empty);
    const line = `${label} [${bar}] ${current}/${total} (${pct}%)`;

    if (isTTY) {
      clearLine();
      process.stderr.write(line);
    }
  }

  // Initial render
  render(0);

  return {
    update(current) { render(current); },
    done(msg) {
      render(total);
      if (isTTY) {
        clearLine();
        process.stderr.write(`✔ ${msg || label}\n`);
      } else {
        process.stderr.write(`${msg || label}\n`);
      }
    },
  };
}
