"""Run the actual Pages + Spring DM preview through make. Ctrl+C stops both."""
import argparse
import os
from pathlib import Path
import shutil
import socket
import subprocess
import time
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--spring", default="../Spring")
    args = parser.parse_args()
    pages = Path(__file__).resolve().parents[1]
    spring = (pages / args.spring).resolve()
    if not (spring / "pom.xml").exists():
        raise SystemExit(f"Spring checkout not found: {spring}")
    for port in (4500, 8585, 8589):
        with socket.socket() as probe:
            if probe.connect_ex(("127.0.0.1", port)) == 0:
                raise SystemExit(f"Port {port} is already in use. Stop its server before starting this preview.")
    logs = pages / ".dm-preview"
    logs.mkdir(exist_ok=True)
    (spring / "volumes").mkdir(exist_ok=True)
    env = os.environ.copy()
    # Override external DB settings as well as the application profile.
    env.update(DB_URL="jdbc:sqlite:volumes/dm-preview.db?journal_mode=WAL", SPRING_PROFILES_ACTIVE="dm-preview")
    make = shutil.which("make")
    if not make:
        raise SystemExit("GNU Make is required; on Windows use scripts/make.ps1 dm-preview")
    processes, streams = [], []
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    try:
        for name, directory, target in (("spring", spring, "dm-preview"), ("pages", pages, "dm-frontend")):
            stream = (logs / f"{name}.log").open("w", encoding="utf-8")
            streams.append(stream)
            processes.append(subprocess.Popen([make, target], cwd=directory, env=env,
                             stdout=stream, stderr=subprocess.STDOUT, creationflags=flags,
                             start_new_session=os.name != "nt"))
        print(f"Building Spring and Pages. Logs: {logs}", flush=True)
        started = time.monotonic()
        while time.monotonic() - started < 240:
            if any(process.poll() is not None for process in processes):
                raise RuntimeError(f"A preview server stopped. See {logs}")
            ready = False
            try:
                with urllib.request.urlopen("http://localhost:4500/student/messages", timeout=2) as response:
                    # The conversation panel, plus the surrounding document: a
                    # missing layout still serves the panel, just unwrapped.
                    body = response.read()
                    ready = b'id="dmChat"' in body and b"<html" in body.lower()
                request = urllib.request.Request("http://localhost:8585/authenticate", data=b'{"uid":"dm-alice","password":"DmPreview123!"}', headers={"Content-Type": "application/json"})
                with urllib.request.urlopen(request, timeout=2) as response:
                    ready = ready and response.status == 200
            except (OSError, urllib.error.URLError):
                ready = False
            if ready:
                print("Ready: http://localhost:4500/student/messages", flush=True)
                print("Use Alice and Bob in separate browser profiles; Charlie tests privacy.", flush=True)
                print("Run make dm-test in another terminal. Ctrl+C here stops both servers.", flush=True)
                break
            time.sleep(2)
        else:
            raise RuntimeError(f"Preview did not become ready in 240 seconds. See {logs}")
        while all(process.poll() is None for process in processes):
            time.sleep(1)
    except KeyboardInterrupt:
        print("Stopping the local preview.", flush=True)
    finally:
        for process in processes:
            if process.poll() is None:
                if os.name == "nt":
                    subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True, creationflags=flags)
                else:
                    import signal
                    os.killpg(process.pid, signal.SIGTERM)
        for stream in streams:
            stream.close()
        if os.name == "nt":
            # MSYS can reparent native Ruby/Java children beyond taskkill's process tree.
            # These ports were free at startup; only stop processes bearing our preview markers.
            cleanup = r'''
            foreach ($port in @(4500, 8585, 8589)) {
                Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | ForEach-Object {
                    $owned = Get-CimInstance Win32_Process -Filter "ProcessId = $($_.OwningProcess)"
                    if ($owned.CommandLine -match 'jekyll.*_config.dev.yml|java.*-Ddm.preview=true') {
                        Stop-Process -Id $owned.ProcessId -Force -ErrorAction SilentlyContinue
                    }
                }
            }
            '''
            subprocess.run(["powershell", "-NoProfile", "-Command", cleanup], capture_output=True, creationflags=flags)


if __name__ == "__main__":
    main()
