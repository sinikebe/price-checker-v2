"""Timezone and CI safety tests for the root timer, without systemd or Docker."""
import importlib.util
import json
import os
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[2] / "deployment/v2/scheduled_update.py"
spec = importlib.util.spec_from_file_location("scheduled_update", SCRIPT)
with patch.dict(os.environ, {"PRICE_CHECKER_V2_DATA_DIR": "/tmp/price-checker-v2-test"}):
    scheduler = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(scheduler)


class ScheduledUpdateTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        directory = Path(self.temporary.name)
        (directory / "state").mkdir()
        self.old_data, self.old_state = scheduler.DATA, scheduler.STATE
        scheduler.DATA, scheduler.STATE = directory, directory / "state"
        self.addCleanup(self._restore)

    def _restore(self):
        scheduler.DATA, scheduler.STATE = self.old_data, self.old_state

    def test_due_uses_paris_timezone_and_disabled_is_noop(self):
        now = datetime(2026, 10, 26, 1, 0, tzinfo=timezone.utc)
        schedule = {"enabled": True, "time": "02:00", "timezone": "Europe/Paris", "revision": 1}
        (scheduler.STATE / "update-schedule.json").write_text(json.dumps(schedule))
        self.assertIsNotNone(scheduler.schedule_at(now))
        self.assertIsNone(scheduler.schedule_at(now.replace(hour=2)))
        schedule["enabled"] = False
        (scheduler.STATE / "update-schedule.json").write_text(json.dumps(schedule))
        self.assertIsNone(scheduler.schedule_at(now))

    def test_dst_skipped_hour_and_repeated_day(self):
        schedule = {"enabled": True, "time": "02:00", "timezone": "Europe/Paris", "revision": 1}
        (scheduler.STATE / "update-schedule.json").write_text(json.dumps(schedule))
        self.assertIsNone(scheduler.schedule_at(datetime(2027, 3, 28, 1, 0, tzinfo=timezone.utc)))
        first = scheduler.schedule_at(datetime(2027, 10, 31, 0, 0, tzinfo=timezone.utc))
        second = scheduler.schedule_at(datetime(2027, 10, 31, 1, 0, tzinfo=timezone.utc))
        self.assertEqual(first[1].date(), second[1].date())

    def test_ci_skip_commit_only_allowed_for_bot_version_files(self):
        def valid_git(*args):
            if "--format=%s" in args:
                return "chore: bump affected component versions [skip ci]"
            if "--format=%ae" in args:
                return "41898282+github-actions[bot]@users.noreply.github.com"
            if args[0] == "diff-tree":
                return "frontend/src/v2/component-versions.json"
            return "parent"
        with patch.object(scheduler, "git", side_effect=valid_git):
            self.assertEqual(scheduler.ci_sha("target"), "parent")
        def untrusted(*args):
            if args[0] == "diff-tree":
                return "backend/app/main_v2.py"
            return valid_git(*args)
        with patch.object(scheduler, "git", side_effect=untrusted):
            with self.assertRaisesRegex(RuntimeError, "unexpected changes"):
                scheduler.ci_sha("target")

    def test_ci_failure_is_fail_closed(self):
        schedule = {"enabled": True, "time": "02:00", "timezone": "UTC", "revision": 1}
        (scheduler.STATE / "update-schedule.json").write_text(json.dumps(schedule))
        (scheduler.STATE / "update-scheduler-installed").touch()
        class Clock:
            @staticmethod
            def now():
                return datetime(2026, 10, 26, 2, 0, tzinfo=timezone.utc)
        with patch.object(scheduler, "datetime", Clock), \
                patch.object(scheduler.os, "geteuid", return_value=0), \
                patch.dict(scheduler.os.environ, {"PRICE_CHECKER_V2_ENV": "dev"}), \
                patch.object(scheduler, "git", side_effect=["old", "", "new"]), \
                patch.object(scheduler, "ci_sha", return_value="new"), \
                patch.object(scheduler, "ci_succeeded", return_value=False), \
                patch.object(scheduler.subprocess, "run") as command:
            command.return_value.returncode = 0
            self.assertEqual(scheduler.main(), 1)
            self.assertEqual(command.call_count, 1)  # merge-base only; updater not run
        status = json.loads((scheduler.STATE / "update-last-run.json").read_text())
        self.assertEqual(status["result"], "failed")


if __name__ == "__main__":
    unittest.main()
