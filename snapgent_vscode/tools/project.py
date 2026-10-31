"""Questions about the workspace as a whole."""

import json
from typing import Any, Dict

from ..context import Context
from ..paths import relative
from .registry import READ, tool

MANIFEST_PATTERNS = ("package.json", "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml", "*.sln")


@tool("get_workspace_info", "Get the active VS Code workspace name, path, and Git status.", risk=READ)
def get_workspace_info(ctx: Context) -> Dict[str, Any]:
    return {
        "name": ctx.root.name,
        "path": str(ctx.root),
        "is_git_repository": (ctx.root / ".git").exists(),
        "policy": ctx.policy.mode,
    }


@tool("get_project_info", "Inspect common project manifests and package scripts.", risk=READ)
def get_project_info(ctx: Context) -> Dict[str, Any]:
    info: Dict[str, Any] = {"workspace": ctx.root.name, "manifests": []}
    for pattern in MANIFEST_PATTERNS:
        for candidate in sorted(ctx.root.glob(pattern))[:10]:
            entry: Dict[str, Any] = {"path": relative(candidate, ctx.root)}
            if candidate.name == "package.json":
                try:
                    package = json.loads(candidate.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError) as error:
                    entry["error"] = str(error)
                else:
                    entry["name"] = package.get("name")
                    entry["scripts"] = package.get("scripts", {})
            info["manifests"].append(entry)
    return info
