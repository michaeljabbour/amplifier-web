# Amplifier Web - Project Handoff Document

**Date:** January 25, 2026
**Version:** 0.1.0
**Status:** Feature-complete for MVP, ready for production hardening

---

## Executive Summary

Amplifier Web is a web interface for Microsoft's Amplifier AI agent system. It provides:
- Real-time streaming AI sessions via WebSocket
- Custom bundle and behavior support
- Session persistence and resume
- Token-based authentication over HTTPS
- Single-user deployment model

The codebase is clean, well-documented, and feature-complete for its initial scope. Outstanding work primarily involves production hardening, testing infrastructure, and documentation enhancements.

---

## Quick Start for New Developers

### Prerequisites
- Python 3.11+
- Node.js 18+
- uv package manager
- An LLM provider API key (ANTHROPIC_API_KEY or OPENAI_API_KEY)

### Running Locally (Development Mode)

```bash
# Clone the repository
git clone https://github.com/bkrabach/amplifier-web
cd amplifier-web

# Backend (from backend/ directory)
cd backend
uv sync
uv run python -m amplifier_web.main
# Note: Auth token is printed on startup and saved to ~/.amplifier/web-auth.json

# Frontend (from frontend/ directory, separate terminal)
cd frontend
npm install
npm run dev
```

### Running with TLS (Production-like)

```bash
# Uses auto-generated self-signed certificates
cd backend
uv run python -m amplifier_web.cli --port 8443
```

### Key URLs
- **Development mode:**
  - Frontend: http://localhost:5173 (proxies to backend)
  - Backend API: http://localhost:8000
- **TLS mode (via cli.py):**
  - Frontend: https://localhost:5173
  - Backend API: https://localhost:8443
- Auth token: `~/.amplifier/web-auth.json`

### External Access

To access from other machines, create `.env.local` files (gitignored):

**backend/.env.local:**
```bash
HOST=0.0.0.0
AMPLIFIER_WEB_ALLOWED_ORIGINS=http://your-hostname:5173,http://your-hostname:8000
```

**frontend/.env.local:**
```bash
VITE_HOST=0.0.0.0
```

Then start with:
```bash
# Backend
cd backend && export $(grep -v '^#' .env.local | xargs) && uv run python -m amplifier_web.main

# Frontend
cd frontend && npm run dev -- --host 0.0.0.0
```

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        Frontend                              │
│  React + TypeScript + Zustand + Tailwind                    │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐           │
│  │  Auth   │ │  Prefs  │ │ Session │ │  Chat   │           │
│  │  Store  │ │  Store  │ │  Store  │ │   UI    │           │
│  └────┬────┘ └────┬────┘ └────┬────┘ └────┬────┘           │
│       │           │           │           │                  │
│       └───────────┴───────────┴───────────┘                  │
│                       │                                      │
│              useWebSocket Hook                               │
└──────────────────────┬──────────────────────────────────────┘
                       │ WebSocket + REST
┌──────────────────────┴──────────────────────────────────────┐
│                        Backend                               │
│  FastAPI + uvicorn + HTTPS                                  │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐           │
│  │    Auth     │ │   Session   │ │   Bundle    │           │
│  │   Module    │ │   Manager   │ │   Manager   │           │
│  └──────┬──────┘ └──────┬──────┘ └──────┬──────┘           │
│         │               │               │                    │
│         └───────────────┴───────────────┘                    │
│                         │                                    │
│              Web Protocol Adapters                           │
│         (Hooks, Display, Approval, Spawn)                    │
└─────────────────────────┬───────────────────────────────────┘
                          │
                 Amplifier Ecosystem
        (amplifier-core, amplifier-foundation)
           Installed via pip or local path
