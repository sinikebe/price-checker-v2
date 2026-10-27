"""Production legal pages must be supplied by the instance, not the checkout."""

from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

CHECKER = Path(__file__).resolve().parents[2] / "deployment/v2/check-legal-docs.py"
DOCUMENTS = ("mentions", "confidentialite", "conditions")


class LegalDocumentChecks(unittest.TestCase):
    def test_requires_three_real_nonempty_utf8_documents(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / "legal"
            directory.mkdir()

            def check():
                return subprocess.run(
                    [sys.executable, str(CHECKER), str(directory)],
                    capture_output=True, text=True, check=False,
                ).returncode

            self.assertNotEqual(check(), 0)
            for name in DOCUMENTS:
                (directory / f"{name}.md").write_text(f"## {name}\n\nTexte réel.\n")
            self.assertEqual(check(), 0)
            (directory / "mentions.md").write_text("  \n")
            self.assertNotEqual(check(), 0)
            (directory / "mentions.md").write_bytes(b"\xff")
            self.assertNotEqual(check(), 0)
            (directory / "mentions.md").write_text("a" * (128 * 1024 + 1))
            self.assertNotEqual(check(), 0)
            (directory / "mentions.md").unlink()
            (directory / "mentions.md").symlink_to(directory / "conditions.md")
            self.assertNotEqual(check(), 0)


if __name__ == "__main__":
    unittest.main()
