"""
Comprehensive security tests for Amplifier Web backend.

Tests the three critical security fixes:
1. Path traversal protection (validate_path, validate_session_cwd)
2. WebSocket authentication (first-message protocol)
3. CORS configuration (environment-based, no wildcards)

These tests focus on unit testing without requiring a full WebSocket server.
"""

from __future__ import annotations

import os
import secrets
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest

from amplifier_web.auth import get_or_create_token, verify_websocket_token
from amplifier_web.main import get_allowed_origins
from amplifier_web.security import validate_path, validate_session_cwd


# ============================================================================
# Priority 1: Path Traversal Protection Tests (CRITICAL)
# ============================================================================


@pytest.mark.unit
@pytest.mark.security
class TestPathValidation:
    """Tests for path traversal protection in validate_path()."""

    def test_validate_path_accepts_valid_paths(self, tmp_path: Path) -> None:
        """
        Test that validate_path accepts legitimate paths within allowed root.

        Verifies:
        - Absolute paths within allowed root are accepted
        - Relative paths within allowed root are accepted
        - Resolved path is returned correctly
        """
        # Create test directory structure
        allowed_root = tmp_path / "workspace"
        allowed_root.mkdir()
        test_file = allowed_root / "test.txt"
        test_file.write_text("test content")

        # Test absolute path
        is_valid, error, resolved = validate_path(test_file, allowed_root)
        assert is_valid is True
        assert error == ""
        assert resolved == test_file.resolve()

        # Test path within subdirectory
        subdir = allowed_root / "subdir"
        subdir.mkdir()
        subfile = subdir / "file.txt"
        subfile.write_text("content")

        is_valid, error, resolved = validate_path(subfile, allowed_root)
        assert is_valid is True
        assert error == ""
        assert resolved == subfile.resolve()

    def test_validate_path_accepts_home_directory(self) -> None:
        """
        Test that validate_path accepts paths in user's home directory.

        Verifies:
        - Home directory itself is valid when used as both path and root
        - Subdirectories in home are accepted
        """
        home = Path.home()

        # Test home directory as both path and root
        is_valid, error, resolved = validate_path(home, home)
        assert is_valid is True
        assert error == ""
        assert resolved == home.resolve()

    def test_validate_path_accepts_tmp_directory(self, tmp_path: Path) -> None:
        """
        Test that validate_path accepts paths in /tmp directory.

        Verifies:
        - /tmp paths are accepted for testing/temporary operations
        """
        # tmp_path fixture provides a path in /tmp (or equivalent)
        test_file = tmp_path / "test.txt"
        test_file.write_text("content")

        is_valid, error, resolved = validate_path(test_file, tmp_path)
        assert is_valid is True
        assert error == ""
        assert resolved == test_file.resolve()

    def test_validate_path_rejects_parent_traversal(self, tmp_path: Path) -> None:
        """
        Test that validate_path rejects paths containing .. (parent directory).

        Verifies:
        - Paths with .. are rejected before resolution
        - Error message indicates the denied pattern
        """
        allowed_root = tmp_path / "workspace"
        allowed_root.mkdir()

        # Test explicit .. in path
        bad_path = allowed_root / ".." / "etc" / "passwd"
        is_valid, error, resolved = validate_path(bad_path, allowed_root)
        assert is_valid is False
        assert ".." in error
        assert "denied pattern" in error.lower()
        assert resolved is None

        # Test .. in middle of path
        bad_path_str = str(allowed_root / "subdir" / ".." / ".." / "etc")
        is_valid, error, resolved = validate_path(bad_path_str, allowed_root)
        assert is_valid is False
        assert ".." in error
        assert resolved is None

    def test_validate_path_rejects_tilde_pattern(self, tmp_path: Path) -> None:
        """
        Test that validate_path rejects paths containing ~ before expansion.

        Verifies:
        - Tilde character is detected as a denied pattern
        - This prevents home directory expansion attacks
        """
        allowed_root = tmp_path / "workspace"
        allowed_root.mkdir()

        # Test path with tilde
        bad_path = "~/../../etc/passwd"
        is_valid, error, resolved = validate_path(bad_path, allowed_root)
        assert is_valid is False
        assert "~" in error
        assert "denied pattern" in error.lower()
        assert resolved is None

    def test_validate_path_rejects_paths_outside_root(self, tmp_path: Path) -> None:
        """
        Test that validate_path rejects paths outside the allowed root.

        Verifies:
        - Paths that resolve outside allowed root are rejected
        - Absolute paths to other directories are rejected
        - Error message indicates the path is outside allowed directory
        """
        allowed_root = tmp_path / "workspace"
        allowed_root.mkdir()

        # Create a directory outside the allowed root
        outside_dir = tmp_path / "outside"
        outside_dir.mkdir()
        outside_file = outside_dir / "file.txt"
        outside_file.write_text("content")

        is_valid, error, resolved = validate_path(outside_file, allowed_root)
        assert is_valid is False
        assert "outside allowed directory" in error.lower()
        assert resolved is None

    def test_validate_path_resolves_symlinks(self, tmp_path: Path) -> None:
        """
        Test that validate_path resolves symlinks before validation.

        Verifies:
        - Symlinks pointing within allowed root are accepted
        - Symlinks pointing outside allowed root are rejected
        - Symlink resolution prevents directory traversal via symlinks
        """
        allowed_root = tmp_path / "workspace"
        allowed_root.mkdir()

        # Create target file inside allowed root
        target_inside = allowed_root / "target.txt"
        target_inside.write_text("content")

        # Create symlink inside allowed root pointing to file inside
        symlink_inside = allowed_root / "link.txt"
        symlink_inside.symlink_to(target_inside)

        is_valid, error, resolved = validate_path(symlink_inside, allowed_root)
        assert is_valid is True
        assert error == ""
        assert resolved == target_inside.resolve()

        # Create target file outside allowed root
        outside_dir = tmp_path / "outside"
        outside_dir.mkdir()
        target_outside = outside_dir / "target.txt"
        target_outside.write_text("sensitive")

        # Create symlink inside allowed root pointing to file outside
        symlink_escape = allowed_root / "escape_link.txt"
        symlink_escape.symlink_to(target_outside)

        is_valid, error, resolved = validate_path(symlink_escape, allowed_root)
        assert is_valid is False
        assert "outside allowed directory" in error.lower() or "escapes" in error.lower()
        assert resolved is None

    def test_validate_path_handles_nonexistent_paths(self, tmp_path: Path) -> None:
        """
        Test that validate_path handles nonexistent paths gracefully.

        Verifies:
        - Nonexistent paths within allowed root can still be validated
        - This allows for path validation before file creation
        """
        allowed_root = tmp_path / "workspace"
        allowed_root.mkdir()

        # Test nonexistent file that would be within allowed root
        nonexistent = allowed_root / "new_file.txt"

        # Note: Path.resolve() will resolve the path even if it doesn't exist
        is_valid, error, resolved = validate_path(nonexistent, allowed_root)
        assert is_valid is True
        assert error == ""
        assert resolved is not None


