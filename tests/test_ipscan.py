"""The private-IP guardrail has to see inside a minified file.

The guardrail that shipped was a per-*line* regular expression with a keyword
allowlist: a line was excused if it also contained "example", "test", "sample",
"placeholder", "dummy", "docs/" or the string "10.0.0.". Every demo fixture is
minified onto a single line — ``demo/fixtures/all.json`` is one 124 KB line
with 133 addresses on it — so a single incidental "example" anywhere in the
file excused the entire file.

That is precisely the file most likely to carry a real address: ``docs/demo.md``
explains that the fixtures are produced by running the dashboard against a real
cluster and redacting the output. A missed ``192.168.1.x`` in a refresh would
have gone to a public clone with the guardrail reporting green.

The replacement in ``.github/ipscan.py`` judges each address, so where it sits
and what the rest of the line says are both irrelevant.
"""
import importlib.util
import pathlib
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("ipscan", ROOT / ".github" / "ipscan.py")
ipscan = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ipscan)


class TheUnitOfJudgementIsTheAddress(unittest.TestCase):
    def test_a_real_address_hidden_on_an_allowlisted_line_is_caught(self):
        """The exact shape the old check waved through."""
        line = '{"note":"example fixture","gw":"10.0.0.1","host":"192.168.1.77","test":true}'
        hits = ipscan.scan_text(line, "demo/fixtures/all.json")
        self.assertEqual([h[2] for h in hits], ["192.168.1.77"])

    def test_the_repos_own_placeholder_range_is_fine(self):
        text = "10.0.0.1 10.0.0.250 10.0.2.111 10.0.8.2 10.0.100.4"
        self.assertEqual(ipscan.scan_text(text, "x"), [])

    def test_other_private_ranges_are_not(self):
        for bad in ("192.168.1.1", "172.16.4.9", "172.31.255.254", "10.1.2.3", "100.100.5.6"):
            with self.subTest(bad=bad):
                self.assertEqual([h[2] for h in ipscan.scan_text(bad, "x")], [bad])

    def test_public_and_documentation_ranges_are_left_alone(self):
        # 203.0.113.0/24 and friends are what the fixtures use for the outside
        # world. Python's ipaddress.is_private calls them private; we must not.
        text = "203.0.113.5 192.0.2.10 198.51.100.7 8.8.8.8 1.1.1.1 224.0.0.18 127.0.0.1 169.254.1.1"
        self.assertEqual(ipscan.scan_text(text, "x"), [])

    def test_things_that_look_like_addresses_but_are_not(self):
        self.assertEqual(ipscan.scan_text("version 10.0.0.1.2 and 999.168.1.1 and 1.2.3", "x"), [])

    def test_no_keyword_filename_or_neighbour_can_excuse_an_address(self):
        for label in ("docs/configuration.md", "x.example", "tests/test_x.py", "demo/fixtures/all.json"):
            with self.subTest(label=label):
                text = 'example sample placeholder dummy test 10.0.0.1 -> 192.168.50.4'
                self.assertEqual([h[2] for h in ipscan.scan_text(text, label)], ["192.168.50.4"])


class TheWholeTrackedTreeIsClean(unittest.TestCase):
    def test_it_passes_on_this_repository(self):
        files = subprocess.run(["git", "ls-files"], cwd=ROOT, capture_output=True, text=True,
                               check=True).stdout.split()
        self.assertGreater(len(files), 50)
        r = subprocess.run([sys.executable, str(ROOT / ".github" / "ipscan.py"), *files],
                           cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout[-3000:])

    def test_it_exits_nonzero_on_a_planted_leak(self):
        with tempfile.TemporaryDirectory() as td:
            leak = pathlib.Path(td) / "fixture.json"
            leak.write_text('{"a":"example","b":"10.0.0.5","c":"192.168.1.77"}', encoding="utf-8")
            r = subprocess.run([sys.executable, str(ROOT / ".github" / "ipscan.py"), str(leak)],
                               capture_output=True, text=True)
        self.assertEqual(r.returncode, 1)
        self.assertIn("192.168.1.77", r.stdout)

    def test_the_workflow_actually_calls_it(self):
        wf = (ROOT / ".github" / "workflows" / "public-guardrails.yml").read_text(encoding="utf-8")
        self.assertIn("ipscan.py", wf)
        self.assertIn("git ls-files", wf)


