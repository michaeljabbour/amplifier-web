"""
Web spawn manager for sub-session spawning with event forwarding.

Implements session spawning with event forwarding to parent hooks,
enabling real-time sub-session activity to be displayed in the browser.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from amplifier_core import AmplifierSession
from amplifier_core.models import HookResult

if TYPE_CHECKING:
    from amplifier_foundation import PreparedBundle

logger = logging.getLogger(__name__)


class WebSpawnManager:
    """
    Manages sub-session spawning with event forwarding for web display.

    Key responsibilities:
    - Create child AmplifierSession with parent lineage
    - Register event forwarders BEFORE execution
    - Forward all child events to parent's hooks for WebSocket streaming
    - Handle cleanup on completion
    """

    async def spawn(
        self,
        agent_name: str,
        instruction: str,
        parent_session: AmplifierSession,
        agent_configs: dict[str, dict],
        prepared_bundle: "PreparedBundle",
        parent_tool_call_id: str | None = None,
        sub_session_id: str | None = None,
        tool_inheritance: dict[str, list[str]] | None = None,
        hook_inheritance: dict[str, list[str]] | None = None,
        orchestrator_config: dict | None = None,
        parent_messages: list[dict] | None = None,
        provider_override: str | None = None,
        model_override: str | None = None,
    ) -> dict[str, Any]:
        """
        Spawn sub-session with event forwarding for web streaming.

        Args:
            agent_name: Name of agent from configuration
            instruction: Task for agent to execute
            parent_session: Parent session for inheritance
            agent_configs: Dict of agent configurations
            prepared_bundle: Prepared bundle for session creation
            parent_tool_call_id: ID of parent tool call (for UI nesting)
            sub_session_id: Optional explicit session ID
            tool_inheritance: Optional tool filtering policy
            hook_inheritance: Optional hook filtering policy
            orchestrator_config: Optional orchestrator config override
            parent_messages: Optional parent context messages
            provider_override: Optional provider ID override
            model_override: Optional model name override

        Returns:
            Dict with "output" (response) and "session_id"
        """
        import time

        spawn_start_time = time.time()

        logger.info(
            f"[SPAWN] Starting spawn: agent={agent_name}, "
            f"parent_tool_call_id={parent_tool_call_id}, "
            f"parent_session={parent_session.session_id}"
        )

        from amplifier_foundation import generate_sub_session_id

        # Import agent config merging
        try:
            from amplifier_app_cli.agent_config import merge_configs
        except ImportError:
            # Fallback simple merge if app-cli not available
            def merge_configs(parent: dict, overlay: dict) -> dict:
                result = dict(parent)
                result.update(overlay)
                return result

        # Get agent configuration
        if agent_name not in agent_configs:
            raise ValueError(f"Agent '{agent_name}' not found in configuration")

        agent_config = agent_configs[agent_name]

        # Merge parent config with agent overlay
        merged_config = merge_configs(parent_session.config, agent_config)

        # Apply tool inheritance filtering if specified
        if tool_inheritance and "tools" in merged_config:
            merged_config = self._filter_tools(merged_config, tool_inheritance)

        # Apply hook inheritance filtering if specified
        if hook_inheritance and "hooks" in merged_config:
            merged_config = self._filter_hooks(merged_config, hook_inheritance)

        # Apply provider override if specified
        if provider_override or model_override:
            merged_config = self._apply_provider_override(
                merged_config, provider_override, model_override
            )

        # Apply orchestrator config override if specified
        if orchestrator_config:
            if "session" not in merged_config:
                merged_config["session"] = {}
            if "orchestrator" not in merged_config["session"]:
                merged_config["session"]["orchestrator"] = {}
            if "config" not in merged_config["session"]["orchestrator"]:
                merged_config["session"]["orchestrator"]["config"] = {}
            merged_config["session"]["orchestrator"]["config"].update(
                orchestrator_config
            )

        # Generate child session ID
        if not sub_session_id:
            sub_session_id = generate_sub_session_id(
                agent_name=agent_name,
                parent_session_id=parent_session.session_id,
                parent_trace_id=getattr(parent_session, "trace_id", None),
            )

        # Create child session with parent_id and inherited UX systems
        display_system = parent_session.coordinator.display_system
        child_session = AmplifierSession(
            config=merged_config,
            loader=None,  # Let child create its own loader
            session_id=sub_session_id,
            parent_id=parent_session.session_id,
            approval_system=parent_session.coordinator.approval_system,
            display_system=display_system,
        )

        # Notify display system we're entering a nested session
        if hasattr(display_system, "push_nesting"):
            display_system.push_nesting()

        # Mount module resolver from parent BEFORE initialize
        parent_resolver = parent_session.coordinator.get("module-source-resolver")
        if parent_resolver:
            await child_session.coordinator.mount(
                "module-source-resolver", parent_resolver
            )

        # Share sys.path additions from parent
        import sys

        paths_to_share: list[str] = []

        if hasattr(parent_session, "loader") and parent_session.loader is not None:
            parent_added_paths = getattr(parent_session.loader, "_added_paths", [])
            paths_to_share.extend(parent_added_paths)

        bundle_package_paths = parent_session.coordinator.get_capability(
            "bundle_package_paths"
        )
        if bundle_package_paths:
            paths_to_share.extend(bundle_package_paths)

        if paths_to_share:
            for path in paths_to_share:
                if path not in sys.path:
                    sys.path.insert(0, path)

        # Initialize child session
        await child_session.initialize()

        # Wire up cancellation propagation
        parent_cancellation = parent_session.coordinator.cancellation
        child_cancellation = child_session.coordinator.cancellation
        parent_cancellation.register_child(child_cancellation)

        # Inherit mention resolver and deduplicator
        parent_mention_resolver = parent_session.coordinator.get_capability(
            "mention_resolver"
        )
        if parent_mention_resolver:
            child_session.coordinator.register_capability(
                "mention_resolver", parent_mention_resolver
            )

        parent_deduplicator = parent_session.coordinator.get_capability(
            "mention_deduplicator"
        )
        if parent_deduplicator:
            child_session.coordinator.register_capability(
                "mention_deduplicator", parent_deduplicator
            )

        # CRITICAL: Register event forwarders BEFORE execution
        # This enables real-time streaming of child events to parent's WebSocket
        self._register_event_forwarders(
            child_session,
            parent_session,
            parent_tool_call_id,
        )

        # Emit session fork event to parent hooks
        parent_hooks = parent_session.coordinator.hooks
        if parent_hooks:
            logger.info(
                f"[SPAWN] Emitting session:fork event: "
                f"child_id={sub_session_id}, parent_tool_call_id={parent_tool_call_id}, agent={agent_name}"
            )
            await parent_hooks.emit(
                "session:fork",
                {
                    "parent_id": parent_session.session_id,
                    "child_id": sub_session_id,
                    "parent_tool_call_id": parent_tool_call_id,
                    "agent": agent_name,
                },
            )

        # Inject agent's system instruction
        system_instruction = agent_config.get("instruction") or agent_config.get(
            "system", {}
        ).get("instruction")
        if system_instruction:
            context = child_session.coordinator.get("context")
            if context and hasattr(context, "add_message"):
                await context.add_message(
                    {"role": "system", "content": system_instruction}
                )

        try:
            # Execute instruction in child session
            response = await child_session.execute(instruction)
        finally:
            # Unregister child cancellation token
            parent_cancellation.unregister_child(child_cancellation)

            # Notify display system we're exiting nested session
            if hasattr(display_system, "pop_nesting"):
                display_system.pop_nesting()

            # Cleanup child session
            await child_session.cleanup()

        spawn_duration = time.time() - spawn_start_time
        logger.info(
            f"[SPAWN] Completed spawn: agent={agent_name}, "
            f"session_id={sub_session_id}, "
            f"duration={spawn_duration:.2f}s"
        )

        return {"output": response, "session_id": sub_session_id}

    def _register_event_forwarders(
        self,
        child_session: AmplifierSession,
        parent_session: AmplifierSession,
        parent_tool_call_id: str | None,
    ) -> None:
        """
        Forward child events to parent's hooks for WebSocket streaming.

        Registers handlers on the child's hook registry that forward events
        to the parent's hooks with additional context (child_session_id,
        parent_tool_call_id, nesting_depth).

        Args:
            child_session: The child session whose events to forward
            parent_session: The parent session to forward events to
            parent_tool_call_id: ID of the tool call that spawned this session
        """
        parent_hooks = parent_session.coordinator.hooks
        child_hooks = child_session.coordinator.hooks

        if not parent_hooks or not child_hooks:
            logger.warning("Cannot register event forwarders: hooks not available")
            return

        # Create forwarder factory for each event type
        def create_forwarder(event_name: str):
            async def forward_event(event: str, data: dict[str, Any]) -> HookResult:
                # Add child session context to forwarded event
                forwarded_data = {
                    **data,
                    "child_session_id": child_session.session_id,
                    "parent_tool_call_id": parent_tool_call_id,
                    "nesting_depth": data.get("nesting_depth", 0) + 1,
                }
                await parent_hooks.emit(event_name, forwarded_data)
                return HookResult(action="continue")

            return forward_event

        # Forward all streamable events
        events_to_forward = [
            "content_block:start",
            "content_block:delta",
            "content_block:end",
            "thinking:delta",
            "thinking:final",
            "tool:pre",
            "tool:post",
            "tool:error",
        ]

        for event in events_to_forward:
            child_hooks.register(
                event=event,
                handler=create_forwarder(event),
                priority=50,  # Run before other hooks
                name=f"web-event-forwarder:{event}",
            )

        logger.info(
            f"Registered event forwarders for {len(events_to_forward)} events "
            f"(child={child_session.session_id}, parent_tool_call_id={parent_tool_call_id})"
        )

    def _filter_tools(
        self, config: dict, tool_inheritance: dict[str, list[str]]
    ) -> dict:
        """Filter tools in config based on inheritance policy."""
        tools = config.get("tools", [])
        if not tools:
            return config

        exclude_tools = tool_inheritance.get("exclude_tools", [])
        inherit_tools = tool_inheritance.get("inherit_tools")

        if inherit_tools is not None:
            filtered_tools = [t for t in tools if t.get("module") in inherit_tools]
        elif exclude_tools:
            filtered_tools = [t for t in tools if t.get("module") not in exclude_tools]
        else:
            return config

        new_config = dict(config)
        new_config["tools"] = filtered_tools
        return new_config

    def _filter_hooks(
        self, config: dict, hook_inheritance: dict[str, list[str]]
    ) -> dict:
        """Filter hooks in config based on inheritance policy."""
        hooks = config.get("hooks", [])
        if not hooks:
            return config

        exclude_hooks = hook_inheritance.get("exclude_hooks", [])
        inherit_hooks = hook_inheritance.get("inherit_hooks")

        if inherit_hooks is not None:
            filtered_hooks = [h for h in hooks if h.get("module") in inherit_hooks]
        elif exclude_hooks:
            filtered_hooks = [h for h in hooks if h.get("module") not in exclude_hooks]
        else:
            return config

        new_config = dict(config)
        new_config["hooks"] = filtered_hooks
        return new_config

    def _apply_provider_override(
        self,
        config: dict,
        provider_id: str | None,
        model: str | None,
    ) -> dict:
        """Apply provider/model override to config."""
        if not provider_id and not model:
            return config

        providers = config.get("providers", [])
        if not providers:
            return config

        # Find target provider
        target_idx = None
        for i, p in enumerate(providers):
            module_id = p.get("module", "")
            if provider_id and provider_id in (
                module_id,
                module_id.replace("provider-", ""),
                f"provider-{provider_id}",
            ):
                target_idx = i
                break

        # If only model specified, apply to first/priority provider
        if provider_id is None and model:
            min_priority = float("inf")
            for i, p in enumerate(providers):
                p_config = p.get("config", {})
                priority = p_config.get("priority", 100)
                if priority < min_priority:
                    min_priority = priority
                    target_idx = i

        if target_idx is None:
            return config

        # Clone and modify providers
        new_providers = []
        for i, p in enumerate(providers):
            p_copy = dict(p)
            p_copy["config"] = dict(p.get("config", {}))

            if i == target_idx:
                p_copy["config"]["priority"] = 0
                if model:
                    p_copy["config"]["model"] = model

            new_providers.append(p_copy)

        return {**config, "providers": new_providers}
