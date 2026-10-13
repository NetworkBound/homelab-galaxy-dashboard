/* universe_layout.js -- canonical, deterministic placement for /api/universe bodies.
 *
 * Shared by BOTH screens (wall + desk). Pure math, no dependencies, no DOM, no
 * randomness, no time. Same input -> bit-identical output on every page.
 * Attaches window.UNIVERSE_LAYOUT (and module.exports under node, for tests).
 *
 * CONTRACT
 *   hash32(str) -> uint32
 *       FNV-1a 32-bit over the UTF-8 bytes of str. The server computes body.seed
 *       and system.seed with the identical function (universe.py:hash32), so
 *       hash32(body.id) === body.seed.
 *
 *   shellOf(cls) -> int
 *       Canonical shell (ring) index for a device class (contracts 1a). The
 *       server assigns body.shell from the same table when a body is first seen;
 *       afterwards body.shell is persisted and authoritative -- always place by
 *       body.shell, never by shellOf(body.class).
 *
 *   capacities(bodies) -> { "<system id|''>": { "<shell>": cap } }
 *       cap = max(slot)+1 per (system, shell). Edge bodies (system null) are
 *       keyed by ''. The server also ships this as systems[i].shells, and the
 *       two are equal by construction; either may be used.
 *
 *   geometry(shellCaps) -> { "<shell>": { r0, r1 } }
 *       Annulus for every shell with cap > 0, walking shells in ascending
 *       numeric order outward from CORE_R. Width grows smoothly with cap
 *       (annulus area ~ cap * SPACING^2), never below MIN_W. Shells with cap 0
 *       take no room. A shell growing pushes outer shells out smoothly; it
 *       never reorders anything. (Lerp radii on the front end if desired.)
 *
 *   quantizeCaps(shellCaps) -> { "<shell>": qcap }
 *       Rounds every cap up to a step with headroom so radii only change when a
 *       shell crosses a step (rare):  q(0) = 0;  q(c) = 8 * ceil((c + max(3, ceil(c/4))) / 8).
 *       CALLERS SHOULD USE  geometry(quantizeCaps(system.shells))  so a new device
 *       in an inner shell leaves every other body's coordinates byte-identical
 *       unless its shell crosses a step. Both screens must use the same call.
 *
 *   place(body, geom) -> { r, theta, x, y, z, phase, scale }
 *       body needs {system, shell, slot, seed}. System-local coordinates, units
 *       where the system core has radius ~1; x/z is the disc plane, y is up.
 *       theta is radians in [0, 2pi) measured from +x toward +z.
 *       Slot n position comes from the R2 low-discrepancy sequence
 *       (plastic number), so ANY count looks evenly filled across the annulus
 *       and adding slot n+1 never moves slots 0..n (except the smooth radius
 *       scaling from geometry()). Shell 0 slot 0 sits exactly at the centre
 *       (the system's hub). Small per-body jitter/phase/scale come from seed.
 *       phase: initial spin phase in radians. scale: size multiplier ~0.9..1.1.
 *       Bodies with system null (class edge) get universe-level coordinates on
 *       a ring of radius EDGE_R (+ annulus), outside every system.
 *
 *   systemCenter(systemSlot) -> { x, z }
 *       Suggested universe-level centre for systems[i].slot (golden spiral,
 *       append-only like bodies). Optional; a screen may compose its own.
 *
 *   colourFor(body, manifestClass) -> "#rrggbb"
 *       manifestClass = manifest.classes[body.class] (may be null). Base colour
 *       is manifestClass.tint, else CLASS_TINTS[class]. Hue +-6deg and
 *       lightness +-5% from seed so siblings are distinguishable; status down
 *       -> desaturated + dimmed, unknown -> partly desaturated.
 *   colourRGB(body, manifestClass) -> [r, g, b] floats 0..1 (same colour).
 */
