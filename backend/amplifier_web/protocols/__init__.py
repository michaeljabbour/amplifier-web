"""Web protocol implementations for Amplifier."""

from .display import WebDisplaySystem
from .approval import WebApprovalSystem
from .write_approval_hook import (
    WriteApprovalHook,
    get_sensitive_directories,
    get_standard_user_directories,
)
from .hooks import WebStreamingHook
from .spawn import WebSpawnManager

__all__ = [
    "WebDisplaySystem",
    "WebApprovalSystem",
    "WebStreamingHook",
    "WebSpawnManager",
    "WriteApprovalHook",
    "get_standard_user_directories",
    "get_sensitive_directories",
]
