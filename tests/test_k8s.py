#!/usr/bin/env python3
"""Tests for k8s.py (Kubernetes / k3s clusters in /api/universe and /api/tour).
stdlib unittest only, no Flask, no real cluster: a fake API (tests/k8s_stub.py)
serves the simulated 4-node k3s fixture (tests/fixtures/k8s/pi-cluster).

    python3 tests/test_k8s.py -v
"""
import contextlib
import io
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)
import k8s_stub  # noqa: E402

import k8s  # noqa: E402
import tour  # noqa: E402
import universe  # noqa: E402

FIX = k8s_stub.load("pi-cluster")
NOW = float(FIX["meta"]["fixture_now"])
TOKEN = "example-stub-token-0123456789"
IP = re.compile(r"\b\d{1,3}(?:\.\d{1,3}){3}\b")


def raw_docs(metrics=True):
    keys = ["nodes", "pods", "namespaces", "services", "events", "version"]
    if metrics:
        keys += ["metrics_nodes", "metrics_pods"]
    return {k: json.loads(json.dumps(FIX[k])) for k in keys}


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


class _Tmp(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="k8s-test-")
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def write(self, name, text, mode=0o600):
        p = os.path.join(self.tmp, name)
        with open(p, "w") as f:
            f.write(text)
        os.chmod(p, mode)
        return p


class StubCase(_Tmp):
    def setUp(self):
        super().setUp()
        self.stub = k8s_stub.Stub(token=TOKEN).start()
        self.addCleanup(self.stub.stop)
        self.tokfile = self.write("token", TOKEN + "\n")

    def poller(self, server=None, **kw):
        return k8s.ClusterPoller(k8s.Cluster("pi-cluster", server or self.stub.url, token_file=self.tokfile, **kw))

    def store(self):
        return universe.Store(os.path.join(self.tmp, "slots.json"))


def build(snaps, store, now=NOW, topo=None):
    obs = k8s.observations(universe.Obs, snaps, now)
    t = k8s.augment_topology(topo or {"nodes": [], "links": [], "ts": now}, snaps)
    return universe.build(obs, store, now=now, topo=t, names=k8s.short_names(snaps),
                          unknown_systems=k8s.unknown_systems(snaps))


