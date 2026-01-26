"""Web protocol implementations for Amplifier."""

from .display import WebDisplaySystem
from .approval import WebApprovalSystem
from .hooks import WebStreamingHook
from .spawn import WebSpawnManager

__all__ = ["WebDisplaySystem", "WebApprovalSystem", "WebStreamingHook", "WebSpawnManager"]
