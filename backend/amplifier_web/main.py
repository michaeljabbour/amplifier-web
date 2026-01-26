"""
Amplifier Web - FastAPI application entry point.

Provides REST API and WebSocket endpoints for the Amplifier web interface.
"""

from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .auth import AuthDep, verify_websocket_token
from .bundle_manager import BundleManager
from .security import validate_session_cwd
from .session_manager import SessionManager

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)

# Global managers (initialized on startup)
bundle_manager: BundleManager | None = None
session_manager: SessionManager | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan - initialize and cleanup managers."""
    global bundle_manager, session_manager

    # Determine modules directory (check for submodules)
    modules_dir = Path(__file__).parent.parent.parent / "modules"
    if not modules_dir.exists():
        modules_dir = None
        logger.info("Submodules not found, will use installed packages")
    else:
        logger.info(f"Using submodules from {modules_dir}")

    # Initialize managers
    bundle_manager = BundleManager(modules_dir=modules_dir)
    await bundle_manager.initialize()

    session_manager = SessionManager(bundle_manager=bundle_manager)

    logger.info("Amplifier Web started")
    yield

    # Cleanup
    logger.info("Amplifier Web shutting down")


# Create FastAPI app
app = FastAPI(
    title="Amplifier Web",
    description="Web interface for Microsoft Amplifier AI agent system",
    version="0.1.0",
    lifespan=lifespan
)


def get_allowed_origins() -> list[str]:
    """
    Get allowed CORS origins from environment or use secure defaults.

    Reads from AMPLIFIER_WEB_ALLOWED_ORIGINS environment variable.
    Format: comma-separated list of origins.
    Example: "http://localhost:3000,http://localhost:5173"

    Returns:
        List of allowed origin URLs
    """
    env_origins = os.environ.get("AMPLIFIER_WEB_ALLOWED_ORIGINS", "")
    if env_origins:
        # Parse comma-separated list, strip whitespace, and reject wildcards
        origins = [
            origin.strip()
            for origin in env_origins.split(",")
            if origin.strip() and origin.strip() != "*"
        ]
        if origins:
            logger.info(f"Using CORS origins from environment: {origins}")
            return origins
        # If only wildcards were specified, fall through to defaults
        logger.warning("CORS wildcard (*) rejected, using secure defaults")
    
    # Secure defaults for local development
    default_origins = [
        "http://localhost:3000",
        "http://localhost:5173",
        "http://127.0.0.1:3000",
        "http://127.0.0.1:5173",
    ]
    logger.info(f"Using default CORS origins: {default_origins}")
    return default_origins


# CORS middleware with configurable origins
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_allowed_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================================
# Pydantic Models
# ============================================================================

class SessionCreateRequest(BaseModel):
    """Request to create a new session."""
    bundle: str = "foundation"
    behaviors: list[str] | None = None
    provider: dict[str, Any] | None = None
    show_thinking: bool = True
    initial_transcript: list[dict[str, Any]] | None = None  # For reconfigure with history
    cwd: str | None = None  # Working directory for file operations
    resume_session_id: str | None = None  # Session ID to resume (loads transcript from storage)


class SessionResponse(BaseModel):
    """Session information response."""
    session_id: str
    bundle: str
    status: str
    turn_count: int


class BundleInfo(BaseModel):
    """Bundle information."""
    name: str
    description: str
    available: bool = True
    is_custom: bool = False


class PromptRequest(BaseModel):
    """Request to execute a prompt."""
    prompt: str
    images: list[str] | None = None


# ============================================================================
# REST API Endpoints
# ============================================================================

@app.get("/api/health")
async def health_check():
    """Health check endpoint (no auth required)."""
    return {"status": "healthy", "version": "0.1.0"}


@app.get("/api/auth/verify")
async def verify_auth(_: AuthDep):
    """Verify authentication token."""
    return {"authenticated": True}


@app.get("/api/bundles", response_model=list[BundleInfo])
async def list_bundles(_: AuthDep):
    """List available bundles."""
    if not bundle_manager:
        raise HTTPException(status_code=503, detail="Service not initialized")

    bundles = await bundle_manager.list_bundles()
    return [
        BundleInfo(name=b.name, description=b.description, is_custom=b.is_custom)
        for b in bundles
    ]


@app.get("/api/bundles/{bundle_name}")
async def get_bundle_config(bundle_name: str, _: AuthDep):
    """Get configuration for a specific bundle."""
    if not bundle_manager:
        raise HTTPException(status_code=503, detail="Service not initialized")

    try:
        config = await bundle_manager.get_bundle_info(bundle_name)
        return config
    except Exception as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.get("/api/sessions", response_model=list[SessionResponse])
async def list_sessions(_: AuthDep):
    """List active sessions."""
    if not session_manager:
        raise HTTPException(status_code=503, detail="Service not initialized")

    sessions = session_manager.list_active_sessions()
    return [
        SessionResponse(
            session_id=s.session_id,
            bundle=s.bundle_name,
            status=s.status,
            turn_count=s.turn_count
        )
        for s in sessions
    ]


@app.get("/api/sessions/history")
async def list_saved_sessions(_: AuthDep):
    """List saved sessions from storage."""
    if not session_manager:
        raise HTTPException(status_code=503, detail="Service not initialized")

    return session_manager.list_saved_sessions()


@app.delete("/api/sessions/history/{session_id}")
async def delete_saved_session(session_id: str, _: AuthDep):
    """Delete a saved session from storage."""
    if not session_manager:
        raise HTTPException(status_code=503, detail="Service not initialized")

    success = await session_manager.delete_saved_session(session_id)
    if not success:
        raise HTTPException(status_code=404, detail="Session not found")

    return {"success": True, "session_id": session_id}


@app.get("/api/sessions/history/{session_id}/transcript")
async def get_session_transcript(session_id: str, _: AuthDep):
    """Get the conversation transcript for a saved session."""
    if not session_manager:
        raise HTTPException(status_code=503, detail="Service not initialized")

    transcript = session_manager.load_transcript(session_id)
    return {"session_id": session_id, "transcript": transcript}


# ============================================================================
# Custom Bundle Endpoints
# ============================================================================

class CustomBundleRequest(BaseModel):
    """Request to add a custom bundle."""
    uri: str
    name: str | None = None
    description: str | None = None


class ValidateBundleRequest(BaseModel):
    """Request to validate a bundle URI."""
    uri: str


@app.post("/api/bundles/custom")
async def add_custom_bundle(request: CustomBundleRequest, _: AuthDep):
    """Register a custom bundle by URI."""
    if not bundle_manager:
        raise HTTPException(status_code=503, detail="Service not initialized")

    result = await bundle_manager.register_custom_bundle(
        uri=request.uri,
        name=request.name,
        description=request.description,
    )

    if not result["success"]:
        raise HTTPException(status_code=400, detail=result["error"])

    return result


@app.delete("/api/bundles/custom/{name}")
async def remove_custom_bundle(name: str, _: AuthDep):
    """Remove a custom bundle registration."""
    if not bundle_manager:
        raise HTTPException(status_code=503, detail="Service not initialized")

    result = await bundle_manager.unregister_custom_bundle(name)

    if not result["success"]:
        raise HTTPException(status_code=404, detail=result["error"])

    return result


@app.post("/api/bundles/validate")
async def validate_bundle(request: ValidateBundleRequest, _: AuthDep):
    """Validate a bundle URI without registering it."""
    if not bundle_manager:
        raise HTTPException(status_code=503, detail="Service not initialized")

    result = await bundle_manager.validate_bundle_uri(request.uri)
    return result


# ============================================================================
# Custom Behavior Endpoints
# ============================================================================

class CustomBehaviorRequest(BaseModel):
    """Request to add a custom behavior."""
    uri: str
    name: str | None = None
    description: str | None = None


@app.get("/api/behaviors")
async def list_behaviors(_: AuthDep):
    """List available behaviors (built-in and custom)."""
    from .preferences import load_preferences

    # Built-in behaviors
    behaviors = [
        {"name": "streaming-ui", "description": "Real-time streaming display", "is_custom": False},
        {"name": "logging", "description": "Event logging to JSONL", "is_custom": False},
        {"name": "redaction", "description": "Secret and PII redaction", "is_custom": False},
        {"name": "progress-monitor", "description": "Analysis paralysis detection", "is_custom": False},
        {"name": "todo-reminder", "description": "Task list reminders", "is_custom": False},
        {"name": "sessions", "description": "Session management and naming", "is_custom": False},
    ]

    # Add custom behaviors from preferences
    prefs = load_preferences()
    for custom in prefs.custom_behaviors:
        behaviors.append({
            "name": custom.get("name", "unknown"),
            "description": custom.get("description", ""),
            "is_custom": True,
            "uri": custom.get("uri"),
        })

    return behaviors


@app.post("/api/behaviors/custom")
async def add_custom_behavior(request: CustomBehaviorRequest, _: AuthDep):
    """Register a custom behavior by URI."""
    if not bundle_manager:
        raise HTTPException(status_code=503, detail="Service not initialized")

    # Validate the URI first (behaviors are just bundles)
    validation = await bundle_manager.validate_bundle_uri(request.uri)
    if not validation["valid"]:
        raise HTTPException(status_code=400, detail=validation["error"])

    # Use bundle name if not provided
    bundle_info = validation["bundle_info"]
    final_name = request.name or bundle_info.get("name", "custom-behavior")
    final_description = request.description or bundle_info.get("description", "Custom behavior")

    # Save to preferences
    from .preferences import add_custom_behavior as do_add

    do_add(request.uri, final_name, final_description)

    return {
        "success": True,
        "name": final_name,
        "description": final_description,
        "uri": request.uri,
    }


@app.delete("/api/behaviors/custom/{name}")
async def remove_custom_behavior(name: str, _: AuthDep):
    """Remove a custom behavior registration."""
    from .preferences import load_preferences, remove_custom_behavior as do_remove

    prefs = load_preferences()

    # Check if behavior exists
    exists = any(b.get("name") == name for b in prefs.custom_behaviors)
    if not exists:
        raise HTTPException(status_code=404, detail=f"Behavior '{name}' not found")

    do_remove(name)
    return {"success": True, "name": name}


# ============================================================================
# Preferences Endpoints
# ============================================================================

class PreferencesUpdate(BaseModel):
    """Request to update user preferences."""
    default_bundle: str | None = None
    default_behaviors: list[str] | None = None
    show_thinking: bool | None = None


@app.get("/api/preferences")
async def get_preferences(_: AuthDep):
    """Get user preferences."""
    from .preferences import load_preferences
    from dataclasses import asdict

    prefs = load_preferences()
    return asdict(prefs)


@app.put("/api/preferences")
async def update_preferences(updates: PreferencesUpdate, _: AuthDep):
    """Update user preferences."""
    from .preferences import update_preferences as do_update
    from dataclasses import asdict

    # Build updates dict from non-None values
    updates_dict = {}
    if updates.default_bundle is not None:
        updates_dict["default_bundle"] = updates.default_bundle
    if updates.default_behaviors is not None:
        updates_dict["default_behaviors"] = updates.default_behaviors
    if updates.show_thinking is not None:
        updates_dict["show_thinking"] = updates.show_thinking

    prefs = do_update(updates_dict)
    return asdict(prefs)


# ============================================================================
# WebSocket Endpoint
# ============================================================================

@app.websocket("/ws/session")
async def websocket_session(websocket: WebSocket):
    """
    WebSocket endpoint for interactive sessions.

    Authentication:
    - Client must send auth message immediately after connecting
    - First message must be: {"type": "auth", "token": "<your-token>"}
    - Server responds with {"type": "auth_success"} on success
    - Connection is closed with code 4001 if auth fails or times out (5 seconds)

    Protocol:
    1. Client connects
    2. Client sends auth message within 5 seconds
    3. Server confirms with 'auth_success'
    4. Client sends 'create_session' message
    5. Server creates session and confirms with 'session_created'
    6. Client sends 'prompt' messages
    7. Server streams responses with content_delta, tool_call, etc.
    8. Server may send 'approval_request' messages
    9. Client responds with 'approval_response'
    10. Client can send 'cancel' to stop execution
    11. Client disconnects to end session
    """
    # Accept connection first
    await websocket.accept()
    logger.info("WebSocket connection accepted, waiting for authentication")

    # Wait for authentication message with timeout
    try:
        auth_data = await asyncio.wait_for(
            websocket.receive_json(),
            timeout=5.0
        )
    except asyncio.TimeoutError:
        logger.warning("WebSocket authentication timeout")
        await websocket.close(code=4001, reason="Authentication timeout")
        return
    except Exception as e:
        logger.error(f"WebSocket authentication error: {e}")
        await websocket.close(code=4001, reason="Authentication failed")
        return

    # Verify auth message format and token
    if auth_data.get("type") != "auth":
        logger.warning(f"Invalid auth message type: {auth_data.get('type')}")
        await websocket.close(code=4001, reason="Invalid auth message")
        return

    token = auth_data.get("token")
    if not token or not verify_websocket_token(token):
        logger.warning("Invalid or missing auth token")
        await websocket.close(code=4001, reason="Invalid or missing auth token")
        return

    # Authentication successful
    logger.info("WebSocket authentication successful")
    await websocket.send_json({"type": "auth_success"})

    session_id: str | None = None

    try:
        while True:
            # Receive message from client
            data = await websocket.receive_json()
            msg_type = data.get("type")

            if msg_type == "create_session":
                # Create new session (or reconfigure/resume with history)
                request = SessionCreateRequest(**data.get("config", {}))
                
                # Validate session working directory
                is_valid, error_msg, session_cwd = validate_session_cwd(request.cwd)
                if not is_valid:
                    logger.warning(f"Invalid session CWD: {error_msg}")
                    await websocket.send_json({
                        "type": "error",
                        "error": f"Invalid working directory: {error_msg}"
                    })
                    continue

                # Load transcript from storage if resuming
                initial_transcript = request.initial_transcript
                if request.resume_session_id:
                    stored_transcript = session_manager.load_transcript(request.resume_session_id)
                    if stored_transcript:
                        initial_transcript = stored_transcript
                        logger.info(f"Loaded {len(stored_transcript)} messages from session {request.resume_session_id}")

                session_id = await session_manager.create_session(
                    websocket=websocket,
                    bundle_name=request.bundle,
                    behaviors=request.behaviors,
                    provider_config=request.provider,
                    show_thinking=request.show_thinking,
                    initial_transcript=initial_transcript,
                    session_cwd=session_cwd,
                )

            elif msg_type == "prompt":
                # Execute prompt
                if not session_id:
                    await websocket.send_json({
                        "type": "error",
                        "error": "No session created"
                    })
                    continue

                prompt = data.get("content", "")
                images = data.get("images")

                try:
                    await session_manager.execute(session_id, prompt, images)
                except Exception as e:
                    logger.error(f"Execution error: {e}")
                    # Error already sent via execute()

            elif msg_type == "approval_response":
                # Handle approval response
                if session_id:
                    await session_manager.handle_approval_response(
                        session_id,
                        data.get("id", ""),
                        data.get("choice", "Deny")
                    )

            elif msg_type == "cancel":
                # Cancel execution
                if session_id:
                    await session_manager.cancel(
                        session_id,
                        immediate=data.get("immediate", False)
                    )

            elif msg_type == "command":
                # Handle slash command
                await handle_slash_command(
                    websocket,
                    session_id,
                    data.get("name", ""),
                    data.get("args", [])
                )

            elif msg_type == "ping":
                # Keep-alive
                await websocket.send_json({"type": "pong"})

            else:
                logger.warning(f"Unknown message type: {msg_type}")

    except WebSocketDisconnect:
        logger.info(f"WebSocket disconnected for session {session_id}")

    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        try:
            await websocket.send_json({
                "type": "error",
                "error": str(e)
            })
        except Exception:
            pass

    finally:
        # Cleanup session
        if session_id and session_manager:
            await session_manager.close_session(session_id)


async def handle_slash_command(
    websocket: WebSocket,
    session_id: str | None,
    command: str,
    args: list[str]
) -> None:
    """
    Handle slash commands from the web interface.

    Args:
        websocket: WebSocket connection
        session_id: Current session ID
        command: Command name (without /)
        args: Command arguments
    """
    if command == "help":
        await websocket.send_json({
            "type": "command_result",
            "command": "help",
            "result": {
                "commands": [
                    {"name": "help", "description": "Show available commands"},
                    {"name": "status", "description": "Show session status"},
                    {"name": "tools", "description": "List available tools"},
                    {"name": "agents", "description": "List available agents"},
                    {"name": "clear", "description": "Clear conversation context"},
                    {"name": "mode", "description": "Set execution mode"},
                    {"name": "modes", "description": "List available modes"},
                ]
            }
        })

    elif command == "status":
        if session_id and session_manager:
            session = session_manager.get_session(session_id)
            if session:
                await websocket.send_json({
                    "type": "command_result",
                    "command": "status",
                    "result": {
                        "session_id": session.metadata.session_id,
                        "bundle": session.metadata.bundle_name,
                        "turns": session.metadata.turn_count,
                        "created": session.metadata.created_at.isoformat(),
                    }
                })
                return

        await websocket.send_json({
            "type": "command_result",
            "command": "status",
            "result": {"error": "No active session"}
        })

    elif command == "tools":
        if session_id and session_manager:
            session = session_manager.get_session(session_id)
            if session:
                tools = session.prepared.mount_plan.get("tools", [])
                await websocket.send_json({
                    "type": "command_result",
                    "command": "tools",
                    "result": {
                        "tools": [
                            {"module": t.get("module", "unknown")}
                            for t in tools
                        ]
                    }
                })
                return

        await websocket.send_json({
            "type": "command_result",
            "command": "tools",
            "result": {"error": "No active session"}
        })

    elif command == "clear":
        # Clear context would need AmplifierSession integration
        await websocket.send_json({
            "type": "command_result",
            "command": "clear",
            "result": {"message": "Context cleared"}
        })

    else:
        await websocket.send_json({
            "type": "command_result",
            "command": command,
            "result": {"error": f"Unknown command: {command}"}
        })


# ============================================================================
# Static Files (Frontend)
# ============================================================================

# Mount frontend static files if they exist
frontend_dir = Path(__file__).parent.parent.parent / "frontend" / "dist"
if frontend_dir.exists():
    app.mount("/", StaticFiles(directory=str(frontend_dir), html=True), name="frontend")


# ============================================================================
# CLI Entry Point
# ============================================================================

def main():
    """Run the server."""
    import uvicorn
    from .auth import get_or_create_token

    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8000"))

    # Get or create auth token and display it
    token = get_or_create_token()
    print("\n" + "=" * 50)
    print("  Amplifier Web Dev Server")
    print("=" * 50)
    print(f"  URL: http://{host}:{port}")
    print(f"\n  Auth Token: {token}")
    print("\n  Enter this token when prompted in the browser.")
    print("=" * 50 + "\n")

    # Only watch backend source directory for reload, exclude everything else
    # This prevents the server from reloading when the orchestrator writes files
    backend_dir = Path(__file__).parent

    uvicorn.run(
        "amplifier_web.main:app",
        host=host,
        port=port,
        reload=True,
        reload_dirs=[str(backend_dir)],  # Only watch backend source
        log_level="info"
    )


if __name__ == "__main__":
    main()
