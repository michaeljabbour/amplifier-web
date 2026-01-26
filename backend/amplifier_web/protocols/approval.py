"""
Web approval system implementation.

Implements the ApprovalSystem protocol from amplifier-core,
handling user approvals via WebSocket with browser UI.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:
    from fastapi import WebSocket

logger = logging.getLogger(__name__)


class ApprovalTimeoutError(Exception):
    """Raised when user approval times out."""
    pass


class WebApprovalSystem:
    """
    WebSocket-based approval system for browser UI.

    Implements the ApprovalSystem protocol from amplifier-core.
    Sends approval requests to browser and waits for responses.

    Features:
    - Session-scoped caching for "Allow always" decisions
    - Timeout handling with configurable defaults
    - Async waiting for browser responses
    """

    def __init__(self, websocket: "WebSocket"):
        """
        Initialize web approval system.

        Args:
            websocket: Connected WebSocket to browser
        """
        self._websocket = websocket
        self._pending: dict[str, asyncio.Future[str]] = {}
        self._cache: dict[int, str] = {}  # Session-scoped approval cache

    async def request_approval(
        self,
        prompt: str,
        options: list[str],
        timeout: float = 300.0,
        default: Literal["allow", "deny"] = "deny"
    ) -> str:
        """
        Request user approval via WebSocket.

        Args:
            prompt: Question to ask user
            options: Available choices (e.g., ["Allow once", "Allow always", "Deny"])
            timeout: Seconds to wait for response (default 5 minutes)
            default: Action to take on timeout ("allow" or "deny")

        Returns:
            Selected option string (one of options)

        Raises:
            ApprovalTimeoutError: If configured to raise on timeout
        """
        # Check cache for "Allow always" decisions
        cache_key = hash((prompt, tuple(options)))
        if cache_key in self._cache:
            cached = self._cache[cache_key]
            logger.debug(f"Using cached approval: {cached}")
            return cached

        # Generate request ID and send to browser
        request_id = str(uuid.uuid4())
        try:
            await self._websocket.send_json({
                "type": "approval_request",
                "id": request_id,
                "prompt": prompt,
                "options": options,
                "timeout": timeout,
                "default": default
            })
        except Exception as e:
            logger.error(f"Failed to send approval request: {e}")
            # Return default on send failure
            return self._resolve_default(default, options)

        # Create future for response and wait with timeout
        future: asyncio.Future[str] = asyncio.get_event_loop().create_future()
        self._pending[request_id] = future

        try:
            choice = await asyncio.wait_for(future, timeout)

            # Cache "always" decisions
            if "always" in choice.lower():
                self._cache[cache_key] = choice
                logger.debug(f"Cached 'always' approval: {choice}")

            return choice

        except asyncio.TimeoutError:
            logger.warning(f"Approval timed out after {timeout}s, using default: {default}")
            # Notify browser of timeout
            try:
                await self._websocket.send_json({
                    "type": "approval_timeout",
                    "id": request_id,
                    "applied_default": default
                })
            except Exception:
                pass
            return self._resolve_default(default, options)

        finally:
            self._pending.pop(request_id, None)

    def handle_response(self, request_id: str, choice: str) -> bool:
        """
        Handle approval response from browser.

        Called by WebSocket handler when browser sends approval_response.

        Args:
            request_id: The approval request ID
            choice: The user's selected option

        Returns:
            True if response was handled, False if request not found
        """
        future = self._pending.get(request_id)
        if future and not future.done():
            future.set_result(choice)
            return True
        return False

    def _resolve_default(
        self,
        default: Literal["allow", "deny"],
        options: list[str]
    ) -> str:
        """
        Find the best matching option for the default action.

        Args:
            default: The default action ("allow" or "deny")
            options: Available options

        Returns:
            The option string that best matches the default
        """
        # Try to find option matching default
        for option in options:
            option_lower = option.lower()
            if default == "allow" and ("allow" in option_lower or "yes" in option_lower):
                return option
            if default == "deny" and ("deny" in option_lower or "no" in option_lower):
                return option

        # Fall back to last option (typically "deny") or first
        return options[-1] if default == "deny" else options[0]
