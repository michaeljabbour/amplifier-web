"""
User preferences storage for Amplifier Web.

Stores user preferences in ~/.amplifier/web-preferences.json.
Single-user model: the whole ~/.amplifier/ belongs to whoever runs the server.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any

# Preferences storage location
PREFS_DIR = Path.home() / ".amplifier"
PREFS_FILE = PREFS_DIR / "web-preferences.json"


@dataclass
class UserPreferences:
    """User preferences for Amplifier Web."""

    # Default bundle to use when creating new sessions
    default_bundle: str = "foundation"

    # Default behaviors to apply
    # Sessions behavior enables automatic session naming after turn 2
    default_behaviors: list[str] = field(default_factory=lambda: ["sessions"])

    # Display options
    show_thinking: bool = True

    # Default working directory for tools
    default_cwd: str | None = None

    # Custom bundles registered by the user
    # List of dicts with uri, name, description
    custom_bundles: list[dict[str, str]] = field(default_factory=list)

    # Custom behaviors registered by the user
    # List of dicts with uri, name, description
    custom_behaviors: list[dict[str, str]] = field(default_factory=list)


def load_preferences() -> UserPreferences:
    """
    Load user preferences from file.

    Returns:
        UserPreferences instance (with defaults if file doesn't exist).
    """
    if not PREFS_FILE.exists():
        return UserPreferences()

    try:
        data = json.loads(PREFS_FILE.read_text())
        return UserPreferences(
            default_bundle=data.get("default_bundle", "foundation"),
            default_behaviors=data.get("default_behaviors", ["sessions"]),
            show_thinking=data.get("show_thinking", True),
            default_cwd=data.get("default_cwd"),
            custom_bundles=data.get("custom_bundles", []),
            custom_behaviors=data.get("custom_behaviors", []),
        )
    except (json.JSONDecodeError, KeyError):
        return UserPreferences()


def save_preferences(prefs: UserPreferences) -> None:
    """
    Save user preferences to file.

    Args:
        prefs: The preferences to save.
    """
    PREFS_DIR.mkdir(parents=True, exist_ok=True)
    PREFS_FILE.write_text(json.dumps(asdict(prefs), indent=2))


def add_custom_bundle(uri: str, name: str, description: str = "") -> UserPreferences:
    """
    Add a custom bundle to preferences.

    Args:
        uri: The bundle URI (git+https:// or file://)
        name: Display name for the bundle
        description: Optional description

    Returns:
        Updated preferences.
    """
    prefs = load_preferences()

    # Check if already exists
    for bundle in prefs.custom_bundles:
        if bundle.get("uri") == uri:
            # Update existing
            bundle["name"] = name
            bundle["description"] = description
            save_preferences(prefs)
            return prefs

    # Add new
    prefs.custom_bundles.append({
        "uri": uri,
        "name": name,
        "description": description,
    })
    save_preferences(prefs)
    return prefs


def remove_custom_bundle(name: str) -> UserPreferences:
    """
    Remove a custom bundle from preferences.

    Args:
        name: The bundle name to remove.

    Returns:
        Updated preferences.
    """
    prefs = load_preferences()
    prefs.custom_bundles = [
        b for b in prefs.custom_bundles if b.get("name") != name
    ]
    save_preferences(prefs)
    return prefs


def add_custom_behavior(uri: str, name: str, description: str = "") -> UserPreferences:
    """
    Add a custom behavior to preferences.

    Args:
        uri: The behavior URI (git+https:// or file://)
        name: Display name for the behavior
        description: Optional description

    Returns:
        Updated preferences.
    """
    prefs = load_preferences()

    # Check if already exists
    for behavior in prefs.custom_behaviors:
        if behavior.get("uri") == uri:
            # Update existing
            behavior["name"] = name
            behavior["description"] = description
            save_preferences(prefs)
            return prefs

    # Add new
    prefs.custom_behaviors.append({
        "uri": uri,
        "name": name,
        "description": description,
    })
    save_preferences(prefs)
    return prefs


def remove_custom_behavior(name: str) -> UserPreferences:
    """
    Remove a custom behavior from preferences.

    Args:
        name: The behavior name to remove.

    Returns:
        Updated preferences.
    """
    prefs = load_preferences()
    prefs.custom_behaviors = [
        b for b in prefs.custom_behaviors if b.get("name") != name
    ]
    save_preferences(prefs)
    return prefs


def update_preferences(updates: dict[str, Any]) -> UserPreferences:
    """
    Update specific preference fields.

    Args:
        updates: Dict of field names to new values.

    Returns:
        Updated preferences.
    """
    prefs = load_preferences()

    if "default_bundle" in updates:
        prefs.default_bundle = updates["default_bundle"]
    if "default_behaviors" in updates:
        prefs.default_behaviors = updates["default_behaviors"]
    if "show_thinking" in updates:
        prefs.show_thinking = updates["show_thinking"]
    if "default_cwd" in updates:
        prefs.default_cwd = updates["default_cwd"]

    save_preferences(prefs)
    return prefs
