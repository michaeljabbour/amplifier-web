# Custom Bundle Support for Amplifier Web

## Goal
Allow users to add custom bundles via git+https:// and file:// URIs in the ConfigPanel, with persistence across visits. Include simple auth over HTTPS for network protection. Turn-key installation.

---

## Architecture

### Installation: Turn-Key via uv

```bash
# Single command install from git
uv tool install git+https://github.com/org/amplifier-web

# Run (auto-generates certs and token on first run)
amplifier-web

# Or with options
amplifier-web --port 8443 --host 0.0.0.0
```

First run automatically:
1. Generates self-signed TLS certificate
2. Generates auth token
3. Prints setup instructions with token

### Deployment Model: Single User Per Instance

**Key Simplification:** Each server instance serves exactly one user. Multi-user = run multiple instances.

- Single user runs server with their own `~/.amplifier/` directory
- Multiple users on same machine → each runs own instance (different port, or separate OS user accounts)
- OS-level permissions handle isolation naturally
- No `user_id` partitioning needed in code

### HTTPS: Auto-Generated Self-Signed Certificate

```
~/.amplifier/
├── web-cert.pem    # Self-signed TLS certificate (auto-generated)
├── web-key.pem     # Private key (auto-generated)
```

- On first run, generates self-signed cert valid for localhost + machine hostname
- Browser will show security warning (expected for self-signed)
- User accepts once, then it's remembered
- For production: can provide own cert via `--cert` and `--key` flags, or use reverse proxy

### Auth: Simple Token (Network Protection)

```
~/.amplifier/web-auth.json: { "token": "generated-secret" }
```
- Auto-generated on first run (or set via env `AMPLIFIER_WEB_TOKEN`)
- Browser prompts for token on first visit, stores in localStorage
- All API requests require `Authorization: Bearer <token>`
- Token travels over HTTPS, so it's encrypted on the wire

### Storage: Existing Conventions

Use existing `~/.amplifier/` structure:

```
~/.amplifier/
├── web-auth.json           # Auth token
├── web-preferences.json    # User preferences (new)
├── registry.json           # Bundle registry (existing, add custom entries)
└── web-sessions/           # Session persistence (existing)
    └── {session_id}/
        ├── metadata.json
        └── history.jsonl
```

No user partitioning needed - the whole `~/.amplifier/` belongs to whoever runs the server.

---

## Implementation

### Phase 0: CLI Entry Point & HTTPS Setup

**File: `backend/amplifier_web/cli.py`** (new)

```python
import click
from pathlib import Path

@click.command()
@click.option("--port", default=8443, help="Port to listen on")
@click.option("--host", default="127.0.0.1", help="Host to bind to")
@click.option("--cert", type=Path, help="TLS certificate file")
@click.option("--key", type=Path, help="TLS private key file")
def main(port: int, host: str, cert: Path | None, key: Path | None):
    """Start Amplifier Web server."""
    from .server import run_server
    run_server(port=port, host=host, cert_path=cert, key_path=key)

if __name__ == "__main__":
    main()
```

**File: `backend/amplifier_web/tls.py`** (new)

```python
from pathlib import Path
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
import datetime
import socket

CERT_DIR = Path.home() / ".amplifier"
CERT_FILE = CERT_DIR / "web-cert.pem"
KEY_FILE = CERT_DIR / "web-key.pem"

def get_or_create_cert() -> tuple[Path, Path]:
    """Get existing cert or generate self-signed one."""
    if CERT_FILE.exists() and KEY_FILE.exists():
        return CERT_FILE, KEY_FILE

    # Generate key
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    # Generate self-signed cert
    hostname = socket.gethostname()
    subject = issuer = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, hostname)])

    cert = (x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.datetime.utcnow())
        .not_valid_after(datetime.datetime.utcnow() + datetime.timedelta(days=365))
        .add_extension(
            x509.SubjectAlternativeName([
                x509.DNSName("localhost"),
                x509.DNSName(hostname),
                x509.IPAddress(ipaddress.IPv4Address("127.0.0.1")),
            ]),
            critical=False,
        )
        .sign(key, hashes.SHA256()))

    # Save
    CERT_DIR.mkdir(parents=True, exist_ok=True)
    KEY_FILE.write_bytes(key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.TraditionalOpenSSL,
        serialization.NoEncryption()
    ))
    CERT_FILE.write_bytes(cert.public_bytes(serialization.Encoding.PEM))

    return CERT_FILE, KEY_FILE
```