# ---------------------------------------------------------------- parsing --
class TestParsing(_Tmp):
    def test_quantities(self):
        self.assertAlmostEqual(k8s.cpu_cores("250m"), 0.25)
        self.assertAlmostEqual(k8s.cpu_cores("4"), 4.0)
        self.assertAlmostEqual(k8s.cpu_cores("812345678n"), 0.812345678)
        self.assertAlmostEqual(k8s.cpu_cores("1500u"), 0.0015)
        self.assertEqual(k8s.mem_bytes("8Gi"), 8 * 1024 ** 3)
        self.assertEqual(k8s.mem_bytes("3145728Ki"), 3 * 1024 ** 3)
        self.assertEqual(k8s.mem_bytes("512M"), 512e6)
        self.assertEqual(k8s.mem_bytes("1024"), 1024)
        self.assertIsNone(k8s.cpu_cores("lots"))
        self.assertIsNone(k8s.mem_bytes(None))

    def test_timestamps(self):
        self.assertEqual(k8s.ts_of("2026-10-10T12:00:00Z"), 1791633600.0)
        self.assertAlmostEqual(k8s.ts_of("2026-10-10T12:00:00.123456789Z"), 1791633600.123456, places=5)
        self.assertIsNone(k8s.ts_of("yesterday"))
        self.assertIsNone(k8s.ts_of(None))

    K3S_YAML = """apiVersion: v1
clusters:
- cluster:
    certificate-authority-data: {ca}
    server: https://127.0.0.1:6443
  name: default
contexts:
- context:
    cluster: default
    user: default
  name: default
current-context: default
kind: Config
preferences: {{}}
users:
- name: default
  user:
    client-certificate-data: {cert}
    client-key-data: {key}
"""

    def test_k3s_kubeconfig(self):
        import base64
        b = lambda s: base64.b64encode(s.encode()).decode()
        p = self.write("k3s.yaml", self.K3S_YAML.format(ca=b("CA-PEM"), cert=b("CERT-PEM"), key=b("KEY-PEM")))
        c = k8s.clusters_from_kubeconfig(p)
        self.assertEqual((c.name, c.server, c.ca_data), ("k3s", "https://127.0.0.1:6443", "CA-PEM"))
        self.assertEqual((c._cert, c._key, c.token()), ("CERT-PEM", "KEY-PEM", None))
        self.assertNotIn("KEY-PEM", repr(c))
        self.assertEqual(k8s.clusters_from_kubeconfig(p, name="Pi Cluster").name, "pi-cluster")

    def test_kubeconfig_token_json_and_refusals(self):
        doc = {"clusters": [{"name": "lab", "cluster": {"server": "https://k.example:6443",
                                                         "certificate-authority": "ca.crt"}}],
               "users": [{"name": "ro", "user": {"token": "abcdef123456"}}],
               "contexts": [{"name": "lab", "context": {"cluster": "lab", "user": "ro"}}], "current-context": "lab"}
        p = self.write("kc.json", json.dumps(doc))
        c = k8s.clusters_from_kubeconfig(p)
        self.assertEqual((c.name, c.token()), ("lab", "abcdef123456"))
        self.assertEqual(c.ca_file, os.path.join(self.tmp, "ca.crt"))
        doc["clusters"][0]["cluster"]["insecure-skip-tls-verify"] = True
        p2 = self.write("kc2.json", json.dumps(doc))
        with self.assertRaises(ValueError):
            k8s.clusters_from_kubeconfig(p2)
        self.assertTrue(k8s.clusters_from_kubeconfig(p2, allow_insecure=True).insecure)
        doc["clusters"][0]["cluster"].pop("insecure-skip-tls-verify")
        doc["users"][0]["user"] = {"exec": {"command": "aws"}}
        with self.assertRaises(ValueError):
            k8s.clusters_from_kubeconfig(self.write("kc3.json", json.dumps(doc)))

    def test_yaml_subset(self):
        d = k8s.parse_yaml("a: 1\nb:\n  - x\n  - 'y z'\nc:\n  d: \"q\\\"\"  # comment\n  e: {}\nf: [1, 2]\ng: https://h:1/p\n")
        self.assertEqual(d, {"a": 1, "b": ["x", "y z"], "c": {"d": 'q"', "e": {}}, "f": [1, 2], "g": "https://h:1/p"})

    def test_env_config(self):
        sa = os.path.join(self.tmp, "sa")
        os.makedirs(sa)
        self.write("sa/token", "sa-token-value-xyz")
        self.write("sa/ca.crt", "CA")
        env = {"K8S_CLUSTERS": "pi|https://192.0.2.10:6443|/t1|/c1; lab|https://k.example:6443|/t2|",
               "KUBECONFIG": os.path.join(self.tmp, "missing.yaml"),
               "KUBERNETES_SERVICE_HOST": "10.43.0.1", "KUBERNETES_SERVICE_PORT": "443",
               "K8S_SA_DIR": sa, "K8S_CLUSTER_NAME": "home"}
        with contextlib.redirect_stdout(io.StringIO()) as out:
            cs = k8s.clusters_from_env(env)
        self.assertEqual([c.name for c in cs], ["pi", "lab", "home"])
        self.assertEqual((cs[0].token_file, cs[0].ca_file, cs[1].ca_file), ("/t1", "/c1", None))
        self.assertEqual((cs[2].server, cs[2].source), ("https://10.43.0.1:443", "in-cluster"))
        self.assertEqual(cs[2].token(), "sa-token-value-xyz")
        self.assertIn("missing.yaml", out.getvalue())          # a broken kubeconfig is logged, not fatal
        self.assertEqual(k8s.clusters_from_env(dict(env, K8S_DISABLE="1")), [])


