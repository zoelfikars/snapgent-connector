"""One MCP server process, spoken to over stdio JSON-RPC."""

import asyncio
import json
import os
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from .protocol import json_line
from .settings import MAX_LOG_CHARS, MCP_PROTOCOL_VERSION, MCP_STDOUT_LIMIT


class MCPServer:
    def __init__(self, server_id: str, config: Dict[str, Any], *, cwd: Path, client_version: str,
                 log: Callable[[str], None]) -> None:
        self.server_id = server_id
        self.config = config
        self._cwd = cwd
        self._client_version = client_version
        self._log = log
        self.process: Optional[asyncio.subprocess.Process] = None
        self.tools: List[Dict[str, Any]] = []
        self._next_id = 1
        self._pending: Dict[int, asyncio.Future] = {}
        self._write_lock_: Optional[asyncio.Lock] = None
        self._reader_task: Optional[asyncio.Task] = None
        self._stderr_task: Optional[asyncio.Task] = None
        self._start_lock_: Optional[asyncio.Lock] = None
        self.error: Optional[str] = None
        self.ready = False

    # Locks are made on first use, inside the running loop: Python 3.9 binds a Lock to the current loop when it is created.
    @property
    def _write_lock(self) -> asyncio.Lock:
        if self._write_lock_ is None:
            self._write_lock_ = asyncio.Lock()
        return self._write_lock_

    @property
    def _start_lock(self) -> asyncio.Lock:
        if self._start_lock_ is None:
            self._start_lock_ = asyncio.Lock()
        return self._start_lock_

    @property
    def alive(self) -> bool:
        # A dead reader means responses can never arrive, even if the process is still running.
        reader_dead = bool(self._reader_task and self._reader_task.done())
        return bool(self.process and self.process.returncode is None and not reader_dead)

    # ── lifecycle ──────────────────────────────────────────────────────────

    def _fail(self, message: str) -> bool:
        self.error = message
        self._log(f"[{self.server_id}] {message}")
        return False

    def _launch_spec(self):
        """(command, args, env) from the config, or an error message."""
        command = self.config.get("command")
        args = self.config.get("args", [])
        server_env = self.config.get("env", {})
        if not isinstance(command, str) or not command.strip():
            return "MCP server command is missing."
        if not isinstance(args, list) or not all(isinstance(arg, str) for arg in args):
            return "MCP server args must be an array of strings."
        if not isinstance(server_env, dict):
            return "MCP server env must be an object."
        env = os.environ.copy()
        env.update({str(key): str(value) for key, value in server_env.items()})
        return command, args, env

    async def start(self) -> bool:
        async with self._start_lock:
            if self.alive and self.ready:
                return True
            await self.stop()
            spec = self._launch_spec()
            if isinstance(spec, str):
                return self._fail(spec)
            command, args, env = spec
            try:
                self.process = await asyncio.create_subprocess_exec(
                    command, *args, cwd=str(self._cwd), env=env,
                    stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                    limit=MCP_STDOUT_LIMIT,
                )
            except (OSError, ValueError) as error:
                return self._fail(f"failed to launch: {error}")
            self.tools = []
            self.error = None
            self._reader_task = asyncio.create_task(self._read_stdout())
            self._stderr_task = asyncio.create_task(self._read_stderr())
            try:
                await self._handshake()
                self.ready = True
                self._log(f"[{self.server_id}] MCP server up ({len(self.tools)} tools advertised)")
                return True
            except (asyncio.TimeoutError, RuntimeError, OSError, ValueError) as error:
                self._fail(f"MCP startup failed: {error}")
                await self.stop()
                return False

    async def _handshake(self) -> None:
        await self._request(
            "initialize",
            {"protocolVersion": MCP_PROTOCOL_VERSION, "capabilities": {},
             "clientInfo": {"name": "snapgent-bridge", "version": self._client_version}},
            timeout=12,
        )
        await self._notify("notifications/initialized")
        result = await self._request("tools/list", {}, timeout=20)
        raw_tools = result.get("tools", []) if isinstance(result, dict) else []
        if not isinstance(raw_tools, list):
            raise RuntimeError("MCP tools/list returned an invalid tool list.")
        self.tools = [tool for tool in raw_tools if isinstance(tool, dict) and isinstance(tool.get("name"), str)]

    async def stop(self) -> None:
        process = self.process
        self.process = None
        self.tools = []
        self.ready = False
        tasks = [task for task in (self._reader_task, self._stderr_task) if task]
        for task in tasks:
            if not task.done():
                task.cancel()
        self._reader_task = None
        self._stderr_task = None
        self._fail_pending(f"{self.server_id} MCP server stopped.")
        self._pending.clear()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        if process and process.returncode is None:
            await self._terminate(process)

    @staticmethod
    async def _terminate(process: asyncio.subprocess.Process) -> None:
        """Close stdin and give the server a moment to exit, then terminate, then kill."""
        if process.stdin:
            try:
                process.stdin.close()
            except (BrokenPipeError, OSError):
                pass
        try:
            await asyncio.wait_for(process.wait(), timeout=2)
        except asyncio.TimeoutError:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=2)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()

    # ── JSON-RPC ───────────────────────────────────────────────────────────

    def _fail_pending(self, reason: str) -> None:
        for future in self._pending.values():
            if not future.done():
                future.set_exception(RuntimeError(reason))

    async def _send(self, payload: Dict[str, Any]) -> None:
        process = self.process
        if not process or process.returncode is not None or not process.stdin:
            raise RuntimeError(f"{self.server_id} MCP server is offline.")
        data = (json_line(payload) + "\n").encode("utf-8")
        async with self._write_lock:
            process.stdin.write(data)
            await process.stdin.drain()

    async def _request(self, method: str, params: Dict[str, Any], timeout: float = 30) -> Any:
        request_id = self._next_id
        self._next_id += 1
        future = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        try:
            await self._send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
            response = await asyncio.wait_for(future, timeout=timeout)
        finally:
            self._pending.pop(request_id, None)
        if "error" in response:
            detail = response["error"]
            raise RuntimeError(str(detail.get("message") or detail) if isinstance(detail, dict) else str(detail))
        return response.get("result")

    async def _notify(self, method: str, params: Optional[Dict[str, Any]] = None) -> None:
        await self._send({"jsonrpc": "2.0", "method": method, "params": params or {}})

    async def request(self, method: str, params: Dict[str, Any], timeout: float = 10) -> Any:
        """A request that is not a tool call (the bar's own questions to the server)."""
        if not self.alive:
            raise RuntimeError(self.error or f"{self.server_id} MCP server is offline.")
        return await self._request(method, params, timeout=timeout)

    async def call_tool(self, tool_name: str, arguments: Dict[str, Any], timeout: float) -> Dict[str, Any]:
        if not self.alive:
            raise RuntimeError(self.error or f"{self.server_id} MCP server is offline.")
        result = await self._request("tools/call", {"name": tool_name, "arguments": arguments}, timeout=timeout)
        return result if isinstance(result, dict) else {"content": [{"text": str(result)}]}

    # ── readers ────────────────────────────────────────────────────────────

    async def _read_stdout(self) -> None:
        process = self.process
        if not process or not process.stdout:
            return
        try:
            while True:
                line = await process.stdout.readline()
                if not line:
                    break
                try:
                    message = json.loads(line.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    self._log(f"[{self.server_id}] ignored non-JSON MCP stdout.")
                    continue
                request_id = message.get("id")
                if isinstance(request_id, int):
                    future = self._pending.get(request_id)
                    if future and not future.done():
                        future.set_result(message)
        except asyncio.CancelledError:
            raise
        except (ValueError, asyncio.LimitOverrunError) as error:
            self._log(f"[{self.server_id}] MCP stdout read failed: {error}")
        finally:
            # `stop()` clears self.process first, so this is a server that went away on its own. Fail the
            # in-flight requests NOW: waiting for their timeout made a server that crashes at startup
            # (bad path, misconfig) stall the bridge for the full 12 s handshake window.
            if self.process is process:
                self._log(f"[{self.server_id}] MCP stdout closed.")
                self._fail_pending(f"{self.server_id} MCP server disconnected.")

    async def _read_stderr(self) -> None:
        process = self.process
        if not process or not process.stderr:
            return
        # A chatty MCP server (or one stuck in a retry loop) used to flood the
        # log with one line per stderr frame. Cap the echoed lines per process and
        # summarise the rest; the full output is still in the server's own stream.
        logged = 0
        suppressed = 0
        max_lines = 50
        while True:
            line = await process.stderr.readline()
            if not line:
                break
            text = line.decode("utf-8", errors="replace").strip()
            if not text:
                continue
            if logged < max_lines:
                self._log(f"[{self.server_id}] stderr: {text[:200]}")
                logged += 1
            else:
                suppressed += 1
        if suppressed:
            self._log(f"[{self.server_id}] stderr: suppressed {suppressed} further line(s) (cap {max_lines}).")
