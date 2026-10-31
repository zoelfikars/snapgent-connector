"""Classifying `run_command` requests. Everything not clearly harmless needs the user's approval."""

from typing import List, Sequence

# Read-only git subcommands that need no approval.
GIT_READ_ONLY = frozenset({"status", "diff", "log", "show", "rev-parse", "ls-files", "blame", "describe", "shortlog", "grep"})
# Flags that make even a read-only git command write files or run other programs.
GIT_DANGEROUS_PREFIXES = ("--output", "--exec", "--upload-pack", "--receive-pack", "--git-dir", "--work-tree", "--config", "--open-files-in-pager", "-c", "-o", "-O")
# Toolchains that may be asked for their version without approval.
VERSION_PROBES = frozenset({
    "node", "npm", "npx", "pnpm", "yarn", "bun", "deno", "python", "python3", "pip", "pip3", "git", "cargo", "rustc",
    "go", "dotnet", "java", "javac", "mvn", "gradle", "tsc", "php", "ruby", "make",
})
VERSION_FLAGS = (["--version"], ["-v"], ["-V"], ["version"])
# Characters cmd.exe treats specially: with a .cmd/.bat shim in the way they would inject a second command.
CMD_METACHARACTERS = frozenset('&|<>^%!"\r\n')


def executable_name(command: str) -> str:
    """`/usr/bin/git` and `GIT.EXE` both mean `git`; a path to something else keeps its path."""
    name = command.strip().replace("\\", "/").rsplit("/", 1)[-1].lower()
    return name[:-4] if name.endswith((".exe", ".cmd", ".bat")) else name


def is_bare_name(command: str) -> bool:
    """A name looked up on PATH, not a path into the workspace (which could be a planted program)."""
    stripped = command.strip()
    return bool(stripped) and "/" not in stripped and "\\" not in stripped and not stripped.startswith(".")


def is_harmless(command: str, args: Sequence[str], extra_allowed: frozenset = frozenset()) -> bool:
    """True when running this needs no approval."""
    if not is_bare_name(command):
        return False
    name = executable_name(command)
    if name in extra_allowed:
        return True
    if name in VERSION_PROBES and list(args) in VERSION_FLAGS:
        return True
    if name == "git":
        return bool(args) and args[0] in GIT_READ_ONLY and not any(a.startswith(GIT_DANGEROUS_PREFIXES) for a in args[1:])
    return False


def unsafe_for_cmd(parts: Sequence[str]) -> List[str]:
    """Arguments containing cmd.exe metacharacters (empty list = fine)."""
    return [part for part in parts if CMD_METACHARACTERS & set(part)]


def describe(command: str, args: Sequence[str]) -> str:
    return " ".join([command, *args]).strip()[:300]
