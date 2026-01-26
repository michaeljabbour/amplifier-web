# Amplifier Web Interface Architecture

## Overview

A web-based interface for the Amplifier AI agent system, providing an interactive chat experience equivalent to the CLI with full support for bundles, behaviors, streaming, tool approvals, and multi-turn sessions.

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           BROWSER (React/TypeScript)                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌─────────────┐ │
│  │   Chat UI    │  │  Tool Panel  │  │ Config Panel │  │ Session Mgr │ │
│  │  (streaming) │  │  (approvals) │  │  (bundles)   │  │  (history)  │ │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬──────┘ │
│         │                 │                 │                 │         │
│         └─────────────────┴─────────────────┴─────────────────┘         │
│                                    │                                     │
│                              WebSocket                                   │
└────────────────────────────────────┼─────────────────────────────────────┘
                                     │
┌────────────────────────────────────┼─────────────────────────────────────┐
│                         BACKEND (Python/FastAPI)                         │
│                                    │                                     │
│  ┌─────────────────────────────────┴─────────────────────────────────┐  │
│  │                    WebSocket Handler                               │  │
│  │  • Message routing    • Event streaming    • Approval handling     │  │
│  └──────────────────────────────┬────────────────────────────────────┘  │
│                                 │                                        │
│  ┌──────────────────────────────┴────────────────────────────────────┐  │
│  │                    Session Manager                                 │  │
│  │  • Create/resume sessions    • Track active sessions              │  │
│  │  • Handle sub-sessions       • Persist transcripts                │  │
│  └──────────────────────────────┬────────────────────────────────────┘  │
│                                 │                                        │
│  ┌──────────────────────────────┴────────────────────────────────────┐  │
│  │              Web Protocol Implementations                          │  │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐   │  │
│  │  │ WebDisplaySystem│  │WebApprovalSystem│  │ WebStreamingHook│   │  │
│  │  │ (show_message)  │  │(request_approval)│  │ (emit events)   │   │  │
│  │  └─────────────────┘  └─────────────────┘  └─────────────────┘   │  │
│  └──────────────────────────────┬────────────────────────────────────┘  │
│                                 │                                        │
│  ┌──────────────────────────────┴────────────────────────────────────┐  │
│  │                    Bundle Manager                                  │  │
│  │  • Discover bundles    • Load & prepare    • Compose behaviors    │  │
│  └──────────────────────────────┬────────────────────────────────────┘  │
│                                 │                                        │
└─────────────────────────────────┼────────────────────────────────────────┘
                                  │
┌─────────────────────────────────┼────────────────────────────────────────┐
│                    AMPLIFIER ECOSYSTEM (Submodules)                      │
│                                 │                                        │
│  ┌──────────────────────────────┴────────────────────────────────────┐  │
│  │  amplifier-core         │  amplifier-foundation                    │  │
│  │  • AmplifierSession     │  • Bundle class                          │  │
│  │  • ModuleCoordinator    │  • BundleRegistry                        │  │
│  │  • HookRegistry         │  • ModuleActivator                       │  │
│  │  • Events & Protocols   │  • Agent definitions                     │  │
│  └─────────────────────────┴─────────────────────────────────────────┘  │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │  amplifier                 │  amplifier-app-cli (reference)         ││
│  │  • Agents & behaviors      │  • Session patterns                    ││
│  │  • Recipes & outlines      │  • Command processing                  ││
│  │  • Context documents       │  • UI patterns                         ││
│  └─────────────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────────────┘
```

## Core Components

### 1. WebSocket Protocol

Real-time bidirectional communication for streaming and approvals.

**Server → Client Events:**
```typescript
// Content streaming (maps to CONTENT_BLOCK_* events)
{ type: "content_start", block_type: "text"|"thinking"|"tool_use", index: number }
{ type: "content_delta", index: number, delta: string }
{ type: "content_end", index: number, content: string }

// Tool lifecycle
{ type: "tool_call", tool_name: string, tool_call_id: string, arguments: object }
{ type: "tool_result", tool_call_id: string, output: string, error?: string }

// Approval requests
{ type: "approval_request", id: string, prompt: string, options: string[], timeout: number, default: string }

// Session events
{ type: "session_start", session_id: string, metadata: object }
{ type: "session_end", session_id: string, status: string }

// Display messages (from hooks)
{ type: "display_message", level: "info"|"warning"|"error", message: string, source?: string }
```

**Client → Server Events:**
```typescript
// User input
{ type: "prompt", content: string, images?: string[] }  // images as base64

// Approval response
{ type: "approval_response", id: string, choice: string }

// Commands
{ type: "command", name: string, args: string[] }  // slash commands

