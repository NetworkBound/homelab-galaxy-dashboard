"""The documented deploy path has to produce something that starts.

``sudo ./deploy/install.sh`` copied the application to ``/opt`` from a
hand-written list of filenames. ``auth.py`` was added to the application and
not to that list, so a fresh install produced a tree whose ``app.py`` begins
``import auth`` with no ``auth.py`` beside it: ``ModuleNotFoundError`` at
startup, ``Restart=always`` in the unit, and a crash loop that never serves a
page. Nothing in the suite or in CI looked at that list, because CI tests the
*source* tree and the list only matters to the *installed* one.

So these tests read install.sh and reproduce what it copies, rather than
trusting it. Running the real thing needs root; reproducing its file selection
does not, and that is where the bug was.
"""
import ast
import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
INSTALL_SH = ROOT / "deploy" / "install.sh"
UNIT = ROOT / "deploy" / "homelab-dashboard.service"


def local_imports(py_path):
    """The modules ``py_path`` imports that are plain .py files next to it."""
    tree = ast.parse(py_path.read_text(encoding="utf-8"))
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names |= {a.name.split(".")[0] for a in node.names}
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            names.add(node.module.split(".")[0])
    return {n for n in names if (py_path.parent / f"{n}.py").is_file()}


def installed_names():
    """What install.sh puts in ${INSTALL_DIR}, worked out from the script itself."""
    text = INSTALL_SH.read_text(encoding="utf-8")
    names = set()
    # The glob form: `for item in "${SRC_DIR}"/*.py`
    if re.search(r'for item in "\$\{SRC_DIR\}"/\*\.py', text):
        names |= {p.name for p in ROOT.glob("*.py")}
    # Any remaining literal `for item in a b c; do` list.
    for m in re.finditer(r"for item in ((?:[\w./${}\\\s-]|\n)+?); do", text):
        for word in m.group(1).split():
            if word.startswith(("$", '"$', "\\")):
                continue
            if (ROOT / word).exists():
                names.add(word)
    return names


class TheInstallerShipsEveryModuleTheAppImports(unittest.TestCase):
    def test_app_pys_local_imports_are_all_installed(self):
        shipped = installed_names()
        self.assertIn("app.py", shipped, "install.sh does not appear to copy app.py; parser is stale")
        missing = sorted(f"{m}.py" for m in local_imports(ROOT / "app.py") if f"{m}.py" not in shipped)
        self.assertEqual(missing, [], f"install.sh would produce a tree that cannot import: {missing}")

    def test_auth_py_specifically(self):
        """The one that actually shipped broken, named so the regression is obvious."""
        self.assertIn("auth.py", installed_names(),
                      "auth.py is not installed: the gate would be absent and app.py would not import")

    def test_the_second_level_imports_are_installed_too(self):
        """app.py importing demo.py is no good if demo.py imports something absent."""
        shipped = installed_names()
        missing = []
        for mod in sorted(local_imports(ROOT / "app.py")):
            for dep in sorted(local_imports(ROOT / f"{mod}.py")):
                if f"{dep}.py" not in shipped:
                    missing.append(f"{dep}.py (needed by {mod}.py)")
        self.assertEqual(missing, [], f"install.sh would produce a tree that cannot import: {missing}")

    def test_the_installer_checks_this_for_itself(self):
        """Belt and braces: the script refuses to finish a broken copy."""
        text = INSTALL_SH.read_text(encoding="utf-8")
        self.assertIn("app.py imports modules that were not installed", text,
                      "install.sh no longer verifies its own copy")


class TheUnitAndTheInstallerAgree(unittest.TestCase):
    def test_execstart_points_at_what_the_installer_builds(self):
        unit = UNIT.read_text(encoding="utf-8")
        self.assertIn("/opt/homelab-galaxy-dashboard/.venv/bin/python app.py", unit)
        self.assertIn('INSTALL_DIR="/opt/${APP_NAME}"', INSTALL_SH.read_text(encoding="utf-8"))

    def test_the_env_file_is_not_described_as_a_mode_it_is_not_given(self):
        """The unit used to claim 0600 while install.sh wrote 0640."""
        unit = UNIT.read_text(encoding="utf-8")
        install = INSTALL_SH.read_text(encoding="utf-8")
        claimed = set(re.findall(r"mode (0[0-7]{3})", unit))
        actual = set(re.findall(r'chmod (0[0-7]{3}) "\$\{CONFIG_DIR\}/env"', install))
        self.assertTrue(actual, "install.sh no longer chmods the env file")
        for c in claimed:
            self.assertIn(c, actual, f"the unit says mode {c}, install.sh sets {sorted(actual)}")

    def test_the_env_file_is_never_created_world_readable(self):
        """install(1) with an explicit mode, not cp-then-chmod."""
        install = INSTALL_SH.read_text(encoding="utf-8")
        self.assertNotRegex(install, r'cp "\$\{SRC_DIR\}/\.env\.example" "\$\{CONFIG_DIR\}/env"',
                            "cp leaves the file at the umask default until the later chmod")
        self.assertRegex(install, r'install -o root -g "\$\{APP_USER\}" -m 06[04]0 '
                                  r'"\$\{SRC_DIR\}/\.env\.example"')


class TheKioskDoesNotHandOutTheBrowser(unittest.TestCase):
    """deploy/kiosk/ runs a browser on a wall; it should not run one wide open."""

    XINITRC = ROOT / "deploy" / "kiosk" / "xinitrc.example"

    @property
    def code(self):
        """The script with comment lines removed — prose may discuss a flag."""
        return "\n".join(ln for ln in self.XINITRC.read_text(encoding="utf-8").splitlines()
                          if not ln.lstrip().startswith("#"))

    def test_the_devtools_origin_check_is_not_disabled(self):
        self.assertNotIn("--remote-allow-origins", self.code,
                         "any page the kiosk browser loads could then drive the whole browser")

    def test_remote_debugging_is_opt_in_and_loopback_only(self):
        code = self.code
        self.assertIsNone(re.search(r"^\s*(?:DISPLAY=\S+ )?chromium .*--remote-debugging-port", code, re.M),
                          "DevTools should only be on when KIOSK_DEBUG_PORT asks for it")
        self.assertIn("KIOSK_DEBUG_PORT", code)
        for line in code.splitlines():
            if "--remote-debugging-port" in line:
                self.assertIn("--remote-debugging-address=127.0.0.1", line,
                              "a debugging port must be bound to loopback")

    def test_the_readiness_probe_survives_a_dashboard_key(self):
        """`curl -f` against a gated `/` spins forever: 401 is still 'serving'."""
        code = self.code
        self.assertNotRegex(code, r"(?m)^until curl -fsS", "curl -f treats the gate's 401 as 'not up yet'")
        self.assertIn("%{http_code}", code)


if __name__ == "__main__":
    unittest.main()
