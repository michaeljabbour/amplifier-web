"""
Write approval hook - requests user permission for writes outside standard directories.

Instead of just denying writes, this hook:
1. Allows writes to standard user directories (Downloads, Documents, Desktop, CWD)
2. For other locations, asks the user for permission via the approval system
3. Remembers "Allow always" decisions for the session
"""

from __future__ import annotations

import logging
import platform
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .approval import WebApprovalSystem

logger = logging.getLogger(__name__)


def get_standard_user_directories() -> list[Path]:
    """
    Get standard user directories that should be writable by default.
    Cross-platform: works on macOS, Windows, and Linux.
    """
    home = Path.home()

    # Standard user directories (cross-platform names)
    standard_dirs = [
        home / "Downloads",
        home / "Documents",
        home / "Desktop",
    ]

    # Platform-specific variations
    system = platform.system()

    if system == "Darwin":  # macOS
        # macOS uses these exact names
        pass
    elif system == "Windows":
        # Windows may have localized names, but the English names usually work
        # Also check for OneDrive redirected folders
        onedrive = home / "OneDrive"
        if onedrive.exists():
            standard_dirs.extend(
                [
                    onedrive / "Downloads",
                    onedrive / "Documents",
                    onedrive / "Desktop",
                ]
            )
    elif system == "Linux":
        # XDG directories (if different from standard)
        import os

        xdg_download = os.environ.get("XDG_DOWNLOAD_DIR")
        xdg_documents = os.environ.get("XDG_DOCUMENTS_DIR")
        if xdg_download:
            standard_dirs.append(Path(xdg_download))
        if xdg_documents:
            standard_dirs.append(Path(xdg_documents))

    # Filter to only existing directories
    return [d for d in standard_dirs if d.exists()]


def get_sensitive_directories() -> list[Path]:
    """
    Get directories that should NEVER be writable (even with approval).
    These are system-critical or security-sensitive.
    """
    home = Path.home()
    system = platform.system()

    sensitive = [
        # Security-sensitive user directories
        home / ".ssh",
        home / ".gnupg",
        home / ".aws",
        home / ".azure",
        home / ".kube",
    ]

    if system == "Darwin":  # macOS
        sensitive.extend(
            [
                Path("/System"),
                Path("/Library"),
                home / "Library",
                Path("/etc"),
                Path("/var"),
                Path("/usr"),
                Path("/bin"),
                Path("/sbin"),
            ]
        )
    elif system == "Windows":
        sensitive.extend(
            [
                Path("C:/Windows"),
                Path("C:/Program Files"),
                Path("C:/Program Files (x86)"),
            ]
        )
    elif system == "Linux":
        sensitive.extend(
            [
                Path("/etc"),
                Path("/var"),
                Path("/usr"),
                Path("/bin"),
                Path("/sbin"),
                Path("/boot"),
                Path("/root"),
            ]
        )

    return sensitive


