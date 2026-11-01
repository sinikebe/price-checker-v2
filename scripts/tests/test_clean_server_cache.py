"""The cleanup policy is fixed, parses Docker's figures, and runs only when asked and when no update runs."""
import fcntl
import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "deployment/v2"))
import clean_server_cache as cleaner  # noqa: E402
import state_files  # noqa: E402

NOW = datetime(2026, 11, 1, 12, 0, tzinfo=UTC)
DF = "\n".join(json.dumps(row) for row in (
    {"Type": "Images", "TotalCount": "4", "Active": "2", "Size": "3.792GB", "Reclaimable": "3.501GB (92%)"},
    {"Type": "Containers", "TotalCount": "3", "Active": "3", "Size": "621.8kB", "Reclaimable": "0B (0%)"},
    {"Type": "Local Volumes", "TotalCount": "8", "Active": "1", "Size": "514.5MB", "Reclaimable": "444.2MB (86%)"},
    {"Type": "Build Cache", "TotalCount": "95", "Active": "0", "Size": "1.826GB", "Reclaimable": "1.826GB"},
))


class FakeDocker:
    def __init__(self, fail=None, image_output="Deleted Images:\nTotal reclaimed space: 1.17GB\n",
                 cache_output="Total:\t800MB\n"):
        self.calls, self.fail = [], fail
        self.image_output, self.cache_output = image_output, cache_output

    def __call__(self, args):
        self.calls.append(args)
        if self.fail and args[:3] == self.fail:
            raise subprocess.CalledProcessError(1, args, stderr="boom")
        if args[:3] == ("docker", "system", "df"):
            return DF
        if args[:2] == ("docker", "images"):
            return "sha256:b\nsha256:c\n" if "dangling=true" in args else "sha256:a\nsha256:b\nsha256:c\nsha256:d\n"
        if args[:3] == ("docker", "image", "prune"):
            return self.image_output
        if args[:3] == ("docker", "builder", "prune"):
            return self.cache_output
        raise AssertionError(f"unexpected command {args}")


class ParsingTests(unittest.TestCase):
    def test_sizes_use_docker_decimal_units(self):
        self.assertEqual(cleaner.parse_size("1.826GB"), 1_826_000_000)
        self.assertEqual(cleaner.parse_size("3.501GB (92%)"), 3_501_000_000)
        self.assertEqual(cleaner.parse_size("621.8kB"), 621_800)
        self.assertEqual(cleaner.parse_size("0B"), 0)
        self.assertIsNone(cleaner.parse_size("none"))

    def test_the_reclaimed_space_is_read_from_each_prune_output(self):
        self.assertEqual(cleaner.reclaimed("Deleted Images:\nuntagged: x\n\nTotal reclaimed space: 1.17GB"), 1_170_000_000)
        self.assertEqual(cleaner.reclaimed("ID RECLAIMABLE SIZE\nabc true 5MB\nTotal:\t1.826GB\n"), 1_826_000_000)
        self.assertIsNone(cleaner.reclaimed(""))

    def test_the_policy_never_touches_volumes_containers_or_tagged_images(self):
        flat = [" ".join(command) for command in cleaner.PRUNE.values()]
        self.assertEqual(flat, ["docker image prune -f", "docker builder prune -f --filter until=24h"])
        for command in flat:
            self.assertNotIn("-a", command.split())
            self.assertNotIn("volume", command)
            self.assertNotIn("system prune", command)


class CleaningTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.data = Path(self.temporary.name)
        self.state = self.data / "state"
        self.state.mkdir()
        (self.data / "backups").mkdir()
        for name, size in (("20261031T020000Z-abc1234.dump", 1000), ("20261030T020000Z-abc1234.dump", 500)):
            (self.data / "backups" / name).write_bytes(b"x" * size)
        (self.data / "backups" / "notes.txt").write_text("not a dump")
        os.symlink("/etc/hostname", self.data / "backups" / "20261029T020000Z-abc1234.dump")

    def usage(self):
        return json.loads((self.state / "server-usage.json").read_text())

    def last(self):
        return json.loads((self.state / "cache-clean-last-run.json").read_text())

    def test_measure_reports_docker_disk_and_backups(self):
        usage = cleaner.measure(FakeDocker(), self.data, NOW)
        self.assertEqual(usage["images"], {"count": 4, "dangling": 2, "size_bytes": 3_792_000_000, "reclaimable_bytes": 3_501_000_000})
        self.assertEqual(usage["build_cache"], {"size_bytes": 1_826_000_000, "reclaimable_bytes": 1_826_000_000})
        self.assertEqual(usage["backups"], {"count": 2, "bytes": 1500}, "links and other files are not counted")
        self.assertGreater(usage["disk"]["total_bytes"], 0)
        self.assertEqual(usage["at"], NOW.isoformat())

    def test_cleaning_runs_the_fixed_commands_and_sums_what_they_freed(self):
        docker = FakeDocker()
        result = cleaner.clean(docker, trigger="manual", data_dir=self.data, state_dir=self.state, now=NOW)
        prunes = [call for call in docker.calls if "prune" in call]
        self.assertEqual(prunes, list(cleaner.PRUNE.values()))
        self.assertEqual((result["result"], result["trigger"], result["freed_bytes"]), ("done", "manual", 1_970_000_000))
        self.assertEqual(self.usage()["images"]["count"], 4, "the figures are measured again afterwards")

    def test_an_unreadable_prune_output_is_reported_as_unknown_not_zero(self):
        result = cleaner.clean(FakeDocker(image_output="ok", cache_output=""), trigger="update",
                               data_dir=self.data, state_dir=self.state, now=NOW)
        self.assertIsNone(result["freed_bytes"])

    def test_a_request_is_run_once_and_consumed(self):
        (self.state / "cache-clean-request.json").write_text('{"id": "a"}')
        docker = FakeDocker()
        self.assertTrue(cleaner.process_request(self.state, self.data, docker, NOW))
        self.assertFalse((self.state / "cache-clean-request.json").exists())
        self.assertEqual((self.last()["result"], self.last()["trigger"]), ("done", "manual"))
        calls = len(docker.calls)
        self.assertFalse(cleaner.process_request(self.state, self.data, docker, NOW))
        self.assertEqual(len(docker.calls), calls, "no request, no command")

    def test_a_failing_command_is_reported_and_the_request_is_not_replayed(self):
        (self.state / "cache-clean-request.json").write_text("{}")
        docker = FakeDocker(fail=("docker", "builder", "prune"))
        self.assertTrue(cleaner.process_request(self.state, self.data, docker, NOW))
        self.assertEqual(self.last()["result"], "failed")
        self.assertIn("returned non-zero", self.last()["message"])
        self.assertFalse((self.state / "cache-clean-request.json").exists())

    def test_the_request_content_is_only_a_signal(self):
        for number, content in enumerate(("{oops", "[1, 2]", '{"command": "rm -rf /"}')):
            (self.state / "cache-clean-request.json").write_text(content)
            docker = FakeDocker()
            self.assertTrue(cleaner.process_request(self.state, self.data, docker, NOW), number)
            commands = [call for call in docker.calls if "prune" in call]
            self.assertEqual(commands, list(cleaner.PRUNE.values()), content)

    def test_a_link_in_place_of_the_request_is_consumed_without_reading_its_target(self):
        target = self.data / "secret.json"
        target.write_text('{"x": 1}')
        os.symlink(target, self.state / "cache-clean-request.json")
        self.assertTrue(cleaner.process_request(self.state, self.data, FakeDocker(), NOW))
        self.assertFalse((self.state / "cache-clean-request.json").exists(follow_symlinks=False))
        self.assertTrue(target.exists())

    def test_nothing_is_cleaned_while_an_update_runs_and_the_request_waits(self):
        (self.state / "cache-clean-request.json").write_text("{}")
        holder = os.open(self.data / "update.lock", os.O_RDWR | os.O_CREAT, 0o600)
        self.addCleanup(os.close, holder)
        fcntl.flock(holder, fcntl.LOCK_EX)
        docker = FakeDocker()
        self.assertFalse(cleaner.process_request(self.state, self.data, docker, NOW))
        self.assertEqual(docker.calls, [])
        self.assertTrue((self.state / "cache-clean-request.json").exists())
        fcntl.flock(holder, fcntl.LOCK_UN)
        self.assertTrue(cleaner.process_request(self.state, self.data, docker, NOW))

    def test_figures_are_refreshed_only_when_old_or_missing(self):
        docker = FakeDocker()
        self.assertTrue(cleaner.refresh_usage(self.state, self.data, docker, NOW))
        calls = len(docker.calls)
        self.assertFalse(cleaner.refresh_usage(self.state, self.data, docker, NOW + timedelta(hours=5)))
        self.assertEqual(len(docker.calls), calls)
        self.assertTrue(cleaner.refresh_usage(self.state, self.data, docker, NOW + timedelta(hours=7)))

    def test_without_docker_the_timer_goes_on(self):
        def missing(_args):
            raise FileNotFoundError("docker")
        self.assertFalse(cleaner.refresh_usage(self.state, self.data, missing, NOW))
        self.assertFalse((self.state / "server-usage.json").exists())
        (self.state / "cache-clean-request.json").write_text("{}")
        self.assertTrue(cleaner.process_request(self.state, self.data, missing, NOW))
        self.assertEqual(self.last()["result"], "failed")

    def test_the_figures_file_is_readable_by_the_backend_user(self):
        cleaner.refresh_usage(self.state, self.data, FakeDocker(), NOW)
        self.assertEqual(os.stat(self.state / "server-usage.json").st_mode & 0o777, 0o644)
        self.assertEqual(state_files.read_json(self.state / "server-usage.json")["schema"], 1)


if __name__ == "__main__":
    unittest.main()