// Session control
{ type: "cancel" }  // graceful cancellation
{ type: "cancel_immediate" }  // force cancellation
```

### 2. Web Protocol Implementations

**WebDisplaySystem** (implements DisplaySystem protocol):
```python
class WebDisplaySystem:
    def __init__(self, websocket: WebSocket, nesting_depth: int = 0):
        self.ws = websocket
        self.nesting = nesting_depth

    async def show_message(self, message: str, level: str = "info", source: str = None):
        await self.ws.send_json({
            "type": "display_message",
            "level": level,
            "message": message,
            "source": source,
            "nesting": self.nesting
        })

    def push_nesting(self) -> "WebDisplaySystem":
        return WebDisplaySystem(self.ws, self.nesting + 1)
```

**WebApprovalSystem** (implements ApprovalSystem protocol):
```python
class WebApprovalSystem:
    def __init__(self, websocket: WebSocket):
        self.ws = websocket
        self._pending: dict[str, asyncio.Future] = {}
        self._cache: dict[str, str] = {}  # session-scoped cache

    async def request_approval(
        self, prompt: str, options: list[str],
        timeout: float = 300.0, default: str = "deny"
    ) -> str:
        # Check cache first
        cache_key = hash((prompt, tuple(options)))
        if cache_key in self._cache:
            return self._cache[cache_key]

        # Send approval request
        request_id = str(uuid.uuid4())
        await self.ws.send_json({
            "type": "approval_request",
            "id": request_id,
            "prompt": prompt,
            "options": options,
            "timeout": timeout,
            "default": default
        })

        # Wait for response with timeout
        future = asyncio.get_event_loop().create_future()
        self._pending[request_id] = future
        try:
            choice = await asyncio.wait_for(future, timeout)
            if "always" in choice.lower():
                self._cache[cache_key] = choice
            return choice
        except asyncio.TimeoutError:
            return default
        finally:
            self._pending.pop(request_id, None)
```

**WebStreamingHook** (implements Hook protocol):
```python
class WebStreamingHook:
    def __init__(self, websocket: WebSocket):
        self.ws = websocket

    async def __call__(self, event: str, data: dict) -> HookResult:
        # Map amplifier events to WebSocket messages
        if event == "content_block_start":
            await self.ws.send_json({
                "type": "content_start",
                "block_type": data.get("type"),
                "index": data.get("index")
            })
        elif event == "content_block_delta":
            await self.ws.send_json({
                "type": "content_delta",
                "index": data.get("index"),
                "delta": data.get("delta", {}).get("text", "")
            })
        # ... handle other events

        return HookResult(action="continue")
```

### 3. Bundle Manager

Wraps amplifier-foundation's bundle loading with web-specific conveniences:

```python
class BundleManager:
    def __init__(self, cache_dir: Path = None):
        self.registry = BundleRegistry(cache_dir or Path.home() / ".amplifier")
        self.discovery = AppBundleDiscovery()

    async def list_available(self) -> list[BundleInfo]:
        """List all discoverable bundles"""
        return [
            BundleInfo(name=name, **meta)
            for name, meta in self.discovery.WELL_KNOWN_BUNDLES.items()
        ]

    async def load_bundle(
        self,
        bundle_name: str,
        behaviors: list[str] = None,
        provider_override: dict = None
    ) -> PreparedBundle:
        """Load and prepare a bundle with optional behavior composition"""
        prepared = await load_and_prepare_bundle(
            bundle_name,
            self.discovery,
            compose_behaviors=behaviors
        )

        # Apply provider override if specified
        if provider_override:
            prepared.mount_plan["providers"].insert(0, provider_override)

        return prepared
```

### 4. Session Manager

Coordinates sessions, WebSocket connections, and persistence:

```python
class SessionManager:
    def __init__(self, bundle_manager: BundleManager, storage_dir: Path):
        self.bundles = bundle_manager
        self.storage = storage_dir
        self.active: dict[str, ActiveSession] = {}

    async def create_session(
        self,
        websocket: WebSocket,
        bundle_name: str,
        behaviors: list[str] = None,
        session_id: str = None
    ) -> str:
        # Prepare bundle
        prepared = await self.bundles.load_bundle(bundle_name, behaviors)

        # Create web protocol implementations
        display = WebDisplaySystem(websocket)
        approval = WebApprovalSystem(websocket)
        streaming_hook = WebStreamingHook(websocket)

        # Create session with web hooks
        session = await prepared.create_session(
            display_system=display,
            approval_system=approval,
            additional_hooks=[streaming_hook]
        )

        # Track and return
        session_id = session_id or session.session_id
        self.active[session_id] = ActiveSession(
            session=session,
            websocket=websocket,
            prepared=prepared
        )
        return session_id

    async def execute(self, session_id: str, prompt: str) -> None:
        """Execute prompt - results streamed via WebSocket"""
        active = self.active[session_id]
        await active.session.execute(prompt)
