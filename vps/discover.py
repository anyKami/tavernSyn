#!/usr/bin/env python3
"""Read-only migration aid: detect ST Docker mounts without exposing env/secrets."""
import json
from pathlib import Path
import shutil
import subprocess

result = {"containers": [], "directories": []}
if shutil.which("docker"):
    listing = subprocess.run(["docker", "ps", "-aq"], capture_output=True, text=True, check=True)
    for container in listing.stdout.split():
        item = json.loads(subprocess.check_output(["docker", "inspect", container], text=True))[0]
        mounts = [{"source": x["Source"], "destination": x["Destination"]} for x in item.get("Mounts", [])]
        if "sillytavern" in (item.get("Name", "") + item.get("Config", {}).get("Image", "")).lower() or any(x["destination"].endswith("/app/data") for x in mounts):
            result["containers"].append({"id": container[:12], "name": item["Name"].lstrip("/"), "running": item["State"]["Running"], "mounts": mounts})
for directory in (Path("/opt/sillytavern"), Path("/opt/SillyTavern"), Path.home() / "SillyTavern"):
    if directory.is_dir():
        result["directories"].append({"path": str(directory), "program": (directory / "package.json").is_file(), "data": (directory / "data").is_dir()})
print(json.dumps(result, ensure_ascii=False, indent=2))
