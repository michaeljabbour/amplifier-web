"""
Web streaming hook implementation.

Implements a Hook that streams Amplifier events to the browser via WebSocket,
enabling real-time updates for content streaming, tool calls, and session events.

DESIGN: Pass through ALL raw event data unchanged (except image sanitization).
The frontend receives exactly what Amplifier emits for full debugging capability.
"""

from __future__ import annotations

import difflib
import logging
from pathlib import Path
from typing import TYPE_CHECKING, Any

from amplifier_core.models import HookResult

if TYPE_CHECKING:
    from fastapi import WebSocket

logger = logging.getLogger(__name__)


class WebStreamingHook:
    """
    WebSocket-based streaming hook for browser UI.

    Subscribes to Amplifier events and forwards them to the browser
    for real-time display of streaming content, tool calls, and status.

    All events pass through raw data unchanged (only images sanitized).
    Also tracks file artifacts (write_file, edit_file operations).
    """

    # Hook metadata (for registration)
    name = "web-streaming"
    priority = 100  # Run early to capture events

    # Tools that create file artifacts
    FILE_TOOLS = {"write_file", "edit_file", "bash"}

    def __init__(
        self,
        websocket: "WebSocket",
        show_thinking: bool = True,
        session_id: str | None = None,
    ):
        """
        Initialize web streaming hook.

        Args:
            websocket: Connected WebSocket to browser
            show_thinking: Whether to stream thinking blocks
            session_id: Session ID for artifact tracking
        """
        self._websocket = websocket
        self._show_thinking = show_thinking
        self._session_id = session_id
        self._current_blocks: dict[int, str] = {}  # index -> block_type
        self._pending_file_ops: dict[str, dict] = {}  # tool_call_id -> tool info

    async def __call__(self, event: str, data: dict[str, Any]) -> HookResult:
        """
        Handle Amplifier event and stream to browser.

        Args:
            event: Event name (e.g., "content_block:start")
            data: Event data dict

        Returns:
            HookResult with action="continue"
        """
        # Log all events for debugging (helps identify what's being emitted)
        # Using INFO level temporarily to diagnose missing events
        logger.info(f"[EVENT] {event}: {list(data.keys()) if data else 'no data'}")

        try:
            message = self._map_event_to_message(event, data)
            if message:
                await self._websocket.send_json(message)
                logger.info(f"[SENT] {message.get('type', event)}")
        except Exception as e:
            logger.warning(f"Failed to stream event {event}: {e}")

        # Always continue - streaming is observational
        return HookResult(action="continue")

    def _map_event_to_message(
        self, event: str, data: dict[str, Any]
    ) -> dict[str, Any] | None:
        """
        Map Amplifier event to WebSocket message format.

        ALWAYS passes through full raw data. Only adds minimal required fields
        for UI functionality. Images are sanitized to avoid huge payloads.

        Args:
            event: Event name
            data: Event data

        Returns:
            WebSocket message dict or None if event should be skipped
        """
        # Sanitize to remove only image binary data
        sanitized = self._sanitize_for_ws(data)

        # Convert event name to WebSocket message type
        # e.g., "content_block:start" -> "content_start", "llm:request:raw" -> "llm_request_raw"
        ws_type = event.replace(":", "_").replace("_block", "")

        # Content streaming events - need index tracking for UI
        if event == "content_block:start":
            block_type = data.get("block_type") or data.get("type", "text")
            raw_index = (
                data.get("block_index")
                if data.get("block_index") is not None
                else data.get("index")
            )
            index: int = int(raw_index) if raw_index is not None else 0
            self._current_blocks[index] = block_type

            # Skip thinking blocks if disabled
            if block_type == "thinking" and not self._show_thinking:
                return None

            return {
                "type": "content_start",
                "block_type": block_type,
                "index": index,
                **sanitized,  # Include full raw data
            }

        elif event == "content_block:delta":
            raw_index = (
                data.get("block_index")
                if data.get("block_index") is not None
                else data.get("index")
            )
            index: int = int(raw_index) if raw_index is not None else 0
            block_type = self._current_blocks.get(index, "text")

            # Skip thinking blocks if disabled
            if block_type == "thinking" and not self._show_thinking:
                return None

            # Extract delta text for UI convenience
            delta = data.get("delta", {})
            delta_text = (
                delta.get("text", "") if isinstance(delta, dict) else str(delta)
            )

            return {
                "type": "content_delta",
                "index": index,
                "delta": delta_text,
                "block_type": block_type,
                **sanitized,  # Include full raw data
            }

        elif event == "content_block:end":
            raw_index = (
                data.get("block_index")
                if data.get("block_index") is not None
                else data.get("index")
            )
            index: int = int(raw_index) if raw_index is not None else 0
            block_type = self._current_blocks.pop(index, "text")

            # Skip thinking blocks if disabled
            if block_type == "thinking" and not self._show_thinking:
                return None

            # Extract content for UI convenience
            block = data.get("block", {})
            if isinstance(block, dict):
                content = block.get("text", "") or block.get("content", "")
            else:
                content = data.get("content", "")

            return {
                "type": "content_end",
                "index": index,
                "content": content,
                "block_type": block_type,
                **sanitized,  # Include full raw data
            }

        # Thinking events
        elif event == "thinking:delta":
            if not self._show_thinking:
                return None
            return {
                "type": "thinking_delta",
                **sanitized,
            }

        elif event == "thinking:final":
            if not self._show_thinking:
                return None
            return {
                "type": "thinking_final",
                **sanitized,
            }

        # Tool lifecycle - add convenience fields for UI
        elif event == "tool:pre":
            tool_name = data.get("tool_name", "unknown")
            tool_call_id = data.get("tool_call_id", "")
            arguments = data.get("tool_input") or data.get("arguments", {})

            # Track file operations for artifact recording
            if tool_name in self.FILE_TOOLS:
                file_path = arguments.get("file_path")
                content_before = None

                # Capture file content before the operation
                if file_path and tool_name in {"write_file", "edit_file"}:
                    try:
                        path = Path(file_path).expanduser()
                        if path.exists():
                            content_before = path.read_text(encoding="utf-8")
                    except Exception as e:
                        logger.debug(f"Could not read file before edit: {e}")

                self._pending_file_ops[tool_call_id] = {
                    "tool_name": tool_name,
                    "arguments": arguments,
                    "content_before": content_before,
                }

            return {
                "type": "tool_call",
                "tool_name": tool_name,
                "tool_call_id": tool_call_id,
                "arguments": arguments,
                "status": "pending",
                **sanitized,  # Include full raw data
            }

        elif event == "tool:post":
            tool_name = data.get("tool_name", "unknown")
            tool_call_id = data.get("tool_call_id", "")
            result = data.get("result", {})

            # Record file artifact if this was a file operation
            if tool_call_id in self._pending_file_ops:
                self._record_artifact(tool_call_id, tool_name, result)
                del self._pending_file_ops[tool_call_id]

            return {
                "type": "tool_result",
                "tool_name": tool_name,
                "tool_call_id": tool_call_id,
                "output": result.get("output", "")
                if isinstance(result, dict)
                else str(result),
                "success": result.get("success", True)
                if isinstance(result, dict)
                else True,
                "error": result.get("error") if isinstance(result, dict) else None,
                **sanitized,  # Include full raw data
            }

        elif event == "tool:error":
            return {
                "type": "tool_error",
                **sanitized,
            }

        # Session lifecycle
        elif event == "session:fork":
            return {
                "type": "session_fork",
                **sanitized,
            }

        # User notifications - map to display_message for UI
        elif event == "user:notification":
            return {
                "type": "display_message",
                **sanitized,
            }

        # All other events - pass through with raw data
        else:
            return {
                "type": ws_type,
                "event": event,  # Keep original event name for reference
                **sanitized,
            }

    def set_show_thinking(self, show: bool) -> None:
        """Toggle thinking block display."""
        self._show_thinking = show

    def set_session_id(self, session_id: str) -> None:
        """Set session ID for artifact tracking."""
        self._session_id = session_id

    def _record_artifact(
        self, tool_call_id: str, tool_name: str, result: dict[str, Any]
    ) -> None:
        """Record a file artifact from a tool operation."""
        if not self._session_id:
            return

        try:
            from ..database import get_database

            db = get_database()
            pending = self._pending_file_ops.get(tool_call_id, {})
            args = pending.get("arguments", {})
            content_before = pending.get("content_before")

            # Extract file path and operation details
            file_path = None
            operation = "edit"
            content_after = None
            diff = None

            if tool_name == "write_file":
                file_path = args.get("file_path")
                operation = "create" if content_before is None else "edit"
                content_after = args.get("content")

                # Generate unified diff
                diff = self._generate_unified_diff(
                    content_before or "",
                    content_after or "",
                    file_path or "file",
                )

            elif tool_name == "edit_file":
                file_path = args.get("file_path")
                operation = "edit"
                old_string = args.get("old_string", "")
                new_string = args.get("new_string", "")

                # Read the file after the edit to get full content
                if file_path:
                    try:
                        path = Path(file_path).expanduser()
                        if path.exists():
                            content_after = path.read_text(encoding="utf-8")
                    except Exception as e:
                        logger.debug(f"Could not read file after edit: {e}")

                # Generate unified diff from before/after content
                if content_before is not None and content_after is not None:
                    diff = self._generate_unified_diff(
                        content_before,
                        content_after,
                        file_path or "file",
                    )
                else:
                    # Fallback: simple diff from old/new strings
                    diff = self._generate_unified_diff(
                        old_string,
                        new_string,
                        file_path or "file",
                    )

            elif tool_name == "bash":
                # Check if bash command modified files
                cmd = args.get("command", "")
                if any(
                    op in cmd for op in ["cat >", "echo >", "tee ", "sed -i", "mv "]
                ):
                    operation = "bash"
                    # Try to extract file path from command
                    for part in cmd.split():
                        if "/" in part and not part.startswith("-"):
                            file_path = part
                            break

            if file_path:
                db.add_artifact(
                    session_id=self._session_id,
                    file_path=file_path,
                    operation=operation,
                    content_before=content_before,
                    content_after=content_after,
                    diff=diff,
                )
                logger.info(f"Recorded artifact: {operation} {file_path}")
        except Exception as e:
            logger.warning(f"Failed to record artifact: {e}")

    def _generate_unified_diff(
        self, content_before: str, content_after: str, file_path: str
    ) -> str:
        """Generate a unified diff between two file contents."""
        before_lines = content_before.splitlines(keepends=True)
        after_lines = content_after.splitlines(keepends=True)

        # Ensure lines end with newline for proper diff
        if before_lines and not before_lines[-1].endswith("\n"):
            before_lines[-1] += "\n"
        if after_lines and not after_lines[-1].endswith("\n"):
            after_lines[-1] += "\n"

        diff_lines = difflib.unified_diff(
            before_lines,
            after_lines,
            fromfile=f"a/{file_path}",
            tofile=f"b/{file_path}",
            lineterm="",
        )

        return "".join(diff_lines)

    def _sanitize_for_ws(self, data: dict[str, Any]) -> dict[str, Any]:
        """
        Sanitize data for WebSocket transmission.

        Only removes large binary data (images) to avoid huge payloads.
        All other data is passed through unchanged for full debugging.
        """

        def sanitize_value(val: Any) -> Any:
            if isinstance(val, dict):
                # Check for image source pattern
                if val.get("type") == "image" and "source" in val:
                    sanitized = dict(val)
                    sanitized["source"] = {
                        "type": "base64",
                        "data": "[image data omitted]",
                    }
                    return sanitized
                # Check for base64 image source
                if (
                    val.get("type") == "base64"
                    and "data" in val
                    and len(str(val.get("data", ""))) > 1000
                ):
                    return {"type": "base64", "data": "[image data omitted]"}
                return {k: sanitize_value(v) for k, v in val.items()}
            elif isinstance(val, list):
                return [sanitize_value(item) for item in val]
            else:
                return val

        return sanitize_value(data)
