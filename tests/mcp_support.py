"""Fixtures for the VS Code MCP tests."""

import subprocess
import tempfile
import unittest
from pathlib import Path

from snapgent_mcp.context import Context


class WorkspaceCase(unittest.TestCase):
    """A fresh empty workspace per test, as a Context."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.base = Path(self._tmp.name).resolve()
        self.root = self.base / "workspace"
        self.root.mkdir()
        self.ctx = Context(root=self.root)

    def write(self, relative_path: str, content: str = "") -> Path:
        path = self.root / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return path

    def read(self, relative_path: str) -> str:
        return (self.root / relative_path).read_text(encoding="utf-8")


def git(root: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", *args],
        cwd=root, capture_output=True, text=True, check=True,
    ).stdout.strip()
