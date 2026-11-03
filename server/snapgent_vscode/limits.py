"""Size and time limits. One place, so a change here is visible and testable."""

IGNORED_DIRECTORIES = frozenset({
    ".git", ".hg", ".svn", ".venv", "venv", "node_modules",
    "__pycache__", ".pytest_cache", ".mypy_cache", ".next", "dist", "build",
})
MAX_RESULTS = 2000
MAX_FILE_CHARS = 200_000
MAX_OUTPUT_CHARS = 1_000_000          # hard ceiling for any size the extension asks for
COMMAND_OUTPUT_CHARS = 40_000         # a command's output is shortened to head + tail beyond this unless told otherwise
OUTPUT_CACHE_MAX_RUNS = 20
OUTPUT_CACHE_MAX_CHARS = 20_000_000
MAX_FILES_PER_READ = 50
MAX_LINES_PER_READ = 1000
MAX_TREE_DEPTH = 8
SAFE_PROJECT_SCRIPTS = frozenset({"build", "check", "format", "lint", "test", "typecheck"})

COMMAND_TIMEOUT_SECONDS = 120  # as long as the bridge waits for one tool call (builds, installs)
SCRIPT_TIMEOUT_SECONDS = 300
COMMIT_TIMEOUT_SECONDS = 120
