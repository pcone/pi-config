"""Machine-wide heavy-job slots (decisions/external-tools/010-heavy-job-slots.md).

slot() holds one of HEAVY_SLOTS exclusive flock() locks for its with-block.
The kernel drops a lock when its holder dies, so no lock goes stale.
Stdlib only; imported by bin/heavy and by the tfd test harness.
"""
import contextlib
import fcntl
import json
import os
import shlex
import sys
import time

ENV_HELD = "HEAVY_SLOT_HELD"
POLL_SECONDS = 0.5
CMD_WIDTH = 60


def _slot_dir():
    return os.path.join(os.path.expanduser("~"), ".cache", "heavy-slots")


def _slot_count():
    raw = os.environ.get("HEAVY_SLOTS", "1")
    try:
        n = int(raw)
    except ValueError:
        n = 0
    if n < 1:
        sys.exit(f"heavy: HEAVY_SLOTS must be a positive integer, got {raw!r}")
    return n


def _holder_line(slots, now):
    """One line naming the longest-running holder, or a fallback when none has an info file."""
    holders = []
    for i in range(slots):
        try:
            with open(_info_path(i)) as f:
                info = json.load(f)
        except (OSError, ValueError):
            continue
        holders.append((info["start"], i, info))
    if not holders:
        return f"heavy: waiting for a slot out of {slots}, holders unknown"
    _, i, info = min(holders)
    cmd = shlex.join(info["command"])
    if len(cmd) > CMD_WIDTH:
        cmd = cmd[: CMD_WIDTH - 1] + "…"
    elapsed = int(now - info["start"])
    cwd = info["cwd"].replace(os.path.expanduser("~"), "~", 1)
    return (
        f"heavy: waiting for slot {i}, held by pid {info['pid']} "
        f"({cmd}, {elapsed // 60}m{elapsed % 60:02d}s, {cwd})"
    )


def _lock_path(i):
    return os.path.join(_slot_dir(), f"slot-{i}.lock")


def _info_path(i):
    return os.path.join(_slot_dir(), f"slot-{i}.info")


def _acquire(slots, command, report_every):
    """Return (index, lock fd) for the first free slot, waiting and reporting until one is free."""
    last_report = None
    while True:
        for i in range(slots):
            fd = os.open(_lock_path(i), os.O_RDWR | os.O_CREAT, 0o644)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                os.close(fd)
                continue
            return i, fd
        now = time.time()
        if last_report is None or now - last_report >= report_every:
            print(_holder_line(slots, now), file=sys.stderr, flush=True)
            last_report = now
        time.sleep(POLL_SECONDS)


@contextlib.contextmanager
def slot(command, *, report_every=60):
    """Hold a heavy-job slot for the with-block; yields its index.

    `command` is the argv list recorded in the holder's info file. When
    HEAVY_SLOT_HELD is already set, the caller holds a slot: yield None and
    take none. Child processes started inside the block inherit HEAVY_SLOT_HELD.
    """
    if ENV_HELD in os.environ:
        yield None
        return
    os.makedirs(_slot_dir(), exist_ok=True)
    i, fd = _acquire(_slot_count(), command, report_every)
    info = _info_path(i)
    try:
        with open(info, "w") as f:
            json.dump(
                {
                    "pid": os.getpid(),
                    "command": list(command),
                    "start": time.time(),
                    "cwd": os.getcwd(),
                },
                f,
            )
        os.environ[ENV_HELD] = str(i)
        try:
            yield i
        finally:
            del os.environ[ENV_HELD]
            os.unlink(info)
    finally:
        os.close(fd)
