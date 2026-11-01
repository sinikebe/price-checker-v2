"""Root-side reads and writes in the backend-writable state directory never follow a link."""
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "deployment/v2"))
import state_files  # noqa: E402


class StateFilesTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.state = Path(self.temporary.name) / "state"
        self.state.mkdir()
        self.outside = Path(self.temporary.name) / "outside.json"
        self.outside.write_text('{"secret": true}')

    def test_reads_a_small_json_object_and_reports_a_missing_file(self):
        (self.state / "a.json").write_text('{"x": 1}')
        self.assertEqual(state_files.read_json(self.state / "a.json"), {"x": 1})
        self.assertIsNone(state_files.read_json(self.state / "missing.json"))

    def test_refuses_content_that_is_not_a_small_json_object(self):
        for name, content in (("list.json", "[1]"), ("bad.json", "{oops"), ("big.json", '{"a": "' + "x" * 70000 + '"}')):
            (self.state / name).write_text(content)
            with self.assertRaises(ValueError, msg=name):
                state_files.read_json(self.state / name)

    def test_never_follows_a_link_or_waits_on_a_pipe(self):
        os.symlink(self.outside, self.state / "link.json")
        with self.assertRaises(ValueError):
            state_files.read_json(self.state / "link.json")
        os.mkfifo(self.state / "pipe.json")
        with self.assertRaises(ValueError):  # returns at once: the pipe is never read
            state_files.read_json(self.state / "pipe.json")
        (self.state / "folder.json").mkdir()
        with self.assertRaises(ValueError):
            state_files.read_json(self.state / "folder.json")

    def test_a_lock_is_created_but_never_through_a_link(self):
        descriptor = state_files.open_lock(self.state / "update.lock")
        os.close(descriptor)
        self.assertTrue((self.state / "update.lock").is_file())
        target = Path(self.temporary.name) / "created-by-mistake"
        os.symlink(target, self.state / "dangling.lock")
        with self.assertRaises(ValueError):
            state_files.open_lock(self.state / "dangling.lock")
        self.assertFalse(target.exists(), "a dangling link must not create its target")
        os.symlink(self.outside, self.state / "linked.lock")
        with self.assertRaises(ValueError):
            state_files.open_lock(self.state / "linked.lock")
        (self.state / "folder.lock").mkdir()
        with self.assertRaises(ValueError):
            state_files.open_lock(self.state / "folder.lock")

    def test_a_write_replaces_a_link_without_touching_its_target(self):
        os.chmod(self.outside, 0o600)
        os.symlink(self.outside, self.state / "last.json")
        state_files.write_json(self.state / "last.json", {"ok": True})
        self.assertFalse((self.state / "last.json").is_symlink())
        self.assertEqual(json.loads((self.state / "last.json").read_text()), {"ok": True})
        self.assertEqual(self.outside.read_text(), '{"secret": true}')
        self.assertEqual(stat.S_IMODE(self.outside.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE((self.state / "last.json").stat().st_mode), 0o644)
        self.assertEqual([item.name for item in self.state.iterdir()], ["last.json"], "no temporary file is left")

    def test_a_failed_write_leaves_nothing_behind(self):
        (self.state / "folder.json").mkdir()
        with self.assertRaises(OSError):
            state_files.write_json(self.state / "folder.json", {"a": 1})
        self.assertEqual([item.name for item in self.state.iterdir()], ["folder.json"])

    def test_remove_deletes_files_and_links_only(self):
        (self.state / "request.json").write_text("{}")
        state_files.remove_regular(self.state / "request.json")
        os.symlink(self.outside, self.state / "link.json")
        state_files.remove_regular(self.state / "link.json")
        state_files.remove_regular(self.state / "missing.json")
        self.assertTrue(self.outside.exists())
        (self.state / "folder.json").mkdir()
        with self.assertRaises(ValueError):
            state_files.remove_regular(self.state / "folder.json")


if __name__ == "__main__":
    unittest.main()
