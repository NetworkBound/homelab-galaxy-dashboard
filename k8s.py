"""Read-only Kubernetes / k3s cluster poller for the galaxy dashboard.

Each configured cluster becomes one system in /api/universe (kind "k8s"), its nodes
and pods become bodies, and /api/tour gains one aspect per cluster (asp:k8s).
Stdlib only (urllib / ssl / json), like the rest of the backend.

Configuration (environment)
  K8S_CLUSTERS      one or more "name|api_url|token_file|ca_file" entries separated by
                    ";" "," or newlines. ca_file may be empty (system trust store).
  KUBECONFIG        kubeconfig path(s), ":"-separated; the current context of each is
                    used. Default: /etc/rancher/k3s/k3s.yaml when readable (k3s server).
  K8S_CONTEXT       use this context instead of current-context.
  K8S_CLUSTER_NAME  display name for the kubeconfig / in-cluster cluster (default:
                    the kubeconfig cluster name, "k3s" when that is k3s's "default").
  in-cluster        KUBERNETES_SERVICE_HOST + the service-account token under
                    /var/run/secrets/kubernetes.io/serviceaccount/ (re-read every poll).
  K8S_POLL_S        poll interval, default 10.
  K8S_NS_CATS       namespace -> palette category overrides, "media=media,lab=infra".
  K8S_DISABLE=1     ignore everything above.
  K8S_ALLOW_INSECURE=1  honour "insecure-skip-tls-verify" in a kubeconfig (refused by default).

Honesty and secrets
  * Read-only: GET only, on nodes, pods, namespaces, services, events and
    metrics.k8s.io (see deploy/k3s/rbac.yaml).
  * A bearer token is only ever placed in the Authorization header. It is never logged,
    never returned, never sent over plain http to a non-loopback host, and never
    forwarded on a redirect (redirects are refused). Error text is built here, from
    the HTTP status / exception class, and passed through redact() anyway.
  * An unreachable cluster is status "unknown" with the last known shape and no
    measurements, never zeros. metrics-server missing = no CPU/memory, not 0 %.
"""
import base64
import json
import os
import re
import shutil
import ssl
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

V = 1
POLL_S = float(os.environ.get("K8S_POLL_S", "10") or 10)
TIMEOUT_S = 6.0
K3S_KUBECONFIG = "/etc/rancher/k3s/k3s.yaml"
SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount"
EVENT_WINDOW_S = 3600          # "recent" warning events
RESTART_WINDOW_S = 86400       # restarts reported over this window
PENDING_STUCK_S = 300          # an unschedulable pod older than this is a fault, not a start
SYS_PREFIX = "sys:k8s-"
ID_PREFIX = "k8s:"
TOPO_PREFIX = "k8s:"           # topology hub node id: k8s:<cluster>

BAD_WAIT = {"CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull", "CreateContainerConfigError",
            "CreateContainerError", "RunContainerError", "InvalidImageName"}
_REASON_TEXT = {"CrashLoopBackOff": "crash looping", "ImagePullBackOff": "image pull failing",
                "ErrImagePull": "image pull failing", "CreateContainerConfigError": "bad config",
                "CreateContainerError": "cannot start", "RunContainerError": "cannot start",
                "InvalidImageName": "bad image name", "Evicted": "evicted", "OOMKilled": "out of memory"}


# ------------------------------------------------------------------ secrets --
_SECRET_RX = [re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]+"),
              re.compile(r"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"),   # JWT
              re.compile(r"K10[0-9a-f]{20,}::[A-Za-z0-9:._-]+"),                           # k3s node token
              re.compile(r"(?i)((?:token|password|secret)[\"']?\s*[:=]\s*[\"']?)[^\s\"',}]+")]


def redact(text, secrets=()):
    """Scrub known secret values and token-shaped strings out of text."""
    s = str(text)
    for sec in secrets or ():
        if sec and len(sec) >= 6:
            s = s.replace(sec, "[redacted]")
    for rx in _SECRET_RX:
        s = rx.sub(lambda m: (m.group(1) if m.groups() else "") + "[redacted]", s)
    return s


def _log(msg, secrets=()):
    print("[k8s] " + redact(msg, secrets), flush=True)


# ---------------------------------------------------------------- quantities --
_CPU_SUFFIX = {"n": 1e-9, "u": 1e-6, "m": 1e-3, "": 1.0}
_MEM_SUFFIX = {"Ki": 1024, "Mi": 1024 ** 2, "Gi": 1024 ** 3, "Ti": 1024 ** 4, "Pi": 1024 ** 5, "Ei": 1024 ** 6,
               "k": 1e3, "K": 1e3, "M": 1e6, "G": 1e9, "T": 1e12, "P": 1e15, "E": 1e18, "": 1.0, "m": 1e-3}
_QTY = re.compile(r"^\s*([0-9.]+(?:[eE][-+]?[0-9]+)?)\s*([A-Za-z]*)\s*$")


def cpu_cores(q):
    """'250m' -> 0.25, '4' -> 4.0, '123456789n' -> 0.123456789; None when unparseable."""
    if q is None:
        return None
    if isinstance(q, (int, float)):
        return float(q)
    m = _QTY.match(str(q))
    if not m or m.group(2) not in _CPU_SUFFIX:
        return None
    return float(m.group(1)) * _CPU_SUFFIX[m.group(2)]


def mem_bytes(q):
    """'8Gi' -> 8589934592, '512M' -> 512e6, '1024' -> 1024; None when unparseable."""
    if q is None:
        return None
    if isinstance(q, (int, float)):
        return float(q)
    m = _QTY.match(str(q))
    if not m or m.group(2) not in _MEM_SUFFIX:
        return None
    return float(m.group(1)) * _MEM_SUFFIX[m.group(2)]


def ts_of(s):
    """RFC 3339 -> epoch seconds, None when absent/unparseable."""
    if not s or not isinstance(s, str):
        return None
    try:
        t = s.strip().replace("Z", "+00:00")
        if "." in t:                       # trim fractional seconds to 6 digits
            head, _, rest = t.partition(".")
            frac = re.match(r"\d+", rest).group(0)
            t = head + "." + frac[:6].ljust(6, "0") + rest[len(frac):]
        d = datetime.fromisoformat(t)
        if d.tzinfo is None:
            d = d.replace(tzinfo=timezone.utc)
        return d.timestamp()
    except Exception:
        return None


# ------------------------------------------------------------- mini YAML ----
def _strip_comment(line):
    out, q, esc = [], None, False
    for i, ch in enumerate(line):
        if q:
            if esc:
                esc = False
            elif ch == "\\" and q == '"':
                esc = True
            elif ch == q:
                q = None
        elif ch in "\"'":
            q = ch
        elif ch == "#" and (i == 0 or line[i - 1] in " \t"):
            break
        out.append(ch)
    return "".join(out).rstrip()


_KEY = re.compile(r"""^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s"'#\-?:][^:]*?|-[^\s:][^:]*?)\s*:(?:\s+|$)(.*)$""")


def _scalar(s):
    s = s.strip()
    if s == "" or s in ("~", "null", "Null", "NULL"):
        return None
    if s[0] == '"':
        try:
            return json.loads(s)
        except ValueError:
            return s.strip('"')
    if s[0] == "'":
        return s[1:-1].replace("''", "'") if s.endswith("'") else s[1:]
    if s in ("{}",):
        return {}
    if s in ("[]",):
        return []
    if s[0] == "[" and s.endswith("]"):
        return [_scalar(x) for x in s[1:-1].split(",") if x.strip()]
    if s in ("true", "True", "TRUE"):
        return True
    if s in ("false", "False", "FALSE"):
        return False
    if re.match(r"^-?\d+$", s):
        return int(s)
    return s


