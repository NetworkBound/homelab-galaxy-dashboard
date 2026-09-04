#!/usr/bin/env python3
import json
import os
import subprocess
import sys
import tempfile
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from urllib.request import urlopen, Request

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
PY = os.path.join(REPO, ".venv", "bin", "python3")


class ProxmoxMock(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, obj, status=200):
        body = json.dumps({"data": obj}).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api2/json/cluster/resources":
            self.send([
                {"vmid": 101, "name": "demo-web", "type": "lxc", "status": "running", "node": "pve1", "cpu": 0.12, "mem": 512 * 1024**2, "maxmem": 1024 * 1024**2, "netin": 1000, "netout": 2000},
                {"vmid": 102, "name": "demo-db", "type": "qemu", "status": "stopped", "node": "pve1", "cpu": 0, "mem": 0, "maxmem": 2 * 1024**3, "netin": 0, "netout": 0},
            ])
        elif path == "/api2/json/nodes/pve1/status":
            self.send({"cpu": 0.08, "cpuinfo": {"cpus": 8}, "memory": {"used": 2 * 1024**3, "total": 8 * 1024**3}, "rootfs": {"used": 10 * 1024**3, "total": 64 * 1024**3}, "loadavg": ["0.1", "0.2", "0.3"], "uptime": 12345, "current-kernel": {"release": "6.8.0-pve"}})
        elif path == "/api2/json/nodes/pve1/storage":
            self.send([{"storage": "local-zfs", "type": "zfspool", "used": 10, "total": 100, "content": "images,rootdir,backup", "active": 1}])
        elif path == "/api2/json/nodes/pve1/disks/zfs":
            self.send([{"name": "rpool", "health": "ONLINE", "frag": 1, "alloc": 10, "free": 90, "size": 100}])
        elif path == "/api2/json/nodes/pve1/disks/zfs/rpool":
            self.send({"state": "ONLINE", "children": [], "scan": "none requested"})
        elif path.startswith("/api2/json/nodes/pve1/lxc/101/config"):
            self.send({"net0": "name=eth0,bridge=vmbr0,ip=10.0.0.101/24,gw=10.0.0.1"})
        elif path.startswith("/api2/json/nodes/pve1/qemu/102/config"):
            self.send({"net0": "virtio=02:00:00:00:01:02,bridge=vmbr0"})
        elif path.startswith("/api2/json/nodes/pve1/storage/local-zfs/content"):
            self.send([])
        else:
            self.send({}, 404)


def fetch_json(url):
    req = Request(url, headers={"Accept": "application/json"})
    with urlopen(req, timeout=3) as r:
        return json.loads(r.read().decode())


def main():
    mock = ThreadingHTTPServer(("127.0.0.1", 18006), ProxmoxMock)
    Thread(target=mock.serve_forever, daemon=True).start()
    with tempfile.TemporaryDirectory() as td:
        env = os.environ.copy()
        env.update({
            "PVE_0_NAME": "pve1",
            "PVE_0_URL": "http://127.0.0.1:18006",
            "PVE_0_TOKEN": "dashboard@pve!readonly=00000000-0000-0000-0000-000000000000",
            "LISTEN_HOST": "127.0.0.1",
            "LISTEN_PORT": "18080",
            "METRICS_DB": os.path.join(td, "metrics.db"),
            "ENABLE_GPU": "false",
            "ENABLE_GPU_RENDER": "false",
        })
        proc = subprocess.Popen([PY, "app.py"], cwd=REPO, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        try:
            deadline = time.time() + 20
            last = None
            while time.time() < deadline:
                try:
                    all_data = fetch_json("http://127.0.0.1:18080/api/all")
                    if len(all_data.get("guests", [])) == 2 and all_data.get("nodes"):
                        last = all_data
                        break
                except Exception:
                    pass
                time.sleep(0.5)
            if not last:
                out = proc.stdout.read(2000) if proc.stdout else ""
                raise SystemExit(f"dashboard did not produce mock Proxmox data\n{out}")
            gpu = fetch_json("http://127.0.0.1:18080/api/gpu")
            hist = fetch_json("http://127.0.0.1:18080/api/history?metric=net&mins=5")
            print(json.dumps({
                "guests": len(last["guests"]),
                "running": last["running"],
                "nodes": len(last["nodes"]),
                "storage": len(last["storage"]),
                "pools": len(last["pools"]),
                "gpu_render_backend": gpu["render_backend"],
                "history_rows": len(hist),
            }, indent=2))
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
            mock.shutdown()


if __name__ == "__main__":
    main()
