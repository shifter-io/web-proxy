import importlib.util
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).parent
spec = importlib.util.spec_from_file_location("cap_init", SOURCE / "initialize.example.py")
initializer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(initializer)


class InitializeTests(unittest.TestCase):
    def test_fresh_credentials_permissions_and_refusal_to_overwrite(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve() / "cap"
            root.mkdir(mode=0o755)
            root.chmod(0o755)
            with patch.object(sys, "argv", ["initialize", str(root)]), \
                    patch.object(initializer.os, "geteuid", return_value=0), \
                    patch.object(initializer.os, "chown") as chown:
                initializer.main()
                original = (root / "cap.env").read_bytes()
                self.assertEqual(stat.S_IMODE(root.stat().st_mode), 0o700)
                self.assertEqual(stat.S_IMODE((root / "tls").stat().st_mode), 0o755)
                for name in ("cap.env", "valkey.env", "ca-private/ca.key"):
                    self.assertEqual(stat.S_IMODE((root / name).stat().st_mode), 0o600)
                self.assertEqual(stat.S_IMODE((root / "tls/valkey.key").stat().st_mode), 0o400)
                self.assertIn("user default off", (root / "users.acl").read_text())
                self.assertIn("~cap:* &cap:*", (root / "users.acl").read_text())
                chown.assert_any_call(root / "tls/valkey.key", 999, 1000)
                subprocess.run(["openssl", "verify", "-CAfile", str(root / "tls/ca.crt"),
                                str(root / "tls/valkey.crt")], check=True, capture_output=True)
                with self.assertRaises(SystemExit):
                    initializer.main()
                self.assertEqual(original, (root / "cap.env").read_bytes())

    def test_nonroot_fails_before_creating_directory(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "cap"
            with patch.object(sys, "argv", ["initialize", str(root)]), \
                    patch.object(initializer.os, "geteuid", return_value=1000):
                with self.assertRaises(SystemExit):
                    initializer.main()
            self.assertFalse(root.exists())

    def test_compose_keeps_storage_private(self):
        compose = (SOURCE / "compose.example.yaml").read_text()
        storage = compose.split("\n  valkey:\n", 1)[1].split("\nnetworks:", 1)[0]
        self.assertNotIn("ports:", storage)
        self.assertNotIn("network_mode:", storage)
        self.assertIn("networks: [cap_state]", storage)
        self.assertIn("internal: true", compose)
        self.assertIn("gateway_mode_ipv4: isolated", compose)
        self.assertIn("gateway_mode_ipv6: isolated", compose)
        self.assertIn("condition: service_healthy", compose)
        config = (SOURCE / "valkey.example.conf").read_text()
        self.assertIn("\nport 0\n", config)
        self.assertIn("protected-mode yes", config)
        self.assertIn("tls-port 6379", config)


if __name__ == "__main__":
    unittest.main()
