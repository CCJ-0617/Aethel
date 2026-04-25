#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_SOURCE="$ROOT_DIR/src/cli.js"

default_install_dir() {
  if [[ -n "${AETHEL_INSTALL_DIR:-}" ]]; then
    printf '%s\n' "$AETHEL_INSTALL_DIR"
    return
  fi

  case ":$PATH:" in
    *":$HOME/bin:"*)
      printf '%s\n' "$HOME/bin"
      ;;
    *)
      printf '%s\n' "$HOME/.local/bin"
      ;;
  esac
}

INSTALL_DIR="$(default_install_dir)"
BIN_TARGET="$INSTALL_DIR/debug_aethel"
PATH_EXPORT_LINE="export PATH=\"$INSTALL_DIR:\$PATH\""

detect_shell_rc() {
  if [[ -n "${AETHEL_SHELL_RC:-}" ]]; then
    printf '%s\n' "$AETHEL_SHELL_RC"
    return
  fi

  case "${SHELL:-}" in
    */zsh)
      printf '%s\n' "$HOME/.zshrc"
      ;;
    */bash)
      printf '%s\n' "$HOME/.bashrc"
      ;;
    *)
      printf '%s\n' "$HOME/.profile"
      ;;
  esac
}

ensure_path_line() {
  local shell_rc="$1"

  mkdir -p "$(dirname "$shell_rc")"
  touch "$shell_rc"

  if ! grep -Fqs "$PATH_EXPORT_LINE" "$shell_rc"; then
    printf '\n%s\n' "$PATH_EXPORT_LINE" >>"$shell_rc"
    printf 'Updated shell profile: %s\n' "$shell_rc"
  else
    printf 'Shell profile already contains PATH entry: %s\n' "$shell_rc"
  fi
}

main() {
  local shell_rc
  shell_rc="$(detect_shell_rc)"

  if [[ ! -f "$BIN_SOURCE" ]]; then
    printf 'Aethel CLI entry was not found: %s\n' "$BIN_SOURCE" >&2
    exit 1
  fi

  if [[ "${AETHEL_SKIP_NPM_INSTALL:-0}" != "1" ]]; then
    printf 'Installing project dependencies...\n'
    (cd "$ROOT_DIR" && npm install)
  else
    printf 'Skipping npm install because AETHEL_SKIP_NPM_INSTALL=1.\n'
  fi

  mkdir -p "$INSTALL_DIR"
  chmod +x "$BIN_SOURCE"
  ln -sfn "$BIN_SOURCE" "$BIN_TARGET"

  printf 'Installed debug CLI symlink: %s -> %s\n' "$BIN_TARGET" "$BIN_SOURCE"

  ensure_path_line "$shell_rc"

  printf '\nDebug installation complete.\n'
  printf 'Run one of the following commands to refresh the current shell:\n'
  printf '  source "%s"\n' "$shell_rc"
  printf '  exec "$SHELL" -l\n'
  printf '\nAfter that, launch this working-copy build with:\n'
  printf '  debug_aethel\n'
  printf '  debug_aethel tui\n'
  printf '\nThe regular `aethel` command is left untouched.\n'
}

main "$@"
