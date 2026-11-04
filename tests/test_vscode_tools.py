from unittest import mock
import json
import sys
import unittest

from snapgent_vscode import limits
from snapgent_vscode.tools import all_tools, call, get, registry, schemas
from snapgent_vscode.tools import commands, editing, git as git_tools, project, reading
from tests.vscode_support import WorkspaceCase, git


class CatalogueTests(WorkspaceCase):
    def test_24_unique_tools_each_with_a_description_schema_and_risk(self):
        tools = all_tools()
        self.assertEqual(len(tools), 24)
        self.assertEqual(len({t.name for t in tools}), 24)
        for tool in tools:
            self.assertTrue(tool.description, tool.name)
            self.assertIn(tool.risk, {registry.READ, registry.WRITE, registry.DESTRUCTIVE, registry.EXECUTE, registry.VCS}, tool.name)
            self.assertEqual(tool.schema()["inputSchema"]["type"], "object")
            self.assertTrue(set(tool.required) <= set(tool.properties), tool.name)

    def test_risk_labels_for_the_tools_that_matter(self):
        risk = {t.name: t.risk for t in all_tools()}
        self.assertEqual((risk["read_files"], risk["write_file"], risk["delete_file"], risk["run_command"], risk["git_commit"]),
                         (registry.READ, registry.WRITE, registry.DESTRUCTIVE, registry.EXECUTE, registry.VCS))

    def test_schemas_are_json_serialisable(self):
        json.dumps(schemas())

    def test_duplicate_registration_is_an_error(self):
        with self.assertRaisesRegex(ValueError, "Duplicate tool name"):
            registry.tool("tree", "again")(lambda ctx: None)

    def test_unknown_tool(self):
        with self.assertRaisesRegex(ValueError, "Unknown tool: nope"):
            call(self.ctx, "nope", {})

    def test_missing_required_parameters_are_named(self):
        with self.assertRaisesRegex(ValueError, r"Missing required parameter\(s\) for read_files: paths"):
            call(self.ctx, "read_files", {})
        with self.assertRaisesRegex(ValueError, "old_text, new_text"):
            call(self.ctx, "edit_file", {"path": "x"})

    def test_unknown_arguments_are_ignored(self):
        self.write("a.txt", "hi")
        self.assertIn("hi", call(self.ctx, "read_files", {"paths": ["a.txt"], "encoding": "latin-1", "extra": 1}))


class ProjectTests(WorkspaceCase):
    def test_workspace_info(self):
        info = project.get_workspace_info(self.ctx)
        self.assertEqual((info["name"], info["is_git_repository"]), ("workspace", False))
        (self.root / ".git").mkdir()
        self.assertTrue(project.get_workspace_info(self.ctx)["is_git_repository"])

    def test_project_info_reads_package_scripts_and_survives_bad_json(self):
        self.write("package.json", json.dumps({"name": "demo", "scripts": {"test": "x"}}))
        self.write("pyproject.toml", "")
        manifests = {m["path"]: m for m in project.get_project_info(self.ctx)["manifests"]}
        self.assertEqual(manifests["package.json"]["scripts"], {"test": "x"})
        self.assertIn("pyproject.toml", manifests)
        self.write("package.json", "{broken")
        self.assertIn("error", project.get_project_info(self.ctx)["manifests"][0])