def parse_yaml(text):
    """Enough YAML for a kubeconfig (block maps, block sequences, plain/quoted
    scalars, {} and []). JSON documents are accepted as-is."""
    try:
        return json.loads(text)
    except ValueError:
        pass
    lines = []
    for raw in text.splitlines():
        if raw.strip() in ("---", "..."):
            continue
        ln = _strip_comment(raw.replace("\t", "  "))
        if not ln.strip():
            continue
        lines.append([len(ln) - len(ln.lstrip(" ")), ln.strip()])

    def is_item(t):
        return t == "-" or t.startswith("- ")

    def block(i, ind):
        return seq(i, ind) if is_item(lines[i][1]) else mapping(i, ind)

    def seq(i, ind):
        out = []
        while i < len(lines) and lines[i][0] == ind and is_item(lines[i][1]):
            text = lines[i][1]
            rest = text[1:].lstrip()
            if not rest:
                i += 1
                if i < len(lines) and lines[i][0] > ind:
                    v, i = block(i, lines[i][0])
                else:
                    v = None
            elif _KEY.match(rest) or is_item(rest):
                lines[i] = [ind + len(text) - len(rest), rest]
                v, i = block(i, lines[i][0])
            else:
                v, i = _scalar(rest), i + 1
            out.append(v)
        return out, i

    def mapping(i, ind):
        out = {}
        while i < len(lines) and lines[i][0] == ind and not is_item(lines[i][1]):
            m = _KEY.match(lines[i][1])
            if not m:
                raise ValueError("unsupported YAML at line %d" % (i + 1))
            k, rest = _scalar(m.group(1)), m.group(2).strip()
            i += 1
            if rest in ("|", ">", "|-", ">-"):
                raise ValueError("block scalars are not supported")
            if rest == "":
                if i < len(lines) and (lines[i][0] > ind or (lines[i][0] == ind and is_item(lines[i][1]))):
                    v, i = block(i, lines[i][0])
                else:
                    v = None
            else:
                v = _scalar(rest)
            out[str(k)] = v
        return out, i

    if not lines:
        return {}
    doc, i = block(0, lines[0][0])
    if i != len(lines):
        raise ValueError("unparsed YAML from line %d" % (i + 1))
    return doc


# ------------------------------------------------------------------ config --
class Cluster:
    """Connection settings for one cluster. Secret material stays in memory only
    and never appears in repr()."""

    def __init__(self, name, server, token_file=None, ca_file=None, ca_data=None, token=None,
                 cert_data=None, key_data=None, insecure=False, source="env"):
        self.name = _safe_name(name)
        self.server = (server or "").rstrip("/")
        self.token_file, self.ca_file, self.ca_data = token_file or None, ca_file or None, ca_data or None
        self._token, self._cert, self._key = token or None, cert_data or None, key_data or None
        self.insecure, self.source = bool(insecure), source

    def __repr__(self):
        return "Cluster(%r, %r, source=%r)" % (self.name, self.server, self.source)

    def token(self):
        """The bearer token, re-read from token_file each call (bound tokens rotate)."""
        if self.token_file:
            with open(self.token_file) as f:
                return f.read().strip() or None
        return self._token

    def secrets(self):
        out = []
        try:
            t = self.token()
            if t:
                out.append(t)
        except OSError:
            pass
        return out


def _safe_name(name):
    s = re.sub(r"[^a-z0-9-]+", "-", str(name or "k3s").strip().lower()).strip("-")
    return s[:40] or "k3s"


def _b64(s):
    if not s:
        return None
    try:
        return base64.b64decode(s).decode("utf-8")
    except Exception:
        return None


def _rel(path, base):
    if not path:
        return None
    return path if os.path.isabs(path) else os.path.join(os.path.dirname(os.path.abspath(base)), path)


def clusters_from_kubeconfig(path, context=None, name=None, allow_insecure=False):
    with open(path) as f:
        doc = parse_yaml(f.read())
    if not isinstance(doc, dict):
        raise ValueError("not a kubeconfig")
    ctxs = {c.get("name"): c.get("context") or {} for c in doc.get("contexts") or [] if isinstance(c, dict)}
    cls = {c.get("name"): c.get("cluster") or {} for c in doc.get("clusters") or [] if isinstance(c, dict)}
    users = {u.get("name"): u.get("user") or {} for u in doc.get("users") or [] if isinstance(u, dict)}
    cname = context or doc.get("current-context") or next(iter(ctxs), None)
    ctx = ctxs.get(cname)
    if ctx is None:
        raise ValueError("kubeconfig context not found")
    cl, us = cls.get(ctx.get("cluster")) or {}, users.get(ctx.get("user")) or {}
    if not cl.get("server"):
        raise ValueError("kubeconfig cluster has no server")
    if us.get("exec") or us.get("auth-provider"):
        raise ValueError("kubeconfig exec/auth-provider users are not supported")
    insecure = bool(cl.get("insecure-skip-tls-verify"))
    if insecure and not allow_insecure:
        raise ValueError("kubeconfig asks for insecure-skip-tls-verify (set K8S_ALLOW_INSECURE=1 to allow)")
    kname = ctx.get("cluster") or cname
    disp = name or ("k3s" if kname == "default" else kname)

    def data_or_file(d, fkey):
        if us.get(d):
            return _b64(us[d])
        p = _rel(us.get(fkey), path)
        if p:
            with open(p) as fh:
                return fh.read()
        return None

    return Cluster(disp, cl["server"], token_file=_rel(us.get("tokenFile"), path),
                   ca_file=_rel(cl.get("certificate-authority"), path),
                   ca_data=_b64(cl.get("certificate-authority-data")), token=us.get("token"),
                   cert_data=data_or_file("client-certificate-data", "client-certificate"),
                   key_data=data_or_file("client-key-data", "client-key"),
                   insecure=insecure, source="kubeconfig")


def clusters_from_env(env=None):
    env = os.environ if env is None else env
    if str(env.get("K8S_DISABLE", "")).strip() in ("1", "true", "yes"):
        return []
    out, errors = [], []
    for ent in re.split(r"[;,\n]+", env.get("K8S_CLUSTERS", "") or ""):
        ent = ent.strip()
        if not ent:
            continue
        parts = [p.strip() for p in ent.split("|")]
        if len(parts) < 3 or not parts[1]:
            errors.append("K8S_CLUSTERS entry needs name|api_url|token_file[|ca_file]")
            continue
        out.append(Cluster(parts[0], parts[1], token_file=parts[2] or None,
                           ca_file=(parts[3] if len(parts) > 3 else "") or None, source="env"))
    kc = env.get("KUBECONFIG")
    paths = [p for p in (kc or "").split(os.pathsep) if p] if kc else (
        [K3S_KUBECONFIG] if os.access(K3S_KUBECONFIG, os.R_OK) else [])
    for p in paths:
        try:
            out.append(clusters_from_kubeconfig(p, env.get("K8S_CONTEXT") or None,
                                                env.get("K8S_CLUSTER_NAME") or None,
                                                str(env.get("K8S_ALLOW_INSECURE", "")) in ("1", "true", "yes")))
        except Exception as e:
            errors.append("kubeconfig %s: %s" % (p, e))
    host = env.get("KUBERNETES_SERVICE_HOST")
    sa_token = os.path.join(env.get("K8S_SA_DIR", SA_DIR), "token")
    if host and os.path.exists(sa_token):
        port = env.get("KUBERNETES_SERVICE_PORT", "443")
        hp = "[%s]" % host if ":" in host else host
        ca = os.path.join(os.path.dirname(sa_token), "ca.crt")
        out.append(Cluster(env.get("K8S_CLUSTER_NAME") or "k3s", "https://%s:%s" % (hp, port),
                           token_file=sa_token, ca_file=ca if os.path.exists(ca) else None, source="in-cluster"))
    seen, uniq = set(), []
    for c in out:
        if c.name in seen:
            continue
        seen.add(c.name)
        uniq.append(c)
    for e in errors:
        _log("config: " + e)
    return uniq


