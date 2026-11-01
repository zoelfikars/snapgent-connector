"""A very small D-Bus client (session bus, little endian), just enough to ask the desktop portal for a folder.

Why not a command-line tool: the portal closes a request the moment the program that made it disconnects, and `gdbus call`
or `busctl call` disconnect as soon as they have their reply, so the dialog would be closed before it is seen. The program
that asks must stay connected until the answer arrives, and only a long-lived connection can do that. Standard library only.
"""

import os
import socket
import struct
import time
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import unquote, urlparse

METHOD_CALL, METHOD_RETURN, ERROR, SIGNAL = 1, 2, 3, 4
PATH, INTERFACE, MEMBER, ERROR_NAME, REPLY_SERIAL, DESTINATION, SENDER, SIGNATURE = 1, 2, 3, 4, 5, 6, 7, 8
ALIGNMENT = {"y": 1, "b": 4, "n": 2, "q": 2, "i": 4, "u": 4, "x": 8, "t": 8, "d": 8, "s": 4, "o": 4, "g": 1, "a": 4, "(": 8, "{": 8, "v": 1}
FIXED = {"y": "B", "n": "h", "q": "H", "i": "i", "u": "I", "x": "q", "t": "Q", "d": "d"}


class DBusError(RuntimeError):
    pass


# ── writing ────────────────────────────────────────────────────────────────

class Writer:
    def __init__(self, base: int = 0) -> None:
        self.data = bytearray()
        self.base = base  # offset of this buffer from the start of the message (alignment is relative to it)

    def pad(self, n: int) -> None:
        while (self.base + len(self.data)) % n:
            self.data.append(0)

    def u32(self, value: int) -> None:
        self.pad(4)
        self.data += struct.pack("<I", value)

    def string(self, text: str) -> None:
        raw = text.encode("utf-8")
        self.u32(len(raw))
        self.data += raw + b"\0"

    def signature(self, text: str) -> None:
        self.data.append(len(text))
        self.data += text.encode("ascii") + b"\0"

    def variant(self, value: Any) -> None:
        if isinstance(value, bool):
            self.signature("b")
            self.u32(1 if value else 0)
        elif isinstance(value, str):
            self.signature("s")
            self.string(value)
        else:
            raise DBusError(f"cannot send a {type(value).__name__}")

    def string_variant_dict(self, items: Dict[str, Any]) -> None:
        """a{sv}"""
        self.u32(0)  # the byte length, filled in below
        length_at = len(self.data) - 4
        self.pad(8)  # entries are aligned to 8; this first padding is not part of the length
        start = len(self.data)
        for key, value in items.items():
            self.pad(8)
            self.string(key)
            self.variant(value)
        struct.pack_into("<I", self.data, length_at, len(self.data) - start)


def encode_call(serial: int, path: str, interface: str, member: str, destination: str, signature: str = "", body: bytes = b"") -> bytes:
    fields = Writer(base=16)

    def field(code: int, kind: str, text: str) -> None:
        fields.pad(8)
        fields.data.append(code)
        fields.signature(kind)
        if kind == "g":
            fields.signature(text)
        else:
            fields.string(text)

    field(PATH, "o", path)
    field(INTERFACE, "s", interface)
    field(MEMBER, "s", member)
    field(DESTINATION, "s", destination)
    if signature:
        field(SIGNATURE, "g", signature)
    header = struct.pack("<BBBBII", ord("l"), METHOD_CALL, 0, 1, len(body), serial) + struct.pack("<I", len(fields.data)) + bytes(fields.data)
    header += b"\0" * (-len(header) % 8)
    return header + body


# ── reading ────────────────────────────────────────────────────────────────

class Reader:
    def __init__(self, data: bytes, pos: int = 0) -> None:
        self.data = data
        self.pos = pos

    def pad(self, n: int) -> None:
        self.pos += -self.pos % n

    def take(self, count: int) -> bytes:
        if self.pos + count > len(self.data):
            raise DBusError("message ended early")
        chunk = self.data[self.pos:self.pos + count]
        self.pos += count
        return chunk

    def fixed(self, code: str) -> Any:
        self.pad(ALIGNMENT[code])
        fmt = "<" + FIXED[code]
        return struct.unpack(fmt, self.take(struct.calcsize(fmt)))[0]

    def read(self, signature: str, i: int = 0) -> Tuple[Any, int]:
        """One value of the type starting at signature[i]; returns it and the index after the type."""
        code = signature[i]
        if code in FIXED:
            return self.fixed(code), i + 1
        if code == "b":
            return bool(self.fixed("u")), i + 1
        if code in "so":
            length = self.fixed("u")
            text = self.take(length).decode("utf-8", "replace")
            self.take(1)
            return text, i + 1
        if code == "g":
            length = self.take(1)[0]
            text = self.take(length).decode("ascii", "replace")
            self.take(1)
            return text, i + 1
        if code == "v":
            inner, _ = self.read("g")
            value, _ = self.read(inner)
            return {"type": inner, "data": value}, i + 1
        if code == "a":
            end = self._end_of_type(signature, i + 1)
            element = signature[i + 1:end]
            length = self.fixed("u")
            self.pad(ALIGNMENT[element[0]])
            stop = self.pos + length
            items = []
            while self.pos < stop:
                items.append(self.read(element)[0])
            return (dict(items) if element[0] == "{" else items), end
        if code in "({":
            end = self._end_of_type(signature, i)
            self.pad(8)
            members, j = [], i + 1
            while j < end - 1:
                value, j = self.read(signature, j)
                members.append(value)
            return (tuple(members) if code == "(" else (members[0], members[1])), end
        raise DBusError(f"unsupported type {code!r}")

    @staticmethod
    def _end_of_type(signature: str, i: int) -> int:
        """Index just after the complete type that starts at signature[i]."""
        code = signature[i]
        if code == "a":
            return Reader._end_of_type(signature, i + 1)
        if code in "({":
            close = ")" if code == "(" else "}"
            j = i + 1
            while signature[j] != close:
                j = Reader._end_of_type(signature, j)
            return j + 1
        return i + 1