class TestNormalize(unittest.TestCase):
    def test_fixture(self):
        d = k8s.normalize(raw_docs(), NOW)
        self.assertEqual(len(d["nodes"]), 4)
        self.assertEqual(len(d["pods"]), 32)
        srv = next(n for n in d["nodes"] if n["name"] == "pi-server")
        self.assertTrue(srv["control_plane"])
        self.assertEqual(srv["roles"], ["control-plane", "master"])
        self.assertEqual((srv["kubelet"], srv["cpu_cap"], srv["arch"]), ("v1.31.4+k3s1", 4.0, "arm64"))
        dead = next(n for n in d["nodes"] if n["name"] == "pi-agent-3")
        self.assertEqual((dead["ready"], dead["ready_state"]), (False, "Unknown"))
        crash = next(p for p in d["pods"] if p["name"].startswith("photo-sync"))
        self.assertEqual((crash["reason"], crash["restarts"], crash["wkind"], crash["wname"]),
                         ("CrashLoopBackOff", 37, "Deployment", "photo-sync"))
        cron = [p for p in d["pods"] if p["ns"] == "default"]
        self.assertEqual({(p["wkind"], p["wname"]) for p in cron}, {("CronJob", "nightly-backup")})
        self.assertTrue(next(p for p in d["pods"] if p["name"].startswith("ollama"))["unschedulable"])
        self.assertEqual(len(d["events"]), 2)                  # Warnings in the last hour only
        self.assertEqual(sorted(d["metrics"]["nodes"]), ["pi-agent-1", "pi-agent-2", "pi-server"])
        tr = next(s for s in d["services"] if s["name"] == "traefik")
        self.assertEqual((tr["type"], tr["node_ports"]), ("LoadBalancer", [31080, 31443]))

    def test_stable_pod_ids_across_rollout(self):
        ids = k8s.PodIds()
        d = k8s.normalize(raw_docs(), NOW)
        first = ids.assign(d["pods"])
        keys = sorted(v[0] for v in first.values())
        self.assertEqual(len(keys), len(set(keys)), "every body key is unique")
        self.assertEqual(len(first), 31, "the older CronJob run is history, not a body")
        web = sorted(v[0] for v in first.values() if "web-frontend" in v[0])
        self.assertEqual(web, ["deploy/web-frontend#0", "deploy/web-frontend#1", "deploy/web-frontend#2"])
        # rollout: replica #1 replaced by a new pod (new name + uid): same key
        pods = [dict(p) for p in d["pods"]]
        old = next(p for p in pods if p["name"] == "web-frontend-8c7d6f5b4-k7l8m")
        new = dict(old, name="web-frontend-9d9d9d9d9-zzzzz", uid="new-uid", created=NOW)
        pods = [p for p in pods if p is not old] + [new]
        second = ids.assign(pods)
        self.assertEqual(second["new-uid"][0], first[old["uid"]][0])
        # a surge pod while all three still run takes #3 (append, nobody moves)
        surge = dict(new, name="web-frontend-9d9d9d9d9-yyyyy", uid="surge-uid")
        third = ids.assign(pods + [surge])
        self.assertEqual(third["surge-uid"][0], "deploy/web-frontend#3")
        self.assertEqual({k: v for k, v in third.items() if k != "surge-uid"}, second)


