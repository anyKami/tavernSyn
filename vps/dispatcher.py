#!/usr/bin/env python3
"""On-demand forced SSH command. No daemon, eval, network listener or user paths."""
import argparse
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import shlex
import stat
import subprocess
import sys
import time
import unicodedata
import uuid

try:
    import fcntl
except ImportError:
    fcntl = None  # Store tests run on Windows; serving SSH requires Linux flock.

MAX_LINE = 64 * 1024 * 1024
ID = re.compile(r"^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$")


class ProtocolError(Exception):
    pass


def check(condition, message):
    if not condition:
        raise ProtocolError(message)


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def atomic(file, value):
    file = Path(file)
    temp = file.with_name(file.name + "." + str(uuid.uuid4()) + ".tmp")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, file)
    except BaseException:
        try:
            temp.unlink(missing_ok=True)
        except OSError:
            pass  # Keep the original failure; never remove the valid destination.
        raise
    if os.name != "nt":
        fd = os.open(file.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def read(file):
    with open(file, encoding="utf-8") as stream:
        return json.load(stream)


def safe_relative(name):
    check(isinstance(name, str) and 0 < len(name) <= 220 and "\\" not in name, "unsafe path")
    for part in name.split("/"):
        check(part and part not in (".", "..", ".tavernsyn-partial", "__proto__", "prototype", "constructor")
              and len(part) <= 120 and not re.search(r'[<>:"|?*\x00-\x1f\x7f]', part)
              and not part.endswith((".", " "))
              and not re.match(r"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)", part, re.I), "nonportable path")
    return name


def digest_files(files):
    return hashlib.sha256(canonical([{k: f[k] for k in ("path", "size", "sha256")} for f in files]).encode()).hexdigest()


def manifest_valid(value):
    check(isinstance(value, dict) and value.get("format") == 1 and isinstance(value.get("files"), list)
          and len(value["files"]) <= 200000, "invalid manifest")
    seen = set()
    for file in value["files"]:
        safe_relative(file["path"])
        key = unicodedata.normalize("NFC", file["path"]).lower()
        check(key not in seen and type(file.get("size")) is int and file["size"] >= 0
              and type(file.get("mtime")) is int and re.fullmatch("[a-f0-9]{64}", file.get("sha256", "")), "invalid manifest entry")
        seen.add(key)
    files = sorted(value["files"], key=lambda f: f["path"])
    check(digest_files(files) == value.get("digest") and sum(f["size"] for f in files) == value.get("bytes"), "manifest digest mismatch")
    return value


def scan(root):
    root = Path(root)
    files, seen = [], set()

    def visit(directory, prefix=""):
        for entry in sorted(directory.iterdir(), key=lambda p: p.name):
            relative = prefix + entry.name
            safe_relative(relative)
            folded = unicodedata.normalize("NFC", relative).lower()
            check(folded not in seen, "case/unicode collision")
            seen.add(folded)
            info = entry.lstat()
            check(not stat.S_ISLNK(info.st_mode), "symlink rejected")
            if stat.S_ISDIR(info.st_mode):
                visit(entry, relative + "/")
            else:
                check(stat.S_ISREG(info.st_mode), "special file rejected")
                sha = hashlib.sha256()
                with entry.open("rb") as stream:
                    for block in iter(lambda: stream.read(1024 * 1024), b""):
                        sha.update(block)
                after = entry.stat()
                check((info.st_size, info.st_mtime_ns, info.st_ctime_ns) == (after.st_size, after.st_mtime_ns, after.st_ctime_ns), "file changed while hashing")
                files.append(dict(path=relative, size=info.st_size, mtime=int(info.st_mtime), sha256=sha.hexdigest()))

    visit(root)
    files.sort(key=lambda f: f["path"])
    return dict(format=1, files=files, bytes=sum(f["size"] for f in files), digest=digest_files(files))


def difference(expected, actual):
    manifest_valid(expected)
    manifest_valid(actual)
    wanted = {f["path"]: f for f in expected["files"]}
    have = {f["path"]: f for f in actual["files"]}
    changed = [name for name, f in wanted.items() if name not in have or (f["size"], f["sha256"]) != (have[name]["size"], have[name]["sha256"])]
    extra = [name for name in have if name not in wanted]
    return dict(changed=changed, extra=extra, equal=not changed and not extra)


def payload_paths(manifest):
    for file in manifest["files"]:
        name = file["path"].lower()
        check(name == "environment.json" or re.match(r"^(profile|extensions|server-plugins|extra)/", name)
              or re.match(r"^shared/(_css|_errors)/", name) or re.match(r"^repositories/\d+/gitdata/", name), "payload outside scope")
        check(not re.match(r"^(extensions|server-plugins)/tavernsyn/", name)
              and not name.startswith("profile/extensions/tavernsyn/") and name != "server-plugins/package.json", "sync code is device-local")
        if not name.startswith("repositories/"):
            check(not any(part in ("node_modules", ".git", ".ssh", ".tailscale") for part in name.split("/")), "device dependencies/identity rejected")


CATEGORIES = {"chats": ["chats", "group chats", "groups"], "characters": ["characters"], "worlds": ["worlds"]}


def scope_valid(scope):
    if scope is None:
        return None
    check(isinstance(scope, list) and 0 < len(scope) <= 3 and all(isinstance(item, str) and item in CATEGORIES for item in scope)
          and len(set(scope)) == len(scope), "invalid selected categories")
    return sorted(scope)


def scope_paths(scope):
    return ["profile/" + folder for category in scope_valid(scope) for folder in CATEGORIES[category]]


def in_scope(name, scope):
    return any(name.startswith(prefix + "/") for prefix in scope_paths(scope))


def sealed(files):
    files = sorted(files, key=lambda file: file["path"])
    return dict(format=1, files=files, bytes=sum(file["size"] for file in files), digest=digest_files(files))


def source_state(metadata, files, scope=None):
    identity = dict(files=sorted([{k: file[k] for k in ("path", "sha256")} for file in files], key=lambda file: file["path"]),
                    plugins=sorted([{k: plugin[k] for k in ("code", "commit", "branch", "origin")} for plugin in metadata.get("plugins", [])], key=lambda plugin: plugin["code"]),
                    config=metadata.get("config", {}), extraRoots=sorted(metadata.get("extraRoots", [])), executables=sorted(metadata.get("executables", [])))
    if scope:
        identity["scope"] = scope_valid(scope)
    return dict(format=2, digest=hashlib.sha256(canonical(identity).encode()).hexdigest(), **identity)


class Lock:
    def __init__(self, path, shared=False):
        check(fcntl is not None, "SSH dispatcher requires Linux flock")
        self.stream = open(path, "a+b")
        try:
            fcntl.flock(self.stream, (fcntl.LOCK_SH if shared else fcntl.LOCK_EX) | fcntl.LOCK_NB)
        except BlockingIOError:
            self.stream.close()
            raise ProtocolError("BUSY: another operation or transfer is active")

    def close(self):
        self.stream.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


class Store:
    def __init__(self, root):
        requested = Path(root).absolute()
        check(requested == requested.resolve() and requested.is_dir(), "storage root contains a link or is missing")
        self.root = requested
        self.private = self.root / "private"
        self.format = read(self.root / "FORMAT.json")
        check(self.format.get("format") == 1 and ID.fullmatch(self.format.get("dataset", "")), "not initialized")
        self.lock = None
        self.job = None

    def current(self):
        pointer = self.root / "current.json"
        if not pointer.exists():
            return None
        current = read(pointer)
        check(ID.fullmatch(current.get("generation", "")), "invalid current pointer")
        generation = self.root / "generations" / current["generation"]
        complete = read(generation / "COMPLETE.json")
        manifest = manifest_valid(read(generation / "manifest.json"))
        check(current.get("digest") == manifest["digest"] == complete.get("digest"), "incomplete generation")
        return {**current, "manifest": manifest}

    def active(self):
        file = self.private / "active.json"
        return read(file) if file.exists() else None

    def save(self, job):
        atomic(self.private / "active.json", job)

    def parked_file(self, job):
        check(ID.fullmatch(job), "invalid job id")
        return self.private / "paused-jobs" / (job + ".json")

    def park(self, job):
        # Call only while holding BOTH exclusive locks. No payload is removed or copied.
        if job["phase"] in ("done", "aborted", "paused"):
            return
        file = self.parked_file(job["job"])
        file.parent.mkdir(mode=0o700, exist_ok=True)
        atomic(file, {**job, "pausedAt": int(time.time())})
        self.save({**job, "phase": "paused", "resumePhase": job["phase"]})

    def close(self):
        try:
            if self.lock and self.job:
                try:
                    with Lock(self.private / "transfer.lock"):
                        active = self.active()
                        if active and active["job"] == self.job:
                            self.park(active)
                except ProtocolError as error:
                    # A separate rsync SSH process may still be draining. The next begin
                    # must acquire its lock before parking this legacy active record.
                    if not str(error).startswith("BUSY:"):
                        raise
        finally:
            if self.lock:
                self.lock.close()
                self.lock = None

    def begin(self, message, device):
        check(ID.fullmatch(message.get("job", "")), "invalid job id")
        check(message.get("dataset") == self.format["dataset"], "wrong dataset")
        check(message.get("jobBound") is True, "UPGRADE_REQUIRED: update the device before starting a transfer")
        direction = message.get("direction")
        check(direction in ("push", "pull"), "invalid direction")
        scope = scope_valid(message.get("scope"))
        if self.lock is None:
            self.lock = Lock(self.private / "operation.lock")
        with Lock(self.private / "transfer.lock"):
            active = self.active()
            current = self.current()
            parked = self.parked_file(message["job"])
            prior = active if active and active["job"] == message["job"] else read(parked) if parked.exists() else None
            check(prior or not message.get("resumeOnly"), "NO_JOB: no retained job with this id")
            if prior:
                check(prior["device"] == device and prior["direction"] == direction, "wrong job owner or direction")
                check(scope_valid(prior.get("scope")) == scope, "job categories changed")
                check(prior["phase"] != "aborted", "job was aborted; start a new job")
                if prior["phase"] == "done":
                    return self.describe(prior)
                if prior["phase"] == "paused":
                    prior = {**prior, "phase": prior["resumePhase"]}
                    prior.pop("resumePhase", None)
                if direction == "push":
                    check((current["digest"] if current else None) == prior["base"]
                          or (current and current["generation"] == prior["generation"]),
                          "REMOTE_CHANGED: interrupted upload is based on an older publication")
                else:
                    check((self.root / "generations" / prior["generation"] / "COMPLETE.json").is_file(), "download generation is no longer available")
                if active and active["job"] != prior["job"]:
                    self.park(active)
                self.save(prior)
                parked.unlink(missing_ok=True)
                self.job = prior["job"]
                return self.describe(prior)
            if direction == "push":
                check(message.get("base") == (current["digest"] if current else None), "REMOTE_CHANGED: preview no longer current")
            else:
                check(current is not None, "EMPTY_REMOTE: no published data")
            if scope:
                self.catalog(scope, current)  # Requires a complete initial publication.
            if active:
                self.park(active)
            seed = self.root / "generations" / current["generation"] / "payload" if current else None
            seeded_from = None
            if direction == "push" and active and active["direction"] == "push" and scope_valid(active.get("scope")) == scope and active["phase"] not in ("done", "aborted") \
                    and active["base"] == (current["digest"] if current else None):
                # Copy/reflink interrupted bytes into the new task. The retained job
                # stays independent; rsync plus SHA-256 verification handles differences.
                check(ID.fullmatch(active["generation"]), "invalid interrupted generation")
                for directory in ("incoming", "generations"):
                    candidate = self.root / directory / active["generation"] / ("upload" if scope else "payload")
                    if candidate.is_dir():
                        check(candidate.resolve() == candidate, "linked interrupted payload")
                        seed, seeded_from = candidate, active["job"]
                        break
            if direction == "pull":
                generation = current["generation"]
                payload = self.root / "generations" / generation / "payload"
            else:
                generation = message["job"]
                payload = self.root / "incoming" / generation / ("upload" if scope else "payload")
                check(not payload.parent.exists(), "staging path already exists")
                payload.parent.mkdir(mode=0o700)
                if seed and scope:
                    payload.mkdir(mode=0o700)
                    for relative in scope_paths(scope):
                        source = seed / relative
                        if source.exists():
                            target = payload / relative
                            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                            subprocess.run(["cp", "--reflink=auto", "--recursive", "--preserve=timestamps", "--no-dereference", str(source), str(target)], check=True, stdout=subprocess.DEVNULL)
                elif seed:
                    # reflink or independent copy; never hardlinks and never a live ST directory.
                    subprocess.run(["cp", "--reflink=auto", "--recursive", "--preserve=timestamps", "--no-dereference",
                                    str(seed), str(payload)], check=True, stdout=subprocess.DEVNULL)
                else:
                    payload.mkdir(mode=0o700)
            job = dict(job=message["job"], device=device, direction=direction, generation=generation,
                       phase="transfer", base=current["digest"] if current else None, payload=str(payload))
            if scope:
                job["scope"] = scope
                job["baseGeneration"] = current["generation"]
            if direction == "pull":
                if scope:
                    selected = self.catalog(scope, current)
                    job.update(manifest=selected["manifest"], environment=selected["environment"], publicationDigest=current["digest"])
                else:
                    job["manifest"] = current["manifest"]
            elif seeded_from:
                job["seededFrom"] = seeded_from
            self.save(job)
            self.job = job["job"]
            return self.describe(job)

    def describe(self, job):
        return {k: job[k] for k in ("job", "direction", "generation", "phase", "base", "manifest", "seededFrom", "scope", "environment", "publicationDigest") if k in job} | {"module": "payload"}

    def catalog(self, scope, current=None):
        scope = scope_valid(scope)
        check(scope is not None, "selected categories required")
        current = current or self.current()
        check(current is not None, "EMPTY_REMOTE: publish a complete snapshot before category synchronization")
        metadata = read(self.root / "generations" / current["generation"] / "payload" / "environment.json")
        check(not metadata.get("scope") and any(file["path"] == "profile/settings.json" and file["size"] > 2 for file in current["manifest"]["files"]), "EMPTY_REMOTE: a complete publication is required")
        files = [file for file in current["manifest"]["files"] if in_scope(file["path"], scope)]
        state_files = [file for file in metadata.get("sourceState", {}).get("files", []) if in_scope(file["path"], scope)]
        check({file["path"] for file in state_files} == {file["path"] for file in files}, "incomplete selected source state")
        selected = {k: metadata[k] for k in ("format", "sourceVersion", "sourcePlatform", "sourceArch") if k in metadata}
        selected.update(scope=scope, plugins=[], config={}, extraRoots=[], warnings=[], executables=[name for name in metadata.get("executables", []) if in_scope(name, scope)])
        selected["sourceState"] = source_state(selected, state_files, scope)
        environment = canonical(selected) + "\n"
        entry = dict(path="environment.json", size=len(environment.encode()), mtime=0, sha256=hashlib.sha256(environment.encode()).hexdigest())
        return dict(generation=current["generation"], digest=current["digest"], scope=scope, manifest=sealed(files + [entry]), environment=environment)

    def merge_scope(self, job, manifest, active_root):
        temporary = active_root / (".merge-" + str(uuid.uuid4()))
        try:
            return self._merge_scope(job, manifest, active_root, temporary)
        finally:
            if temporary.exists():
                shutil.rmtree(temporary)

    def _merge_scope(self, job, manifest, active_root, temporary):
        scope = scope_valid(job["scope"])
        upload = active_root / "upload"
        check(difference(manifest, scan(upload))["equal"], "INTEGRITY: category upload is incomplete")
        incoming = read(upload / "environment.json")
        check(scope_valid(incoming.get("scope")) == scope and not incoming.get("plugins") and not incoming.get("extraRoots")
              and not incoming.get("config") and all(file["path"] == "environment.json" or in_scope(file["path"], scope) for file in manifest["files"]), "category upload outside scope")
        state_files = incoming.get("sourceState", {}).get("files", [])
        check({file["path"] for file in state_files} == {file["path"] for file in manifest["files"] if file["path"] != "environment.json"}
              and all(in_scope(name, scope) for name in incoming.get("executables", []))
              and source_state(incoming, state_files, scope)["digest"] == incoming.get("sourceState", {}).get("digest"), "invalid selected source state")
        base = self.root / "generations" / job["baseGeneration"] / "payload"
        subprocess.run(["cp", "--reflink=auto", "--recursive", "--preserve=timestamps", "--no-dereference", str(base), str(temporary)], check=True, stdout=subprocess.DEVNULL)
        for relative in scope_paths(scope):
            target, source = temporary / relative, upload / relative
            if target.exists():
                check(target.is_dir() and not target.is_symlink(), "invalid selected destination")
                shutil.rmtree(target)
            if source.exists():
                check(source.is_dir() and not source.is_symlink(), "invalid selected source")
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                subprocess.run(["cp", "--reflink=auto", "--recursive", "--preserve=timestamps", "--no-dereference", str(source), str(target)], check=True, stdout=subprocess.DEVNULL)
        metadata = read(base / "environment.json")
        metadata["executables"] = sorted(set([name for name in metadata.get("executables", []) if not in_scope(name, scope)] + incoming.get("executables", [])))
        files = [file for file in metadata["sourceState"]["files"] if not in_scope(file["path"], scope)] + state_files
        metadata["sourceState"] = source_state(metadata, files)
        atomic(temporary / "environment.json", metadata)
        merged = scan(temporary)
        payload_paths(merged)
        target = active_root / "payload"
        if target.exists():
            check(not target.is_symlink(), "invalid category publication stage")
            shutil.rmtree(target)
        os.rename(temporary, target)
        atomic(active_root / "SCOPE.json", dict(scope=scope, snapshotDigest=manifest["digest"], digest=merged["digest"]))
        return merged

    def published(self, message):
        current = self.current()
        check(current and current["generation"] == message.get("job"), "COMMIT_NOT_CONFIRMED: publication is not current")
        receipt = read(self.root / "generations" / current["generation"] / "SCOPE.json")
        check(receipt["scope"] == scope_valid(message.get("scope")) and receipt["snapshotDigest"] == message.get("snapshotDigest")
              and receipt["digest"] == current["digest"], "COMMIT_NOT_CONFIRMED: category receipt differs")
        return dict(generation=current["generation"], digest=current["digest"], snapshotDigest=receipt["snapshotDigest"], phase="done")

    def own_job(self, message, device):
        check(self.lock is not None, "begin/resume control session first")
        job = self.active()
        check(job and job["device"] == device and job["job"] == message.get("job"), "wrong job owner")
        return job

    def inspect(self, message, device):
        job = self.own_job(message, device)
        check(job["phase"] == "transfer" and job["direction"] == "push", "not an upload")
        with Lock(self.private / "transfer.lock"):
            self.clean_partials(Path(job["payload"]))
            return difference(message["manifest"], scan(job["payload"]))

    @staticmethod
    def clean_partials(root):
        for directory, dirs, _ in os.walk(root, followlinks=False):
            for name in list(dirs):
                full = Path(directory) / name
                check(not full.is_symlink(), "symlink in stage")
                if name == ".tavernsyn-partial":
                    shutil.rmtree(full)
                    dirs.remove(name)

    def commit(self, message, device):
        job = self.own_job(message, device)
        manifest = manifest_valid(message["manifest"])
        payload_paths(manifest)
        scope = scope_valid(job.get("scope"))
        current = self.current()
        if scope and current and current["generation"] == job["generation"]:
            return self.describe(job) | self.published(dict(job=job["job"], scope=scope, snapshotDigest=manifest["digest"]))
        if job["phase"] == "done":
            current = self.current()
            check(current and current["generation"] == job["generation"] and current["digest"] == manifest["digest"], "different committed result")
            return self.describe(job) | {"digest": manifest["digest"]}
        check(job["direction"] == "push" and job["phase"] in ("transfer", "finalizing"), "not an upload")
        check(scope or any(f["path"] == "profile/settings.json" and f["size"] > 2 for f in manifest["files"]), "EMPTY_SOURCE: missing profile settings")
        job["phase"] = "finalizing"
        self.save(job)  # Daemon dispatcher rejects any new transfer before exclusive lock acquisition.
        with Lock(self.private / "transfer.lock"):
            stage = self.root / "incoming" / job["generation"]
            generation = self.root / "generations" / job["generation"]
            active_root = stage if stage.exists() else generation
            self.clean_partials(active_root / "payload")
            if not difference(manifest, scan(active_root / ("upload" if scope else "payload")))["equal"]:
                if stage.exists():
                    job["phase"] = "transfer"
                    self.save(job)
                raise ProtocolError("INTEGRITY: upload is incomplete")
            snapshot_digest = manifest["digest"]
            if scope:
                manifest = self.merge_scope(job, manifest, active_root)
            atomic(active_root / "manifest.json", manifest)
            atomic(active_root / "COMPLETE.json", {"digest": manifest["digest"], "generation": job["generation"]})
            # Ensure transferred file data precedes the publication pointer.
            for directory, _, files in os.walk(active_root):
                for name in files:
                    # rsync can preserve a source file's read-only mode. fsync needs
                    # only a readable descriptor on Linux; do not request write access.
                    with open(Path(directory) / name, "r+b" if os.name == "nt" else "rb") as stream:
                        os.fsync(stream.fileno())
                if os.name != "nt":
                    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
                    try:
                        os.fsync(fd)
                    finally:
                        os.close(fd)
            if stage.exists():
                os.rename(stage, generation)
                if os.name != "nt":
                    for directory in (stage.parent, generation.parent):
                        fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
                        try:
                            os.fsync(fd)
                        finally:
                            os.close(fd)
            current = self.current()
            if current and current["generation"] != job["generation"]:
                atomic(self.root / "previous.json", {k: current[k] for k in ("generation", "digest")})
            maintenance = []
            try:
                atomic(self.root / "current.json", {"generation": job["generation"], "digest": manifest["digest"]})
            except OSError:
                # A directory fsync can fail after replace already changed the
                # pointer. Verify the committed fact before reporting its result.
                published = self.current()
                if not published or published["generation"] != job["generation"] or published["digest"] != manifest["digest"]:
                    raise
                maintenance.append("publication-sync")
            job["phase"] = "done"
            for name, action in (("job-record", lambda: self.save(job)),
                                 ("paused-record", lambda: self.parked_file(job["job"]).unlink(missing_ok=True)),
                                 ("generations", self.gc)):
                try:
                    action()
                except (OSError, ProtocolError):
                    maintenance.append(name)
            if scope:
                try:
                    shutil.rmtree(generation / "upload")
                except OSError:
                    maintenance.append("category-staging")
            return self.describe(job) | {"digest": manifest["digest"], **({"snapshotDigest": snapshot_digest} if scope else {}), **({"maintenance": maintenance} if maintenance else {})}

    def gc(self):
        keep = {read(self.root / name)["generation"] for name in ("current.json", "previous.json") if (self.root / name).exists()}
        paused = self.private / "paused-jobs"
        for file in paused.glob("*.json") if paused.exists() else []:
            check(ID.fullmatch(file.stem) and not file.is_symlink(), "unexpected paused job path")
            job = read(file)
            # Pin interrupted downloads and publications interrupted after rename.
            check(ID.fullmatch(job.get("generation", "")), "invalid paused generation")
            keep.add(job["generation"])
        for entry in (self.root / "generations").iterdir():
            check(ID.fullmatch(entry.name) and entry.is_dir() and not entry.is_symlink(), "unexpected generation path")
            if entry.name not in keep:
                shutil.rmtree(entry)

    def finish(self, message, device, abort=False):
        job = self.own_job(message, device)
        check(not (abort and job["phase"] == "done"), "job already completed; published data is unchanged")
        check(abort or job["direction"] == "pull" or job["phase"] == "done", "upload must commit before finish")
        with Lock(self.private / "transfer.lock"):
            job["phase"] = "aborted" if abort else "done"
            self.save(job)
            self.parked_file(job["job"]).unlink(missing_ok=True)
            if abort and job["direction"] == "push":
                stage = self.root / "incoming" / job["generation"]
                if stage.exists():
                    check(not stage.is_symlink(), "unsafe stage")
                    shutil.rmtree(stage)
        return self.describe(job)

    def command(self, message, device):
        op = message.get("op")
        if op == "hello":
            current = self.current()
            active = self.active()
            pending = {k: active[k] for k in ("job", "direction", "phase")} if active and active["device"] == device and active["phase"] not in ("done", "aborted") else None
            return {"protocol": 1, "version": "0.2.7", "capabilities": ["paused-jobs", "job-bound-rsync", "scoped-sync-v1"], "dataset": self.format["dataset"],
                    "current": {k: current[k] for k in ("generation", "digest")} if current else None, "pending": pending}
        if op == "begin":
            return self.begin(message, device)
        if op == "catalog":
            return self.catalog(scope_valid(message.get("scope")))
        if op == "published":
            return self.published(message)
        if op == "status":
            return self.describe(self.own_job(message, device))
        if op == "inspect":
            return self.inspect(message, device)
        if op == "commit":
            return self.commit(message, device)
        if op in ("finish", "abort"):
            return self.finish(message, device, abort=op == "abort")
        raise ProtocolError("unsupported control operation")


def serve_rsync(store, device, job_id=None):
    # Shared lock spans the *entire* rsync process, even when the separate control SSH disconnects.
    with Lock(store.private / "transfer.lock", shared=True):
        job = store.active()
        check(job_id is not None, "UPGRADE_REQUIRED: job-bound rsync required")
        check(job and job["job"] == job_id, "wrong transfer job")
        check(job and job["device"] == device and job["phase"] == "transfer", "no active transfer for this device")
        payload = Path(job["payload"])
        expected = store.root / ("incoming" if job["direction"] == "push" else "generations") / job["generation"] / ("upload" if job.get("scope") and job["direction"] == "push" else "payload")
        check(payload == expected and payload.resolve() == expected and not payload.is_symlink(), "invalid module root")
        config = store.private / ("rsync-" + job["job"] + "-" + str(os.getpid()) + ".conf")
        contents = "\n".join([
            "use chroot = no", "max connections = 1", "log file = /dev/null", "lock file = " + str(store.private / "rsync.lock"),
            "timeout = 120", "incoming chmod = Du+rwx,Fu+rw",
            "[payload]", "path = " + str(payload), "list = false", "read only = " + ("false" if job["direction"] == "push" else "true"),
            "write only = " + ("true" if job["direction"] == "push" else "false"),
            "refuse options = links copy-links copy-dirlinks keep-dirlinks hard-links devices specials owner group perms chmod inplace append append-verify backup backup-dir relative copy-dest link-dest",
        ]) + "\n"
        config.write_text(contents, encoding="utf-8")
        os.chmod(config, 0o600)
        try:
            return subprocess.run(["rsync", "--server", "--daemon", "--config=" + str(config), "."], check=False).returncode
        finally:
            config.unlink(missing_ok=True)


def initialize(root, dataset):
    check(ID.fullmatch(dataset), "dataset must be a UUID")
    root = Path(root).absolute()
    check(root == root.resolve() and len(root.parts) >= 3 and not root.exists()
          and all(re.fullmatch(r"[A-Za-z0-9_.-]+", part) for part in root.parts[1:]), "use a NEW dedicated storage directory without spaces")
    check(str(root) not in ("/home/root", "/var/lib", "/usr/local", "/opt/sillytavern", "/srv/sillytavern"), "unsafe storage directory")
    check(root.parent.is_dir(), "storage parent must already exist")
    root.mkdir(mode=0o700)
    for name in ("private", "incoming", "generations"):
        (root / name).mkdir(mode=0o700)
    atomic(root / "FORMAT.json", {"format": 1, "dataset": dataset})


def ssh_command(original):
    parts = shlex.split(original)
    check(len(parts) >= 2 and ID.fullmatch(parts[1]), "unsupported SSH command")
    if parts[0] == "tavernsyn-control-v1" and len(parts) == 2:
        return "control", parts[1]
    if parts[0] == "tavernsyn-rsync-v2":
        check(len(parts) == 6 and ID.fullmatch(parts[2]) and parts[3:] == ["--server", "--daemon", "."], "unsupported SSH command")
        return "rsync", parts[1]
    check(parts[0] == "tavernsyn-rsync-v1" and parts[2:] == ["--server", "--daemon", "."], "unsupported SSH command")
    return "rsync", parts[1]


def tailscale_source(connection):
    try:
        source = ipaddress.ip_address(connection.split()[0])
        return any(source in ipaddress.ip_network(network) for network in ("100.64.0.0/10", "fd7a:115c:a1e0::/48"))
    except (ValueError, IndexError):
        return False


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--init", metavar="DATASET_UUID")
    args = parser.parse_args()
    if args.init:
        initialize(args.root, args.init)
        return 0
    mode, device = ssh_command(os.environ.get("SSH_ORIGINAL_COMMAND", ""))
    check(tailscale_source(os.environ.get("SSH_CONNECTION", "")), "Tailscale source required")
    # Password holders share one account. Device UUIDs identify recovery jobs, not separate principals.
    store = Store(args.root)
    if mode == "rsync":
        parts = shlex.split(os.environ["SSH_ORIGINAL_COMMAND"])
        return serve_rsync(store, device, parts[2] if parts[0] == "tavernsyn-rsync-v2" else None)
    try:
        while True:
            line = sys.stdin.buffer.readline(MAX_LINE + 1)
            if not line:
                break
            check(len(line) <= MAX_LINE and line.endswith(b"\n"), "control message too large")
            message = json.loads(line)
            try:
                result = {"id": message.get("id"), "ok": True, "result": store.command(message, device)}
            except (ProtocolError, OSError, subprocess.CalledProcessError, KeyError, ValueError) as error:
                # No file contents, keys, environment or command output in replies.
                code = "PERMISSION" if isinstance(error, PermissionError) else str(error).split(":", 1)[0] if isinstance(error, ProtocolError) and ":" in str(error) else "REMOTE"
                result = {"id": message.get("id"), "ok": False, "error": str(error) if isinstance(error, ProtocolError) else type(error).__name__, "code": code}
            print(json.dumps(result, ensure_ascii=False), flush=True)
    finally:
        store.close()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ProtocolError, OSError, ValueError) as error:
        print("TavernSyn: " + (str(error) if isinstance(error, ProtocolError) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