```

---

## Completed Features (Original Plan)

The original plan (`ORIGINAL_PLAN.md`) has been **fully implemented**:

| Feature | Status | Notes |
|---------|--------|-------|
| CLI entry point (`amplifier-web`) | ✅ Complete | `cli.py` with click options |
| Auto-generated TLS certificates | ✅ Complete | `tls.py`, stored in `~/.amplifier/` |
| Token-based authentication | ✅ Complete | `auth.py`, Bearer token |
| User preferences persistence | ✅ Complete | `preferences.py`, JSON storage |
| Custom bundle registration | ✅ Complete | `bundle_manager.py` |
| Custom behavior registration | ✅ Complete | REST endpoints in `main.py` |
| Session persistence | ✅ Complete | `session_manager.py` |
| Session resume | ✅ Complete | Transcript loading |
| Frontend auth flow | ✅ Complete | `authStore.ts`, `LoginModal.tsx` |
| Frontend preferences sync | ✅ Complete | `prefsStore.ts` |
| ConfigPanel custom bundles UI | ✅ Complete | `ConfigPanel.tsx` |
| Working directory support | ✅ Complete | Injected into tool configs |

---

## Outstanding Work Items

### HIGH Priority

#### 1. CORS Configuration (Security)
**File:** `backend/amplifier_web/main.py:71-77`
```python
allow_origins=["*"],  # Restrict in production
```
**Action:** Implement environment-based CORS configuration for production.

#### 2. Test Suite Missing
**Location:** No `tests/` directory exists
**Action:** Create test infrastructure:
- Backend unit tests (pytest configured but no tests)
- Frontend component tests (no framework configured)
- Integration tests for WebSocket flow

### MEDIUM Priority

#### 3. Error Handling Improvements
Several locations silently catch exceptions:
- `auth.py:49-50` - Silently regenerates corrupted auth file
- `tls.py:44-45` - Broad exception swallowing on cert read
- `session_manager.py:293-294` - Transcript restore errors only logged

**Action:** Add proper logging and consider user notifications for recoverable errors.

#### 4. uv Tool Installation Issue
The `uv tool install` approach doesn't work standalone because amplifier-core isn't published as a package.

**Action:** Either:
- Publish amplifier-core to PyPI, OR
- Document local development setup requirements, OR
- Bundle dependencies differently

#### 5. Session Reconfiguration Experimental
**File:** `frontend/src/hooks/useWebSocket.ts:667-672`
```typescript
const reconfigureMessage = `**Session Reconfigured** (experimental)
```
**Action:** Test and stabilize, or document limitations clearly.

#### 6. Working Directory ✅ RESOLVED
~~Some modules don't support configurable `working_dir`.~~

**Status:** Fixed upstream! All modules now support the unified `session.working_dir` coordinator capability. Just pass `session_cwd` to `create_session()` and all modules query it automatically. Config injection workaround has been removed.

### LOW Priority

#### 7. Dead Code to Remove
| File | Item | Action |
|------|------|--------|
| `protocols/approval.py:144-146` | Unused `clear_cache()` method | Remove |
| `storage/__init__.py` | Empty placeholder module | Delete directory |
| `components/Session/SessionList.tsx` | Unused placeholder | Delete (use `Sessions/SessionList.tsx`) |
| `components/Session/SessionHeader.tsx` | Unused placeholder | Delete |
| `stores/sessionStore.ts:34-38, 129-145` | Legacy `pendingToolCalls` | Remove |

#### 8. Documentation Gaps
- Sub-session/agent delegation not documented in README
- Event streaming architecture not explained
- No troubleshooting guide
- No `.env.example` file

#### 9. Missing Configurations
- No `.eslintrc` or `eslint.config.mjs` for frontend
- No `.prettierrc` for code formatting
- No pre-commit hooks

---

## Feature Request for Upstream (amplifier-foundation)

### Unified Working Directory Capability ✅ IMPLEMENTED

~~**Problem:** When amplifier runs as a backend service, `Path.cwd()` returns the server's directory, not the user's intended project directory.~~

**Status:** Implemented upstream! The unified `session.working_dir` coordinator capability is now available.

**How it works:**
- Pass `session_cwd` parameter to `create_session()`
- All modules query the capability via `get_working_dir(coordinator)`
- Child sessions inherit the capability from parent sessions

**Modules updated:** tool-bash, tool-search, tool-recipes, hooks-logging, hooks-status-context, hooks-mode, hooks-python-check, hook-shell

---

## API Documentation Summary

### REST Endpoints (17 total)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/health` | No | Health check |
| GET | `/api/auth/verify` | Yes | Verify token |
| GET | `/api/bundles` | Yes | List bundles |
| GET | `/api/bundles/{name}` | Yes | Get bundle details |
| POST | `/api/bundles/custom` | Yes | Add custom bundle |
| DELETE | `/api/bundles/custom/{name}` | Yes | Remove custom bundle |
| POST | `/api/bundles/validate` | Yes | Validate bundle URI |
| GET | `/api/behaviors` | Yes | List behaviors |
| POST | `/api/behaviors/custom` | Yes | Add custom behavior |
| DELETE | `/api/behaviors/custom/{name}` | Yes | Remove custom behavior |
| GET | `/api/sessions` | Yes | List active sessions |
| GET | `/api/sessions/history` | Yes | List saved sessions |
| GET | `/api/sessions/history/{id}/transcript` | Yes | Get transcript |
| DELETE | `/api/sessions/history/{id}` | Yes | Delete session |
| GET | `/api/preferences` | Yes | Get preferences |
| PUT | `/api/preferences` | Yes | Update preferences |

