"""
Web display system implementation.

Implements the DisplaySystem protocol from amplifier-core,
sending messages to the browser via WebSocket.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:
    from fastapi import WebSocket

logger = logging.getLogger(__name__)


class WebDisplaySystem:
    """
    WebSocket-based display system for browser UI.

    Implements the DisplaySystem protocol from amplifier-core.
    Sends display messages to the connected browser client.
    """

    def __init__(self, websocket: "WebSocket", nesting_depth: int = 0):
        """
        Initialize web display system.

        Args:
            websocket: Connected WebSocket to browser
            nesting_depth: Current nesting level for sub-sessions
        """
        self._websocket = websocket
        self._nesting_depth = nesting_depth

    async def show_message(
        self,
        message: str,
        level: Literal["info", "warning", "error"] = "info",
        source: str = "hook"
    ) -> None:
        """
        Display message to user via WebSocket.

        Args:
            message: Message text to display
            level: Severity level (info/warning/error)
            source: Message source (for context, e.g., hook name)
        """
        try:
            await self._websocket.send_json({
                "type": "display_message",
                "level": level,
                "message": message,
                "source": source,
                "nesting": self._nesting_depth
            })
        except Exception as e:
            logger.warning(f"Failed to send display message: {e}")

    def push_nesting(self) -> "WebDisplaySystem":
        """
        Create a nested display system for sub-sessions.

        Returns:
            New WebDisplaySystem with incremented nesting depth
        """
        return WebDisplaySystem(
            websocket=self._websocket,
            nesting_depth=self._nesting_depth + 1
        )

    def pop_nesting(self) -> "WebDisplaySystem":
        """
        Create a display system with reduced nesting.

        Returns:
            New WebDisplaySystem with decremented nesting depth
        """
        return WebDisplaySystem(
            websocket=self._websocket,
            nesting_depth=max(0, self._nesting_depth - 1)
        )

    @property
    def nesting_depth(self) -> int:
        """Current nesting depth for visual hierarchy."""
        return self._nesting_depth
