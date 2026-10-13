#!/usr/bin/env python3
"""Writes the simulated k3s cluster fixture (tests/fixtures/k8s/pi-cluster/*.json).

A 4-node k3s cluster on Raspberry Pis: one server (control-plane) and three agents,
one of which (pi-agent-3) is NotReady (kubelet stopped posting). 32 pods (31 bodies:
an older CronJob run is history) across 8 namespaces, including a crash-looping deployment, a pod stuck Pending (Insufficient
memory), finished helm-install / CronJob pods, and workloads on the dead node.
metrics-server answers for the three live nodes. Addresses are documentation range
(192.0.2.0/24); there are no secrets in here.

Timestamps are fixed relative to FIXTURE_NOW; tests/k8s_stub.py can re-date them to
"now" for a live demo.

    python3 tests/fixtures/k8s/make_pi_cluster.py
"""
import json
import os
from datetime import datetime, timezone

FIXTURE_NOW = 1_791_600_000
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pi-cluster")
K3S = "v1.31.4+k3s1"


def iso(dt_s):
    return datetime.fromtimestamp(FIXTURE_NOW - dt_s, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def uid(s):
    import hashlib
    h = hashlib.sha1(s.encode()).hexdigest()
    return "%s-%s-%s-%s-%s" % (h[:8], h[8:12], h[12:16], h[16:20], h[20:32])


NODES = [  # name, roles, ip, ready, cpu, mem Gi, age days
    ("pi-server", ["control-plane", "master"], "192.0.2.10", "True", 4, 8, 120),
    ("pi-agent-1", [], "192.0.2.11", "True", 4, 8, 118),
    ("pi-agent-2", [], "192.0.2.12", "True", 4, 8, 118),
    ("pi-agent-3", [], "192.0.2.13", "Unknown", 4, 4, 60),
]


def node(name, roles, ip, ready, cpu, mem, age_d):
    labels = {"kubernetes.io/hostname": name, "kubernetes.io/arch": "arm64", "kubernetes.io/os": "linux",
              "beta.kubernetes.io/instance-type": "k3s", "node.kubernetes.io/instance-type": "k3s"}
    for r in roles:
        labels["node-role.kubernetes.io/" + r] = "true"
    hb = 20 if ready == "True" else 3 * 3600
    conds = [{"type": t, "status": "False", "reason": "Kubelet" + ok, "lastHeartbeatTime": iso(hb),
              "lastTransitionTime": iso(age_d * 86400)}
             for t, ok in (("MemoryPressure", "HasSufficientMemory"), ("DiskPressure", "HasNoDiskPressure"),
                           ("PIDPressure", "HasSufficientPID"))]
    if ready == "True":
        conds.append({"type": "Ready", "status": "True", "reason": "KubeletReady",
                      "message": "kubelet is posting ready status", "lastHeartbeatTime": iso(hb),
                      "lastTransitionTime": iso(5 * 86400)})
    else:
        for c in conds:
            c["status"], c["reason"] = "Unknown", "NodeStatusUnknown"
        conds.append({"type": "Ready", "status": "Unknown", "reason": "NodeStatusUnknown",
                      "message": "Kubelet stopped posting node status.", "lastHeartbeatTime": iso(hb),
                      "lastTransitionTime": iso(3 * 3600 - 40)})
    return {"apiVersion": "v1", "kind": "Node",
            "metadata": {"name": name, "uid": uid("node/" + name), "labels": labels,
                         "creationTimestamp": iso(age_d * 86400),
                         "annotations": {"k3s.io/node-args": "[\"agent\"]", "flannel.alpha.coreos.com/public-ip": ip}},
            "spec": {"podCIDR": "10.42.%d.0/24" % NODES.index(next(n for n in NODES if n[0] == name)),
                     "providerID": "k3s://" + name},
            "status": {"capacity": {"cpu": str(cpu), "memory": "%dKi" % (mem * 1024 * 1024 - 120000),
                                    "pods": "110", "ephemeral-storage": "61202244Ki"},
                       "allocatable": {"cpu": str(cpu), "memory": "%dKi" % (mem * 1024 * 1024 - 120000),
                                       "pods": "110"},
                       "conditions": conds,
                       "addresses": [{"type": "InternalIP", "address": ip}, {"type": "Hostname", "address": name}],
                       "nodeInfo": {"kubeletVersion": K3S, "kubeProxyVersion": K3S, "architecture": "arm64",
                                    "operatingSystem": "linux", "osImage": "Debian GNU/Linux 12 (bookworm)",
                                    "kernelVersion": "6.6.51+rpt-rpi-2712",
                                    "containerRuntimeVersion": "containerd://1.7.23-k3s2"}}}


# ns, workload kind, workload name, pod name, node, phase, ready, restarts, extra
PODS = []


def add(ns, wk, wn, name, nodename, phase="Running", ready=True, restarts=0, age=10 * 86400, **kw):
    PODS.append(dict(ns=ns, wk=wk, wn=wn, name=name, node=nodename, phase=phase, ready=ready,
                     restarts=restarts, age=age, **kw))


ALL = [n[0] for n in NODES]
# kube-system: what k3s ships
add("kube-system", "Deployment", "coredns", "coredns-ccb96694c-7vq4x", "pi-server", rs="ccb96694c")
add("kube-system", "Deployment", "local-path-provisioner", "local-path-provisioner-5cf85fd84d-p2c8w", "pi-server", rs="5cf85fd84d")
add("kube-system", "Deployment", "metrics-server", "metrics-server-5985cbc9d7-xk7lm", "pi-server", rs="5985cbc9d7")
add("kube-system", "Deployment", "traefik", "traefik-57b79cf995-hc6qn", "pi-agent-1", rs="57b79cf995")
for i, n in enumerate(ALL):
    add("kube-system", "DaemonSet", "svclb-traefik", "svclb-traefik-%s" % ("8k2mx", "9l3ny", "4p5qz", "7r6sw")[i], n)
add("kube-system", "Job", "helm-install-traefik-crd", "helm-install-traefik-crd-6xj2b", "pi-server",
    phase="Succeeded", ready=False, age=120 * 86400)
add("kube-system", "Job", "helm-install-traefik", "helm-install-traefik-q8w4n", "pi-server",
    phase="Succeeded", ready=False, restarts=1, age=120 * 86400)
# monitoring
add("monitoring", "StatefulSet", "prometheus", "prometheus-0", "pi-agent-2")
add("monitoring", "Deployment", "grafana", "grafana-6f7c8d9b5-r2t9z", "pi-agent-1", rs="6f7c8d9b5")
add("monitoring", "Deployment", "kube-state-metrics", "kube-state-metrics-7d9f4b6c8-m4k2p", "pi-agent-2", rs="7d9f4b6c8")
for i, n in enumerate(ALL):
    add("monitoring", "DaemonSet", "node-exporter", "node-exporter-%s" % ("f8h2k", "j3l9m", "n4p6q", "r7s1t")[i], n)
# cert-manager
add("cert-manager", "Deployment", "cert-manager", "cert-manager-7b8f9c6d4-wv5xz", "pi-agent-1", rs="7b8f9c6d4")
add("cert-manager", "Deployment", "cert-manager-cainjector", "cert-manager-cainjector-5c9d8b7f6-a1b2c", "pi-agent-2", rs="5c9d8b7f6")
add("cert-manager", "Deployment", "cert-manager-webhook", "cert-manager-webhook-6d4f5b8c9-d3e4f", "pi-agent-1", rs="6d4f5b8c9")
# apps (web): 3 web replicas, one on the dead node
add("apps", "Deployment", "web-frontend", "web-frontend-8c7d6f5b4-g5h6j", "pi-agent-1", rs="8c7d6f5b4", age=2 * 86400)
add("apps", "Deployment", "web-frontend", "web-frontend-8c7d6f5b4-k7l8m", "pi-agent-2", rs="8c7d6f5b4", age=2 * 86400 - 30)
add("apps", "Deployment", "web-frontend", "web-frontend-8c7d6f5b4-n9p0q", "pi-agent-3", rs="8c7d6f5b4", age=2 * 86400 - 60)
add("apps", "Deployment", "api", "api-5f6g7h8j9-r1s2t", "pi-agent-1", rs="5f6g7h8j9", restarts=2, last_term=6 * 3600)
add("apps", "Deployment", "api", "api-5f6g7h8j9-u3v4w", "pi-agent-2", rs="5f6g7h8j9")
add("apps", "StatefulSet", "redis", "redis-0", "pi-agent-2")
# media
add("media", "Deployment", "jellyfin", "jellyfin-9a8b7c6d5-x5y6z", "pi-agent-2", rs="9a8b7c6d5")
# photos: the crash loop
add("photos", "Deployment", "photo-sync", "photo-sync-4c5d6e7f8-b7c8d", "pi-agent-1", rs="4c5d6e7f8",
    ready=False, restarts=37, age=3 * 3600, waiting="CrashLoopBackOff", last_term=140, last_reason="Error")
# ai: whisper runs, ollama cannot be scheduled (needs more memory than any Pi has)
add("ai", "Deployment", "whisper", "whisper-3b4c5d6e7-e9f0g", "pi-agent-2", rs="3b4c5d6e7")
add("ai", "Deployment", "ollama", "ollama-2a3b4c5d6-h1i2j", None, rs="2a3b4c5d6", phase="Pending", ready=False,
    age=40 * 60, unschedulable=True)
# default: last night's backup CronJob run (finished) and the one before it (history)
add("default", "Job", "nightly-backup-29341440", "nightly-backup-29341440-k3l4m", "pi-agent-1",
    phase="Succeeded", ready=False, age=9 * 3600)
add("default", "Job", "nightly-backup-29340000", "nightly-backup-29340000-n5o6p", "pi-agent-2",
    phase="Succeeded", ready=False, age=33 * 3600)


def pod(p):
    md = {"name": p["name"], "namespace": p["ns"], "uid": uid("pod/%s/%s" % (p["ns"], p["name"])),
          "creationTimestamp": iso(p["age"]), "labels": {"app.kubernetes.io/name": p["wn"]}}
    wk = p["wk"]
    if wk == "Deployment":
        md["labels"]["pod-template-hash"] = p["rs"]
        md["ownerReferences"] = [{"apiVersion": "apps/v1", "kind": "ReplicaSet", "name": "%s-%s" % (p["wn"], p["rs"]),
                                  "uid": uid("rs/" + p["wn"]), "controller": True, "blockOwnerDeletion": True}]
    elif wk in ("DaemonSet", "StatefulSet"):
        md["ownerReferences"] = [{"apiVersion": "apps/v1", "kind": wk, "name": p["wn"], "uid": uid(wk + p["wn"]),
                                  "controller": True}]
    elif wk == "Job":
        md["ownerReferences"] = [{"apiVersion": "batch/v1", "kind": "Job", "name": p["wn"], "uid": uid("job/" + p["wn"]),
                                  "controller": True}]
    cname = p["wn"].split("-")[0]
    cs = {"name": cname, "image": "registry.example/%s:1.0" % cname, "restartCount": p["restarts"],
          "ready": p["ready"], "started": p["ready"]}
    if p["phase"] == "Running":
        if p.get("waiting"):
            cs["state"] = {"waiting": {"reason": p["waiting"], "message": "back-off 5m0s restarting failed container"}}
        else:
            cs["state"] = {"running": {"startedAt": iso(p.get("last_term", p["age"]) - 5 if p.get("last_term") else p["age"] - 8)}}
    elif p["phase"] == "Succeeded":
        cs["state"] = {"terminated": {"exitCode": 0, "reason": "Completed", "startedAt": iso(p["age"] - 2),
                                      "finishedAt": iso(p["age"] - 60)}}
    if p.get("last_term"):
        cs["lastState"] = {"terminated": {"exitCode": 1, "reason": p.get("last_reason", "Error"),
                                          "startedAt": iso(p["last_term"] + 30), "finishedAt": iso(p["last_term"])}}
    else:
        cs["lastState"] = {}
    conds = []
    if p.get("unschedulable"):
        conds.append({"type": "PodScheduled", "status": "False", "reason": "Unschedulable",
                      "message": "0/4 nodes are available: 1 node(s) had untolerated taint "
                                 "{node.kubernetes.io/unreachable: }, 3 Insufficient memory.",
                      "lastTransitionTime": iso(p["age"])})
    else:
        conds.append({"type": "PodScheduled", "status": "True", "lastTransitionTime": iso(p["age"])})
        conds.append({"type": "Initialized", "status": "True", "lastTransitionTime": iso(p["age"] - 2)})
        rd = "True" if p["ready"] else "False"
        conds.append({"type": "ContainersReady", "status": rd, "lastTransitionTime": iso(p["age"] - 6)})
        conds.append({"type": "Ready", "status": rd, "lastTransitionTime": iso(p["age"] - 6),
                      **({} if p["ready"] else {"reason": "PodCompleted" if p["phase"] == "Succeeded" else "ContainersNotReady"})})
    st = {"phase": p["phase"], "conditions": conds, "qosClass": "Burstable"}
    if p["node"]:
        st["hostIP"] = next(n[2] for n in NODES if n[0] == p["node"])
        st["podIP"] = "10.42.%d.%d" % (ALL.index(p["node"]), 10 + len(p["name"]) % 200)
        st["startTime"] = iso(p["age"] - 1)
        st["containerStatuses"] = [cs]
    spec = {"containers": [{"name": cname, "image": cs["image"]}], "restartPolicy": "Always" if wk != "Job" else "Never",
            "serviceAccountName": "default"}
    if p["node"]:
        spec["nodeName"] = p["node"]
    return {"apiVersion": "v1", "kind": "Pod", "metadata": md, "spec": spec, "status": st}


def svc(ns, name, typ, ports, node_ports=None, lb=None):
    sp = {"type": typ, "clusterIP": "10.43.%d.%d" % (len(ns), len(name)),
          "ports": [dict({"name": "p%d" % p, "port": p, "protocol": "TCP", "targetPort": p},
                         **({"nodePort": node_ports[i]} if node_ports else {})) for i, p in enumerate(ports)]}
    st = {"loadBalancer": {"ingress": [{"ip": x} for x in lb]}} if lb else {"loadBalancer": {}}
    return {"apiVersion": "v1", "kind": "Service",
            "metadata": {"name": name, "namespace": ns, "uid": uid("svc/%s/%s" % (ns, name)),
                         "creationTimestamp": iso(100 * 86400)}, "spec": sp, "status": st}


def event(ns, kind, name, reason, msg, count, last_s, typ="Warning"):
    return {"apiVersion": "v1", "kind": "Event",
            "metadata": {"name": "%s.%s" % (name, uid(reason)[:10]), "namespace": ns,
                         "creationTimestamp": iso(last_s + 600)},
            "involvedObject": {"kind": kind, "namespace": ns if kind != "Node" else None, "name": name},
            "reason": reason, "message": msg, "type": typ, "count": count,
            "firstTimestamp": iso(last_s + 3 * 3600), "lastTimestamp": iso(last_s),
            "source": {"component": "kubelet"}}


def lst(kind, items):
    return {"kind": kind + "List", "apiVersion": "v1", "metadata": {"resourceVersion": "4242"}, "items": items}


def main():
    os.makedirs(OUT, exist_ok=True)
    pods = [pod(p) for p in PODS]
    nss = sorted({p["ns"] for p in PODS} | {"kube-public", "kube-node-lease"})
    docs = {
        "version": {"major": "1", "minor": "31", "gitVersion": K3S, "platform": "linux/arm64"},
        "nodes": lst("Node", [node(*n) for n in NODES]),
        "pods": lst("Pod", pods),
        "namespaces": lst("Namespace", [{"apiVersion": "v1", "kind": "Namespace",
                                         "metadata": {"name": n, "uid": uid("ns/" + n), "creationTimestamp": iso(120 * 86400)},
                                         "status": {"phase": "Active"}} for n in nss]),
        "services": lst("Service", [
            svc("default", "kubernetes", "ClusterIP", [443]),
            svc("kube-system", "kube-dns", "ClusterIP", [53]),
            svc("kube-system", "metrics-server", "ClusterIP", [443]),
            svc("kube-system", "traefik", "LoadBalancer", [80, 443], [31080, 31443], ["192.0.2.10", "192.0.2.11", "192.0.2.12"]),
            svc("monitoring", "grafana", "ClusterIP", [3000]),
            svc("monitoring", "prometheus", "ClusterIP", [9090]),
            svc("media", "jellyfin", "NodePort", [8096], [30096]),
            svc("apps", "web-frontend", "ClusterIP", [80]),
            svc("apps", "api", "ClusterIP", [8080]),
            svc("apps", "redis", "ClusterIP", [6379]),
        ]),
        "events": lst("Event", [
            event("photos", "Pod", "photo-sync-4c5d6e7f8-b7c8d", "BackOff", "Back-off restarting failed container", 412, 30),
            event(None, "Node", "pi-agent-3", "NodeNotReady", "Node pi-agent-3 status is now: NodeNotReady", 1, 3 * 3600 - 40),
            event("ai", "Pod", "ollama-2a3b4c5d6-h1i2j", "FailedScheduling", "0/4 nodes are available: 3 Insufficient memory.", 9, 120),
            event("apps", "Pod", "api-5f6g7h8j9-r1s2t", "Unhealthy", "Readiness probe failed: HTTP probe failed with statuscode: 503", 3, 6 * 3600),
            event("default", "Pod", "nightly-backup-29341440-k3l4m", "Pulled", "Container image already present", 1, 9 * 3600, "Normal"),
        ]),
        "metrics_nodes": {"kind": "NodeMetricsList", "apiVersion": "metrics.k8s.io/v1beta1", "metadata": {}, "items": [
            {"metadata": {"name": "pi-server"}, "timestamp": iso(15), "window": "20s", "usage": {"cpu": "812345678n", "memory": "3145728Ki"}},
            {"metadata": {"name": "pi-agent-1"}, "timestamp": iso(15), "window": "20s", "usage": {"cpu": "1623456789n", "memory": "4194304Ki"}},
            {"metadata": {"name": "pi-agent-2"}, "timestamp": iso(15), "window": "20s", "usage": {"cpu": "1290000000n", "memory": "5033164Ki"}},
        ]},
    }
    pm = []
    for p in PODS:
        if p["phase"] != "Running" or p["node"] == "pi-agent-3":
            continue
        h = sum(map(ord, p["name"]))
        cpu = 2 + h % 180 if not p.get("waiting") else 0
        mem = 12 + h % 400
        if p["wn"] in ("prometheus", "jellyfin", "grafana", "whisper"):
            cpu, mem = cpu * 3, mem * 4
        pm.append({"metadata": {"name": p["name"], "namespace": p["ns"]}, "timestamp": iso(15), "window": "20s",
                   "containers": [{"name": p["wn"].split("-")[0], "usage": {"cpu": "%dm" % cpu, "memory": "%dMi" % mem}}]})
    docs["metrics_pods"] = {"kind": "PodMetricsList", "apiVersion": "metrics.k8s.io/v1beta1", "metadata": {}, "items": pm}
    for k, v in docs.items():
        with open(os.path.join(OUT, k + ".json"), "w") as f:
            json.dump(v, f, indent=1, sort_keys=True)
            f.write("\n")
    with open(os.path.join(OUT, "meta.json"), "w") as f:
        json.dump({"fixture_now": FIXTURE_NOW, "cluster": "pi-cluster", "pods": len(PODS), "nodes": len(NODES)}, f, indent=1)
        f.write("\n")
    print("wrote %d pods, %d nodes -> %s" % (len(PODS), len(NODES), OUT))


if __name__ == "__main__":
    main()
