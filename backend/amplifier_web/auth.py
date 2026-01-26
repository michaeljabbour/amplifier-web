"""
Authentication module for Amplifier Web.

Provides simple token-based authentication for network protection.
Single-user model: each server instance serves one user.
"""

from __future__ import annotations

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

# Security scheme for OpenAPI docs
security = HTTPBearer(auto_error=False)


def get_or_create_token() -> str:
    """
    Get existing auth token or generate a new one.

    Token sources (in priority order):
    1. AMPLIFIER_WEB_TOKEN environment variable
    2. ~/.amplifier/web-auth.json file
    3. Generate new token and save to file

    Returns:
        The auth token string.
    """
    # Check environment variable first
    if env_token := os.environ.get("AMPLIFIER_WEB_TOKEN"):
        return env_token

    # Check existing file
    if AUTH_FILE.exists():
        try:
            data = json.loads(AUTH_FILE.read_text())
            if token := data.get("token"):
                return token
        except (json.JSONDecodeError, KeyError):
            pass  # Regenerate if file is corrupted

    # Generate new token
    token = secrets.token_urlsafe(32)

    # Save to file
    AUTH_DIR.mkdir(parents=True, exist_ok=True)
    AUTH_FILE.write_text(json.dumps({"token": token}, indent=2))
    AUTH_FILE.chmod(0o600)  # Owner read/write only

    return token


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