# ------------------------------------------------------------------ client --
class K8sError(Exception):
    """kind: auth | forbidden | notfound | unavailable | unreachable | tls | bad_response | config"""

    def __init__(self, kind, msg, status=None):
        super().__init__(msg)
        self.kind, self.status = kind, status


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise K8sError("bad_response", "API redirected (HTTP %d); refusing to follow with credentials" % code, code)


_LOOPBACK = ("127.0.0.1", "::1", "localhost")


class Client:
    def __init__(self, cluster, timeout=TIMEOUT_S):
        self.c = cluster
        self.timeout = timeout
        u = urllib.parse.urlparse(cluster.server)
        if u.scheme not in ("https", "http") or not u.hostname:
            raise K8sError("config", "api_url must be http(s)://host[:port]")
        self.scheme, self.host = u.scheme, u.hostname
        handlers = [urllib.request.ProxyHandler({}), _NoRedirect()]
        if u.scheme == "https":
            handlers.append(urllib.request.HTTPSHandler(context=self._ssl()))
        self.opener = urllib.request.build_opener(*handlers)

    def _ssl(self):
        c = self.c
        ctx = ssl.create_default_context(cafile=c.ca_file) if c.ca_file else ssl.create_default_context()
        if c.ca_data:
            ctx.load_verify_locations(cadata=c.ca_data)
        if c.insecure:
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
        if c._cert and c._key:
            # ssl only loads client keys from files: a private 0700 dir, removed at once
            d = tempfile.mkdtemp(prefix="k8s-")
            try:
                cp, kp = os.path.join(d, "c.pem"), os.path.join(d, "k.pem")
                for p, data in ((cp, c._cert), (kp, c._key)):
                    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                    with os.fdopen(fd, "w") as f:
                        f.write(data)
                ctx.load_cert_chain(cp, kp)
            finally:
                shutil.rmtree(d, ignore_errors=True)
        return ctx

    def get(self, path):
        url = self.c.server + path
        headers = {"Accept": "application/json", "User-Agent": "galaxy-dashboard-k8s/1"}
        try:
            tok = self.c.token()
        except OSError as e:
            raise K8sError("config", "token file unreadable (%s)" % type(e).__name__)
        if tok:
            if self.scheme == "http" and self.host not in _LOOPBACK:
                raise K8sError("config", "refusing to send a token over plain http to a non-loopback host")
            headers["Authorization"] = "Bearer " + tok
        req = urllib.request.Request(url, headers=headers, method="GET")
        try:
            with self.opener.open(req, timeout=self.timeout) as r:
                body = r.read()
        except K8sError:
            raise
        except urllib.error.HTTPError as e:
            code = e.code
            try:
                e.close()
            except Exception:
                pass
            kind = {401: "auth", 403: "forbidden", 404: "notfound"}.get(code, "unavailable")
            text = {401: "auth failed", 403: "forbidden", 404: "not found"}.get(code, "API error")
            raise K8sError(kind, "%s (HTTP %d)" % (text, code), code)
        except (ssl.SSLError, ssl.CertificateError) as e:
            raise K8sError("tls", "TLS verification failed (%s)" % type(e).__name__)
        except urllib.error.URLError as e:
            r = e.reason
            if isinstance(r, (ssl.SSLError, ssl.CertificateError)):
                raise K8sError("tls", "TLS verification failed (%s)" % type(r).__name__)
            raise K8sError("unreachable", "unreachable (%s)" % type(r).__name__)
        except (TimeoutError, ConnectionError, OSError) as e:
            raise K8sError("unreachable", "unreachable (%s)" % type(e).__name__)
        try:
            return json.loads(body)
        except ValueError:
            raise K8sError("bad_response", "API answered with non-JSON")

    def get_list(self, path, limit=500, max_pages=40):
        items, cont, sep = [], None, "&" if "?" in path else "?"
        for _ in range(max_pages):
            q = "limit=%d" % limit + ("&continue=" + urllib.parse.quote(cont) if cont else "")
            d = self.get(path + sep + q)
            items.extend(d.get("items") or [])
            cont = (d.get("metadata") or {}).get("continue")
            if not cont:
                break
        return {"items": items}


# --------------------------------------------------------------- normalise --
def _cond(obj, typ):
    for c in ((obj.get("status") or {}).get("conditions") or []):
        if c.get("type") == typ:
            return c
    return None


def norm_node(n, now):
    md, st, sp = n.get("metadata") or {}, n.get("status") or {}, n.get("spec") or {}
    labels = md.get("labels") or {}
    roles = sorted({k.split("/", 1)[1] for k in labels if k.startswith("node-role.kubernetes.io/") and "/" in k})
    rc = _cond(n, "Ready") or {}
    addrs = {a.get("type"): a.get("address") for a in st.get("addresses") or []}
    info, cap = st.get("nodeInfo") or {}, st.get("capacity") or {}
    pressure = [c.get("type") for c in st.get("conditions") or []
                if c.get("type") in ("MemoryPressure", "DiskPressure", "PIDPressure") and c.get("status") == "True"]
    cp = any(r in ("control-plane", "master") for r in roles)
    pods_cap = cap.get("pods")
    return {"name": md.get("name"), "uid": md.get("uid"), "roles": roles, "control_plane": cp,
            "ready": rc.get("status") == "True", "ready_state": rc.get("status") or "Unknown",
            "ready_reason": rc.get("reason"), "ip": addrs.get("InternalIP") or addrs.get("ExternalIP"),
            "kubelet": info.get("kubeletVersion"), "arch": info.get("architecture"),
            "os": info.get("osImage"), "runtime": info.get("containerRuntimeVersion"),
            "cpu_cap": cpu_cores(cap.get("cpu")), "mem_cap": mem_bytes(cap.get("memory")),
            "pods_cap": int(pods_cap) if str(pods_cap or "").isdigit() else None,
            "cordoned": bool(sp.get("unschedulable")), "pressure": pressure,
            "created": ts_of(md.get("creationTimestamp"))}


def _owner(md):
    refs = md.get("ownerReferences") or []
    ref = next((r for r in refs if r.get("controller")), refs[0] if refs else None)
    return (ref.get("kind"), ref.get("name")) if ref else (None, None)


_CRON_JOB = re.compile(r"^(.+)-(\d{8,})$")


