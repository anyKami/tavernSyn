import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("update", Path(__file__).resolve().parents[1] / "vps/update.py")
update = importlib.util.module_from_spec(spec)
spec.loader.exec_module(update)


class UpdateTests(unittest.TestCase):
    def test_keepalive_only_changes_the_dedicated_account(self):
        config = "Match User admin\n    ClientAliveInterval 600\nMatch User tavernsyn\n    PasswordAuthentication yes\n    ClientAliveInterval 90\n    ClientAliveCountMax 5\nMatch User tavernsyn Address *,!100.64.0.0/10\n    DenyUsers *\nMatch all\n"
        updated = update.keepalive(config, "tavernsyn")
        self.assertIn("Match User admin\n    ClientAliveInterval 600\n", updated)
        self.assertIn("Match User tavernsyn\n    ClientAliveInterval 15\n    ClientAliveCountMax 3\n    PasswordAuthentication yes", updated)
        self.assertIn("Match User tavernsyn Address *,!100.64.0.0/10\n    DenyUsers *\nMatch all", updated)
        self.assertEqual(update.keepalive(updated, "tavernsyn"), updated)

    def test_unknown_or_ambiguous_account_block_is_refused(self):
        for config in ("Match User admin\n", "Match User tavernsyn\nMatch User tavernsyn\n"):
            with self.assertRaises(RuntimeError):
                update.keepalive(config, "tavernsyn")


if __name__ == "__main__":
    unittest.main()
