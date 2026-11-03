"""The Windows side of freeing the bridge port: reading what `netstat` and `tasklist` say."""

import unittest

from snapgent_bridge import launcher

NETSTAT = """
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1032
  TCP    127.0.0.1:17613        0.0.0.0:0              LISTENING       4321
  TCP    127.0.0.1:17613        127.0.0.1:50711        ESTABLISHED     4321
  TCP    127.0.0.1:176130       0.0.0.0:0              LISTENING       999
  TCP    [::1]:17613            [::]:0                 LISTENING       8765
  UDP    0.0.0.0:17613          *:*                                    77
"""


class WindowsOutputTests(unittest.TestCase):
    def test_only_the_programs_listening_on_exactly_that_port_are_found(self):
        self.assertEqual(launcher.parse_netstat_listeners(NETSTAT, 17613), [4321, 8765])

    def test_nothing_listening_or_nothing_said(self):
        self.assertEqual(launcher.parse_netstat_listeners(NETSTAT, 9), [])
        self.assertEqual(launcher.parse_netstat_listeners("", 17613), [])

    def test_the_program_name_comes_from_the_first_csv_field_in_lower_case(self):
        self.assertEqual(launcher.windows_image_name('"Snapgent.exe","4321","Console","1","31,000 K"\r\n'), "snapgent.exe")
        self.assertEqual(launcher.windows_image_name('"python.exe","12","Console","1","9 K"'), "python.exe")
        self.assertEqual(launcher.windows_image_name("INFO: No tasks are running which match the specified criteria."), "info: no tasks are running which match the specified criteria.")
        self.assertEqual(launcher.windows_image_name(""), "")


if __name__ == "__main__":
    unittest.main()
