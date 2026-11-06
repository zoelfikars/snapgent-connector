import unittest

from snapgent_mcp import risk
from snapgent_mcp.security import (
    ALLOW, CONFIRM, DENY, MODES, READONLY, RESERVED_ARGUMENT, STANDARD, TRUSTED,
    ConfirmationStore, Policy, SessionState, decide, policy_from_env,
)
from snapgent_mcp.security import commands as cmd
from snapgent_mcp.security import files as sf
from snapgent_mcp.security.confirmation import fingerprint


class ModeTests(unittest.TestCase):
    def test_default_is_standard(self):
        self.assertEqual(policy_from_env({}).mode, STANDARD)

    def test_modes_and_extra_commands_come_from_the_environment(self):
        policy = policy_from_env({"SNAPGENT_POLICY": " ReadOnly ", "SNAPGENT_ALLOWED_COMMANDS": "Cargo, make ,,"})
        self.assertEqual(policy.mode, READONLY)
        self.assertEqual(policy.extra_commands, frozenset({"cargo", "make"}))

    def test_a_typo_never_loosens_security(self):
        for value in ("trusted ", "truste", "off", "none", "yes"):
            expected = TRUSTED if value.strip() == "trusted" else STANDARD
            self.assertEqual(policy_from_env({"SNAPGENT_POLICY": value}).mode, expected, value)

    def test_building_a_policy_with_an_unknown_mode_fails(self):
        with self.assertRaises(ValueError):
            Policy("permissive")

    def test_only_standard_asks(self):
        self.assertEqual([Policy(m).asks for m in MODES], [False, True, False])


class SensitiveFileTests(unittest.TestCase):
    def test_secrets(self):
        for path in (".env", "app/.env", ".env.local", ".env.production", "keys/server.pem", "a/b/id_rsa", "id_ed25519", ".npmrc",
                     ".ssh/config", "home/.aws/credentials", "config/credentials.json", "SECRETS.yml", "x.kdbx", "tls.KEY"):
            self.assertTrue(sf.is_sensitive(path), path)

    def test_templates_public_keys_and_ordinary_files_are_fine(self):
        for path in (".env.example", ".env.sample", "id_rsa.pub", "README.md", "src/environment.js", "docs/keys.md", "", ".", "env.txt"):
            self.assertFalse(sf.is_sensitive(path), path)

    def test_windows_separators(self):
        self.assertTrue(sf.is_sensitive("a\\.ssh\\id_rsa"))

    def test_git_directory(self):
        for path in (".git/config", ".git/hooks/pre-commit", "sub/.git/config", "a\\.git\\hooks"):
            self.assertTrue(sf.touches_git_directory(path), path)
        for path in (".gitignore", ".github/workflows/x.yml", "src/git.js", ""):
            self.assertFalse(sf.touches_git_directory(path), path)

    def test_files_that_decide_what_runs(self):
        for path in ("package.json", "sub/Makefile", "pyproject.toml", "conftest.py", "App.csproj", ".husky/pre-commit", "scripts/build.sh", "jest.config.js"):
            self.assertTrue(sf.is_execution_config(path), path)
        for path in ("src/app.js", "README.md", "scripts"):
            self.assertFalse(sf.is_execution_config(path), path)


class CommandTests(unittest.TestCase):
    def test_names(self):
        self.assertEqual([cmd.executable_name(c) for c in ("git", "/usr/bin/GIT", "C:\\Git\\git.exe", "npm.cmd")], ["git", "git", "git", "npm"])
        self.assertTrue(cmd.is_bare_name("git"))
        for planted in ("./git", "../bin/git", "bin/git", "C:\\x\\git", ".hidden", ""):
            self.assertFalse(cmd.is_bare_name(planted), planted)

    def test_harmless(self):
        for command, args in (("git", ["status"]), ("git", ["diff", "--stat"]), ("git", ["log", "-5", "--oneline"]), ("node", ["--version"]),
                              ("npm", ["-v"]), ("python3", ["--version"]), ("git", ["--version"]), ("git", ["version"])):
            self.assertTrue(cmd.is_harmless(command, args), (command, args))

    def test_not_harmless(self):
        for command, args in (("git", []), ("git", ["push"]), ("git", ["reset", "--hard"]), ("git", ["-c", "core.pager=x", "log"]),
                              ("git", ["diff", "--output=out.txt"]), ("git", ["grep", "-Osh", "x"]), ("git", ["log", "--exec=x"]),
                              ("node", ["-e", "process.exit()"]), ("node", ["--version", "x"]), ("curl", ["--version"]), ("rm", ["-rf", "x"]),
                              ("./git", ["status"]), ("bash", ["--version"])):
            self.assertFalse(cmd.is_harmless(command, args), (command, args))

    def test_the_user_can_extend_the_allowlist_but_not_with_a_path(self):
        extra = frozenset({"cargo"})
        self.assertTrue(cmd.is_harmless("cargo", ["build"], extra))
        self.assertTrue(cmd.is_harmless("Cargo.exe", ["build"], extra))
        self.assertFalse(cmd.is_harmless("./cargo", ["build"], extra))

    def test_cmd_metacharacters(self):
        self.assertEqual(cmd.unsafe_for_cmd(["npm", "run", "test"]), [])
        for part in ("a & calc", "a|b", "x > y", "%PATH%", "a^b", 'say "hi"', "a\nb", "!x"):
            self.assertEqual(cmd.unsafe_for_cmd(["ok", part]), [part], part)

    def test_describe_is_bounded(self):
        self.assertEqual(cmd.describe("git", ["push", "origin"]), "git push origin")
        self.assertEqual(len(cmd.describe("x", ["a" * 1000])), 300)