def workload_of(md):
    """(kind, name) of the pod's top-level workload, from ownerReferences + labels
    only (no RBAC on replicasets/jobs needed)."""
    kind, name = _owner(md)
    labels = md.get("labels") or {}
    if kind == "ReplicaSet" and name:
        h = labels.get("pod-template-hash")
        if h and name.endswith("-" + h):
            return "Deployment", name[: -len(h) - 1]
        return "ReplicaSet", name
    if kind == "Job" and name:
        m = _CRON_JOB.match(name)
        return ("CronJob", m.group(1)) if m else ("Job", name)
    if kind in ("DaemonSet", "StatefulSet"):
        return kind, name
    if kind == "Node":
        return "Static", md.get("name")
    if kind:
        return kind, name
    return "Pod", md.get("name")


def norm_pod(p, now):
    md, st, sp = p.get("metadata") or {}, p.get("status") or {}, p.get("spec") or {}
    cs = list(st.get("containerStatuses") or [])
    restarts = sum(int(c.get("restartCount") or 0) for c in cs)
    reason, last_term, last_term_reason = None, None, None
    for c in cs:
        w = (c.get("state") or {}).get("waiting") or {}
        if w.get("reason") in BAD_WAIT and reason is None:
            reason = w.get("reason")
        t = (c.get("lastState") or {}).get("terminated") or {}
        ft = ts_of(t.get("finishedAt"))
        if ft and (last_term is None or ft > last_term):
            last_term, last_term_reason = ft, t.get("reason")
    if reason is None and st.get("reason"):
        reason = st.get("reason")                      # e.g. Evicted
    for c in st.get("initContainerStatuses") or []:
        w = (c.get("state") or {}).get("waiting") or {}
        if w.get("reason") in BAD_WAIT and reason is None:
            reason = w.get("reason")
    sched = _cond(p, "PodScheduled") or {}
    wk, wn = workload_of(md)
    return {"ns": md.get("namespace") or "default", "name": md.get("name"), "uid": md.get("uid") or md.get("name"),
            "phase": st.get("phase") or "Unknown", "node": sp.get("nodeName"),
            "ready": (_cond(p, "Ready") or {}).get("status") == "True",
            "containers": len(sp.get("containers") or []) or len(cs),
            "ready_containers": sum(1 for c in cs if c.get("ready")),
            "restarts": restarts, "reason": reason, "last_term": last_term, "last_term_reason": last_term_reason,
            "unschedulable": sched.get("status") == "False" and sched.get("reason") == "Unschedulable",
            "owner_kind": _owner(md)[0], "owner": _owner(md)[1], "wkind": wk, "wname": wn,
            "created": ts_of(md.get("creationTimestamp")), "started": ts_of(st.get("startTime")),
            "deleting": bool(md.get("deletionTimestamp"))}


def norm_service(s):
    md, sp, st = s.get("metadata") or {}, s.get("spec") or {}, s.get("status") or {}
    ports = sp.get("ports") or []
    lb = [i.get("ip") or i.get("hostname") for i in (st.get("loadBalancer") or {}).get("ingress") or []]
    return {"ns": md.get("namespace"), "name": md.get("name"), "type": sp.get("type") or "ClusterIP",
            "node_ports": sorted(int(p["nodePort"]) for p in ports if p.get("nodePort")),
            "ports": sorted(int(p["port"]) for p in ports if p.get("port")),
            "lb": [x for x in lb if x]}


def norm_event(e, now):
    md = e.get("metadata") or {}
    io = e.get("involvedObject") or e.get("regarding") or {}
    last = (ts_of(e.get("lastTimestamp")) or ts_of(e.get("eventTime")) or ts_of((e.get("series") or {}).get("lastObservedTime"))
            or ts_of(e.get("firstTimestamp")) or ts_of(md.get("creationTimestamp")))
    return {"ns": md.get("namespace") or io.get("namespace"), "kind": io.get("kind"), "name": io.get("name"),
            "reason": e.get("reason"), "count": int(e.get("count") or ((e.get("series") or {}).get("count")) or 1),
            "last": last, "type": e.get("type")}


def normalize(raw, now):
    """raw: {"nodes", "pods", "namespaces"?, "services"?, "events"?, "version"?,
    "metrics_nodes"?, "metrics_pods"?} API documents -> one plain snapshot dict."""
    nodes = sorted((norm_node(n, now) for n in (raw.get("nodes") or {}).get("items") or []), key=lambda n: n["name"] or "")
    pods = sorted((norm_pod(p, now) for p in (raw.get("pods") or {}).get("items") or []),
                  key=lambda p: (p["ns"], p["name"] or ""))
    if raw.get("namespaces") is not None:
        nss = sorted((n.get("metadata") or {}).get("name") for n in raw["namespaces"].get("items") or [])
    else:
        nss = sorted({p["ns"] for p in pods})
    out = {"nodes": nodes, "pods": pods, "namespaces": [n for n in nss if n]}
    if raw.get("services") is not None:
        out["services"] = [norm_service(s) for s in raw["services"].get("items") or []]
    if raw.get("events") is not None:
        ev = [norm_event(e, now) for e in raw["events"].get("items") or []]
        out["events"] = sorted((e for e in ev if e["type"] == "Warning" and e["last"] and now - e["last"] <= EVENT_WINDOW_S),
                               key=lambda e: -e["last"])
    if raw.get("version"):
        out["version"] = raw["version"].get("gitVersion")
    if raw.get("metrics_nodes") is not None:
        out["metrics"] = {"nodes": {}, "pods": {}}
        for m in raw["metrics_nodes"].get("items") or []:
            u = m.get("usage") or {}
            out["metrics"]["nodes"][(m.get("metadata") or {}).get("name")] = {
                "cpu": cpu_cores(u.get("cpu")), "mem": mem_bytes(u.get("memory"))}
        for m in (raw.get("metrics_pods") or {}).get("items") or []:
            md = m.get("metadata") or {}
            cpu = mem = 0.0
            ok = False
            for c in m.get("containers") or []:
                u = c.get("usage") or {}
                cc, mm = cpu_cores(u.get("cpu")), mem_bytes(u.get("memory"))
                if cc is not None:
                    cpu += cc
                    ok = True
                if mm is not None:
                    mem += mm
            if ok:
                out["metrics"]["pods"]["%s/%s" % (md.get("namespace"), md.get("name"))] = {"cpu": cpu, "mem": mem}
    return out