### WebSocket Protocol

**Connection:** `wss://host:port/ws/session?token={auth_token}`

**Client → Server Messages:**
- `create_session` - Start new session
- `prompt` - Send user message
- `approval_response` - Respond to approval request
- `cancel` - Cancel execution
- `command` - Execute slash command
- `ping` - Keep-alive

**Server → Client Messages:**
- `session_created`, `bundle_debug_info`
- `content_start`, `content_delta`, `content_end`
- `thinking_delta`, `thinking_final`
- `tool_call`, `tool_result`
- `approval_request`
- `session_fork` (sub-session spawned)
- `display_message`, `prompt_complete`, `error`

---

## File Structure

```
amplifier-web/
├── backend/                          # Python FastAPI
│   ├── amplifier_web/
│   │   ├── main.py                   # FastAPI app, endpoints, WebSocket
│   │   ├── session_manager.py        # Session lifecycle
│   │   ├── bundle_manager.py         # Bundle loading, validation
│   │   ├── auth.py                   # Token authentication
│   │   ├── preferences.py            # User preferences
│   │   ├── tls.py                    # Certificate generation
│   │   ├── cli.py                    # CLI entry point
│   │   └── protocols/                # Web protocol adapters
│   │       ├── hooks.py              # Event streaming
│   │       ├── display.py            # Display messages
│   │       ├── approval.py           # Approval flow
│   │       └── spawn.py              # Sub-session spawning
│   └── pyproject.toml
│
├── frontend/                         # React TypeScript
│   ├── src/
│   │   ├── App.tsx                   # Main component
│   │   ├── hooks/useWebSocket.ts     # WebSocket integration
│   │   ├── stores/                   # Zustand state
│   │   │   ├── authStore.ts
│   │   │   ├── sessionStore.ts
│   │   │   └── prefsStore.ts
│   │   ├── components/
│   │   │   ├── Chat/                 # Chat UI
│   │   │   ├── Config/               # ConfigPanel
│   │   │   ├── Auth/                 # LoginModal
│   │   │   ├── Sessions/             # Session list
│   │   │   └── Tools/                # Approval, tool cards
│   │   └── types/amplifier.ts        # TypeScript definitions
│   └── package.json
│
├── README.md                         # User documentation
├── ARCHITECTURE.md                   # Technical architecture
├── HANDOFF.md                        # This document
└── ORIGINAL_PLAN.md                  # Original implementation plan
```

---

## Storage Locations

```
~/.amplifier/
├── web-auth.json              # Auth token
├── web-cert.pem               # TLS certificate
├── web-key.pem                # TLS private key
├── web-preferences.json       # User preferences
└── web-sessions/              # Session storage
    └── {session_id}/
        ├── metadata.json      # Session metadata
        └── transcript.jsonl   # Conversation history
```

---

## Known Limitations

1. **Single-user model:** Each server instance serves one user
2. **Self-signed certificates:** Browser warnings expected
3. **Amplifier dependency:** Requires amplifier-core and amplifier-foundation packages
4. **Session reconfigure:** Experimental, may lose some context

---

## Security Considerations

1. **Token storage:** `~/.amplifier/web-auth.json` has 0o600 permissions
2. **TLS:** Auto-generated certs for development; use proper certs or reverse proxy for production
3. **CORS:** Currently allows all origins - must restrict for production
4. **file:// URIs:** Validated to prevent access to system directories
5. **Path traversal:** Blocked via path resolution and pattern matching

---

## Commit History (Recent)

```
156e3f0 Fix session timestamps showing wrong relative time
4a4e993 Inject working_dir into tool-search and document module support
b08849d Fix system prompt context and Save Defaults button
7261af0 Fix working directory for tools and improve cwd display
a3a2278 Fix cwd not being used by tools and show path in status
7eba80c Pass through FULL raw event data for all events
4be72cc Capture ALL events using amplifier-core canonical list
```

---

## Contacts & Resources

- **Repository:** https://github.com/bkrabach/amplifier-web
- **Amplifier Core:** https://github.com/microsoft/amplifier-core
- **Amplifier Foundation:** https://github.com/microsoft/amplifier-foundation

---

## Handoff Checklist

- [x] Code is committed and pushed
- [x] Documentation reviewed and updated
- [x] Dead code identified
- [x] Outstanding work documented
- [x] API fully documented
- [x] Architecture documented
- [ ] Test suite created (TODO)
- [ ] CORS hardened for production (TODO)
- [ ] .env.example created (TODO)