class ClockStub:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


class ConfirmationTests(unittest.TestCase):
    def make(self):
        clock = ClockStub()
        counter = iter(range(1, 100))
        return ConfirmationStore(clock, lambda: f"tok{next(counter)}"), clock

    def test_a_token_works_once_for_the_same_call(self):
        store, _ = self.make()
        token = store.issue("delete_file", {"path": "a.txt"})
        self.assertTrue(store.redeem(token, "delete_file", {"path": "a.txt", RESERVED_ARGUMENT: token}))
        self.assertFalse(store.redeem(token, "delete_file", {"path": "a.txt"}), "single use")

    def test_a_token_is_bound_to_the_exact_tool_and_arguments(self):
        store, _ = self.make()
        token = store.issue("delete_file", {"path": "a.txt"})
        self.assertFalse(store.redeem(token, "delete_file", {"path": "b.txt"}))
        token = store.issue("delete_file", {"path": "a.txt"})
        self.assertFalse(store.redeem(token, "write_file", {"path": "a.txt"}))

    def test_a_wrong_token_is_burned_and_garbage_is_rejected(self):
        store, _ = self.make()
        store.issue("t", {})
        for bad in ("guess", "", None, 123, ["tok1"]):
            self.assertFalse(store.redeem(bad, "t", {}), repr(bad))

    def test_tokens_expire(self):
        store, clock = self.make()
        token = store.issue("t", {})
        clock.now += 121
        self.assertFalse(store.redeem(token, "t", {}))

    def test_real_tokens_are_long_and_random(self):
        a, b = ConfirmationStore().issue("t", {}), ConfirmationStore().issue("t", {})
        self.assertEqual(len(a), 32)
        self.assertNotEqual(a, b)

    def test_argument_order_does_not_matter(self):
        self.assertEqual(fingerprint("t", {"a": 1, "b": 2}), fingerprint("t", {"b": 2, "a": 1}))


