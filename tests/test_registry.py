import unittest

from snapgent_bridge.registry import ServerRegistry
from tests.support import fake_registry, fake_server, mock_config, real_server, temp_dir


class CatalogueTests(unittest.TestCase):
    def test_colliding_names_are_server_prefixed_and_unique_ones_are_not(self):
        registry = fake_registry({"alpha": fake_server("alpha", ["get_state", "only_a"]), "beta": fake_server("beta", ["get_state"])})
        self.assertEqual([t["name"] for t in registry.catalog], ["alpha/get_state", "only_a", "beta/get_state"])
        self.assertEqual([t["server"] for t in registry.catalog], ["alpha", "alpha", "beta"])

    def test_dead_servers_are_left_out(self):
        registry = fake_registry({"a": fake_server("a", ["x"]), "b": fake_server("b", ["y"], alive=False)})
        self.assertEqual([t["name"] for t in registry.catalog], ["x"])

    def test_missing_description_and_schema_get_defaults(self):
        server = fake_server("a", ["x"])
        server.tools = [{"name": "x"}]
        entry = fake_registry({"a": server}).catalog[0]
        self.assertEqual((entry["description"], entry["inputSchema"]), ("", {"type": "object", "properties": {}}))

    def test_status_reports_per_server_health(self):
        registry = fake_registry({"a": fake_server("a", ["x", "y"]), "b": fake_server("b", ["z"], alive=False)})
        self.assertEqual(registry.status(), [{"id": "a", "alive": True, "tools": 2}, {"id": "b", "alive": False, "tools": 0}])
        self.assertTrue(registry.any_alive)
        self.assertFalse(fake_registry({"b": fake_server("b", ["z"], alive=False)}).any_alive)


class ResolveTests(unittest.TestCase):
    def setUp(self):
        self.registry = fake_registry({"alpha": fake_server("alpha", ["get_state", "only_a"]), "beta": fake_server("beta", ["get_state", "only_b"])})

    def test_unique_bare_name(self):
        found = self.registry.resolve("only_a")
        self.assertEqual((found.server.server_id, found.tool_name), ("alpha", "only_a"))

    def test_prefixed_name_addresses_a_server(self):
        found = self.registry.resolve("beta/get_state")
        self.assertEqual((found.server.server_id, found.tool_name), ("beta", "get_state"))

    def test_ambiguous_and_unknown_names_resolve_to_nothing(self):
        self.assertIsNone(self.registry.resolve("get_state").server)
        self.assertIsNone(self.registry.resolve("nope").server)
        self.assertIsNone(self.registry.resolve("ghost/only_a").server)


class IsolationTests(unittest.TestCase):
    def setUp(self):
        self.registry = fake_registry({"alpha": fake_server("alpha", ["get_state", "only_a"]), "beta": fake_server("beta", ["get_state", "only_b"])})

    def test_the_selected_server_can_run_its_tools(self):
        self.assertEqual(self.registry.resolve_for_call("only_a", "alpha").server.server_id, "alpha")

    def test_a_tool_of_another_server_is_refused_even_by_exact_name(self):
        for name in ("only_b", "beta/get_state"):
            found = self.registry.resolve_for_call(name, "alpha")
            self.assertIsNone(found.server, name)
            self.assertEqual(found.kind, "unknown_tool")
            self.assertIn("not available for the selected server", found.error)

    def test_an_ambiguous_bare_name_resolves_to_the_selected_server(self):
        found = self.registry.resolve_for_call("get_state", "beta")
        self.assertEqual((found.server.server_id, found.tool_name), ("beta", "get_state"))

    def test_a_selected_server_without_that_tool_cannot_use_an_ambiguous_name_it_lacks(self):
        found = self.registry.resolve_for_call("nope", "alpha")
        self.assertEqual((found.server, found.kind), (None, "unknown_tool"))
        self.assertIn("Unknown or unavailable", found.error)

    def test_a_dead_selected_server_runs_nothing(self):
        registry = fake_registry({"alpha": fake_server("alpha", ["x"], alive=False)})
        self.assertIsNone(registry.resolve_for_call("x", "alpha").server)

    def test_without_a_selection_the_plain_rules_apply(self):
        self.assertEqual(self.registry.resolve_for_call("only_b", None).server.server_id, "beta")
        self.assertIsNone(self.registry.resolve_for_call("get_state", None).server)


class LifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_start_stop_and_restart_with_real_processes(self):
        with temp_dir() as tmp:
            config = mock_config(tmp)
            registry = ServerRegistry(lambda i, c: real_server(i, c), lambda _m: None)
            await registry.start_all({"mock": config})
            try:
                self.assertEqual([t["name"] for t in registry.catalog], ["echo"])
                first_pid = registry.servers["mock"].process.pid
                await registry.restart({"mock": config})
                self.assertNotEqual(registry.servers["mock"].process.pid, first_pid)
                self.assertTrue(registry.any_alive)
            finally:
                await registry.stop_all()
            self.assertEqual((registry.servers, registry.catalog), ({}, []))

    async def test_revive_dead_restarts_only_dead_servers_and_reports_it(self):
        with temp_dir() as tmp:
            registry = ServerRegistry(lambda i, c: real_server(i, c), lambda _m: None)
            await registry.start_all({"mock": mock_config(tmp)})
            try:
                self.assertFalse(await registry.revive_dead())
                registry.servers["mock"].process.kill()
                await registry.servers["mock"].process.wait()
                self.assertTrue(await registry.revive_dead())
                self.assertTrue(registry.servers["mock"].alive)
                self.assertEqual([t["name"] for t in registry.catalog], ["echo"])
            finally:
                await registry.stop_all()


if __name__ == "__main__":
    unittest.main()
