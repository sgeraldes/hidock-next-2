"""Create endpoint-only TLS material; no certificate is installed into Windows trust."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import socket
import sys

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID


def provision(root: Path) -> dict:
    root.mkdir(parents=True, exist_ok=True)
    cert_path = root / "host-certificate.pem"
    key_path = root / "host-private-key.pem"
    if cert_path.exists() != key_path.exists():
        raise RuntimeError("Incomplete TLS identity. Repair explicitly; existing files were preserved.")
    if not cert_path.exists():
        key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
        now = datetime.datetime.now(datetime.timezone.utc)
        names = sorted({socket.gethostname().lower(), socket.getfqdn().lower(), "localhost"})
        subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, socket.gethostname())])
        cert = (x509.CertificateBuilder().subject_name(subject).issuer_name(subject)
                .public_key(key.public_key()).serial_number(x509.random_serial_number())
                .not_valid_before(now - datetime.timedelta(minutes=5))
                .not_valid_after(now + datetime.timedelta(days=365))
                .add_extension(x509.SubjectAlternativeName([x509.DNSName(name) for name in names]), False)
                .add_extension(x509.BasicConstraints(ca=False, path_length=None), True)
                .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), False)
                .sign(key, hashes.SHA256()))
        with key_path.open("xb") as stream:
            stream.write(key.private_bytes(serialization.Encoding.PEM,
                         serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        os.chmod(key_path, 0o600)
        cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    cert = x509.load_pem_x509_certificate(cert_path.read_bytes())
    return {"certificate": str(cert_path), "key": str(key_path),
            "sha256": cert.fingerprint(hashes.SHA256()).hex(),
            "hostname": socket.gethostname().lower()}


if __name__ == "__main__":
    print(json.dumps(provision(Path(sys.argv[1]).resolve())))
