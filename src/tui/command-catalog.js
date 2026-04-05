export const COMMAND_CATALOG = [
  {
    name: "auth",
    description: "Run OAuth initialization and verify Drive access",
    template: "auth",
    actions: [{ label: "Verify account", command: "auth" }],
  },
  {
    name: "clean",
    description: "List accessible Drive files and clean them",
    template: "clean --shared-drives",
    actions: [
      { label: "Preview My Drive", command: "clean" },
      { label: "Preview Shared Drives", command: "clean --shared-drives" },
    ],
  },
  {
    name: "init",
    description: "Initialise a sync workspace",
    template: "init --local-path .",
    actions: [{ label: "Init Current Directory", command: "init --local-path ." }],
  },
  {
    name: "status",
    description: "Show sync status",
    template: "status",
    actions: [{ label: "Show Status", command: "status" }],
  },
  {
    name: "diff",
    description: "Show detailed changes",
    template: "diff --side all",
    actions: [
      { label: "All Changes", command: "diff --side all" },
      { label: "Remote Only", command: "diff --side remote" },
      { label: "Local Only", command: "diff --side local" },
    ],
  },
  {
    name: "add",
    description: "Stage changes for commit",
    template: "add --all",
    actions: [{ label: "Stage All", command: "add --all" }],
  },
  {
    name: "reset",
    description: "Unstage changes",
    template: "reset --all",
    actions: [{ label: "Unstage All", command: "reset --all" }],
  },
  {
    name: "commit",
    description: "Apply staged changes and save snapshot",
    template: "commit -m \"sync\"",
    actions: [{ label: "Commit Staged", command: "commit -m \"sync\"" }],
  },
  {
    name: "log",
    description: "Show commit history",
    template: "log -n 10",
    actions: [{ label: "Show Recent History", command: "log -n 10" }],
  },
  {
    name: "fetch",
    description: "Check remote state",
    template: "fetch",
    actions: [{ label: "Fetch Remote State", command: "fetch" }],
  },
  {
    name: "dedupe-folders",
    description: "Detect duplicate remote folders",
    template: "dedupe-folders",
    actions: [{ label: "Dry Run", command: "dedupe-folders" }],
  },
  {
    name: "pull",
    description: "Download remote changes",
    template: "pull",
    actions: [
      { label: "Pull Now", command: "pull" },
      { label: "Dry Run", command: "pull --dry-run" },
    ],
  },
  {
    name: "push",
    description: "Upload local changes",
    template: "push",
    actions: [
      { label: "Push Now", command: "push" },
      { label: "Dry Run", command: "push --dry-run" },
    ],
  },
  {
    name: "resolve",
    description: "Resolve file conflicts",
    template: "resolve",
    actions: [
      { label: "List Conflicts", command: "resolve" },
      { label: "Use Ours", command: "resolve --ours" },
      { label: "Use Theirs", command: "resolve --theirs" },
      { label: "Keep Both", command: "resolve --both" },
    ],
  },
  {
    name: "ignore",
    description: "Manage .aethelignore patterns",
    template: "ignore list",
    actions: [
      { label: "List Rules", command: "ignore list" },
      { label: "Create Default File", command: "ignore create" },
    ],
  },
  {
    name: "show",
    description: "Show a commit or snapshot",
    template: "show HEAD",
    actions: [
      { label: "Show HEAD", command: "show HEAD" },
      { label: "Show HEAD Verbose", command: "show --verbose HEAD" },
    ],
  },
  {
    name: "restore",
    description: "Restore files from the last snapshot",
    template: "restore path/to/file",
    actions: [],
  },
  {
    name: "rm",
    description: "Delete local files and stage remote deletion",
    template: "rm path/to/file",
    actions: [],
  },
  {
    name: "mv",
    description: "Move or rename a local file",
    template: "mv old/path new/path",
    actions: [],
  },
];
