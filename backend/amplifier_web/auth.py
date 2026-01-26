"""
Authentication module for Amplifier Web.

Provides simple token-based authentication for network protection.
Single-user model: each server instance serves one user.
"""

from __future__ import annotations

import fcntl
import json
import os
import secrets
from pathlib import Path
from typing import Annotated

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

# Auth token storage location
AUTH_DIR = Path.home() / ".amplifier"
AUTH_FILE = AUTH_DIR / "web-auth.json"
AUTH_LOCK = AUTH_DIR / ".web-auth.lock"

# Security scheme for OpenAPI docs
security = HTTPBearer(auto_error=False)


def _read_token_from_file() -> str | None:
    """Read token from file if it exists and is valid."""
    if not AUTH_FILE.exists():
        return None
    try:
        data = json.loads(AUTH_FILE.read_text())
        if token := data.get("token"):
            return token
    except (json.JSONDecodeError, OSError, ValueError):
        pass
    return None


def _write_token_atomically(token: str) -> None:
    """Write token to file using atomic rename."""
    temp_file = AUTH_DIR / f".web-auth.{os.getpid()}.tmp"
    try:
        temp_file.write_text(json.dumps({"token": token}, indent=2))
        temp_file.chmod(0o600)
        temp_file.rename(AUTH_FILE)
    except OSError:
        # Fall back to direct write if atomic fails
        temp_file.unlink(missing_ok=True)
        AUTH_FILE.write_text(json.dumps({"token": token}, indent=2))
        AUTH_FILE.chmod(0o600)


def get_or_create_token() -> str:
    """
    Get existing auth token or generate a new one.

    Token sources (in priority order):
    1. AMPLIFIER_WEB_TOKEN environment variable
    2. ~/.amplifier/web-auth.json file
    3. Generate new token and save to file

    Returns:
        The auth token string.

    Note:
        Uses file locking and atomic writes to prevent race conditions
        when multiple processes start simultaneously. This ensures the
        token remains stable across restarts.
    """
    # Check environment variable first (highest priority)
    if env_token := os.environ.get("AMPLIFIER_WEB_TOKEN"):
        return env_token

    # Fast path: check existing file without lock
    if token := _read_token_from_file():
        return token

    # Slow path: acquire lock and create token
    # Uses double-checked locking to handle race conditions
    AUTH_DIR.mkdir(parents=True, exist_ok=True)

    with open(AUTH_LOCK, "w") as lock_file:
        # Acquire exclusive lock (blocks until available)
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
            # Re-check after acquiring lock (another process may have created it)
            if token := _read_token_from_file():
                return token

            # Generate and save new token
            token = secrets.token_urlsafe(32)
            _write_token_atomically(token)
            return token
        finally:
            # Lock is automatically released when file is closed
            pass


async def verify_token(
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(security)],
) -> None:
    """
    FastAPI dependency to verify auth token on REST endpoints.

    Raises:
        HTTPException: 401 if token is missing or invalid.
    """
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing authentication token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    expected_token = get_or_create_token()
    if credentials.credentials != expected_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication token",
            headers={"WWW-Authenticate": "Bearer"},
        )


def verify_websocket_token(token: str) -> bool:
    """
    Verify token for WebSocket connection.

    Args:
        token: The token to verify.

    Returns:
        True if token is valid, False otherwise.
    """
    expected_token = get_or_create_token()
    return secrets.compare_digest(token, expected_token)


# Type alias for use in endpoint dependencies
AuthDep = Annotated[None, Depends(verify_token)]
