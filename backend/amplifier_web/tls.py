"""
TLS certificate management for Amplifier Web.

Auto-generates self-signed certificates for turn-key HTTPS setup.
"""

from __future__ import annotations

import datetime
import ipaddress
import socket
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

# Certificate storage locations
CERT_DIR = Path.home() / ".amplifier"
CERT_FILE = CERT_DIR / "web-cert.pem"
KEY_FILE = CERT_DIR / "web-key.pem"


def get_or_create_cert() -> tuple[Path, Path]:
    """
    Get existing TLS certificate or generate a new self-signed one.

    The certificate is valid for:
    - localhost
    - 127.0.0.1
    - Machine hostname

    Returns:
        Tuple of (certificate_path, key_path)
    """
    if CERT_FILE.exists() and KEY_FILE.exists():
        # Verify the certificate is not expired
        try:
            cert_data = CERT_FILE.read_bytes()
            cert = x509.load_pem_x509_certificate(cert_data)
            if cert.not_valid_after_utc > datetime.datetime.now(datetime.timezone.utc):
                return CERT_FILE, KEY_FILE
        except Exception:
            pass  # Regenerate if we can't read the cert

    return _generate_self_signed_cert()


def _generate_self_signed_cert() -> tuple[Path, Path]:
    """
    Generate a new self-signed certificate.

    Returns:
        Tuple of (certificate_path, key_path)
    """
    # Generate private key
    key = rsa.generate_private_key(
        public_exponent=65537,
        key_size=2048,
    )

    # Get hostname for certificate
    hostname = socket.gethostname()

    # Build certificate subject
    subject = issuer = x509.Name(
        [
            x509.NameAttribute(NameOID.COMMON_NAME, hostname),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Amplifier Web"),
        ]
    )

    # Build Subject Alternative Names (SAN)
    san_entries: list[x509.GeneralName] = [
        x509.DNSName("localhost"),
        x509.DNSName(hostname),
        x509.IPAddress(ipaddress.IPv4Address("127.0.0.1")),
    ]

    # Try to add the machine's actual IP address
    try:
        local_ip = socket.gethostbyname(hostname)
        if local_ip != "127.0.0.1":
            san_entries.append(x509.IPAddress(ipaddress.IPv4Address(local_ip)))
    except socket.gaierror:
        pass

    # Build the certificate
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.datetime.now(datetime.timezone.utc))
        .not_valid_after(
            datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=365)
        )
        .add_extension(
            x509.SubjectAlternativeName(san_entries),
            critical=False,
        )
        .add_extension(
            x509.BasicConstraints(ca=False, path_length=None),
            critical=True,
        )
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                key_encipherment=True,
                content_commitment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=False,
                crl_sign=False,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(
            x509.ExtendedKeyUsage([x509.oid.ExtendedKeyUsageOID.SERVER_AUTH]),
            critical=False,
        )
        .sign(key, hashes.SHA256())
    )

    # Ensure directory exists with appropriate permissions
    CERT_DIR.mkdir(parents=True, exist_ok=True)

    # Save private key (readable only by owner)
    key_bytes = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.TraditionalOpenSSL,
        encryption_algorithm=serialization.NoEncryption(),
    )
    KEY_FILE.write_bytes(key_bytes)
    KEY_FILE.chmod(0o600)

    # Save certificate
    cert_bytes = cert.public_bytes(serialization.Encoding.PEM)
    CERT_FILE.write_bytes(cert_bytes)
    CERT_FILE.chmod(0o644)

    return CERT_FILE, KEY_FILE
