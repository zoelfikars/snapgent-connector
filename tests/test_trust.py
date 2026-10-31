import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from snapgent_bridge import trust
from snapgent_bridge.trust import TrustPolicy, TrustStore

ORIGIN = "moz-extension://1f2e3d4c-aaaa-bbbb-cccc-111122223333"
OTHER = "chrome-extension://abcdefghijklmnop"


class StoreTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.path = Path(self._tmp.name) / "trusted_origins.json"

    def test_remembers_across_runs(self):
        TrustStore(self.path).add(ORIGIN)
        self.assertIn(ORIGIN, TrustStore(self.path))
        self.assertNotIn(OTHER, TrustStore(self.path))
        self.assertFalse(self.path.with_suffix(".json.tmp").exists())

    def test_the_file_is_plain_json_the_user_can_edit(self):
        store = TrustStore(self.path)
        store.add(OTHER)
        store.add(ORIGIN)
        self.assertEqual(json.loads(self.path.read_text(encoding="utf-8")), {"origins": sorted([OTHER, ORIGIN])})

    def test_a_damaged_file_trusts_nobody_instead_of_everybody(self):
        for content in ("{broken", "[]", '{"origins": "x"}', '{"origins": [1, null]}', ""):
            self.path.write_text(content, encoding="utf-8")
            store = TrustStore(self.path)
            for origin in (ORIGIN, OTHER, "chrome-extension://abcdefghijklmnop"):
                self.assertNotIn(origin, store, content)

    def test_without_a_file_it_is_memory_only(self):
        store = TrustStore(None)
        store.add(ORIGIN)
        self.assertIn(ORIGIN, store)


class PolicyTests(unittest.IsolatedAsyncioTestCase):
    def make(self, answers=None, pinned=(), store=None, error=None):
        asked = []
        logs = []

        async def ask(origin):
            asked.append(origin)
            await asyncio.sleep(0)
            if error:
                raise error
            return (answers or {}).get(origin, False)

        policy = TrustPolicy(store or TrustStore(None), pinned, ask, logs.append)
        return policy, asked, logs

    async def settle(self):
        for _ in range(5):
            await asyncio.sleep(0)

    async def test_an_unknown_extension_is_turned_away_at_first_and_let_in_after_the_user_says_yes(self):
        policy, asked, logs = self.make({ORIGIN: True})
        self.assertFalse(policy.allows(ORIGIN))
        await self.settle()
        self.assertTrue(policy.allows(ORIGIN))
        self.assertEqual(asked, [ORIGIN])
        self.assertTrue(any("approved extension" in line for line in logs))

    async def test_no_means_no_and_it_does_not_nag_again_this_run(self):
        policy, asked, logs = self.make({ORIGIN: False})
        policy.allows(ORIGIN)
        await self.settle()
        for _ in range(5):
            self.assertFalse(policy.allows(ORIGIN))
            await self.settle()
        self.assertEqual(asked, [ORIGIN])
        self.assertTrue(any("refused extension" in line and "ZS_ALLOWED_ORIGINS" in line for line in logs))

    async def test_a_burst_of_reconnects_while_the_question_is_open_asks_only_once(self):
        gate = asyncio.Event()
        asked = []

        async def ask(origin):
            asked.append(origin)
            await gate.wait()
            return True

        policy = TrustPolicy(TrustStore(None), [], ask, lambda _m: None)
        for _ in range(10):
            self.assertFalse(policy.allows(ORIGIN))
            await asyncio.sleep(0)
        gate.set()
        await self.settle()
        self.assertEqual(asked, [ORIGIN])
        self.assertTrue(policy.allows(ORIGIN))

    async def test_a_prompt_that_crashes_is_never_approval(self):
        policy, asked, logs = self.make(error=RuntimeError("no terminal"))
        policy.allows(ORIGIN)
        await self.settle()
        self.assertFalse(policy.allows(ORIGIN))
        self.assertTrue(any("could not ask" in line for line in logs))

    async def test_origins_are_independent(self):
        policy, asked, _ = self.make({ORIGIN: True})
        policy.allows(ORIGIN)
        policy.allows(OTHER)
        await self.settle()
        self.assertTrue(policy.allows(ORIGIN))
        self.assertFalse(policy.allows(OTHER))
        self.assertEqual(sorted(asked), sorted([ORIGIN, OTHER]))

    async def test_an_already_trusted_origin_is_never_asked_about(self):
        store = TrustStore(None)
        store.add(ORIGIN)
        policy, asked, _ = self.make(store=store)
        self.assertTrue(policy.allows(ORIGIN))
        await self.settle()
        self.assertEqual(asked, [])

    async def test_a_pinned_origin_replaces_the_questions_entirely(self):
        policy, asked, _ = self.make(pinned=[ORIGIN])
        self.assertTrue(policy.allows(ORIGIN))
        self.assertFalse(policy.allows(OTHER))
        await self.settle()
        self.assertEqual(asked, [], "pinning means the user already decided")


class TerminalPromptTests(unittest.IsolatedAsyncioTestCase):
    async def test_without_a_terminal_the_answer_is_no(self):
        class NoTty:
            def isatty(self):
                return False
        with patch.object(trust.sys, "stdin", NoTty()):
            self.assertFalse(await trust.ask_in_terminal(ORIGIN))
        with patch.object(trust.sys, "stdin", None):
            self.assertFalse(await trust.ask_in_terminal(ORIGIN))

    async def test_only_an_explicit_yes_approves(self):
        class Tty:
            def isatty(self):
                return True
        for reply, expected in (("y", True), ("YES", True), (" yes ", True), ("", False), ("n", False), ("ya", False), ("sure", False)):
            with patch.object(trust.sys, "stdin", Tty()), patch("builtins.input", return_value=reply):
                self.assertEqual(await trust.ask_in_terminal(ORIGIN), expected, reply)

    async def test_the_prompt_names_the_origin_and_says_when_to_refuse(self):
        class Tty:
            def isatty(self):
                return True
        shown = []
        with patch.object(trust.sys, "stdin", Tty()), patch("builtins.input", side_effect=lambda text: shown.append(text) or "n"):
            await trust.ask_in_terminal(ORIGIN)
        self.assertIn(ORIGIN, shown[0])
        self.assertIn("ONLY if it is your own", shown[0])
        self.assertIn("Type y and press Enter", shown[0])
        self.assertTrue(shown[0].startswith("\n"), "the question starts on a fresh line instead of after a log line")
        self.assertTrue(shown[0].rstrip().endswith("[y/N]"), "the answer is typed on the question's own line")

    async def test_a_terminal_that_closes_counts_as_no(self):
        class Tty:
            def isatty(self):
                return True
        with patch.object(trust.sys, "stdin", Tty()), patch("builtins.input", side_effect=EOFError):
            self.assertFalse(await trust.ask_in_terminal(ORIGIN))

    async def test_two_extensions_are_asked_one_after_the_other(self):
        class Tty:
            def isatty(self):
                return True
        asked = []

        def answer(text):
            asked.append(text)
            return "n"

        with patch.object(trust.sys, "stdin", Tty()), patch("builtins.input", side_effect=answer):
            await asyncio.gather(trust.ask_in_terminal(ORIGIN), trust.ask_in_terminal(OTHER))
        self.assertEqual(len(asked), 2, "both questions reach the terminal")
        self.assertTrue(any(ORIGIN in text for text in asked))
        self.assertTrue(any(OTHER in text for text in asked), "the second question is not swallowed by the first")


if __name__ == "__main__":
    unittest.main()
