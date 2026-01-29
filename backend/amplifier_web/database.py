"""
SQLite database for Amplifier Web session persistence.

Stores sessions, messages, and file artifacts with full history.
"""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Generator

DEFAULT_DB_PATH = Path.home() / ".amplifier" / "amplifier-web.db"


class Database:
    """SQLite database for persistent session storage."""

    def __init__(self, db_path: Path | None = None):
        self.db_path = db_path or DEFAULT_DB_PATH
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    @contextmanager
    def _connection(self) -> Generator[sqlite3.Connection, None, None]:
        """Context manager for database connections."""
        conn = sqlite3.connect(str(self.db_path))
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _init_schema(self) -> None:
        """Initialize database schema."""
        with self._connection() as conn:
            conn.executescript("""
                -- Sessions table
                CREATE TABLE IF NOT EXISTS sessions (
                    id TEXT PRIMARY KEY,
                    bundle_name TEXT NOT NULL,
                    name TEXT,
                    cwd TEXT,
                    status TEXT DEFAULT 'active',
                    turn_count INTEGER DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                -- Messages table (conversation history)
                CREATE TABLE IF NOT EXISTS messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT,
                    tool_calls TEXT,  -- JSON array of tool calls
                    tool_call_id TEXT,
                    name TEXT,
                    timestamp TEXT NOT NULL,
                    FOREIGN KEY (session_id) REFERENCES sessions(id)
                );

                -- Artifacts table (file changes)
                CREATE TABLE IF NOT EXISTS artifacts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    message_id INTEGER,
                    file_path TEXT NOT NULL,
                    operation TEXT NOT NULL,  -- 'create', 'edit', 'delete'
                    content_before TEXT,
                    content_after TEXT,
                    diff TEXT,
                    timestamp TEXT NOT NULL,
                    FOREIGN KEY (session_id) REFERENCES sessions(id),
                    FOREIGN KEY (message_id) REFERENCES messages(id)
                );

                -- Indexes for performance
                CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
                CREATE INDEX IF NOT EXISTS idx_artifacts_session ON artifacts(session_id);
                CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
            """)

    # Session operations
    def create_session(
        self,
        session_id: str,
        bundle_name: str,
        cwd: str | None = None,
        name: str | None = None,
    ) -> dict[str, Any]:
        """Create a new session."""
        now = datetime.utcnow().isoformat() + "Z"
        with self._connection() as conn:
            conn.execute(
                """
                INSERT INTO sessions (id, bundle_name, name, cwd, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (session_id, bundle_name, name, cwd, now, now),
            )
        return self.get_session(session_id)

    def get_session(self, session_id: str) -> dict[str, Any] | None:
        """Get session by ID."""
        with self._connection() as conn:
            row = conn.execute(
                "SELECT * FROM sessions WHERE id = ?", (session_id,)
            ).fetchone()
            if row:
                return dict(row)
        return None

    def update_session(
        self,
        session_id: str,
        name: str | None = None,
        status: str | None = None,
        turn_count: int | None = None,
    ) -> None:
        """Update session fields."""
        updates = []
        params = []
        if name is not None:
            updates.append("name = ?")
            params.append(name)
        if status is not None:
            updates.append("status = ?")
            params.append(status)
        if turn_count is not None:
            updates.append("turn_count = ?")
            params.append(turn_count)

        if updates:
            updates.append("updated_at = ?")
            params.append(datetime.utcnow().isoformat() + "Z")
            params.append(session_id)

            with self._connection() as conn:
                conn.execute(
                    f"UPDATE sessions SET {', '.join(updates)} WHERE id = ?",
                    params,
                )

    def list_sessions(self, limit: int = 50, offset: int = 0) -> list[dict[str, Any]]:
        """List sessions ordered by most recent."""
        with self._connection() as conn:
            rows = conn.execute(
                """
                SELECT * FROM sessions
                ORDER BY updated_at DESC
                LIMIT ? OFFSET ?
                """,
                (limit, offset),
            ).fetchall()
            return [dict(row) for row in rows]

    def delete_session(self, session_id: str) -> None:
        """Delete a session and all its data."""
        with self._connection() as conn:
            conn.execute("DELETE FROM artifacts WHERE session_id = ?", (session_id,))
            conn.execute("DELETE FROM messages WHERE session_id = ?", (session_id,))
            conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))

    # Message operations
    def add_message(
        self,
        session_id: str,
        role: str,
        content: str | None = None,
        tool_calls: list[dict] | None = None,
        tool_call_id: str | None = None,
        name: str | None = None,
    ) -> int:
        """Add a message to session history."""
        now = datetime.utcnow().isoformat() + "Z"
        tool_calls_json = json.dumps(tool_calls) if tool_calls else None

        with self._connection() as conn:
            cursor = conn.execute(
                """
                INSERT INTO messages (session_id, role, content, tool_calls, tool_call_id, name, timestamp)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (session_id, role, content, tool_calls_json, tool_call_id, name, now),
            )
            # Update session timestamp and turn count
            conn.execute(
                """
                UPDATE sessions 
                SET updated_at = ?, turn_count = turn_count + 1
                WHERE id = ?
                """,
                (now, session_id),
            )
            return cursor.lastrowid

    def get_messages(self, session_id: str) -> list[dict[str, Any]]:
        """Get all messages for a session."""
        with self._connection() as conn:
            rows = conn.execute(
                """
                SELECT * FROM messages
                WHERE session_id = ?
                ORDER BY id ASC
                """,
                (session_id,),
            ).fetchall()

            messages = []
            for row in rows:
                msg = dict(row)
                if msg["tool_calls"]:
                    msg["tool_calls"] = json.loads(msg["tool_calls"])
                messages.append(msg)
            return messages

    # Artifact operations
    def add_artifact(
        self,
        session_id: str,
        file_path: str,
        operation: str,
        content_before: str | None = None,
        content_after: str | None = None,
        diff: str | None = None,
        message_id: int | None = None,
    ) -> int:
        """Record a file artifact (change)."""
        now = datetime.utcnow().isoformat() + "Z"

        with self._connection() as conn:
            cursor = conn.execute(
                """
                INSERT INTO artifacts 
                (session_id, message_id, file_path, operation, content_before, content_after, diff, timestamp)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    session_id,
                    message_id,
                    file_path,
                    operation,
                    content_before,
                    content_after,
                    diff,
                    now,
                ),
            )
            return cursor.lastrowid

    def get_artifacts(self, session_id: str) -> list[dict[str, Any]]:
        """Get all artifacts for a session."""
        with self._connection() as conn:
            rows = conn.execute(
                """
                SELECT * FROM artifacts
                WHERE session_id = ?
                ORDER BY id ASC
                """,
                (session_id,),
            ).fetchall()
            return [dict(row) for row in rows]

    def get_artifact(self, artifact_id: int) -> dict[str, Any] | None:
        """Get a specific artifact by ID."""
        with self._connection() as conn:
            row = conn.execute(
                "SELECT * FROM artifacts WHERE id = ?", (artifact_id,)
            ).fetchone()
            if row:
                return dict(row)
        return None

    # Utility
    def session_exists(self, session_id: str) -> bool:
        """Check if a session exists."""
        with self._connection() as conn:
            row = conn.execute(
                "SELECT 1 FROM sessions WHERE id = ?", (session_id,)
            ).fetchone()
            return row is not None


# Global database instance
_db: Database | None = None


def get_database() -> Database:
    """Get the global database instance."""
    global _db
    if _db is None:
        _db = Database()
    return _db