def decode_message(data: bytes) -> Dict[str, Any]:
    """{type, serial, fields, body} of one complete message (see `read_message`)."""
    if data[:1] != b"l":
        raise DBusError("only little-endian messages are supported")
    kind, _flags, _version, body_length, serial = struct.unpack_from("<BBBII", data, 1)
    reader = Reader(data, 12)
    fields_raw, _ = reader.read("a(yv)")
    fields = {code: variant["data"] for code, variant in fields_raw}
    reader.pad(8)
    body = Reader(data[reader.pos:reader.pos + body_length])
    return {"type": kind, "serial": serial, "fields": fields, "body": body}


# ── the connection ─────────────────────────────────────────────────────────

def session_bus_path(env: Optional[Dict[str, str]] = None) -> str:
    env = os.environ if env is None else env
    address = env.get("DBUS_SESSION_BUS_ADDRESS") or f"unix:path=/run/user/{os.getuid()}/bus"
    for part in address.split(";")[0].replace("unix:", "", 1).split(","):
        key, _, value = part.partition("=")
        if key == "path":
            return value
        if key == "abstract":
            return "\0" + value
    raise DBusError(f"unsupported session bus address: {address}")


class Connection:
    def __init__(self, path: str) -> None:
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.serial = 0
        try:
            self.sock.connect(path)
            uid = str(os.getuid()).encode("ascii").hex().encode("ascii")
            self.sock.sendall(b"\0AUTH EXTERNAL " + uid + b"\r\n")
            if not self._line().startswith(b"OK"):
                raise DBusError("the session bus refused the connection")
            self.sock.sendall(b"BEGIN\r\n")
            self._buffer = bytearray()
        except (OSError, DBusError):
            self.sock.close()
            raise
        self.call("/org/freedesktop/DBus", "org.freedesktop.DBus", "org.freedesktop.DBus", "Hello")

    def _line(self) -> bytes:
        data = b""
        while not data.endswith(b"\r\n"):
            chunk = self.sock.recv(1)
            if not chunk:
                raise DBusError("the session bus closed the connection")
            data += chunk
        return data

    def close(self) -> None:
        try:
            self.sock.close()
        except OSError:
            pass

    def send(self, path: str, interface: str, destination: str, member: str, signature: str = "", body: bytes = b"") -> int:
        self.serial += 1
        self.sock.sendall(encode_call(self.serial, path, interface, member, destination, signature, body))
        return self.serial

    def _exactly(self, count: int) -> bytes:
        while len(self._buffer) < count:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise DBusError("the session bus closed the connection")
            self._buffer += chunk
        data, self._buffer = bytes(self._buffer[:count]), self._buffer[count:]
        return data

    def read_message(self) -> Dict[str, Any]:
        fixed = self._exactly(16)
        body_length, fields_length = struct.unpack_from("<II", fixed, 4)[0], struct.unpack_from("<I", fixed, 12)[0]
        header_end = 16 + fields_length
        rest = self._exactly(header_end + (-header_end % 8) - 16 + body_length)
        return decode_message(fixed + rest)

    def call(self, path: str, interface: str, destination: str, member: str, signature: str = "", body: bytes = b"") -> Dict[str, Any]:
        """Send a call and return its reply (messages that are not the reply are skipped)."""
        serial = self.send(path, interface, destination, member, signature, body)
        while True:
            message = self.read_message()
            if message["fields"].get(REPLY_SERIAL) == serial:
                if message["type"] == ERROR:
                    raise DBusError(message["fields"].get(ERROR_NAME, "D-Bus error"))
                return message


# ── the folder question ────────────────────────────────────────────────────

PORTAL = "org.freedesktop.portal.Desktop"


def ask_portal_for_folder(title: str, token: str, timeout: float, stop: Callable[[], bool] = lambda: False,
                          path: Optional[str] = None) -> Optional[str]:
    """The folder chosen in the portal's window, None when it was cancelled, or DBusError when the portal cannot be used.

    The connection stays open until the answer arrives: closing it would close the dialog."""
    connection = Connection(path or session_bus_path())
    try:
        body = Writer()
        body.string("")
        body.string(title)
        body.string_variant_dict({"directory": True, "handle_token": token})
        connection.call("/org/freedesktop/portal/desktop", "org.freedesktop.portal.FileChooser", PORTAL, "OpenFile", "ssa{sv}", bytes(body.data))
        deadline = time.monotonic() + timeout
        connection.sock.settimeout(1.0)
        while time.monotonic() < deadline and not stop():
            try:
                message = connection.read_message()
            except socket.timeout:
                continue
            fields = message["fields"]
            if message["type"] != SIGNAL or fields.get(MEMBER) != "Response" or not str(fields.get(PATH, "")).endswith("/" + token):
                continue
            reader = message["body"]
            code = reader.fixed("u")
            results, _ = reader.read("a{sv}")
            return folder_from_results(code, results)
        return None
    finally:
        connection.close()


def folder_from_results(code: int, results: Dict[str, Any]) -> Optional[str]:
    """A choice gives its folder; a cancel (code 1) or anything unreadable gives None."""
    uris = (results.get("uris") or {}).get("data") or []
    if code != 0 or not uris or not str(uris[0]).startswith("file://"):
        return None
    return unquote(urlparse(str(uris[0])).path)