# ------------------------------------------------------- stable pod identity --
class PodIds:
    """Stable body keys for pods whose names change on every restart/rollout:
       Deployment / ReplicaSet  deploy/<name>#<i>   i = lowest free index, sticky per pod uid
       DaemonSet                ds/<name>@<node>
       StatefulSet, bare, static pods: their own (stable) name
       Job / CronJob            the newest pod only: job/<name>, cron/<cronjob>
    The sticky table lives in memory; after a restart indexes are re-dealt by
    creation time, which keeps a steady workload on the same keys."""

    def __init__(self):
        self.idx = {}

    def assign(self, pods):
        out, groups, newest = {}, {}, {}
        for p in pods:
            wk, wn, ns = p["wkind"], p["wname"], p["ns"]
            if wk in ("Deployment", "ReplicaSet"):
                groups.setdefault((ns, wk, wn), []).append(p)
            elif wk == "DaemonSet" and p["node"]:
                out[p["uid"]] = ("ds/%s@%s" % (wn, p["node"]), "%s %s" % (wn, p["node"]))
            elif wk in ("Job", "CronJob"):
                k = (ns, wk, wn)
                if k not in newest or (p["created"] or 0, p["name"]) > (newest[k]["created"] or 0, newest[k]["name"]):
                    newest[k] = p
            elif wk == "StatefulSet":
                out[p["uid"]] = ("sts/%s" % p["name"], p["name"])
            else:
                out[p["uid"]] = ("pod/%s" % p["name"], p["name"])
        for (ns, wk, wn), p in newest.items():
            out[p["uid"]] = ("%s/%s" % ("cron" if wk == "CronJob" else "job", wn), wn)
        live_groups = set()
        for key, members in groups.items():
            live_groups.add(key)
            table = self.idx.setdefault(key, {})
            uids = {p["uid"] for p in members}
            for u in [u for u in table if u not in uids]:
                del table[u]
            for p in sorted(members, key=lambda p: (p["created"] or 0, p["name"])):
                if p["uid"] not in table:
                    used = set(table.values())
                    i = 0
                    while i in used:
                        i += 1
                    table[p["uid"]] = i
                i = table[p["uid"]]
                tag = "deploy" if key[1] == "Deployment" else "rs"
                out[p["uid"]] = ("%s/%s#%d" % (tag, key[2], i), key[2] if i == 0 else "%s %d" % (key[2], i + 1))
        for key in [k for k in self.idx if k not in live_groups]:
            del self.idx[key]
        return out


# ------------------------------------------------------------------ poller --
class ClusterPoller:
    """Polls one cluster. snapshot() is a plain dict that never holds a secret:
       name, status ("ok" | "unknown"), error (None | short text), error_kind,
       checked (last attempt), ts (last success), data (last good normalize() output
       plus "ids" and "restarts_24h"), metrics (bool), notes (degraded optional feeds)."""

    def __init__(self, cluster, interval=POLL_S, client=None):
        self.cluster, self.interval = cluster, interval
        self._client = client
        self.ids = PodIds()
        self.lock = threading.Lock()
        self._snap = {"name": cluster.name, "status": "unknown", "error": "not polled yet",
                      "error_kind": "pending", "checked": None, "ts": None, "data": None,
                      "metrics": False, "notes": []}
        self._restarts = {}        # pod uid -> last restartCount
        self._rlog = []            # (ts, n) restart increments seen
        self._partial_until = 0.0
        self._started = None
        self._last_err = None
        self._thread = None

    def client(self):
        if self._client is None:
            self._client = Client(self.cluster)
        return self._client

    def snapshot(self):
        with self.lock:
            return dict(self._snap)

    def _restarts_24h(self, pods, now):
        """Restarts in the last 24 h. Exact for increments this poller saw and for pods
        created inside the window. A pod first seen older than the window, with its
        last restart inside it, counts once: a lower bound, flagged partial for 24 h."""
        if self._started is None:
            self._started = now
        live = set()
        for p in pods:
            u, n = p["uid"], p["restarts"]
            live.add(u)
            prev = self._restarts.get(u)
            if prev is None:
                if n and p["created"] and now - p["created"] <= RESTART_WINDOW_S:
                    self._rlog.append((p["last_term"] or now, n))
                elif n and p["last_term"] and now - p["last_term"] <= RESTART_WINDOW_S:
                    self._rlog.append((p["last_term"], 1))
                    if n > 1:
                        self._partial_until = max(self._partial_until, p["last_term"] + RESTART_WINDOW_S)
            elif n > prev:
                self._rlog.append((now, n - prev))
            self._restarts[u] = n
        for u in [u for u in self._restarts if u not in live]:
            del self._restarts[u]
        self._rlog = [(t, k) for t, k in self._rlog if now - t <= RESTART_WINDOW_S]
        return sum(k for _, k in self._rlog), now < self._partial_until

    def poll_once(self, now=None):
        now = time.time() if now is None else now
        c = self.cluster
        try:
            cl = self.client()
            raw, notes = {}, []
            raw["nodes"] = cl.get("/api/v1/nodes")
            raw["pods"] = cl.get_list("/api/v1/pods")
            for key, path in (("namespaces", "/api/v1/namespaces"), ("services", "/api/v1/services"),
                              ("events", "/api/v1/events?fieldSelector=type%3DWarning"), ("version", "/version")):
                try:
                    raw[key] = cl.get_list(path) if key in ("services", "events") else cl.get(path)
                except K8sError as e:
                    if e.kind in ("unreachable", "auth"):
                        raise
                    if key != "version":
                        notes.append("%s: %s" % (key, e))
            metrics = False
            try:
                raw["metrics_nodes"] = cl.get("/apis/metrics.k8s.io/v1beta1/nodes")
                try:
                    raw["metrics_pods"] = cl.get_list("/apis/metrics.k8s.io/v1beta1/pods")
                except K8sError as e:
                    if e.kind == "unreachable":
                        raise
                    notes.append("pod metrics: %s" % e)
                metrics = True
            except K8sError as e:
                if e.kind in ("unreachable", "auth"):
                    raise
                notes.append("metrics-server unavailable (%s)" % (e,) if e.kind != "notfound"
                             else "metrics-server not installed")
            data = normalize(raw, now)
            data["ids"] = self.ids.assign(data["pods"])
            r24, partial = self._restarts_24h(data["pods"], now)
            data["restarts_24h"], data["restarts_partial"] = r24, partial
            with self.lock:
                self._snap = {"name": c.name, "status": "ok", "error": None, "error_kind": None,
                              "checked": now, "ts": now, "data": data, "metrics": metrics, "notes": notes}
            if self._last_err:
                _log("%s: recovered" % c.name)
            self._last_err = None
        except Exception as e:
            kind = e.kind if isinstance(e, K8sError) else "error"
            msg = str(e) if isinstance(e, K8sError) else "poll failed (%s)" % type(e).__name__
            msg = redact(msg, c.secrets())
            with self.lock:
                s = dict(self._snap)
                s.update(status="unknown", error=msg, error_kind=kind, checked=now)
                self._snap = s
            if msg != self._last_err:
                _log("%s: %s" % (c.name, msg), c.secrets())
            self._last_err = msg
        return self.snapshot()

    def run(self):
        while True:
            self.poll_once()
            time.sleep(self.interval)

    def start(self):
        if self._thread is None:
            self._thread = threading.Thread(target=self.run, daemon=True, name="k8s-" + self.cluster.name)
            self._thread.start()


class Registry:
    def __init__(self):
        self.pollers = {}
        self.started = False
        self._fixed = None           # tests / stage: explicit snapshots

    def add(self, poller):
        self.pollers[poller.cluster.name] = poller

    def set_snapshots(self, snaps):
        self._fixed = list(snaps) if snaps is not None else None

    def snapshots(self):
        if self._fixed is not None:
            return list(self._fixed)
        return [p.snapshot() for _, p in sorted(self.pollers.items())]


REGISTRY = Registry()


def start(env=None, registry=None):
    """Read the config and start one poller thread per cluster. Idempotent."""
    reg = registry or REGISTRY
    if reg.started:
        return reg
    reg.started = True
    for c in clusters_from_env(env):
        p = ClusterPoller(c)
        reg.add(p)
        p.start()
        _log("polling %s (%s) every %ds" % (c.name, c.source, int(p.interval)))
    return reg


def _snaps(snaps):
    return REGISTRY.snapshots() if snaps is None else list(snaps)