# ---------------------------------------------------------------- poller --
class TestPoller(StubCase):
    def test_poll_ok_with_paging_and_metrics(self):
        p = self.poller()
        s = p.poll_once(NOW)
        self.assertEqual((s["status"], s["error"], s["metrics"]), ("ok", None, True))
        self.assertEqual(len(s["data"]["pods"]), 32)
        page = p.client().get_list("/api/v1/pods", limit=5)
        self.assertEqual(len(page["items"]), 32)               # 7 pages, joined
        sm = k8s.summary(s, NOW)
        self.assertEqual((sm["nodes"], sm["nodes_ready"], sm["pods_failing"], sm["crashloop"]),
                         (4, 3, 2, ["photo-sync"]))
        self.assertIn("cpu_pct", sm)
        self.assertGreater(self.stub.seen_auth, 5)

    def test_missing_metrics_server(self):
        self.stub.metrics = False
        s = self.poller().poll_once(NOW)
        self.assertEqual(s["status"], "ok")
        self.assertFalse(s["metrics"])
        self.assertIn("metrics-server not installed", s["notes"])
        for o in k8s.observations(universe.Obs, [s], NOW):
            for key in ("cpu", "cpu_pct", "mem_pct", "cpu_m", "mem_b"):
                self.assertNotIn(key, o.m, "no metrics-server: absent, never 0")
        a = k8s.tour_aspects(tour.Uni(None), [s], NOW)[0]
        self.assertEqual([f["k"] for f in a["facts"]], ["Nodes", "Pods", "Restarts"])
        self.assertIn("no metrics-server", a["line"])

    def test_auth_failure(self):
        p = self.poller()
        good = p.poll_once(NOW)
        self.stub.token = "rotated-token-9999"
        with contextlib.redirect_stdout(io.StringIO()) as out:
            s = p.poll_once(NOW + 10)
        self.assertEqual((s["status"], s["error_kind"], s["error"]), ("unknown", "auth", "auth failed (HTTP 401)"))
        self.assertEqual(s["ts"], good["ts"], "last success kept")
        self.assertNotIn(TOKEN, out.getvalue())
        obs = k8s.observations(universe.Obs, [s], NOW + 10)
        self.assertTrue(obs)
        self.assertEqual({o.status for o in obs}, {"unknown"})
        self.assertFalse([o for o in obs if "cpu_pct" in o.m or "ready" in o.m], "stale: no measurements")
        probs = k8s.tour_problems(None, [s], NOW + 10)
        self.assertEqual(probs, [{"host": "pi-cluster", "text": "API auth failed", "sev": 3, "lab": False, "n": 1}])

    def test_unreachable_cluster(self):
        p = self.poller(server="http://127.0.0.1:%d" % free_port())
        with contextlib.redirect_stdout(io.StringIO()):
            s = p.poll_once(NOW)
        self.assertEqual((s["status"], s["error_kind"]), ("unknown", "unreachable"))
        self.assertIsNone(s["data"])
        self.assertEqual(k8s.observations(universe.Obs, [s], NOW), [], "never reached: no invented bodies")
        self.assertEqual(k8s.topology_nodes([s]), [])
        a = k8s.tour_aspects(tour.Uni(None), [s], NOW)[0]
        self.assertEqual((a["status"], a["facts"]), ("unknown", [{"k": "Feed", "v": "unavailable", "s": ""}]))
        self.assertEqual(a["line"], "Cluster API unreachable")
        self.assertEqual(k8s.tour_problems(None, [s], NOW)[0]["text"], "API unreachable")

    def test_token_redaction(self):
        p = self.poller()
        s = p.poll_once(NOW)
        blob = json.dumps(s) + json.dumps(k8s.summary(s, NOW)) + repr(p.cluster)
        blob += json.dumps([o.m for o in k8s.observations(universe.Obs, [s], NOW)])
        self.assertNotIn(TOKEN, blob)
        self.assertNotIn(TOKEN, json.dumps(build([s], self.store())))
        # a redirect is refused (the token would follow it) and nothing leaks into the error
        self.stub.redirect = True
        with contextlib.redirect_stdout(io.StringIO()) as out:
            s2 = p.poll_once(NOW + 10)
        self.assertEqual(s2["status"], "unknown")
        self.assertIn("redirect", s2["error"])
        self.assertNotIn(TOKEN, out.getvalue() + json.dumps(s2))
        # never over plain http to a non-loopback host
        far = k8s.Client(k8s.Cluster("x", "http://192.0.2.99:6443", token_file=self.tokfile))
        with self.assertRaises(k8s.K8sError) as cm:
            far.get("/api/v1/nodes")
        self.assertEqual(cm.exception.kind, "config")
        # redact() scrubs bearer headers, JWTs, k3s join tokens and explicit secrets
        jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJzeXN0ZW0ifQ.c2lnbmF0dXJlLXZhbHVl"
        txt = k8s.redact("Authorization: Bearer %s token=%s K10abcdef0123456789abcdef::server:s3cr3t x %s"
                         % (TOKEN, TOKEN, jwt), [TOKEN])
        for sec in (TOKEN, jwt, "s3cr3t"):
            self.assertNotIn(sec, txt)

    def test_restarts_window(self):
        p = self.poller()
        s = p.poll_once(NOW)
        self.assertEqual(s["data"]["restarts_24h"], 38)        # photo-sync 37 (born 3 h ago) + api >= 1
        self.assertTrue(s["data"]["restarts_partial"])
        # photo-sync restarts twice more: exact increment
        pod = next(i for i in self.stub.docs["pods"]["items"] if i["metadata"]["name"].startswith("photo-sync"))
        pod["status"]["containerStatuses"][0]["restartCount"] = 39
        self.assertEqual(p.poll_once(NOW + 10)["data"]["restarts_24h"], 40)


