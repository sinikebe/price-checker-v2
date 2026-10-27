"""Updater backups expire only after a recent verified replacement exists."""

from __future__ import annotations

import importlib.util
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "deployment/v2/prune_local_backups.py"
spec = importlib.util.spec_from_file_location("prune_local_backups", SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class BackupPruneTests(unittest.TestCase):
    def test_only_old_recognized_artifacts_are_removed(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            old = directory / "20260301T120000Z-abcdef0.dump"
            old.write_bytes(b"old")
            fresh = directory / "20261001T120000Z-abcdef1.dump"
            fresh.write_bytes(b"new")
            unknown = directory / "manual-note.dump"
            unknown.write_bytes(b"keep")
            cert = directory / "db-cert-20260301T120000Z-abcdef0"
            cert.mkdir()
            (cert / "server.key").write_bytes(b"key")
            (cert / "server.crt").write_bytes(b"crt")
            removed = module.prune(
                directory, fresh, now=datetime(2026, 10, 26, tzinfo=timezone.utc)
            )
            self.assertCountEqual(removed, [old.name, cert.name])
            self.assertFalse(old.exists())
            self.assertFalse(cert.exists())
            self.assertTrue(fresh.exists())
            self.assertTrue(unknown.exists())

    def test_no_recent_dump_means_no_pruning(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            old = directory / "20260301T120000Z-abcdef0.dump"
            old.write_bytes(b"old")
            with self.assertRaises(ValueError):
                module.prune(directory, old, now=datetime(2026, 10, 26, tzinfo=timezone.utc))
            self.assertTrue(old.exists())
