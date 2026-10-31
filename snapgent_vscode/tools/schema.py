"""JSON-schema fragments for tool parameters."""

from typing import Any, Dict, Optional

STR: Dict[str, Any] = {"type": "string"}
BOOL: Dict[str, Any] = {"type": "boolean"}
STR_LIST: Dict[str, Any] = {"type": "array", "items": STR}


def integer(minimum: Optional[int] = None, maximum: Optional[int] = None) -> Dict[str, Any]:
    schema: Dict[str, Any] = {"type": "integer"}
    if minimum is not None:
        schema["minimum"] = minimum
    if maximum is not None:
        schema["maximum"] = maximum
    return schema
