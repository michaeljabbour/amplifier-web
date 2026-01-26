"""
Web streaming hook implementation.

Implements a Hook that streams Amplifier events to the browser via WebSocket,
enabling real-time updates for content streaming, tool calls, and session events.

DESIGN: Pass through ALL raw event data unchanged (except image sanitization).
The frontend receives exactly what Amplifier emits for full debugging capability.
"""

from __future__ import annotations

import logging
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
    """

    # Hook metadata (for registration)
    name = "web-streaming"
    priority = 100  # Run early to capture events

    def __init__(self, websocket: "WebSocket", show_thinking: bool = True):
        """
        Initialize web streaming hook.

        Args:
            websocket: Connected WebSocket to browser
            show_thinking: Whether to stream thinking blocks
        """
        self._websocket = websocket
        self._show_thinking = show_thinking
        self._current_blocks: dict[int, str] = {}  # index -> block_type

    async def __call__(self, event: str, data: dict[str, Any]) -> HookResult:
        """
        Handle Amplifier event and stream to browser.

        Args:
            event: Event name (e.g., "content_block:start")
            data: Event data dict

        Returns:
            HookResult with action="continue"
        """
        try:
            message = self._map_event_to_message(event, data)
            if message:
                await self._websocket.send_json(message)
        except Exception as e:
            logger.warning(f"Failed to stream event {event}: {e}")

        # Always continue - streaming is observational
        return HookResult(action="continue")

    def _map_event_to_message(self, event: str, data: dict[str, Any]) -> dict[str, Any] | None:
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
            index = data.get("block_index") if data.get("block_index") is not None else data.get("index", 0)
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
            index = data.get("block_index") if data.get("block_index") is not None else data.get("index", 0)
            block_type = self._current_blocks.get(index, "text")

            # Skip thinking blocks if disabled
            if block_type == "thinking" and not self._show_thinking:
                return None

            # Extract delta text for UI convenience
            delta = data.get("delta", {})
            delta_text = delta.get("text", "") if isinstance(delta, dict) else str(delta)

            return {
                "type": "content_delta",
                "index": index,
                "delta": delta_text,
                "block_type": block_type,
                **sanitized,  # Include full raw data
            }

        elif event == "content_block:end":
            index = data.get("block_index") if data.get("block_index") is not None else data.get("index", 0)
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
            return {
                "type": "tool_call",
                "tool_name": data.get("tool_name", "unknown"),
                "tool_call_id": data.get("tool_call_id", ""),
                "arguments": data.get("tool_input") or data.get("arguments", {}),
                "status": "pending",
                **sanitized,  # Include full raw data
            }

        elif event == "tool:post":
            result = data.get("result", {})
            return {
                "type": "tool_result",
                "tool_name": data.get("tool_name", "unknown"),
                "tool_call_id": data.get("tool_call_id", ""),
                "output": result.get("output", "") if isinstance(result, dict) else str(result),
                "success": result.get("success", True) if isinstance(result, dict) else True,
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
                    sanitized["source"] = {"type": "base64", "data": "[image data omitted]"}
                    return sanitized
                # Check for base64 image source
                if val.get("type") == "base64" and "data" in val and len(str(val.get("data", ""))) > 1000:
                    return {"type": "base64", "data": "[image data omitted]"}
                return {k: sanitize_value(v) for k, v in val.items()}
            elif isinstance(val, list):
                return [sanitize_value(item) for item in val]
            else:
                return val

        return sanitize_value(data)