class ReadingTests(WorkspaceCase):
    def setUp(self):
        super().setUp()
        self.write("src/app.js", "export function start() {}\nconst run = () => 1\n")
        self.write(".github/workflows/check.yml", "name: check\n")
        self.write("node_modules/dep/index.js", "export function hidden() {}\n")

    def test_tree_skips_dependencies_and_respects_exclude(self):
        paths = [line.strip() for line in reading.tree(self.ctx, ".", 1).splitlines()]
        self.assertTrue(any("src" in p for p in paths))
        self.assertFalse(any("node_modules" in p for p in paths))
        custom = reading.tree(self.ctx, ".", 3, exclude=["src"])
        self.assertFalse(any("app.js" in p for p in custom.splitlines()))

    def test_find_files_by_name_and_by_path_pattern(self):
        self.assertEqual(reading.find_files(self.ctx, ".", "*.js"), ["src/app.js"])  # node_modules is skipped
        self.assertEqual(reading.find_files(self.ctx, ".", "*.yml"), [".github/workflows/check.yml"])
        self.assertEqual(reading.find_files(self.ctx, "src", "app.js"), ["src/app.js"])

    def test_search_files(self):
        hits = reading.search_files(self.ctx, ".", "START")
        self.assertEqual(hits, ["src/app.js:1: export function start() {}"])
        self.assertEqual(reading.search_files(self.ctx, ".", "START", case_sensitive=True), [])
        self.assertEqual(reading.search_files(self.ctx, ".", "run", file_pattern="*.yml"), [])

    def test_find_files_gives_the_model_a_short_list_and_the_extension_the_whole_project(self):
        for index in range(limits.MAX_RESULTS + 30):
            self.write(f"many/f{index:05d}.txt", "x")
        self.assertEqual(len(reading.find_files(self.ctx, "many", "*")), limits.MAX_RESULTS)
        self.assertEqual(len(reading.find_files(self.ctx, "many", "*", max_results=limits.MAX_RESULTS + 30)), limits.MAX_RESULTS + 30)
        self.assertEqual(len(reading.find_files(self.ctx, "many", "*", max_results=5)), 5)

    def test_a_hidden_folder_like_snapgent_plans_is_listed(self):
        self.write(".snapgent/plans/add-login.md", "# plan")
        self.assertIn(".snapgent/plans/add-login.md", reading.find_files(self.ctx, "."))

    def test_search_skips_binary_and_oversized_files_and_excluded_folders(self):
        (self.root / "blob.bin").write_bytes(b"NEEDLE\0\1\2")
        self.write("huge.log", "NEEDLE\n" + "x" * (limits.MAX_SEARCH_FILE_BYTES + 10))
        self.write("target/debug/out.txt", "NEEDLE\n")
        self.write("notes.txt", "a NEEDLE here\n")
        self.assertEqual(reading.search_files(self.ctx, ".", "NEEDLE"), ["notes.txt:1: a NEEDLE here"])

    def test_a_search_that_runs_out_of_time_returns_what_it_found_and_says_so(self):
        self.write("a.txt", "NEEDLE\n")
        self.write("b.txt", "NEEDLE\n")
        with mock.patch.object(limits, "SEARCH_TIME_SECONDS", 0), mock.patch.object(reading, "SEARCH_TIME_SECONDS", 0):
            hits = reading.search_files(self.ctx, ".", "NEEDLE")
        self.assertIn("search stopped", hits[-1])

    def test_search_results_are_capped(self):
        self.write("big.txt", "x\n" * (limits.MAX_RESULTS + 50))
        self.assertEqual(len(reading.search_files(self.ctx, "big.txt", "x")), limits.MAX_RESULTS)

    def test_read_files_bulk_and_budget(self):
        self.write("a.txt", "one\ntwo\n")
        self.write("b.txt", "three\n")
        text = reading.read_files(self.ctx, ["a.txt", "b.txt"])
        self.assertIn("===== a.txt =====", text)
        self.assertIn("1: one", text)
        self.assertIn("===== b.txt =====", text)
        # A file that does not fit is listed as remaining instead of being truncated.
        big = "z" * (limits.MAX_FILE_CHARS + 10)
        self.write("huge.txt", big)
        out = reading.read_files(self.ctx, ["a.txt", "huge.txt", "b.txt"], max_total_chars=20)
        self.assertIn("more files remaining", out)
        self.assertIn("huge.txt", out)

    def test_read_files_limit(self):
        with self.assertRaises(ValueError):
            reading.read_files(self.ctx, ["src/app.js"] * 51)

    def test_read_files_escape(self):
        text = reading.read_files(self.ctx, ["../outside.txt"])
        self.assertIn("escapes workspace", text)

