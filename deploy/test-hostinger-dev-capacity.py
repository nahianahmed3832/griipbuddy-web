#!/usr/bin/env python3

from contextlib import redirect_stderr, redirect_stdout
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("hostinger-dev-capacity.py")
spec = importlib.util.spec_from_file_location("capacity", SCRIPT)
capacity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capacity)


class CapacityTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name).resolve()
        self.lock = self.root / "deploy.lock"
        self.docker = str(self.root / "docker")
        self.stage = str(self.root / "stage")
        self.data = str(self.root / "data")
        self.artifact = self.root / "rollback.dump"
        self.artifact.write_bytes(b"synthetic rollback data")
        self.image_id = "sha256:" + "a" * 64
        self.filesystems = {
            path: (1, 100, 20) for path in [str(self.root), self.docker, self.stage, self.data]
        }
        self.plan = {
            "version": 1,
            "host": socket.gethostname(),
            "paths": [self.data],
            "allocations": [
                {"role": role, "label": f"fixture-{role}", "path": path, "bytes": bytes_,
                 "inodes": inodes, "basis": "fixture-only values"}
                for role, path, bytes_, inodes in [
                    ("staging", self.stage, 10, 1),
                    ("extraction", self.stage, 10, 1),
                    ("image_load", "$DOCKER_ROOT", 30, 5),
                    ("migration_backup", self.stage, 10, 1),
                    ("temporary_work", self.stage, 5, 1),
                    ("rollback_recovery", "$DOCKER_ROOT", 15, 3),
                    ("operating_reserve", self.stage, 20, 8),
                ]
            ],
            "rollback_images": [{"tag": "test-dev:previous", "id": self.image_id}],
            "rollback_artifacts": [{"path": str(self.artifact),
                                     "sha256": hashlib.sha256(self.artifact.read_bytes()).hexdigest()}],
        }
        self.plan_file = self.root / "plan.json"
        replacement = patch.multiple(capacity, LOCK=self.lock, filesystem=self.filesystems.__getitem__,
                                     docker_output=self.docker_output)
        replacement.start()
        self.addCleanup(replacement.stop)

    def docker_output(self, args, message):
        if args[0] == "info":
            return self.docker
        if args[-1] == "test-dev:previous":
            return self.image_id
        raise capacity.PlanError(message)

    def cli(self, *command):
        self.plan_file.write_text(json.dumps(self.plan), encoding="utf-8")
        output, error = io.StringIO(), io.StringIO()
        args = [str(SCRIPT), str(self.plan_file)]
        if command:
            args.extend(["--", *command])
        with patch.object(sys, "argv", args), redirect_stdout(output), redirect_stderr(error):
            status = capacity.main()
        return status, json.loads(error.getvalue() if command else output.getvalue())

    def test_shared_filesystem_sums_byte_and_inode_budgets_at_exact_boundary(self):
        status, result = self.cli()
        self.assertEqual((status, result["status"]), (0, "READY"))
        self.assertEqual(len(result["filesystems"]), 1)
        group = result["filesystems"][0]
        self.assertEqual((group["required_bytes"], group["required_inodes"]), (100, 20))
        self.assertEqual(result["verified_rollback"]["artifacts"][0]["bytes"], 23)
        self.assertFalse(self.lock.exists())

    def test_each_resource_can_independently_reject_and_report_shortfall(self):
        for available, shortage in [((99, 20), (1, 0)), ((100, 19), (0, 1)), ((90, 10), (10, 10))]:
            with self.subTest(available=available):
                self.filesystems[self.stage] = (1, *available)
                status, result = self.cli()
                group = result["filesystems"][0]
                self.assertEqual((status, result["status"]), (1, "BLOCKED"))
                self.assertEqual((group["bytes_short"], group["inodes_short"]), shortage)

    def test_a_separate_data_filesystem_needs_its_own_reserve_and_capacity(self):
        self.filesystems[self.data] = (2, 1000, 10)
        self.assertEqual(self.cli()[0], 2)
        self.plan["allocations"].append({
            "role": "operating_reserve", "label": "data-reserve", "path": self.data,
            "bytes": 1000, "inodes": 11, "basis": "fixture separate device",
        })
        status, result = self.cli()
        self.assertEqual((status, len(result["filesystems"])), (1, 2))
        data_group = next(group for group in result["filesystems"] if group["paths"] == [self.data])
        self.assertEqual((data_group["bytes_short"], data_group["inodes_short"]), (0, 1))

    def test_missing_role_or_mismatched_host_is_error(self):
        reserve = self.plan["allocations"].pop()
        self.assertEqual(self.cli()[0], 2)
        self.plan["allocations"].append(reserve)
        self.plan["host"] = "unrelated-machine"
        self.assertEqual(self.cli()[0], 2)

    def test_unavailable_or_modified_rollback_blocks_before_command(self):
        with patch.object(capacity.subprocess, "run") as release:
            self.plan["rollback_images"][0]["id"] = "sha256:" + "b" * 64
            self.assertEqual(self.cli("fixture-release")[0], 2)
            self.plan["rollback_images"][0]["id"] = self.image_id
            self.artifact.write_bytes(b"different synthetic fixture")
            self.assertEqual(self.cli("fixture-release")[0], 2)
            self.artifact.unlink()
            self.assertEqual(self.cli("fixture-release")[0], 2)
            release.assert_not_called()

    def test_blocked_command_is_never_invoked_and_success_propagates_command_status(self):
        with patch.object(capacity.subprocess, "run", return_value=subprocess.CompletedProcess([], 7)) as release:
            self.filesystems[self.stage] = (1, 100, 19)
            self.assertEqual(self.cli("fixture-release", "argument")[0], 1)
            release.assert_not_called()
            self.filesystems[self.stage] = (1, 100, 20)
            status, result = self.cli("fixture-release", "argument")
            self.assertEqual((status, result["status"]), (7, "READY"))
            self.assertEqual(release.call_args.args, (["fixture-release", "argument"],))
            self.assertEqual(len(release.call_args.kwargs["pass_fds"]), 1)

    def test_concurrent_guarded_commands_are_rejected(self):
        with self.lock.open("ab") as lock, patch.object(capacity.subprocess, "run") as release:
            capacity.fcntl.flock(lock, capacity.fcntl.LOCK_EX | capacity.fcntl.LOCK_NB)
            status, result = self.cli("fixture-release")
        self.assertEqual((status, result["status"]), (2, "ERROR"))
        release.assert_not_called()

    def test_docker_probe_error_uses_only_the_safe_diagnostic(self):
        with patch.object(capacity.subprocess, "run", side_effect=subprocess.CalledProcessError(
            1, ["docker"], output="fixture secret stdout", stderr="fixture secret stderr",
        )):
            with self.assertRaisesRegex(capacity.PlanError, "^Cannot inspect local engine\\.$"):
                self._real_docker_output(("info",), "Cannot inspect local engine.")

    _real_docker_output = staticmethod(capacity.docker_output)


if __name__ == "__main__":
    unittest.main(verbosity=2)
