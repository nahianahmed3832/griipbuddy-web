#!/usr/bin/env python3
"""Guard the prebuilt Hostinger development release's storage budget."""

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import stat
import subprocess
import sys


ROLES = {
    "staging", "extraction", "image_load", "migration_backup", "temporary_work",
    "rollback_recovery", "operating_reserve",
}
LOCK = Path("/run/lock/griipbuddy-dev-release.lock")
DOCKER_SOCKET = "unix:///var/run/docker.sock"
TOKEN = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_.-]*")
PATH = re.compile(r"/[a-zA-Z0-9_./+@-]*")
TAG = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_./:-]*:[a-zA-Z0-9_][a-zA-Z0-9_.-]*")
SHA256 = re.compile(r"[0-9a-f]{64}")
IMAGE_ID = re.compile(r"sha256:[0-9a-f]{64}")


class PlanError(Exception):
    pass


def record(value, fields, context):
    if not isinstance(value, dict) or value.keys() != set(fields.split()):
        raise PlanError(f"{context} has missing or unexpected fields.")
    return value


def entries(value, context, *, required=True):
    if not isinstance(value, list) or (required and not value):
        raise PlanError(f"{context} must be a list with the required entries.")
    return value


def matching(value, pattern, context):
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise PlanError(f"{context} has an invalid format.")
    return value


def path_name(value, context, *, allow_docker_root=False):
    if allow_docker_root and value == "$DOCKER_ROOT":
        return value
    value = matching(value, PATH, context)
    if ".." in Path(value).parts:
        raise PlanError(f"{context} must have a canonical absolute path.")
    return value


def release_environment():
    env = os.environ.copy()
    env.pop("DOCKER_CONTEXT", None)
    env["DOCKER_HOST"] = DOCKER_SOCKET
    return env


