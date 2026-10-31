"""Tests for the Python side. The packages under test live in server/, so put it on the import path once, here."""

import sys
from pathlib import Path

SERVER = Path(__file__).resolve().parent.parent / "server"
if str(SERVER) not in sys.path:
    sys.path.insert(0, str(SERVER))
