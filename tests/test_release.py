import json
import re
import stat
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

from scripts import package_release as pr
import subprocess

from snapgent_bridge import BRIDGE_VERSION

REPO = Path(__file__).resolve().parent.parent


class ReleaseCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.base = Path(self._tmp.name)
        self.dist = self.base / "dist"
        for target in pr.EXTENSION_TARGETS:
            (self.dist / target).mkdir(parents=True)
            (self.dist / target / "manifest.json").write_text("{}", encoding="utf-8")
        self.bins = self.base / "bins"
        self.bins.mkdir()
        for name in pr.BINARIES:
            (self.bins / name).write_bytes(b"MZ")
        self.out = self.base / "out"

    def build(self, binaries=True):
        return pr.assemble(REPO, self.out, "1.2.3", self.dist, self.bins if binaries else None)


class AssembleTests(ReleaseCase):
    def test_layout_contains_everything_a_user_needs(self):
        folder = self.build()
        self.assertEqual(folder.name, "snapgent-v1.2.3")
        for expected in ("bridge.py", "vscode_mcp.py", "setup-config.py", "start.bat", "Linux_Start.sh", "MacOS_Start.command", "README.md", "LICENSE",
                         "snapgent_bridge/__init__.py", "snapgent_vscode/security/decision.py", "chrome/manifest.json", "firefox/manifest.json",
                         "bridge.exe", "vscode_mcp.exe"):
            self.assertTrue((folder / expected).exists(), expected)

    def test_nothing_that_should_stay_in_the_repo_leaks_into_a_release(self):
        folder = self.build()
        names = {p.relative_to(folder).as_posix() for p in folder.rglob("*")}
        for forbidden in ("tests", "extension", "scripts", ".github", "docs", "config.json", "logs", ".git"):
            self.assertNotIn(forbidden, names, forbidden)
        self.assertFalse(any("__pycache__" in n or n.endswith(".pyc") for n in names))

    @unittest.skipIf(sys.platform == "win32", "Windows has no execute bit; the zip test covers it")
    def test_launchers_are_executable_so_they_can_be_double_clicked(self):
        folder = self.build()
        for name in ("Linux_Start.sh", "MacOS_Start.command"):
            self.assertTrue((folder / name).stat().st_mode & stat.S_IXUSR, name)

    def test_a_dry_run_leaves_out_the_executables(self):
        folder = self.build(binaries=False)
        self.assertFalse((folder / "bridge.exe").exists())
        self.assertTrue((folder / "bridge.py").exists())

    def test_a_missing_input_is_a_clear_error_not_a_half_built_release(self):
        (self.bins / "bridge.exe").unlink()
        with self.assertRaisesRegex(pr.ReleaseError, "bridge.exe"):
            self.build()
        (self.dist / "firefox" / "manifest.json").unlink()
        (self.dist / "firefox").rmdir()
        with self.assertRaisesRegex(pr.ReleaseError, "firefox"):
            self.build(binaries=False)

    def test_rebuilding_replaces_the_previous_folder(self):
        first = self.build()
        (first / "stale.txt").write_text("x", encoding="utf-8")
        self.assertFalse((self.build() / "stale.txt").exists())

    def test_zip_keeps_the_top_folder_and_the_execute_bit(self):
        archive = pr.make_zip(self.build())
        with zipfile.ZipFile(archive) as zf:
            names = zf.namelist()
            self.assertTrue(all(n.startswith("snapgent-v1.2.3/") for n in names))
            self.assertIn("snapgent-v1.2.3/chrome/manifest.json", names)
            mode = zf.getinfo("snapgent-v1.2.3/MacOS_Start.command").external_attr >> 16
            self.assertTrue(mode & stat.S_IXUSR)

    def test_command_line_entry_point(self):
        code = pr.main(["--version", "9.9.9", "--extension-dist", str(self.dist), "--binaries", str(self.bins), "--out", str(self.out)])
        self.assertEqual(code, 0)
        self.assertTrue((self.out / "snapgent-v9.9.9.zip").is_file())
        self.assertEqual(pr.main(["--version", "9.9.9", "--extension-dist", str(self.base / "nope"), "--out", str(self.out)]), 1)


class RepositoryLayoutTests(unittest.TestCase):
    """The repository root stays a table of contents, not a drawer. Add a folder here only on purpose."""

    ALLOWED_ROOT = {
        ".gitattributes", ".gitignore", "CHANGELOG.md", "LICENSE", "README.md",
        ".github", ".snapgent", "assets", "docs", "extension", "scripts", "server", "tests",
    }

    def test_nothing_unexpected_is_tracked_at_the_root(self):
        try:
            tracked = subprocess.run(["git", "ls-files"], cwd=REPO, capture_output=True, text=True, check=True).stdout.splitlines()
        except (OSError, subprocess.CalledProcessError):
            self.skipTest("not a git checkout")
        at_root = {path.split("/")[0] for path in tracked}
        self.assertEqual(sorted(at_root - self.ALLOWED_ROOT), [], "move it into server/, extension/, docs/ or scripts/")

    def test_every_release_input_exists_in_the_repository(self):
        for source, _destination in pr.SOURCES:
            self.assertTrue((REPO / source).exists(), source)

    def test_no_compiled_binaries_are_tracked(self):
        try:
            tracked = subprocess.run(["git", "ls-files"], cwd=REPO, capture_output=True, text=True, check=True).stdout.splitlines()
        except (OSError, subprocess.CalledProcessError):
            self.skipTest("not a git checkout")
        self.assertEqual([p for p in tracked if p.endswith((".exe", ".dll", ".pyc"))], [])


class VersionTests(unittest.TestCase):
    """The version appears in several places; a release with disagreeing numbers confuses users and the popup."""

    def test_extension_and_bridge_versions_agree(self):
        package = json.loads((REPO / "extension" / "package.json").read_text(encoding="utf-8"))
        self.assertEqual(package["version"], BRIDGE_VERSION)

    def test_the_readme_badge_and_download_links_name_that_version(self):
        readme = (REPO / "README.md").read_text(encoding="utf-8")
        self.assertIn(f"RELEASE-V{BRIDGE_VERSION}", readme)

    def test_the_changelog_has_a_section_for_the_current_version(self):
        changelog = (REPO / "CHANGELOG.md").read_text(encoding="utf-8")
        self.assertIsNotNone(re.search(rf"^## \[V?{re.escape(BRIDGE_VERSION)}\]", changelog, re.MULTILINE))


if __name__ == "__main__":
    unittest.main()
