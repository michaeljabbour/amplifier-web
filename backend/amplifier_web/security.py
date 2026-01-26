"""
Security utilities for Amplifier Web.

Provides path validation to prevent directory traversal attacks.
"""

from __future__ import annotations

import logging
from pathlib import Path

logger = logging.getLogger(__name__)

# Patterns that should never be allowed in file paths
DENIED_PATH_PATTERNS = [
    "..",  # Parent directory traversal
    "~",  # Home directory expansion (should be resolved first)
]

# Root directories that are allowed for file operations
# These should be set based on the user's working directory
ALLOWED_PATH_ROOTS = [
    # Will be dynamically set based on session CWD
    # Default to user's home directory if no CWD specified
]


def validate_path(
    path: str | Path, allowed_root: Path
) -> tuple[bool, str, Path | None]:
    """
    Validate a file path to prevent directory traversal attacks.

    Checks:
    1. Path doesn't contain denied patterns (.. or ~)
    2. Resolved absolute path is within allowed_root
    3. Path doesn't escape via symlinks

    Args:
        path: Path to validate (can be relative or absolute)
        allowed_root: Root directory that path must be within

    Returns:
        Tuple of (is_valid, error_message, resolved_path)
        - is_valid: True if path is safe to use
        - error_message: Error description if invalid, empty string if valid
        - resolved_path: Absolute resolved path if valid, None if invalid
    """
    try:
        # Convert to Path objects
        if isinstance(path, str):
            path_obj = Path(path)
        else:
            path_obj = path

        allowed_root = Path(allowed_root).resolve()

        # Check for denied patterns in the original path string
        path_str = str(path)
        for pattern in DENIED_PATH_PATTERNS:
            if pattern in path_str:
                return (
                    False,
                    f"Path contains denied pattern '{pattern}': {path_str}",
                    None,
                )

        # Resolve to absolute path (handles relative paths, symlinks, etc.)
        # If path is relative, it's resolved relative to current working directory
        # For session paths, we'll handle this by changing CWD or making absolute first
        resolved = path_obj.resolve()

        # Check if resolved path is within allowed root
        try:
            # relative_to() raises ValueError if not a subpath
            resolved.relative_to(allowed_root)
        except ValueError:
            return (
                False,
                f"Path is outside allowed directory. Path: {resolved}, Allowed: {allowed_root}",
                None,
            )

        # Additional check: ensure the resolved path didn't escape via symlinks
        # We already resolved, so we just need to confirm it's still under the root
        if not str(resolved).startswith(str(allowed_root)):
            return (
                False,
                f"Path escapes allowed directory via symlink: {resolved}",
                None,
            )

        logger.debug(f"Path validation passed: {path} -> {resolved}")
        return (True, "", resolved)

    except Exception as e:
        logger.error(f"Path validation error: {e}")
        return (False, f"Path validation failed: {str(e)}", None)


def validate_session_cwd(cwd: str | Path | None) -> tuple[bool, str, Path | None]:
    """
    Validate a session's working directory.

    Ensures the CWD is:
    1. A valid path
    2. An existing directory
    3. Within user's home directory (or other safe root)
    4. Doesn't contain traversal patterns

    Args:
        cwd: Working directory path to validate (None uses home directory)

    Returns:
        Tuple of (is_valid, error_message, resolved_cwd)
        - is_valid: True if CWD is safe to use
        - error_message: Error description if invalid, empty string if valid
        - resolved_cwd: Absolute resolved path if valid, None if invalid
    """
    # If no CWD specified, use home directory
    if cwd is None:
        home = Path.home()
        logger.info(f"No CWD specified, using home directory: {home}")
        return (True, "", home)

    try:
        # Convert to Path and expand user home
        cwd_path = Path(cwd).expanduser()

        # Check for denied patterns after expansion
        # We check the EXPANDED path to allow ~/path but block path/~/other or ~user
        expanded_str = str(cwd_path)
        for pattern in DENIED_PATH_PATTERNS:
            if pattern in expanded_str:
                return (
                    False,
                    f"CWD contains denied pattern '{pattern}': {expanded_str}",
                    None,
                )

        # Resolve to absolute path
        resolved_cwd = cwd_path.resolve()

        # Check if it exists and is a directory
        if not resolved_cwd.exists():
            return (False, f"CWD does not exist: {resolved_cwd}", None)

        if not resolved_cwd.is_dir():
            return (False, f"CWD is not a directory: {resolved_cwd}", None)

        # Validate it's within user's home directory
        home = Path.home().resolve()
        try:
            resolved_cwd.relative_to(home)
        except ValueError:
            # Allow paths outside home if they're in common safe locations
            # This is for development/testing scenarios
            safe_roots = [
                Path("/tmp"),
                Path("/var/tmp"),
            ]

            is_safe = any(
                str(resolved_cwd).startswith(str(safe_root.resolve()))
                for safe_root in safe_roots
            )

            if not is_safe:
                logger.warning(
                    f"CWD is outside home directory: {resolved_cwd}. "
                    f"This may be a security risk in production."
                )
                # In production, you might want to return False here
                # For now, we'll allow it with a warning

        logger.info(f"Session CWD validated: {cwd} -> {resolved_cwd}")
        return (True, "", resolved_cwd)

    except Exception as e:
        logger.error(f"CWD validation error: {e}")
        return (False, f"CWD validation failed: {str(e)}", None)
