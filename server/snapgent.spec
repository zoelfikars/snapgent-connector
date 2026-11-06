# -*- mode: python ; coding: utf-8 -*-
# Build: pyinstaller --noconfirm snapgent.spec   ->   dist/snapgent (snapgent.exe on Windows)
# One program: the bridge, and (with --mcp) the Snapgent MCP server it starts.
from PyInstaller.utils.hooks import collect_submodules

a = Analysis(
    ["snapgent.py"],
    pathex=[],
    binaries=[],
    datas=[],
    # `websockets` loads parts of itself lazily; collect everything so the frozen bridge can serve.
    hiddenimports=collect_submodules("snapgent_bridge") + collect_submodules("snapgent_mcp") + collect_submodules("websockets"),
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="snapgent",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,  # UPX-packed executables are flagged by many antivirus products
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