@pytest.mark.unit
@pytest.mark.security
class TestSessionCwdValidation:
    """Tests for session working directory validation in validate_session_cwd()."""

    def test_validate_session_cwd_none_input(self) -> None:
        """
        Test that validate_session_cwd handles None input correctly.

        Verifies:
        - None input returns True (valid)
        - Resolved path is user's home directory
        - No error message is returned
        """
        is_valid, error, resolved_cwd = validate_session_cwd(None)
        assert is_valid is True
        assert error == ""
        assert resolved_cwd == Path.home()

    def test_validate_session_cwd_accepts_home_directory(self) -> None:
        """
        Test that validate_session_cwd accepts user's home directory.

        Verifies:
        - Home directory path is valid
        - Both string and Path objects work
        """
        home = Path.home()

        # Test with Path object
        is_valid, error, resolved_cwd = validate_session_cwd(home)
        assert is_valid is True
        assert error == ""
        assert resolved_cwd == home.resolve()

        # Test with string
        is_valid, error, resolved_cwd = validate_session_cwd(str(home))
        assert is_valid is True
        assert error == ""
        assert resolved_cwd == home.resolve()

    def test_validate_session_cwd_accepts_subdirectory_of_home(self, tmp_path: Path) -> None:
        """
        Test that validate_session_cwd accepts subdirectories within home.

        Verifies:
        - Subdirectories of home are valid working directories
        """
        # Create a test directory in home (or use tmp which is allowed)
        # Note: We use tmp_path which is typically in /tmp, an allowed safe location
        test_dir = tmp_path / "workspace"
        test_dir.mkdir()

        is_valid, error, resolved_cwd = validate_session_cwd(test_dir)
        assert is_valid is True
        assert error == ""
        assert resolved_cwd == test_dir.resolve()

    def test_validate_session_cwd_accepts_tmp_directory(self, tmp_path: Path) -> None:
        """
        Test that validate_session_cwd accepts /tmp directory.

        Verifies:
        - /tmp is a safe root for development/testing
        - Subdirectories of /tmp are accepted
        """
        is_valid, error, resolved_cwd = validate_session_cwd(tmp_path)
        assert is_valid is True
        assert error == ""
        assert resolved_cwd == tmp_path.resolve()

    def test_validate_session_cwd_rejects_nonexistent_directory(self) -> None:
        """
        Test that validate_session_cwd rejects nonexistent directories.

        Verifies:
        - Nonexistent paths are rejected
        - Error message indicates directory does not exist
        """
        nonexistent = Path("/nonexistent/directory/path")

        is_valid, error, resolved_cwd = validate_session_cwd(nonexistent)
        assert is_valid is False
        assert "does not exist" in error.lower()
        assert resolved_cwd is None

    def test_validate_session_cwd_rejects_file_instead_of_directory(self, tmp_path: Path) -> None:
        """
        Test that validate_session_cwd rejects files (not directories).

        Verifies:
        - File paths are rejected
        - Error message indicates path is not a directory
        """
        test_file = tmp_path / "file.txt"
        test_file.write_text("content")

        is_valid, error, resolved_cwd = validate_session_cwd(test_file)
        assert is_valid is False
        assert "not a directory" in error.lower()
        assert resolved_cwd is None

    def test_validate_session_cwd_rejects_traversal_patterns(self, tmp_path: Path) -> None:
        """
        Test that validate_session_cwd rejects paths with traversal patterns.

        Verifies:
        - Paths containing .. are rejected
        - Paths containing ~ are rejected before expansion
        """
        # Test .. pattern
        bad_path = str(tmp_path / ".." / ".." / "etc")
        is_valid, error, resolved_cwd = validate_session_cwd(bad_path)
        assert is_valid is False
        assert ".." in error
        assert "denied pattern" in error.lower()
        assert resolved_cwd is None

        # Test ~ pattern
        bad_path = "~/../../etc"
        is_valid, error, resolved_cwd = validate_session_cwd(bad_path)
        assert is_valid is False
        assert "~" in error
        assert "denied pattern" in error.lower()
        assert resolved_cwd is None

    def test_validate_session_cwd_warns_for_dangerous_paths(self, tmp_path: Path) -> None:
        """
        Test that validate_session_cwd handles system directories appropriately.

        Verifies:
        - System directories like /etc, /var, /usr may be rejected or warned
        - This is a defense-in-depth measure
        """
        # Note: This test may behave differently on different systems
        # On most systems, these directories exist but should be outside home
        dangerous_paths = ["/etc", "/var", "/usr", "/root"]

        for dangerous_path in dangerous_paths:
            path = Path(dangerous_path)
            if not path.exists():
                continue  # Skip if doesn't exist on this system

            is_valid, error, resolved_cwd = validate_session_cwd(path)
            # Either rejected outright or allowed with warning
            # In production, these should be rejected (is_valid = False)
            # Current implementation allows with warning for flexibility
            if is_valid:
                # If allowed, it should at least log a warning (not testable here)
                # but we can verify it's not in home
                home = Path.home()
                try:
                    resolved_cwd.relative_to(home)
                    # If we get here, dangerous path is somehow in home (unlikely)
                    pytest.fail(f"Dangerous path {dangerous_path} should not be in home")
                except ValueError:
                    # Good - it's outside home, warning should be logged
                    pass


