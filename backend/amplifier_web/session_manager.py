"""
Session manager for Amplifier Web.

Manages the lifecycle of Amplifier sessions for web clients.
Uses foundation's PreparedBundle.create_session() factory - does NOT
manually wire coordinator internals.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .bundle_manager import BundleManager
from .protocols import (
    WebApprovalSystem,
    WebDisplaySystem,
    WebStreamingHook,
    WebSpawnManager,
)

if TYPE_CHECKING:
    from fastapi import WebSocket
    from amplifier_foundation import PreparedBundle

logger = logging.getLogger(__name__)


@dataclass
class SessionMetadata:
    """Metadata for an active or saved session."""

    session_id: str
    bundle_name: str
    created_at: datetime = field(default_factory=datetime.utcnow)
    updated_at: datetime = field(default_factory=datetime.utcnow)
    name: str | None = None
    turn_count: int = 0
    status: str = "active"
    cwd: Path | None = None  # Working directory for file operations


@dataclass
class ActiveSession:
    """
    An active session with WebSocket connection.

    Holds references to:
    - The WebSocket for this client
    - The PreparedBundle (for spawning, agent lookup)
    - The AmplifierSession (created lazily on first execute)
    - Web protocol implementations (display, approval, streaming hook)
    - Execute task for cancellation support
    """

    session_id: str
    websocket: "WebSocket"
    metadata: SessionMetadata
    prepared: "PreparedBundle"
    display: WebDisplaySystem
    approval: WebApprovalSystem
    streaming_hook: WebStreamingHook
    amplifier_session: Any = None  # Created on first execute
    execute_task: asyncio.Task | None = None  # For cancellation support
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock)


class SessionManager:
    """
    Manages Amplifier sessions for web clients.

    Responsibilities (app-layer):
    - Create web protocol implementations (display, approval, streaming hook)
    - Call prepared.create_session() with those protocols
    - Track active sessions by ID
    - Handle WebSocket message routing

    NOT responsible for (foundation handles):
    - Module loading and resolution
    - Session initialization internals
    - Hook registration mechanics
    """

    def __init__(
        self,
        bundle_manager: BundleManager,
        storage_dir: Path | None = None,
    ):
        """
        Initialize session manager.

        Args:
            bundle_manager: For loading and preparing bundles
            storage_dir: Directory for session persistence
        """
        self._bundles = bundle_manager
        self._storage_dir = storage_dir or Path.home() / ".amplifier" / "web-sessions"
        self._active: dict[str, ActiveSession] = {}
        self._storage_dir.mkdir(parents=True, exist_ok=True)

    async def create_session(
        self,
        websocket: "WebSocket",
        bundle_name: str = "foundation",
        behaviors: list[str] | None = None,
        provider_config: dict[str, Any] | None = None,
        session_id: str | None = None,
        show_thinking: bool = True,
        session_cwd: Path | None = None,
        initial_transcript: list[dict[str, Any]] | None = None,
    ) -> str:
        """
        Create a new session for a WebSocket connection.

        Args:
            websocket: Connected WebSocket to browser
            bundle_name: Bundle to load (default: "foundation")
            behaviors: Behavior bundles to compose
            provider_config: Provider configuration (API keys, model selection)
            session_id: Optional session ID (for resume)
            show_thinking: Whether to stream thinking blocks
            session_cwd: Working directory for @-mention resolution
            initial_transcript: Optional conversation history to restore (for reconfigure)

        Returns:
            Session ID

        Raises:
            RuntimeError: If bundle loading or session creation fails
        """
        session_id = session_id or str(uuid.uuid4())[:16]
        self._pending_transcript: dict[str, list[dict[str, Any]]] = getattr(
            self, "_pending_transcript", {}
        )
        if initial_transcript:
            self._pending_transcript[session_id] = initial_transcript

        # Create web protocol implementations
        display = WebDisplaySystem(websocket)
        approval = WebApprovalSystem(websocket)
        streaming_hook = WebStreamingHook(websocket, show_thinking=show_thinking)

        # Load and prepare bundle via BundleManager
        # Note: session_cwd is passed to create_session() below, where the unified
        # working_dir coordinator capability handles it for all modules
        prepared = await self._bundles.load_and_prepare(
            bundle_name,
            behaviors=behaviors,
            provider_config=provider_config,
        )

        # Create or load metadata (preserve existing metadata when resuming)
        existing_metadata = self._load_session_metadata(session_id)
        if existing_metadata:
            # Resuming - preserve turn count and created_at, update cwd if provided
            existing_cwd = existing_metadata.get("cwd")
            if existing_cwd and isinstance(existing_cwd, str):
                existing_cwd = Path(existing_cwd)

            metadata = SessionMetadata(
                session_id=session_id,
                bundle_name=bundle_name,
                turn_count=existing_metadata.get("turn_count", 0),
                cwd=session_cwd or existing_cwd,
            )
            # Preserve original created_at if available
            if existing_metadata.get("created_at"):
                metadata.created_at = existing_metadata["created_at"]
        else:
            # New session
            metadata = SessionMetadata(
                session_id=session_id,
                bundle_name=bundle_name,
                cwd=session_cwd,
            )

        # Create active session record (AmplifierSession created lazily)
        active = ActiveSession(
            session_id=session_id,
            websocket=websocket,
            metadata=metadata,
            prepared=prepared,
            display=display,
            approval=approval,
            streaming_hook=streaming_hook,
        )

        self._active[session_id] = active

        # Notify browser
        await websocket.send_json(
            {
                "type": "session_created",
                "session_id": session_id,
                "bundle": bundle_name,
                "behaviors": behaviors or [],
                "cwd": str(session_cwd) if session_cwd else None,
            }
        )

        # Send debug info about the bundle configuration
        await self._send_bundle_debug_info(websocket, prepared, bundle_name, behaviors)

        logger.info(f"Created session {session_id} with bundle {bundle_name}")
        return session_id

    async def _ensure_amplifier_session(self, active: ActiveSession) -> Any:
        """
        Ensure AmplifierSession exists, creating it if needed.

        Uses PreparedBundle.create_session() factory - the CORRECT way
        to create sessions. Foundation handles all internal wiring.

        Args:
            active: Active session record

        Returns:
            AmplifierSession ready for execute()
        """
        if active.amplifier_session is not None:
            return active.amplifier_session

        # Use foundation's factory method - it handles ALL wiring:
        # - Mounts module resolver
        # - Initializes session
        # - Sets up system prompt factory
        # - Registers capabilities
        session = await active.prepared.create_session(
            session_id=active.session_id,
            approval_system=active.approval,
            display_system=active.display,
            session_cwd=active.metadata.cwd,  # Pass cwd so tools use correct directory
        )

        # Set session ID on streaming hook for artifact tracking
        active.streaming_hook.set_session_id(active.session_id)

        # Register streaming hook with the hook registry
        # Use coordinator.hooks directly (same pattern as hooks-streaming-ui module)
        hook_registry = session.coordinator.hooks
        if hook_registry:
            # Import ALL canonical events from amplifier-core
            # This ensures we capture everything that makes it to events.jsonl
            try:
                from amplifier_core.events import ALL_EVENTS

                events_to_capture = list(ALL_EVENTS)
            except ImportError:
                # Fallback to essential events if import fails
                logger.warning(
                    "Could not import ALL_EVENTS from amplifier_core.events, using fallback list"
                )
                events_to_capture = [
                    "content_block:start",
                    "content_block:delta",
                    "content_block:end",
                    "thinking:delta",
                    "thinking:final",
                    "tool:pre",
                    "tool:post",
                    "tool:error",
                    "session:start",
                    "session:end",
                    "session:fork",
                    "session:resume",
                    "prompt:submit",
                    "prompt:complete",
                    "provider:request",
                    "provider:response",
                    "provider:error",
                    "llm:request",
                    "llm:request:debug",
                    "llm:request:raw",
                    "llm:response",
                    "llm:response:debug",
                    "llm:response:raw",
                    "cancel:requested",
                    "cancel:completed",
                    "user:notification",
                    "context:compaction",
                    "plan:start",
                    "plan:end",
                    "artifact:write",
                    "artifact:read",
                    "approval:required",
                    "approval:granted",
                    "approval:denied",
                ]

            # Also try to get auto-discovered module events
            discovered_events = (
                session.coordinator.get_capability("observability.events") or []
            )
            if discovered_events:
                events_to_capture.extend(discovered_events)
                logger.info(
                    f"Auto-discovered {len(discovered_events)} additional module events"
                )

            for event in events_to_capture:
                hook_registry.register(
                    event=event,
                    handler=active.streaming_hook,
                    priority=100,  # Run early to capture events
                    name=f"web-streaming:{event}",
                )
            logger.info(
                f"Registered web streaming hook for {len(events_to_capture)} events"
            )

        # Register session spawning capabilities for agent delegation
        # This enables the task tool to spawn sub-agents
        self._register_session_spawning(session, active.prepared)

        # Restore transcript if this is a reconfigure (bundle/behavior change)
        pending_transcript = getattr(self, "_pending_transcript", {})
        if active.session_id in pending_transcript:
            transcript = pending_transcript.pop(active.session_id)
            await self._restore_transcript(session, transcript)
            logger.info(
                f"Restored {len(transcript)} messages for reconfigured session {active.session_id}"
            )

        active.amplifier_session = session
        logger.info(f"Created AmplifierSession for {active.session_id}")

        return session

    async def _restore_transcript(
        self, session: Any, transcript: list[dict[str, Any]]
    ) -> None:
        """
        Restore conversation transcript into a session.

        Uses the context module's set_messages() capability, similar to
        how amplifier-app-cli handles session resume with --force-bundle.

        Args:
            session: The AmplifierSession to restore messages into
            transcript: List of message dicts with role and content
        """
        try:
            # Get the context module from coordinator
            context = session.coordinator.get("context")
            if context and hasattr(context, "set_messages"):
                # Filter to only user/assistant messages (skip system/developer)
                filtered = [
                    msg
                    for msg in transcript
                    if msg.get("role") in ("user", "assistant")
                ]
                await context.set_messages(filtered)
                logger.info(
                    f"Restored {len(filtered)} messages via context.set_messages()"
                )
            else:
                logger.warning(
                    "Context module not found or doesn't support set_messages()"
                )
        except Exception as e:
            logger.error(f"Failed to restore transcript: {e}")

    def _register_session_spawning(
        self, session: Any, prepared: "PreparedBundle"
    ) -> None:
        """Register session spawning capabilities for agent delegation.

        This enables the task tool to spawn sub-agents by registering
        the session.spawn and session.resume capabilities.

        Uses WebSpawnManager which forwards child events to parent's hooks
        for real-time WebSocket streaming.

        Args:
            session: The AmplifierSession to register capabilities on
            prepared: The PreparedBundle for creating child sessions
        """
        spawn_manager = WebSpawnManager()

        async def spawn_capability(
            agent_name: str,
            instruction: str,
            parent_session: Any,
            agent_configs: dict[str, dict],
            sub_session_id: str | None = None,
            tool_inheritance: dict[str, list[str]] | None = None,
            hook_inheritance: dict[str, list[str]] | None = None,
            orchestrator_config: dict | None = None,
            parent_messages: list[dict] | None = None,
            provider_override: str | None = None,
            model_override: str | None = None,
            parent_tool_call_id: str | None = None,
        ) -> dict:
            return await spawn_manager.spawn(
                agent_name=agent_name,
                instruction=instruction,
                parent_session=parent_session,
                agent_configs=agent_configs,
                prepared_bundle=prepared,
                parent_tool_call_id=parent_tool_call_id,
                sub_session_id=sub_session_id,
                tool_inheritance=tool_inheritance,
                hook_inheritance=hook_inheritance,
                orchestrator_config=orchestrator_config,
                parent_messages=parent_messages,
                provider_override=provider_override,
                model_override=model_override,
            )

        # Try to import resume capability from amplifier-app-cli
        try:
            from amplifier_app_cli.session_spawner import resume_sub_session

            async def resume_capability(sub_session_id: str, instruction: str) -> dict:
                return await resume_sub_session(
                    sub_session_id=sub_session_id,
                    instruction=instruction,
                )

            session.coordinator.register_capability("session.resume", resume_capability)
            logger.info("Registered session resume capability (session.resume)")
        except ImportError:
            logger.warning(
                "Could not register session.resume capability (amplifier-app-cli not available)"
            )

        session.coordinator.register_capability("session.spawn", spawn_capability)
        logger.info(
            "Registered session spawn capability with event forwarding (session.spawn)"
        )

    async def execute(
        self,
        session_id: str,
        prompt: str,
        images: list[str] | None = None,
    ) -> None:
        """
        Execute a prompt in a session.

        Results are streamed to the browser via WebSocket through the
        streaming hook registered on the session.

        Args:
            session_id: Session to execute in
            prompt: User prompt text
            images: Optional base64-encoded images

        Raises:
            KeyError: If session not found
            RuntimeError: If execution fails
        """
        active = self._active.get(session_id)
        if not active:
            raise KeyError(f"Session {session_id} not found")

        async with active._lock:
            try:
                # Ensure AmplifierSession exists
                session = await self._ensure_amplifier_session(active)

                # Update metadata
                active.metadata.turn_count += 1
                active.metadata.updated_at = datetime.utcnow()

                # Build message content
                content: Any = prompt
                if images:
                    content = [{"type": "text", "text": prompt}]
                    for img_data in images:
                        content.append(
                            {
                                "type": "image",
                                "source": {
                                    "type": "base64",
                                    "media_type": "image/png",
                                    "data": img_data,
                                },
                            }
                        )

                # Reset cancellation state before each execution
                session.coordinator.cancellation.reset()

                # Execute via AmplifierSession as a task (for cancellation support)
                # Streaming happens automatically via the registered hook
                logger.info(f"Executing prompt in session {session_id}")
                active.execute_task = asyncio.create_task(session.execute(content))
                try:
                    result = await active.execute_task
                finally:
                    active.execute_task = None
                logger.info(
                    f"Execution completed for session {session_id}, result length: {len(str(result)) if result else 0}"
                )

                # Save transcript after each turn
                await self._save_transcript(active)

                # Notify completion
                logger.info(f"Sending prompt_complete for session {session_id}")
                await active.websocket.send_json(
                    {
                        "type": "prompt_complete",
                        "turn": active.metadata.turn_count,
                    }
                )
                logger.info(f"prompt_complete sent for session {session_id}")

            except asyncio.CancelledError:
                logger.info(f"Session {session_id} execution cancelled")
                await active.websocket.send_json({"type": "execution_cancelled"})
                raise

            except Exception as e:
                logger.error(f"Execution error in session {session_id}: {e}")
                await active.websocket.send_json(
                    {
                        "type": "execution_error",
                        "error": str(e),
                    }
                )
                raise

    async def cancel(self, session_id: str, immediate: bool = False) -> None:
        """
        Cancel execution in a session.

        Uses the kernel's cancellation mechanism:
        - Graceful: Waits for current tools to complete
        - Immediate: Synthesizes tool results and stops

        Args:
            session_id: Session to cancel
            immediate: If True, cancel immediately; otherwise graceful
        """
        active = self._active.get(session_id)
        if not active:
            return

        # Request cancellation through the kernel's coordinator API
        if active.amplifier_session:
            coordinator = active.amplifier_session.coordinator
            await coordinator.request_cancel(immediate=immediate)

            # For immediate cancellation, also cancel the asyncio task
            if immediate and active.execute_task and not active.execute_task.done():
                active.execute_task.cancel()

        await active.websocket.send_json(
            {
                "type": "cancel_acknowledged",
                "immediate": immediate,
            }
        )

    async def handle_approval_response(
        self,
        session_id: str,
        request_id: str,
        choice: str,
    ) -> bool:
        """
        Handle an approval response from the browser.

        Args:
            session_id: Session ID
            request_id: Approval request ID
            choice: User's selected option

        Returns:
            True if response was handled
        """
        active = self._active.get(session_id)
        if not active:
            return False

        return active.approval.handle_response(request_id, choice)

    async def close_session(self, session_id: str) -> None:
        """
        Close and cleanup a session.

        Args:
            session_id: Session to close
        """
        active = self._active.pop(session_id, None)
        if not active:
            return

        # Cleanup AmplifierSession if it was created
        if active.amplifier_session:
            try:
                # Use context manager exit if available
                if hasattr(active.amplifier_session, "__aexit__"):
                    await active.amplifier_session.__aexit__(None, None, None)
                elif hasattr(active.amplifier_session, "cleanup"):
                    await active.amplifier_session.cleanup()
            except Exception as e:
                logger.warning(f"Error cleaning up session {session_id}: {e}")

        # Save session metadata
        await self._save_session(active)
        logger.info(f"Closed session {session_id}")

    async def _send_bundle_debug_info(
        self,
        websocket: "WebSocket",
        prepared: "PreparedBundle",
        bundle_name: str,
        behaviors: list[str] | None,
    ) -> None:
        """
        Send detailed bundle configuration info to browser for debugging.

        Passes through raw bundle data with minimal transformation.
        Only masks sensitive fields (api_key, secret, password, token).
        """
        try:
            bundle = prepared.bundle

            def mask_secrets(obj):
                """Recursively mask sensitive fields in dicts."""
                if isinstance(obj, dict):
                    return {
                        k: (
                            "***"
                            if k in ("api_key", "secret", "password", "token")
                            else mask_secrets(v)
                        )
                        for k, v in obj.items()
                    }
                elif isinstance(obj, list):
                    return [mask_secrets(item) for item in obj]
                else:
                    return obj

            # Pass through raw bundle data with secrets masked
            debug_info = {
                "type": "bundle_debug_info",
                "bundle_name": bundle_name,
                "bundle_version": getattr(bundle, "version", "unknown"),
                "behaviors_composed": behaviors or [],
                # Raw bundle fields
                "instruction": bundle.instruction,
                "tools": mask_secrets(list(bundle.tools)),
                "providers": mask_secrets(list(bundle.providers)),
                "hooks": mask_secrets(list(bundle.hooks)),
                "agents": mask_secrets(dict(bundle.agents) if bundle.agents else {}),
                # Additional bundle attributes if available
                "session_config": mask_secrets(getattr(bundle, "session", None)),
                "orchestrator_config": mask_secrets(
                    getattr(bundle, "orchestrator", None)
                ),
            }

            # Get mount plan if available
            if hasattr(bundle, "to_mount_plan"):
                try:
                    mount_plan = bundle.to_mount_plan()
                    if mount_plan:
                        # Try to serialize mount plan
                        debug_info["mount_plan"] = {
                            "modules": [
                                repr(m) for m in getattr(mount_plan, "modules", [])
                            ],
                            "providers": [
                                repr(p) for p in getattr(mount_plan, "providers", [])
                            ],
                            "raw": repr(mount_plan),
                        }
                except Exception as e:
                    debug_info["mount_plan"] = {"error": str(e)}

            await websocket.send_json(debug_info)
            logger.info(
                f"Sent bundle debug info: {len(bundle.tools)} tools, {len(bundle.providers)} providers"
            )

        except Exception as e:
            logger.warning(f"Failed to send bundle debug info: {e}")
            # Non-fatal - don't break session creation

    def _load_session_metadata(self, session_id: str) -> dict[str, Any] | None:
        """Load existing session metadata from storage if it exists."""
        session_dir = self._storage_dir / session_id
        metadata_path = session_dir / "metadata.json"

        if not metadata_path.exists():
            return None

        try:
            data = json.loads(metadata_path.read_text())
            # Parse created_at back to datetime if it exists
            if "created_at" in data and data["created_at"]:
                # Handle ISO format with or without Z suffix
                created_str = data["created_at"].rstrip("Z")
                data["created_at"] = datetime.fromisoformat(created_str)

            # Recalculate turn_count from transcript (metadata may be stale)
            transcript_path = session_dir / "transcript.jsonl"
            if transcript_path.exists():
                try:
                    user_turns = sum(
                        1
                        for line in transcript_path.read_text().splitlines()
                        if line and '"role": "user"' in line
                    )
                    if user_turns > data.get("turn_count", 0):
                        data["turn_count"] = user_turns
                        logger.info(
                            f"Recalculated turn_count for {session_id}: {user_turns}"
                        )
                except Exception as e:
                    logger.warning(f"Failed to recalculate turn_count: {e}")

            return data
        except (json.JSONDecodeError, OSError, ValueError) as e:
            logger.warning(f"Failed to load session metadata for {session_id}: {e}")
            return None

    async def _save_session(self, active: ActiveSession) -> None:
        """Save session metadata and transcript to storage."""
        session_dir = self._storage_dir / active.session_id
        session_dir.mkdir(exist_ok=True)

        # Save metadata
        metadata_path = session_dir / "metadata.json"
        metadata = {
            "session_id": active.metadata.session_id,
            "bundle_name": active.metadata.bundle_name,
            # Add 'Z' suffix to indicate UTC (isoformat() on naive datetime omits timezone)
            "created_at": active.metadata.created_at.isoformat() + "Z",
            "updated_at": active.metadata.updated_at.isoformat() + "Z",
            "name": active.metadata.name,
            "turn_count": active.metadata.turn_count,
            "status": "saved",
            "cwd": str(active.metadata.cwd) if active.metadata.cwd else None,
        }
        metadata_path.write_text(json.dumps(metadata, indent=2))

        # Save transcript if session has context
        await self._save_transcript(active)

    async def _save_transcript(self, active: ActiveSession) -> None:
        """Save conversation transcript to JSONL file."""
        if not active.amplifier_session:
            logger.debug("_save_transcript: no amplifier_session")
            return

        try:
            # Get messages from context module
            context = active.amplifier_session.coordinator.get("context")
            if not context:
                logger.debug("_save_transcript: no context module")
                return
            if not hasattr(context, "get_messages"):
                logger.debug(
                    f"_save_transcript: context has no get_messages, attrs: {dir(context)}"
                )
                return

            messages = await context.get_messages()
            logger.debug(
                f"_save_transcript: got {len(messages) if messages else 0} messages"
            )

            # Filter to user/assistant only (skip system/developer)
            filtered = [
                msg for msg in messages if msg.get("role") in ("user", "assistant")
            ]

            if not filtered:
                return

            # Save as JSONL
            session_dir = self._storage_dir / active.session_id
            session_dir.mkdir(exist_ok=True)
            transcript_path = session_dir / "transcript.jsonl"

            lines = []
            for msg in filtered:
                msg_dict = msg if isinstance(msg, dict) else msg.model_dump()
                # Add timestamp if not present
                if "timestamp" not in msg_dict:
                    msg_dict["timestamp"] = datetime.utcnow().isoformat()
                lines.append(json.dumps(msg_dict, ensure_ascii=False))

            transcript_path.write_text("\n".join(lines) + "\n" if lines else "")
            logger.info(
                f"Saved transcript with {len(filtered)} messages for session {active.session_id}"
            )

        except Exception as e:
            logger.warning(f"Failed to save transcript: {e}")

    def load_transcript(self, session_id: str) -> list[dict[str, Any]]:
        """Load conversation transcript from storage.

        Returns:
            List of message dicts (role, content, timestamp)
        """
        session_dir = self._storage_dir / session_id
        transcript_path = session_dir / "transcript.jsonl"

        if not transcript_path.exists():
            return []

        transcript = []
        try:
            with open(transcript_path, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line:
                        transcript.append(json.loads(line))
            logger.info(f"Loaded {len(transcript)} messages from transcript")
        except Exception as e:
            logger.warning(f"Failed to load transcript: {e}")

        return transcript

    def get_session(self, session_id: str) -> ActiveSession | None:
        """Get an active session by ID."""
        return self._active.get(session_id)

    def list_active_sessions(self) -> list[SessionMetadata]:
        """List all active sessions."""
        return [s.metadata for s in self._active.values()]

    def list_saved_sessions(
        self, top_level_only: bool = True, min_turns: int = 1
    ) -> list[dict[str, Any]]:
        """List saved sessions from storage.

        Args:
            top_level_only: If True, filter out spawned agent sub-sessions
            min_turns: Minimum turn count to include (default 1, filters zero-turn sessions)
        """
        sessions = []
        if not self._storage_dir.exists():
            return sessions

        for session_dir in self._storage_dir.iterdir():
            if not session_dir.is_dir():
                continue

            session_id = session_dir.name

            # Filter out spawned agent sessions (they have underscore in ID)
            # Format: {parent_span}-{child_span}_{agent_name}
            if top_level_only and "_" in session_id:
                continue

            metadata_path = session_dir / "metadata.json"
            if metadata_path.exists():
                try:
                    metadata = json.loads(metadata_path.read_text())

                    # Get turn count - if 0, try to calculate from transcript
                    turn_count = metadata.get("turn_count", 0)
                    if turn_count == 0:
                        # Metadata may be stale - count user messages in transcript
                        transcript_path = session_dir / "transcript.jsonl"
                        if transcript_path.exists():
                            try:
                                user_turns = sum(
                                    1
                                    for line in transcript_path.read_text().splitlines()
                                    if line and '"role": "user"' in line
                                )
                                if user_turns > 0:
                                    turn_count = user_turns
                                    metadata["turn_count"] = turn_count
                            except Exception:
                                pass  # Fall back to metadata value

                    # Filter by minimum turn count
                    if turn_count < min_turns:
                        continue

                    # Ensure timestamps have UTC indicator for JavaScript parsing
                    # Old sessions may have been saved without the 'Z' suffix
                    for ts_field in ("created_at", "updated_at"):
                        if ts_field in metadata and not metadata[ts_field].endswith(
                            "Z"
                        ):
                            metadata[ts_field] = metadata[ts_field] + "Z"

                    sessions.append(metadata)
                except Exception as e:
                    logger.warning(
                        f"Failed to load session metadata {session_dir}: {e}"
                    )

        # Sort by updated_at descending (most recent first)
        sessions.sort(key=lambda s: s.get("updated_at", ""), reverse=True)
        return sessions

    async def delete_saved_session(self, session_id: str) -> bool:
        """Delete a saved session from storage."""
        session_dir = self._storage_dir / session_id
        if not session_dir.exists():
            return False

        import shutil

        try:
            shutil.rmtree(session_dir)
            return True
        except Exception as e:
            logger.error(f"Failed to delete session {session_id}: {e}")
            return False

    async def rename_session(self, session_id: str, new_name: str) -> bool:
        """Rename a saved session."""
        session_dir = self._storage_dir / session_id
        metadata_file = session_dir / "metadata.json"

        if not metadata_file.exists():
            return False

        try:
            import json

            with open(metadata_file) as f:
                metadata = json.load(f)

            metadata["name"] = new_name
            metadata["updated_at"] = datetime.now(timezone.utc).isoformat()

            with open(metadata_file, "w") as f:
                json.dump(metadata, f, indent=2)

            return True
        except Exception as e:
            logger.error(f"Failed to rename session {session_id}: {e}")
            return False
