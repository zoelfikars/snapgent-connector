"""Runs `python3 snapgent.py` the way a clone is run on Linux and macOS."""

import asyncio
import json
import os
import signal
import socket
import subprocess
import sys
import unittest
from pathlib import Path

try:
    import websockets
except ImportError:
    websockets = None

ROOT = Path(__file__).resolve().parent.parent / "server"


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipIf(websockets is None or sys.platform == "win32", "needs websockets and POSIX signals")
class EntryPointTests(unittest.IsolatedAsyncioTestCase):
    async def test_snapgent_py_serves_extensions_rejects_pages_and_stops_cleanly(self):
        port = free_port()
        env = {**os.environ, "ZS_BRIDGE_PORT": str(port), "ZS_ALLOWED_ORIGINS": "moz-extension://abc-123"}
        process = subprocess.Popen([sys.executable, "snapgent.py"], cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        try:
            client = None
            for _ in range(100):
                try:
                    client = await websockets.connect(f"ws://127.0.0.1:{port}", origin="moz-extension://abc-123")
                    break
                except OSError:
                    await asyncio.sleep(0.1)
            self.assertIsNotNone(client, "bridge did not start listening")
            async with client:
                connected = json.loads(await asyncio.wait_for(client.recv(), 5))
                self.assertEqual(connected["type"], "connected")
                self.assertRegex(connected["bridge_version"], r"^\d+\.\d+\.\d+$")
            async with websockets.connect(f"ws://127.0.0.1:{port}", origin="moz-extension://another-extension") as other:
                with self.assertRaises(websockets.ConnectionClosed) as stranger:
                    await asyncio.wait_for(other.recv(), 5)
                self.assertEqual(stranger.exception.rcvd.code, 1008, "an extension that is not the pinned one")
            async with websockets.connect(f"ws://127.0.0.1:{port}", origin="https://evil.example") as page:
                with self.assertRaises(websockets.ConnectionClosed) as caught:
                    await asyncio.wait_for(page.recv(), 5)
                self.assertEqual(caught.exception.rcvd.code, 1008)
        finally:
            process.send_signal(signal.SIGTERM)
            try:
                output, _ = process.communicate(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                output, _ = process.communicate()
                self.fail("bridge ignored SIGTERM")
        self.assertEqual(process.returncode, 0, output)
        self.assertIn("bridge stopped", output)
        self.assertIn(f"Listening on ws://127.0.0.1:{port}", output)


if __name__ == "__main__":
    unittest.main()
