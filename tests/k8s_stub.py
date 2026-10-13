#!/usr/bin/env python3
"""A tiny fake Kubernetes API for tests and the stage demo. Serves the fixture
cluster (tests/fixtures/k8s/<name>/*.json) read-only on 127.0.0.1, with bearer-token
auth, list paging (limit / continue), the Warning fieldSelector on events, and an
optional metrics.k8s.io. TEST ONLY: never deployed, never pointed at a real cluster.

    python3 tests/k8s_stub.py --port 16443 --token-file /tmp/stub-token [--no-metrics] [--redate]

--redate shifts every timestamp so the fixture's "now" is the real now (live demo).
"""
import argparse
import copy
import json
import os
import re
import threading
import time
import urllib.parse
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, "fixtures", "k8s")
_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$")
ROUTES = {"/version": "version", "/api/v1/nodes": "nodes", "/api/v1/pods": "pods",
          "/api/v1/namespaces": "namespaces", "/api/v1/services": "services", "/api/v1/events": "events",
          "/apis/metrics.k8s.io/v1beta1/nodes": "metrics_nodes", "/apis/metrics.k8s.io/v1beta1/pods": "metrics_pods"}


def load(name="pi-cluster"):
    d = os.path.join(FIXTURES, name)
    docs = {}
    for f in os.listdir(d):
        if f.endswith(".json"):
            with open(os.path.join(d, f)) as fh:
                docs[f[:-5]] = json.load(fh)
    return docs


def redate(obj, shift):
    """Every RFC 3339 'Z' timestamp moved by shift seconds."""
    if isinstance(obj, dict):
        return {k: redate(v, shift) for k, v in obj.items()}
    if isinstance(obj, list):
        return [redate(v, shift) for v in obj]
    if isinstance(obj, str) and _ISO.match(obj):
        t = datetime.strptime(obj[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc).timestamp() + shift
        return datetime.fromtimestamp(t, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return obj


class Stub:
    """state is mutable from tests: token, metrics, fail (HTTP status to answer with),
    redirect, docs (the API documents), seen_auth (count of authorised requests)."""

    def __init__(self, name="pi-cluster", token="example-stub-token-0123456789", metrics=True, shift=0.0,
                 port=0, certfile=None, keyfile=None):
        self.docs = load(name)
        self.fixture_now = self.docs.pop("meta", {}).get("fixture_now", 0)
        self.token, self.metrics, self.shift = token, metrics, shift
        self.fail, self.redirect, self.seen_auth, self.requests = None, False, 0, []
        stub = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, code, obj, extra=None):
                body = json.dumps(obj).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                for k, v in (extra or {}).items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                u = urllib.parse.urlparse(self.path)
                q = urllib.parse.parse_qs(u.query)
                stub.requests.append(u.path)
                if stub.redirect:
                    return self._send(302, {}, {"Location": "http://127.0.0.1:1/steal"})
                if stub.token and self.headers.get("Authorization") != "Bearer " + stub.token:
                    return self._send(401, {"kind": "Status", "status": "Failure", "reason": "Unauthorized", "code": 401})
                stub.seen_auth += 1
                if stub.fail:
                    return self._send(stub.fail, {"kind": "Status", "code": stub.fail})
                key = ROUTES.get(u.path)
                if key is None or key not in stub.docs or (key.startswith("metrics") and not stub.metrics):
                    return self._send(404, {"kind": "Status", "status": "Failure", "reason": "NotFound", "code": 404})
                doc = stub.docs[key]
                shift = stub.shift if stub.shift is not None else 0.0
                if shift:
                    doc = redate(doc, shift)
                else:
                    doc = copy.deepcopy(doc)
                if key == "events" and "type=Warning" in (q.get("fieldSelector") or [""])[0]:
                    doc["items"] = [e for e in doc["items"] if e.get("type") == "Warning"]
                if "items" in doc and q.get("limit"):
                    lim, start = int(q["limit"][0]), int((q.get("continue") or ["0"])[0] or 0)
                    items = doc["items"]
                    doc["items"] = items[start:start + lim]
                    doc.setdefault("metadata", {})
                    doc["metadata"]["continue"] = str(start + lim) if start + lim < len(items) else ""
                return self._send(200, doc)

        self.server = ThreadingHTTPServer(("127.0.0.1", port), H)
        self.scheme = "http"
        if certfile:
            import ssl
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ctx.load_cert_chain(certfile, keyfile)
            self.server.socket = ctx.wrap_socket(self.server.socket, server_side=True)
            self.scheme = "https"
        self.port = self.server.server_address[1]
        self.url = "%s://127.0.0.1:%d" % (self.scheme, self.port)
        self.thread = None

    def start(self):
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True, name="k8s-stub")
        self.thread.start()
        return self

    def stop(self):
        self.server.shutdown()
        self.server.server_close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=16443)
    ap.add_argument("--token-file", required=True, help="file holding the bearer token the stub accepts")
    ap.add_argument("--fixture", default="pi-cluster")
    ap.add_argument("--no-metrics", action="store_true")
    ap.add_argument("--redate", action="store_true")
    a = ap.parse_args()
    with open(a.token_file) as f:
        tok = f.read().strip()
    s = Stub(a.fixture, token=tok, metrics=not a.no_metrics, port=a.port)
    if a.redate:
        s.shift = time.time() - s.fixture_now
    print("fake k8s API on %s (fixture %s)" % (s.url, a.fixture), flush=True)
    s.server.serve_forever()


if __name__ == "__main__":
    main()
