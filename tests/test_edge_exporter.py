"""deploy/edge/galaxy-audience-export.py turns an nginx log into wall text.

Two of the fields it reads are whatever the client said they were. ``$host`` is
the Host header, and ``$http_cf_ipcountry`` is an ordinary request header that
only means anything when the request really arrived through Cloudflare — and
the whole reason this exporter exists is the install that has *no* Cloudflare
token and reads its own origin log, where anyone who can reach the origin
directly supplies it.

Both strings were copied verbatim into audience.json, which the dashboard
fetches and the wall renders. The front end escapes them today, so this was not
an exploitable injection when it was found — but "is safe because of what some
other file does with it" is not a property an exporter should rely on, and a
country column that can be filled with 12 rows of junk is a broken panel
whatever the renderer does.

So the exporter now decides what a country code and a hostname are.
"""
import importlib.util
import json
import pathlib
import tempfile
import time
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location(
    "galaxy_audience_export", ROOT / "deploy" / "edge" / "galaxy-audience-export.py")
exporter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(exporter)


class FieldsTheClientControlsAreConstrained(unittest.TestCase):
    def test_a_country_is_two_letters_or_unknown(self):
        self.assertEqual(exporter._country("us"), "US")
        self.assertEqual(exporter._country("GB"), "GB")
        for junk in ("<script>alert(1)</script>", "-", "", "USA", "U", "../../etc/passwd",
                     "A" * 400, "U S"):
            with self.subTest(junk=junk):
                self.assertEqual(exporter._country(junk), "??")

    def test_a_host_is_a_hostname_or_flagged(self):
        self.assertEqual(exporter._host("Dash.Example.COM"), "dash.example.com")
        self.assertEqual(exporter._host("a-b.example.com"), "a-b.example.com")
        for junk in ("<img src=x onerror=alert(1)>", "", "-", "example.com/../x",
                     "a" * 300, 'ex"ample.com', "exam ple.com"):
            with self.subTest(junk=junk):
                self.assertEqual(exporter._host(junk), "(invalid)")

    def test_no_field_in_the_output_carries_a_markup_character(self):
        """End to end, from a log line a stranger could cause to be written."""
        now = time.time()
        with tempfile.TemporaryDirectory() as td:
            log = pathlib.Path(td) / "galaxy.log"
            out = pathlib.Path(td) / "audience.json"
            # Real routable addresses: _public() rejects the RFC5737
            # documentation ranges too, so 203.0.113.x would never be counted.
            log.write_text(
                f'{now:.3f} 8.8.8.8 <script>x</script> <img/onerror=1> 200 "Mozilla/5.0"\n'
                f'{now:.3f} 1.1.1.1 gb dash.example.com 200 "Mozilla/5.0"\n',
                encoding="utf-8")
            exporter.LOG, exporter.OUT = str(log), str(out)
            exporter.main()
            data = json.loads(out.read_text(encoding="utf-8"))

        blob = json.dumps(data)
        for ch in ("<", ">", "onerror", "script"):
            self.assertNotIn(ch, blob, f"{ch!r} survived into audience.json")
        self.assertEqual(sorted(c["cc"] for c in data["by_country"]), ["??", "GB"])
        self.assertEqual(sorted(h["host"] for h in data["by_host"]), ["(invalid)", "dash.example.com"])
        self.assertEqual(data["viewers_5m"], 2)

    def test_private_clients_are_still_ignored_entirely(self):
        now = time.time()
        with tempfile.TemporaryDirectory() as td:
            log = pathlib.Path(td) / "galaxy.log"
            out = pathlib.Path(td) / "audience.json"
            log.write_text(f'{now:.3f} 10.0.0.9 gb dash.example.com 200 "Mozilla/5.0"\n', encoding="utf-8")
            exporter.LOG, exporter.OUT = str(log), str(out)
            exporter.main()
            data = json.loads(out.read_text(encoding="utf-8"))
        self.assertEqual(data["viewers_1h"], 0)
        self.assertEqual(data["by_country"], [])


class TheCrowdsecExporterFailsLoudly(unittest.TestCase):
    SH = ROOT / "deploy" / "edge" / "galaxy-cs-export.sh"

    def test_it_has_errexit(self):
        self.assertIn("set -euo pipefail", self.SH.read_text(encoding="utf-8"),
                      "a half-written export directory should stop the script, not be published")

    def test_it_creates_its_directory_with_an_explicit_mode(self):
        self.assertIn("mkdir -p -m 0755", self.SH.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
