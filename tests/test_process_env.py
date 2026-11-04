import os
import sys
import unittest
from unittest import mock

from snapgent_vscode.process import child_environment


class ChildEnvironmentTests(unittest.TestCase):
    def test_a_clone_passes_the_environment_on_as_it_is(self):
        with mock.patch.dict(os.environ, {"LD_LIBRARY_PATH": "/x"}, clear=False), mock.patch.object(sys, "frozen", False, create=True):
            self.assertEqual(child_environment()["LD_LIBRARY_PATH"], "/x")

    def test_the_built_program_gives_children_the_users_own_library_path_back(self):
        env = {"LD_LIBRARY_PATH": "/tmp/_MEI1234:/usr/lib", "LD_LIBRARY_PATH_ORIG": "/usr/lib", "PATH": "/bin"}
        with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(sys, "frozen", True, create=True):
            result = child_environment()
        self.assertEqual(result["LD_LIBRARY_PATH"], "/usr/lib")
        self.assertNotIn("LD_LIBRARY_PATH_ORIG", result)
        self.assertEqual(result["PATH"], "/bin")

    def test_without_an_original_the_bundle_path_is_removed(self):
        with mock.patch.dict(os.environ, {"LD_LIBRARY_PATH": "/tmp/_MEI1234"}, clear=True), mock.patch.object(sys, "frozen", True, create=True):
            self.assertNotIn("LD_LIBRARY_PATH", child_environment())


if __name__ == "__main__":
    unittest.main()
