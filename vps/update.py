#!/usr/bin/env python3
"""Update an existing password-only VPS install; preserve passwords and all payloads."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tempfile
import time
import uuid


def check(condition, message):
    if not condition:
        raise RuntimeError(message)


def plain(file):
    file = Path(file).absolute()
    check(file == file.resolve(), "Linked paths are not supported: " + str(file))
    return file


def read(file):
    return json.loads(Path(file).read_text(encoding="utf-8"))


def replace(file, data, mode):
    file = plain(file)
    fd, name = tempfile.mkstemp(prefix=".tavernsyn-update-", dir=file.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            os.fchmod(stream.fileno(), mode)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, file)
        directory = os.open(file.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def keepalive(config, account):
    lines = config.splitlines()
    indexes = [i for i, line in enumerate(lines) if line.strip().lower() == "match user " + account.lower()]
    check(len(indexes) == 1, "Expected one dedicated sync-account Match block")
    first = indexes[0]
    last = next((i for i in range(first + 1, len(lines)) if lines[i].strip().lower().startswith("match ")), len(lines))
    body = [line for line in lines[first + 1:last]
            if not re.match(r"^\s*ClientAlive(?:Interval|CountMax)\s", line, re.I)]
    return "\n".join(lines[:first + 1] + ["    ClientAliveInterval 15", "    ClientAliveCountMax 3"] + body + lines[last:]) + "\n"


def run(args, **kwargs):
    return subprocess.run(args, check=True, text=True, capture_output=True, timeout=90, **kwargs).stdout


def pointers(root):
    return {name: hashlib.sha256((root / name).read_bytes()).hexdigest() if (root / name).is_file() else None
            for name in ("FORMAT.json", "current.json", "previous.json")}


def main():
    import fcntl
    import pwd
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True)
    parser.add_argument("--account", default="tavernsyn")
    parser.add_argument("--dataset", required=True)
    args = parser.parse_args()
    check(os.geteuid() == 0, "Run this updater as root")
    check(re.fullmatch(r"[a-z_][a-z0-9_-]{0,30}", args.account) and args.account != "root", "Invalid sync account")
    account = pwd.getpwnam(args.account)
    check(account.pw_uid != 0, "The sync account must not be root")
    root = plain(args.root)
    check(re.fullmatch(r"/(?:srv|var/lib)/[A-Za-z0-9_./-]+", str(root)) and ".." not in str(root), "Invalid dedicated storage root")
    check(read(root / "FORMAT.json").get("dataset") == args.dataset, "Wrong dataset; nothing updated")
    for directory in (root, root / "private", root / "incoming", root / "generations"):
        check(plain(directory).is_dir() and directory.stat().st_uid == account.pw_uid, "Unexpected storage owner: " + str(directory))
    target = plain("/usr/local/libexec/tavernsyn/password-dispatcher.py")
    config = plain(Path("/etc/ssh/tavernsyn") / (args.account + ".conf"))
    for file in (target, config):
        check(file.is_file() and file.stat().st_uid == 0, "Expected existing managed root-owned file: " + str(file))
    effective = run(["/usr/sbin/sshd", "-T", "-C", f"user={args.account},host=localhost,addr=100.64.0.1"])
    check(f"forcecommand /usr/bin/python3 {target} --root {root}" in effective.splitlines(), "Existing ForceCommand differs; nothing updated")
    source = Path(__file__).resolve().parent
    dispatcher = (source / "dispatcher.py").read_bytes()
    compile(dispatcher, "dispatcher.py", "exec")
    updated_config = keepalive(config.read_text(encoding="utf-8"), args.account).encode()

    # Run the real Linux flock/EOF/read-only tests as the unprivileged sync account.
    work = Path(tempfile.mkdtemp(prefix="tavernsyn-update-tests-"))
    try:
        work.chmod(0o755)
        for folder in ("vps", "tests", ".tmp"):
            (work / folder).mkdir(mode=0o755)
        os.chown(work / ".tmp", account.pw_uid, account.pw_gid)
        (work / ".tmp").chmod(0o700)
        (work / "vps/dispatcher.py").write_bytes(dispatcher)
        shutil.copyfile(source.parent / "tests/test_vps.py", work / "tests/test_vps.py")
        for file in (work / "vps/dispatcher.py", work / "tests/test_vps.py"):
            file.chmod(0o644)
        tested = subprocess.run(["runuser", "-u", args.account, "--", "/usr/bin/python3", "-B", "-m", "unittest", "discover", "-s", "tests", "-p", "test_vps.py", "-v"],
                                cwd=work, check=True, text=True, capture_output=True, timeout=90)
        tests = tested.stdout + tested.stderr
    finally:
        check(work.parent == Path(tempfile.gettempdir()) and work.name.startswith("tavernsyn-update-tests-"), "Unexpected test cleanup path")
        shutil.rmtree(work)

    locks = []
    backup = None
    try:
        for name in ("operation.lock", "transfer.lock"):
            file = plain(root / "private" / name)
            new = not file.exists()
            stream = file.open("a+b")
            locks.append(stream)
            if new:
                os.fchown(stream.fileno(), account.pw_uid, account.pw_gid)
                os.fchmod(stream.fileno(), 0o600)
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        before = pointers(root)
        backup = Path("/var/backups") / ("tavernsyn-0.2.1-" + time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:8])
        backup.mkdir(mode=0o700)
        (backup / "linux-tests.log").write_text(tests, encoding="utf-8")
        for file in (target, config):
            shutil.copy2(file, backup / file.name)
        active_file = root / "private/active.json"
        if active_file.exists():
            shutil.copy2(active_file, backup / "active-before.json")
        (backup / "pointers-before.json").write_text(json.dumps(before, indent=2), encoding="utf-8")
        try:
            replace(target, dispatcher, 0o755)
            replace(config, updated_config, 0o600)
            run(["/usr/sbin/sshd", "-t"])
            # Parent owns both maintenance locks while this unprivileged child parks
            # the old job. Repair only owner permissions on its *unpublished* stage.
            code = '''import importlib.util,json,os,pathlib,stat,sys
spec=importlib.util.spec_from_file_location("dispatcher",sys.argv[1]);d=importlib.util.module_from_spec(spec);spec.loader.exec_module(d)
s=d.Store(sys.argv[2]);j=s.active();changed=0
if j and j["direction"]=="push" and j["phase"] not in ("done","aborted"):
 p=s.root/"incoming"/j["generation"]/"payload"
 if p.exists():
  d.check(p.resolve()==p,"linked staged payload")
  def fail(error):raise error
  os.chmod(p,stat.S_IMODE(p.stat().st_mode)|0o700)
  for directory,dirs,files in os.walk(p,topdown=True,followlinks=False,onerror=fail):
   for file in [pathlib.Path(directory),*[pathlib.Path(directory)/n for n in dirs+files]]:
    info=file.lstat();d.check(not stat.S_ISLNK(info.st_mode) and info.st_uid==os.geteuid(),"unexpected staged file owner/type")
    d.check(stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode),"unexpected staged file type")
    mode=stat.S_IMODE(info.st_mode)|stat.S_IRUSR|stat.S_IWUSR|(stat.S_IXUSR if stat.S_ISDIR(info.st_mode) else 0)
    if stat.S_IMODE(info.st_mode)!=mode:os.chmod(file,mode);changed+=1
if j:s.park(j)
h=s.command({"op":"hello"},j["device"] if j else "00000000-0000-4000-8000-000000000000")
print(json.dumps({"hello":h,"repairedStageModes":changed}))'''
            probe = json.loads(run(["runuser", "-u", args.account, "--", "/usr/bin/python3", "-B", "-c", code, str(target), str(root)]))
            check(pointers(root) == before, "Published pointers changed unexpectedly")
            check(probe["hello"].get("version") == "0.2.1", "New dispatcher did not pass protocol check")
            run(["systemctl", "reload", "ssh"])
        except BaseException:
            replace(target, (backup / target.name).read_bytes(), 0o755)
            replace(config, (backup / config.name).read_bytes(), 0o600)
            if (backup / "active-before.json").exists():
                # Restore through the sync account so active.json retains its ownership.
                run(["runuser", "-u", args.account, "--", "/usr/bin/python3", "-c",
                     "import os,sys; p=sys.argv[1]; t=p+'.rollback'; open(t,'w').write(sys.stdin.read()); os.replace(t,p)",
                     str(active_file)], input=(backup / "active-before.json").read_text())
            raise
        result = dict(status="updated", version="0.2.1", dataset=args.dataset, root=str(root), backup=str(backup),
                      dispatcherSha256=hashlib.sha256(dispatcher).hexdigest(), linuxTestsPassed=True,
                      publishedPointersUnchanged=True, payloadsPreserved=True, **probe)
        (backup / "RESULT.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
        print(json.dumps(result, ensure_ascii=False, indent=2))
    finally:
        for stream in reversed(locks):
            stream.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        if isinstance(error, subprocess.CalledProcessError):
            print((error.stdout + error.stderr)[-12000:], file=os.sys.stderr)
        raise
