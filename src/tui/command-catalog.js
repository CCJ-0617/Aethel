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
    name: "clone",
    description: "Clone a Drive folder into a new workspace",
    template: "clone my-drive ./my-drive --no-checkout",
    actions: [],
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
    template: "status --short",
    actions: [
      { label: "Show Status", command: "status" },
      { label: "Short Status", command: "status --short" },
      { label: "Detailed Status", command: "status --detail" },
    ],
  },
  {
    name: "diff",
    description: "Show detailed changes",
    template: "diff --side all",
    actions: [
      { label: "All Changes", command: "diff --side all" },
      { label: "Detailed Changes", command: "diff --side all --detail" },
      { label: "Staged Changes", command: "diff --staged" },
      { label: "Remote Only", command: "diff --side remote" },
      { label: "Local Only", command: "diff --side local" },
    ],
  },
  {
    name: "add",
    description: "Stage changes for commit",
    template: "add -A",
    actions: [{ label: "Stage All", command: "add -A" }],
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
    template: "log --oneline -n 10",
    actions: [
      { label: "Show Recent History", command: "log --oneline -n 10" },
      { label: "Show History Stats", command: "log --stat -n 10" },
    ],
  },
  {
    name: "branch",
    description: "List, create, or delete branch refs",
    template: "branch -v",
    actions: [{ label: "Show Branches", command: "branch -v" }],
  },
  {
    name: "switch",
    description: "Switch current branch ref",
    template: "switch main",
    actions: [{ label: "Switch Main", command: "switch main" }],
  },
  {
    name: "tag",
    description: "Create or list snapshot tags",
    template: "tag --list",
    actions: [
      { label: "List Tags", command: "tag --list" },
      { label: "List Tags Verbose", command: "tag --list --verbose" },
    ],
  },
  {
    name: "remote",
    description: "Inspect Drive remote configuration",
    template: "remote -v",
    actions: [
      { label: "Show Remote URLs", command: "remote -v" },
      { label: "Show Origin", command: "remote show origin" },
    ],
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
    name: "dedupe-files",
    description: "Detect duplicate remote files",
    template: "dedupe-files",
    actions: [{ label: "Dry Run", command: "dedupe-files" }],
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
      { label: "Keep Local", command: "resolve --keep local" },
      { label: "Keep Remote", command: "resolve --keep remote" },
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
    template: "show --stat HEAD",
    actions: [
      { label: "Show HEAD", command: "show HEAD" },
      { label: "Show HEAD Stats", command: "show --stat HEAD" },
      { label: "Show HEAD Verbose", command: "show --verbose HEAD" },
    ],
  },
  {
    name: "rev-parse",
    description: "Resolve branch, tag, or snapshot refs",
    template: "rev-parse HEAD",
    actions: [
      { label: "Resolve HEAD", command: "rev-parse HEAD" },
      { label: "Current Branch", command: "rev-parse --abbrev-ref HEAD" },
      { label: "Short HEAD", command: "rev-parse --short HEAD" },
    ],
  },
  {
    name: "restore",
    description: "Restore files from a snapshot ref",
    template: "restore --source HEAD path/to/file",
    actions: [{ label: "Unstage Path", command: "restore --staged path/to/file" }],
  },
  {
    name: "checkout",
    description: "Alias for restore --source HEAD",
    template: "checkout path/to/file",
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
  {
    name: "verify",
    description: "Verify file integrity against the last snapshot",
    template: "verify",
    actions: [
      { label: "Local Snapshot", command: "verify" },
      { label: "Local and Remote", command: "verify --remote" },
    ],
  },
];