**File: `backend/pyproject.toml`** (modify)

Add entry point and dependencies:
```toml
[project.scripts]
amplifier-web = "amplifier_web.cli:main"

[project]
dependencies = [
    ...existing...,
    "click>=8.0.0",
    "cryptography>=42.0.0",
]
```

### Phase 1: Auth Module

**File: `backend/amplifier_web/auth.py`** (new)

```python
import json
import os
import secrets
from pathlib import Path
from fastapi import Request, HTTPException, WebSocket

AUTH_FILE = Path.home() / ".amplifier" / "web-auth.json"

def get_or_create_token() -> str:
    """Get existing token or generate new one."""
    if env_token := os.environ.get("AMPLIFIER_WEB_TOKEN"):
        return env_token
    if AUTH_FILE.exists():
        return json.loads(AUTH_FILE.read_text())["token"]
    token = secrets.token_urlsafe(32)
    AUTH_FILE.parent.mkdir(parents=True, exist_ok=True)
    AUTH_FILE.write_text(json.dumps({"token": token}))
    return token

async def verify_token(request: Request) -> None:
    """FastAPI dependency to verify auth token."""
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(401, "Missing auth token")
    if auth[7:] != get_or_create_token():
        raise HTTPException(401, "Invalid auth token")

def verify_websocket_token(token: str) -> bool:
    """Verify token for WebSocket connection."""
    return token == get_or_create_token()
```

**File: `backend/amplifier_web/main.py`**

- Add auth dependency to all REST endpoints
- WebSocket verifies token as first message after connect

**Frontend: Login flow**
- On app load, check localStorage for token
- If missing or 401 response, show simple login modal
- Store token, include in all API requests and WebSocket connection

### Phase 2: Backend - Bundle Registration & Preferences

**File: `backend/amplifier_web/bundle_manager.py`**

Add methods:
```python
async def register_custom_bundle(self, uri: str, name: str | None = None) -> BundleInfo
async def validate_bundle_uri(self, uri: str) -> dict[str, Any]
async def unregister_custom_bundle(self, name: str) -> bool
def validate_file_path(self, path: str) -> tuple[bool, str | None]
```

**File: `backend/amplifier_web/preferences.py`** (new)

```python
PREFS_FILE = Path.home() / ".amplifier" / "web-preferences.json"

@dataclass
class UserPreferences:
    default_bundle: str = "foundation"
    default_behaviors: list[str] = field(default_factory=list)
    show_thinking: bool = True

def load_preferences() -> UserPreferences
def save_preferences(prefs: UserPreferences) -> None
```

**File: `backend/amplifier_web/main.py`**

New REST endpoints:
```
POST /api/bundles/custom     - Add custom bundle by URI
DELETE /api/bundles/custom/{name} - Remove custom bundle
POST /api/bundles/validate   - Validate URI without registering
GET /api/preferences         - Get user preferences
PUT /api/preferences         - Save user preferences
```

### Phase 3: Frontend - Auth & Persistence

**File: `frontend/src/stores/authStore.ts`** (new)

```typescript
interface AuthStore {
  token: string | null;
  isAuthenticated: boolean;
  setToken: (token: string) => void;
  clearToken: () => void;
}
```

**File: `frontend/src/stores/prefsStore.ts`** (new)

```typescript
interface PrefsStore {
  defaultBundle: string;
  defaultBehaviors: string[];
  showThinking: boolean;
  customBundles: CustomBundle[];
  // Sync with server on load
  loadFromServer: () => Promise<void>;
  saveToServer: () => Promise<void>;
}
```