(function (root) {
  "use strict";

  var TAU = Math.PI * 2;
  var A1 = 0.7548776662466927;   // 1/g,  g = plastic number 1.3247179572447...
  var A2 = 0.5698402909980532;   // 1/g^2
  var GOLDEN = 2.399963229728653; // golden angle, used for system spiral

  var CORE_R = 1.2;    // first annulus starts here (hub sits inside it)
  var SPACING = 0.55;  // nominal distance between neighbouring bodies
  var MIN_W = 0.5;     // thinnest annulus
  var GAP = 0.45;      // empty band between consecutive shells
  var JITTER = 0.18;   // fraction of SPACING
  var EDGE_R = 60.0;   // universe-level radius for system-less (edge) bodies
  var SYS_SPACING = 16.0;

  var SHELL_OF_CLASS = {
    pve_host: 0, gateway: 0,
    "switch": 1, ap: 1, network_device: 1, edge: 1,
    server: 2, storage: 2,
    guest_lxc: 3,
    guest_vm: 4,
    computer: 5, game_console: 5,
    phone: 6, tablet: 6,
    tv_av: 7,
    iot: 8,
    appliance: 9,
    printer: 10,
    camera: 11,
    unknown: 12
  };

  var CLASS_TINTS = {
    pve_host: "#38e1ff", guest_vm: "#5fa8ff", guest_lxc: "#4fd1c5",
    gateway: "#ffb347", "switch": "#ffd166", ap: "#f6e05e",
    server: "#90cdf4", storage: "#b794f4", computer: "#63b3ed",
    phone: "#9b8cff", tablet: "#b39dff", tv_av: "#f687b3", iot: "#68d391",
    appliance: "#a0aec0", camera: "#fc8181", printer: "#f6ad55",
    game_console: "#ed64a6", network_device: "#fbd38d", edge: "#e2e8f0",
    unknown: "#9aa4b2"
  };

  function hash32(str) {
    var s = String(str), h = 0x811c9dc5, i, c;
    function eat(b) { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; }
    for (i = 0; i < s.length; i++) {
      c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {     // surrogate pair
        var d = s.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
      }
      if (c < 0x80) eat(c);
      else if (c < 0x800) { eat(0xc0 | (c >> 6)); eat(0x80 | (c & 63)); }
      else if (c < 0x10000) { eat(0xe0 | (c >> 12)); eat(0x80 | ((c >> 6) & 63)); eat(0x80 | (c & 63)); }
      else { eat(0xf0 | (c >> 18)); eat(0x80 | ((c >> 12) & 63)); eat(0x80 | ((c >> 6) & 63)); eat(0x80 | (c & 63)); }
    }
    return h >>> 0;
  }

  function frac(v) { return v - Math.floor(v); }

  function shellOf(cls) {
    return Object.prototype.hasOwnProperty.call(SHELL_OF_CLASS, cls) ? SHELL_OF_CLASS[cls] : SHELL_OF_CLASS.unknown;
  }

  function capacities(bodies) {
    var out = {}, i, b, k, s;
    for (i = 0; i < (bodies || []).length; i++) {
      b = bodies[i];
      if (b == null || b.slot == null || b.shell == null) continue;
      k = b.system == null ? "" : String(b.system);
      s = String(b.shell);
      if (!out[k]) out[k] = {};
      if (!(out[k][s] >= b.slot + 1)) out[k][s] = b.slot + 1;
    }
    return out;
  }

  function quantizeCaps(shellCaps) {
    var out = {}, k, c;
    for (k in (shellCaps || {})) {
      if (!Object.prototype.hasOwnProperty.call(shellCaps, k)) continue;
      c = +shellCaps[k] || 0;
      out[k] = c <= 0 ? 0 : 8 * Math.ceil((c + Math.max(3, Math.ceil(c / 4))) / 8);
    }
    return out;
  }

  function geometry(shellCaps) {
    var keys = Object.keys(shellCaps || {}).map(Number).filter(function (k) {
      return isFinite(k) && shellCaps[k] > 0;
    }).sort(function (a, b) { return a - b; });
    var out = {}, r = CORE_R, i, n, w, r0;
    for (i = 0; i < keys.length; i++) {
      n = shellCaps[keys[i]];
      r0 = (i === 0) ? r : r + GAP;
      w = Math.max(MIN_W, Math.sqrt(r0 * r0 + n * SPACING * SPACING / Math.PI) - r0);
      out[keys[i]] = { r0: r0, r1: r0 + w };
      r = r0 + w;
    }
    return out;
  }

  function place(body, geom) {
    var seed = (body.seed >>> 0), n = body.slot | 0, shell = body.shell | 0;
    var g = geom && geom[shell];
    var j1 = ((seed & 0xffff) / 65535) - 0.5;
    var j2 = (((seed >>> 16) & 0xffff) / 65535) - 0.5;
    var phase = TAU * (((seed >>> 8) & 0xffff) / 65536);
    var scale = 1 + ((((seed >>> 24) & 0xff) / 255) - 0.5) * 0.2;
    var r, theta, y, r0, r1;
    if (body.system == null) {               // edge: universe-level ring
      r0 = EDGE_R; r1 = EDGE_R + (g ? (g.r1 - g.r0) : MIN_W);
    } else if (!g) {
      r0 = CORE_R; r1 = CORE_R + MIN_W;      // geometry missing this shell: still deterministic
    } else { r0 = g.r0; r1 = g.r1; }
    if (body.system != null && shell === 0 && n === 0) {
      return { r: 0, theta: 0, x: 0, y: 0, z: 0, phase: phase, scale: scale };
    }
    var rot = TAU * (hash32(String(body.system) + "#" + shell) / 4294967296);
    theta = frac(0.5 + n * A1) * TAU + rot;
    var u = frac(0.5 + n * A2);
    r = Math.sqrt(r0 * r0 + u * (r1 * r1 - r0 * r0));
    r += j1 * JITTER * SPACING;
    theta += (j2 * JITTER * SPACING) / Math.max(r, 0.5);
    theta = frac(theta / TAU) * TAU;
    y = ((((seed >>> 4) & 0xff) / 255) - 0.5) * 0.12 * (r1 - r0);
    return { r: r, theta: theta, x: r * Math.cos(theta), y: y, z: r * Math.sin(theta),
             phase: phase, scale: scale };
  }

  function systemCenter(slot) {
    var n = slot | 0;
    if (n === 0) return { x: 0, z: 0 };
    var r = SYS_SPACING * Math.sqrt(n), t = n * GOLDEN;
    return { x: r * Math.cos(t), z: r * Math.sin(t) };
  }

  function hexToRgb(h) {
    h = String(h || "").replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var v = parseInt(h, 16);
    if (h.length !== 6 || !isFinite(v)) v = 0x9aa4b2;
    return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
  }
  function rgbToHsl(c) {
    var r = c[0], g = c[1], b = c[2], mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    var l = (mx + mn) / 2, h = 0, s = 0, d = mx - mn;
    if (d > 1e-9) {
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    return [h, s, l];
  }
  function hslToRgb(h, s, l) {
    function f(p, q, t) {
      t = frac(t);
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    }
    if (s <= 0) return [l, l, l];
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    return [f(p, q, h + 1 / 3), f(p, q, h), f(p, q, h - 1 / 3)];
  }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  function colourRGB(body, manifestClass) {
    var base = (manifestClass && manifestClass.tint) || CLASS_TINTS[body && body["class"]] || CLASS_TINTS.unknown;
    var hsl = rgbToHsl(hexToRgb(base));
    var seed = (body && body.seed) >>> 0;
    var h = hsl[0] + ((((seed >>> 12) & 0xff) / 255) - 0.5) * (12 / 360);
    var s = hsl[1], l = hsl[2] + ((((seed >>> 20) & 0xff) / 255) - 0.5) * 0.10;
    var st = body && body.status;
    if (st === "down") { s *= 0.25; l *= 0.6; }
    else if (st === "unknown") { s *= 0.6; }
    return hslToRgb(frac(h), clamp01(s), clamp01(l));
  }
  function colourFor(body, manifestClass) {
    var c = colourRGB(body, manifestClass), out = "#", i, v;
    for (i = 0; i < 3; i++) { v = Math.round(clamp01(c[i]) * 255).toString(16); out += v.length < 2 ? "0" + v : v; }
    return out;
  }

  var api = {
    version: 1,
    hash32: hash32, shellOf: shellOf, capacities: capacities, geometry: geometry, quantizeCaps: quantizeCaps,
    place: place, systemCenter: systemCenter, colourFor: colourFor, colourRGB: colourRGB,
    SHELL_OF_CLASS: SHELL_OF_CLASS, CLASS_TINTS: CLASS_TINTS,
    CONST: { CORE_R: CORE_R, SPACING: SPACING, MIN_W: MIN_W, GAP: GAP, JITTER: JITTER,
             EDGE_R: EDGE_R, SYS_SPACING: SYS_SPACING, A1: A1, A2: A2 }
  };
  root.UNIVERSE_LAYOUT = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