# ---------------------------------------------------------- universe mapping --
_NS_CAT = {"kube-system": "infra", "kube-public": "infra", "kube-node-lease": "infra", "default": None,
           "monitoring": "monitor", "observability": "monitor", "prometheus": "monitor", "grafana": "monitor",
           "loki": "monitor", "logging": "monitor", "media": "media", "jellyfin": "media", "plex": "media",
           "ai": "ai", "ml": "ai", "ollama": "ai", "llm": "ai", "web": "web", "apps": "web", "www": "web",
           "ingress": "network", "ingress-nginx": "network", "traefik": "network", "metallb-system": "network",
           "cert-manager": "network", "tailscale": "network", "networking": "network", "longhorn-system": "infra",
           "storage": "infra", "argocd": "infra", "flux-system": "infra"}
_NAME_CAT = [("ai", r"ollama|llama|whisper|comfy|stable-?diffusion|vllm|openwebui|open-webui"),
             ("media", r"jellyfin|plex|emby|sonarr|radarr|lidarr|prowlarr|tdarr|immich|photo"),
             ("monitor", r"prometheus|grafana|loki|alertmanager|node-exporter|kube-state|uptime|tempo|promtail"),
             ("network", r"traefik|coredns|ingress|metallb|svclb|cert-manager|cilium|flannel|tailscale|pihole|adguard"),
             ("web", r"nginx|frontend|web|wordpress|nextcloud|api|ghost")]


def ns_cats(env=None):
    env = os.environ if env is None else env
    out = dict(_NS_CAT)
    for ent in (env.get("K8S_NS_CATS") or "").split(","):
        k, _, v = ent.partition("=")
        if k.strip() and v.strip() in ("ai", "media", "network", "monitor", "web", "infra"):
            out[k.strip()] = v.strip()
    return out


def cat_of(ns, name=None, cats=None):
    """Palette category for a pod: its namespace first (kube-system -> infra), then
    the workload name for namespaces with no meaning of their own (default, apps)."""
    cats = ns_cats() if cats is None else cats
    c = cats.get(ns)
    if c:
        return c
    for cat, rx in _NAME_CAT:
        if re.search(rx, "%s %s" % (ns, name or ""), re.I):
            return cat
    return "infra"


def system_id(name):
    return SYS_PREFIX + _safe_name(name)


def hub_topo_id(name):
    return TOPO_PREFIX + _safe_name(name)


def node_body_id(cluster, node):
    return "%s%s:node:%s" % (ID_PREFIX, _safe_name(cluster), node)


def pod_body_id(cluster, ns, key):
    return "%s%s:pod:%s/%s" % (ID_PREFIX, _safe_name(cluster), ns, key)


def system_def(sid):
    """SYSTEM_DEFS-style entry for a k8s system id (universe.build reads it)."""
    if not str(sid).startswith(SYS_PREFIX):
        return None
    name = sid[len(SYS_PREFIX):]
    try:
        import universe
        accent = universe.system_accent(sid)
    except Exception:
        accent = "#7aa2ff"
    return {"label": name, "kind": "k8s", "accent": accent}


def _hub_node(data):
    """The control-plane node at the galaxy core (first by name), else the first node."""
    nodes = data.get("nodes") or []
    cps = [n for n in nodes if n["control_plane"]]
    return (cps or nodes or [None])[0]


def _pod_status(p, node_ready, now):
    """(status, down_why) from phase / Ready / waiting reason."""
    ph = p["phase"]
    if p["node"] and node_ready.get(p["node"]) is False and ph in ("Running", "Pending"):
        return "unknown", None                    # its kubelet stopped reporting
    if ph == "Running":
        if p["ready"]:
            return "up", None
        if p["reason"] in BAD_WAIT:
            return "down", "offline"
        return "idle", None                       # starting / probe not passing yet
    if ph == "Pending":
        if p["reason"] in BAD_WAIT:
            return "down", "offline"
        if p["unschedulable"] and p["created"] and now - p["created"] > PENDING_STUCK_S:
            return "down", "offline"
        return "idle", None
    if ph == "Succeeded":
        return "down", "stopped"                  # a finished job is not an outage
    if ph == "Failed":
        return "down", "offline"
    return "unknown", None


def observations(Obs, snaps=None, now=None, cats=None):
    """universe.Obs objects for every cluster snapshot that has ever succeeded.
    Stale (unreachable / auth failing) clusters keep their last shape with status
    'unknown' and no measurements."""
    now = time.time() if now is None else now
    cats = ns_cats() if cats is None else cats
    out = []
    for s in _snaps(snaps):
        data = s.get("data")
        if not data:
            continue
        live = s.get("status") == "ok"
        name, sid = s["name"], system_id(s["name"])
        mx = (data.get("metrics") or {}) if live and s.get("metrics") else {}
        hub = _hub_node(data)
        hub_bid = node_body_id(name, hub["name"]) if hub else None
        node_ready = {n["name"]: n["ready"] for n in data.get("nodes") or []}
        on_node = {}
        for p in data.get("pods") or []:
            if p["node"]:
                on_node[p["node"]] = on_node.get(p["node"], 0) + 1
        # control plane first: it takes the first slot of its ring
        for n in sorted(data.get("nodes") or [], key=lambda n: (not n["control_plane"], n["name"])):
            bid = node_body_id(name, n["name"])
            role = "control-plane" if n["control_plane"] else "agent"
            m = {"k8s_role": role, "kind": "node"}
            if live:
                m.update({"ready": n["ready"], "kubelet": n["kubelet"], "arch": n["arch"], "ip": n["ip"],
                          "pods": on_node.get(n["name"], 0), "cpu_cap": n["cpu_cap"],
                          "mem_cap_b": n["mem_cap"], "pods_cap": n["pods_cap"]})
                if n["cordoned"]:
                    m["cordoned"] = True
                if n["pressure"]:
                    m["pressure"] = list(n["pressure"])
                u = (mx.get("nodes") or {}).get(n["name"])
                if u and u.get("cpu") is not None and n["cpu_cap"]:
                    m["cpu"] = round(u["cpu"] / n["cpu_cap"], 4)
                    m["cpu_pct"] = round(100.0 * u["cpu"] / n["cpu_cap"], 1)
                if u and u.get("mem") is not None and n["mem_cap"]:
                    m["mem_pct"] = round(100.0 * u["mem"] / n["mem_cap"], 1)
                status = "up" if n["ready"] else "down"
            else:
                status = "unknown"
            o = Obs(n["name"], "server", status=status, src=["k8s"], decl=bid, sys_hint=sid, cat="infra", m=m)
            if status == "down":
                o.down_why = "offline"
            if bid == hub_bid:
                o.topo = hub_topo_id(name)
            else:
                # not hub: true - the wall draws every hub->child edge, and 30 pod lines
                # per agent read as a web, not a star system (CONTRACTS 7a)
                o.parent_ref = hub_bid
            out.append(o)
        ids = data.get("ids") or {}
        for p in data.get("pods") or []:
            key = ids.get(p["uid"])
            if not key:
                continue                           # an older run of a job: history, not a body
            bid = pod_body_id(name, p["ns"], key[0])
            m = {"kind": "pod", "ns": p["ns"], "workload": "%s/%s" % (p["wkind"], p["wname"])}
            if live:
                st, why = _pod_status(p, node_ready, now)
                m.update({"pod": p["name"], "phase": p["phase"], "node": p["node"], "ready": p["ready"],
                          "containers": "%d/%d" % (p["ready_containers"], p["containers"]),
                          "restarts": p["restarts"]})
                if p["reason"]:
                    m["reason"] = p["reason"]
                u = (mx.get("pods") or {}).get("%s/%s" % (p["ns"], p["name"]))
                if u:
                    m["cpu_m"] = round(u["cpu"] * 1000.0, 1)
                    m["mem_b"] = int(u["mem"])
            else:
                st, why = "unknown", None
            o = Obs(key[1], "guest_lxc", status=st, src=["k8s"], decl=bid, sys_hint=sid,
                    cat=cat_of(p["ns"], p["wname"], cats), m=m)
            o.down_why = why
            if p["node"]:
                o.parent_ref = node_body_id(name, p["node"])
            out.append(o)
    return out


