# Amplifier Web

A web interface for the [Microsoft Amplifier](https://github.com/microsoft/amplifier) AI agent system.

## Overview

Amplifier Web provides an interactive browser-based experience for Amplifier, featuring:

- **Real-time streaming** - Watch responses stream in as they're generated
- **Bundle configuration** - Select and configure bundles (foundation, amplifier-dev, etc.)
- **Behavior composition** - Add behaviors like logging, redaction, streaming-ui
- **Tool approvals** - Interactive approval dialogs with timeouts
- **Session management** - Persistent sessions with history

## Architecture

```
amplifier-web/
├── backend/                    # Python FastAPI backend
│   └── amplifier_web/
│       ├── main.py             # FastAPI app + WebSocket
│       ├── session_manager.py  # Session lifecycle
│       ├── bundle_manager.py   # Bundle loading
│       └── protocols/          # Web implementations
│           ├── display.py      # WebDisplaySystem
│           ├── approval.py     # WebApprovalSystem
│           └── hooks.py        # WebStreamingHook
│
└── frontend/                   # React TypeScript frontend
    └── src/
        ├── App.tsx
        ├── components/         # Chat, Config, Tools, Session
        ├── hooks/              # useWebSocket
        ├── stores/             # Zustand state
        └── types/              # TypeScript definitions
```

## Quick Start

### Prerequisites

- Python 3.11+
- Node.js 18+
- uv (Python package manager)

### Backend

```bash
cd backend
uv sync
uv run python -m amplifier_web.main
```

The server runs at http://localhost:8000

### Frontend

```bash
cd frontend
npm install
npm run dev
```

The development server runs at http://localhost:5173 (proxies to backend)

## WebSocket Protocol

The frontend communicates with the backend via WebSocket for real-time updates.

### Client → Server Messages

```typescript
// Create session
{ type: "create_session", config: { bundle: "foundation", behaviors: ["streaming-ui"] } }

// Send prompt
{ type: "prompt", content: "Help me debug this code", images?: ["base64..."] }

// Respond to approval
{ type: "approval_response", id: "request-id", choice: "Allow once" }

// Cancel execution
{ type: "cancel", immediate?: false }

// Slash command
{ type: "command", name: "status", args: [] }
```

### Server → Client Messages

```typescript
// Session created
{ type: "session_created", session_id: "abc123", bundle: "foundation" }

// Content streaming
{ type: "content_start", block_type: "text", index: 0 }
{ type: "content_delta", index: 0, delta: "Hello " }
{ type: "content_end", index: 0, content: "Hello world" }

// Tool lifecycle
{ type: "tool_call", tool_name: "bash", tool_call_id: "...", arguments: {...} }
{ type: "tool_result", tool_call_id: "...", output: "...", success: true }

// Approval request
{ type: "approval_request", id: "...", prompt: "Allow write?", options: ["Allow", "Deny"], timeout: 300 }

// Display messages
{ type: "display_message", level: "info", message: "Processing..." }
```

## Configuration

### Loading a Bundle

```python
from amplifier_web.bundle_manager import BundleManager

manager = BundleManager()
await manager.initialize()

prepared = await manager.load_bundle(
    "amplifier-dev",
    behaviors=["streaming-ui", "logging"],
    provider_override={
        "module": "provider-anthropic",
        "config": {
            "api_key": "${ANTHROPIC_API_KEY}",
            "default_model": "claude-sonnet-4-5"
        }
    }
)
```

### Available Bundles

| Bundle | Description |
|--------|-------------|
| `foundation` | Core bundle with default tools and agents |
| `amplifier-dev` | For developing on the Amplifier ecosystem |
| `recipes` | Recipe execution support |

### Available Behaviors

| Behavior | Description |
|----------|-------------|
| `streaming-ui` | Real-time UI streaming with thinking display |
| `logging` | Event logging to JSONL |
| `redaction` | Secret and PII redaction |
| `progress-monitor` | Analysis paralysis detection |
| `todo-reminder` | Task list reminders |
| `sessions` | Session management and naming |

## Development

### Project Setup

```bash
# Clone the repository
git clone https://github.com/bkrabach/amplifier-web
cd amplifier-web
```

### Running Tests

```bash
# Backend
cd backend
uv run pytest

# Frontend
cd frontend
npm test
```

## License

MIT - See [LICENSE](LICENSE)

## Related Projects

- [amplifier](https://github.com/microsoft/amplifier) - Main Amplifier project
- [amplifier-core](https://github.com/microsoft/amplifier-core) - Ultra-thin kernel
- [amplifier-foundation](https://github.com/microsoft/amplifier-foundation) - Bundle composition
- [amplifier-app-cli](https://github.com/microsoft/amplifier-app-cli) - Reference CLI