class EditingTests(WorkspaceCase):
    def test_create_never_overwrites_and_makes_parents(self):
        self.assertEqual(editing.create_file(self.ctx, "a/b/c.txt", "x"), "Created a/b/c.txt")
        with self.assertRaisesRegex(FileExistsError, "already exists"):
            editing.create_file(self.ctx, "a/b/c.txt", "y")
        self.assertEqual(self.read("a/b/c.txt"), "x")

    def test_write_replaces(self):
        editing.write_file(self.ctx, "w.txt", "1")
        editing.write_file(self.ctx, "w.txt", "2")
        self.assertEqual(self.read("w.txt"), "2")

    def test_edit_requires_a_unique_snippet_unless_replace_all(self):
        self.write("d.txt", "same same")
        with self.assertRaisesRegex(ValueError, "occurs 2 times"):
            editing.edit_file(self.ctx, "d.txt", "same", "new")
        with self.assertRaisesRegex(ValueError, "not found"):
            editing.edit_file(self.ctx, "d.txt", "absent", "new")
        with self.assertRaisesRegex(ValueError, "cannot be empty"):
            editing.edit_file(self.ctx, "d.txt", "", "new")
        self.assertIn("2 replacement", editing.edit_file(self.ctx, "d.txt", "same", "new", replace_all=True))
        self.assertEqual(self.read("d.txt"), "new new")

    def test_apply_patch_is_all_or_nothing(self):
        self.write("app.txt", "alpha beta gamma")
        editing.apply_patch(self.ctx, "app.txt", [{"old_text": "alpha", "new_text": "one"}, {"old_text": "gamma", "new_text": "three"}])
        self.assertEqual(self.read("app.txt"), "one beta three")
        with self.assertRaises(ValueError):
            editing.apply_patch(self.ctx, "app.txt", [{"old_text": "one", "new_text": "1"}, {"old_text": "missing", "new_text": "x"}])
        self.assertEqual(self.read("app.txt"), "one beta three", "nothing written when any edit fails")
        for bad in ([], "no", [5], [{"old_text": "", "new_text": "x"}], [{"old_text": "one", "new_text": 3}]):
            with self.assertRaises(ValueError, msg=repr(bad)):
                editing.apply_patch(self.ctx, "app.txt", bad)

    def test_patch_edits_apply_in_order(self):
        self.write("o.txt", "a")
        editing.apply_patch(self.ctx, "o.txt", [{"old_text": "a", "new_text": "b"}, {"old_text": "b", "new_text": "c"}])
        self.assertEqual(self.read("o.txt"), "c")

    def test_copy_and_move_do_not_overwrite(self):
        self.write("source.txt", "content")
        editing.copy_file(self.ctx, "source.txt", "dir/copy.txt")
        self.assertEqual(self.read("dir/copy.txt"), "content")
        with self.assertRaises(FileExistsError):
            editing.copy_file(self.ctx, "source.txt", "dir/copy.txt")
        editing.move_file(self.ctx, "source.txt", "moved.txt")
        self.assertFalse((self.root / "source.txt").exists())
        with self.assertRaises(FileNotFoundError):
            editing.move_file(self.ctx, "source.txt", "again.txt")
        with self.assertRaises(ValueError):
            editing.move_file(self.ctx, "moved.txt", "../outside.txt")

    def test_create_directory(self):
        self.assertEqual(editing.create_directory(self.ctx, "x/y"), "Directory ready: x/y")
        self.assertTrue((self.root / "x" / "y").is_dir())

    def test_delete_refuses_unsafe_targets(self):
        self.write("notes.txt", "x")
        (self.root / "folder").mkdir()
        self.write(".git/config", "x")
        self.assertIn("Deleted", editing.delete_file(self.ctx, "notes.txt"))
        self.assertFalse((self.root / "notes.txt").exists())
        for path, error in (("folder", IsADirectoryError), (".git/config", ValueError), (".", ValueError), ("../outside.txt", ValueError), ("missing.txt", FileNotFoundError)):
            with self.assertRaises(error, msg=path):
                editing.delete_file(self.ctx, path)
        self.assertTrue((self.root / ".git" / "config").exists())


