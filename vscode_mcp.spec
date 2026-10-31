# -*- mode: python ; coding: utf-8 -*-
# Build: pyinstaller --noconfirm vscode_mcp.spec   ->   dist/vscode_mcp (vscode_mcp.exe on Windows)
from PyInstaller.utils.hooks import collect_submodules

a = Analysis(
    ["vscode_mcp.py"],
    pathex=[],
    binaries=[],
    datas=[],
    hiddenimports=collect_submodules("snapgent_vscode"),
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
    name="vscode_mcp",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