SHORT_MAX = 14
_GENERIC = {"install", "controller", "provisioner", "operator", "deployment", "server", "app"}


def _clip_tokens(name, room):
    """Fit a dashed name into room characters, whole tokens first."""
    if len(name) <= room:
        return name
    toks = [t for t in re.split(r"[-_.]", name) if t]
    keep = [t for t in toks if t.lower() not in _GENERIC] or toks
    out = ""
    for t in keep:
        cand = (out + "-" + t) if out else t
        if len(cand) > room:
            break
        out = cand
    return out or name[:room]


def _fit(base, suffix):
    if not suffix:
        return _clip_tokens(base, SHORT_MAX)
    return "%s %s" % (_clip_tokens(base, max(3, SHORT_MAX - len(suffix) - 1)), suffix)


def short_names(snaps=None):
    """{body id: short} for every k8s body (CONTRACTS 7: <= 14 chars, unique inside the
    cluster's system). Fed to universe.build as name overrides, under the operator's
    universe_names.json. Workload names lose their namespace prefix
    ("cert-manager-cainjector" in cert-manager -> "cainjector"), replicas get " 2",
    DaemonSet pods their node's distinguishing tail ("node-exp a1")."""
    out = {}
    for s in _snaps(snaps):
        data = s.get("data")
        if not data:
            continue
        name = s["name"]
        nodes = [n["name"] for n in data.get("nodes") or []]
        pre = os.path.commonprefix(nodes) if len(nodes) > 1 else ""
        pre = pre[: pre.rfind("-") + 1] if "-" in pre else ""
        tail = {n: (n[len(pre):] or n) for n in nodes}
        taken = {}

        def put(bid, short):
            short = short[:SHORT_MAX]
            k, i = short.lower(), 2
            while k in taken:
                sfx = " %d" % i
                short2 = short[: SHORT_MAX - len(sfx)].rstrip(" -") + sfx
                k, i = short2.lower(), i + 1
                if k not in taken:
                    short = short2
            taken[k] = bid
            out[bid] = short

        for n in nodes:
            put(node_body_id(name, n), _clip_tokens(n, SHORT_MAX))
        ids = data.get("ids") or {}
        for p in sorted(data.get("pods") or [], key=lambda p: ids.get(p["uid"], ("~",))[0]):
            key = ids.get(p["uid"])
            if not key:
                continue
            wn, ns = p["wname"] or p["name"], p["ns"]
            if wn.startswith(ns + "-") and len(wn) > len(ns) + 1:
                wn = wn[len(ns) + 1:]
            if wn.startswith("helm-install-"):
                wn = "helm-" + wn[len("helm-install-"):]
            k0 = key[0]
            if k0.startswith("ds/"):
                t = tail.get(p["node"] or "", p["node"] or "")
                t = re.sub(r"^(agent|worker|node)-?", lambda m: m.group(1)[0], t)
                t = re.sub(r"^(server|master|control-plane)(?=-|$)-?", "srv", t)
                sh = _fit(wn, t[:5])
            elif "#" in k0 and not k0.endswith("#0"):
                sh = _fit(wn, str(int(k0.rsplit("#", 1)[1]) + 1))
            elif k0.startswith("sts/"):
                sh = _clip_tokens(p["name"], SHORT_MAX)
            else:
                sh = _fit(wn, None)
            put(pod_body_id(name, ns, k0), sh)
    return out


def unknown_systems(snaps=None):
    """System ids whose cluster is not answering right now: bodies there that were not
    reported are 'unknown', never 'gone'."""
    return {system_id(s["name"]) for s in _snaps(snaps) if s.get("status") != "ok"}


def topology_nodes(snaps=None):
    """One topology hub node per cluster that has a shape (kind pvehost: the screens
    draw it as a galaxy core and anchor the k8s system on it). No address."""
    out = []
    for s in _snaps(snaps):
        data = s.get("data")
        if not data:
            continue
        live = s.get("status") == "ok"
        hub = _hub_node(data)
        nodes = data.get("nodes") or []
        meta = {"k8s": True, "anchor_of": system_id(s["name"]), "nodes": len(nodes)}
        if live:
            meta.update({"ready": sum(1 for n in nodes if n["ready"]), "pods": len(data.get("pods") or []),
                         "running": sum(1 for p in data.get("pods") or [] if p["phase"] == "Running")})
        status = "unknown" if not live else ("up" if hub and hub["ready"] else "down")
        out.append({"id": hub_topo_id(s["name"]), "kind": "pvehost", "label": s["name"], "ip": None,
                    "parent": None, "rx": 0.0, "tx": 0.0, "measured": False, "status": status, "meta": meta})
    return out


def augment_topology(topo, snaps=None):
    """A copy of a /api/topology document with the cluster hub nodes added (the
    input is never mutated). Unchanged object when no cluster has a shape."""
    extra = topology_nodes(snaps)
    if not extra:
        return topo
    t = dict(topo or {})
    have = {n.get("id") for n in t.get("nodes") or []}
    t["nodes"] = list(t.get("nodes") or []) + [n for n in extra if n["id"] not in have]
    return t


# ------------------------------------------------------------------- tour --
def _pct(v):
    return "%d" % round(v)


def summary(s, now=None):
    """Cluster facts for the tour aspect and /api/k8s. Measurements only when live."""
    now = time.time() if now is None else now
    data = s.get("data") or {}
    live = s.get("status") == "ok" and bool(data)
    out = {"name": s["name"], "status": s.get("status"), "error": s.get("error"),
           "checked": s.get("checked"), "ts": s.get("ts"), "notes": list(s.get("notes") or [])}
    if not live:
        return out
    nodes, pods = data.get("nodes") or [], data.get("pods") or []
    ids = data.get("ids") or {}
    current = [p for p in pods if p["uid"] in ids]            # newest run per job only
    node_ready = {n["name"]: n["ready"] for n in nodes}
    sts = [_pod_status(p, node_ready, now) for p in current]
    active = [p for p, (st, why) in zip(current, sts) if why != "stopped"]
    running = sum(1 for p, (st, why) in zip(current, sts) if st == "up")
    failing = [p for p, (st, why) in zip(current, sts) if st == "down" and why == "offline"]
    out.update({"nodes": len(nodes), "nodes_ready": sum(1 for n in nodes if n["ready"]),
                "pods": len(active), "pods_running": running, "pods_failing": len(failing),
                "pods_completed": sum(1 for _, (st, why) in zip(current, sts) if why == "stopped"),
                "namespaces": len(data.get("namespaces") or []),
                "restarts_24h": data.get("restarts_24h"), "restarts_partial": bool(data.get("restarts_partial")),
                "warnings_1h": len(data.get("events") or []) if "events" in data else None,
                "version": data.get("version"),
                "crashloop": sorted({ids[p["uid"]][1] for p in current if p["reason"] == "CrashLoopBackOff"})})
    if "services" in data:
        svc = data["services"]
        out["services"] = len(svc)
        out["load_balancers"] = sum(1 for x in svc if x["type"] == "LoadBalancer")
        out["node_ports"] = sum(len(x["node_ports"]) for x in svc if x["type"] in ("NodePort", "LoadBalancer"))
    mx = data.get("metrics") if s.get("metrics") else None
    if mx:
        ready = [n for n in nodes if n["ready"] and n["name"] in (mx.get("nodes") or {})]
        cu = sum(mx["nodes"][n["name"]]["cpu"] or 0 for n in ready)
        cc = sum(n["cpu_cap"] or 0 for n in ready)
        mu = sum(mx["nodes"][n["name"]]["mem"] or 0 for n in ready)
        mc = sum(n["mem_cap"] or 0 for n in ready)
        if cc:
            out["cpu_pct"] = round(100.0 * cu / cc, 1)
        if mc:
            out["mem_pct"] = round(100.0 * mu / mc, 1)
    return out


