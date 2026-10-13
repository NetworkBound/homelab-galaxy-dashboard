# Kubernetes / k3s clusters

The dashboard can watch one or more Kubernetes clusters (k3s is the usual homelab
case) and draw each one as its own galaxy. It can also run *on* k3s.

Everything here is read-only: the dashboard lists cluster objects and never changes
anything in a cluster.

## What you see

| Cluster thing | On the screens |
|---|---|
| the cluster | a system (galaxy), kind `k8s`, with its own accent colour and slot. It is appended after the existing galaxies and never moves them |
| control-plane node | the galaxy core (topology hub `k8s:<cluster>`) |
| agent nodes | bodies of class `server`; their pods have them as `parent` (detail card), no hub edges are drawn |
| pods | bodies of class `guest_lxc`, coloured by namespace category (`kube-system` = infra, `monitoring` = monitor, `media` = media, `ai` = ai, `ingress`/`cert-manager` = network, `apps`/`web` = web; namespaces like `default` fall back to the workload name, else infra) |
| tour | one stop `asp:k8s` per cluster, after the last Proxmox host stop: Nodes ready n / n, Pods running n / n, Restarts /24h, CPU / mem % |
| problems | `<node> · node not ready` (red), `<workload> · crash looping` / `image pull failing` / `unschedulable` (amber), `<cluster> · API unreachable` |

Status rules:
- A node is `up` when Ready, otherwise `down` (`down_why: offline`).
- A pod is `up` when Running and Ready. It is `idle` while starting or Pending.
- A pod is `down/offline` on CrashLoopBackOff, an image pull error, Failed, or Unschedulable for more than 5 minutes.
- A pod is `down/stopped` when it is a finished Job or CronJob run.
- A pod is `unknown` when its node stopped reporting.
- An unreachable API, or one that refuses our credentials, makes every body of that cluster `unknown`, keeping the last known shape. Nothing is ever shown as zero.
- Without metrics-server there are no CPU or memory figures. They are absent, not 0 %.

Pods keep their place through restarts and rollouts:
- Deployment replicas are `deploy/<name>#<i>`.
- DaemonSet pods are `ds/<name>@<node>`.
- StatefulSet pods keep their own names.
- A Job or CronJob is shown by its newest run only.

A pod that disappears is shown as `gone` and is held for `K8S_RETAIN_S` (6 h by default) rather than the registry's 30 days. Nodes keep the normal 30-day hold.

No traffic streams are drawn for clusters. The Kubernetes API has no measured
per-pair traffic, and the dashboard never invents streams.

## Configuration

| Variable | Meaning |
|---|---|
| `K8S_CLUSTERS` | `name\|api_url\|token_file\|ca_file`, several separated by `;` `,` or newlines. `ca_file` may be empty to use the system trust store |
| `KUBECONFIG` | kubeconfig path(s), `:`-separated; the current context is used. Default: `/etc/rancher/k3s/k3s.yaml` when readable |
| `K8S_CONTEXT` | use this context instead |
| `K8S_CLUSTER_NAME` | display name for the kubeconfig or in-cluster cluster (default `k3s`) |
| `K8S_POLL_S` | poll interval, default 10 |
| `K8S_NS_CATS` | namespace category overrides, e.g. `photos=media,lab=infra` |
| `K8S_RETAIN_S` | how long a vanished pod keeps its slot (default 21600) |
| `K8S_DISABLE=1` | ignore all of the above |
| `K8S_ALLOW_INSECURE=1` | honour `insecure-skip-tls-verify` in a kubeconfig (refused by default) |

In-cluster mode turns on by itself when `KUBERNETES_SERVICE_HOST` is set and the
service-account token exists. The token is re-read on every poll, because bound
tokens rotate.

`GET /api/k8s` returns a per-cluster summary (counts, status, last error) for
checking a deployment. It contains no secrets and no addresses.

### A read-only token for an outside dashboard

Apply `deploy/k3s/rbac.yaml` (it also creates the `galaxy` namespace's service
account). Then mint a token and store it in a root-only file on the dashboard host:

```bash
kubectl apply -f deploy/k3s/namespace.yaml -f deploy/k3s/rbac.yaml
kubectl -n galaxy create token galaxy-dashboard --duration=8760h > /etc/homelab-galaxy-dashboard/k3s.token
chmod 600 /etc/homelab-galaxy-dashboard/k3s.token
# the cluster CA (k3s self-signs it):
sudo cat /var/lib/rancher/k3s/server/tls/server-ca.crt > /etc/homelab-galaxy-dashboard/k3s-ca.crt
```

