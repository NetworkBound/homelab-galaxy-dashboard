#!/usr/bin/env python3
"""Scan text for credential shapes. Reads paths, or stdin with --stdin.

Exists because a live credential shipped in a public repo. The sweep that missed
it looked for credential *assignments* -- password= followed by a quote. The
credential was a URL query parameter, where the value follows = directly with no
quote, mid-line, inside a longer string literal.

So the rules are organised by the shape a secret takes in text, not by the name
of the variable holding it. Exit 1 if anything is found.
"""
import argparse
import pathlib
import re
import sys

RULES = [
    ("credential in a URL query string",
     re.compile(r'[?&](?:password|passwd|pwd|pass|token|api_?key|secret|auth|access_token)=([^&\s"\'<>)]{4,})', re.I)),
    ("credential in a URL host part",
     re.compile(r'[a-z][a-z0-9+.-]*://[^/\s:@"\']{1,64}:([^/\s@"\']{4,})@')),
    ("private key", re.compile(r'-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY')),
    ("GitHub token", re.compile(r'\b(gh[pousr]_[A-Za-z0-9]{20,})')),
    ("Slack token", re.compile(r'\b(xox[baprs]-[A-Za-z0-9-]{10,})')),
    ("AWS access key", re.compile(r'\b(AKIA[0-9A-Z]{16})\b')),
    ("JWT", re.compile(r'\b(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})')),
    ("ntfy token", re.compile(r'\b(tk_[a-z0-9]{20,})\b')),
    ("Proxmox API token", re.compile(r'\b([a-z0-9_-]+@(?:pve|pam)![a-z0-9_-]+=[0-9a-f-]{30,})')),
    ("OpenAI-style key", re.compile(r'\b(sk-[A-Za-z0-9_-]{20,})\b')),
    ("bearer token", re.compile(r'Bearer\s+([A-Za-z0-9._-]{20,})')),
    ("assigned secret",
     re.compile(r'(?:password|passwd|secret|api_?key|token|access_key)\s*[:=]\s*["\']([^"\'\s]{8,})["\']', re.I)),
    # The (?<![@/]) matters: pinning a GitHub Action by commit SHA is the
    # recommended practice, and actions/create-github-app-token@<40-hex> puts
    # the word "token" immediately before a hex string on every such line.
    ("secret named in hex",
     re.compile(r'(?:token|key|secret|pat|password|auth)\W{0,4}(?<![@/])\b([0-9a-f]{40}|[0-9a-f]{64})\b', re.I)),
]

PLACEHOLDER = re.compile(
    r'^(?:x{3,}|y{3,}|<[^>]*>|\{\{.*\}\}|\$\{?[A-Z_]+\}?|%[sd]|\.\.\.|'
    r'changeme|change_me|your[_-]?\w*|example\w*|placeholder|redacted|secret|password|'
    r'token|dummy|test|sample|none|null|true|false|abc123|0+|1234\d*)$', re.I)
EMBEDDED_PLACEHOLDER = re.compile(
    r'(?:^|[=:])(?:0{4,}[0-9a-f-]*|x{4,}|<[^>]+>|your[_-]|example|changeme|redacted)', re.I)
SKIP_EXT = (".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2", ".ttf",
            ".pdf", ".zip", ".gz", ".mp4", ".webp", ".lock", ".min.js", ".map")
# A file whose job is to describe secrets rather than hold one.
ALLOW_PATH = re.compile(r'(\.example$|\.sample$|\.template$|/redact\.|/secretscan|'
                        r'test_.*\.py$|.*_test\.(rs|go|js|ts)$|/tests?/)', re.I)


def mask(v):
    return v[0] + "*" * (len(v) - 1) if len(v) <= 8 else f"{v[:3]}...{v[-2:]} ({len(v)} chars)"


def scan_text(text, label, allow_fixtures):
    hits = []
    for name, rx in RULES:
        for m in rx.finditer(text):
            val = m.group(1) if m.lastindex else m.group(0)
            if PLACEHOLDER.match(val) or EMBEDDED_PLACEHOLDER.search(val):
                continue
            if val.startswith(("${", "{{", "<")):
                continue
            if allow_fixtures:
                continue
            line = text.count("\n", 0, m.start()) + 1
            hits.append((label, line, name, mask(val)))
    return hits


def main():
    ap = argparse.ArgumentParser(description="Find credential shapes in text.")
    ap.add_argument("paths", nargs="*")
    ap.add_argument("--stdin", action="store_true")
    ap.add_argument("--label", default="<stdin>")
    a = ap.parse_args()

    hits = []
    if a.stdin:
        hits += scan_text(sys.stdin.read(), a.label, False)
    for p in a.paths:
        pp = pathlib.Path(p)
        if not pp.is_file() or pp.name.lower().endswith(SKIP_EXT):
            continue
        try:
            raw = pp.read_bytes()
        except OSError:
            continue
        if b"\0" in raw[:4096] or len(raw) > 2_000_000:
            continue
        hits += scan_text(raw.decode("utf-8", "replace"), p, bool(ALLOW_PATH.search(p)))

    for label, line, name, masked in hits:
        print(f"  {label}:{line}: {name} -> {masked}")
    return 1 if hits else 0


if __name__ == "__main__":
    sys.exit(main())
