"""The host sampler writes its file atomically inside the state directory, whatever the current directory."""
import importlib.util
import os
import tempfile
import unittest
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[2] / "deployment/v2/host_health.py"
spec = importlib.util.spec_from_file_location("host_health_sampler", SCRIPT)
sampler = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sampler)

PROC_STAT = "cpu  100 0 50 800 50 0 0 0 0 0\n"
PROC_MEMINFO = "MemTotal: 1000 kB\nMemFree: 200 kB\nMemAvailable: 400 kB\n"


class CollectTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.state = Path(temporary.name) / "state"
        self.elsewhere = Path(temporary.name) / "elsewhere"
        self.elsewhere.mkdir()
        previous = os.getcwd()
        os.chdir(self.elsewhere)
        self.addCleanup(os.chdir, previous)

    def test_the_temporary_file_is_written_beside_its_target(self):
        renames = []
        real_replace = os.replace

        def replace(source, target):
            renames.append((Path(source), Path(target)))
            real_replace(source, target)

        with patch.object(sampler.os, "replace", side_effect=replace):
            result = sampler.collect(self.state, at=datetime(2026, 11, 6, 12, tzinfo=UTC),
                                     proc_stat=PROC_STAT, proc_meminfo=PROC_MEMINFO,
                                     filesystem=os.statvfs(self.state.parent))
        [(source, target)] = renames
        # A temporary file in another directory could sit on another filesystem, where a
        # rename is not atomic, or in a directory the sampler's user cannot write.
        self.assertEqual(source.parent, self.state)
        self.assertEqual(target, self.state / "host-health.json")
        self.assertEqual(list(self.elsewhere.iterdir()), [], "nothing is left in the current directory")
        self.assertEqual(sorted(path.name for path in self.state.iterdir()),
                         ["host-health.json", "host-health.lock"], "no temporary file is left behind")
        self.assertEqual(result["current"]["memory"]["used_bytes"], 600 * 1024)


if __name__ == "__main__":
    unittest.main()
