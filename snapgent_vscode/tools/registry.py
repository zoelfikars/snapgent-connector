"""The tool catalogue. Each tool is defined ONCE: schema, handler and risk together."""

import inspect
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional

from ..context import Context

# What a tool can do to the user's machine; the security policy decides per level.
READ = "read"            # observes the workspace
WRITE = "write"          # creates or changes files in the workspace
DESTRUCTIVE = "destructive"  # removes data
EXECUTE = "execute"      # runs processes
VCS = "vcs"              # changes git history/index


@dataclass(frozen=True)
class ToolDef:
    name: str
    description: str
    properties: Dict[str, Any]
    required: List[str]
    handler: Callable[..., Any]
    risk: str

    def schema(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "inputSchema": {"type": "object", "properties": self.properties, "required": self.required},
        }


_TOOLS: Dict[str, ToolDef] = {}


def tool(name: str, description: str, properties: Optional[Dict[str, Any]] = None,
         required: Optional[List[str]] = None, risk: str = READ):
    """Register `handler(ctx, **arguments)` as an MCP tool."""
    def register(handler: Callable[..., Any]) -> Callable[..., Any]:
        if name in _TOOLS:
            raise ValueError(f"Duplicate tool name: {name}")
        _TOOLS[name] = ToolDef(name, description, properties or {}, required or [], handler, risk)
        return handler
    return register


def get(name: str) -> ToolDef:
    definition = _TOOLS.get(name)
    if definition is None:
        raise ValueError(f"Unknown tool: {name}")
    return definition


def all_tools() -> List[ToolDef]:
    return list(_TOOLS.values())


def schemas() -> List[Dict[str, Any]]:
    return [definition.schema() for definition in _TOOLS.values()]


def call(ctx: Context, name: str, arguments: Dict[str, Any]) -> Any:
    """Run a tool. Unknown arguments are ignored (models add extras); missing required ones are named."""
    definition = get(name)
    missing = [key for key in definition.required if key not in arguments]
    if missing:
        raise ValueError(f"Missing required parameter(s) for {name}: {', '.join(missing)}")
    accepted = inspect.signature(definition.handler).parameters
    return definition.handler(ctx, **{key: value for key, value in arguments.items() if key in accepted})
