import os
import unittest
from pathlib import Path
from unittest import mock

from snapgent_mcp.paths import find_outside_root, iter_files, relative, resolve_inside
from snapgent_mcp.tools.commands import outside_root_argument, run_command
from tests.mcp_support import WorkspaceCase


class ResolveInsideTests(WorkspaceCase):
    def test_relative_paths_and_dot(self):
        self.write("a/b.txt")
        self.assertEqual(resolve_inside("a/b.txt", self.root), self.root / "a" / "b.txt")
        self.assertEqual(resolve_inside("", self.root), self.root)
        self.assertEqual(resolve_inside(".", self.root), self.root)

    def test_absolute_path_inside_is_fine(self):
        self.assertEqual(resolve_inside(str(self.root / "x"), self.root), self.root / "x")

    def test_escapes_are_refused(self):
        for bad in ("../outside.txt", "a/../../outside", "/etc/passwd", str(self.base / "other")):
            with self.assertRaisesRegex(ValueError, "escapes workspace root", msg=bad):
                resolve_inside(bad, self.root)

    def test_a_symlink_pointing_outside_is_an_escape(self):
        outside = self.base / "secret.txt"
        outside.write_text("s", encoding="utf-8")
        try:
            os.symlink(outside, self.root / "link.txt")
        except (OSError, NotImplementedError):
            self.skipTest("symlinks not available")
        with self.assertRaisesRegex(ValueError, "escapes workspace root"):
            resolve_inside("link.txt", self.root)

    def test_a_sibling_with_the_same_prefix_is_not_inside(self):
        sibling = self.base / "workspace-evil"
        sibling.mkdir()
        with self.assertRaises(ValueError):
            resolve_inside(str(sibling / "x"), self.root)

    def test_relative_formatting(self):
        self.assertEqual(relative(self.root / "a" / "b.txt", self.root), "a/b.txt")
        self.assertEqual(relative(self.root, self.root), ".")


class OutsideRootGuardTests(WorkspaceCase):
    def test_paths_that_leave_the_root_are_found(self):
        for bad in (("/etc/passwd",), ("../x",), ("a/../../x",), ("--out=/etc/x",), ("~/notes",), (str(self.base / "other"),)):
            self.assertIsNotNone(find_outside_root(list(bad), self.root), bad)

    def test_ordinary_arguments_and_paths_inside_are_fine(self):
        for good in (["-m", "unittest"], ["src/a.py"], [str(self.root / "x")], ["a/../b"], ["/dev/null"], ["s/a/b/"], ["--flag=value"], ["print('/etc')"]):
            self.assertIsNone(find_outside_root(good, self.root), good)

    def test_run_command_refuses_and_names_the_root(self):
        with self.assertRaisesRegex(ValueError, "outside the workspace root") as caught:
            run_command(self.ctx, "cat", ["/etc/passwd"])
        self.assertIn(str(self.root), str(caught.exception))

    def test_the_program_may_live_anywhere_but_not_climb_out_with_dots(self):
        self.assertIsNone(outside_root_argument("/usr/bin/python3", ["-m", "unittest"], self.root))
        self.assertIsNotNone(outside_root_argument("../tool.sh", [], self.root))


class IterFilesTests(WorkspaceCase):
    def test_skips_dependency_and_build_folders_and_is_sorted(self):
        for name in ("b.txt", "a.txt", "node_modules/x.js", ".git/config", "dist/o.js", "src/z.js", "src/y.js"):
            self.write(name)
        found = [relative(p, self.root) for p in iter_files(self.root)]
        self.assertEqual(found, ["a.txt", "b.txt", "src/y.js", "src/z.js"])

    def test_an_excluded_folder_is_not_even_entered(self):
        self.write("target/debug/big.o")
        self.write("src/a.rs")
        entered = []
        original = os.walk
        def spy(base, *args, **kwargs):
            for current, dirs, names in original(base, *args, **kwargs):
                entered.append(Path(current).name)
                yield current, dirs, names
        with mock.patch("snapgent_mcp.paths.os.walk", spy):
            found = [relative(p, self.root) for p in iter_files(self.root, {"target"})]
        self.assertEqual(found, ["src/a.rs"])
        self.assertNotIn("debug", entered)

    def test_a_single_file_yields_itself(self):
        path = self.write("one.txt")
        self.assertEqual(list(iter_files(path)), [path])


if __name__ == "__main__":
    unittest.main()