class WriteApprovalHook:
    """
    Hook that intercepts write operations and requests user approval
    for writes outside standard directories.

    This provides a better UX than just denying - users stay in control.
    """

    name = "write-approval"

    def __init__(self, approval_system: "WebApprovalSystem", cwd: Path | None = None):
        """
        Initialize the write approval hook.

        Args:
            approval_system: The web approval system for requesting user permission
            cwd: Current working directory (always allowed)
        """
        self.approval = approval_system
        self.cwd = cwd or Path.cwd()

        # Build allowed paths list
        self.allowed_paths = get_standard_user_directories()
        self.allowed_paths.append(self.cwd)

        # Sensitive paths that are never allowed
        self.sensitive_paths = get_sensitive_directories()

        # Cache for paths user has approved this session
        self._approved_paths: set[str] = set()

        logger.info(
            f"WriteApprovalHook initialized with {len(self.allowed_paths)} allowed paths"
        )

    def _is_path_allowed(self, path: Path) -> bool:
        """Check if path is within allowed directories."""
        resolved = path.resolve()

        for allowed in self.allowed_paths:
            try:
                resolved.relative_to(allowed.resolve())
                return True
            except ValueError:
                continue

        return False

    def _is_path_sensitive(self, path: Path) -> bool:
        """Check if path is in a sensitive directory (never allowed)."""
        resolved = path.resolve()

        for sensitive in self.sensitive_paths:
            try:
                if sensitive.exists():
                    resolved.relative_to(sensitive.resolve())
                    return True
            except ValueError:
                continue

        return False

    def _is_path_approved(self, path: Path) -> bool:
        """Check if user has already approved this path."""
        resolved = str(path.resolve())

        # Check exact path
        if resolved in self._approved_paths:
            return True

        # Check if parent directory was approved with "always"
        for approved in self._approved_paths:
            if resolved.startswith(approved + "/"):
                return True

        return False

    async def check_write_permission(
        self, file_path: str, operation: str = "write"
    ) -> tuple[bool, str | None]:
        """
        Check if a write operation is allowed, requesting approval if needed.

        Args:
            file_path: The path being written to
            operation: Description of operation (write, edit, create)

        Returns:
            Tuple of (allowed: bool, error_message: str | None)
        """
        path = Path(file_path).expanduser()

        # Check sensitive paths first (never allowed)
        if self._is_path_sensitive(path):
            return False, f"Cannot {operation} to sensitive system path: {file_path}"

        # Check if in allowed directories
        if self._is_path_allowed(path):
            return True, None

        # Check if already approved this session
        if self._is_path_approved(path):
            return True, None

        # Request approval from user
        prompt = f"Allow {operation} to:\n{file_path}\n\nThis path is outside your project and standard directories."
        options = ["Allow once", "Allow always for this directory", "Deny"]

        try:
            choice = await self.approval.request_approval(
                prompt=prompt,
                options=options,
                timeout=120.0,  # 2 minutes
                default="deny",
            )

            if "deny" in choice.lower():
                return False, f"User denied {operation} to: {file_path}"

            # Cache approval
            if "always" in choice.lower():
                # Approve the parent directory
                self._approved_paths.add(str(path.parent.resolve()))
                logger.info(f"User approved directory: {path.parent}")
            else:
                # Approve just this file
                self._approved_paths.add(str(path.resolve()))
                logger.info(f"User approved file: {path}")

            return True, None

        except Exception as e:
            logger.error(f"Error requesting write approval: {e}")
            return False, f"Failed to get approval for {operation}: {str(e)}"

    async def __call__(self, event: str, data: dict[str, Any]) -> dict[str, Any]:
        """
        Hook handler for tool:pre events.

        Intercepts write_file/edit_file and requests approval for
        paths outside standard directories.

        Returns a dict with 'action' key:
        - {"action": "continue"} - allow the tool to proceed
        - {"action": "deny", "reason": "..."} - block the tool
        """
        # Only handle tool:pre events
        if event != "tool:pre":
            return {"action": "continue"}

        # Only intercept write operations
        tool_name = data.get("tool_name", "")
        if tool_name not in ("write_file", "edit_file", "Write", "Edit"):
            return {"action": "continue"}

        # Extract file path from tool input
        tool_input = data.get("tool_input", {})
        file_path = tool_input.get("file_path")
        if not file_path:
            return {"action": "continue"}

        # Use existing check_write_permission logic
        operation = "write" if "write" in tool_name.lower() else "edit"
        allowed, error = await self.check_write_permission(file_path, operation)

        if not allowed:
            return {
                "action": "deny",
                "reason": error or f"Write to {file_path} was denied",
            }

        return {"action": "continue"}


async def mount(
    coordinator: Any, config: dict[str, Any] | None = None
) -> WriteApprovalHook | None:
    """
    Mount the write approval hook.

    Args:
        coordinator: Module coordinator
        config: Configuration including approval_system and cwd

    Returns:
        The hook instance, or None if approval system not available
    """
    config = config or {}

    approval_system = config.get("approval_system")
    if not approval_system:
        logger.warning("WriteApprovalHook: No approval system provided, skipping")
        return None

    cwd = config.get("cwd")
    if cwd:
        cwd = Path(cwd)

    hook = WriteApprovalHook(approval_system, cwd)

    # Register as a hook that can intercept tool calls
    # The hook will be called before write_file/edit_file operations

    return hook
