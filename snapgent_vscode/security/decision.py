"""The one place that answers: may this tool call run, must the user approve it, or is it refused?

Pure: it looks at the policy, the tool's risk level, the arguments and the session, and returns a
verdict with a human-readable description. It never performs the action.
"""

from dataclasses import dataclass
from typing import Any, Dict, List

from .. import risk
from . import commands, files
from .confirmation import RESERVED_ARGUMENT
from .modes import READONLY, TRUSTED, Policy
from .session import SessionState

ALLOW, CONFIRM, DENY = "allow", "confirm", "deny"
# Tools that return file CONTENT, which would be sent to a third-party website.
CONTENT_TOOLS = frozenset({"read_file", "read_files", "read_file_lines", "get_file_outline", "git_diff"})
SCRIPT_TOOLS = frozenset({"run_project_script", "run_tests"})


@dataclass(frozen=True)
class Decision:
    verdict: str
    reason: str = ""       # why it is refused / what the user is asked to approve

    @property
    def allowed(self) -> bool:
        return self.verdict == ALLOW


_ALLOW = Decision(ALLOW)


def paths_in(arguments: Dict[str, Any]) -> List[str]:
    """Every workspace path an argument set refers to."""
    found: List[str] = []
    for key in ("path", "source", "destination"):
        if isinstance(arguments.get(key), str):
            found.append(arguments[key])
    if isinstance(arguments.get("paths"), list):
        found.extend(item for item in arguments["paths"] if isinstance(item, str))
    return found


def _deny(reason: str) -> Decision:
    return Decision(DENY, reason)


def _ask(description: str) -> Decision:
    return Decision(CONFIRM, description)


def _hard_rules(tool_risk: str, paths: List[str]) -> Decision:
    """Refused in every mode: hooks and config under .git run code or redirect git."""
    if tool_risk in (risk.WRITE, risk.DESTRUCTIVE) and any(files.touches_git_directory(p) for p in paths):
        return _deny("Changing anything inside .git is not allowed.")
    return _ALLOW


def _standard(name: str, tool_risk: str, arguments: Dict[str, Any], paths: List[str], policy: Policy, session: SessionState) -> Decision:
    if tool_risk == risk.READ:
        if name in CONTENT_TOOLS:
            sensitive = next((p for p in paths if files.is_sensitive(p)), None)
            if sensitive:
                return _ask(f"Read a file that may contain secrets (it would be sent to the chat site): {sensitive}")
        return _ALLOW
    if tool_risk == risk.WRITE:
        return _ALLOW
    if tool_risk == risk.DESTRUCTIVE:
        return _ask(f"Delete file: {paths[0] if paths else '(unknown)'}")
    if tool_risk == risk.VCS:
        if name == "git_commit":
            return _ask(f'Create a git commit: "{str(arguments.get("message", ""))[:200]}"')
        return _ALLOW
    if tool_risk == risk.EXECUTE:
        if name == "run_command":
            command, args = str(arguments.get("command", "")), [str(a) for a in arguments.get("args") or []]
            if commands.is_harmless(command, args, policy.extra_commands):
                return _ALLOW
            return _ask(f"Run command: {commands.describe(command, args)}")
        if name in SCRIPT_TOOLS and session.changed_execution_configs:
            changed = ", ".join(session.changed_execution_configs[:5])
            return _ask(f"Run the project's {arguments.get('script', 'test')} script. The agent changed {changed} in this session, so the script may not be the one you wrote.")
    return _ALLOW


def decide(policy: Policy, name: str, tool_risk: str, arguments: Dict[str, Any], session: SessionState) -> Decision:
    arguments = {key: value for key, value in arguments.items() if key != RESERVED_ARGUMENT}
    paths = paths_in(arguments)
    hard = _hard_rules(tool_risk, paths)
    if not hard.allowed:
        return hard
    if policy.mode == READONLY and tool_risk != risk.READ:
        return _deny(f"The server runs in read-only mode, so '{name}' is not allowed.")
    if policy.mode == TRUSTED:
        return _ALLOW
    return _standard(name, tool_risk, arguments, paths, policy, session)