@unittest.skipUnless(shutil.which("openssl"), "openssl CLI needed to mint a test CA")
class TestTLS(_Tmp):
    def test_ca_verification(self):
        key, crt = os.path.join(self.tmp, "k.pem"), os.path.join(self.tmp, "c.pem")
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", crt,
                        "-days", "1", "-subj", "/CN=k3s-test", "-addext", "subjectAltName=IP:127.0.0.1"],
                       check=True, capture_output=True)
        stub = k8s_stub.Stub(token=TOKEN, certfile=crt, keyfile=key).start()
        self.addCleanup(stub.stop)
        tf = self.write("token", TOKEN)
        ok = k8s.ClusterPoller(k8s.Cluster("pi", stub.url, token_file=tf, ca_file=crt)).poll_once(NOW)
        self.assertEqual(ok["status"], "ok")
        with contextlib.redirect_stdout(io.StringIO()):
            bad = k8s.ClusterPoller(k8s.Cluster("pi", stub.url, token_file=tf)).poll_once(NOW)
        self.assertEqual((bad["status"], bad["error_kind"]), ("unknown", "tls"))


# --------------------------------------------------------------- universe --
class TestUniverse(StubCase):
    def setUp(self):
        super().setUp()
        self.p = self.poller()
        self.snap = self.p.poll_once(NOW)

    def test_system_and_bodies(self):
        doc = build([self.snap], self.store())
        sysd = {s["id"]: s for s in doc["systems"]}["sys:k8s-pi-cluster"]
        self.assertEqual((sysd["kind"], sysd["anchor"], sysd["label"]), ("k8s", "k8s:pi-cluster", "pi-cluster"))
        self.assertRegex(sysd["accent"], r"^#[0-9a-f]{6}$")
        B = {b["id"]: b for b in doc["bodies"]}
        self.assertEqual(len(B), 35)                            # 4 nodes + 31 pods
        cp = B["k8s:pi-cluster:node:pi-server"]
        self.assertEqual((cp["topo"], cp["class"], cp["shell"], cp["slot"]), ("k8s:pi-cluster", "server", 2, 0))
        ag = B["k8s:pi-cluster:node:pi-agent-1"]
        self.assertNotIn("hub", ag, "no hub edges: a web of pod lines is not a clean star system")
        self.assertEqual(ag["parent"], cp["id"])
        dead = B["k8s:pi-cluster:node:pi-agent-3"]
        self.assertEqual((dead["status"], dead["down_why"]), ("down", "offline"))
        crash = B["k8s:pi-cluster:pod:photos/deploy/photo-sync#0"]
        self.assertEqual((crash["status"], crash["down_why"], crash["class"], crash["m"]["reason"]),
                         ("down", "offline", "guest_lxc", "CrashLoopBackOff"))
        self.assertEqual(crash["parent"], ag["id"])
        done = B["k8s:pi-cluster:pod:default/cron/nightly-backup"]
        self.assertEqual((done["status"], done["down_why"]), ("down", "stopped"))
        lost = B["k8s:pi-cluster:pod:apps/deploy/web-frontend#2"]
        self.assertEqual(lost["status"], "unknown", "its node stopped reporting")
        self.assertEqual(B["k8s:pi-cluster:pod:kube-system/deploy/coredns#0"]["cat"], "infra")
        self.assertEqual(B["k8s:pi-cluster:pod:monitoring/sts/prometheus-0"]["cat"], "monitor")
        self.assertEqual(B["k8s:pi-cluster:pod:media/deploy/jellyfin#0"]["cat"], "media")
        self.assertEqual(B["k8s:pi-cluster:pod:ai/deploy/whisper#0"]["cat"], "ai")
        self.assertEqual(B["k8s:pi-cluster:pod:apps/deploy/api#0"]["cat"], "web")
        self.assertIn("cpu_m", B["k8s:pi-cluster:pod:monitoring/sts/prometheus-0"]["m"])
        self.assertIn("cpu_pct", cp["m"])
        self.assertEqual(doc["counts"]["down_by"], {"offline": 3, "stopped": 3, "gone": 0})
        ids = set(B) | {"k8s:pi-cluster"}
        for b in doc["bodies"]:
            self.assertTrue(b["parent"] is None or b["parent"] in ids, b["id"])
            self.assertLessEqual(len(b.get("short") or ""), 14)
            self.assertFalse(IP.search(b.get("short") or "") or IP.search(b["label"]), "no IPs on screen (section 7)")
        self.assertEqual(len({b["short"] for b in doc["bodies"]}), len(doc["bodies"]), "shorts unique in a system")
        self.assertNotIn("traffic", doc, "no measured traffic: no pairs")

    def test_append_only_and_hold(self):
        st = self.store()
        d1 = build([self.snap], st)
        slots = {b["id"]: (b["system"], b["shell"], b["slot"]) for b in d1["bodies"]}
        # a new workload appears: it takes the next slot, nobody else moves
        new = json.loads(json.dumps(next(i for i in self.stub.docs["pods"]["items"]
                                         if i["metadata"]["name"].startswith("whisper"))))
        new["metadata"].update(name="paperless-abc-12345", uid="pp-1", namespace="web",
                               labels={"pod-template-hash": "abc"},
                               ownerReferences=[{"kind": "ReplicaSet", "name": "paperless-abc", "controller": True}])
        self.stub.docs["pods"]["items"].append(new)
        d2 = build([self.p.poll_once(NOW + 10)], st, now=NOW + 10)
        s2 = {b["id"]: (b["system"], b["shell"], b["slot"]) for b in d2["bodies"]}
        for bid, v in slots.items():
            self.assertEqual(s2[bid], v, bid)
        pp = s2["k8s:pi-cluster:pod:web/deploy/paperless#0"]
        self.assertEqual(pp[2], max(v[2] for v in slots.values() if v[1] == 3) + 1)
        # it goes away: shown gone (not an outage), then freed after the pod hold, not 30 days
        self.stub.docs["pods"]["items"].pop()
        d3 = build([self.p.poll_once(NOW + 20)], st, now=NOW + 20)
        b3 = next(b for b in d3["bodies"] if b["id"] == "k8s:pi-cluster:pod:web/deploy/paperless#0")
        self.assertEqual((b3["status"], b3["down_why"]), ("down", "gone"))
        later = NOW + 30 + universe.K8S_POD_RETAIN_S
        d4 = build([self.p.poll_once(later)], st, now=later)
        self.assertNotIn("k8s:pi-cluster:pod:web/deploy/paperless#0", {b["id"] for b in d4["bodies"]})

    def test_unreachable_keeps_bodies_unknown(self):
        st = self.store()
        build([self.snap], st)
        self.stub.fail = 503
        stale = self.p.poll_once(NOW + 10)
        self.assertEqual(stale["status"], "unknown")
        d = build([stale], st, now=NOW + 10)
        mine = [b for b in d["bodies"] if b["system"] == "sys:k8s-pi-cluster"]
        self.assertEqual({b["status"] for b in mine}, {"unknown"})
        self.assertFalse([b for b in mine if b.get("down_why")], "unknown, never gone")
        # even with no snapshot at all (dashboard restarted while the API is down), held bodies are unknown
        fresh = {"name": "pi-cluster", "status": "unknown", "error_kind": "unreachable", "data": None}
        d2 = build([fresh], st, now=NOW + 99999)
        mine = [b for b in d2["bodies"] if b["system"] == "sys:k8s-pi-cluster"]
        self.assertEqual(len(mine), 35)
        self.assertEqual({b["status"] for b in mine}, {"unknown"})

    def test_topology_augment_and_anchor_collision(self):
        topo = {"ts": NOW, "nodes": [{"id": "pve:pve1", "kind": "pvehost", "label": "pve1"}], "links": []}
        snap = dict(self.snap, name="pve1")
        t = k8s.augment_topology(topo, [snap])
        self.assertEqual(len(topo["nodes"]), 1, "input never mutated")
        hub = t["nodes"][-1]
        self.assertEqual((hub["id"], hub["kind"], hub["ip"], hub["meta"]["anchor_of"]),
                         ("k8s:pve1", "pvehost", None, "sys:k8s-pve1"))
        self.assertIs(k8s.augment_topology(topo, []), topo)
        a = universe._anchors([], t["nodes"])
        self.assertEqual((a["sys:pve1"], a["sys:k8s-pve1"]), ("pve:pve1", "k8s:pve1"))


