#!/usr/bin/env python3
"""Initialize a fresh dedicated Cap directory; refuse to replace credentials."""
import argparse
import hashlib
import os
from pathlib import Path
import secrets
import shutil
import subprocess


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    root = args.directory.resolve()
    if os.geteuid() != 0:
        parser.error("root is required to set service ownership")
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    if any(root.iterdir()):
        parser.error("destination must be empty; preserve existing secrets")
    root.chmod(0o700)
    os.umask(0o077)
    source = Path(__file__).resolve().parent
    for src, dst in (("compose.example.yaml", "compose.yaml"),
                     ("valkey.example.conf", "valkey.conf")):
        shutil.copyfile(source / src, root / dst)
    tls = root / "tls"
    tls.mkdir(mode=0o755)
    tls.chmod(0o755)
    ca = root / "ca-private"
    ca.mkdir(mode=0o700)
    def openssl(*cmd):
        subprocess.run(["openssl", *cmd], check=True, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL)
    openssl("req", "-x509", "-newkey", "rsa:3072", "-nodes", "-days", "3650",
            "-subj", "/CN=Cap private storage CA", "-keyout", str(ca / "ca.key"),
            "-out", str(tls / "ca.crt"))
    openssl("req", "-new", "-newkey", "rsa:3072", "-nodes",
            "-subj", "/CN=valkey", "-keyout", str(tls / "valkey.key"),
            "-out", str(ca / "valkey.csr"))
    (ca / "server.ext").write_text("subjectAltName=DNS:valkey\nextendedKeyUsage=serverAuth\n")
    openssl("x509", "-req", "-in", str(ca / "valkey.csr"), "-CA", str(tls / "ca.crt"),
            "-CAkey", str(ca / "ca.key"), "-CAcreateserial", "-days", "825",
            "-extfile", str(ca / "server.ext"), "-out", str(tls / "valkey.crt"))
    password = secrets.token_hex(32)
    digest = hashlib.sha256(password.encode()).hexdigest()
    (root / "cap.env").write_text(
        f"ADMIN_KEY={secrets.token_hex(32)}\nVALKEY_URL=rediss://cap:{password}@valkey:6379\n")
    (root / "valkey.env").write_text(f"VALKEYCLI_AUTH={password}\n")
    (root / "users.acl").write_text(
        "user default off\n"
        f"user cap on #{digest} ~cap:* &cap:* +@read +@write +@connection +@pubsub "
        "-@dangerous +keys +scan\n")
    for name in ("users.acl", "valkey.conf"):
        os.chown(root / name, 999, 1000)
        (root / name).chmod(0o400)
    for name in ("ca.crt", "valkey.crt"):
        (tls / name).chmod(0o444)
    os.chown(tls / "valkey.key", 999, 1000)
    (tls / "valkey.key").chmod(0o400)
    for name, uid in (("cap-data", 1000), ("valkey-data", 999)):
        (root / name).mkdir(mode=0o700)
        os.chown(root / name, uid, 1000)
    print("Initialized private Cap credentials and TLS storage; no credentials printed.")


if __name__ == "__main__":
    main()
