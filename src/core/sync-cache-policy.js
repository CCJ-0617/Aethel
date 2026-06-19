const DEFAULT_CACHED_REMOTE_COMMANDS = new Set(["status", "add", "pull", "push"]);

export function remoteCacheEnabledByDefault(command) {
  return DEFAULT_CACHED_REMOTE_COMMANDS.has(command);
}
