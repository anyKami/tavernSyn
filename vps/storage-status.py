#!/usr/bin/env python3
"""Read-only capacity report. Never prunes stages or acquires write locks."""
import argparse
import json
import os
from pathlib import Path
import shutil
import stat
from dispatcher import Store, ProtocolError, check, ID


def tree_size(root):
    files, size = 0, 0
    def fail(error):
        raise error
    for directory, dirs, names in os.walk(root, followlinks=False, onerror=fail):
        for name in dirs + names:
            file = Path(directory) / name
            info = file.lstat()
            check(not stat.S_ISLNK(info.st_mode), "linked storage entry")
            if stat.S_ISREG(info.st_mode):
                files += 1
                size += info.st_size
            else:
                check(stat.S_ISDIR(info.st_mode), "special storage entry")
    return dict(files=files, logicalBytes=size)


def storage_status(root):
    store = Store(root)
    usage = shutil.disk_usage(store.root)
    result = dict(format=1, totalBytes=usage.total, freeBytes=usage.free,
                  note="Read-only point-in-time report; logical bytes do not account for reflink sharing.")
    for name in ("incoming", "generations"):
        check((store.root / name).resolve() == store.root / name, "linked storage directory")
        entries = []
        for entry in sorted((store.root / name).iterdir()):
            check(ID.fullmatch(entry.name) and not entry.is_symlink() and entry.is_dir(), "unexpected storage entry")
            entries.append(dict(generation=entry.name, **tree_size(entry)))
        result[name] = entries
    paused = store.private / "paused-jobs"
    result["pausedJobs"] = []
    for file in sorted(paused.glob("*.json")) if paused.exists() else []:
        check(ID.fullmatch(file.stem) and not file.is_symlink() and file.is_file(), "unexpected paused entry")
        result["pausedJobs"].append(file.stem)
    result["warnings"] = (["LOW_SPACE"] if usage.free < max(32 * 1024 * 1024, usage.total // 10) else [])
    if result["incoming"] or result["pausedJobs"]:
        result["warnings"].append("RETAINED_JOBS_REVIEW_REQUIRED")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(storage_status(args.root), ensure_ascii=False, indent=2))
    except (OSError, ProtocolError) as error:
        parser.exit(1, "TavernSyn storage report: " + type(error).__name__ + "\n")