```bash
K8S_CLUSTERS="pi-cluster|https://<server>:6443|/etc/homelab-galaxy-dashboard/k3s.token|/etc/homelab-galaxy-dashboard/k3s-ca.crt"
```

The k3s server certificate covers the server's own addresses and `127.0.0.1`. If
you reach it by another name, add `--tls-san <name>` to the k3s server.

Do not point the dashboard at k3s's admin kubeconfig (`/etc/rancher/k3s/k3s.yaml`)
on a shared host: it is cluster-admin. It is supported, but the RBAC token above is
the intended setup.

### Permissions (deploy/k3s/rbac.yaml)

ClusterRole `galaxy-dashboard-read`:

| API group | Resources | Verbs |
|---|---|---|
| `""` (core) | nodes, pods, namespaces, services, events | get, list, watch |
| `metrics.k8s.io` | nodes, pods | get, list, watch |

There is no access to Secrets, ConfigMaps, logs, exec or proxy, and no write verbs.
`/version` is readable by any authenticated client by default.

### Secret handling

- The token is only ever put in the `Authorization` header.
- Redirects are refused, so the header can never follow a redirect to another host.
- Proxies from the environment are ignored.
- A token is never sent over plain `http` except to loopback.
- Error text is built from HTTP status codes and exception class names, then passed through `k8s.redact()`.
- Client-certificate kubeconfigs (k3s's own) are loaded through a private 0700 temp directory that is deleted immediately.

## Running the dashboard on k3s

`deploy/k3s/` contains:

| File | What |
|---|---|
| `namespace.yaml` | namespace `galaxy` |
| `rbac.yaml` | ServiceAccount + read-only ClusterRole + binding |
| `pvc.yaml` | 1 Gi `local-path` volume for `/var/lib/homelab-dashboard` (registry slots, names, traffic state) |
| `deployment.yaml` | one replica, `Recreate` strategy, non-root (uid 10001), all capabilities dropped, seccomp RuntimeDefault |
| `service.yaml` | ClusterIP, port 80 -> 8080 |
| `ingress.yaml` | optional Traefik Ingress (not in the kustomization) |
| `kustomization.yaml` | `kubectl apply -k deploy/k3s` |
| `Dockerfile` | the image |

### Build the image

From the repository root:

```bash
podman build -f deploy/k3s/Dockerfile -t registry.local/galaxy-dashboard:latest .
# Raspberry Pi agents are arm64; build both architectures into one manifest:
podman build --platform linux/arm64,linux/amd64 \
  --manifest registry.local/galaxy-dashboard:latest -f deploy/k3s/Dockerfile .
podman manifest push registry.local/galaxy-dashboard:latest
```

There are two ways to get the image onto the cluster without a registry:
- Import it on every node with `podman save ... | sudo k3s ctr images import -`.
- Use k3s's `registries.yaml` to point at your own registry.

Change `image:` in `deployment.yaml` to match.

The image has Python 3.12 plus `requirements.txt`. The GPU renderer finds no GPU in
the pod and stays idle. The pod keeps its state (registry slots, history and the
setup wizard's `config.json`) on the `local-path` volume.

### Deploy

```bash
# optional: credentials for the other pollers (UniFi, Zabbix, ...). Never commit them.
kubectl -n galaxy create secret generic galaxy-dashboard-env \
  --from-literal=UNIFI_USER=... --from-literal=UNIFI_PASS=...
kubectl apply -k deploy/k3s
kubectl -n galaxy get pods
kubectl -n galaxy port-forward svc/galaxy-dashboard 8080:80   # then http://127.0.0.1:8080/api/k8s
```

In the pod, k8s.py uses in-cluster mode and watches the cluster it runs on. Set
`K8S_CLUSTER_NAME` in `deployment.yaml` to name its galaxy.

The dashboard has no login of its own, and some of its POST endpoints drive the
room lights and TV. Keep the Ingress LAN-only or put it behind an auth proxy
(Authelia).

## Development and tests

- `python3 -m pytest -q tests` runs everything. `tests/test_k8s.py` uses a fake API (`tests/k8s_stub.py`), never a real cluster.
- `tests/fixtures/k8s/pi-cluster/` is the simulated k3s cluster. Regenerate it with `python3 tests/fixtures/k8s/make_pi_cluster.py`. It has:
  - 1 server and 3 Raspberry Pi agents, one of them NotReady;
  - 32 pods across 8 namespaces, including a crash loop, a Pending pod and finished jobs;
  - metrics-server data.
- Run the stub by hand with `python3 tests/k8s_stub.py --token-file <file> --redate`.
- `DEMO=1 python3 app.py` includes the simulated cluster as a Kubernetes galaxy.