# ------------------------------------------------------------------ tour --
class TestTour(StubCase):
    def tearDown(self):
        k8s.REGISTRY.set_snapshots(None)

    def test_aspect_after_last_host_stop(self):
        snap = self.poller().poll_once(NOW)
        doc = build([snap], self.store())
        doc["systems"] += [{"id": "sys:pve2", "kind": "pvehost", "anchor": "pve:pve2", "slot": 1},
                           {"id": "sys:pve1", "kind": "pvehost", "anchor": "pve:pve1", "slot": 2},
                           {"id": "sys:home", "kind": "clients", "anchor": "unifi:x", "slot": 3}]
        k8s.REGISTRY.set_snapshots([snap])
        res = tour.build({}, doc, None, now=NOW)
        keys = [a["key"] for a in res["aspects"]]
        self.assertEqual(keys[-1], "asp:k8s")
        self.assertEqual(len(keys), 11)
        a = res["aspects"][-1]
        self.assertEqual((a["anchor"], a["after"], a["name"]), ("sys:k8s-pi-cluster", "host:pve:pve1", "Kubernetes"))
        self.assertEqual(a["facts"][0], {"k": "Nodes", "v": "3 / 4", "s": "warn"})
        self.assertEqual(a["facts"][1]["k"], "Pods")
        self.assertEqual(a["facts"][3]["k"], "CPU / mem")
        self.assertLessEqual(len(a["facts"]), 4)
        for f in a["facts"]:
            self.assertLessEqual(len(f["k"]), 12)
            self.assertIn(f["s"], ("ok", "warn", "crit", ""))
        self.assertFalse(IP.search(json.dumps(a)))
        texts = [(p["host"], p["text"], p["sev"]) for p in res["problems"]]
        self.assertEqual(texts[0], ("pi-agent-3", "node not ready", 4))
        self.assertIn(("photo-sync", "crash looping", 3), texts)

    def test_no_cluster_no_change(self):
        k8s.REGISTRY.set_snapshots([])
        res = tour.build({}, None, None, now=NOW)
        self.assertEqual(len(res["aspects"]), 10)
        self.assertFalse([a for a in res["aspects"] if a["key"].startswith("asp:k8s")])

    def test_second_cluster_key(self):
        snap = self.poller().poll_once(NOW)
        two = k8s.tour_aspects(tour.Uni(None), [snap, dict(snap, name="lab")], NOW)
        self.assertEqual([a["key"] for a in two], ["asp:k8s", "asp:k8s:lab"])
        self.assertEqual(two[1]["anchor"], "sys:k8s-lab")


if __name__ == "__main__":
    unittest.main()
