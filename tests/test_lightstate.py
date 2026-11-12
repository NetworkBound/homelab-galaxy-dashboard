#!/usr/bin/env python3
"""Tests for the /api/lightstate whitelist (app.py _ls_sanitize). The pure `_ls_*` helpers
are lifted out of app.py's source, so nothing here needs Flask or a configured service;
tests/test_demo_smoke.py covers the same fields over HTTP.

    python3 tests/test_lightstate.py -v
"""
import ast
import math
import os
import re
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)


def lift(path, want_fn, want_names=()):
    """Compile just the named top-level functions / assignments of a source file."""
    with open(path, encoding="utf-8") as f:
        tree = ast.parse(f.read(), path)
    def wanted(node):
        if isinstance(node, ast.FunctionDef):
            return want_fn(node.name)
        return isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id in want_names for t in node.targets)

    keep = [node for node in tree.body if wanted(node)]
    ns = {"re": re, "math": math, "time": time}
    exec(compile(ast.Module(body=keep, type_ignores=[]), path, "exec"), ns)
    return ns


APP = lift(os.path.join(REPO, "app.py"), lambda n: n.startswith("_ls_"), ("LS_SHOTS", "LS_STORY_MAX", "_LS_CTRL"))
sanitize = APP["_ls_sanitize"]

BASE = {"rgb": [10, 200, 255], "hue": 190, "lit": 1, "mode": "tour", "phase": "hold", "beat": 7, "bri": 80,
        "stop": "host:pve:pve1", "stop_name": "PVE1", "from": "asp:media", "to": "host:pve:pve1", "to_name": "PVE1",
        "idx": 17, "n": 26, "prog": 1, "travel_s": 1.6, "hold_s": 3.2, "manual": False,
        "stops": [{"key": "over:0", "name": "Overview"}], "bpm": 150, "move": "arc", "move_dir": -1}


def post(**kw):
    return dict(BASE, **kw)


class Whitelist(unittest.TestCase):
    def test_v12_fields_unchanged(self):
        s = sanitize(post())
        self.assertEqual({k: s[k] for k in ("bpm", "move", "move_dir", "beat", "bri", "stop", "idx", "n", "phase")},
                         {"bpm": 150.0, "move": "arc", "move_dir": -1, "beat": 7, "bri": 80,
                          "stop": "host:pve:pve1", "idx": 17, "n": 26, "phase": "hold"})
        self.assertNotIn("story", s)
        self.assertNotIn("shot", s)

    def test_story_and_shot_pass(self):
        s = sanitize(post(story="15 containers and 4 VMs running on PVE1", shot="core"))
        self.assertEqual((s["story"], s["shot"]), ("15 containers and 4 VMs running on PVE1", "core"))
        for shot in ("wide", "core", "planet", "stream", "edge"):
            self.assertEqual(sanitize(post(shot=shot))["shot"], shot)
        self.assertEqual(sanitize(post(shot=" Stream "))["shot"], "stream")
        self.assertEqual(sanitize(post(story="ZFS 48 TB · 7 % used"))["story"], "ZFS 48 TB · 7 % used")

    def test_story_is_cleaned(self):
        self.assertEqual(sanitize(post(story="  3 hosts\tup\r\n now\x00\x1b[31m \u202e\u200b "))["story"], "3 hosts up now [31m")
        self.assertEqual(len(sanitize(post(story="x" * 500))["story"]), 64)
        self.assertEqual(sanitize(post(story="a" * 63 + " b"))["story"], "a" * 63)      # no trailing space after the cut

    def test_bad_story_and_shot_are_dropped(self):
        for bad in ("", "   ", "\x00\x01", None, 5, 1.5, True, ["a"], {"text": "a"}):
            self.assertNotIn("story", sanitize(post(story=bad)), repr(bad))
        for bad in ("", "close", "wide;drop", None, 3, ["wide"], {"wide": 1}, "WIDE SHOT"):
            self.assertNotIn("shot", sanitize(post(shot=bad)), repr(bad))

    def test_unknown_fields_are_dropped(self):
        s = sanitize(post(story="3 hosts up", shot="wide", evil="x", story_html="<b>x</b>", shots=["wide"],
                          __proto__={"a": 1}, ts=1))
        self.assertEqual(set(s), {"rgb", "hue", "lit", "mode", "phase", "beat", "bri", "stop", "stop_name", "from", "to",
                                  "to_name", "idx", "n", "prog", "travel_s", "hold_s", "manual", "stops", "ts",
                                  "move", "move_dir", "bpm", "story", "shot"})
        self.assertGreater(s["ts"], 1e9)                                             # the server's clock, never the client's

    def test_no_rgb_is_ignored_and_garbage_raises(self):
        self.assertIsNone(sanitize({"story": "3 hosts up"}))
        self.assertIsNone(sanitize(["rgb"]))
        with self.assertRaises((TypeError, ValueError)):
            sanitize(post(rgb=["a", 1, 2]))

    def test_story_change_is_a_change(self):
        ch = APP["_ls_changed"]
        a, b = sanitize(post(story="3 hosts up")), sanitize(post(story="4 hosts up"))
        self.assertTrue(ch(a, b))
        self.assertTrue(ch(a, sanitize(post())))          # the line clearing reaches the TV too
        self.assertFalse(ch(a, sanitize(post(story="3 hosts up"))))


if __name__ == "__main__":
    unittest.main()