def docker_output(args, failure):
    try:
        result = subprocess.run(
            ["docker", *args], check=True, capture_output=True, text=True,
            env=release_environment(), timeout=20,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise PlanError(failure) from error
    return result.stdout.strip()


def load_plan(file):
    try:
        plan = json.loads(file.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError) as error:
        raise PlanError("Could not read the capacity plan as JSON.") from error
    record(plan, "version host paths allocations rollback_images rollback_artifacts", "Capacity plan")
    if type(plan["version"]) is not int or plan["version"] != 1:
        raise PlanError("Capacity plan version must be 1.")
    if matching(plan["host"], TOKEN, "Host") != socket.gethostname():
        raise PlanError("Capacity plan host differs from the current hostname.")

    for index, path in enumerate(entries(plan["paths"], "Persistent paths", required=False), 1):
        path_name(path, f"Persistent path {index}")

    roles, labels = set(), set()
    for index, item in enumerate(entries(plan["allocations"], "Allocations"), 1):
        context = f"Allocation {index}"
        record(item, "role label path bytes inodes basis", context)
        role = matching(item["role"], TOKEN, f"{context} role")
        if role not in ROLES:
            raise PlanError(f"{context} uses an unknown role.")
        label = matching(item["label"], TOKEN, f"{context} label")
        if label in labels:
            raise PlanError("Allocation labels must be unique.")
        path_name(item["path"], f"{context} path", allow_docker_root=True)
        for key in ("bytes", "inodes"):
            if type(item[key]) is not int or item[key] < 0:
                raise PlanError(f"{context} {key} must be a nonnegative integer.")
        if not isinstance(item["basis"], str) or not item["basis"].strip():
            raise PlanError(f"{context} must give a measurement or exclusion basis.")
        if (role == "operating_reserve" and not (item["bytes"] and item["inodes"])):
            raise PlanError("An operating reserve must include positive bytes and inodes.")
        roles.add(role)
        labels.add(label)
    if roles != ROLES:
        raise PlanError(f"Capacity plan omits roles: {', '.join(sorted(ROLES - roles))}.")

    seen = set()
    for index, image in enumerate(entries(plan["rollback_images"], "Rollback image pins"), 1):
        context = f"Rollback image {index}"
        record(image, "tag id", context)
        tag = matching(image["tag"], TAG, f"{context} tag")
        matching(image["id"], IMAGE_ID, f"{context} ID")
        if tag in seen:
            raise PlanError("Rollback image tags must be unique.")
        seen.add(tag)

    seen = set()
    for index, artifact in enumerate(entries(plan["rollback_artifacts"], "Rollback artifacts"), 1):
        context = f"Rollback artifact {index}"
        record(artifact, "path sha256", context)
        path = path_name(artifact["path"], f"{context} path")
        matching(artifact["sha256"], SHA256, f"{context} SHA-256")
        if path in seen:
            raise PlanError("Rollback artifact paths must be unique.")
        seen.add(path)
    return plan


def filesystem(path):
    try:
        details = os.stat(path)
        if not stat.S_ISDIR(details.st_mode):
            raise PlanError(f"Capacity path is not an existing directory: {path}.")
        capacity = os.statvfs(path)
    except OSError as error:
        raise PlanError(f"Cannot measure the filesystem at {path}.") from error
    if capacity.f_frsize <= 0 or capacity.f_files <= 0 or capacity.f_favail < 0:
        raise PlanError(f"Filesystem cannot report usable byte and inode capacity: {path}.")
    return details.st_dev, capacity.f_bavail * capacity.f_frsize, capacity.f_favail


def check_rollback(plan):
    images, artifacts = [], []
    for image in plan["rollback_images"]:
        tag = image["tag"]
        current = docker_output(
            ("image", "inspect", "--format", "{{.Id}}", tag),
            f"Cannot inspect rollback image {tag} on the local engine.",
        )
        if current != image["id"]:
            raise PlanError(f"Rollback image ID does not match the pin for {tag}.")
        images.append(image)

    for artifact in plan["rollback_artifacts"]:
        path = Path(artifact["path"])
        try:
            details = path.stat()
            if not stat.S_ISREG(details.st_mode) or not details.st_size:
                raise PlanError(f"Rollback artifact must be a nonempty regular file: {path}.")
            checksum = hashlib.sha256()
            with path.open("rb") as file:
                for block in iter(lambda: file.read(1024 * 1024), b""):
                    checksum.update(block)
        except OSError as error:
            raise PlanError(f"Cannot read rollback artifact {path}.") from error
        if checksum.hexdigest() != artifact["sha256"]:
            raise PlanError(f"Rollback artifact checksum does not match the pin for {path}.")
        artifacts.append({**artifact, "bytes": details.st_size})
    return {"images": images, "artifacts": artifacts}


def check_capacity(plan, docker_root, rollback):
    filesystems = {}
    by_path = {}

    def add_path(path):
        if path in by_path:
            return by_path[path]
        device, available_bytes, available_inodes = filesystem(path)
        group = filesystems.setdefault(device, {
            "paths": [], "available_bytes": available_bytes, "available_inodes": available_inodes,
            "required_bytes": 0, "required_inodes": 0, "allocations": [],
        })
        group["paths"].append(path)
        group["available_bytes"] = min(group["available_bytes"], available_bytes)
        group["available_inodes"] = min(group["available_inodes"], available_inodes)
        by_path[path] = group
        return group

    rollback_paths = [str(Path(item["path"]).resolve().parent) for item in rollback["artifacts"]]
    for path in [docker_root, *plan["paths"], *rollback_paths]:
        add_path(path)
    for item in plan["allocations"]:
        path = docker_root if item["path"] == "$DOCKER_ROOT" else item["path"]
        group = add_path(path)
        group["required_bytes"] += item["bytes"]
        group["required_inodes"] += item["inodes"]
        group["allocations"].append({
            key: item[key] for key in ("role", "label", "bytes", "inodes")
        } | {"path": path})

    if not any(item["role"] == "image_load" for item in by_path[docker_root]["allocations"]):
        raise PlanError("The plan must place an image load allocation on the local Docker filesystem.")

    blocked = False
    for group in filesystems.values():
        if not any(item["role"] == "operating_reserve" for item in group["allocations"]):
            raise PlanError(f"Add an operating reserve for the filesystem at {group['paths'][0]}.")
        group["bytes_short"] = max(0, group["required_bytes"] - group["available_bytes"])
        group["inodes_short"] = max(0, group["required_inodes"] - group["available_inodes"])
        blocked |= bool(group["bytes_short"] or group["inodes_short"])

    return {
        "status": "BLOCKED" if blocked else "READY",
        "host": plan["host"],
        "docker_root": docker_root,
        "filesystems": list(filesystems.values()),
        "verified_rollback": rollback,
        "message": (
            "Release blocked. Recover the listed bytes and inodes or move measured staging work to "
            "a verified filesystem, then rerun. Preserve all active data and rollback resources."
            if blocked else "The measured phase fits while retaining the requested operating reserve."
        ),
    }


def preflight(plan_file):
    plan = load_plan(plan_file)
    root = docker_output(("info", "--format", "{{.DockerRootDir}}"), "Cannot inspect the local Docker engine.")
    docker_root = path_name(root, "Docker root directory")
    return check_capacity(plan, docker_root, check_rollback(plan))


def run(plan_file, command):
    if command:
        try:
            # The lock serializes invocations of this controller across all three development lanes.
            lock_fd = os.open(LOCK, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            with os.fdopen(lock_fd, "ab") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return check_then_run(plan_file, command, pass_fds=(lock.fileno(),))
        except BlockingIOError as error:
            raise PlanError("Another guarded development release command holds the release lock.") from error
        except OSError as error:
            raise PlanError("Could not open the development release lock or start the command.") from error
    return check_then_run(plan_file, command)


def check_then_run(plan_file, command, *, pass_fds=()):
    result = preflight(plan_file)
    # Keep stdout available for the guarded release command.
    print(json.dumps(result, indent=2), file=sys.stderr if command else sys.stdout, flush=True)
    if result["status"] != "READY":
        return 1
    if command:
        status = subprocess.run(command, pass_fds=pass_fds, env=release_environment()).returncode
        return status if status >= 0 else 128 - status
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("plan", type=Path, help="Measured phase plan for the local development host")
    parts = sys.argv[1:]
    command = []
    if "--" in parts:
        delimiter = parts.index("--")
        parts, command = parts[:delimiter], parts[delimiter + 1:]
        if not command:
            parser.error("-- must be followed by a release command")
    args = parser.parse_args(parts)
    try:
        return run(args.plan, command)
    except PlanError as error:
        print(json.dumps({"status": "ERROR", "message": str(error)}),
              file=sys.stderr if command else sys.stdout, flush=True)
        return 2


if __name__ == "__main__":
    sys.exit(main())