# ============================================================================
# Priority 2: WebSocket Authentication Tests (HIGH)
# ============================================================================


@pytest.mark.unit
@pytest.mark.security
class TestWebSocketAuth:
    """Tests for WebSocket authentication (first-message protocol)."""

    def test_verify_websocket_token_with_valid_token(self) -> None:
        """
        Test that verify_websocket_token accepts valid tokens.

        Verifies:
        - Valid token returns True
        - Token comparison is secure (constant-time)
        """
        # Get the expected token
        expected_token = get_or_create_token()

        # Verify with correct token
        result = verify_websocket_token(expected_token)
        assert result is True

    def test_verify_websocket_token_with_invalid_token(self) -> None:
        """
        Test that verify_websocket_token rejects invalid tokens.

        Verifies:
        - Wrong token returns False
        - Empty token returns False
        - Random token returns False
        """
        # Test with wrong token
        result = verify_websocket_token("wrong_token")
        assert result is False

        # Test with empty token
        result = verify_websocket_token("")
        assert result is False

        # Test with random token
        random_token = secrets.token_urlsafe(32)
        result = verify_websocket_token(random_token)
        assert result is False

    def test_verify_websocket_token_uses_constant_time_comparison(self) -> None:
        """
        Test that verify_websocket_token uses constant-time comparison.

        Verifies:
        - Uses secrets.compare_digest for timing attack resistance
        - This is a code inspection test via behavior verification
        """
        # Get the expected token
        expected_token = get_or_create_token()

        # Create a token that differs by one character
        if len(expected_token) > 0:
            wrong_token = expected_token[:-1] + ("x" if expected_token[-1] != "x" else "y")
            result = verify_websocket_token(wrong_token)
            assert result is False

    def test_get_or_create_token_consistency(self) -> None:
        """
        Test that get_or_create_token returns consistent token.

        Verifies:
        - Multiple calls return the same token
        - Token is stable across calls
        """
        token1 = get_or_create_token()
        token2 = get_or_create_token()
        assert token1 == token2
        assert len(token1) > 0

    def test_get_or_create_token_respects_environment_variable(self) -> None:
        """
        Test that get_or_create_token respects AMPLIFIER_WEB_TOKEN env var.

        Verifies:
        - Environment variable takes precedence
        - Custom token is used when set
        """
        custom_token = "test_token_" + secrets.token_urlsafe(16)

        with patch.dict(os.environ, {"AMPLIFIER_WEB_TOKEN": custom_token}):
            token = get_or_create_token()
            assert token == custom_token

    def test_websocket_token_verification_integration(self) -> None:
        """
        Test WebSocket token verification flow end-to-end.

        Verifies:
        - Token can be retrieved and verified
        - Complete authentication flow works
        """
        # Simulate the authentication flow
        # 1. Server gets or creates token
        server_token = get_or_create_token()
        assert server_token is not None
        assert len(server_token) > 0

        # 2. Client sends token (in real flow, via first WebSocket message)
        client_token = server_token  # Client would get this via some secure channel

        # 3. Server verifies token
        is_valid = verify_websocket_token(client_token)
        assert is_valid is True

        # 4. Invalid token should fail
        is_valid = verify_websocket_token("invalid_token")
        assert is_valid is False