**File: `frontend/src/components/Auth/LoginModal.tsx`** (new)

Simple modal with token input field.

### Phase 4: Frontend - ConfigPanel UI

**File: `frontend/src/components/Config/ConfigPanel.tsx`**

Add sections:
1. **Custom Bundle Input** - Text input for URI + Add button
2. **Validation feedback** - Loading spinner, error messages
3. **Enhanced bundle list** - Show custom bundles with "Custom" badge + remove button
4. **Auto-restore** - Use saved defaults on mount

---

## Files to Modify

| File | Action | Description |
|------|--------|-------------|
| `backend/pyproject.toml` | Modify | Add entry point, click, cryptography deps |
| `backend/amplifier_web/cli.py` | **Create** | CLI entry point with options |
| `backend/amplifier_web/tls.py` | **Create** | Auto-generate self-signed certificates |
| `backend/amplifier_web/auth.py` | **Create** | Simple token auth |
| `backend/amplifier_web/preferences.py` | **Create** | User preferences storage |
| `backend/amplifier_web/bundle_manager.py` | Modify | Add validation, registration methods |
| `backend/amplifier_web/main.py` | Modify | Add auth dependency, HTTPS support, new REST endpoints |
| `frontend/src/stores/authStore.ts` | **Create** | Auth token storage |
| `frontend/src/stores/prefsStore.ts` | **Create** | Preferences with server sync |
| `frontend/src/components/Auth/LoginModal.tsx` | **Create** | Simple token input modal |
| `frontend/src/components/Config/ConfigPanel.tsx` | Modify | Add custom bundle UI |
| `frontend/src/types/amplifier.ts` | Modify | Add BundleInfo.isCustom |
| `frontend/src/App.tsx` | Modify | Use stores, show login when needed |

---

## Security

### file:// Path Validation

Paths scoped to home directory, deny system paths:

```python
ALLOWED_ROOTS = [Path.home(), Path("/tmp")]
DENIED_PATTERNS = ["/etc", "/var", "/usr", "/bin", "/sbin", "/System", "/Library"]

def validate_file_path(self, uri: str) -> tuple[bool, str | None]:
    path = Path(uri[7:]).resolve()  # Remove file://, resolve symlinks
    if ".." in str(path):
        return False, "Path traversal not allowed"
    for denied in DENIED_PATTERNS:
        if str(path).startswith(denied):
            return False, f"Access to {denied} not allowed"
    for allowed in ALLOWED_ROOTS:
        if path.is_relative_to(allowed):
            return True, None
    return False, "Path must be under home directory"
```

---

## Verification

1. **Turn-key install:**
   ```bash
   uv tool install git+https://github.com/org/amplifier-web
   amplifier-web
   ```
   - First run generates cert + token, prints instructions
   - Check `~/.amplifier/web-cert.pem` and `web-key.pem` exist
   - Check `~/.amplifier/web-auth.json` exists

2. **HTTPS:**
   - `curl -k https://localhost:8443/health` → Works (with -k for self-signed)
   - Browser shows cert warning → Accept → Site loads
   - Second visit → No warning (cert remembered)

3. **Auth flow:**
   - Open browser → Login modal appears
   - Enter wrong token → "Invalid token" error
   - Enter correct token → Modal closes, session created
   - Refresh page → No login modal (token in localStorage)
   - `curl -k https://localhost:8443/api/bundles` without auth → 401

4. **Custom bundles:**
   - Add `git+https://github.com/org/bundle@main` → Validates and adds to list
   - Add `file:///etc/passwd` → Security error
   - Add `file://~/my-bundles/test` → Works
   - Refresh page → Custom bundles persist

5. **Preferences:**
   - Select bundle, close browser, reopen → Same bundle selected
   - Check `~/.amplifier/web-preferences.json` has saved values

6. **Multi-instance (manual test):**
   - `amplifier-web --port 8443` (user A)
   - `amplifier-web --port 8444` (user B, different HOME)
   - Each has independent auth tokens, certs, preferences, bundles
