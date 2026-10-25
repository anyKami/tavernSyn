import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import uuid

PROJECT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("dispatcher", PROJECT / "vps" / "dispatcher.py")
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)


class FakeLock:
    def __init__(self, *args, **kwargs):
        pass
    def __enter__(self):
        return self
    def __exit__(self, *args):
        pass
    def close(self):
        pass


class StoreTests(unittest.TestCase):
    def setUp(self):
        (PROJECT / ".tmp").mkdir(exist_ok=True)
        self.work = Path(tempfile.mkdtemp(prefix="vps-", dir=PROJECT / ".tmp"))
        self.root = self.work / "store"
        self.dataset, self.device = str(uuid.uuid4()), str(uuid.uuid4())
        d.initialize(self.root, self.dataset)
        self.store = d.Store(self.root)
        self.lock = patch.object(d, "Lock", FakeLock)
        self.lock.start()
        self.addCleanup(self.lock.stop)
        original_run = subprocess.run

        def run(args, **kwargs):
            if args[0] == "cp":
                shutil.copytree(args[-2], args[-1], copy_function=shutil.copy2, symlinks=True)
                return subprocess.CompletedProcess(args, 0)
            return original_run(args, **kwargs)

        self.copy = patch.object(d.subprocess, "run", side_effect=run)
        self.copy.start()
        self.addCleanup(self.copy.stop)

    def begin(self, job=None, direction="push"):
        current = self.store.current()
        job = job or str(uuid.uuid4())
        self.store.begin(dict(job=job, direction=direction, dataset=self.dataset, base=current["digest"] if current else None, jobBound=True), self.device)
        return job

    def test_atomic_failures_remove_temporary_files_and_keep_the_original(self):
        file = self.work / "atomic.json"
        for where in ("write", "sync", "rename"):
            d.atomic(file, {"old": True})
            target, name = (d.json, "dump") if where == "write" else (d.os, "fsync") if where == "sync" else (d.os, "replace")
            with patch.object(target, name, side_effect=OSError("synthetic storage failure")):
                with self.assertRaises(OSError):
                    d.atomic(file, {"new": True})
            self.assertEqual(d.read(file), {"old": True})
            self.assertEqual(list(self.work.glob("atomic.json.*.tmp")), [])

    def test_publication_survives_failure_in_post_commit_housekeeping(self):
        job = self.begin()
        _, manifest = self.payload(job)
        save = self.store.save

        def fail_done(value):
            if value["phase"] == "done":
                raise OSError("synthetic done-record failure")
            save(value)

        with patch.object(self.store, "save", side_effect=fail_done), patch.object(self.store, "gc", side_effect=PermissionError()):
            result = self.store.commit(dict(job=job, manifest=manifest), self.device)
        self.assertEqual(result["phase"], "done")
        self.assertEqual(set(result["maintenance"]), {"job-record", "generations"})
        self.assertEqual(self.store.current()["generation"], job)
        self.assertEqual(self.store.current()["digest"], manifest["digest"])
        self.assertEqual(self.store.commit(dict(job=job, manifest=manifest), self.device)["phase"], "done")

    def test_pointer_replaced_before_sync_failure_is_reported_as_published_with_warning(self):
        job = self.begin()
        _, manifest = self.payload(job)
        atomic = d.atomic

        def fail_after_pointer(file, value):
            atomic(file, value)
            if Path(file).name == "current.json":
                raise OSError("synthetic directory sync failure after replace")

        with patch.object(d, "atomic", side_effect=fail_after_pointer):
            result = self.store.commit(dict(job=job, manifest=manifest), self.device)
        self.assertEqual(result["phase"], "done")
        self.assertEqual(result["maintenance"], ["publication-sync"])
        self.assertEqual(self.store.current()["generation"], job)

    def test_storage_report_is_read_only_and_warns_about_retained_work(self):
        job = self.begin()
        self.payload(job)
        self.store.close()
        spec = importlib.util.spec_from_file_location("storage_status", PROJECT / "vps/storage-status.py")
        module = importlib.util.module_from_spec(spec)
        with patch.dict(os.sys.modules, {"dispatcher": d}):
            spec.loader.exec_module(module)
        before = {str(p.relative_to(self.root)): p.read_bytes() for p in self.root.rglob("*") if p.is_file()}
        result = module.storage_status(self.root)
        after = {str(p.relative_to(self.root)): p.read_bytes() for p in self.root.rglob("*") if p.is_file()}
        self.assertEqual(before, after)
        self.assertEqual(result["incoming"][0]["generation"], job)
        self.assertGreater(result["incoming"][0]["logicalBytes"], 0)
        self.assertEqual(result["pausedJobs"], [job])
        self.assertIn("RETAINED_JOBS_REVIEW_REQUIRED", result["warnings"])

    def payload(self, job, value="one"):
        payload = self.root / "incoming" / job / "payload"
        (payload / "profile").mkdir(exist_ok=True)
        (payload / "profile" / "settings.json").write_text(json.dumps({"value": value}), encoding="utf-8")
        (payload / "profile" / "世界书.txt").write_text(value * 100, encoding="utf-8")
        return payload, d.scan(payload)

    def publish(self, value="one"):
        job = self.begin()
        payload, manifest = self.payload(job, value)
        self.store.commit(dict(job=job, manifest=manifest), self.device)
        return job, manifest

    def test_new_root_only_and_empty_pull_refused(self):
        with self.assertRaises(d.ProtocolError):
            d.initialize(self.root, self.dataset)
        with self.assertRaises(d.ProtocolError):
            self.begin(direction="pull")
        self.assertIsNone(self.store.current())

    def test_failed_integrity_cannot_publish_over_current(self):
        first, _ = self.publish()
        second = self.begin()
        payload, manifest = self.payload(second, "two")
        (payload / "profile" / "世界书.txt").write_text("corruption", encoding="utf-8")
        with self.assertRaises(d.ProtocolError):
            self.store.commit(dict(job=second, manifest=manifest), self.device)
        self.assertEqual(self.store.current()["generation"], first)
        self.assertEqual(self.store.active()["phase"], "transfer")
        self.store.finish(dict(job=second), self.device, abort=True)
        self.assertEqual(self.store.current()["generation"], first)

    def test_commit_response_loss_is_idempotent_and_gc_retains_two(self):
        first, _ = self.publish()
        second, manifest = self.publish("two")
        # Reconnect with the same job; no new generation and no replacement of previous.
        self.begin(job=second)
        replay = self.store.commit(dict(job=second, manifest=manifest), self.device)
        self.assertEqual(replay["digest"], manifest["digest"])
        self.assertEqual(d.read(self.root / "previous.json")["generation"], first)
        third, _ = self.publish("three")
        self.assertEqual({x.name for x in (self.root / "generations").iterdir()}, {second, third})
        self.assertFalse((self.root / "incoming" / second).exists())

    def test_recovery_after_rename_before_pointer_publish(self):
        first, _ = self.publish()
        second = self.begin()
        _, manifest = self.payload(second, "two")
        original_atomic = d.atomic

        def fail_pointer(file, value):
            if Path(file).name == "current.json":
                raise OSError("simulated interrupted publication")
            return original_atomic(file, value)

        with patch.object(d, "atomic", side_effect=fail_pointer):
            with self.assertRaises(OSError):
                self.store.commit(dict(job=second, manifest=manifest), self.device)
        self.assertEqual(self.store.current()["generation"], first)
        self.assertTrue((self.root / "generations" / second / "COMPLETE.json").exists())
        self.store.commit(dict(job=second, manifest=manifest), self.device)
        self.assertEqual(self.store.current()["generation"], second)

    def test_device_binding_path_validation_and_empty_upload(self):
        job = self.begin()
        with self.assertRaises(d.ProtocolError):
            self.store.begin(dict(job=job, direction="push", dataset=self.dataset, jobBound=True), str(uuid.uuid4()))
        with self.assertRaises(d.ProtocolError):
            self.store.own_job(dict(job="../../data"), self.device)
        payload = self.root / "incoming" / job / "payload"
        (payload / "profile").mkdir()
        (payload / "profile" / "settings.json").write_text("{}", encoding="utf-8")
        with self.assertRaises(d.ProtocolError):
            self.store.commit(dict(job=job, manifest=d.scan(payload)), self.device)
        self.assertIsNone(self.store.current())

    def test_interrupted_download_is_pinned_across_new_publications(self):
        published, manifest = self.publish()
        job = self.begin(direction="pull")
        active = self.store.active()
        self.assertEqual(active["generation"], published)
        self.assertEqual(active["manifest"]["digest"], manifest["digest"])
        self.store.close()
        self.publish("two")
        self.publish("three")
        self.assertTrue((self.root / "generations" / published).is_dir())
        self.begin(job=job, direction="pull")
        self.assertEqual(self.store.active()["generation"], published)
        self.store.finish(dict(job=job), self.device)
        self.store.gc()
        self.assertFalse((self.root / "generations" / published).exists())

    def test_disconnect_parks_upload_without_losing_payload_and_same_job_resumes(self):
        job = self.begin()
        payload, manifest = self.payload(job)
        self.store.close()
        self.assertEqual(self.store.active()["phase"], "paused")
        self.assertTrue(self.store.parked_file(job).is_file())
        self.assertEqual(d.scan(payload)["digest"], manifest["digest"])
        self.begin(job=job)
        self.assertEqual(self.store.active()["phase"], "transfer")
        self.assertFalse(self.store.parked_file(job).exists())
        self.store.commit(dict(job=job, manifest=manifest), self.device)
        self.assertEqual(self.store.current()["digest"], manifest["digest"])

    def test_legacy_or_crashed_control_record_does_not_permanently_block_next_job(self):
        old = self.begin()
        payload, manifest = self.payload(old)
        # Simulate SIGKILL: no close/finally, but OS locks are released.
        self.store.lock = None
        self.device = str(uuid.uuid4())
        new = self.begin()
        self.assertEqual(self.store.active()["job"], new)
        self.assertEqual(d.scan(payload)["digest"], manifest["digest"])
        self.assertTrue(self.store.parked_file(old).is_file())
        seeded = self.root / "incoming" / new / "payload"
        self.assertEqual(d.scan(seeded)["digest"], manifest["digest"])
        self.assertEqual(self.store.active()["seededFrom"], old)
        (seeded / "profile/settings.json").write_text('{"new":true}')
        self.assertEqual(d.scan(payload)["digest"], manifest["digest"], "the seed must never hardlink retained data")
        self.store.close()

    def test_obsolete_interrupted_upload_cannot_overwrite_a_new_publication(self):
        old = self.begin()
        payload, manifest = self.payload(old)
        self.store.close()
        current, _ = self.publish("newer")
        with self.assertRaisesRegex(d.ProtocolError, "REMOTE_CHANGED"):
            self.begin(job=old)
        self.assertEqual(self.store.current()["generation"], current)
        self.assertEqual(d.scan(payload)["digest"], manifest["digest"])

    def test_late_rsync_connection_cannot_write_into_a_different_job(self):
        old = self.begin()
        self.store.close()
        self.begin()
        with self.assertRaisesRegex(d.ProtocolError, "wrong transfer job"):
            d.serve_rsync(self.store, self.device, old)
        with self.assertRaisesRegex(d.ProtocolError, "job-bound rsync required"):
            d.serve_rsync(self.store, self.device)

    @unittest.skipIf(os.name == "nt", "Linux fsync on a read-only descriptor; VPS deployment runs this test as the sync account")
    def test_commit_fsync_does_not_require_write_access_to_readonly_files(self):
        job = self.begin()
        payload, manifest = self.payload(job)
        readonly = payload / "profile" / "世界书.txt"
        readonly.chmod(0o400)
        original_open = open

        def readable_only(file, mode="r", *args, **kwargs):
            if Path(file) == readonly and "+" in mode:
                raise PermissionError("fixture read-only file")
            return original_open(file, mode, *args, **kwargs)

        try:
            with patch("builtins.open", side_effect=readable_only):
                self.store.commit(dict(job=job, manifest=manifest), self.device)
            self.assertEqual(self.store.current()["digest"], manifest["digest"])
        finally:
            for file in self.root.rglob("世界书.txt"):
                file.chmod(0o600)

    def test_corrupt_complete_marker_rejected(self):
        job, _ = self.publish()
        d.atomic(self.root / "generations" / job / "COMPLETE.json", {"digest": "0" * 64})
        with self.assertRaises(d.ProtocolError):
            self.store.current()

    def test_same_size_mtime_corruption_and_nonportable_names(self):
        root = self.work / "names"
        root.mkdir()
        (root / "a.txt").write_text("AAAA", encoding="utf-8")
        before = d.scan(root)
        (root / "a.txt").write_text("BBBB", encoding="utf-8")
        os.utime(root / "a.txt", (before["files"][0]["mtime"], before["files"][0]["mtime"]))
        self.assertEqual(d.difference(before, d.scan(root))["changed"], ["a.txt"])
        for value in ("../file", "/file", "x\\file", "C:/file", "aux.txt", "x./file", ".tavernsyn-partial/file"):
            with self.assertRaises(d.ProtocolError):
                d.safe_relative(value)

    def test_forced_entry_refuses_arbitrary_ssh_commands(self):
        env = {**os.environ, "SSH_ORIGINAL_COMMAND": "sh -c arbitrary"}
        result = subprocess.run([os.sys.executable, str(PROJECT / "vps/dispatcher.py"), "--root", str(self.root)], env=env, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"unsupported SSH command", result.stderr)

    def test_password_entry_accepts_only_fixed_commands_and_valid_device_ids(self):
        self.assertEqual(d.ssh_command(f"tavernsyn-control-v1 {self.device}"), ("control", self.device))
        self.assertEqual(d.ssh_command(f"tavernsyn-rsync-v1 {self.device} --server --daemon ."), ("rsync", self.device))
        self.assertEqual(d.ssh_command(f"tavernsyn-rsync-v2 {self.device} {str(uuid.uuid4())} --server --daemon ."), ("rsync", self.device))
        for command in ("sh", f"tavernsyn-control-v1 {self.device}; id", "tavernsyn-control-v1 ../bad",
                        f"tavernsyn-rsync-v1 {self.device} --server --daemon /etc", f"tavernsyn-control-v1 {self.device} extra"):
            with self.assertRaises(d.ProtocolError):
                d.ssh_command(command)

    def test_password_entry_requires_tailscale_source(self):
        for source in ("100.64.0.1 12345 100.100.1.1 22", "fd7a:115c:a1e0::1 12345 fd7a:115c:a1e0::2 22"):
            self.assertTrue(d.tailscale_source(source))
        for source in ("", "127.0.0.1 22 127.0.0.1 22", "203.0.113.1 22 x 22", "100.128.0.1 22 x 22"):
            self.assertFalse(d.tailscale_source(source))
        env = {**os.environ, "SSH_ORIGINAL_COMMAND": f"tavernsyn-control-v1 {self.device}", "SSH_CONNECTION": "203.0.113.1 12345 100.100.1.1 22"}
        result = subprocess.run([os.sys.executable, str(PROJECT / 'vps/dispatcher.py'), '--root', str(self.root)], env=env, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b'Tailscale source required', result.stderr)


