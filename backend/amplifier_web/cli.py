"""
CLI entry point for Amplifier Web server.

Provides turn-key installation with auto-generated TLS certificates and auth token.
"""

from __future__ import annotations

import os
from pathlib import Path

import click


@click.command()
@click.option("--port", default=4000, help="Port to listen on")
@click.option("--host", default="127.0.0.1", help="Host to bind to")
@click.option(
    "--cert", type=click.Path(exists=True, path_type=Path), help="TLS certificate file"
)
@click.option(
    "--key", type=click.Path(exists=True, path_type=Path), help="TLS private key file"
)
@click.option("--no-tls", is_flag=True, help="Disable TLS (not recommended)")
@click.option("--dev", is_flag=True, help="Development mode (auto-reload, no TLS)")
def main(
    port: int,
    host: str,
    cert: Path | None,
    key: Path | None,
    no_tls: bool,
    dev: bool,
) -> None:
    """Start Amplifier Web server.

    On first run, automatically generates:
    - Self-signed TLS certificate (~/.amplifier/web-cert.pem)
    - Auth token (~/.amplifier/web-auth.json)

    Examples:
        # Basic usage (generates certs, binds to localhost)
        amplifier-web

        # Bind to all interfaces
        amplifier-web --host 0.0.0.0

        # Use custom port
        amplifier-web --port 9443

        # Use your own certificates
        amplifier-web --cert /path/to/cert.pem --key /path/to/key.pem

        # Development mode (no TLS, auto-reload)
        amplifier-web --dev
    """
    import uvicorn

    from .auth import get_or_create_token, AUTH_FILE
    from .tls import get_or_create_cert, CERT_FILE, KEY_FILE

    # Development mode overrides
    if dev:
        no_tls = True
        port = int(os.environ.get("PORT", "4000"))

    # Get or create auth token
    token = get_or_create_token()

    # Determine TLS configuration
    ssl_certfile: str | None = None
    ssl_keyfile: str | None = None

    if not no_tls:
        if cert and key:
            # User-provided certificates
            ssl_certfile = str(cert)
            ssl_keyfile = str(key)
        else:
            # Auto-generated certificates
            cert_path, key_path = get_or_create_cert()
            ssl_certfile = str(cert_path)
            ssl_keyfile = str(key_path)

    # Print setup information
    protocol = "http" if no_tls else "https"
    display_host = "localhost" if host == "127.0.0.1" else host

    click.echo()
    click.echo(
        click.style(
            "╔═══════════════════════════════════════════════════════════╗", fg="cyan"
        )
    )
    click.echo(
        click.style(
            "║              Amplifier Web Server                         ║", fg="cyan"
        )
    )
    click.echo(
        click.style(
            "╚═══════════════════════════════════════════════════════════╝", fg="cyan"
        )
    )
    click.echo()

    click.echo(
        f"  Server URL:  {click.style(f'{protocol}://{display_host}:{port}', fg='green', bold=True)}"
    )
    click.echo()

    if not no_tls:
        click.echo(f"  TLS Certificate: {ssl_certfile}")
        click.echo(f"  TLS Private Key: {ssl_keyfile}")
        click.echo()
        click.echo(
            click.style("  Note: ", fg="yellow")
            + "Your browser will show a security warning for"
        )
        click.echo(
            "        self-signed certificates. This is expected - accept it once"
        )
        click.echo("        and it will be remembered.")
        click.echo()

    click.echo(f"  Auth Token File: {AUTH_FILE}")
    click.echo()
    click.echo(click.style("  Your auth token:", fg="yellow"))
    click.echo(f"    {click.style(token, fg='bright_white', bold=True)}")
    click.echo()
    click.echo("  Enter this token when prompted in the browser.")
    click.echo()
    click.echo(click.style("═" * 61, fg="cyan"))
    click.echo()

    # Set environment variables for the app
    os.environ["AMPLIFIER_WEB_HOST"] = host
    os.environ["AMPLIFIER_WEB_PORT"] = str(port)
    if not no_tls:
        os.environ["AMPLIFIER_WEB_TLS"] = "1"

    # Run the server
    uvicorn.run(
        "amplifier_web.main:app",
        host=host,
        port=port,
        ssl_certfile=ssl_certfile,
        ssl_keyfile=ssl_keyfile,
        reload=dev,
        reload_dirs=[str(Path(__file__).parent)] if dev else None,
        log_level="info",
    )


if __name__ == "__main__":
    main()