class GitTests(WorkspaceCase):
    def setUp(self):
        super().setUp()
        git(self.root, "init", "-q", "-b", "main")
        self.write("a.txt", "one\n")
        git(self.root, "add", "a.txt")
        git(self.root, "commit", "-q", "-m", "first")

    def test_status_diff_log_branches(self):
        self.write("a.txt", "two\n")
        self.assertIn("a.txt", git_tools.git_status(self.ctx))
        self.assertIn("-one", git_tools.git_diff(self.ctx, "a.txt"))
        self.assertIn("first", git_tools.git_log(self.ctx, 5))
        self.assertEqual(git_tools.git_branches(self.ctx), "main")
        for bad in (0, 51):
            with self.assertRaises(ValueError):
                git_tools.git_log(self.ctx, bad)

    def test_diff_path_cannot_escape(self):
        with self.assertRaises(ValueError):
            git_tools.git_diff(self.ctx, "../x")

    def test_add_and_commit_flow(self):
        self.write("b.txt", "new\n")
        self.assertIn("Staged 1 path(s): b.txt", git_tools.git_add(self.ctx, ["b.txt"]))
        git(self.root, "config", "user.name", "T")
        git(self.root, "config", "user.email", "t@example.com")
        git_tools.git_commit(self.ctx, "  add b  ")
        self.assertIn("add b", git(self.root, "log", "-1", "--format=%s"))

    def test_add_refuses_the_whole_workspace_and_bad_input(self):
        for paths in (["."], [], "a.txt"):
            with self.assertRaises(ValueError, msg=repr(paths)):
                git_tools.git_add(self.ctx, paths)
        with self.assertRaises(ValueError):
            git_tools.git_add(self.ctx, ["../x"])

    def test_commit_needs_a_message_and_surfaces_git_errors(self):
        for message in ("", "  ", None):
            with self.assertRaises(ValueError):
                git_tools.git_commit(self.ctx, message)
        git(self.root, "config", "user.name", "T")
        git(self.root, "config", "user.email", "t@example.com")
        with self.assertRaisesRegex(RuntimeError, "Command exited with status"):
            git_tools.git_commit(self.ctx, "nothing staged")


class CommandTests(WorkspaceCase):
    def test_package_manager_follows_the_lockfile(self):
        self.assertEqual(commands.package_manager(self.root), "npm")
        for lockfile, manager in (("yarn.lock", "yarn"), ("pnpm-lock.yaml", "pnpm")):
            self.write(lockfile)
            self.assertEqual(commands.package_manager(self.root), manager)

    def test_script_command_validates_everything(self):
        with self.assertRaisesRegex(ValueError, "Script must be one of"):
            commands.script_command("publish", self.root)
        with self.assertRaises(FileNotFoundError):
            commands.script_command("test", self.root)
        self.write("package.json", json.dumps({"scripts": {"lint": "x"}}))
        with self.assertRaisesRegex(ValueError, "does not define the 'test'"):
            commands.script_command("test", self.root)
        self.assertEqual(commands.script_command("lint", self.root)[-3:], ["npm", "run", "lint"] if commands.os.name != "nt" else ["npm", "run", "lint"])
        self.write("package.json", "{broken")
        with self.assertRaisesRegex(RuntimeError, "Could not read package.json"):
            commands.script_command("lint", self.root)

    def test_run_command_returns_output_and_reports_failures(self):
        self.assertEqual(commands.run_command(self.ctx, sys.executable, ["-c", "print('hello')"]), "hello")
        with self.assertRaisesRegex(RuntimeError, "status 3"):
            commands.run_command(self.ctx, sys.executable, ["-c", "import sys; sys.exit(3)"])
        with self.assertRaisesRegex(ValueError, "cannot be empty"):
            commands.run_command(self.ctx, "  ")

    def test_run_command_runs_in_the_workspace(self):
        self.assertEqual(commands.run_command(self.ctx, sys.executable, ["-c", "import os; print(os.getcwd())"]), str(self.root))

    def test_run_tests_without_any_setup(self):
        with self.assertRaisesRegex(FileNotFoundError, "No supported test setup"):
            commands.run_tests(self.ctx)


if __name__ == "__main__":
    unittest.main()