class BinaryAndHugeFilesAreSkippedNotCrashedOn(unittest.TestCase):
    def test_a_png_does_not_abort_the_sweep(self):
        with tempfile.TemporaryDirectory() as td:
            png = pathlib.Path(td) / "x.png"
            png.write_bytes(b"\x89PNG\r\n\x1a\n\x00\x00" + b"\xff" * 500)
            r = subprocess.run([sys.executable, str(ROOT / ".github" / "ipscan.py"), str(png)],
                               capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)


class TheHistorySweepUsesTheSameRulesAsTheTreeSweep(unittest.TestCase):
    """CI's "No credentials anywhere in history" job was permanently red.

    A blob arrives on stdin with no path, so ``--stdin`` hard-coded
    ``allow_fixtures=False`` and judged every historical version of a file by
    stricter rules than the current one. A synthetic Proxmox token in an older
    ``tests/test_setup_api.py`` failed the job on every push. A gate that is
    always red is a gate that gets switched off, so the sweep now receives the
    path the blob was committed at.
    """

    SCAN = ROOT / ".github" / "secretscan.py"
    FAKE = 'PVE_TOKEN = "admin@pam!prod=9f3c1a2b-44de-4c77-9b10-7a2e5d6f8c91"\n'

    def run_scan(self, *args):
        return subprocess.run([sys.executable, str(self.SCAN), "--stdin", *args],
                              input=self.FAKE, capture_output=True, text=True)

    def test_a_blob_from_a_non_exempt_path_is_still_flagged(self):
        r = self.run_scan("--allow-path", "pollers.py")
        self.assertEqual(r.returncode, 1, "a credential in a real module must still fail")

    def test_a_blob_with_no_path_given_is_still_judged_strictly(self):
        self.assertEqual(self.run_scan().returncode, 1)

    def test_a_blob_from_an_exempt_path_matches_the_tree_scan(self):
        r = self.run_scan("--allow-path", "tests/test_setup_api.py")
        self.assertEqual(r.returncode, 0, "history is stricter than the working tree again")

    def test_the_whole_history_of_this_repository_is_clean(self):
        """What a clone actually hands over, not just what HEAD shows.

        In-process rather than a subprocess per blob: the CI job shells out
        because it is a shell loop, but spawning Python a few hundred times
        here would dominate the suite.
        """
        spec = importlib.util.spec_from_file_location("secretscan", self.SCAN)
        secretscan = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(secretscan)

        listing = subprocess.run(["git", "rev-list", "--objects", "--all"], cwd=ROOT,
                                 capture_output=True, text=True, check=True).stdout.splitlines()
        pairs = [ln.split(maxsplit=1) for ln in listing]
        pairs = [p for p in pairs if len(p) == 2]
        kinds = subprocess.run(["git", "cat-file", "--batch-check=%(objectname) %(objecttype)"],
                               cwd=ROOT, input="\n".join(p[0] for p in pairs),
                               capture_output=True, text=True).stdout.split()
        blobs = {kinds[i] for i in range(0, len(kinds) - 1, 2) if kinds[i + 1] == "blob"}

        hits, checked = [], 0
        for sha, path in pairs:
            if sha not in blobs:
                continue
            raw = subprocess.run(["git", "cat-file", "-p", sha], cwd=ROOT, capture_output=True).stdout
            if b"\0" in raw[:4096] or len(raw) > 2_000_000:
                continue
            checked += 1
            hits += secretscan.scan_text(raw.decode("utf-8", "replace"), f"blob {sha} ({path})",
                                         bool(secretscan.ALLOW_PATH.search(path)))
        self.assertGreater(checked, 50, "history sweep found almost no blobs; it is broken")
        self.assertEqual(hits, [], f"credential shapes in repository history: {hits[:5]}")

    def test_the_workflow_passes_the_path_through(self):
        ci = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
        self.assertIn("--allow-path", ci, "the history job would go red again")


if __name__ == "__main__":
    unittest.main()
