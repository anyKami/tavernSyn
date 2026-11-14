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

    def commit(self, message, device):
        # Most publication tests start with a fully staged payload. Run the
        # protocol against those same bytes before exercising publication.
        job = self.store.active()
        if job and job["job"] == message["job"] and job["phase"] == "transfer":
            if self.store.inspect(message, device)["equal"]:
                plan = self.store.hybrid_plan(message, device)["plan"]
                self.assertEqual(plan["groups"], [])
                self.assertEqual(plan["large"], [])
                self.store.hybrid_descriptors(dict(job=job["job"], descriptors=[]), device)
                self.store.hybrid_apply(dict(job=job["job"]), device)
        return self.store.commit(message, device)

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
            result = self.commit(dict(job=job, manifest=manifest), self.device)
        self.assertEqual(result["phase"], "done")
        self.assertEqual(set(result["maintenance"]), {"job-record", "generations"})
        self.assertEqual(self.store.current()["generation"], job)
        self.assertEqual(self.store.current()["digest"], manifest["digest"])
        self.assertEqual(self.commit(dict(job=job, manifest=manifest), self.device)["phase"], "done")

    def test_pointer_replaced_before_sync_failure_is_reported_as_published_with_warning(self):
        job = self.begin()
        _, manifest = self.payload(job)
        atomic = d.atomic

        def fail_after_pointer(file, value):
            atomic(file, value)
            if Path(file).name == "current.json":
                raise OSError("synthetic directory sync failure after replace")

        with patch.object(d, "atomic", side_effect=fail_after_pointer):
            result = self.commit(dict(job=job, manifest=manifest), self.device)
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
        self.commit(dict(job=job, manifest=manifest), self.device)
        return job, manifest

    def complete_publication(self):
        job = self.begin()
        payload = self.root / "incoming" / job / "payload"
        shutil.rmtree(payload)
        contents = {"profile/settings.json": '{"theme":"keep"}', "profile/secrets.json": '{"key":"synthetic"}',
                    "profile/chats/A/old.jsonl": '{"mes":"old"}\n', "profile/group chats/g.jsonl": '{"mes":"group"}\n',
                    "profile/groups/g.json": '{"id":"g"}', "profile/characters/old.png": "old card",
                    "profile/worlds/old.json": '{"entries":{}}', "extensions/demo/index.js": "keep plugin",
                    "profile/files/keep.txt": "keep attachment"}
        for name, text in contents.items():
            file = payload / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(text, encoding="utf-8")
        metadata = dict(format=1, sourceVersion="1.19.0", sourcePlatform="fixture", sourceArch="fixture",
                        plugins=[], config={"/backups/chat/enabled": True}, extraRoots=[], warnings=[], executables=[])
        metadata["sourceState"] = d.source_state(metadata, d.scan(payload)["files"])
        d.atomic(payload / "environment.json", metadata)
        manifest = d.scan(payload)
        self.commit(dict(job=job, manifest=manifest), self.device)
        return self.store.current()

    def category_upload(self, scope, empty=False):
        current = self.store.current()
        job = str(uuid.uuid4())
        self.store.begin(dict(job=job, direction="push", scope=scope, dataset=self.dataset, base=current["digest"], jobBound=True), self.device)
        upload = self.root / "incoming" / job / "upload"
        for relative in d.scope_paths(scope):
            if (upload / relative).exists():
                shutil.rmtree(upload / relative)
        if not empty:
            for category in scope:
                relative = d.CATEGORIES[category][0]
                file = upload / "profile" / relative / ("new.png" if category == "characters" else "new.jsonl" if category == "chats" else "new.json")
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text('{"fixture":"new"}\n', encoding="utf-8")
        metadata = dict(format=1, sourceVersion="1.19.0", sourcePlatform="other", sourceArch="other", scope=sorted(scope),
                        plugins=[], config={}, extraRoots=[], warnings=[], executables=[])
        metadata["sourceState"] = d.source_state(metadata, d.scan(upload)["files"], scope)
        d.atomic(upload / "environment.json", metadata)
        return job, upload, d.scan(upload)

    def test_full_and_category_inspect_keep_partial_bytes_until_commit(self):
        for scope in (None, ["worlds"]):
            with self.subTest(scope=scope):
                if scope:
                    self.complete_publication()
                    job, payload, manifest = self.category_upload(scope)
                else:
                    job = self.begin()
                    payload, manifest = self.payload(job)
                partial = payload / "profile" / ".tavernsyn-partial" / "world.json"
                partial.parent.mkdir()
                partial.write_bytes(b"retained incomplete transfer")
                request = dict(job=job, manifest=manifest)
                self.assertTrue(self.store.inspect(request, self.device)["equal"])
                self.assertEqual(partial.read_bytes(), b"retained incomplete transfer")
                self.assertEqual(self.store.inspect(request, self.device)["extra"], [])
                with self.assertRaises(d.ProtocolError):
                    d.scan(payload)
                extra = payload / "profile" / "business.txt"
                extra.write_text("unexpected", encoding="utf-8")
                self.assertEqual(self.store.inspect(request, self.device)["extra"], ["profile/business.txt"])
                self.assertEqual(partial.read_bytes(), b"retained incomplete transfer")
                extra.unlink()
                receipt = self.commit(request, self.device)
                generation = self.root / "generations" / job
                self.assertEqual(receipt["generation"], job)
                self.assertEqual(receipt.get("snapshotDigest", receipt["digest"]), manifest["digest"])
                self.assertEqual(list(generation.rglob(".tavernsyn-partial")), [])
                self.assertEqual(self.store.current()["generation"], job)

    def test_inspect_rejects_a_partial_path_that_is_not_a_directory(self):
        job = self.begin()
        payload, manifest = self.payload(job)
        partial = payload / "profile" / ".tavernsyn-partial"
        partial.write_text("ordinary file", encoding="utf-8")
        request = dict(job=job, manifest=manifest)
        with self.assertRaisesRegex(d.ProtocolError, "invalid partial directory"):
            self.store.inspect(request, self.device)
        self.assertEqual(partial.read_text(encoding="utf-8"), "ordinary file")
    def test_inspect_rejects_partial_directory_symlink(self):
        job = self.begin()
        payload, manifest = self.payload(job)
        partial = payload / "profile" / ".tavernsyn-partial"
        request = dict(job=job, manifest=manifest)
        try:
            partial.symlink_to(self.work, target_is_directory=True)
        except OSError as error:
            self.skipTest(f"directory symlink unavailable: {error}")
        with self.assertRaisesRegex(d.ProtocolError, "symlink"):
            self.store.inspect(request, self.device)
        self.assertTrue(partial.is_symlink())

    def test_category_push_mirrors_deletions_and_preserves_every_unselected_file(self):
        for scope in (["characters"], ["chats"], ["worlds"], ["chats", "characters", "worlds"]):
            with self.subTest(scope=scope):
                before = self.complete_publication()
                expected = {file["path"]: file["sha256"] for file in before["manifest"]["files"] if file["path"] != "environment.json" and not d.in_scope(file["path"], scope)}
                job, _, manifest = self.category_upload(scope)
                result = self.commit(dict(job=job, manifest=manifest), self.device)
                current = self.store.current()
                self.assertEqual(result["snapshotDigest"], manifest["digest"])
                self.assertEqual(result["digest"], current["digest"])
                self.assertNotEqual(result["digest"], manifest["digest"])
                actual = {file["path"]: file["sha256"] for file in current["manifest"]["files"] if file["path"] != "environment.json" and not d.in_scope(file["path"], scope)}
                self.assertEqual(actual, expected)
                self.assertFalse(any("old." in file["path"] and d.in_scope(file["path"], scope) for file in current["manifest"]["files"]))
                metadata = d.read(self.root / "generations" / job / "payload/environment.json")
                self.assertNotIn("scope", metadata)
                self.assertEqual(metadata["sourceState"]["digest"], d.source_state(metadata, metadata["sourceState"]["files"])["digest"])
                catalog = self.store.catalog(scope)
                selected = json.loads(catalog["environment"])
                self.assertEqual(selected["sourceState"]["digest"], d.source_state(selected, selected["sourceState"]["files"], scope)["digest"])
                self.assertTrue(all(file["path"] == "environment.json" or d.in_scope(file["path"], scope) for file in catalog["manifest"]["files"]))

    def test_empty_category_is_an_explicit_delete_not_an_empty_full_snapshot(self):
        self.complete_publication()
        job, _, manifest = self.category_upload(["worlds"], empty=True)
        self.commit(dict(job=job, manifest=manifest), self.device)
        current = self.store.current()
        self.assertFalse(any(d.in_scope(file["path"], ["worlds"]) for file in current["manifest"]["files"]))
        self.assertTrue(any(file["path"] == "profile/characters/old.png" for file in current["manifest"]["files"]))

    def test_category_job_rejects_outside_files_and_changed_resume_scope(self):
        before = self.complete_publication()
        job, upload, _ = self.category_upload(["worlds"])
        (upload / "profile/settings.json").write_text('{"unexpected":true}', encoding="utf-8")
        with self.assertRaises(d.ProtocolError):
            self.commit(dict(job=job, manifest=d.scan(upload)), self.device)
        self.assertEqual(self.store.current()["generation"], before["generation"])
        with self.assertRaises(d.ProtocolError):
            self.store.begin(dict(job=job, direction="push", scope=["characters"], dataset=self.dataset, jobBound=True), self.device)

    def test_category_publication_receipt_and_retry_after_rename(self):
        before = self.complete_publication()
        job, _, manifest = self.category_upload(["characters"])
        atomic = d.atomic
        def fail_pointer(file, value):
            if Path(file).name == "current.json":
                raise OSError("synthetic pre-publication failure")
            return atomic(file, value)
        with patch.object(d, "atomic", side_effect=fail_pointer):
            with self.assertRaises(OSError):
                self.commit(dict(job=job, manifest=manifest), self.device)
        self.assertEqual(self.store.current()["generation"], before["generation"])
        published = self.commit(dict(job=job, manifest=manifest), self.device)
        replay = self.commit(dict(job=job, manifest=manifest), self.device)
        self.assertEqual(published["digest"], replay["digest"])
        self.assertEqual(self.store.published(dict(job=job, scope=["characters"], snapshotDigest=manifest["digest"]))["digest"], published["digest"])
        with self.assertRaises(d.ProtocolError):
            self.store.published(dict(job=job, scope=["worlds"], snapshotDigest=manifest["digest"]))

    def test_category_download_resumes_until_a_successful_sync_supersedes_it(self):
        with self.assertRaises(d.ProtocolError):
            self.store.catalog(["worlds"])
        current = self.complete_publication()
        job = str(uuid.uuid4())
        result = self.store.begin(dict(job=job, direction="pull", scope=["chats"], dataset=self.dataset, jobBound=True), self.device)
        self.assertEqual(result["publicationDigest"], current["digest"])
        paths = {file["path"] for file in result["manifest"]["files"]}
        self.assertIn("profile/groups/g.json", paths)
        self.assertIn("profile/group chats/g.jsonl", paths)
        self.assertNotIn("profile/settings.json", paths)
        self.store.close()
        resumed = self.store.begin(dict(job=job, direction="pull", scope=["chats"], dataset=self.dataset, jobBound=True), self.device)
        self.assertEqual(resumed["generation"], current["generation"])
        self.store.close()
        self.complete_publication()
        with self.assertRaisesRegex(d.ProtocolError, "NO_JOB"):
            self.store.begin(dict(job=job, direction="pull", scope=["chats"], dataset=self.dataset, jobBound=True, resumeOnly=True), self.device)

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
            self.commit(dict(job=second, manifest=manifest), self.device)
        self.assertEqual(self.store.current()["generation"], first)
        self.assertEqual(self.store.active()["phase"], "transfer")
        self.store.finish(dict(job=second), self.device, abort=True)
        self.assertEqual(self.store.current()["generation"], first)

    def test_commit_response_loss_is_idempotent_and_gc_retains_only_current(self):
        first, _ = self.publish()
        second, manifest = self.publish("two")
        # Reconnect with the same job; publication and cleanup stay idempotent.
        self.begin(job=second)
        replay = self.commit(dict(job=second, manifest=manifest), self.device)
        self.assertEqual(replay["digest"], manifest["digest"])
        self.assertFalse((self.root / "previous.json").exists())
        self.assertFalse((self.root / "generations" / first).exists())
        third, _ = self.publish("three")
        self.assertEqual({x.name for x in (self.root / "generations").iterdir()}, {third})
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
                self.commit(dict(job=second, manifest=manifest), self.device)
        self.assertEqual(self.store.current()["generation"], first)
        self.assertTrue((self.root / "generations" / second / "COMPLETE.json").exists())
        self.commit(dict(job=second, manifest=manifest), self.device)
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
            self.commit(dict(job=job, manifest=d.scan(payload)), self.device)
        self.assertIsNone(self.store.current())

    def test_successful_publication_removes_superseded_download_and_uploads(self):
        published, manifest = self.publish()
        job = self.begin(direction="pull")
        active = self.store.active()
        self.assertEqual(active["generation"], published)
        self.assertEqual(active["manifest"]["digest"], manifest["digest"])
        self.store.close()
        upload = self.begin()
        self.payload(upload, "unfinished")
        self.store.close()
        archive = self.root / "private/archived-jobs" / str(uuid.uuid4())
        archive.mkdir(parents=True)
        (archive / "staging.bin").write_bytes(b"obsolete")
        current, _ = self.publish("two")
        self.assertFalse((self.root / "generations" / published).exists())
        self.assertFalse(self.store.parked_file(job).exists())
        self.assertFalse((self.root / "incoming" / upload).exists())
        self.assertFalse(archive.exists())
        self.assertEqual(self.store.current()["generation"], current)

    def test_successful_download_cleans_old_data_but_abort_preserves_recovery(self):
        current, _ = self.publish()
        old = self.begin()
        payload, manifest = self.payload(old, "unfinished")
        self.store.close()
        job = self.begin(direction="pull")
        self.store.finish(dict(job=job), self.device, abort=True)
        self.assertEqual(d.scan(payload)["digest"], manifest["digest"])
        job = self.begin(direction="pull")
        self.store.finish(dict(job=job), self.device)
        self.assertFalse(payload.exists())
        self.assertFalse(self.store.parked_file(old).exists())
        self.assertEqual(self.store.current()["generation"], current)

    def test_download_cleanup_failure_is_success_with_warning_and_can_retry(self):
        current, _ = self.publish()
        job = self.begin(direction="pull")
        with patch.object(self.store, "gc", side_effect=PermissionError()):
            result = self.store.finish(dict(job=job), self.device)
        self.assertEqual(result["phase"], "done")
        self.assertEqual(result["maintenance"], ["generations"])
        self.assertEqual(self.store.current()["generation"], current)
        self.assertNotIn("maintenance", self.store.finish(dict(job=job), self.device))

    def test_cleanup_refuses_unexpected_paths_without_deleting_valid_data(self):
        current, _ = self.publish()
        old = self.begin()
        payload, manifest = self.payload(old)
        self.store.close()
        unexpected = self.root / "incoming/keep-me"
        unexpected.mkdir()
        job = self.begin(direction="pull")
        result = self.store.finish(dict(job=job), self.device)
        self.assertEqual(result["maintenance"], ["generations"])
        self.assertTrue(unexpected.exists())
        self.assertEqual(d.scan(payload)["digest"], manifest["digest"])
        self.assertEqual(self.store.current()["generation"], current)

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
        self.commit(dict(job=job, manifest=manifest), self.device)
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
        with self.assertRaisesRegex(d.ProtocolError, "NO_JOB"):
            self.store.begin(dict(job=old, direction="push", dataset=self.dataset, jobBound=True, resumeOnly=True), self.device)
        self.assertEqual(self.store.current()["generation"], current)
        self.assertFalse(payload.exists())

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
                self.commit(dict(job=job, manifest=manifest), self.device)
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
        job = str(uuid.uuid4())
        for module in ("wire", "payload"):
            self.assertEqual(d.ssh_command(f"tavernsyn-rsync-v3 {self.device} {job} {module} --server --daemon ."), ("rsync", self.device))
        for command in (f"tavernsyn-rsync-v1 {self.device} --server --daemon .",
                        f"tavernsyn-rsync-v2 {self.device} {job} --server --daemon ."):
            with self.assertRaisesRegex(d.ProtocolError, "UPGRADE_REQUIRED"):
                d.ssh_command(command)
        for command in ("sh", f"tavernsyn-control-v1 {self.device}; id", "tavernsyn-control-v1 ../bad",
                        f"tavernsyn-rsync-v1 {self.device} --server --daemon /etc", f"tavernsyn-control-v1 {self.device} extra"):
            with self.assertRaises(d.ProtocolError):
                d.ssh_command(command)

    def test_password_entry_requires_tailscale_source(self):
        for source in ("100.64.0.1 12345 100.100.1.1 22", "fd7a:115c:a1e0::1 12345 fd7a:115c:a1e0::2 22"):
            self.assertTrue(d.tailscale_source(source))
        for source in ("", "127.0.0.1 22 127.0.0.1 22", "203.0.113.1 22 x 22", "100.128.0.1 22 x 22"):
            self.assertFalse(d.tailscale_source(source))

    def test_hybrid_hello_and_old_job_fail_before_changing_storage(self):
        job = str(uuid.uuid4())
        request = dict(op="begin", job=job, direction="push", dataset=self.dataset, jobBound=True)
        for message in (request, dict(op="hello"), dict(op="hello", requiredProtocol="hybrid-v1")):
            with self.assertRaisesRegex(d.ProtocolError, "UPGRADE_REQUIRED"):
                self.store.command(message, self.device)
        self.assertFalse((self.root / "incoming" / job).exists())
        self.assertIsNone(self.store.current())
        hello = self.store.command(dict(op="hello", requiredProtocol="hybrid-v2"), self.device)
        self.assertEqual(hello["hybridProtocol"], "hybrid-v2")
        self.assertIn("hybrid-v2", hello["capabilities"])
        self.store.command(request, self.device)
        active = self.store.active()
        active["protocol"] = "hybrid-v1"
        d.atomic(self.store.private / "active.json", active)
        self.store.close()
        paused = self.store.active()
        with self.assertRaisesRegex(d.ProtocolError, "UPGRADE_REQUIRED"):
            self.store.begin({**request, "resumeOnly": True}, self.device)
        self.assertEqual(self.store.active(), paused)

    def test_frozen_upload_replays_after_missing_bundle_and_interrupted_apply(self):
        job = self.begin()
        stage, _ = self.payload(job)
        source = self.work / "source"
        shutil.copytree(stage, source)
        for name in ("first.txt", "second.txt"):
            (source / "profile" / name).write_text(name, encoding="utf-8")
        manifest = d.scan(source)
        request = dict(job=job, manifest=manifest)
        plan = self.store.hybrid_plan(request, self.device)["plan"]
        self.assertEqual([[f["path"] for f in group] for group in plan["groups"]],
                         [["profile/first.txt", "profile/second.txt"]])
        wire = self.store.hybrid_dir(self.store.active()) / "wire" / "0.bundle"
        local = self.work / "local.bundle"
        descriptor = d.hybrid.create_bundle(source, local, plan, manifest, 0)
        self.store.hybrid_descriptors(dict(job=job, descriptors=[descriptor]), self.device)
        with self.assertRaises(OSError):
            self.store.hybrid_apply(request, self.device)
        self.assertIsNone(self.store.current())
        shutil.copyfile(local, wire)
        apply = d.hybrid.apply_bundle

        def stop_after_write(*args):
            apply(*args)
            raise OSError("fixture interruption before applied record")

        with patch.object(d.hybrid, "apply_bundle", side_effect=stop_after_write):
            with self.assertRaisesRegex(OSError, "fixture interruption"):
                self.store.hybrid_apply(request, self.device)
        self.assertIsNone(self.store.current())
        self.store.close()
        self.begin(job)
        self.assertEqual(self.store.hybrid_plan(request, self.device), dict(plan=plan, descriptors=[descriptor]))
        with self.assertRaises(d.ProtocolError):
            self.store.hybrid_descriptors(dict(job=job, descriptors=[{**descriptor, "sha256": "0" * 64}]), self.device)
        self.assertEqual(self.store.hybrid_apply(request, self.device)["planDigest"], plan["digest"])
        self.assertEqual(self.store.commit(request, self.device)["digest"], manifest["digest"])
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
            hello = json.dumps(dict(op="hello", requiredProtocol="hybrid-v2", id=1))
            begin = json.dumps({**message, "id": 2, "op": "begin"})
            result = subprocess.run([os.sys.executable, str(PROJECT / "vps/dispatcher.py"), "--root", str(store.root)],
                                    input=hello + "\n" + begin + "\n", text=True,
                                    capture_output=True, env=env, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual([json.loads(line)["ok"] for line in result.stdout.splitlines()], [True, True], result.stdout)
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
