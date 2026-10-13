#!/usr/bin/env python3
"""Reject private infrastructure addresses that are not the documented placeholders.

This repository is public and the thing it draws is somebody's network, so the
one rule a contributor has to keep is: no address from your own lab. Demo
fixtures in particular are *made* by pointing the app at a real cluster and
redacting the result, which is exactly the moment a real address survives.

The check this replaces matched a regular expression per *line* and skipped any
line that also contained the word "example", "test", or the string "10.0.0.".
Every fixture under ``demo/fixtures/`` is minified onto a single line —
``all.json`` is 124 KB of it — so one incidental "example" anywhere in the file
excused all 133 addresses in it. A real ``192.168.1.x`` pasted in during a
refresh would have been waved straight through to a public clone.

So the unit here is the address, not the line. Every match is checked against
the placeholder networks below and nothing else gets it off: no keyword, no
filename, no neighbouring text.

Placeholder convention, matching what the repository already uses throughout:

    10.0.0.0/16     private-side examples (fixtures, docs, .env.example)

Public documentation ranges (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24) are
not private and are never flagged. Need something outside all of that? Change
it to a placeholder — or, if it genuinely has to be literal, widen
``PLACEHOLDER_NETS`` here in the same commit, where a reviewer will see it.

    python3 .github/ipscan.py $(git ls-files)
"""
import argparse
import ipaddress
import pathlib
import re
import sys

# Dotted quads that fall inside RFC1918. Deliberately not anchored to any
# surrounding syntax: an address is an address in JSON, YAML, Markdown or a
# comment.
IPV4 = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")

# What counts as "an address from your own network". Spelled out rather than
# taken from ``ipaddress.is_private``, which also returns True for the RFC5737
# documentation ranges (203.0.113.0/24 and friends) that the fixtures use on
# purpose for the *public* side of the world.
PRIVATE_NETS = [
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("100.64.0.0/10"),     # CGNAT, which is where Tailscale lives
]

PLACEHOLDER_NETS = [
    ipaddress.ip_network("10.0.0.0/16"),       # the repo's example LAN
    ipaddress.ip_network("10.42.0.0/16"),      # k3s's default pod network (tests/fixtures/k8s)
    ipaddress.ip_network("10.43.0.0/16"),      # k3s's default service network
]

# Exactly two files are allowed to contain a counter-example, because stating
# what a violation looks like is their whole job. Named one by one on purpose:
# a blanket "tests/" exemption would be a hole, since a test fixture copied
# from a real lab is as public as anything else here.
SELF_REFERENTIAL = {".github/ipscan.py", "tests/test_ipscan.py"}

SKIP_DIRS = {".git", "node_modules", "dist", "build", "__pycache__", ".venv", "venv"}
SKIP_PREFIXES = ("static/vendor/",)
SKIP_EXT = (".pyc", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".svg",
            ".woff", ".woff2", ".ttf", ".otf", ".map", ".lock", ".min.js", ".pdf",
            ".zip", ".gz", ".mp4", ".webm")

MAX_BYTES = 8_000_000


def is_private(addr):
    """True for an address a public repository has no business naming."""
    try:
        a = ipaddress.ip_address(addr)
    except ValueError:
        return False                       # 999.1.1.1, a version string, a timestamp
    return any(a in net for net in PRIVATE_NETS)


def allowed(addr):
    a = ipaddress.ip_address(addr)
    return any(a in net for net in PLACEHOLDER_NETS)


def skip(path):
    p = pathlib.PurePosixPath(path)
    # removeprefix, not lstrip: lstrip("./") eats the leading dot of
    # ".github/ipscan.py" and the exemption silently stops matching.
    if p.as_posix().removeprefix("./") in SELF_REFERENTIAL:
        return True
    if any(part in SKIP_DIRS for part in p.parts):
        return True
    if str(p).startswith(SKIP_PREFIXES):
        return True
    return path.lower().endswith(SKIP_EXT)


def scan_text(text, label):
    """Every offending address, with the line it sits on and a little context."""
    hits = []
    for m in IPV4.finditer(text):
        addr = m.group(0)
        if not is_private(addr) or allowed(addr):
            continue
        line = text.count("\n", 0, m.start()) + 1
        start = max(0, m.start() - 40)
        context = text[start:m.end() + 40].replace("\n", " ")
        hits.append((label, line, addr, context))
    return hits


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("paths", nargs="*", help="files to scan (typically $(git ls-files))")
    a = ap.parse_args()

    hits = []
    for p in a.paths:
        if skip(p):
            continue
        pp = pathlib.Path(p)
        if not pp.is_file():
            continue
        try:
            raw = pp.read_bytes()
        except OSError:
            continue
        if b"\0" in raw[:4096] or len(raw) > MAX_BYTES:
            continue
        hits += scan_text(raw.decode("utf-8", "replace"), p)

    if hits:
        print("Private infrastructure IP guardrail FAILED.")
        print("These are real-looking private addresses outside the placeholder ranges")
        print(f"({', '.join(str(n) for n in PLACEHOLDER_NETS)}). Redact them:\n")
        for label, line, addr, context in hits[:100]:
            print(f"  {label}:{line}: {addr}")
            print(f"      ...{context.strip()}...")
        if len(hits) > 100:
            print(f"  ... and {len(hits) - 100} more")
        return 1
    print(f"Private infrastructure IP guardrail passed ({len(a.paths)} files).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
