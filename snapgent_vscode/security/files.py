"""Which paths are special: secrets, git internals, and files that decide what gets executed."""

import fnmatch
from typing import Iterable, List

# Files whose contents would be sent to a third-party website if the model read them.
SENSITIVE_NAMES = (
    ".env", ".env.*", "*.pem", "*.key", "*.p12", "*.pfx", "*.kdbx", "id_rsa*", "id_ed25519*", "id_ecdsa*",
    ".npmrc", ".pypirc", ".netrc", "credentials", "credentials.*", "secrets.*", "*.secret", "*.secrets",
)
SENSITIVE_DIRECTORIES = frozenset({".ssh", ".aws", ".gnupg", ".kube", ".azure"})
# Allowed even though they match a pattern above: templates carry no secrets.
SAFE_EXCEPTIONS = (".env.example", ".env.sample", ".env.template", "*.pub")

# Files that decide what `npm test`, `pytest`, `make`, ... will execute. If the agent changed one,
# running the project's scripts is no longer "running the user's scripts".
EXECUTION_CONFIG_NAMES = (
    "package.json", "makefile", "gnumakefile", "justfile", "pyproject.toml", "setup.py", "setup.cfg", "tox.ini",
    "pytest.ini", "conftest.py", "noxfile.py", "*.csproj", "*.sln", "pom.xml", "build.gradle", "build.gradle.kts",
    "jest.config.*", "vitest.config.*", "vite.config.*", "webpack.config.*", "gulpfile.*", "gruntfile.*",
    "cargo.toml", "build.rs", "go.mod",
)


def _parts(relative_path: str) -> List[str]:
    return [part for part in relative_path.replace("\\", "/").split("/") if part and part != "."]


def _matches(name: str, patterns: Iterable[str]) -> bool:
    lowered = name.lower()
    return any(fnmatch.fnmatch(lowered, pattern.lower()) for pattern in patterns)


def is_sensitive(relative_path: str) -> bool:
    parts = _parts(relative_path)
    if not parts:
        return False
    if any(part.lower() in SENSITIVE_DIRECTORIES for part in parts[:-1]):
        return True
    name = parts[-1]
    return _matches(name, SENSITIVE_NAMES) and not _matches(name, SAFE_EXCEPTIONS)


def touches_git_directory(relative_path: str) -> bool:
    """Hooks and config under .git run code or redirect git; the agent never writes there."""
    return ".git" in _parts(relative_path)


def is_execution_config(relative_path: str) -> bool:
    parts = _parts(relative_path)
    if not parts:
        return False
    return _matches(parts[-1], EXECUTION_CONFIG_NAMES) or ".husky" in parts or "scripts" in parts[:-1]
