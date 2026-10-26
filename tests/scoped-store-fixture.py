"""Local protocol test fixture; no SSH or network listener. Windows substitutes flock and cp only."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

spec = importlib.util.spec_from_file_location("dispatcher", Path(__file__).resolve().parents[1] / "vps/dispatcher.py")
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)
if os.name == "nt":
    class Lock:
        def __init__(self, *args, **kwargs): pass
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def close(self): pass
    d.Lock = Lock
    original_run = subprocess.run
    def run(args, **kwargs):
        if args[0] == "cp":
            shutil.copytree(args[-2], args[-1], copy_function=shutil.copy2, symlinks=True)
            return subprocess.CompletedProcess(args, 0)
        return original_run(args, **kwargs)
    d.subprocess.run = run
root, device, dataset = sys.argv[1:]
if not (Path(root) / "FORMAT.json").exists():
    d.initialize(root, dataset)
store = d.Store(root)
try:
    for line in sys.stdin:
        message = json.loads(line)
        try:
            response = dict(id=message["id"], ok=True, result=store.command(message, device))
        except Exception as error:
            response = dict(id=message["id"], ok=False, error=str(error), code=str(error).split(":")[0])
        print(json.dumps(response, ensure_ascii=False), flush=True)
finally:
    store.close()