@unittest.skipUnless(d.fcntl, "Linux flock/SSH transfer concurrency needs a real Linux host")
class LinuxLockTests(unittest.TestCase):
    def store(self, root):
        dataset, device = str(uuid.uuid4()), str(uuid.uuid4())
        d.initialize(root, dataset)
        message = dict(job=str(uuid.uuid4()), dataset=dataset, direction="push", base=None, jobBound=True)
        return d.Store(root), device, message

    def test_new_job_cannot_steal_a_live_control_session(self):
        with tempfile.TemporaryDirectory() as temp:
            first, device, message = self.store(Path(temp) / "store")
            second = d.Store(first.root)
            try:
                first.begin(message, device)
                with self.assertRaisesRegex(d.ProtocolError, "BUSY"):
                    second.begin({**message, "job": str(uuid.uuid4())}, device)
                first.close()
                second.begin({**message, "job": str(uuid.uuid4())}, device)
                self.assertTrue(second.parked_file(message["job"]).is_file())
            finally:
                first.close()
                second.close()

    def test_control_disconnect_cannot_release_a_still_running_rsync(self):
        with tempfile.TemporaryDirectory() as temp:
            first, device, message = self.store(Path(temp) / "store")
            second = d.Store(first.root)
            try:
                first.begin(message, device)
                with d.Lock(first.private / "transfer.lock", shared=True):
                    first.close()
                    self.assertEqual(first.active()["phase"], "transfer")
                    with self.assertRaisesRegex(d.ProtocolError, "BUSY"):
                        second.begin({**message, "job": str(uuid.uuid4())}, device)
                    second.close()
                second.begin({**message, "job": str(uuid.uuid4())}, device)
                self.assertTrue(second.parked_file(message["job"]).is_file())
            finally:
                first.close()
                second.close()

    def test_ssh_control_eof_parks_job_and_releases_actual_os_lock(self):
        with tempfile.TemporaryDirectory() as temp:
            store, device, message = self.store(Path(temp) / "store")
            env = {**os.environ, "SSH_ORIGINAL_COMMAND": f"tavernsyn-control-v1 {device}",
                   "SSH_CONNECTION": "100.64.0.1 12345 100.64.0.2 22"}
            result = subprocess.run([os.sys.executable, str(PROJECT / "vps/dispatcher.py"), "--root", str(store.root)],
                                    input=json.dumps({**message, "id": 1, "op": "begin"}) + "\n", text=True,
                                    capture_output=True, env=env, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(json.loads(result.stdout)["ok"], result.stdout)
            self.assertEqual(store.active()["phase"], "paused")
            with d.Lock(store.private / "operation.lock"), d.Lock(store.private / "transfer.lock"):
                pass

    def test_exclusive_lock_cannot_steal_active_transfer(self):
        with tempfile.TemporaryDirectory() as temp:
            file = Path(temp) / "transfer.lock"
            with d.Lock(file, shared=True):
                with self.assertRaises(d.ProtocolError):
                    d.Lock(file)
                with d.Lock(file, shared=True):
                    pass
            with d.Lock(file):
                with self.assertRaises(d.ProtocolError):
                    d.Lock(file, shared=True)


if __name__ == "__main__":
    unittest.main()