```

## Directory Structure

```
amplifier-web/
├── backend/                    # Python FastAPI backend
│   ├── amplifier_web/
│   │   ├── __init__.py
│   │   ├── main.py            # FastAPI app entry
│   │   ├── websocket.py       # WebSocket handler
│   │   ├── session_manager.py # Session lifecycle
│   │   ├── bundle_manager.py  # Bundle loading
│   │   ├── protocols/         # Web protocol implementations
│   │   │   ├── __init__.py
│   │   │   ├── display.py     # WebDisplaySystem
│   │   │   ├── approval.py    # WebApprovalSystem
│   │   │   └── hooks.py       # WebStreamingHook
│   │   ├── api/               # REST endpoints
│   │   │   ├── __init__.py
│   │   │   ├── bundles.py     # Bundle discovery/config
│   │   │   ├── sessions.py    # Session management
│   │   │   └── commands.py    # Slash command execution
│   │   └── storage/           # Persistence
│   │       ├── __init__.py
│   │       └── session_store.py
│   ├── pyproject.toml
│   └── uv.lock
│
├── frontend/                   # React TypeScript frontend
│   ├── src/
│   │   ├── App.tsx
│   │   ├── components/
│   │   │   ├── Chat/
│   │   │   │   ├── ChatContainer.tsx
│   │   │   │   ├── MessageList.tsx
│   │   │   │   ├── MessageBubble.tsx
│   │   │   │   ├── StreamingText.tsx
│   │   │   │   └── InputArea.tsx
│   │   │   ├── Tools/
│   │   │   │   ├── ToolCallCard.tsx
│   │   │   │   └── ApprovalModal.tsx
│   │   │   ├── Config/
│   │   │   │   ├── BundleSelector.tsx
│   │   │   │   ├── BehaviorToggle.tsx
│   │   │   │   └── ProviderConfig.tsx
│   │   │   └── Session/
│   │   │       ├── SessionList.tsx
│   │   │       └── SessionHeader.tsx
│   │   ├── hooks/
│   │   │   ├── useWebSocket.ts
│   │   │   ├── useSession.ts
│   │   │   └── useApproval.ts
│   │   ├── stores/
│   │   │   ├── sessionStore.ts
│   │   │   └── configStore.ts
│   │   └── types/
│   │       └── amplifier.ts
│   ├── package.json
│   └── vite.config.ts
│
├── .gitmodules
├── ARCHITECTURE.md
└── README.md
```

## Key Features to Implement

### Phase 1: Core Chat Experience
- [x] Bundle loading from foundation
- [ ] WebSocket streaming for text responses
- [ ] Basic chat UI with markdown rendering
- [ ] Session persistence (transcript.jsonl)

### Phase 2: Tool Integration
- [ ] Tool call display with arguments
- [ ] Approval modal with timeout countdown
- [ ] Tool result rendering
- [ ] "Allow always" caching

### Phase 3: Advanced Features
- [ ] Slash commands (/mode, /status, /tools, etc.)
- [ ] Mode switching with visual indicator
- [ ] Sub-session nesting (visual indentation)
- [ ] Thinking block disclosure (toggle)
- [ ] Image paste/upload support

### Phase 4: Configuration
- [ ] Bundle selector UI
- [ ] Behavior composition UI
- [ ] Provider configuration
- [ ] Session history browser

## Bundle Integration Example

Loading the `amplifier-dev` bundle with custom provider:

```python
import os
from amplifier_web.bundle_manager import BundleManager
from amplifier_web.protocols import WebDisplaySystem, WebApprovalSystem

# Initialize manager
manager = BundleManager()
await manager.initialize()

# Load bundle, compose behaviors, inject provider credentials
# This uses foundation's load_bundle() + Bundle.compose() + bundle.prepare()
prepared = await manager.load_and_prepare(
    "amplifier-dev",
    behaviors=["streaming-ui", "logging"],
    provider_config={
        "module": "provider-anthropic",
        "config": {
            "api_key": os.getenv("ANTHROPIC_API_KEY"),
            "default_model": "claude-sonnet-4-5",
        }
    }
)

# Create session using foundation's factory method
# Foundation handles ALL internal wiring (resolver, hooks, system prompt)
session = await prepared.create_session(
    session_id="user-123",
    approval_system=WebApprovalSystem(websocket),
    display_system=WebDisplaySystem(websocket),
)

# Register streaming hook for real-time UI
await session.coordinator.mount("hooks", WebStreamingHook(websocket), name="web-streaming")

# Execute prompts - streaming happens via hook
await session.execute("Help me build a feature")
```

## Technology Choices

**Backend:**
- Python 3.11+ (match amplifier ecosystem)
- FastAPI (async WebSocket support, OpenAPI docs)
- uv (package management, matches amplifier)

**Frontend:**
- React 18+ with TypeScript
- Tailwind CSS for styling
- Zustand for state management
- react-markdown for rendering

**Communication:**
- WebSocket for real-time streaming
- REST API for configuration endpoints
