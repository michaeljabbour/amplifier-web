"""
Bundle manager for Amplifier Web.

Thin wrapper around amplifier-foundation's bundle system.
Does NOT duplicate foundation logic - just provides web-app conveniences
for initialization and provider injection.
"""

from __future__ import annotations

import logging
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from amplifier_foundation import Bundle, PreparedBundle
    from amplifier_foundation.registry import BundleRegistry

logger = logging.getLogger(__name__)


@dataclass
class BundleInfo:
    """Minimal info about a bundle for API responses."""
    name: str
    description: str = ""
    is_custom: bool = False
    uri: str | None = None


# Security: Paths that should never be accessible via file:// URIs
DENIED_PATH_PATTERNS = [
    "/etc",
    "/var",
    "/usr",
    "/bin",
    "/sbin",
    "/System",
    "/Library",
    "/private",
    "/root",
]

# Security: Paths that are allowed for file:// URIs
ALLOWED_PATH_ROOTS = [
    Path.home(),
    Path("/tmp"),
]


class BundleManager:
    """
    Thin wrapper around amplifier-foundation's bundle system.

    Responsibilities (app-layer policy):
    - Add submodule paths to sys.path on init
    - Provide registry instance
    - Compose provider credentials at runtime (never stored in bundles)

    NOT responsible for (foundation handles):
    - Bundle discovery, loading, parsing
    - Module activation and resolution
    - Session creation
    """

    def __init__(self, modules_dir: Path | None = None):
        """
        Initialize bundle manager.

        Args:
            modules_dir: Directory containing amplifier submodules.
                         If provided, adds them to sys.path.
        """
        self._modules_dir = modules_dir
        self._registry: BundleRegistry | None = None
        self._initialized = False

    async def initialize(self) -> None:
        """
        Initialize by adding submodules to path and importing foundation.

        This is the ONLY place we touch sys.path - foundation handles everything else.
        """
        if self._initialized:
            return

        # Add submodules to sys.path if available
        if self._modules_dir:
            for subdir in ["amplifier-core", "amplifier-foundation", "amplifier-app-cli"]:
                module_path = self._modules_dir / subdir
                if module_path.exists() and str(module_path) not in sys.path:
                    sys.path.insert(0, str(module_path))
                    logger.info(f"Added {module_path} to sys.path")

        try:
            from amplifier_foundation.registry import BundleRegistry

            self._registry = BundleRegistry()
            self._initialized = True
            logger.info("Bundle manager initialized with amplifier-foundation")

        except ImportError as e:
            logger.error(f"Failed to import amplifier-foundation: {e}")
            raise RuntimeError(
                "amplifier-foundation not available. "
                "Ensure submodules are initialized or packages are installed."
            ) from e

    @property
    def registry(self) -> "BundleRegistry":
        """Get the bundle registry. Must call initialize() first."""
        if not self._registry:
            raise RuntimeError("BundleManager not initialized. Call initialize() first.")
        return self._registry

    async def load_and_prepare(
        self,
        bundle_name: str,
        behaviors: list[str] | None = None,
        provider_config: dict[str, Any] | None = None,
    ) -> "PreparedBundle":
        """
        Load a bundle, compose behaviors, inject provider config, and prepare.

        This is the main entry point for web sessions.

        Args:
            bundle_name: Bundle to load (e.g., "foundation", "amplifier-dev")
            behaviors: Optional behavior bundles to compose (e.g., ["streaming-ui"])
            provider_config: Optional provider config to inject (app-layer credentials)

        Returns:
            PreparedBundle ready for create_session()

        Note:
            Working directory is now handled by passing session_cwd to create_session().
            All modules query the coordinator capability instead of using config injection.

        Example:
            prepared = await manager.load_and_prepare(
                "foundation",
                behaviors=["streaming-ui"],
                provider_config={
                    "module": "provider-anthropic",
                    "config": {"api_key": os.getenv("ANTHROPIC_API_KEY")}
                }
            )
            session = await prepared.create_session(
                approval_system=my_approval,
                display_system=my_display,
                session_cwd=user_project_path,  # Working dir passed here now
            )
        """
        await self.initialize()

        from amplifier_foundation import Bundle
        from amplifier_foundation.registry import load_bundle

        # Load the base bundle
        bundle = await load_bundle(bundle_name, registry=self._registry)
        logger.info(f"Loaded bundle: {bundle_name}")

        # Compose with behaviors if specified
        if behaviors:
            for behavior_name in behaviors:
                # Behaviors are typically namespaced like "foundation:behaviors/streaming-ui"
                # or can be full bundle names
                behavior_ref = behavior_name
                if ":" not in behavior_name and "/" not in behavior_name:
                    # Short name - assume foundation behavior
                    behavior_ref = f"foundation:behaviors/{behavior_name}"

                try:
                    behavior_bundle = await load_bundle(behavior_ref, registry=self._registry)
                    bundle = bundle.compose(behavior_bundle)
                    logger.info(f"Composed behavior: {behavior_name}")
                except Exception as e:
                    logger.warning(f"Failed to load behavior '{behavior_name}': {e}")

        # Note: Working directory is now handled via the unified session.working_dir
        # coordinator capability. Pass session_cwd to create_session() and all modules
        # will query the capability automatically. No config injection needed.

        # Enable debug and raw_debug for full event visibility in web console
        debug_bundle = Bundle(
            name="web-debug-config",
            version="1.0.0",
            session={"debug": True, "raw_debug": True},
        )
        bundle = bundle.compose(debug_bundle)
        logger.info("Enabled debug and raw_debug for web event visibility")

        # Compose with provider config if specified (app-layer credential injection)
        if provider_config:
            provider_bundle = Bundle(
                name="app-provider-config",
                version="1.0.0",
                providers=[provider_config],
            )
            bundle = bundle.compose(provider_bundle)
            logger.info(f"Injected provider config: {provider_config.get('module')}")
        else:
            # Auto-detect provider from environment variables
            provider_bundle = await self._auto_detect_provider()
            if provider_bundle:
                bundle = bundle.compose(provider_bundle)

        # Prepare the bundle (downloads modules, creates resolver)
        prepared = await bundle.prepare()
        logger.info(f"Bundle prepared: {bundle_name}")

        return prepared

    async def _auto_detect_provider(self) -> "Bundle | None":
        """
        Auto-detect provider from environment variables.

        Checks for API keys and creates the corresponding provider bundle.
        Priority: Anthropic > OpenAI

        Returns:
            Provider Bundle if API key found, None otherwise.
        """
        from amplifier_foundation import Bundle

        # Check for Anthropic API key
        if os.getenv("ANTHROPIC_API_KEY"):
            try:
                provider = Bundle(
                    name="auto-provider-anthropic",
                    version="1.0.0",
                    providers=[{
                        "module": "provider-anthropic",
                        "source": "git+https://github.com/microsoft/amplifier-module-provider-anthropic@main",
                        "config": {
                            "default_model": "claude-sonnet-4-5",
                            "debug": True,
                            "raw_debug": True,
                        }
                    }],
                )
                logger.info("Auto-detected Anthropic provider from environment")
                return provider
            except Exception as e:
                logger.warning(f"Failed to create Anthropic provider: {e}")

        # Check for OpenAI API key
        if os.getenv("OPENAI_API_KEY"):
            try:
                provider = Bundle(
                    name="auto-provider-openai",
                    version="1.0.0",
                    providers=[{
                        "module": "provider-openai",
                        "source": "git+https://github.com/microsoft/amplifier-module-provider-openai@main",
                        "config": {
                            "default_model": "gpt-4o",
                            "debug": True,
                            "raw_debug": True,
                        }
                    }],
                )
                logger.info("Auto-detected OpenAI provider from environment")
                return provider
            except Exception as e:
                logger.warning(f"Failed to create OpenAI provider: {e}")

        logger.warning("No API key found in environment (ANTHROPIC_API_KEY or OPENAI_API_KEY)")
        return None

    async def list_bundles(self) -> list[BundleInfo]:
        """
        List available bundles from registry, including custom bundles.

        Returns:
            List of BundleInfo with name and description.
        """
        await self.initialize()

        from .preferences import load_preferences

        bundles = []

        # Common bundles that should always be available
        common = [
            ("foundation", "Core foundation bundle with tools and agents"),
            ("amplifier-dev", "Bundle for Amplifier ecosystem development"),
        ]

        for name, desc in common:
            bundles.append(BundleInfo(name=name, description=desc))

        # Add custom bundles from preferences
        prefs = load_preferences()
        for custom in prefs.custom_bundles:
            bundles.append(BundleInfo(
                name=custom.get("name", "unknown"),
                description=custom.get("description", ""),
                is_custom=True,
                uri=custom.get("uri"),
            ))

        return bundles

    async def get_bundle_info(self, bundle_name: str) -> dict[str, Any]:
        """
        Get information about a specific bundle.

        Args:
            bundle_name: Bundle to query

        Returns:
            Dict with bundle metadata
        """
        await self.initialize()

        from amplifier_foundation.registry import load_bundle

        bundle = await load_bundle(bundle_name, registry=self._registry)

        return {
            "name": bundle.name,
            "version": bundle.version,
            "has_instruction": bool(bundle.instruction),
            "tools": [t.get("module") for t in bundle.tools],
            "providers": [p.get("module") for p in bundle.providers],
            "agents": list(bundle.agents.keys()) if bundle.agents else [],
        }

    def validate_file_path(self, uri: str) -> tuple[bool, str | None]:
        """
        Validate a file:// URI for security.

        Paths must be under home directory or /tmp, and not in system directories.

        Args:
            uri: The file:// URI to validate.

        Returns:
            Tuple of (is_valid, error_message).
            If valid, error_message is None.
        """
        if not uri.startswith("file://"):
            return False, "URI must start with file://"

        # Extract path from URI
        path_str = uri[7:]  # Remove "file://"

        # Expand ~ to home directory
        if path_str.startswith("~"):
            path_str = str(Path.home()) + path_str[1:]

        try:
            path = Path(path_str).resolve()
        except Exception as e:
            return False, f"Invalid path: {e}"

        # Check for path traversal attempts
        if ".." in str(path):
            return False, "Path traversal not allowed"

        # Check against denied patterns
        path_str_resolved = str(path)
        for denied in DENIED_PATH_PATTERNS:
            if path_str_resolved.startswith(denied):
                return False, f"Access to {denied} not allowed"

        # Check against allowed roots
        for allowed in ALLOWED_PATH_ROOTS:
            try:
                if path.is_relative_to(allowed):
                    # Path must exist
                    if not path.exists():
                        return False, f"Path does not exist: {path}"
                    return True, None
            except ValueError:
                continue

        return False, "Path must be under home directory or /tmp"

    async def validate_bundle_uri(self, uri: str) -> dict[str, Any]:
        """
        Validate a bundle URI and return info about it.

        Supports:
        - git+https://github.com/org/repo[@ref]
        - file:///path/to/bundle.yaml

        Args:
            uri: The bundle URI to validate.

        Returns:
            Dict with validation result and bundle info if valid.
        """
        await self.initialize()

        result: dict[str, Any] = {
            "valid": False,
            "uri": uri,
            "error": None,
            "bundle_info": None,
        }

        # Validate URI format
        if uri.startswith("file://"):
            valid, error = self.validate_file_path(uri)
            if not valid:
                result["error"] = error
                return result

            # Try to load the bundle to verify it's valid
            try:
                from amplifier_foundation.registry import load_bundle

                # Extract the actual path
                path_str = uri[7:]
                if path_str.startswith("~"):
                    path_str = str(Path.home()) + path_str[1:]

                bundle = await load_bundle(path_str, registry=self._registry)
                result["valid"] = True
                result["bundle_info"] = {
                    "name": bundle.name,
                    "version": bundle.version,
                    "description": getattr(bundle, "description", ""),
                }
            except Exception as e:
                result["error"] = f"Failed to load bundle: {e}"

        elif uri.startswith("git+https://"):
            # Git URL validation - basic format check
            # Format: git+https://github.com/org/repo[@ref]
            git_url = uri[4:]  # Remove "git+" prefix

            if not git_url.startswith("https://"):
                result["error"] = "Git URL must use HTTPS"
                return result

            # Try to load via foundation's git support
            try:
                from amplifier_foundation.registry import load_bundle

                bundle = await load_bundle(uri, registry=self._registry)
                result["valid"] = True
                result["bundle_info"] = {
                    "name": bundle.name,
                    "version": bundle.version,
                    "description": getattr(bundle, "description", ""),
                }
            except Exception as e:
                result["error"] = f"Failed to load bundle from git: {e}"

        else:
            result["error"] = "URI must start with 'git+https://' or 'file://'"

        return result

    async def register_custom_bundle(
        self,
        uri: str,
        name: str | None = None,
        description: str | None = None,
    ) -> dict[str, Any]:
        """
        Register a custom bundle by URI.

        Args:
            uri: The bundle URI (git+https:// or file://)
            name: Optional display name (derived from bundle if not provided)
            description: Optional description (derived from bundle if not provided)

        Returns:
            Dict with registration result and bundle info.
        """
        # First validate the URI
        validation = await self.validate_bundle_uri(uri)
        if not validation["valid"]:
            return {
                "success": False,
                "error": validation["error"],
            }

        # Use bundle name if not provided
        bundle_info = validation["bundle_info"]
        final_name = name or bundle_info.get("name", "custom-bundle")
        final_description = description or bundle_info.get("description", "Custom bundle")

        # Save to preferences
        from .preferences import add_custom_bundle

        add_custom_bundle(uri, final_name, final_description)

        return {
            "success": True,
            "name": final_name,
            "description": final_description,
            "uri": uri,
            "bundle_info": bundle_info,
        }

    async def unregister_custom_bundle(self, name: str) -> dict[str, Any]:
        """
        Remove a custom bundle registration.

        Args:
            name: The bundle name to remove.

        Returns:
            Dict with removal result.
        """
        from .preferences import load_preferences, remove_custom_bundle

        prefs = load_preferences()

        # Check if bundle exists
        exists = any(b.get("name") == name for b in prefs.custom_bundles)
        if not exists:
            return {
                "success": False,
                "error": f"Bundle '{name}' not found",
            }

        remove_custom_bundle(name)
        return {
            "success": True,
            "name": name,
        }