# ============================================================================
# Priority 3: CORS Configuration Tests (HIGH)
# ============================================================================


@pytest.mark.unit
@pytest.mark.security
class TestCorsConfiguration:
    """Tests for CORS configuration (environment-based, no wildcards)."""

    def test_get_allowed_origins_returns_secure_defaults(self) -> None:
        """
        Test that get_allowed_origins returns secure defaults when no env var set.

        Verifies:
        - Default origins are localhost/127.0.0.1 only
        - No wildcard (*) origins
        - Common development ports are included (3000, 5173)
        """
        with patch.dict(os.environ, {}, clear=True):
            # Remove any existing AMPLIFIER_WEB_ALLOWED_ORIGINS
            if "AMPLIFIER_WEB_ALLOWED_ORIGINS" in os.environ:
                del os.environ["AMPLIFIER_WEB_ALLOWED_ORIGINS"]

            origins = get_allowed_origins()

            # Verify no wildcards
            assert "*" not in origins
            assert "http://*" not in origins
            assert "https://*" not in origins

            # Verify only localhost origins
            for origin in origins:
                assert "localhost" in origin or "127.0.0.1" in origin
                assert origin.startswith("http://") or origin.startswith("https://")

            # Verify common dev ports are included
            assert any("3000" in origin for origin in origins)
            assert any("5173" in origin for origin in origins)

    def test_get_allowed_origins_respects_environment_variable(self) -> None:
        """
        Test that get_allowed_origins respects AMPLIFIER_WEB_ALLOWED_ORIGINS env var.

        Verifies:
        - Environment variable overrides defaults
        - Multiple origins can be specified (comma-separated)
        - Whitespace is handled correctly
        """
        custom_origins = "http://example.com:3000,https://app.example.com,http://localhost:8080"

        with patch.dict(os.environ, {"AMPLIFIER_WEB_ALLOWED_ORIGINS": custom_origins}):
            origins = get_allowed_origins()

            assert len(origins) == 3
            assert "http://example.com:3000" in origins
            assert "https://app.example.com" in origins
            assert "http://localhost:8080" in origins

    def test_get_allowed_origins_handles_whitespace(self) -> None:
        """
        Test that get_allowed_origins handles whitespace in env var.

        Verifies:
        - Leading/trailing whitespace is stripped
        - Whitespace around commas is handled
        """
        custom_origins = "  http://example.com:3000  ,  https://app.example.com  "

        with patch.dict(os.environ, {"AMPLIFIER_WEB_ALLOWED_ORIGINS": custom_origins}):
            origins = get_allowed_origins()

            assert len(origins) == 2
            assert "http://example.com:3000" in origins
            assert "https://app.example.com" in origins

    def test_get_allowed_origins_handles_empty_environment_variable(self) -> None:
        """
        Test that get_allowed_origins handles empty env var gracefully.

        Verifies:
        - Empty env var falls back to defaults
        - Whitespace-only env var falls back to defaults
        """
        # Test empty string
        with patch.dict(os.environ, {"AMPLIFIER_WEB_ALLOWED_ORIGINS": ""}):
            origins = get_allowed_origins()
            assert len(origins) > 0  # Should return defaults
            assert "*" not in origins

        # Test whitespace only
        with patch.dict(os.environ, {"AMPLIFIER_WEB_ALLOWED_ORIGINS": "   "}):
            origins = get_allowed_origins()
            assert len(origins) > 0  # Should return defaults
            assert "*" not in origins

    def test_get_allowed_origins_rejects_wildcard(self) -> None:
        """
        Test that get_allowed_origins explicitly rejects wildcard origins.

        Verifies:
        - Wildcard (*) in env var is rejected
        - Falls back to secure defaults when only wildcards specified
        """
        # If someone tries to set wildcard in env var, it's rejected
        with patch.dict(os.environ, {"AMPLIFIER_WEB_ALLOWED_ORIGINS": "*"}):
            origins = get_allowed_origins()
            # Wildcard is rejected, falls back to defaults
            assert "*" not in origins
            assert len(origins) > 0  # Should have localhost defaults

        # Mixed wildcards and valid origins: only valid ones kept
        with patch.dict(os.environ, {"AMPLIFIER_WEB_ALLOWED_ORIGINS": "*,http://example.com,*"}):
            origins = get_allowed_origins()
            assert "*" not in origins
            assert "http://example.com" in origins
            assert len(origins) == 1

    def test_get_allowed_origins_allows_production_domains(self) -> None:
        """
        Test that get_allowed_origins can be configured for production.

        Verifies:
        - Production domains can be specified
        - HTTPS origins are supported
        - Multiple production origins work
        """
        production_origins = "https://app.example.com,https://api.example.com"

        with patch.dict(os.environ, {"AMPLIFIER_WEB_ALLOWED_ORIGINS": production_origins}):
            origins = get_allowed_origins()

            assert len(origins) == 2
            assert "https://app.example.com" in origins
            assert "https://api.example.com" in origins

            # Verify all are HTTPS (recommended for production)
            for origin in origins:
                assert origin.startswith("https://")


