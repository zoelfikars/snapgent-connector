"""config.json: which MCP servers the bridge runs. Validation is pure; the store does the file I/O."""

import json
import re
from pathlib import Path
from typing import Any, Dict, List

SERVER_ID_RE = re.compile(r"[A-Za-z0-9._-]{1,64}")
PROTECTED_SERVER_ID = "snapgent"  # the default target cannot be removed
LEGACY_SERVER_ID = "vscode"  # its name in older versions: protected too, until the launcher renames it


class ConfigError(RuntimeError):
    """The config file or a requested change is not acceptable; the message is shown to the user."""


def valid_server_id(server_id: Any) -> bool:
    return isinstance(server_id, str) and SERVER_ID_RE.fullmatch(server_id) is not None


def build_server_spec(command: Any, args: Any, env: Any) -> Dict[str, Any]:
    """Validate a user-supplied server definition and return the canonical stored form."""
    if not isinstance(command, str) or not command.strip():
        raise ConfigError("MCP server command is required.")
    args = [] if args is None else args
    env = {} if env is None else env
    if not isinstance(args, list) or not all(isinstance(arg, str) for arg in args):
        raise ConfigError("MCP server args must be an array of strings.")
    if not isinstance(env, dict) or not all(isinstance(key, str) for key in env):
        raise ConfigError("MCP server env must be an object.")
    return {"command": command, "args": args, "env": env}


def usable_servers(config: Any, filename: str = "config.json") -> Dict[str, Dict[str, Any]]:
    """The well-formed server entries of a parsed config."""
    servers = config.get("mcpServers") if isinstance(config, dict) else None
    if not isinstance(servers, dict):
        raise ConfigError(f"{filename} must contain an object named mcpServers.")
    return {
        server_id: value
        for server_id, value in servers.items()
        if valid_server_id(server_id) and isinstance(value, dict)
    }


class ConfigStore:
    def __init__(self, path: Path) -> None:
        self._path = path

    def _read(self) -> Dict[str, Any]:
        if not self._path.exists():
            return {}
        try:
            return json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise ConfigError(f"Could not read {self._path.name}: {error}") from error

    def load_servers(self) -> Dict[str, Dict[str, Any]]:
        if not self._path.exists():
            return {}
        return usable_servers(self._read(), self._path.name)

    def server_ids(self) -> List[str]:
        return list(self.load_servers())

    def add_server(self, server_id: Any, command: Any, args: Any, env: Any) -> None:
        if not valid_server_id(server_id):
            raise ConfigError("Invalid MCP server id.")
        spec = build_server_spec(command, args, env)
        self._mutate(lambda servers: servers.__setitem__(server_id, spec))

    def remove_server(self, server_id: Any) -> None:
        if not valid_server_id(server_id):
            raise ConfigError("Invalid MCP server id.")
        if server_id in (PROTECTED_SERVER_ID, LEGACY_SERVER_ID):
            raise ConfigError("The Snapgent MCP server cannot be removed.")
        self._mutate(lambda servers: servers.pop(server_id, None))

    def _mutate(self, change) -> None:
        config = self._read()
        servers = config.setdefault("mcpServers", {})
        if not isinstance(servers, dict):
            raise ConfigError("mcpServers must be a JSON object.")
        change(servers)
        # Write atomically so a crash mid-write never leaves a half-written config.
        temp = self._path.with_suffix(".json.tmp")
        temp.write_text(json.dumps(config, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        temp.replace(self._path)