def _aspect_key(i, name):
    return "asp:k8s" if i == 0 else "asp:k8s:" + _safe_name(name)


def _last_host_stop(U):
    """The wall's last host stop: host:<anchor> of the Proxmox system with the highest slot."""
    systems = getattr(U, "systems", None) or {}
    pve = [s for s in systems.values() if s.get("kind") == "pvehost" and str(s.get("anchor") or "").startswith("pve:")]
    if not pve:
        return "fabric"
    last = max(pve, key=lambda s: (s.get("slot") or 0, s.get("id")))
    return "host:" + last["anchor"]


def tour_aspects(U, snaps=None, now=None):
    """One CONTRACTS 9.1 aspect per cluster: Nodes n/n, Pods n/n, Restarts /24h,
    CPU / mem %. Anchored at the cluster system, after the last host stop."""
    now = time.time() if now is None else now
    out = []
    after = _last_host_stop(U)
    for i, s in enumerate(_snaps(snaps)):
        sid = system_id(s["name"])
        has = getattr(U, "has", None)
        anchor = sid if (has is None or has(sid)) else (U.resolve([sid, "sys:core"]) if hasattr(U, "resolve") else sid)
        a = {"key": _aspect_key(i, s["name"]), "name": "Kubernetes" if i == 0 else "Kubernetes " + s["name"],
             "anchor": anchor, "after": after}
        sm = summary(s, now)
        if "nodes" not in sm:
            a.update({"status": "unknown", "facts": [{"k": "Feed", "v": "unavailable", "s": ""}],
                      "line": "Cluster %s" % ("API unreachable" if s.get("error_kind") == "unreachable"
                                              else "not answering")})
            out.append(a)
            continue
        facts = []
        nr, nn = sm["nodes_ready"], sm["nodes"]
        facts.append({"k": "Nodes", "v": "%d / %d" % (nr, nn), "s": "ok" if nr == nn else ("crit" if nr == 0 else "warn")})
        pr, pn = sm["pods_running"], sm["pods"]
        facts.append({"k": "Pods", "v": "%d / %d" % (pr, pn), "s": "ok" if not sm["pods_failing"] and pr == pn else "warn"})
        r = sm.get("restarts_24h")
        if r is not None:
            facts.append({"k": "Restarts", "v": ("≥%d" if sm["restarts_partial"] else "%d") % r, "u": "/24h",
                          "s": "warn" if sm["crashloop"] else ""})
        if "cpu_pct" in sm and "mem_pct" in sm:
            hi = max(sm["cpu_pct"], sm["mem_pct"])
            facts.append({"k": "CPU / mem", "v": "%s / %s" % (_pct(sm["cpu_pct"]), _pct(sm["mem_pct"])), "u": "%",
                          "s": "crit" if hi >= 95 else "warn" if hi >= 85 else ""})
        bits = []
        if nr < nn:
            bits.append("%d node%s not ready" % (nn - nr, "" if nn - nr == 1 else "s"))
        if sm["crashloop"]:
            bits.append("%s crash looping" % sm["crashloop"][0] if len(sm["crashloop"]) == 1
                        else "%d pods crash looping" % len(sm["crashloop"]))
        elif sm["pods_failing"]:
            bits.append("%d pod%s failing" % (sm["pods_failing"], "" if sm["pods_failing"] == 1 else "s"))
        line = "%d nodes, %d pods" % (nn, pn) + (" · " + ", ".join(bits) if bits else ", all healthy")
        if "cpu_pct" not in sm:
            line += " · no metrics-server"
        worst = max((f["s"] for f in facts), key=lambda x: {"crit": 3, "warn": 2, "ok": 1, "": 0}[x])
        a.update({"status": worst or "ok", "facts": facts[:4], "line": line})
        out.append(a)
    return out


def tour_problems(U=None, snaps=None, now=None):
    """CONTRACTS 9.3 rows ({host, text, sev, lab, n}): a NotReady node is an outage
    (sev 4), a failing pod a warning (sev 3), an unanswering API sev 4/3."""
    now = time.time() if now is None else now
    out = []
    try:
        import universe
        short = universe.short_name
    except Exception:
        short = None

    def sh(label):
        s = (short(label) if short else None) or str(label)
        return s if len(s) <= 14 else s[:13] + "…"

    for s in _snaps(snaps):
        data = s.get("data") or {}
        if s.get("status") != "ok":
            if s.get("error_kind") in ("pending",):
                continue
            out.append({"host": sh(s["name"]), "text": "API unreachable" if s.get("error_kind") == "unreachable"
                        else "API auth failed" if s.get("error_kind") in ("auth", "forbidden") else "API not answering",
                        "sev": 4 if s.get("error_kind") == "unreachable" else 3, "lab": False, "n": 1})
            continue
        nodes = data.get("nodes") or []
        node_ready = {n["name"]: n["ready"] for n in nodes}
        for n in nodes:
            if not n["ready"]:
                out.append({"host": sh(n["name"]), "text": "node not ready", "sev": 4, "lab": False, "n": 1})
        ids = data.get("ids") or {}
        rows = {}
        for p in data.get("pods") or []:
            if p["uid"] not in ids:
                continue
            st, why = _pod_status(p, node_ready, now)
            if st != "down" or why != "offline":
                continue
            host = sh(ids[p["uid"]][1])
            text = _REASON_TEXT.get(p["reason"] or "", "unschedulable" if p["unschedulable"] else "pod failed")
            r = rows.setdefault(host, {"host": host, "text": text, "sev": 3, "lab": False, "n": 0})
            r["n"] += 1
        out.extend(rows.values())
    return out


# ------------------------------------------------------------------ flask --
def install(app, registry=None):
    """GET /api/k8s: per-cluster summary (no secrets, no addresses)."""
    from flask import Response
    reg = registry or REGISTRY

    @app.route("/api/k8s")
    def api_k8s():
        now = time.time()
        body = {"v": V, "ts": round(now, 1), "clusters": [summary(s, now) for s in reg.snapshots()]}
        return Response(json.dumps(body, separators=(",", ":")), mimetype="application/json",
                        headers={"Cache-Control": "no-store"})

    return api_k8s