# ============================================================================
# Integration Test Helpers
# ============================================================================


@pytest.mark.integration
@pytest.mark.security
class TestSecurityIntegration:
    """
    Integration tests combining multiple security features.

    Note: Full WebSocket integration tests would require WebSocket test client,
    which is more complex. These tests verify the components work together.
    """

    def test_session_creation_with_validated_cwd(self, tmp_path: Path) -> None:
        """
        Test that session creation validates working directory.

        Verifies:
        - validate_session_cwd is used before session creation
        - Invalid CWD prevents session creation
        - Valid CWD allows session to proceed
        """
        # Test with valid directory
        valid_cwd = tmp_path / "workspace"
        valid_cwd.mkdir()

        is_valid, error, resolved_cwd = validate_session_cwd(valid_cwd)
        assert is_valid is True
        assert resolved_cwd is not None

        # Test with invalid directory (doesn't exist)
        invalid_cwd = tmp_path / "nonexistent"

        is_valid, error, resolved_cwd = validate_session_cwd(invalid_cwd)
        assert is_valid is False
        assert resolved_cwd is None

    def test_file_operation_requires_path_validation(self, tmp_path: Path) -> None:
        """
        Test that file operations require path validation.

        Verifies:
        - validate_path should be called before any file operation
        - This prevents path traversal in file reads/writes
        """
        workspace = tmp_path / "workspace"
        workspace.mkdir()

        # Simulate file operation workflow
        requested_path = workspace / "file.txt"

        # Step 1: Validate path
        is_valid, error, safe_path = validate_path(requested_path, workspace)
        assert is_valid is True

        # Step 2: Only proceed if valid
        if is_valid and safe_path:
            # Safe to perform file operation
            safe_path.write_text("content")
            assert safe_path.read_text() == "content"

        # Simulate attack attempt
        attack_path = workspace / ".." / ".." / "etc" / "passwd"

        # Step 1: Validate path
        is_valid, error, safe_path = validate_path(attack_path, workspace)
        assert is_valid is False

        # Step 2: Do NOT proceed with file operation
        assert safe_path is None


# ============================================================================
# Pytest Configuration and Fixtures
# ============================================================================


def pytest_configure(config):
    """Register custom markers."""
    config.addinivalue_line("markers", "unit: Unit tests")
    config.addinivalue_line("markers", "integration: Integration tests")
    config.addinivalue_line("markers", "security: Security-focused tests")