class DecisionMatrixTests(unittest.TestCase):
    def verdict(self, name, tool_risk, arguments=None, policy=None, session=None):
        return decide(policy or Policy(), name, tool_risk, arguments or {}, session or SessionState()).verdict

    def test_standard_mode(self):
        v = self.verdict
        self.assertEqual(v("read_files", risk.READ, {"paths": ["src/a.js"]}), ALLOW)
        self.assertEqual(v("read_files", risk.READ, {"paths": [".env"]}), CONFIRM)
        self.assertEqual(v("read_files", risk.READ, {"paths": ["a.js", "config/.env.local"]}), CONFIRM)
        self.assertEqual(v("git_diff", risk.READ, {"path": "id_rsa"}), CONFIRM)
        self.assertEqual(v("list_dir", risk.READ, {"path": ".ssh"}), ALLOW)
        self.assertEqual(v("write_file", risk.WRITE, {"path": "src/a.js", "content": "x"}), ALLOW)
        self.assertEqual(v("delete_file", risk.DESTRUCTIVE, {"path": "a.txt"}), CONFIRM)
        self.assertEqual(v("git_add", risk.VCS, {"paths": ["a.txt"]}), ALLOW)
        self.assertEqual(v("git_commit", risk.VCS, {"message": "m"}), CONFIRM)
        self.assertEqual(v("run_command", risk.EXECUTE, {"command": "git", "args": ["status"]}), ALLOW)
        self.assertEqual(v("run_command", risk.EXECUTE, {"command": "curl", "args": ["http://x"]}), CONFIRM)
        self.assertEqual(v("run_tests", risk.EXECUTE), ALLOW)
        self.assertEqual(v("run_project_script", risk.EXECUTE, {"script": "test"}), ALLOW)

    def test_confirmation_text_says_what_will_happen(self):
        d = decide(Policy(), "run_command", risk.EXECUTE, {"command": "npm", "args": ["install", "left-pad"]}, SessionState())
        self.assertEqual(d.reason, "Run command: npm install left-pad")
        self.assertIn("a.txt", decide(Policy(), "delete_file", risk.DESTRUCTIVE, {"path": "a.txt"}, SessionState()).reason)
        self.assertIn('"fix bug"', decide(Policy(), "git_commit", risk.VCS, {"message": "fix bug"}, SessionState()).reason)

    def test_scripts_need_approval_once_the_agent_changed_what_they_run(self):
        session = SessionState()
        session.note_write("src/app.js")
        self.assertEqual(self.verdict("run_tests", risk.EXECUTE, session=session), ALLOW)
        session.note_write("package.json")
        decision = decide(Policy(), "run_project_script", risk.EXECUTE, {"script": "build"}, session)
        self.assertEqual(decision.verdict, CONFIRM)
        self.assertIn("package.json", decision.reason)

    def test_git_internals_are_refused_in_every_mode(self):
        for mode in MODES:
            for name, tool_risk, args in (("write_file", risk.WRITE, {"path": ".git/hooks/pre-commit"}), ("edit_file", risk.WRITE, {"path": ".git/config"}),
                                          ("copy_file", risk.WRITE, {"source": "a", "destination": ".git/hooks/x"}), ("delete_file", risk.DESTRUCTIVE, {"path": ".git/x"})):
                self.assertEqual(self.verdict(name, tool_risk, args, Policy(mode)), DENY, (mode, name))
        self.assertEqual(self.verdict("read_files", risk.READ, {"paths": [".git/config"]}, Policy(TRUSTED)), ALLOW, "reading is not the danger")

    def test_readonly_refuses_everything_but_reads(self):
        p = Policy(READONLY)
        for name, tool_risk in (("write_file", risk.WRITE), ("delete_file", risk.DESTRUCTIVE), ("run_tests", risk.EXECUTE), ("git_add", risk.VCS)):
            self.assertEqual(self.verdict(name, tool_risk, {"path": "a"}, p), DENY, name)
        self.assertEqual(self.verdict("read_files", risk.READ, {"paths": ["a.js"]}, p), ALLOW)
        self.assertEqual(self.verdict("read_files", risk.READ, {"paths": [".env"]}, p), CONFIRM, "secrets still need approval")

    def test_plan_mode_lets_the_agent_save_its_plan_as_markdown_under_snapgent_plans_and_nowhere_else(self):
        p = Policy(READONLY)
        for name in ("create_file", "write_file", "edit_file", "apply_patch"):
            self.assertEqual(self.verdict(name, risk.WRITE, {"path": ".snapgent/plans/add-login.md"}, p), ALLOW, name)
        self.assertEqual(self.verdict("write_file", risk.WRITE, {"path": ".snapgent/plans/api/v2/auth.MD"}, p), ALLOW)
        for path in (".snapgent/plans/x.txt", ".snapgent/plans/.md", ".snapgent/skills/x.md", "plans/x.md", "src/main.go", ".snapgent/plans",
                     ".snapgent/plans/../config.md", ".snapgent/plans/../../x.md", "docs/.snapgent/plans/x.md"):
            self.assertEqual(self.verdict("write_file", risk.WRITE, {"path": path}, p), DENY, path)
        # only the editing tools, and only when every path is a plan file
        self.assertEqual(self.verdict("delete_file", risk.DESTRUCTIVE, {"path": ".snapgent/plans/x.md"}, p), DENY)
        self.assertEqual(self.verdict("copy_file", risk.WRITE, {"source": "a.md", "destination": ".snapgent/plans/x.md"}, p), DENY)
        self.assertEqual(self.verdict("run_command", risk.EXECUTE, {"command": "ls"}, p), DENY)

    def test_trusted_mode_never_asks(self):
        p = Policy(TRUSTED)
        for name, tool_risk, args in (("delete_file", risk.DESTRUCTIVE, {"path": "a"}), ("git_commit", risk.VCS, {"message": "m"}),
                                      ("run_command", risk.EXECUTE, {"command": "rm", "args": ["-rf", "x"]}), ("read_files", risk.READ, {"paths": [".env"]})):
            self.assertEqual(self.verdict(name, tool_risk, args, p), ALLOW, name)

    def test_user_allowlisted_commands_skip_the_prompt(self):
        p = Policy(STANDARD, frozenset({"cargo"}))
        self.assertEqual(self.verdict("run_command", risk.EXECUTE, {"command": "cargo", "args": ["build"]}, p), ALLOW)
        self.assertEqual(self.verdict("run_command", risk.EXECUTE, {"command": "./cargo", "args": []}, p), CONFIRM)

    def test_a_token_in_the_arguments_never_changes_the_verdict(self):
        self.assertEqual(self.verdict("delete_file", risk.DESTRUCTIVE, {"path": "a", RESERVED_ARGUMENT: "anything"}), CONFIRM)

    def test_malformed_arguments_do_not_crash_the_decision(self):
        self.assertEqual(self.verdict("run_command", risk.EXECUTE, {"command": 5, "args": [1, None]}), CONFIRM)
        self.assertEqual(self.verdict("read_files", risk.READ, {"paths": "x"}), ALLOW)


if __name__ == "__main__":
    unittest.main()
