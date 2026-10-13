/* nexus.js — the 4K "big screen": the estate as a galaxy cluster, from orbit.
 *
 * Companion to the wall (index.html), not a copy of it. The wall is a dense
 * console you stand in front of; this is the thing you see across the room and
 * on camera. Everything drawn is measured:
 *   - ONE SPIRAL GALAXY PER CONFIGURED PROXMOX NODE (window.CONFIG.nodes[] —
 *     any number, not two): every guest is a star on an arm (size ~ RAM,
 *     brightness ~ CPU, colour = category, red = stopped); the core's size
 *     follows the node's memory in use, its spin the CPU load; the disc takes
 *     that node's configured accent colour. Node 0 sits at x=-400 and node 1
 *     at x=+400; further nodes alternate outward in 500-unit steps (galaxyX).
 *   - the bridge between the first two carries comets for the measured
 *     inter-node flows (NFS etc.) — count and speed follow bps.
 *   - the far sun is the WAN edge, captioned "<CONFIG.wan_label> · WAN"; a
 *     solar system sits between sun and estate: gateway close to the sun,
 *     switch + AP further out, client moons orbiting whichever of the three
 *     they're attached to (one shared Points pool). One uplink guide line per
 *     node carries comets from the gateway to that galaxy's core when topology
 *     reports measured bps on that link.
 *   - THE EDGE: a third, violet galaxy standing for the outside world, beyond
 *     and above the WAN sun. Its stars are measured (tunnel PoPs + visitor
 *     countries). It is NEVER in CONFIG.nodes and nothing that iterates the
 *     nodes sees it.
 *   - AUDIENCE: the viewer countries are labelled bodies on THE EDGE sized by
 *     their unique visitors (leader lines to their labels), a gold headline
 *     under the status block, an arrival flare + shockwave + a rate-limited
 *     camera crane captioned NEW VIEWER · CC, and a dedicated `audience` stop
 *     and showcase chapter. Only edge.audience is ever called people; tunnel
 *     request counters say "requests".
 *   - the room's other screen: /api/lightstate(/stream) is what the wall
 *     publishes for the lights + its tour position. The director here follows
 *     it in lockstep (same smootherstep ease, driven by the wall's own prog),
 *     so when the wall arrives at a stop this arrives too, in the same beat.
 *     When the wall is quiet/manual it free-roams every stop on its own cycle.
 *     body.st-showcase (key 2, or local key 'p' / NEXUS.play()) swaps the
 *     director for a ~3-minute flythrough of the whole estate.
 *   - modes (showtime.js body classes) and the shared /api/pulse/stream beat.
 *
 * Reads:  window.CONFIG  nodes[] (id/label/accent), palette{}, categories[],
 *                        brand, wan_label, features.cameras
 *         /api/all       nodes, guests, pools, unifi, zabbix, telemetry, edge
 *         /api/topology  nodes, links, flows, totals, external, edge
 *         /api/showtime, /api/gpu, /api/threats(/stream), /api/lightstate(/stream),
 *         /api/pulse/stream
 *
 * Budget: fixed pools everywhere (guest stars, comets, client moons, the 200
 * label pool), per-frame DOM limited to label transform/opacity/className —
 * and only written when the value actually changed — 60 fps at 3840x2160.
 * Keys: 1-5 modes (showtime.js), space = free-roam next, p = toggle the
 * showcase flythrough locally.
 */
(function () {
  'use strict';
  /* ---- identity: everything site-specific arrives on window.CONFIG ----
     (docs/contracts.md). config.js has already fetched /api/config and
     normalised it before this file is loaded, so this is a plain read. */
  var C = window.CONFIG || {};
  function esc(x) { return String(x == null ? '' : x).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  var CAT = {}, CATS = (C.categories && C.categories.length ? C.categories.slice()
                        : ['ai', 'media', 'network', 'monitor', 'web', 'infra']);
  CATS.forEach(function (k) { CAT[k] = C.catHex ? C.catHex(k) : 0x8fb0d0; });
  var WAN_LABEL = String(C.wan_label || 'ISP');
  /* GAL_K: the host galaxies are drawn 1.3x larger in the world - the wide shots read them as THE subject and their
     arms and haze fill the frame between the HUD cards (every shot that frames a galaxy scales with nd.scale, so a
     host stop frames it the same way) */
  var GAL_K = 1.3;
  /* The first two configured Proxmox nodes are the pair every shot in this file was composed against: node 0 at
     x=-400 wears the blue-white plate, node 1 at x=+400 the golden one (with its edge-on variant). A single node sits
     at the origin. Every further node (configured or discovered) is a GROWTH galaxy: ensureGalaxies() gives it the
     next free seat of an append-only back row the moment /api/universe lists its system, so adding a node never
     moves an existing one. */
  var CFG_NODES = (C.nodes && C.nodes.length) ? C.nodes : [{ id: 'pve', label: 'PVE', accent: '#5ad7ff', index: 0 }];
  var NODES = CFG_NODES.slice(0, 2).map(function (n, i, arr) {
    return { id: n.id, label: String(n.label || n.id).toUpperCase(), name: String(n.label || n.id),
             accent: C.hex ? C.hex(n.accent) : 0x5ad7ff, x: arr.length < 2 ? 0 : (i === 0 ? -400 : 400),
             spin: i === 0 ? 1 : -1, disc: 'galaxy_nb.png', discFlip: i === 0, discRot: i === 0 ? 2.3 : 0,
             scale: GAL_K, index: i };
  });
  var N_NODES = NODES.length;
  var NODE_BY_ID = {}; CFG_NODES.forEach(function (n) { NODE_BY_ID[n.id] = n; });
  var NA = NODES[0], NB = NODES[1] || NODES[0];          // the composed pair (the same node twice on a one-node estate)
  /* the node whose galaxy gets a stop per guest category (CONFIG.featured_node: the server's pick, by default the
     node with the most guests) */
  var FEATURED = C.featured_node && NODE_BY_ID[C.featured_node] ? C.featured_node : NB.id;
  function nodeSys(id) { return 'sys:' + id; }
  // the sun sits left/down along the view depth so it projects at ~(1230, 250) of 1920x1080 in the overview, clear of
  // the header text, the right-hand galaxy and card. Every sun-relative shot/route/station follows automatically.
  var SUN = new THREE.Vector3(583, 22, -1634);
  /* network hub (gateway). 2026-10-04 composition: the overview frames the two host galaxies; the network system sits
     centre-low between the two galaxies, under the bridge (it owns the gap between them), and the remote-site systems
     sit below each galaxy, left and right of the stop caption. Positions were solved by projecting every body through
     overviewShot() at 16:9 so no two regions overlap, nothing touches the frame edge or the HUD (offline). */
  var NET_C = new THREE.Vector3(0, -120, 0);
  /* 2026-09-19 UNIVERSE: THE EDGE - a third, violet galaxy (Cloudflare's edge) beyond and above the WAN
     sun. A backdrop body: deliberately NOT part of overviewBounds()/overviewShot() - from the OVERVIEW it
     sits top-right behind the sun; WAN EDGE looks between sun and EDGE core; THE EDGE (new stop/chapter)
     frames it with the sun in the foreground. Its stars are measured (Cloudflare PoPs + viewer countries). */
  var EDGE_POS = new THREE.Vector3(2000, 420, -2750), EDGE_SCALE = 2.2, EDGE_ACC = 0xb48cff, EDGE_HOT = 0xf6821f;
  var THREAT_COL = { 0: '#37f5a0', 1: '#ffb347', 2: '#ff5a6a', 3: '#ff2d55' };
  // QA bisect switches (localStorage.nxflags = 'nosky,nodisc,notex,norocket,nothreat'); none set in production
  var NXF = {}; try { String(window.NX_FLAGS || localStorage.getItem('nxflags') || '').split(',').forEach(function (f) { if (f) NXF[f.trim()] = 1; }); } catch (e) { }
  var $ = function (id) { return document.getElementById(id); };
  var U_TIME = { value: 0 };
  /* HUD keep-out (2026-10-04 review): long comet streams and route/link lines crossed the header text, the node cards
     and the stop caption. hudFade(ndc) -> 0..1 fades anything drawn under those bands (soft 4% edges). Off in the
     showcase, where that chrome is hidden. Bands match labelsTick: top 19% (header), cards x<23%/x>77% for
     36-66% height, caption bottom 19% across the middle. */
  var U_HUD = { value: 1 };
  /* 2026-10-08 production chrome (§7a): the HUD is a thin top strip (clock, alert), the estate status panel top-right,
     two 280 px node cards at mid-height and a two-line caption at the bottom. HUDZ is the ONE description of those
     keep-out zones (fractions of the CSS viewport); labelsTick, hudFadeAt() and HUD_GLSL below all read it. */
  var HUDZ = { top: 0.075, bot: 0.885, cardX: 0.165, cardY0: 0.40, cardY1: 0.60, statX: 0.835, statY: 0.17, capX: 0.26 };
  var HUD_GLSL = [
    'uniform float uHud;',
    'float hudFade(vec2 n){ if (uHud < 0.5) return 1.0;',
    '  float top = 1.0 - smoothstep(0.80, 0.88, n.y);',
    '  float corner = 1.0 - smoothstep(0.62, 0.68, n.x) * smoothstep(0.60, 0.68, n.y);',
    '  float card = 1.0 - smoothstep(0.62, 0.68, abs(n.x)) * (1.0 - smoothstep(0.18, 0.24, abs(n.y)));',
    '  float cap = 1.0 - smoothstep(0.70, 0.78, -n.y) * (1.0 - smoothstep(0.22, 0.28, abs(n.x)));',
    '  return clamp(top * corner * card * cap, 0.0, 1.0); }'
  ].join('\n');            // shared clock uniform (declared first: the starfield below uses it before pointsMat is defined)
  var clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; };
  var lerp = function (a, b, t) { return a + (b - a) * t; };
  var smooth = function (t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
  var smootherstep = function (t) { t = clamp(t, 0, 1); return t * t * t * (t * (t * 6 - 15) + 10); };   // same curve the wall eases its travel with
  var nearFactor = function (dist, n, f) { return clamp((f - dist) / (f - n), 0, 1); };                  // 0 far away, 1 once closer than n — feeds coreFS's brightness damping
  var plural = function (n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); };                           // "1 guest" vs "3 guests", everywhere a live count is spoken
  function hash(s) { s = String(s); var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967295; }
  function fmtBps(b) { b = +b || 0; return b >= 1e9 ? (b / 1e9).toFixed(2) + ' Gb/s' : b >= 1e6 ? (b / 1e6).toFixed(1) + ' Mb/s' : b >= 1e3 ? (b / 1e3).toFixed(0) + ' kb/s' : b.toFixed(0) + ' b/s'; }
  function fmtGB(b) { return (b / 1073741824).toFixed(0); }
  // three significant digits, units always (research §5): 177 Mb/s, 40.7 Mb/s, 4.6 Mb/s, 502 kb/s
  function fmtRate(b) { b = +b || 0; var u = b >= 1e9 ? [1e9, ' Gb/s'] : b >= 1e6 ? [1e6, ' Mb/s'] : b >= 1e3 ? [1e3, ' kb/s'] : [1, ' b/s']; return parseFloat((b / u[0]).toPrecision(3)) + u[1]; }
  function normBps(b) { b = Math.max(0, +b || 0); return clamp((Math.log10(b + 1) - 3) / 4.5, 0, 1); }   // 1 kb/s .. ~30 Mb/s -> 0..1
  /* ---- names: every on-screen name is SHORT and one line. `short` from /api/universe wins (the server's rules plus
     the operator's universe_names.json); for a body without one a generic trim runs here ("USW Pro Max 24" -> "USW 24",
     a "-a1b2" serial tail dropped). An IP- or MAC-only name has no short form: such a body is not labelled in the scene
     at all (its address is in the detail card). */
  function isAddr(s) { return /^\d{1,3}(\.\d{1,3}){3}$/.test(s) || /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(s); }
  function clip(s, max) { s = String(s || ''); return s.length > max ? s.slice(0, max - 1) + '…' : s; }
  function shortText(s, max) {
    s = String(s || '').trim(); if (!s) return '';
    if (isAddr(s)) return '';
    var t = s.replace(/\s*\([^)]*\)$/, '')
             .replace(/\s+(switch|router|access point)$/i, '')
             .replace(/^TP-?Link\s+Deco\s+(Node\s+)?/i, 'Deco ')
             .replace(/^(USW|USL|USP)\s+((Pro|Lite|Max|Enterprise|Ultra|Flex)\s+)*(\d+)\b.*$/i, '$1 $4')
             .replace(/^(.{3,}?)[-_][0-9a-f]{4,6}$/i, '$1');
    return clip(t || s, max || 16);
  }
  function shortName(b) { return b ? (b.short ? clip(b.short, 18) : shortText(b.label || '')) : ''; }
  var CAT_NAME = {}; CATS.forEach(function (k) { CAT_NAME[k] = ({ ai: 'AI', media: 'Media', network: 'Network', monitor: 'Monitoring', web: 'Web', infra: 'Infra' })[k] || (C.catName ? C.catName(k) : k); });
  // product copy for a wall name that arrives in ALL CAPS ("HOME · 29 DEVICES" -> "Home · 29 devices")
  function sentence(s) { s = String(s || '').trim(); if (s && s === s.toUpperCase() && /[A-Z]/.test(s)) { s = s.toLowerCase(); s = s.charAt(0).toUpperCase() + s.slice(1); } return s; }
  function cap1(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }
  var TAU = Math.PI * 2;

  /* ============================== MOTION (2026-10-04) ==============================
     The ONE place measured data becomes motion (docs/contracts.md). Every curve here is fixed,
     log-scaled through normBps() and capped, so no traffic level can make anything spin fast (the
     "moving insanely fast" complaint). Everything is integrated with the clamped frame dt, so frame
     rate only changes smoothness, never speed.

       input                      -> motion                         curve                                   cap
       frame dt                   -> every integrator               min(dt, 0.05 s)                         50 ms
       node CPU %                 -> galaxy spin (rad/s)            0.012 + 0.040 * cpu/100, eased 4 s      0.052 (one turn / 2 min)
       system (network, sites)    -> rigid rotation of the system   one turn / 20 min, phase from the epoch 0.0052 rad/s
       device rx+tx bps           -> u = normBps (1 kb/s..30 Mb/s)  log10                                   0..1
       u                          -> orbit of a body round its slot 0.12 + 0.68 u rad/s, radius 22% band    0.8 rad/s (8 s / loop)
       u                          -> body sprite spin               class spin * (0.4 + 0.6 u)              0.6 rad/s
       u (flow families)          -> comets per second              0.4 + 7 u                               7.4 / s
       u (turntable classes)      -> turntable frame rate           sheet fps * (0.25 + 0.75 u)             8 fps = 3 s / turn
       rtt ms                     -> pulse period (s)               1.2 + 1.6 log2(1 + rtt)                 1.2 .. 6 s
       status down                -> orbit + spin + pulse stop where they are; alpha -> 0.32, colour
                                     desaturated (UNIVERSE_LAYOUT.colourRGB), eased 1.2 s; back up = relight in place
       new (first 10 min)         -> birth: size 0 -> 1 over 1.6 s (smootherstep) + a 2.4 s flare ring at the slot
       wall tour (lightstate)     -> camera leg follows the wall's prog through a rate-limited follower
                                     (0.4x .. 2.2x nominal speed, stepped on REAL elapsed time capped at 0.25 s so a
                                     slow frame rate can't make it lag the wall), never a jump, never backwards; hold sway fades
                                     in over 2 s so arrival -> hold has no velocity step */
  var MOTION = {
    DT_MAX: 0.05,
    spin: function (cpuPct) { return 0.012 + 0.04 * clamp((+cpuPct || 0) / 100, 0, 1); }, SPIN_TAU: 4,
    SYS_W: TAU / 1200,
    orbitW: function (u) { return 0.12 + 0.68 * clamp(u, 0, 1); }, ORBIT_R: 0.22,
    spinW: function (clsSpin, u) { return Math.min(0.6, (clsSpin == null ? 0.15 : clsSpin) * (0.4 + 0.6 * clamp(u, 0, 1))); },
    flowRate: function (u) { return 0.4 + 7 * clamp(u, 0, 1); },
    ttFps: function (sheetFps, u) { return (sheetFps || 8) * (0.25 + 0.75 * clamp(u, 0, 1)); },
    pulseT: function (rtt) { return rtt == null ? 3.2 : clamp(1.2 + 1.6 * Math.log2(1 + Math.max(0, rtt)), 1.2, 6); }, PULSE_A: 0.12,
    DOWN_ALPHA: 0.32, STATUS_TAU: 1.2, BIRTH_S: 1.6, FLARE_S: 2.4,
    TOUR_GAIN: 6, TOUR_MIN: 0.4, TOUR_MAX: 2.2, SWAY_IN: 2.0
  };
  /* simulation clock: the sum of clamped dts. Every phase that used clock.getElapsedTime() reads this instead,
     so a tab that slept (or a slow frame) can never fast-forward an orbit or a pulse, and t and the dt
     integrators always agree. */
  var SIM_T = 0;

  /* ============================== renderer ============================== */
  var canvas = $('c');
  var scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x02040c, 0.00022);
  var cam = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 1, 6000);
  var rndr = new THREE.WebGLRenderer({ canvas: canvas, antialias: false, powerPreference: 'high-performance' });
  /* ============================== render scale (2026-10-05 perf) ==============================
     The TV is typically a 4K panel at DPR 2, often on a GPU that is shared with other work (an NVR detector, say). The 3D scene does NOT need
     3840x2160: it renders at RS.s x the native drawing-buffer size and the compositor upscales the canvas (bilinear);
     every HUD element and label is HTML/CSS and stays native-crisp. RS.s is capped so the scene never exceeds
     RS_MAX_PIX (~2730x1536 on a 4K panel) and is driven DOWN from there by measured GPU time (perfTick: timer
     queries, hysteresis, rare steps) when the GPU is contended, then back up when it is free.
     Everything that is specified in device pixels follows the scale so the picture is the same in CSS pixels:
       U_PR   - the drawing-buffer pixel ratio the point shaders size gl_PointSize with (was a per-material snapshot)
       U_CAPK - point-size caps were tuned at the base pixel ratio: cap * (pr / basePR) keeps them the same on screen
       U_LINEK- GL lines are 1 device px wide, i.e. 1/s wider on screen at scale s: their alpha is scaled by s */
  /* the cap is native 4K (was 4.2e6, ~2730x1536 = s 0.712). Measured on a mid-range GPU shared with an NVR detector:
     composer.render 0.52-0.57 ms at s 0.712 vs 0.74-0.85 ms at s 1.0 (timer queries, same frames,
     NEXUS.hold), 60 fps both, GPU util 29-45 % either way. Native resolution keeps 1-px orbit lines, lanes and star
     points from shimmering through the bilinear upscale; perfTick still steps the scale down when the GPU is contended. */
  var BASE_PR = Math.min(window.devicePixelRatio || 1, 2), RS_MAX_PIX = 8.3e6;
  var U_PR = { value: BASE_PR }, U_CAPK = { value: 1 }, U_LINEK = { value: 1 };
  var RS = { s: 1, sMax: 1, lock: 0 };
  (function () { var m = /(?:^|,)rs=([0-9.]+)/.exec(String(window.NX_FLAGS || (function () { try { return localStorage.getItem('nxflags'); } catch (e) { return ''; } })() || '')); if (m) RS.lock = clamp(+m[1], 0.25, 1); })();
  function rsMaxFor(w, h) { var px = w * h * BASE_PR * BASE_PR; return px > 0 ? clamp(Math.sqrt(RS_MAX_PIX / px), 0.25, 1) : 1; }
  RS.sMax = rsMaxFor(innerWidth, innerHeight); RS.s = RS.lock || RS.sMax;
  rndr.setSize(innerWidth, innerHeight);
  rndr.setPixelRatio(BASE_PR * RS.s);
  U_PR.value = BASE_PR * RS.s; U_CAPK.value = RS.s; U_LINEK.value = RS.s;
  // Tone mapping moved to the END of the chain (gradePass below). This is three r128: the
  // renderer-level ACES only ever ran inside built-in materials (sprites, ring meshes) — the
  // custom ShaderMaterials (cores, every point cloud) and the bloom composite have no
  // tonemapping chunk, so their output went to the screen as raw linear values and simply
  // clipped to flat white above 1.0. That clipping (core + bloom stacked additively) was the
  // blown-out white discs on the galaxy close-ups. Mapping once, post-bloom, rolls those
  // highlights off filmically instead and keeps the accent hue in the core body.
  rndr.toneMapping = THREE.NoToneMapping;
  /* PHOTOGRAPHIC PIPELINE (2026-10-08b, docs/contracts.md: "one photographic pipeline for everything"). The scene renders
     into a HALF-FLOAT buffer, so a star core, a galaxy bulge or a sun can be several times brighter than white without
     clipping; the bloom bright-pass keeps only the light ABOVE a threshold of 1.0 (a soft knee on the HDR value: only
     genuinely bright things glow); ONE filmic curve at the end maps everything with the same exposure. The old 8-bit
     chain clipped every highlight at 1.0 before the curve ever saw it - the flat white discs ("3D rendered") came from
     that. nxflags `ldr` (or a GPU without float render targets) keeps the old 8-bit chain exactly. */
  var HDR = (function () {
    if (NXF.ldr || !rndr.capabilities.isWebGL2) return false;
    try { return !!rndr.getContext().getExtension('EXT_color_buffer_float'); } catch (e) { return false; }
  })();
  /* the scene buffer is R11F_G11F_B10F (packed float, 4 bytes a pixel like RGBA8: HDR at half the bandwidth of RGBA16F, no
     alpha - nothing reads the scene's alpha); nxflags `rgba16` takes RGBA16F instead */
  var hdrRT = HDR ? new THREE.WebGLRenderTarget(4, 4, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: NXF.rgba16 ? THREE.RGBAFormat : THREE.RGBFormat, type: THREE.HalfFloatType }) : null;
  if (hdrRT && !NXF.rgba16) {
    hdrRT.texture.internalFormat = 'R11F_G11F_B10F';
    /* three r128 turns every RGB float render target into RGBA (WebGL2 cannot render to RGB16F), which would hand
       R11F_G11F_B10F an RGBA upload format (INVALID_OPERATION, an incomplete framebuffer, a black screen). The packed format
       is renderable and blendable with EXT_color_buffer_float: give its (null-data) allocations the RGB format it needs */
    (function () {
      var gl = rndr.getContext(), ti = gl.texImage2D;
      gl.texImage2D = function (tg, lv, ifmt, w, h, bd, fmt, ty, px) {
        if (arguments.length >= 9 && ifmt === gl.R11F_G11F_B10F && fmt === gl.RGBA) return ti.call(gl, tg, lv, ifmt, w, h, bd, gl.RGB, ty, px);
        return ti.apply(gl, arguments);
      };
    })();
  }
  var composer = HDR ? new THREE.EffectComposer(rndr, hdrRT) : new THREE.EffectComposer(rndr);
  if (HDR) composer._pixelRatio = rndr.getPixelRatio();      // a composer handed its own target starts at pixel ratio 1
  // whole-pixel targets: at a fractional RS.s the stock setSize hands WebGLRenderTarget a fractional width
  composer.setSize = function (w, h) {
    this._width = w; this._height = h;
    var ew = Math.max(1, Math.floor(w * this._pixelRatio)), eh = Math.max(1, Math.floor(h * this._pixelRatio));
    this.renderTarget1.setSize(ew, eh); this.renderTarget2.setSize(ew, eh);
    for (var i = 0; i < this.passes.length; i++) this.passes[i].setSize(ew, eh);
  };
  composer.setSize(innerWidth, innerHeight);
  composer.addPass(new THREE.RenderPass(scene, cam));
  /* bloom (2026-10-05 perf): the same UnrealBloomPass bright-pass + 5-mip separable blur as before, but
     - its resolution is pinned to the NATIVE screen (bright target = native/2, exactly what it was at 4K) instead of
       following the composer, so the glow keeps the same on-screen radius whatever RS.s the scene renders at;
     - its own composite pass and the full-resolution additive copy back into the scene buffer are gone: the final pass
       below reads the five blurred mips directly and does composite + add + grade in ONE full-screen pass.
     The fold reproduces the old 8-bit chain exactly (composite clamped to [0,1] like its RGBA8 target, added with the
     SrcAlpha/One blend the copy used, the sum clamped like the RGBA8 scene buffer), so the picture does not change -
     it just stops costing a 4K read-modify-write and a 1080p write + read per frame. */
  var bloom = new THREE.UnrealBloomPass(new THREE.Vector2(256, 256), 1.0, 0.72, 0.7);
  var NATIVE = { w: innerWidth * BASE_PR, h: innerHeight * BASE_PR };
  /* HDR bloom: the bright-pass is a soft threshold on the HDR value (what is ABOVE 1.0 glows, in proportion to the excess,
     so a dim star never blooms and a bright core blooms smoothly), its targets are half-float too (a core several times
     brighter than white spreads a proportionally wider glow instead of saturating), and the whole chain runs at a quarter
     of the native size (BLOOM_RES): bloom is a wide, soft thing, and the tight halo of a star is drawn by its own sprite */
  var BLOOM_RES = HDR ? 0.25 : 0.5, BLOOM_THR = HDR ? 1.0 : 0.72;
  if (HDR) {
    [bloom.renderTargetBright].concat(bloom.renderTargetsHorizontal, bloom.renderTargetsVertical).forEach(function (rt) { rt.texture.type = THREE.HalfFloatType; });
    bloom.threshold = BLOOM_THR;
    bloom.materialHighPassFilter.fragmentShader = [
      'uniform sampler2D tDiffuse; uniform float luminosityThreshold; uniform float smoothWidth; varying vec2 vUv;',
      'void main(){ vec3 c = texture2D(tDiffuse, vUv).rgb; float l = dot(c, vec3(0.2126, 0.7152, 0.0722));',
      '  float x = max(l - luminosityThreshold, 0.0), k = x * x / (x + 0.35);',          // soft knee: 0 at the threshold, ~linear above
      '  gl_FragColor = vec4(min(c * (k / max(l, 1e-4)), vec3(24.0)), 1.0); }'
    ].join('\n');
    bloom.materialHighPassFilter.needsUpdate = true;
  }
  (function () {
    var setSize0 = bloom.setSize;
    // bright target = BLOOM_RES of the native drawing-buffer size, never the scaled one (the glow keeps its on-screen radius)
    bloom.setSize = function () { setSize0.call(bloom, Math.max(4, Math.round(NATIVE.w * BLOOM_RES * 2)), Math.max(4, Math.round(NATIVE.h * BLOOM_RES * 2))); };
    bloom.needsSwap = false;
    bloom.render = function (renderer, writeBuffer, readBuffer) {
      var oldAutoClear = renderer.autoClear; renderer.autoClear = false;
      renderer.getClearColor(this._oldClearColor); this.oldClearAlpha = renderer.getClearAlpha();
      renderer.setClearColor(this.clearColor, 0);
      this.highPassUniforms.tDiffuse.value = readBuffer.texture;
      this.highPassUniforms.luminosityThreshold.value = this.threshold;
      this.fsQuad.material = this.materialHighPassFilter;
      renderer.setRenderTarget(this.renderTargetBright); renderer.clear(); this.fsQuad.render(renderer);
      var input = this.renderTargetBright;
      for (var i = 0; i < this.nMips; i++) {
        var m = this.separableBlurMaterials[i];
        this.fsQuad.material = m;
        m.uniforms.colorTexture.value = input.texture; m.uniforms.direction.value = THREE.UnrealBloomPass.BlurDirectionX;
        renderer.setRenderTarget(this.renderTargetsHorizontal[i]); renderer.clear(); this.fsQuad.render(renderer);
        m.uniforms.colorTexture.value = this.renderTargetsHorizontal[i].texture; m.uniforms.direction.value = THREE.UnrealBloomPass.BlurDirectionY;
        renderer.setRenderTarget(this.renderTargetsVertical[i]); renderer.clear(); this.fsQuad.render(renderer);
        input = this.renderTargetsVertical[i];
      }
      renderer.setClearColor(this._oldClearColor, this.oldClearAlpha); renderer.autoClear = oldAutoClear;
    };
  })();
  composer.addPass(bloom);
  var BLOOM_BASE = 1.0;
  /* final pass: bloom composite + ACES (Narkowicz fit) + a touch of saturation + a soft vignette, written straight to
     the canvas. Saturation is nudged UP (never down): lightsync.js reads this picture and only counts pixels with HSL
     saturation >= 0.25, so a desaturating grade would cost real room-light hue detection. The vignette is mild and only
     bites in the outer ~35% of the frame; the centre (where the subject and its colour always are) is untouched. */
  /* HDR grade (2026-10-08b): scene + bloom (no clamp: the bloom of a bright core adds real light), one exposure, the
     ACES filmic curve, then a saturation lift and a gentle S on the mid-tones (deep-sky photo contrast: a near-black but
     not crushed sky, colour that holds in the arms), a soft vignette, and a ~1/255 blue-noise-ish dither plus a whisper of
     luminance grain so the long smooth gradients of halos and haze never band on the 8-bit panel / a phone recording. */
  var GRADE = { exp: HDR ? 1.2 : 1.45, sat: HDR ? 1.2 : 1.12, vig: HDR ? 0.24 : 0.3, grain: HDR ? 0.012 : 0, con: HDR ? 0.1 : 0 };
  var gradePass = new THREE.ShaderPass({
    uniforms: { tDiffuse: { value: null }, uExp: { value: GRADE.exp }, uSat: { value: GRADE.sat }, uVig: { value: GRADE.vig },
                b1: { value: bloom.renderTargetsVertical[0].texture }, b2: { value: bloom.renderTargetsVertical[1].texture }, b3: { value: bloom.renderTargetsVertical[2].texture },
                b4: { value: bloom.renderTargetsVertical[3].texture }, b5: { value: bloom.renderTargetsVertical[4].texture },
                uF: { value: [0, 0, 0, 0, 0] }, uStr: { value: 1 }, uGrain: { value: GRADE.grain }, uCon: { value: GRADE.con }, uT: { value: 0 } },
    defines: HDR ? { NX_HDR: 1 } : {},
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: [
      'uniform sampler2D tDiffuse, b1, b2, b3, b4, b5; uniform float uExp, uSat, uVig, uStr, uGrain, uCon, uT; uniform float uF[5]; varying vec2 vUv;',
      'vec3 aces(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14), 0.0, 1.0); }',
      'float h12(vec2 p){ vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }',
      'void main(){',
      '#ifdef NX_HDR',
      '  vec3 bl = uStr * (uF[0]*texture2D(b1, vUv).rgb + uF[1]*texture2D(b2, vUv).rgb + uF[2]*texture2D(b3, vUv).rgb + uF[3]*texture2D(b4, vUv).rgb + uF[4]*texture2D(b5, vUv).rgb);',
      '  vec3 c = (texture2D(tDiffuse, vUv).rgb + bl) * uExp;',
      '#else',
      '  vec4 bl = clamp(uStr * (uF[0]*texture2D(b1, vUv) + uF[1]*texture2D(b2, vUv) + uF[2]*texture2D(b3, vUv) + uF[3]*texture2D(b4, vUv) + uF[4]*texture2D(b5, vUv)), 0.0, 1.0);',
      '  vec3 c = min(texture2D(tDiffuse, vUv).rgb + bl.rgb * bl.a, 1.0) * uExp;',
      '#endif',
      '  c = aces(max(c, 0.0));',
      '  float l = dot(c, vec3(0.2126, 0.7152, 0.0722)); c = mix(vec3(l), c, uSat);',
      // mid-tone S (pivot ~0.4): arms and haze gain contrast, black and white points stay put
      '  c = clamp(c, 0.0, 1.0); c = mix(c, c * c * (3.0 - 2.0 * c), uCon);',
      '  vec2 q = vUv - 0.5; float v = 1.0 - uVig * smoothstep(0.16, 0.5, dot(q, q));',
      '  c *= v;',
      '  float n = h12(gl_FragCoord.xy + fract(uT * 7.31) * 113.0) + h12(gl_FragCoord.yx * 1.37 + fract(uT * 3.17) * 71.0) - 1.0;',
      '  c += n * (0.6 / 255.0 + uGrain * sqrt(max(l, 0.0)) * (1.0 - l));',
      '  gl_FragColor = vec4(c, 1.0); }'
    ].join('\n')
  });
  // ShaderPass CLONES its uniforms (textures included): point the clones back at the live blur-mip render targets
  for (var bi0 = 0; bi0 < 5; bi0++) gradePass.uniforms['b' + (bi0 + 1)].value = bloom.renderTargetsVertical[bi0].texture;
  (function () {
    var render0 = gradePass.render, BF = [1.0, 0.8, 0.6, 0.4, 0.2];
    gradePass.render = function () {
      // bloom.strength is driven per frame (beat, threat hit); the mip weights are UnrealBloomPass's lerpBloomFactor()
      var u = gradePass.uniforms; u.uStr.value = bloom.strength; u.uT.value = SIM_T;
      for (var i = 0; i < 5; i++) u.uF.value[i] = lerp(BF[i], 1.2 - BF[i], bloom.radius);
      return render0.apply(gradePass, arguments);
    };
  })();
  composer.addPass(gradePass);
  /* baked Blender assets (2026-09-19): every texture is loaded exactly once, here, and handed to the
     material that owns it in the callback; nothing waits on them (the scene draws untextured until then) */
  /* Chrome caps HTTP/1.1 connections at 6 per host and this page holds long-lived SSE sockets (lightstate,
     pulse, presence, threats here + mode, pulse in showtime.js = 6). A navigation away needs a 7th socket,
     which only frees once the NEW page commits - verified on the TV: with the 6th stream open a reload never
     committed and the renderer sat in futex_wait until the kiosk was killed. beforeunload runs BEFORE the
     navigation request is issued, so closing our streams there hands the sockets back in time. */
  var STREAMS = [];
  /* 2026-10-05: this page's own streams open at the REVEAL, not at script start. With showtime.js's two sockets plus
     ours, five of Chrome's six per-host HTTP/1.1 sockets were held by SSE before the first texture request went out,
     so every boot asset and API answer queued single-file behind one connection. Nothing needs a stream behind the
     veil (the first lightstate is polled, presence defaults to active); reveal() opens them, at most 8 s in. */
  var SSE_Q = [];
  function sse(url, onmsg, onerr) {
    if (!BOOT.revealed) { SSE_Q.push([url, onmsg, onerr]); return null; }
    var es = new EventSource(url); es.onmessage = onmsg; if (onerr) es.onerror = onerr; STREAMS.push(es); return es;
  }
  function closeStreams() { SSE_Q.length = 0; STREAMS.forEach(function (es) { try { es.close(); } catch (e) { } }); STREAMS.length = 0; }
  addEventListener('beforeunload', closeStreams); addEventListener('pagehide', closeStreams);
  var MAX_ANISO = Math.min(8, rndr.capabilities.getMaxAnisotropy());
  /* pre-warm (a 533 ms hitch was measured on the first visit to a host stop): three uploads a texture to the GPU on
     the first frame an object using it is actually drawn, so a 4K disc or atlas that was off-screen until a stop change
     stalled that frame. Every texture is uploaded right after it decodes instead (WebGLRenderer.initTexture), and the
     scene's programs are compiled once after the assets settle (see prewarm below).
     2026-10-05 perf: images are decoded OFF the main thread (fetch -> createImageBitmap, flipped at decode so the
     texture keeps flipY=false) - an <img> handed to texImage2D is decoded synchronously inside the upload, which was a
     100-330 ms main-thread stall per 2048px PNG while the scene was already on screen. Falls back to TextureLoader
     where createImageBitmap is missing. BOOT counts every load still in flight for the reveal gate. */
  var BOOT = { inflight: 0, manifest: false, uni: false, all: false, rockets: false, revealed: false, t0: performance.now(), tReady: 0, frames: 0 };
  var TEXL = (function () {
    var IBL = typeof createImageBitmap === 'function' && THREE.ImageBitmapLoader ? new THREE.ImageBitmapLoader().setOptions({ imageOrientation: 'flipY', premultiplyAlpha: 'none' }) : null;
    var TL = new THREE.TextureLoader();
    function done(t, onLoad) { BOOT.inflight--; if (onLoad) onLoad(t); try { if (rndr.initTexture) rndr.initTexture(t); } catch (e) { } }
    return { load: function (url, onLoad, onProg, onErr) {
      BOOT.inflight++;
      function fail(e) { BOOT.inflight--; if (onErr) onErr(e); }
      if (!IBL) return TL.load(url, function (t) { done(t, onLoad); }, onProg, fail);
      IBL.load(url, function (bmp) {
        var t = new THREE.Texture(bmp); t.flipY = false;
        if (/\.jpe?g$/i.test(url)) t.format = THREE.RGBFormat;     // what TextureLoader picks for a JPEG
        t.needsUpdate = true; done(t, onLoad);
      }, onProg, fail);
    } };
  })();
  function loadTex(name, cb) { TEXL.load('/static/assets/' + name, function (t) { t.anisotropy = MAX_ANISO; if (cb) cb(t); }, undefined, function () { console.warn('nexus: texture failed', name); }); }
  /* THE SKY (2026-10-08c): the SHARED deep-sky plate, static/assets/galaxy2/sky/deep_sky.jpg - the shared
     physically built 4096x2048 equirect (a Milky-Way band with its dark rift, faint H-alpha / OIII / reflection nebulae
     near the plane, galactic cirrus, ~9000 tiny deep-field galaxies and a few landmark objects), the same sky the wall
     stands in. Raw sampling (three's default LinearEncoding), white tint. A BackSide sphere that follows the camera (r128
     has no background intensity), one draw, depth and fog off, anisotropy 1 (never seen at a grazing angle; 8x over the
     full-screen plate cost 0.15-0.25 ms at 4K). The painted nebula of the 2026-10-08b pass is gone.
     LEVEL: SKY.close / SKY.wide are the asset owner's sphere tints for the TV - 0.35 at the close-ups, 0.40-0.45 at the
     wide shots (overview, internet edge), eased between with the director's stop - on the TV's original exposure (1.45);
     this page's HDR grade exposes at GRADE.exp, so the sphere colour carries 1.45 / GRADE.exp to land at the same display
     level. FILLERS: where a wide shot would still show a void, the shared nebula fillers (galaxy2/nebulae: cirrus, H-alpha
     shock filaments, the OIII veil) are painted INTO the plate once at boot (skyFill: no per-frame cost), aimed at the
     void cells of those two frames only and kept subordinate (SKY.fill). Tunable with nxflags: sky=<file under
     /static/assets/>  skyclose=  skywide=  skyrot=ry:rx:rz  skyfill= (0 = plate only); live: NEXUS.skyTune({ ... }). */
  function nxv(name, def) {
    var m = new RegExp('(?:^|,)\\s*' + name + '=([^,]+)').exec(String(window.NX_FLAGS || (function () { try { return localStorage.getItem('nxflags'); } catch (e) { return ''; } })() || ''));
    return m ? (isNaN(+m[1]) ? m[1].trim() : +m[1]) : def;
  }
  var SKY = { file: String(nxv('sky', 'galaxy2/sky/deep_sky.jpg')), close: nxv('skyclose', 0.35), wide: nxv('skywide', 0.42),
              rot: String(nxv('skyrot', '0.79:0.3:0.6')).split(':').map(Number), fill: nxv('skyfill', 1.0), wideK: 0, src: null, voids: null, fillers: 0, bakeMs: 0 };
  var sky = new THREE.Mesh(new THREE.SphereGeometry(5000, 48, 24), new THREE.MeshBasicMaterial({ map: null, color: 0x000000, side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false }));
  sky.renderOrder = -100; sky.frustumCulled = false; sky.visible = false; scene.add(sky);
  // turned so the band and the landmark objects sit at the edges of both wide shots and their middles stay dark (skyfit.py)
  sky.rotation.set(SKY.rot[1] || 0, SKY.rot[0] || 0, SKY.rot[2] || 0);
  var skyF = 0;                      // fades in (skyTick) instead of popping when the plate lands after the reveal
  function skyUse(tx) {
    var old = sky.material.map; tx.anisotropy = 1; sky.material.map = tx; sky.material.needsUpdate = true; sky.visible = true;
    try { rndr.initTexture(tx); } catch (e) { }
    if (old && old !== tx) old.dispose();
  }
  function skyBaked(img, flipY) { var t2 = new THREE.Texture(img); t2.flipY = flipY; t2.needsUpdate = true; skyUse(t2); }
  if (!NXF.nosky) loadTex(SKY.file, function (t) {
    SKY.src = { img: t.image, flipY: t.flipY };
    // the fillers are painted in once the deep sky has placed itself (it knows the two wide frames); the plain plate meanwhile
    var tries = 0;
    skyUse(t);
    (function bake() {
      if (!(SKY.fill > 0)) return;
      if ((!FILL.ready || !DEEP.ready) && tries++ < 60) return setTimeout(bake, 100);
      skyFill(t.image, !t.flipY, function (img) { if (img) skyBaked(img, t.flipY); });
    })();
  });
  // live tuning (console / QA): NEXUS.skyTune({ close, wide, fill, rot: [ry, rx, rz] }) - re-paints when fill or rot change
  function skyTune(o) {
    o = o || {}; var rebake = false;
    if (o.close != null) SKY.close = +o.close; if (o.wide != null) SKY.wide = +o.wide;
    if (o.fill != null && +o.fill !== SKY.fill) { SKY.fill = +o.fill; rebake = true; }
    if (o.rot) { SKY.rot = o.rot.slice(); sky.rotation.set(SKY.rot[1] || 0, SKY.rot[0] || 0, SKY.rot[2] || 0); rebake = true; }
    if (rebake && SKY.src) {
      if (!(SKY.fill > 0)) { var tp = new THREE.Texture(SKY.src.img); tp.flipY = SKY.src.flipY; tp.needsUpdate = true; skyUse(tp); }
      else skyFill(SKY.src.img, !SKY.src.flipY, function (img) { if (img) skyBaked(img, SKY.src.flipY); });
    }
    return SKY;
  }
  function skyTick(dt) {
    if (!sky.visible) return;
    if (skyF < 1) skyF = Math.min(1, skyF + dt / 1.2);
    var k = D.stopKey, wide = !TC.on && !SC.active && !!k && (/^over/.test(k) || k === 'wan');
    SKY.wideK += ((wide ? 1 : 0) - SKY.wideK) * Math.min(1, dt / 0.6);
    sky.material.color.setScalar(lerp(SKY.close, SKY.wide, SKY.wideK) * (1.45 / GRADE.exp) * smooth(skyF));
  }

  /* ============================== textures ============================== */
  function softTex(inner, mid) {
    var s = 128, cv = document.createElement('canvas'); cv.width = cv.height = s;
    var x = cv.getContext('2d'), g = x.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, inner); g.addColorStop(0.25, mid); g.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = g; x.fillRect(0, 0, s, s);
    var t = new THREE.CanvasTexture(cv); return t;
  }
  var TEX_STAR = softTex('rgba(255,255,255,1)', 'rgba(255,255,255,.55)');
  var TEX_DUST = softTex('rgba(255,255,255,.9)', 'rgba(255,255,255,.18)');
  var TEX_NEB = softTex('rgba(255,255,255,.35)', 'rgba(255,255,255,.08)');
  // halo glow with an inverse-square-ish skirt: a tight hot centre and a long, low tail
  // instead of TEX_STAR's ~linear ramp (which still had 55% alpha at a quarter of the radius
  // and so read as a flat, hard-edged disc once bloom stacked on it). Used only by the core
  // and sun halos — guest stars/comets keep TEX_STAR so they stay crisp points.
  var TEX_GLOW = (function () {
    var s = 256, cv = document.createElement('canvas'); cv.width = cv.height = s;
    var x = cv.getContext('2d'), g = x.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.05, 'rgba(255,255,255,.8)'); g.addColorStop(0.14, 'rgba(255,255,255,.4)');
    g.addColorStop(0.3, 'rgba(255,255,255,.15)'); g.addColorStop(0.55, 'rgba(255,255,255,.045)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = g; x.fillRect(0, 0, s, s);
    return new THREE.CanvasTexture(cv);
  })();
  // soft annulus (alpha ramps 0 -> 1 -> 0 across r0..r1 of the half-size) drawn on a 2x2 plane:
  // replaces the 1-segment-thin RingGeometry rings, whose geometric edges aliased into a
  // shimmering hairline at 4K with no MSAA. r128 has no cheap MSAA-on-render-target path
  // (WebGLMultisampleRenderTarget + composer is a known-fragile combination there), so the
  // ring edge is anti-aliased in the texture instead.
  function ringTex(r0, r1) {
    var s = 256, cv = document.createElement('canvas'); cv.width = cv.height = s;
    var x = cv.getContext('2d'), g = x.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2), mid = (r0 + r1) / 2;
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(Math.max(0, r0), 'rgba(0,0,0,0)'); g.addColorStop(mid, 'rgba(255,255,255,1)');
    g.addColorStop(Math.min(1, r1), 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = g; x.fillRect(0, 0, s, s);
    return new THREE.CanvasTexture(cv);
  }
  var TEX_RING = ringTex(0.84, 1.0), TEX_ORBIT = ringTex(0.4, 1.0);
  /* ---- photographic textures (2026-10-08b, docs/contracts.md) ----
     TEX_PSF    a real star's point-spread function: a tight Moffat core and a faint, wide halo; no rim, no disc
     TEX_SPIKE  four thin tapering diffraction spikes: only the brightest stars wear them (a second, rotated sprite)
     TEX_NEBS   three wispy gas clouds (seeded fBm, soft-masked): emission / reflection nebulae and galaxy haze
     TEX_ELL    an elliptical galaxy / galaxy bulge: a de Vaucouleurs-like profile (bright core, long faint wings)
     Alpha carries the profile (RGB white); the caller's colour carries hue and HDR brightness. Everything here is
     seeded (rng), so every load draws the same sky. */
  var STARS = [], SPIKE_ROT = 0, _sg = new THREE.Vector3();     // the glare pool (REAL STARS, below the sun): declared early, the deep sky adds to it
  function rng(seed) {
    var a = seed >>> 0;
    return function () { a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  function alphaTex(s, fn) {
    var cv = document.createElement('canvas'); cv.width = cv.height = s;
    var x = cv.getContext('2d'), im = x.createImageData(s, s), d = im.data;
    for (var j = 0; j < s; j++) for (var i = 0; i < s; i++) {
      var o = (j * s + i) * 4, a = fn((i + 0.5) / s * 2 - 1, (j + 0.5) / s * 2 - 1);
      d[o] = d[o + 1] = d[o + 2] = 255; d[o + 3] = a <= 0 ? 0 : a >= 1 ? 255 : Math.round(a * 255);
    }
    x.putImageData(im, 0, 0);
    var t = new THREE.CanvasTexture(cv); return t;
  }
  var TEX_PSF = alphaTex(256, function (u, v) {
    var r = Math.sqrt(u * u + v * v); if (r >= 1) return 0;
    var core = Math.pow(1 + (r * r) / (0.14 * 0.14), -2.4), halo = 0.06 * Math.exp(-r / 0.2) + 0.015 * Math.exp(-r / 0.5);
    return (core + halo) * (1 - r * r) * (1 - r * r);
  });
  var TEX_SPIKE = alphaTex(512, function (u, v) {
    function spike(a, b) { var w = 0.0075 + 0.012 * Math.abs(a); return Math.exp(-(b * b) / (w * w)) * Math.pow(Math.max(0, 1 - Math.abs(a)), 2.2); }
    var r = Math.sqrt(u * u + v * v); if (r >= 1) return 0;
    return Math.min(1, 0.85 * (spike(u, v) + spike(v, u))) * (1 - r * r);
  });
  // the glare round a RESOLVED star's limb (r0 = 0.2 of the sprite radius is the limb): nothing over the disc, so the
  // photosphere's limb darkening stays visible, then a bright skirt right outside the limb fading into a long faint tail
  var TEX_CORONA = alphaTex(256, function (u, v) {
    var r = Math.sqrt(u * u + v * v); if (r >= 1) return 0;
    var e = Math.max(0, r - 0.2), on = Math.min(1, Math.max(0, (r - 0.165) / 0.035));
    return on * (0.7 * Math.exp(-e / 0.07) + 0.16 * Math.exp(-e / 0.3)) * (1 - r * r);
  });
  var TEX_ELL = alphaTex(128, function (u, v) {
    var r = Math.sqrt(u * u + v * v); if (r >= 1) return 0;
    return Math.exp(-Math.pow(r / 0.16, 0.8)) * (1 - r * r);
  });
  var TEX_NEBS = (function () {
    var out = [], S = 128;
    for (var vi = 0; vi < 3; vi++) {
      var R = rng(9001 + vi * 77), G0 = 32, grid = new Float32Array(G0 * G0);
      for (var gi = 0; gi < grid.length; gi++) grid[gi] = R();
      var noise = function (x, y) {
        x = ((x % G0) + G0) % G0; y = ((y % G0) + G0) % G0;
        var x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, x1 = (x0 + 1) % G0, y1 = (y0 + 1) % G0;
        fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
        var a = grid[y0 * G0 + x0], b = grid[y0 * G0 + x1], c = grid[y1 * G0 + x0], d = grid[y1 * G0 + x1];
        return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
      };
      var ox = R() * 32, oy = R() * 32, stretch = 0.6 + 0.5 * R();
      out.push(alphaTex(S, function (u, v) {
        var r = Math.sqrt(u * u * stretch + v * v / stretch); if (r >= 1) return 0;
        var s = 0, amp = 0.5, f = 2.2, x = u * 4 + ox, y = v * 4 + oy;
        for (var k = 0; k < 5; k++) { var nv = noise(x * f / 2.2, y * f / 2.2); s += amp * (k < 2 ? nv : 1 - Math.abs(2 * nv - 1)); amp *= 0.52; f *= 2.03; }
        var m = Math.pow(Math.max(0, 1 - r), 1.6);
        return Math.pow(Math.max(0, s - 0.28) / 0.72, 1.7) * m * 1.25;
      }));
    }
    return out;
  })();
  /* the shared deep-sky assets (2026-10-08c; static/assets/galaxy2, the shared set - manifest.json there has the
     conventions): raw sampling, white tint, additive, STRAIGHT alpha (rgb x a = the light). G2 = the galaxy plates and
     the deep-sky fillers are the shared ones (nxflags nog2 = the page's own 2026-10-08b plates, for an A/B). */
  var G2 = !NXF.nog2, G2B = 'galaxy2/';
  /* the shared galaxy plates (2026-10-08c): drawn RAW (white, no grade, no desaturation; rgb x a additive), x 1.45 /
     GRADE.exp so they land at the display level the asset owner judged them at (the TV's original exposure 1.45). Each
     is turned in its plane (rot, fitted offline) so its arms lie over the page's own arm curve - the one its stellar
     populations and its guest stars are placed on - so the data sits ON the arms. They spin counter-clockwise as the
     image is seen (their arms trail that way). The plates go by node INDEX (CONFIG.nodes order), never by name: node 0
     wears the blue-white plate, node 1 the golden one (which has an edge-on view of the same galaxy, cross-faded in
     within ~20 degrees of edge-on, edgeOnTick); growth nodes take pve_pool by their seat. */
  var G2P = { node: [{ file: G2B + 'galaxies/galaxy_blue.png', rot: 3.037 },
                     { file: G2B + 'galaxies/galaxy_gold.png', rot: 1.553, edgeon: G2B + 'galaxies/galaxy_gold_edgeon.png' }],
              edge: { file: G2B + 'galaxies/galaxy_edge.png', rot: 1.292 },
              pve: [{ file: G2B + 'galaxies/galaxy_pve_a.png', rot: 4.922 }, { file: G2B + 'galaxies/galaxy_pve_b.png', rot: 4.136 }] };
  // a lone node wears the golden plate (the edge-on variant included)
  if (G2) NODES.forEach(function (nd, i) { var p = G2P.node[N_NODES === 1 ? 1 : i]; if (!p) return; nd.disc = p.file; nd.discRot = p.rot; nd.discFlip = false; nd.raw = true; nd.rot = 1; nd.edgeon = p.edgeon || null; });
  // the shared PSFs for the glare stars (mkGlare, below): materials made before they decode are pointed at them on arrival
  var G2PSF = { psf: null, hub: null, mats: [] };
  if (G2) ['psf', 'hub'].forEach(function (k) {
    loadTex(G2B + (k === 'psf' ? 'psf/psf_soft.png' : 'psf/psf_hubble.png'), function (t) {
      G2PSF[k] = t; G2PSF.mats.forEach(function (m) { if (m.userData.g2 === k) { m.map = t; m.needsUpdate = true; } });
    });
  });
  // the nebula fillers, as images: they are only ever painted into the sky plate (skyFill). The cirrus is a seamless
  // tile: three soft-edged patches are cut from it (different crops, so neighbouring patches differ)
  var FILL = { ha: null, o3: null, ci: [], ready: false };
  (function () {
    var left = 3;
    function done() { if (--left === 0) FILL.ready = true; }
    function img(name, cb) { var im = new Image(); im.onload = function () { cb(im); done(); }; im.onerror = function () { console.warn('nexus: filler failed', name); done(); }; im.src = '/static/assets/' + G2B + 'nebulae/' + name; }
    img('neb_ha.png', function (im) { FILL.ha = im; });
    img('neb_o3.png', function (im) { FILL.o3 = im; });
    img('neb_cirrus_tile.png', function (im) {
      [[0, 0], [0.37, 0.61], [0.71, 0.23]].forEach(function (o) {
        var S = 512, cv = document.createElement('canvas'); cv.width = cv.height = S; var x = cv.getContext('2d'), W = im.width, H = im.height;
        var ox = Math.round(o[0] * W), oy = Math.round(o[1] * H);
        for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) x.drawImage(im, dx * W - ox, dy * H - oy);   // the tile wraps
        x.globalCompositeOperation = 'destination-in';
        var g = x.createRadialGradient(S / 2, S / 2, S * 0.12, S / 2, S / 2, S / 2);
        g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(0.55, 'rgba(0,0,0,0.6)'); g.addColorStop(1, 'rgba(0,0,0,0)');
        x.fillStyle = g; x.fillRect(0, 0, S, S); FILL.ci.push(cv);
      });
    });
  })();
  function ringPlane(tex, color, opacity) {
    var m = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ map: tex, color: color, transparent: true, opacity: opacity, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }));
    m.rotation.x = Math.PI / 2; return m;
  }

  /* ============================== starfield ============================== */
  (function stars() {
    var N = 11000, pos = new Float32Array(N * 3), col = new Float32Array(N * 3), sz = new Float32Array(N), ph = new Float32Array(N);   // 2026-09-14: 7000 -> 11000 (one draw call either way)
    var c = new THREE.Color();
    for (var i = 0; i < N; i++) {
      var r = 2200 + Math.random() * 1800, th = Math.random() * Math.PI * 2, u = Math.random() * 2 - 1, s = Math.sqrt(1 - u * u);
      pos[i * 3] = r * s * Math.cos(th); pos[i * 3 + 1] = r * u * 0.9; pos[i * 3 + 2] = r * s * Math.sin(th);
      var w = Math.random(); c.setHSL(w < 0.7 ? 0.6 : w < 0.9 ? 0.08 : 0.9, 0.35, 0.72 + Math.random() * 0.25);
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      sz[i] = 1.2 + Math.pow(Math.random(), 3) * 5; ph[i] = Math.random() * 6.28;
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('size', new THREE.BufferAttribute(sz, 1));
    g.setAttribute('phase', new THREE.BufferAttribute(ph, 1));
    // ~6px cap at 4K (brief: "the starfield's gl_PointSize balloons at close range") — this is
    // background decoration on a 2200-4000 unit shell, it should never read as a bright close
    // subject even if a handful of its 7000 sprites happen to land near the camera's path
    scene.add(new THREE.Points(padAttrs(g), pointsMat(TEX_STAR, 0.0, 1.0, 6.0)));
  })();
  /* near dust: a second, sparser shell INSIDE the estate's envelope (450-1700 units from
     origin, i.e. threaded between the galaxies and the sun) so every camera move gets real
     parallax against the far starfield — the old single 2200-4000 shell barely shifts for a
     300-unit camera leg, which is why travel read as the scene sliding rather than the camera
     flying. Tiny (<=3px cap), faint, one extra draw call; nothing here is bright enough to be
     mistaken for a subject even when a mote drifts past the lens. */
  (function nearDust() {
    var N = 3400, pos = new Float32Array(N * 3), col = new Float32Array(N * 3), sz = new Float32Array(N), ph = new Float32Array(N);   // 2026-09-14: 1800 -> 3400, two depth bands for stronger parallax
    var c = new THREE.Color();
    for (var i = 0; i < N; i++) {
      var band = i % 3 === 0;                                   // a third of the motes sit in a nearer, faster-parallax band
      var r = band ? 300 + Math.pow(Math.random(), 0.8) * 500 : 450 + Math.pow(Math.random(), 0.7) * 1250;
      var th = Math.random() * Math.PI * 2, u = Math.random() * 2 - 1, s = Math.sqrt(1 - u * u);
      pos[i * 3] = r * s * Math.cos(th); pos[i * 3 + 1] = r * u * 0.55; pos[i * 3 + 2] = r * s * Math.sin(th);
      c.setHSL(Math.random() < 0.8 ? 0.58 : 0.1, 0.25, 0.7 + Math.random() * 0.2);
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      sz[i] = (band ? 0.5 : 0.7) + Math.pow(Math.random(), 2) * 2.2; ph[i] = Math.random() * 6.28;
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('size', new THREE.BufferAttribute(sz, 1));
    g.setAttribute('phase', new THREE.BufferAttribute(ph, 1));
    scene.add(new THREE.Points(padAttrs(g), pointsMat(TEX_DUST, 0.25, 0.42, 3.0)));
  })();

  /* one shader for every point cloud: per-vertex size + colour + twinkle phase,
     optional category focus (dims everything but one category). Geometries that
     have no category/glow still need the attributes (zero-filled) or the
     program upload throws. */
  function padAttrs(g) {
    var n = g.attributes.position.count;
    ['cat', 'glow'].forEach(function (k) { if (!g.attributes[k]) g.setAttribute(k, new THREE.BufferAttribute(new Float32Array(n), 1)); });
    return g;
  }
  function pointsMat(tex, twinkle, alpha, maxPx, hud) {
    return new THREE.ShaderMaterial({
      uniforms: { map: { value: tex }, uTime: U_TIME, uTw: { value: twinkle }, uAlpha: { value: alpha },
                  uFocus: { value: -1 }, uPR: U_PR, uCapK: U_CAPK, uCap: { value: maxPx || 240.0 }, uHud: hud ? U_HUD : { value: 0 }, uNF: { value: new THREE.Vector2(0, 0) } },
      vertexShader: [
        HUD_GLSL,
        'attribute float size; attribute float phase; attribute float cat; attribute float glow;',
        'uniform float uTime, uTw, uFocus, uPR, uCap, uCapK; uniform vec2 uNF; varying vec3 vC; varying float vA;',
        'void main(){ vC = color; vec4 mv = modelViewMatrix * vec4(position,1.0);',
        '  float tw = 1.0 + uTw * sin(uTime*1.7 + phase*7.0);',
        '  float f = (uFocus < 0.0 || abs(cat-uFocus) < 0.5) ? 1.0 : 0.22;',
        '  vA = f * (0.75 + 0.25*tw) ; float g = 1.0 + glow;',
        // capped per-pool (uCap): a single-guest category chapter can put the camera close
        // enough to one star that the uncapped 900/-z falloff blew it into a full-screen white
        // disc (this was the "core" blow-out seen close-up — it was actually a guest star
        // sprite, not a core). The background starfield uses a much tighter cap (~6px, see its
        // pointsMat() call) — it's meant to always read as distant background, but a handful of
        // its 7000 sprites can end up only a few hundred units from the camera by chance and,
        // uncapped (or capped only at 240), balloon into a big soft blob that visually swallows
        // the one tiny foreground star in a sparse (1-3 guest) chapter.
        '  gl_PointSize = min(uCap * uCapK, size * g * tw * uPR * (900.0 / -mv.z)); gl_Position = projectionMatrix * mv;',
        '  vA *= hudFade(gl_Position.xy / max(gl_Position.w, 0.001));',
        // uNF (optional): a pool that fades out near the lens instead of ballooning into out-of-focus discs (galaxy dust)
        '  if (uNF.y > 0.0) vA *= smoothstep(uNF.x, uNF.y, -mv.z); }'
      ].join('\n'),
      fragmentShader: [
        'uniform sampler2D map; uniform float uAlpha; varying vec3 vC; varying float vA;',
        'void main(){ vec4 t = texture2D(map, gl_PointCoord); gl_FragColor = vec4(vC * t.rgb, t.a * uAlpha * vA); }'
      ].join('\n'),
      vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
    });
  }

  /* guest stars as PHOTOGRAPHIC stars (2026-10-08b, docs/contracts.md): the point-spread function in the fragment shader instead
     of TEX_STAR's soft disc - a tight core that whitens like a saturated sensor, the category colour carried by the wing
     and the halo (so the legend still reads), and four faint diffraction spikes on the busiest guests only (glow, i.e. CPU,
     > 0.85), aligned with every other spike in the frame (SPIKE_ROT). The sprite is drawn 2.4x (3.4x with spikes) wider
     than the old disc so the halo has room; the core keeps the old apparent size. Same attributes and uniforms as
     pointsMat (category focus, fade, HUD keep-out, twinkle). */
  function psfMat(twinkle, alpha, maxPx, hud) {
    var m = pointsMat(TEX_STAR, twinkle, alpha, maxPx, hud);
    m.vertexShader = m.vertexShader.replace('varying vec3 vC; varying float vA;', 'varying vec3 vC; varying float vA; varying float vS;')
      .replace('  gl_PointSize = min(uCap * uCapK, size * g * tw * uPR * (900.0 / -mv.z)); gl_Position = projectionMatrix * mv;',
               '  vS = glow > 0.85 ? 3.4 : 2.4; gl_PointSize = min(uCap * uCapK * 1.5, size * g * tw * uPR * (900.0 / -mv.z) * vS); gl_Position = projectionMatrix * mv;');
    m.fragmentShader = [
      'uniform float uAlpha; varying vec3 vC; varying float vA; varying float vS;',
      'void main(){ vec2 q = gl_PointCoord * 2.0 - 1.0; float rq = dot(q, q); if (rq >= 1.0) discard;',
      '  vec2 p = q * vS; float r2 = dot(p, p);',                        // p: in units of the old disc's radius
      '  float e = 1.35 * exp(-r2 * 3.2) + 0.16 * exp(-r2 * 0.9) + 0.035 * exp(-sqrt(r2) * 0.9);',
      '  if (vS > 3.0) { float cs = cos(' + SPIKE_ROT.toFixed(3) + '), sn = sin(' + SPIKE_ROT.toFixed(3) + '); vec2 k = abs(vec2(cs * q.x + sn * q.y, -sn * q.x + cs * q.y));',
      '    e += 0.42 * (exp(-k.y * 70.0) * pow(1.0 - k.x, 2.4) + exp(-k.x * 70.0) * pow(1.0 - k.y, 2.4)); }',
      '  float w = exp(-r2 * 3.2);',
      '  vec3 col = vC * e + vec3(dot(vC, vec3(0.3, 0.55, 0.15))) * w * 0.7;',
      '  gl_FragColor = vec4(col * (1.0 - rq * rq), uAlpha * vA); }'
    ].join('\n');
    return m;
  }

  /* ============================== galaxies ============================== */
  var coreVS = 'varying vec3 vN; varying vec3 vP; varying vec2 vUv; void main(){ vN = normalize(normalMatrix*normal); vP = position; vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }';
  // c1 is the hot, near-white centre tone every core/planet/sun fades FROM (see coreC1() below);
  // c2 is the saturated node/accent colour it fades TO at the rim.
  var coreFS = [
    'varying vec3 vN; varying vec3 vP; varying vec2 vUv; uniform vec3 c1; uniform vec3 c2; uniform float pulse; uniform float t; uniform float near; uniform float mixPow; uniform float gain; uniform float lit;',
    // uMap/uHasMap (2026-09-19): baked equirect surface (sun granulation, planet maps) multiplied into the
    // body colour BEFORE the rim/near terms. Galaxy cores keep uHasMap 0. Every material using this shader
    // MUST carry both uniforms with a value object (r128 throws on an undefined uniform) - see coreUniforms().
    'uniform sampler2D uMap; uniform float uHasMap;',
    'void main(){ float facing = abs(dot(vN, vec3(0.0,0.0,1.0)));',                             // 1 dead centre, 0 grazing/silhouette
    '  float veins = sin(vP.x*0.31+t*0.6)*0.5 + sin(vP.y*0.27-t*0.4)*0.5 + sin(vP.z*0.35+vP.x*0.2)*0.5;',
    // TWO separate curves off the same facing ratio, because they need opposite shapes:
    // - rim (fixed exponent 2, silhouette-only) softens the actual geometric edge — that
    //   concentration right at the grazing angle is exactly right regardless of what's drawn,
    //   it's just anti-aliasing the mesh boundary, so it's shared by every use of this shader.
    // - colT (mixPow, PER-MATERIAL) controls how much of the disc reads as c1 vs c2. mixPow=2
    //   (sun, fabric planets — unchanged from the original, they already read fine) keeps c1
    //   dominant across most of the disc, same as the fresnel/rim-light look real stars have.
    //   Galaxy cores use a much lower mixPow (<1, see coreMat below) so c2 — the node's accent
    //   colour — dominates almost the whole disc instead, with c1 only at a small hot centre,
    //   per the brief ("small hot centre falling off into the accent colour", most of the area
    //   accent-coloured — NOT the sun-style "mostly hot colour, thin rim" proportions, which is
    //   what a first attempt at fixing this wrongly assumed applied everywhere).
    '  float rim = pow(1.0 - facing, 2.0);',
    '  float colT = pow(1.0 - facing, mixPow);',
    '  vec3 col = mix(c1, c2, clamp(colT*0.9 + pulse*0.5, 0.0, 1.0)) + veins*0.10*c2*max(colT, 0.2);',
    '  if (uHasMap > 0.5) col *= texture2D(uMap, vUv).rgb * 1.15;',
    // alpha fades at the rim (rides the fixed silhouette-only term) instead of being FLAT across
    // the whole disc — that flat alpha (every pixel centre-to-rim at the same opacity) was the
    // literal hard edge: a solid cutout against the background with no falloff at all. "near"
    // only trims this outer rim a little further as the camera closes in, so a close dwell shot
    // gets a SOFTER edge, never a dimmer centre — the old (1.0-0.7*near) multiplied the WHOLE
    // disc including dead centre, which is what flattened cores into a dull, uniform "moon".
    '  float a = 0.95 - rim * (0.5 + 0.3*near);',
    // a MILD close-range brightness trim (max -22% at full near, vs the old -70% that made
    // cores a dull moon): the post-bloom ACES grade now does the real highlight roll-off,
    // this just keeps the hot centre from saturating the bloom threshold in a close dwell
    // gain is per material: galaxy cores render deliberately ABOVE 1.0 (HDR) so the post-bloom
    // ACES grade rolls them off into a hot centre with a glowing body — at gain 1.0 they were
    // verified on screen to flatten into a matte disc once the grade took over from clipping
    // lit (planets only): a fixed key light from upper-left-front in view space, so the fabric
    // bodies read as shaded spheres — unlit, the same disc verified on screen as a flat pastel
    // coin at the WIRED/WIRELESS stops, with no cue that it was round at all
    '  float sh = mix(1.0, 0.28 + 0.72*max(dot(vN, normalize(vec3(-0.45,0.55,0.7))), 0.0), lit);',
    '  gl_FragColor = vec4(col*gain*sh*(1.0+pulse*0.7)*(1.0-0.22*near), clamp(a, 0.0, 1.0)); }'
  ].join('\n');
  // hot near-white centre tone for the galaxy cores specifically. Safe to lean this close to
  // white now that coreMat's mixPow (see below) keeps it confined to a small centre patch —
  // c2 (the node's accent colour, saturated) is what actually fills most of the disc. The sun
  // and fabric planets keep their own original, more muted c1 (mixPow 2 there, c1-dominant,
  // same proven look as before) and are left untouched.
  function coreC1(hex) { return new THREE.Color(hex).multiplyScalar(0.6).lerp(new THREE.Color(0xffffff), 0.62); }
  function coreUniforms(c1, c2, mixPow, gain, lit) {
    return { c1: { value: c1 }, c2: { value: c2 }, pulse: { value: 0 }, t: U_TIME, near: { value: 0 }, mixPow: { value: mixPow }, gain: { value: gain }, lit: { value: lit },
             uMap: { value: null }, uHasMap: { value: 0 } };
  }

  /* PHOTOGRAPHIC DISC. No "restraint" (desaturating the disc art in the shader and tinting it a muted grey-blue read
     as "3D rendered" next to vivid galaxies). The baked spiral keeps its full colour; a warm bulge tint in the middle
     eases into the system's accent tint on the arms (golden core, teal-green arms on an amber node), a contrast curve deepens the dust lanes and lifts the arm
     crests, and the pink HII knots in the art get a saturation lift. `diffuse` (the material colour) is the arm tint. */
  var WHITE = new THREE.Color(1, 1, 1), WARM = new THREE.Color(1.0, 0.82, 0.56);
  function armTint(hex) { return new THREE.Color(hex).lerp(WHITE, 0.3); }
  function bulgeTint(hex) { return WARM.clone().lerp(new THREE.Color(hex), 0.25); }
  function discGrade(mat, hex, gain, raw) {
    mat.userData.uCore = { value: bulgeTint(hex) }; mat.userData.uGain = { value: gain || 1.15 }; mat.userData.uRaw = { value: raw ? 1 : 0 };
    mat.onBeforeCompile = function (sh) {
      sh.uniforms.uCore = mat.userData.uCore; sh.uniforms.uGain = mat.userData.uGain; sh.uniforms.uRaw = mat.userData.uRaw;
      sh.fragmentShader = 'uniform vec3 uCore; uniform float uGain; uniform float uRaw;\n' + sh.fragmentShader.replace('#include <map_fragment>', [
        '#ifdef USE_MAP',
        '  vec4 texelColor = texture2D( map, vUv ); texelColor = mapTexelToLinear( texelColor );',
        '  vec3 col;',
        '  if (uRaw > 0.5) col = texelColor.rgb * uGain;',          // a shared plate: as rendered (galaxy2 manifest)
        '  else {',
        '    vec3 tx = pow(max(texelColor.rgb, 0.0), vec3(1.2)) * uGain;',
        '    float rr = length(vUv - 0.5) * 2.0;',
        '    vec3 tint = mix(uCore, diffuse, smoothstep(0.04, 0.42, rr));',
        // pink / magenta knots (red well above green AND blue above green): never the golden or teal arm light
        '    float pink = smoothstep(0.02, 0.12, tx.b - tx.g) * smoothstep(0.08, 0.24, tx.r - tx.g);',
        '    col = mix(tx * tint, tx * vec3(1.35, 0.6, 0.95), pink * 0.75);',
        '  }',
        '  diffuseColor = vec4(col, opacity * texelColor.a);',
        '#endif'].join('\n'));
    };
    return mat;
  }
  var RAW_GAIN = 1.45 / GRADE.exp;
  function setGalaxyTint(gal, hex) {
    if (!gal.nd.raw) { gal.discMat.color.copy(armTint(hex)); if (gal.discMat.userData.uCore) gal.discMat.userData.uCore.value.copy(bulgeTint(hex)); }
    gal.halo.material.color.copy(bulgeTint(hex).lerp(new THREE.Color(hex), 0.45));
    gal.bulgeC2 = new THREE.Color(1.0, 0.72, 0.4).lerp(new THREE.Color(hex), 0.3);
  }
  /* dust lanes as ABSORPTION (2026-10-08b): an additive-only galaxy can never show a dark lane in front of its own bulge
     or its stars, which is half of what makes a galaxy photo read as real. A second plane carries the disc art's local
     darkness (texel vs a mip-blurred neighbourhood: the lanes are darker than the light around them) and MULTIPLIES what
     is already drawn behind it by (1 - k), more in blue than red (dust reddening). Drawn after the galaxy's light (bulge,
     halo, haze, background) and before its guest stars, which stay data-bright. */
  /* the lane MASK is computed once per plate on the GPU (laneMask: a 512 px render of the formula below) so the per-frame
     absorption pass is a single small-texture fetch + discard (it was two fetches of the 2048 px plate: ~0.06 ms at a
     host stop) */
  var LANE_MASK = {};
  function laneMask(tex) {
    var key = tex.uuid; if (LANE_MASK[key]) return LANE_MASK[key];
    var rt = new THREE.WebGLRenderTarget(512, 512, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false });
    var mat = new THREE.ShaderMaterial({ uniforms: { map: { value: tex } }, depthTest: false, depthWrite: false,
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: [
        'uniform sampler2D map; varying vec2 vUv;',
        'void main(){ vec4 t = texture2D(map, vUv), b = texture2D(map, vUv, 4.0);',
        '  float lt = dot(t.rgb * t.a, vec3(0.3, 0.55, 0.15)), lb = dot(b.rgb * b.a, vec3(0.3, 0.55, 0.15)), rr = length(vUv - 0.5) * 2.0;',
        '  float d = clamp((lb - lt) / max(lb, 0.03) * 1.6, 0.0, 1.0) * smoothstep(0.015, 0.08, lb) * smoothstep(0.92, 0.3, rr) * smoothstep(0.03, 0.12, rr);',
        '  gl_FragColor = vec4(d, d, d, 1.0); }'
      ].join('\n') });
    var q = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat), sc0 = new THREE.Scene(); sc0.add(q);
    var prev = rndr.getRenderTarget(); rndr.setRenderTarget(rt); rndr.render(sc0, cam); rndr.setRenderTarget(prev);
    mat.dispose(); q.geometry.dispose();
    LANE_MASK[key] = rt.texture; return rt.texture;
  }
  function laneMat() {
    return new THREE.ShaderMaterial({
      uniforms: { map: { value: null }, uK: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: [
        'uniform sampler2D map; uniform float uK; varying vec2 vUv;',
        'void main(){ float d = texture2D(map, vUv).r * uK; if (d < 0.01) discard;',
        '  gl_FragColor = vec4(vec3(0.62, 0.74, 0.9) * d, 1.0); }'
      ].join('\n'),
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.ZeroFactor, blendDst: THREE.OneMinusSrcColorFactor
    });
  }
  /* the bulge (2026-10-08b): a soft, flattened glow instead of a hard-edged sphere. Additive; brightness falls to zero at
     the silhouette ((facing)^p on a sphere is a smooth bell on screen), the centre runs several times brighter than white
     (HDR) so the filmic curve gives a white-hot middle in a golden body - the luminous bulge of a galaxy photo. Same
     uniform names as coreFS (the loop drives c1/c2/pulse/near/gain the same way). */
  var bulgeFS = [
    'varying vec3 vN; varying vec3 vP; varying vec2 vUv; uniform vec3 c1; uniform vec3 c2; uniform float pulse; uniform float near; uniform float gain;',
    'void main(){ float f = abs(dot(normalize(vN), vec3(0.0, 0.0, 1.0)));',
    '  float body = pow(f, 3.2), hot = pow(f, 14.0);',
    '  vec3 col = mix(c2, c1, hot * 0.85 + 0.15 * body) * (0.5 * body + 1.6 * hot);',
    '  gl_FragColor = vec4(col * gain * (1.0 + pulse * 0.6) * (1.0 - 0.3 * near), 1.0); }'
  ].join('\n');
  // one GPU copy per disc file, however many galaxies wear it (growth reuses the two baked discs, rotated + re-tinted)
  var DISC_TEX = {};
  function discTex(file, cb) {
    var e = DISC_TEX[file];
    if (e) { if (e.t) cb(e.t); else e.w.push(cb); return; }
    e = DISC_TEX[file] = { t: null, w: [cb] };
    loadTex(file, function (t) { e.t = t; e.w.forEach(function (f) { f(t); }); e.w = null; });
  }
  // the lane absorption covers only the inner 0.82 of the plate (the lanes never reach the rim): a circle, uv in plate units
  var LANE_GEO = (function () {
    var g = new THREE.CircleGeometry(300 * 0.82, 56), uv = g.attributes.uv;
    for (var i = 0; i < uv.count; i++) uv.setXY(i, 0.5 + (uv.getX(i) - 0.5) * 0.82, 0.5 + (uv.getY(i) - 0.5) * 0.82);
    return g;
  })();
  var galaxies = {};
  function buildGalaxy(nd) {
    var O = new THREE.Group(); if (nd.pos) O.position.copy(nd.pos); else O.position.set(nd.x, 0, 0);
    if (nd.tilt) O.rotation.set(nd.tilt[0], nd.tilt[1], nd.tilt[2]); else O.rotation.set(0.62, 0, 0.16 * nd.spin);
    if (nd.scale) O.scale.setScalar(nd.scale);
    scene.add(O);
    var G = new THREE.Group(); O.add(G);                                  // G spins about its own axis inside the tilted O
    var acc = new THREE.Color(nd.accent);
    // baked disc (2026-09-19): the face-on spiral PNG on a 600x600 plane in G's XZ plane, additive, under the
    // dust/core/halo (renderOrder -2 so the transparent sort draws it first). Straight alpha, black between
    // arms, so additive blending only ever adds the arms. Opacity is driven per frame with the same `near`
    // damping the halo gets (discTick) and stays 0 until the texture has actually arrived.
    var discMat = discGrade(new THREE.MeshBasicMaterial({ map: null, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide,
                                                          color: nd.raw ? 0xffffff : armTint(nd.accent), alphaTest: 0.004 }), nd.accent, nd.raw ? RAW_GAIN : 0, nd.raw);
    var disc = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), discMat); disc.rotation.x = -Math.PI / 2; disc.rotation.z = nd.discRot || 0; disc.renderOrder = -2; G.add(disc);
    if (nd.discFlip) disc.scale.x = -1;
    // the dust lanes' absorption (laneMat): the same plane, drawn after the galaxy's own light, before its guest stars
    var lmat = laneMat(), lanes = new THREE.Mesh(LANE_GEO, lmat); lanes.rotation.copy(disc.rotation); lanes.scale.copy(disc.scale); lanes.renderOrder = 1; lanes.visible = false; G.add(lanes);
    if (nd.disc && !NXF.nodisc) discTex(nd.disc, function (t) { discMat.map = t; discMat.needsUpdate = true; lmat.uniforms.map.value = laneMask(t); lanes.visible = !NXF.nolanes; });
    /* stellar populations (2026-10-08b; the 2026-10-07 "cooler, quieter dust" undone): the A/C arm stars (accent toward
       white with radius) plus what a deep exposure of a spiral shows - a warm, dense bulge population, pink HII knots and
       blue-white young clusters strung along the arms, and globular clusters scattered in a round halo above and below the
       disc. HDR: knots and clusters run brighter than white, so they sparkle and only they reach the bloom. Seeded per
       galaxy (rng), so the same galaxy draws the same stars on every load. */
    var N = nd.N || 3200, pos = new Float32Array(N * 3), col = new Float32Array(N * 3), sz = new Float32Array(N), ph = new Float32Array(N);
    var c = new THREE.Color(), RG = rng(Math.floor(hash('gal:' + nd.id) * 4294967295));
    var BLUE = new THREE.Color(0.7, 0.84, 1.0), PINK = new THREE.Color(1.0, 0.4, 0.66), GLOB = new THREE.Color(1.0, 0.86, 0.66), aW = armTint(nd.accent);
    for (var i = 0; i < N; i++) {
      var arm = i % 2, u = RG(), r = 18 + Math.pow(u, 0.8) * 250, q = RG();
      var th = arm * Math.PI + r * 0.0165 + (RG() - 0.5) * (0.35 + u * 0.7), y = (RG() - 0.5) * 14 * (1 - u * 0.5), b, s;
      if (i % 9 === 0) {                                   // the diffuse disc haze (as A/C)
        th = RG() * TAU; r = RG() * 270; y = (RG() - 0.5) * 40;
        c.copy(acc).lerp(WHITE, 0.35 + u * 0.4); b = 0.35; s = 6 + RG() * 10;
      } else if (q < 0.1) {                                // bulge: warm, dense, a little puffed up
        r = 3 + Math.pow(RG(), 1.7) * 72; th = RG() * TAU; y = (RG() - 0.5) * 34 * (1 - r / 85);
        c.copy(WARM).lerp(acc, 0.12); b = 0.55 + RG() * 0.55; s = 1.2 + RG() * 2.4;
      } else if (q < 0.135) {                              // HII knots on the arm crests
        c.copy(PINK); b = 1.2 + RG() * 1.1; s = 3.2 + RG() * 4.2; y *= 0.5;
      } else if (q < 0.165) {                              // young blue clusters
        c.copy(BLUE); b = 1.5 + RG() * 1.3; s = 2.2 + RG() * 3; y *= 0.5;
      } else if (q < 0.18) {                               // globular clusters in the halo
        var gr = 80 + RG() * 240, ga = RG() * TAU, gc0 = 2 * RG() - 1, gs0 = Math.sqrt(1 - gc0 * gc0);
        r = gr * gs0; th = ga; y = gr * gc0 * 0.75;
        c.copy(GLOB); b = 0.9 + RG() * 0.7; s = 2.2 + RG() * 1.8;
      } else {                                             // arm and disc stars: the A/C colours, bluer toward the rim
        c.copy(acc).lerp(WHITE, 0.35 + u * 0.4).lerp(BLUE, 0.3 * u); if (q > 0.93) c.copy(aW).lerp(WHITE, 0.5);
        b = 0.5 + RG() * 0.5; s = 1.5 + RG() * 3.5;
      }
      pos[i * 3] = Math.cos(th) * r; pos[i * 3 + 1] = y; pos[i * 3 + 2] = Math.sin(th) * r;
      col[i * 3] = c.r * b; col[i * 3 + 1] = c.g * b; col[i * 3 + 2] = c.b * b;
      sz[i] = s; ph[i] = RG() * 6.28;
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('size', new THREE.BufferAttribute(sz, 1)); g.setAttribute('phase', new THREE.BufferAttribute(ph, 1));
    // (a shared plate carries its own stars: the populations stay, fainter, for the depth they give a moving camera)
    var dust = new THREE.Points(padAttrs(g), pointsMat(TEX_DUST, 0.15, nd.raw ? 0.3 : 0.55)); G.add(dust);
    if (HDR) dust.material.uniforms.uNF.value.set(70, 260);
    /* nebula haze (A/C opacity restored: 0.07 -> 0.16): the inner seven as before, now with wispy cloud texture on the odd
       ones; plus an outer ring of five large faint clouds that carry the galaxy's glow out into the space around it, so a
       wide shot has the galaxies' own haze between them instead of black (docs/contracts.md) */
    var hazeOut = [];
    for (var k = 0; k < (NXF.nohaze ? 7 : 12); k++) {
      var outer = k >= 7, kk = outer ? k - 7 : k;
      var sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: (k % 2 || outer) ? TEX_NEBS[k % 3] : TEX_NEB, color: acc.clone().lerp(new THREE.Color(k % 2 ? 0x6d2b79 : 0x1c3a5e), outer ? 0.35 : 0.5),
                                                           transparent: true, opacity: outer ? 0.1 : (nd.raw ? 0.07 : 0.16), depthWrite: false, blending: THREE.AdditiveBlending, rotation: RG() * TAU, alphaTest: 0.003 }));
      var a = outer ? kk / 5 * TAU + 0.6 : kk / 7 * TAU, rr = outer ? 300 + RG() * 120 : 60 + kk * 28;
      sp.position.set(Math.cos(a) * rr, (RG() - 0.5) * (outer ? 60 : 20), Math.sin(a) * rr); var ss = outer ? 340 + RG() * 160 : 180 + kk * 40; sp.scale.set(ss, ss, 1); G.add(sp);
      if (outer) { sp.userData.op = sp.material.opacity; hazeOut.push(sp); }
    }
    // core — mixPow lowered from 0.55: verified on screen that on a node with a lot of memory
    // in use (coreR is driven by it) 0.55 still let the near-white c1 dominate out past half
    // the disc radius, i.e. the "small hot centre, mostly accent colour" proportions were only
    // true in miniature (a small node's small coreR hid the same ratio problem).
    // 0.22 confines c1 to roughly the inner third of the radius; the abs projected SIZE is
    // separately capped in the render loop (see coreR-independent max-angle clamp on g.core).
    // nd.hot (THE EDGE): a saturated orange centre (only 30% toward white) instead of coreC1's near-white, so the
    // core reads orange against the violet arms rather than as another white-hot dot
    var c1 = nd.hot ? new THREE.Color(nd.hot).lerp(new THREE.Color(0xffffff), 0.3) : coreC1(nd.accent);
    var coreMat;
    if (HDR) {   // the luminous bulge (bulgeFS): white-hot centre, golden body, no edge
      c1 = nd.hot ? new THREE.Color(nd.hot).lerp(WHITE, 0.4) : new THREE.Color(1.0, 0.95, 0.86);
      // (over a shared plate, whose own core is white-hot by design, the bulge is a soft volume: gain 0.9, not 2.4)
      coreMat = new THREE.ShaderMaterial({ uniforms: coreUniforms(c1, nd.hot ? new THREE.Color(nd.hot) : new THREE.Color(1.0, 0.72, 0.4).lerp(acc, 0.3), 0.22, nd.raw ? 0.9 : 2.4, 0), vertexShader: coreVS, fragmentShader: bulgeFS,
                                           transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor });
    } else coreMat = new THREE.ShaderMaterial({ uniforms: coreUniforms(c1, acc.clone(), nd.hot ? 0.6 : 0.22, 1.6, 0), vertexShader: coreVS, fragmentShader: coreFS, transparent: true });
    var core = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 4), coreMat); G.add(core);
    var halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: TEX_GLOW, color: nd.hot ? new THREE.Color(nd.hot).lerp(acc, 0.25) : bulgeTint(nd.accent).lerp(acc, 0.45), transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending })); G.add(halo);
    // a galaxy added at runtime (growth) gets no PointLight: a new light changes every lit program's light count, a
    // recompile hitch for nothing (no material on this page is lit by it); the loop writes the same fields either way
    var light = nd.noLight ? { intensity: 0, color: new THREE.Color(nd.accent) } : new THREE.PointLight(nd.accent, 2.5, 900); if (!nd.noLight) G.add(light);
    // beat shockwave: a soft textured annulus on a plane (see ringTex) instead of a hairline
    // RingGeometry — scale is applied in the render loop as its radius, exactly as before
    var ring = ringPlane(TEX_RING, acc, 0); G.add(ring);
    // guest stars: fixed pool of 160, filled on data
    var GN = 160, gp = new Float32Array(GN * 3), gc = new Float32Array(GN * 3), gs = new Float32Array(GN), gph = new Float32Array(GN), gcat = new Float32Array(GN), ggl = new Float32Array(GN);
    var gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.BufferAttribute(gp, 3)); gg.setAttribute('color', new THREE.BufferAttribute(gc, 3));
    gg.setAttribute('size', new THREE.BufferAttribute(gs, 1)); gg.setAttribute('phase', new THREE.BufferAttribute(gph, 1));
    gg.setAttribute('cat', new THREE.BufferAttribute(gcat, 1)); gg.setAttribute('glow', new THREE.BufferAttribute(ggl, 1));
    gg.setDrawRange(0, 0);
    var guests = new THREE.Points(gg, HDR && !NXF.nopsf ? psfMat(0.08, 1.0) : pointsMat(TEX_STAR, 0.08, 1.0)); guests.frustumCulled = false; guests.renderOrder = 2; G.add(guests);
    // the same galaxy seen edge-on (a shared variant plate): a camera-facing quad, plate-wide, laid along the disc's major
    // axis on screen (edgeOnTick); in the scene root because its orientation is the camera's, not the galaxy's
    var eo = null;
    if (nd.edgeon && !NXF.noedgeon) {
      var eoMat = discGrade(new THREE.MeshBasicMaterial({ map: null, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide, color: 0xffffff }), nd.accent, RAW_GAIN, true);
      eo = new THREE.Mesh(new THREE.PlaneGeometry(1, 0.25), eoMat); eo.renderOrder = -2; eo.visible = false; eo.frustumCulled = false; scene.add(eo);
      loadTex(nd.edgeon, function (t) { eoMat.map = t; eoMat.needsUpdate = true; });
    }
    if (HDR) guests.material.uniforms.uNF.value.set(30, 120);       // a star the camera flies past fades instead of filling the frame   // same zero-sphere trap as the comet pool; after the lane absorption (data stays bright)
    return { nd: nd, O: O, G: G, dust: dust, disc: disc, discMat: discMat, lanes: lanes, laneMat: lmat, core: core, coreMat: coreMat, halo: halo, light: light, ring: ring, ringT: 9, ringRed: 0, guests: guests, gg: gg,
             gp: gp, gc: gc, gs: gs, gcat: gcat, ggl: ggl, list: [], spin: 0.02, coreR: 22, world: O.position.clone(),
             bulgeC2: nd.hot ? new THREE.Color(nd.hot) : new THREE.Color(1.0, 0.72, 0.4).lerp(acc, 0.3), hazeOut: hazeOut, eo: eo, eoK: 1, haloK: nd.raw ? 0.5 : 1 };
  }
  NODES.forEach(function (nd, i) { galaxies[nd.id] = buildGalaxy(nd); galaxies[nd.id].obIdx = i; });
  // discF: a disc whose texture lands after the reveal fades in over ~1 s instead of popping
  // 2026-10-08b: opacity back to the A/C 0.6 (the 2026-10-07 restraint had it at 0.42); the lanes' absorption rides the same fade
  /* a shared plate: opacity 1.0 for the SUBJECT, 0.6 for a galaxy that is only in the frame (the asset owner's 1.0 /
     0.55-0.75; at the internet edge the right-hand galaxy's disc fills the foreground and would bury the edge's labels), eased
     with the director's stop; held down less up close (0.35, not 0.55: it is the galaxy) */
  var TVL = { halo: 1, core: 1 };   // QA look knobs (NEXUS.TVL)
  var DISC_OP = 0.6, DISC_OP_RAW = 1.0, LANE_K = 0.5;
  function discSubject(gal) {
    var k = D.stopKey; if (!k || /^over/.test(k)) return true;
    var id = gal === EDGE ? 'edge' : gal.nd.id, t = String(k).split(/[:>]/);
    return id === 'edge' ? /^(wan|edge|audience)/.test(k) : t.indexOf(id) >= 0;
  }
  function discTick(gal, near, dt) {
    if (gal.discMat.map && (gal.discF || 0) < 1) gal.discF = Math.min(1, (gal.discF || 0) + dt);
    var f = gal.discMat.map ? smooth(gal.discF || 0) : 0, raw = gal.nd.raw, k = gal.eoK == null ? 1 : gal.eoK;
    var inside = 1;
    if (raw) {
      gal.subjK = gal.subjK == null ? 1 : gal.subjK; gal.subjK += ((discSubject(gal) ? 1 : 0) - gal.subjK) * Math.min(1, dt / 0.8);
      /* a photograph of a whole galaxy cannot be seen from INSIDE it: with the camera within the disc's footprint and
         near its plane (the stream legs, the network-core stop beside the gpu galaxy) the plate fades away and the
         galaxy's own 3D stars carry it - otherwise a hugely magnified plate washed the frame grey */
      _eN.set(0, 1, 0).applyQuaternion(gal.O.quaternion); _eV.subVectors(cam.position, gal.world);
      var hh = Math.abs(_eV.dot(_eN)), ip = Math.sqrt(Math.max(0, _eV.lengthSq() - hh * hh)), Rg = 282 * (gal.nd.scale || 1);
      inside = 1 - (1 - smooth((ip - 0.9 * Rg) / (0.6 * Rg))) * (1 - smooth(hh / (1.4 * Rg))); inside *= inside;
    }
    var base = (raw ? DISC_OP_RAW * (1 - 0.35 * near) * lerp(0.6, 1, gal.subjK) * inside : DISC_OP * (1 - 0.55 * near)) * f;
    gal.discMat.opacity = base * k;
    // a faded plate is not drawn at all (seen from inside a disc it covered the whole frame for nothing: +0.08 ms)
    gal.disc.visible = base * k > 0.003;
    if (gal.eo) { gal.eo.material.opacity = base * (1 - k); gal.eo.visible = !!gal.eo.material.map && base * (1 - k) > 0.003 && gal.O.visible; }
    if (gal.laneMat) { gal.laneMat.uniforms.uK.value = LANE_K * f * k * (raw ? inside : 1) * (gal.O.visible ? 1 : 0); gal.lanes.visible = !!gal.laneMat.uniforms.map.value && !NXF.nolanes && gal.laneMat.uniforms.uK.value > 0.005; }
  }
  /* edge-on: within ~20 degrees of edge-on a flat disc collapses to a line, so the plate cross-fades into the same
     galaxy's edge-on view (a camera-facing quad, plate-wide, its major axis along the disc's line of nodes on screen and
     its near side at the bottom when the camera is above the disc, as the asset is drawn) */
  var _eN = new THREE.Vector3(), _eV = new THREE.Vector3(), _eF = new THREE.Vector3(), _eU = new THREE.Vector3(), _eM = new THREE.Vector3(), _eB = new THREE.Matrix4();
  function edgeOnTick(g) {
    if (!g.eo) { g.eoK = 1; return; }
    _eN.set(0, 1, 0).applyQuaternion(g.O.quaternion);
    _eV.subVectors(g.world, cam.position).normalize();
    var e = Math.abs(_eN.dot(_eV)), k = smooth((e - 0.17) / 0.17); g.eoK = k;
    if (k > 0.999) return;
    _eF.copy(_eV).addScaledVector(_eN, -_eN.dot(_eV)).normalize();              // the disc's far side, in its plane
    _eU.copy(_eF).addScaledVector(_eV, -_eF.dot(_eV)).normalize();              // ... on screen: the image's top
    _eM.crossVectors(_eV, _eU).normalize();
    _eB.makeBasis(_eM, _eU, _eV.negate()); g.eo.quaternion.setFromRotationMatrix(_eB);
    var w = 600 * (g.nd.scale || 1); g.eo.scale.set(w, w, 1); g.eo.position.copy(g.world);
  }
  /* THE EDGE galaxy itself (see EDGE_POS). Own dust/disc/core/halo from the same builder; its guest-star pool
     is repurposed as the measured EDGE stars (fillEdgeStars). Never in NODES: nothing that iterates NODES
     (hud, overview bounds, lockstep host/blk stops) should ever see it. */
  var EDGE = buildGalaxy({ id: 'edge', label: 'THE EDGE', accent: EDGE_ACC, hot: EDGE_HOT, pos: EDGE_POS, scale: EDGE_SCALE, tilt: [1.15, 0, 0.5], disc: G2 ? G2P.edge.file : 'galaxy_edge.png',
                           discRot: G2 ? G2P.edge.rot : 0, raw: G2, spin: 1, N: 2400 });
  EDGE.coreR = 30; EDGE.spin = 0.012; EDGE.light.intensity = 0;
  // gain trimmed: verified at THE EDGE stop that the builder's HDR core gain + the orange c1 still summed (with the
  // halo and bloom) to a flat white coin; at this gain the ACES grade leaves the centre orange-hot
  EDGE.coreMat.uniforms.gain.value = 0.75;

  /* ============================== DEEP SKY (2026-10-08c, docs/contracts.md / §8a) ==============================
     When it zooms out the screen should be filled: busy, but clean. The negative space is filled with REAL deep-sky content - never UI, never text - all seeded (the same sky on every load),
     additive and faint enough to stay behind the estate; since 2026-10-08c it is the SHARED set (static/assets/galaxy2,
     the same objects the wall shows):
       SKY          the shared deep-sky plate (see THE SKY above), turned so both wide shots have its band and landmarks at
                    their edges and dark sky behind the galaxies
       DEEP FIELD   ~40 background galaxies (inclined and edge-on spirals, lenticulars, irregulars, ellipticals) at
                    opacity 0.3-0.6, a few at a quarter to a half of a system galaxy's apparent size, the rest small, on a
                    far shell (3000-4300 from the estate centre) and stratified behind the two wide frames; plus ~90 tiny
                    soft ellipticals for depth (the plate holds the thousands of smallest ones); faded out near the lens
       CLUSTERS     globular, open (in its blue reflection nebula) and embedded (in its HII bubble) clusters at 0.5-0.9 in
                    the middle distance, in the negative space of the wide frames
       FILLERS      the nebula fillers, painted into the plate where a wide frame would still be a void (skyFill)
       BRIGHT STARS a handful of foreground stars with the shared photographic PSF (spikes '+' on the brightest) */
  var DEEP = { gals: [], clu: [], wide: [], ready: false };
  (function deepSky() {
    if (NXF.nodeep) { DEEP.ready = true; return; }
    var R = rng(20261008), _d = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _n = new THREE.Vector3();
    // the two wide shots' poses (overviewShot() itself is not callable yet: the director section is below)
    var tV = Math.tan((cam.fov * Math.PI / 180) / 2), tH = tV * (innerWidth / Math.max(1, innerHeight));
    function frame(pos, look) {
      var F = look.clone().sub(pos).normalize(), Rt = new THREE.Vector3().crossVectors(F, new THREE.Vector3(0, 1, 0)).normalize(), U = new THREE.Vector3().crossVectors(Rt, F);
      // a point behind the frame at screen (sx, sy) in [-1, 1], at distance dist from its camera
      return { pos: pos, F: F, R: Rt, U: U, tH: tH, tV: tV, at: function (sx, sy, dist, out) { return out.copy(pos).addScaledVector(F, dist).addScaledVector(Rt, sx * tH * dist).addScaledVector(U, sy * tV * dist); } };
    }
    var ovL = galaxies[NA.id].world.clone().add(galaxies[NB.id].world).multiplyScalar(0.5);
    var OV = frame(ovL.clone().addScaledVector(new THREE.Vector3(0, 0.4, 1).normalize(), 1550), ovL);
    var WAN = frame(new THREE.Vector3(430, 240, 640), SUN.clone().lerp(EDGE_POS, 0.28));
    DEEP.wide = [OV, WAN];
    function farFromEdge(p) { return p.distanceTo(EDGE_POS) > 1100 && p.distanceTo(SUN) > 700; }
    function onShell(rr, out) { var u = R() * 2 - 1, th = R() * TAU, s = Math.sqrt(1 - u * u); return out.set(rr * s * Math.cos(th), rr * u * 0.8, rr * s * Math.sin(th)); }
    var dfVS = [
      'attribute vec3 tint; varying vec3 vC; varying vec2 vUv;',
      'void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vC = tint * smoothstep(500.0, 1500.0, -mv.z); gl_Position = projectionMatrix * mv; }'
    ].join('\n');
    // straight alpha: rgb x a is the light (the shared assets' convention); tint = white x opacity (x a colour for TEX_ELL)
    var dfFS = 'uniform sampler2D map; varying vec3 vC; varying vec2 vUv; void main(){ vec4 t = texture2D(map, vUv); if (t.a < 0.004) discard; gl_FragColor = vec4(vC * t.rgb * t.a, 1.0); }';
    // one draw per texture: camera-facing-ish quads (they face the estate centre; at 3000+ that is every stop's view)
    function quads(list, file, tex, order) {
      var n = list.length, P = new Float32Array(n * 12), UV = new Float32Array(n * 8), T = new Float32Array(n * 12), I = [], corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
      list.forEach(function (q, i) {
        _n.copy(q.p).normalize().negate(); _a.set(0, 1, 0).cross(_n).normalize(); _b.crossVectors(_n, _a);
        var ca = Math.cos(q.rot), sa = Math.sin(q.rot), fl = q.flat || 1;
        var ax = _a.clone().multiplyScalar(ca * q.size).addScaledVector(_b, sa * q.size), bx = _a.clone().multiplyScalar(-sa * q.size * fl).addScaledVector(_b, ca * q.size * fl);
        for (var k = 0; k < 4; k++) {
          var o = (i * 4 + k) * 3;
          P[o] = q.p.x + ax.x * corners[k][0] + bx.x * corners[k][1]; P[o + 1] = q.p.y + ax.y * corners[k][0] + bx.y * corners[k][1]; P[o + 2] = q.p.z + ax.z * corners[k][0] + bx.z * corners[k][1];
          UV[(i * 4 + k) * 2] = corners[k][0] * 0.5 + 0.5; UV[(i * 4 + k) * 2 + 1] = corners[k][1] * 0.5 + 0.5;
          T[o] = q.c[0]; T[o + 1] = q.c[1]; T[o + 2] = q.c[2];
        }
        I.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
      });
      var g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(P, 3)); g.setAttribute('uv', new THREE.BufferAttribute(UV, 2)); g.setAttribute('tint', new THREE.BufferAttribute(T, 3)); g.setIndex(I);
      var mat = new THREE.ShaderMaterial({ uniforms: { map: { value: tex || null } }, vertexShader: dfVS, fragmentShader: dfFS, transparent: true, depthWrite: false, side: THREE.DoubleSide,
                                           blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor });
      var m = new THREE.Mesh(g, mat); m.renderOrder = order; m.frustumCulled = false; m.visible = !!tex; scene.add(m);
      if (file) loadTex(file, function (t) { mat.uniforms.map.value = t; m.visible = true; });
      return m;
    }
    // where an object goes: a third behind the overview frame, a third behind the internet-edge frame, a third anywhere
    function place(i, r0, r1, sxK, out) {
      for (var tries = 0; tries < 10; tries++) {
        var w = i % 3, dist = r0 + R() * (r1 - r0);
        if (w < 2) DEEP.wide[w].at((R() * 2 - 1) * sxK, (R() * 2 - 1) * sxK, dist, out); else onShell(dist, out);
        if (farFromEdge(out) && out.distanceTo(galaxies[NA.id].world) > 600 && out.distanceTo(galaxies[NB.id].world) > 600) break;
      }
      return out;
    }
    // ---- deep field: the shared background galaxies ----
    // (plus one in each corner cell of the two wide frames: the vignettes make the corners the darkest cells)
    var CORN = [];
    DEEP.wide.forEach(function (fr) { [[-0.8, 0.72], [0.8, 0.72], [-0.8, -0.72], [0.8, -0.72]].forEach(function (c) { CORN.push(fr.at(c[0] + (R() - 0.5) * 0.12, c[1] + (R() - 0.5) * 0.12, 3500 + R() * 400, new THREE.Vector3())); }); });
    [['bg/bg_spiral_inclined.png', 9], ['bg/bg_spiral_edgeon.png', 7], ['bg/bg_lenticular.png', 8], ['bg/bg_irregular.png', 8], ['bg/bg_elliptical.png', 9]].forEach(function (b, bi) {
      var list = [];
      for (var i = 0; i < b[1]; i++) {
        var big = i < 2, op = 0.3 + 0.3 * R();
        // half-size in world units on the 3000-4300 shell: two landmarks per kind (a quarter to a half of a system
        // galaxy's apparent size in the overview), the rest small
        list.push({ p: place(i, 3000, 4300, 1.05, new THREE.Vector3()), size: big ? 140 + 100 * R() : 35 + Math.pow(R(), 1.6) * 90, rot: R() * TAU, c: [op, op, op] });
      }
      CORN.forEach(function (p, ci) { if (ci % 5 === bi && farFromEdge(p)) { var op2 = 0.45 + 0.1 * R(); list.push({ p: p, size: 70 + 30 * R(), rot: R() * TAU, c: [op2, op2, op2] }); } });
      DEEP.gals.push(quads(list, G2B + b[0], null, -50));
    });
    (function () {   // the tiny soft ellipticals: warm smudges a few px across
      var list = [];
      for (var i = 0; i < 90; i++) {
        var br = 0.18 + 0.36 * Math.pow(R(), 2), warm = R() < 0.7;
        list.push({ p: place(i, 3200, 4400, 1.08, new THREE.Vector3()), size: 6 + Math.pow(R(), 3) * 30, rot: R() * TAU, flat: 0.55 + 0.45 * R(),
                    c: warm ? [br, 0.88 * br, 0.72 * br] : [0.8 * br, 0.88 * br, br] });
      }
      DEEP.gals.push(quads(list, null, TEX_ELL, -50));
    })();
    // ---- clusters: the shared globular / open / embedded sprites in the middle distance, in the wide frames' negative space ----
    // (sizes: half-widths in world units; the embedded cluster's HII bubble is the loudest of the three - smallest, faintest)
    [['clusters/cluster_globular.png', 4, 40, 75, 0.5, 0.9], ['clusters/cluster_open.png', 4, 60, 110, 0.5, 0.85], ['clusters/cluster_embedded.png', 3, 40, 70, 0.4, 0.6]].forEach(function (c) {
      var list = [];
      for (var i = 0; i < c[1]; i++) {
        var op = c[4] + (c[5] - c[4]) * R();
        // the frames' outer band (|s| 0.7-1.0): their middles are the galaxies'
        var a2 = R() * TAU, rr2 = 0.72 + 0.3 * R(), w = i % 3, dist = 2600 + R() * 1200;
        for (var tries = 0; tries < 10; tries++) {
          if (w < 2) DEEP.wide[w].at(Math.cos(a2) * rr2, Math.sin(a2) * rr2 * 0.9, dist, _d); else onShell(dist, _d);
          if (farFromEdge(_d) && _d.distanceTo(galaxies[NA.id].world) > 600 && _d.distanceTo(galaxies[NB.id].world) > 600) break;
          a2 = R() * TAU;
        }
        list.push({ p: _d.clone(), size: c[2] + (c[3] - c[2]) * R(), rot: R() * TAU, c: [op, op, op] });
      }
      DEEP.clu.push(quads(list, G2B + c[0], null, -30));
    });
    // ---- a handful of bright foreground stars with the photographic PSF (+ spikes on the three brightest) ----
    if (HDR) for (var bs = 0; bs < 6; bs++) {
      var p3 = new THREE.Vector3();
      for (var t3 = 0; t3 < 8; t3++) { if (bs % 3) onShell(2400 + R() * 900, p3); else OV.at((R() * 2 - 1) * 0.9, (R() * 2 - 1) * 0.85, 2600 + R() * 800, p3); if (farFromEdge(p3)) break; }
      var warmS = R() < 0.5, cs = warmS ? [1.0, 0.86, 0.7] : [0.78, 0.88, 1.0], kk = 1100 + R() * 1000;
      mkGlare({ pos: p3, r: 0, k: kk, min: 8, max: 54, color: new THREE.Color(cs[0], cs[1], cs[2]).multiplyScalar(1.4), spike: bs < 3, spikeK: 2.0, spikeA: 0.26 });
    }
    DEEP.ready = true;
  })();
  /* the nebula FILLERS, painted into the sky plate once (no per-frame cost): first the VOIDS - each wide frame's 6 x 4
     cells, sampled through a small copy of the plate at the wide-shot level (the same test as the QA grid: mean display
     luma and the share of visibly bright pixels), skipping the cells a galaxy fills; then one filler per void cell -
     mostly the neutral cirrus, an H-alpha or OIII filler in a few - at a subordinate level. Equirect mapping of
     SphereGeometry (u = atan2(z, -x) / 2pi, row = polar angle) in the sphere's own (rotated) frame; the decoded plate is
     already flipped for upload (flipY false), so canvas rows count from the SOUTH pole. 'lighter' = additive. */
  function skyVoids(bmp, flipped) {
    var w = 512, h = 256, cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    var x = cv.getContext('2d'); x.drawImage(bmp, 0, 0, w, h);
    var px = x.getImageData(0, 0, w, h).data, qi = sky.quaternion.clone().invert(), d = new THREE.Vector3(), out = []; SKY.cells = [];
    var gain = SKY.wide * 1.45;                    // plate value -> pre-ACES radiance at the wide shots (exposure folded in)
    // what the screen shows at (sx, sy) for that sky: the grade (ACES, mid-tone S, vignette) and the page's CSS vignette
    // (#vig: the top and bottom bands under the HUD, the corner ellipse), so the test matches the QA grid on the frame
    function lum(dir, sx, sy) {
      d.copy(dir).applyQuaternion(qi);
      var th = Math.acos(clamp(d.y, -1, 1)), ph = Math.atan2(d.z, -d.x); if (ph < 0) ph += TAU;
      var ix = Math.min(w - 1, Math.floor(ph / TAU * w)), iy = Math.min(h - 1, Math.floor((flipped ? 1 - th / Math.PI : th / Math.PI) * h)), o = (iy * w + ix) * 4;
      var v = (0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2]) / 255 * gain;
      var c = clamp((v * (2.51 * v + 0.03)) / (v * (2.43 * v + 0.59) + 0.14), 0, 1); c += (c * c * (3 - 2 * c) - c) * GRADE.con;
      var qx = sx * 0.5, qy = sy * 0.5, yt = (1 - sy) / 2, re = Math.sqrt(sx * sx + sy * sy) / Math.SQRT2;
      c *= 1 - GRADE.vig * clamp((qx * qx + qy * qy - 0.16) / 0.34, 0, 1);
      c *= (1 - 0.45 * clamp(1 - yt / 0.09, 0, 1)) * (1 - 0.5 * clamp(1 - (1 - yt) / 0.12, 0, 1)) * (1 - 0.2 * clamp((re - 0.62) / 0.38, 0, 1));
      return 255 * c;
    }
    // a cell a galaxy's disc fills is not a void: its centre ray hits the disc plane inside 0.85 of the disc's radius
    var gals = NODES.map(function (n) { return galaxies[n.id]; }).concat([EDGE]).map(function (g) { g.O.updateMatrixWorld(true); return { c: g.world, n: new THREE.Vector3(0, 1, 0).applyQuaternion(g.O.quaternion), r: 0.85 * 300 * (g.nd.scale || 1) }; });
    function onDisc(g, pos, dir) { var dn = dir.dot(g.n); if (Math.abs(dn) < 1e-4) return false; var t = g.c.clone().sub(pos).dot(g.n) / dn; return t > 0 && pos.clone().addScaledVector(dir, t).distanceTo(g.c) < g.r; }
    DEEP.wide.forEach(function (fr, fi) {
      for (var j = 0; j < 4; j++) for (var i = 0; i < 6; i++) {
        var sx0 = -1 + (i + 0.5) / 3, sy0 = 1 - (j + 0.5) / 2, sum = 0, n = 0, bright = 0, filled = false;
        var cdir = fr.F.clone().addScaledVector(fr.R, sx0 * fr.tH).addScaledVector(fr.U, sy0 * fr.tV).normalize();
        gals.forEach(function (g) { if (onDisc(g, fr.pos, cdir)) filled = true; });
        if (filled) continue;
        for (var b = 0; b < 6; b++) for (var a = 0; a < 8; a++) {
          var sx = -1 + (i + (a + 0.5) / 8) / 3, sy = 1 - (j + (b + 0.5) / 6) / 2;
          var L = lum(fr.F.clone().addScaledVector(fr.R, sx * fr.tH).addScaledVector(fr.U, sy * fr.tV).normalize(), sx, sy); sum += L; n++; if (L > 24) bright++;
        }
        var mean = sum / n, cont = bright / n;
        SKY.cells.push([fi, i, j, +mean.toFixed(1), +(100 * cont).toFixed(1)]);
        if (mean < 12 && cont < 0.06) out.push({ dir: cdir, frame: fi, i: i, j: j, mean: mean, edge: Math.max(Math.abs(sx0) / 0.84, Math.abs(sy0) / 0.75) });
      }
    });
    return out;
  }
  function skyFill(bmp, flipped, done) {
    try {
      var t0 = performance.now(), W = bmp.width, H = bmp.height, voids = skyVoids(bmp, flipped); SKY.voids = voids;
      if (!voids.length || !FILL.ready) { SKY.fillers = 0; return done(null); }
      var cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      var x = cv.getContext('2d'); x.drawImage(bmp, 0, 0); x.globalCompositeOperation = 'lighter';
      var qi = sky.quaternion.clone().invert(), d = new THREE.Vector3(), R = rng(9113), cellA = 2 * Math.atan(DEEP.wide[0].tH) / 6, nHa = 0, nO3 = 0;
      function at(dir, ang) {
        d.copy(dir).applyQuaternion(qi);
        var th = Math.acos(clamp(d.y, -1, 1)), ph = Math.atan2(d.z, -d.x); if (ph < 0) ph += TAU;
        return { cx: ph / TAU * W, cy: (flipped ? 1 - th / Math.PI : th / Math.PI) * H, rh: ang / Math.PI * H, rw: ang / TAU * W / Math.max(0.25, Math.sin(th)) };
      }
      function paint(q, img, a, rot, flip) {
        [-W, 0, W].forEach(function (wrap) {
          if (q.cx + wrap + q.rw < 0 || q.cx + wrap - q.rw > W) return;
          // canvas alpha tops out at 1: a level above it is drawn in passes ('lighter' adds them up)
          for (var left = a; left > 0.004; left -= 1) {
            x.save(); x.translate(q.cx + wrap, q.cy); x.rotate(rot); x.scale(flip ? -1 : 1, 1); x.globalAlpha = Math.min(1, left);
            x.drawImage(img, -q.rw, -q.rh, q.rw * 2, q.rh * 2); x.restore();
          }
        });
      }
      // the level is display-equivalent: a filler at opacity op on the asset owner's chain = op / SKY.wide in the plate
      /* the cirrus carries the most light per area of the three (mean luma 0.019 against 0.007 for the H-alpha filaments and
         0.004 for the OIII veil), so it is what fills: the darkest voids (corners under the vignettes) get two cirrus patches,
         a little stronger; the H-alpha and OIII fillers are colour accents in the other outer voids (two of each at most).
         The bottom row (the band under the caption and legend may stay dark) comes last. */
      voids.slice().sort(function (a, b) { return (a.mean + (a.j === 3 ? 100 : 0)) - (b.mean + (b.j === 3 ? 100 : 0)); }).forEach(function (v, vi) {
        var dark = v.mean < 9.5, layers = dark ? 2 : 1;
        for (var li = 0; li < layers; li++) {
          var kind = 'ci';
          if (!dark && li === 0 && v.edge > 0.8) { if (nHa < 2 && R() < 0.5) { kind = 'ha'; nHa++; } else if (nO3 < 2 && R() < 0.5) { kind = 'o3'; nO3++; } }
          var img = kind === 'ha' ? FILL.ha : kind === 'o3' ? FILL.o3 : FILL.ci[(vi + li) % Math.max(1, FILL.ci.length)];
          if (!img) continue;
          var op = (kind === 'ha' ? 0.45 : kind === 'o3' ? 0.6 : 0.55) * SKY.fill * (dark ? clamp(11 / Math.max(4, v.mean), 1, 1.6) : 1);
          var ang = cellA * (kind === 'ci' ? 0.85 + 0.25 * R() : 1.0 + 0.3 * R());
          var dir = v.dir.clone().addScaledVector(DEEP.wide[v.frame].R, (R() - 0.5) * 0.05).addScaledVector(DEEP.wide[v.frame].U, (R() - 0.5) * 0.05).normalize();
          paint(at(dir, ang), img, op / SKY.wide, R() * TAU, R() < 0.5);
        }
      });
      SKY.fillers = voids.length; SKY.bakeMs = Math.round(performance.now() - t0);
      if (typeof createImageBitmap === 'function') createImageBitmap(cv).then(done, function () { done(cv); }); else done(cv);
    } catch (e) { console.warn('nexus: sky fill', e); done(null); }
  }
  function deepTick() { }

  function placeGuest(gal, i, n) {
    // deterministic spot on an arm from the guest's name — stable between polls.
    // arm is chosen per-CATEGORY (not per-guest) so a category stays a coherent wedge on
    // one arm — the director's category close-ups (blk shots) take a centroid+radius of
    // a category's guests, which only makes a sane camera shot if they're actually together
    var g = gal.list[i], h = hash(g.name), h2 = hash(g.name + '#');
    var arm = hash(g.cat) < 0.5 ? 0 : 1, r = 34 + Math.pow((i + 0.5) / n, 0.85) * 225;
    var th = arm * Math.PI + r * 0.0165 + (h - 0.5) * 0.5;
    return [Math.cos(th) * r, (h2 - 0.5) * 12, Math.sin(th) * r];
  }
  /* a node's guests: /api/all's list; for a node /api/all does not report yet (a newly joined Proxmox node can lag there,
     and the growth stage only extends /api/universe) the universe's own guest bodies stand in, so a new galaxy has its
     stars, its labels and its counts from the first document. Derived entries are cached per universe document. */
  // every guest of the estate: /api/all's, plus the universe-derived ones of any node /api/all does not list yet
  function allGuests() { var out = S.guests; NODES.forEach(function (n) { if (!n.gone && !S.guests.some(function (g) { return g.node === n.id; })) out = out.concat(guestsOf(n.id)); }); return out; }
  var GUESTS_U = { ver: -1, by: {} };
  function guestsOf(node) {
    var gl = S.guests.filter(function (g) { return g.node === node; });
    if (gl.length || !UNI.on) return gl;
    if (GUESTS_U.ver !== UNI.applied) {
      GUESTS_U.ver = UNI.applied; GUESTS_U.by = {};
      Object.keys(UNI.recs).forEach(function (id) {
        var R = UNI.recs[id], b = R.b, m = b.m || {}; if (R.role !== 'guest' || m.vmid == null || !R.F || !R.F.gal) return;
        var nid = R.F.gal.nd.id, list = GUESTS_U.by[nid] || (GUESTS_U.by[nid] = []);
        var old = GUESTS_U.prev && GUESTS_U.prev[nid] && GUESTS_U.prev[nid][m.vmid];
        var g = old || { node: nid, id: m.vmid, _derived: true };            // the same object across documents: its _pos / _uid stay
        g.name = b.short || b.label || String(m.vmid); g.status = b.status === 'up' ? 'running' : 'stopped'; g.cat = b.cat || 'infra';
        g.cpu = m.cpu_pct != null ? +m.cpu_pct : (m.cpu != null ? +m.cpu * 100 : 0); g.type = m.type === 'qemu' ? 'qemu' : 'lxc'; g.maxmem = g.maxmem || 0; g.mem = g.mem || 0;
        list.push(g);
      });
      GUESTS_U.prev = {}; Object.keys(GUESTS_U.by).forEach(function (k) { GUESTS_U.prev[k] = {}; GUESTS_U.by[k].forEach(function (g) { GUESTS_U.prev[k][g.id] = g; }); });
    }
    return GUESTS_U.by[node] || [];
  }
  function fillGuests(gal, list) {
    gal.list = list.slice(0, 160).sort(function (a, b) { return (a.cat + a.name).localeCompare(b.cat + b.name); });
    var n = gal.list.length, c = new THREE.Color();
    gal.list.forEach(function (g, i) {
      var p = guestUniPos(gal, g) || placeGuest(gal, i, n); gal.gp[i * 3] = p[0]; gal.gp[i * 3 + 1] = p[1]; gal.gp[i * 3 + 2] = p[2];
      var up = g.status === 'running';
      c.setHex(up ? (CAT[g.cat] || CAT.infra) : 0xff5a6a); if (!up) c.multiplyScalar(0.45);
      gal.gc[i * 3] = c.r; gal.gc[i * 3 + 1] = c.g; gal.gc[i * 3 + 2] = c.b;
      var ram = Math.log2(1 + (g.maxmem || 0) / 1073741824);             // 0 .. ~7
      gal.gs[i] = up ? 7 + ram * 2.6 : 5;
      gal.gcat[i] = CATS.indexOf(g.cat) < 0 ? 5 : CATS.indexOf(g.cat);
      gal.ggl[i] = up ? clamp((g.cpu || 0) / 40, 0, 1.2) : 0;             // brightness follows CPU
      g._pos = p;
      // a guest's birth / down flare waits until its star has a position (the universe can answer before /api/all)
      if (g._uid && UNI.recs[g._uid] && UNI.recs[g._uid].pendFx) { var PR = UNI.recs[g._uid], pk = PR.pendFx; PR.pendFx = null; uniFlare(pk, PR); }
    });
    ['position', 'color', 'size', 'cat', 'glow'].forEach(function (k) { gal.gg.attributes[k].needsUpdate = true; });
    gal.gg.setDrawRange(0, n);
    if (G3D) { gal.guests.visible = false; if (UNI.on) uni3dSync(); }
  }

  /* ============================== the sun (WAN) ============================== */
  var sun = new THREE.Group(); sun.position.copy(SUN); scene.add(sun);
  // gain 1.0 -> 1.3 with the granulation map: the multiply darkened the disc into a flat lemon (verified on the
  // WAN shot) - the extra gain lets the post-bloom ACES roll the centre back to a hot near-white
  var sunMat = new THREE.ShaderMaterial({ uniforms: coreUniforms(new THREE.Color(0xffb347), new THREE.Color(0xfff2c0), 2.0, 1.3, 0), vertexShader: coreVS, fragmentShader: coreFS });
  /* HDR (2026-10-08b): the internet sun is a REAL star - a limb-darkened photosphere (quadratic law, the limb cooler and
     redder than the centre), the baked granulation and spots, several times brighter than white at the centre so the
     filmic curve gives a white-hot disc with an orange rim; its glare (PSF + spikes) comes from the STARS pool below. */
  var photoFS = [
    'varying vec3 vN; varying vec3 vP; varying vec2 vUv; uniform vec3 c1; uniform vec3 c2; uniform float pulse; uniform float gain; uniform sampler2D uMap; uniform float uHasMap;',
    'void main(){ float mu = clamp(dot(normalize(vN), vec3(0.0, 0.0, 1.0)), 0.0, 1.0), m1 = 1.0 - mu;',
    '  float ld = 1.0 - 0.6 * m1 - 0.22 * m1 * m1;',
    '  vec3 col = mix(c1, c2, pow(mu, 0.7));',
    '  if (uHasMap > 0.5) col *= 0.66 + 0.46 * texture2D(uMap, vUv).r;',
    '  gl_FragColor = vec4(col * ld * gain * (1.0 + 0.4 * pulse), 1.0); }'
  ].join('\n');
  if (HDR) sunMat = new THREE.ShaderMaterial({ uniforms: coreUniforms(new THREE.Color(1.0, 0.42, 0.12), new THREE.Color(1.0, 0.9, 0.72), 2.0, 3.2, 0), vertexShader: coreVS, fragmentShader: photoFS });
  // SphereGeometry (Icosahedron has no UVs) so the baked granulation map wraps; rotates slowly in the loop
  var SUN_R = 70, sunMesh = new THREE.Mesh(new THREE.SphereGeometry(SUN_R, 48, 32), sunMat); sun.add(sunMesh);
  if (!NXF.notex) loadTex('sun.png', function (t) { sunMat.uniforms.uMap.value = t; sunMat.uniforms.uHasMap.value = 1; });
  var sunHalo = new THREE.Sprite(new THREE.SpriteMaterial({ map: TEX_GLOW, color: HDR ? new THREE.Color(1.0, 0.78, 0.5) : 0xffb347, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending })); sunHalo.scale.set(640, 640, 1); sun.add(sunHalo);
  sun.add(new THREE.PointLight(0xffb347, 1.5, 3000));

  /* ============================== REAL STARS: glare (2026-10-08b, docs/contracts.md) ==============================
     A camera does not see a star as a ball with a ring round it: it sees the photosphere (when it is close enough to be
     resolved) inside the lens' GLARE - the point-spread function, a bright core with a faint wide halo - and, on the
     brightest, four diffraction spikes, all the spikes in a frame pointing the same way (the optics are fixed to the
     camera). The glare is sized in SCREEN pixels from the star's apparent brightness (px = k / sqrt(distance)), so a
     near star dazzles and the same star across the estate is a point of light. Each star: two sprites (PSF + spikes),
     pushed toward the lens by the star's radius so its own sphere never hides them; additive, HDR. */
  /* the shared photographic PSFs (galaxy2/psf, 2026-10-08c) for the unresolved stars: psf_soft (Moffat core + halo +
     aureole) and, on the brightest, psf_hubble (the same core with two-vane diffraction spikes) as ONE sprite; it is drawn
     with its spikes diagonal, so it is turned 45 degrees to keep this page's '+' (SPIKE_ROT). Their core is 0.0417 of the
     sprite (24 x the core FWHM), half the page's own PSF's, so the sprite is drawn 1.94x as wide for the same core. The
     sun (a RESOLVED star: photosphere, limb glare) keeps the page's own textures. */
  function mkGlare(o) {
    var g2 = G2 && !o.r, one = g2 && o.spike, kind = one ? 'hub' : 'psf';
    var S = { o: o, vis: 1, lvl: 1, one: one,
      psf: new THREE.Sprite(new THREE.SpriteMaterial({ map: g2 && G2PSF[kind] ? G2PSF[kind] : TEX_PSF, color: o.color.clone(), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
                                                       rotation: one ? Math.PI / 4 + SPIKE_ROT : 0 })),
      cor: new THREE.Sprite(new THREE.SpriteMaterial({ map: TEX_CORONA, color: o.color.clone().multiplyScalar(0.8), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false })),
      spk: o.spike && !one ? new THREE.Sprite(new THREE.SpriteMaterial({ map: TEX_SPIKE, color: o.color.clone(), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, rotation: SPIKE_ROT })) : null };
    if (g2) { S.psf.material.userData.g2 = kind; G2PSF.mats.push(S.psf.material); }
    S.psf.renderOrder = 3; S.psf.frustumCulled = false; scene.add(S.psf);
    S.cor.renderOrder = 3; S.cor.frustumCulled = false; scene.add(S.cor);
    if (S.spk) { S.spk.renderOrder = 3; S.spk.frustumCulled = false; scene.add(S.spk); }
    STARS.push(S); return S;
  }
  function glareTick() {
    var pxK = innerHeight / (2 * Math.tan(cam.fov * Math.PI / 360));
    for (var i = 0; i < STARS.length; i++) {
      var S = STARS[i], o = S.o, p = typeof o.pos === 'function' ? o.pos() : o.pos, lv = S.lvl * S.vis;
      if (!p || lv < 0.01) { S.psf.visible = false; S.cor.visible = false; if (S.spk) S.spk.visible = false; continue; }
      _sg.subVectors(cam.position, p); var d = Math.max(1, _sg.length()), rad = (typeof o.r === 'function' ? o.r() : o.r) || 0;
      _sg.multiplyScalar(Math.min(rad * 1.3, d * 0.5) / d).add(p);
      var px = clamp(o.k / Math.sqrt(d), o.min || 6, o.max || 420), w = px * d / pxK, hud = U_HUD.value > 0.5 ? hudFadeAt(p) : 1;
      /* an unresolved star IS its PSF; once its disc is resolved (> ~6 px) the photosphere (limb darkening and all) is
         the star and the PSF core fades out - its near glow is then the bloom of the bright photosphere itself */
      var discPx = rad * 2 * pxK / d, unres = clamp(1 - (discPx - 4) / 10, 0, 1);
      // (a shared PSF's core is half the page's own: 1.94x the sprite; a spiked one waits for its texture rather than show a plain core)
      var k2 = S.psf.material.map === TEX_PSF ? 1 : 1.94, wait = S.one && S.psf.material.map === TEX_PSF;
      S.psf.visible = unres > 0.01 && !wait; S.psf.position.copy(_sg); S.psf.scale.set(w * k2, w * k2, 1); S.psf.material.opacity = lv * hud * (o.a || 1) * unres;
      // the limb glare of a resolved star: TEX_CORONA's limb (0.2 of the sprite radius) on the projected limb
      var wc = rad * 2 / 0.2 * 1.04; S.cor.visible = unres < 0.99; S.cor.position.copy(_sg); S.cor.scale.set(wc, wc, 1); S.cor.material.opacity = lv * hud * (1 - unres) * (o.corA || 0.8);
      if (S.spk) { var ws = w * (o.spikeK || 1.7); S.spk.visible = true; S.spk.position.copy(_sg); S.spk.scale.set(ws, ws, 1); S.spk.material.opacity = lv * hud * (o.spikeA || 0.5); }
    }
  }
  // the internet sun: the brightest thing in the sky (spikes); trimmed near it like its halo (the fabric stops sit ~500 away)
  var SUN_GLARE = HDR ? mkGlare({ pos: SUN, r: function () { return sunMesh.scale.x * SUN_R; }, k: 10500, min: 40, max: 520, color: new THREE.Color(2.4, 2.05, 1.6), spike: true, spikeK: 1.9, spikeA: 0.55 }) : null;

  /* ============================== fabric (solar system) ==============================
     gateway/switch/ap = three small planets strung out between the sun and the estate;
     clients = moons orbiting whichever of the three they're attached to, one shared
     Points pool (fixed 96) so this stays a single draw call regardless of client count. */
  /* ---- real 3D bodies (2026-10-07): static/bodies3d.js, the module the wall draws its devices and hubs with ----
     Every non-guest device and every hub (gateway / switch / AP planets, a remote site's own anchor device) is the
     same instanced low-poly Blender model, matcap-shaded, as on the wall: same model, same class tint (guests the
     CATEGORY palette), same status grammar (down = dim + desaturate, stopped; motion.js curves), so one device looks
     the same on both screens. The guest stars in the host arms stay stars (A/B at TV distance: see NX3D below).
     nxflags no3d = the old atlas sprites + textured planets (A/B and fallback). The gains are the nexus's own: its
     grade is hotter than the wall's (exposure 1.45 into ACES, bloom threshold 0.70 at strength 1.0). */
  /* 2026-10-08b: with the HDR pipeline the TV opts into bodies3d's PHOTO look (shared with the wall): every
     planet lit by ITS star (B3.lights, written per frame below: the switch star for its planets, the gateway for the
     ring, the site star, the sun for the edge ring), far bodies drawn as stars with a photographic PSF, hub stars with a
     limb-darkened photosphere, corona and spikes. Same values as the wall (netscene.js b3dCreate) so a body looks the
     same on both screens. nxflags nophoto = the celestial look as before. */
  var B3 = (window.BODIES3D && !NXF.no3d) ? window.BODIES3D.create({ scene: scene, fogDensity: scene.fog.density,
    gain: { body: 1.0, glow: 1.05, rim: 0.22, glowWhite: 0.2, hubBody: 0.95, hubGlow: 1.0 },
    // lod: the TV frames its star systems closer than the wall does - a planet resolves into a lit sphere from ~2.6 px radius
    // amb: a little more fill than the wall - the TV looks across its star systems, so half of every ring shows its night side
    photo: HDR && !NXF.nophoto ? { lod: [2.6, 6.0], starPx: 5.4, starGain: 1.6, sun: 2.0, amb: [0.095, 0.105, 0.13], hazeK: 0.55, spikes: 0.3 } : undefined }) : null;
  var B3PHOTO = !!(B3 && B3.photo);
  var NBM = window.NB_MOTION || null;
  function hubTintRGB(cls) { var L = window.UNIVERSE_LAYOUT; return L && L.colourRGB ? L.colourRGB({ 'class': cls, seed: 0, status: 'up' }, null) : [0.6, 0.75, 0.9]; }
  // world radius of the hub model (unit sphere). 2026-10-07: hubs are stars now (celestial bodies3d, glow sprite as a
  // child), so they are drawn smaller: the gateway star and its switch stars stay crisp anchors instead of white-out discs
  var HUB3R = { gateway: 10, 'switch': 6.5, ap: 6 };
  var FABKIND = ['gateway', 'switch', 'ap'];
  var FAB_COL = { gateway: 0x5ad7ff, switch: 0xffb347, ap: 0x37f5a0 };
  var FAB_RAD = { gateway: 10, switch: 6, ap: 6 };   // 2026-10-04: scaled with the smaller network system (core ring 26..46)
  // the drawn radius of a fabric body: the hub model fills ~80% of its unit sphere. Label anchors, label obstacles and the
  // down ring follow what is drawn; the wired / AP shot framing keeps FAB_RAD (the approved composition).
  function fabR(k) { return B3 ? HUB3R[k] * 0.8 : FAB_RAD[k]; }
  var fab = {}, fabIds = { gateway: null, switch: null, ap: null };
  /* the hub models as REAL STARS (2026-10-08b): bodies3d's switch stars carry lighthouse "pulsar" beams - a diagram cue a
     photograph never shows - so on this screen the beams come off (the soft corona stays) and every hub star wears the
     shared glare instead, coloured by its spectral type: the gateway a white G-type sun (the only one with spikes, it
     is the brightest thing in the home system), switches yellow-orange K-types, the AP and the sites orange dwarfs */
  var HUB_STAR = { gateway: { col: [1.0, 0.93, 0.84], k: 2300, spike: true }, 'switch': { col: [1.0, 0.8, 0.58], k: 1150 }, ap: { col: [1.0, 0.64, 0.46], k: 820 },
                   site: { col: [1.0, 0.72, 0.5], k: 1250 } };
  function hubStarize(m, kind, pos, rad) {
    if (!HDR || !m || B3PHOTO) return null;
    if (m.userData.corona && m.userData.corona.userData.glowKind === 'pulsar') { m.remove(m.userData.corona); m.userData.corona = null; }
    var hs = HUB_STAR[kind] || HUB_STAR['switch'];
    var G = mkGlare({ pos: pos, r: rad, k: hs.k, min: 5, max: 280, color: new THREE.Color(hs.col[0], hs.col[1], hs.col[2]).multiplyScalar(1.7), spike: !!hs.spike, spikeK: 1.8, spikeA: 0.42 });
    m.userData.glare = G; return G;
  }
  function dropGlare(m) {
    var G = m && m.userData.glare; if (!G) return;
    scene.remove(G.psf); scene.remove(G.cor); if (G.spk) scene.remove(G.spk); var i = STARS.indexOf(G); if (i >= 0) STARS.splice(i, 1); m.userData.glare = null;
  }
  (function buildFabric() {
    /* 2026-10-04: the gateway is the HUB of the network system (sys:core + sys:home from /api/universe), a
       fixed point 470 units estate-side of the sun. The switch/AP start at their old relative spots and move to
       their layout slots on the core ring as soon as /api/universe answers (uniTick writes fab[k].pos in place). */
    var basePos = {
      gateway: NET_C.clone(),
      switch: NET_C.clone().add(new THREE.Vector3(-150, 45, 70)),
      ap: NET_C.clone().add(new THREE.Vector3(150, -45, -40))
    };
    FABKIND.forEach(function (k) {
      var G = new THREE.Group(); G.position.copy(basePos[k]); scene.add(G);
      var mat = null, mesh;
      if (B3) {      // the wall's hub model for this kind, class tint, unit radius scaled to HUB3R
        mesh = B3.hubMesh(k, { tint: hubTintRGB(k), tintMix: 0.85 }); mesh.scale.setScalar(HUB3R[k]); G.add(mesh);
        hubStarize(mesh, k, basePos[k], HUB3R[k] * 0.9);
      } else {
        mat = new THREE.ShaderMaterial({ uniforms: coreUniforms(new THREE.Color(FAB_COL[k]).multiplyScalar(0.4).lerp(new THREE.Color(0xffffff), 0.2), new THREE.Color(FAB_COL[k]), 2.0, 1.05, 1), vertexShader: coreVS, fragmentShader: coreFS, transparent: true });
        mesh = new THREE.Mesh(new THREE.SphereGeometry(FAB_RAD[k], 48, 32), mat); G.add(mesh);
        if (!NXF.notex) loadTex('planet_' + k + '.png', function (t) { mat.uniforms.uMap.value = t; mat.uniforms.uHasMap.value = 1; });
      }
      // "down" alarm ring (soft textured annulus, red, opacity driven in the render loop)
      var ring = ringPlane(TEX_RING, 0xff3b4a, 0); ring.scale.setScalar(fabR(k) * 1.7); G.add(ring);
      // faint orbit band under the client moons (they orbit at r 20..42, see fillFabric) so
      // the solar system reads as a system — a soft disc, not a hairline
      // 2026-10-07 clarity: the per-planet orbit bands read as blobs next to the diagram's rings; the gateway keeps one
      // soft, neutral core glow instead (the home network's centre of gravity)
      if (k === 'gateway' && !HDR) { var cg0 = new THREE.Sprite(new THREE.SpriteMaterial({ map: TEX_GLOW, color: 0x5f8fc8, transparent: true, opacity: 0.2, depthWrite: false, blending: THREE.AdditiveBlending })); cg0.scale.set(150, 150, 1); G.add(cg0); }
      fab[k] = { group: G, mesh: mesh, mat: mat, ring: ring, pos: basePos[k], down: false, meta: null };
    });
  })();
  // a hub model turns (eased) to show the camera its front, with a small sway; AP-style glyphs wobble +-20 deg
  function hubFace(m, p, dt, wob, seed) {
    var yT = Math.atan2(cam.position.x - p.x, cam.position.z - p.z) + wob * 0.35 * Math.sin(SIM_T * 0.23 + seed * 1.7);
    var d = yT - m.rotation.y; d = ((d + Math.PI) % TAU + TAU) % TAU - Math.PI;
    m.rotation.y += d * (1 - Math.exp(-dt / 0.8));
  }
  function fabKindOf(id) {
    if (!id) return null;
    if (id === fabIds.gateway) return 'gateway';
    if (id === fabIds.switch) return 'switch';
    if (id === fabIds.ap) return 'ap';
    return null;
  }
  // moons: one shared pool for every client, positions deterministic from hash(id)
  var CLIENT_CAT = { pc: 0x9bd8ff, phone: 0xb08cff, appliance: 0xffb347, 'smart-home': 0x37f5a0, av: 0xff4fa3,
                     printer: 0xffd166, '3dprinter': 0xff8a5b, network: 0x8fb0d0, unknown: 0x7f95b0 };
  var MOON_N = 96, mpos = new Float32Array(MOON_N * 3), mcol = new Float32Array(MOON_N * 3), msz = new Float32Array(MOON_N), mph = new Float32Array(MOON_N);
  var mgeo = new THREE.BufferGeometry();
  mgeo.setAttribute('position', new THREE.BufferAttribute(mpos, 3)); mgeo.setAttribute('color', new THREE.BufferAttribute(mcol, 3));
  mgeo.setAttribute('size', new THREE.BufferAttribute(msz, 1)); mgeo.setAttribute('phase', new THREE.BufferAttribute(mph, 1));
  mgeo.setDrawRange(0, 0);
  var moons = new THREE.Points(padAttrs(mgeo), pointsMat(TEX_STAR, 0.15, 1.0)); scene.add(moons);
  var moonState = [];
  function fillFabric(list) {
    // /api/universe owns every client once it answers: the moon pool is the no-universe fallback only
    if (UNI.on) { moonState = []; mgeo.setDrawRange(0, 0); return; }
    list = list.slice(0, MOON_N).sort(function (a, b) { return String(a.id).localeCompare(String(b.id)); });
    var c = new THREE.Color(); moonState = [];
    list.forEach(function (cl, i) {
      var kind = fabKindOf(cl.parent); if (!kind) return;
      var h = hash(cl.id), h2 = hash(cl.id + '#'), h3 = hash(cl.id + '##');
      /* 2026-09-14: moon colour = device category (meta.cat), dormant clients
         (meta.offline: known, asleep) are dim and small - present, not dead */
      /* round 2: status:"down" (probe silent) is dormant too, not a live-coloured moon */
      var m = cl.meta || {}, dorm = !!m.offline || (cl.status !== undefined && cl.status !== 'up');
      c.setHex(dorm ? 0x3b4a62 : (CLIENT_CAT[m.cat] || (kind === 'ap' ? 0x9bffa0 : 0x9bd8ff)));
      var j = i * 3; mcol[j] = c.r; mcol[j + 1] = c.g; mcol[j + 2] = c.b; msz[i] = dorm ? 2.0 : 3.2 + 2.2 * normBps(Math.max(+cl.rx || 0, +cl.tx || 0) * 8);
      moonState.push({ i: i, kind: kind, r: 20 + h * 22, ang: h2 * 6.283, y: (h3 - 0.5) * 10, client: cl });
    });
    mgeo.attributes.color.needsUpdate = true; mgeo.attributes.size.needsUpdate = true;
    mgeo.setDrawRange(0, moonState.length);
  }
  // gateway-switch / gateway-ap spokes now live in the universe links buffer (one LineSegments draw for every
  // attachment line, rewritten per frame because the switch/AP orbit with the network system) - see linksTick

  /* ============================== comets (flows) ============================== */
  /* the bridge spans the first two nodes (the pair every shot in this file was
     framed against); with one node configured it degenerates to a short arc over
     the origin and simply never carries traffic. */
  var BR_A = NODES[0].x, BR_B = (NODES[1] || NODES[0]).x;
  var CURVES = {
    bridge: new THREE.CubicBezierCurve3(new THREE.Vector3(BR_A + 30, 6, 0), new THREE.Vector3(-120, 170, 40), new THREE.Vector3(120, 170, -40), new THREE.Vector3(BR_B - 30, 6, 0)),
    // control points derived from the sun and the gateway hub: inbound arcs over the top, outbound under. Routed for
    // the OVERVIEW framing: from the sun the arc swings left just under the header band, passes between the right-hand
    // galaxy's label and the bridge label, and drops into the gateway at the centre - control points solved by
    // projecting through overviewShot(); inbound over the top, outbound a lane below it
    wan_in: new THREE.CubicBezierCurve3(SUN.clone(), new THREE.Vector3(600, 380, -300), new THREE.Vector3(150, 250, -250), NET_C.clone()),
    wan_out: new THREE.CubicBezierCurve3(NET_C.clone(), new THREE.Vector3(170, 200, -230), new THREE.Vector3(640, 320, -320), SUN.clone())
  };
  // thinner, sparser, less saturated beads: the scene stays busy without strobing
  var FAM = { bridge: { color: 0x5ad7ff, bps: 0, k: 1 }, wan_in: { color: 0x5fc8e8, bps: 0, k: 1.05, rate: null, calm: 0.45 }, wan_out: { color: 0xd8709f, bps: 0, k: 1.05, calm: 0.45 } };
  /* one uplink family per composed node: gateway -> that galaxy's core, in the node's own accent.
     UP_FAM[id] is the family key ('up:<node id>'). */
  var UP_FAM = {}, NET_FAM0 = { wan_in: 1, wan_out: 1 };
  NODES.forEach(function (n) {
    var key = 'up:' + n.id, gw = fab.gateway.pos;
    if (FAM[key]) return;
    CURVES[key] = new THREE.CubicBezierCurve3(
      gw.clone(),
      gw.clone().lerp(new THREE.Vector3(n.x, 40, 0), 0.4).add(new THREE.Vector3(0, 60, 0)),
      gw.clone().lerp(new THREE.Vector3(n.x, 10, 0), 0.75),
      new THREE.Vector3(n.x, 4, 0));
    FAM[key] = { color: n.accent, bps: 0, k: 0.8 };
    UP_FAM[n.id] = key; NET_FAM0[key] = 1;
  });
  /* 2026-09-19 UNIVERSE families. `u` (when set) replaces normBps(bps) as the family's 0..1 intensity so a
     family can be driven by a rate that is not a bit rate; rate 0 = never auto-spawned (explicit spawns only):
     - edge_in   : orange, EDGE core -> sun, cadence follows Cloudflare req_per_min (capped, see edgeUpdate)
     - edge_view : gold, same route, one comet per NEW unique viewer (audience.viewers_5m delta, <= 20/poll)
     - bridge_r  : the bridge reversed - only the reverse-direction rocket's exhaust trail lives on it
     - th0..th3  : red intrusion comets, EDGE rim (angle hashed from the attacker's cc) -> sun; the curve's
                   control points are rewritten per event (no allocation), onArrive fires the shield burst */
  var EDGE_C1 = EDGE_POS.clone().lerp(SUN, 0.35).add(new THREE.Vector3(0, -90, 0)), EDGE_C2 = SUN.clone().lerp(EDGE_POS, 0.3).add(new THREE.Vector3(0, 110, 0));
  CURVES.edge_in = new THREE.CubicBezierCurve3(EDGE_POS.clone(), EDGE_C1, EDGE_C2, SUN.clone());
  CURVES.edge_view = CURVES.edge_in;
  CURVES.bridge_r = new THREE.CubicBezierCurve3(CURVES.bridge.v3.clone(), CURVES.bridge.v2.clone(), CURVES.bridge.v1.clone(), CURVES.bridge.v0.clone());
  FAM.edge_in = { color: 0xf6821f, bps: 0, u: 0, k: 1.3, rate: 0 };
  FAM.edge_view = { color: 0xffd166, bps: 0, u: 0.55, k: 1.7, rate: 0 };
  FAM.bridge_r = { color: 0x5ad7ff, bps: 0, k: 1, rate: 0 };
  var TH_N = 4;
  for (var thi = 0; thi < TH_N; thi++) {
    CURVES['th' + thi] = new THREE.CubicBezierCurve3(EDGE_POS.clone(), EDGE_C1.clone(), EDGE_C2.clone(), SUN.clone());
    FAM['th' + thi] = { color: 0xff5a6a, bps: 0, u: 0.85, k: 6.5, rate: 0, onArrive: function () { threatArrive(); } };
  }
  var NO_GUIDE = { edge_view: 1, bridge_r: 1, th0: 1, th1: 1, th2: 1, th3: 1 };
  /* AUDIENCE: a viewer mote launches from the COUNTRY's own star (not the EDGE core) when that country's
     unique-visitor count rises. VW_N launch curves are rewritten at launch time (vwLaunch, from the star's live world
     position, so the EDGE's spin never leaves the mote starting off-star) and used round-robin; the queue drains at
     3/s and a flight is ~4 s, so at most ~12 are ever in flight and a slot is never rewritten under a comet still
     riding it. A viewers_5m rise with no per-country delta (a returning 1 h unique) keeps the old edge_view route
     from the core - the country is genuinely unknown then. */
  var VW_N = 16, vwNext = 0;
  for (var vwi = 0; vwi < VW_N; vwi++) {
    CURVES['vw' + vwi] = new THREE.CubicBezierCurve3(EDGE_POS.clone(), EDGE_C1.clone(), EDGE_C2.clone(), SUN.clone());
    FAM['vw' + vwi] = { color: 0xffd166, bps: 0, u: 0.6, k: 1.9, rate: 0 };
    NO_GUIDE['vw' + vwi] = 1;
  }
  // gold arrival ping at the launching star: PING_N pooled sprites, scale grows / opacity decays over PING_S seconds
  // (pingTick); world scale is capped against camera distance so a ping near the lens never washes the frame
  var PING_N = 4, PING_S = 1.5, pings = [];
  for (var pgi = 0; pgi < PING_N; pgi++) {
    var pSp = new THREE.Sprite(new THREE.SpriteMaterial({ map: TEX_GLOW, color: 0xffd166, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
    pSp.visible = false; scene.add(pSp); pings.push({ sp: pSp, t: PING_S });
  }
  function pingAt(p) { var best = pings[0]; for (var i = 1; i < PING_N; i++) if (pings[i].t > best.t) best = pings[i]; best.t = 0; best.sp.position.copy(p); best.sp.visible = true; }
  function pingTick(dt) {
    for (var i = 0; i < PING_N; i++) {
      var P = pings[i];
      if (P.t >= PING_S) { if (P.sp.visible) { P.sp.visible = false; P.sp.material.opacity = 0; } continue; }
      P.t += dt; var f = clamp(P.t / PING_S, 0, 1), s = Math.min(40 + 200 * f, cam.position.distanceTo(P.sp.position) * 0.16);
      P.sp.scale.set(s, s, 1); P.sp.material.opacity = 0.75 * (1 - f) * (1 - f);
    }
  }
  function famU(f) { return f.u != null ? f.u : normBps(f.bps); }
  /* CN 96 -> 160 (2026-09-14) to carry the exosphere comet families */
  var CN = 200, TRAIL = 7, cpos = new Float32Array(CN * TRAIL * 3), ccol = new Float32Array(CN * TRAIL * 3), csz = new Float32Array(CN * TRAIL), cph = new Float32Array(CN * TRAIL);
  var cg = new THREE.BufferGeometry();
  cg.setAttribute('position', new THREE.BufferAttribute(cpos, 3)); cg.setAttribute('color', new THREE.BufferAttribute(ccol, 3));
  cg.setAttribute('size', new THREE.BufferAttribute(csz, 1)); cg.setAttribute('phase', new THREE.BufferAttribute(cph, 1));
  // 120 px cap (was the 240 default): once the pool stopped being culled at the sun-side framings, exo comets passing
  // within ~100 units of the camera ballooned into quarter-screen orbs; a comet is a streak, never a body
  var comets = new THREE.Points(padAttrs(cg), pointsMat(TEX_STAR, 0, 1, 120, true)); scene.add(comets);
  // never frustum-cull a pool whose positions are rewritten per frame: three computes the bounding sphere ONCE, at
  // first render, from the zero-filled buffer -> a zero-radius sphere at the origin, so the whole pool vanished from
  // any shot that did not contain the origin (verified on the TV: no intrusion comets at the threat/EDGE framings)
  comets.frustumCulled = false;
  var cometS = []; for (var ci = 0; ci < CN; ci++) cometS.push({ fam: null, t: 2, v: 0.2, sz: 1, life: 0 });   // life > 0: seconds to live (rocket exhaust), else runs the whole curve
  var _v = new THREE.Vector3(), _c = new THREE.Color();
  function cometSpawn(fam, t0) {
    for (var i = 0; i < CN; i++) if (cometS[i].t >= 1) {
      var s = cometS[i], u = famU(FAM[fam]);
      s.fam = fam; s.t = t0 || 0; s.life = 0; s.v = (0.10 + u * 0.28) * (0.7 + Math.random() * 0.6); s.sz = (3 + u * 6) * (0.6 + Math.random() * 0.8) * FAM[fam].k; return;
    }
  }
  // a comet dropped mid-curve at an explicit speed/size: the rockets' exhaust trail (see rocketTick)
  // a comet dropped mid-curve with a short life: the rockets' exhaust (verified on the TV that whole-curve trail
  // comets at exhaust cadence filled all 160 slots within a minute and starved every other family, so the
  // intrusion comet + shield burst never fired)
  function cometSpawnAt(fam, t0, v, sz, life) {
    for (var i = 0; i < CN; i++) if (cometS[i].t >= 1) { var s = cometS[i]; s.fam = fam; s.t = t0; s.v = v; s.sz = sz; s.life = life || 0; return; }
  }
  // gold viewer motes waiting to launch, drained at ~3/s so they read as a stream, not a clump. A fixed 32-slot ring
  // of EDGE star indices (-1 = country unknown, launch from the core); pushed only from the 6 s poll, never per frame.
  var VQ = new Int16Array(32), vqH = 0, vqT = 0, viewAcc = 0;
  function viewPush(idx) { if (vqT - vqH < 32) VQ[vqT++ & 31] = idx; }
  function viewQueue() { return vqT - vqH; }
  function vwLaunch(idx) {
    var st = idx >= 0 && edgeStars[idx];
    if (!st) { cometSpawn('edge_view'); return; }
    _local.fromArray(L_estar[idx].local); EDGE.G.localToWorld(_local);
    var k = vwNext++ % VW_N, cv = CURVES['vw' + k];
    cv.v0.copy(_local); cv.v3.copy(SUN); cv.v1.copy(_local).lerp(SUN, 0.3); cv.v1.y += 90; cv.v2.copy(SUN).lerp(_local, 0.3); cv.v2.y += 60;
    pingAt(_local); cometSpawn('vw' + k);
    // the arrival is an EVENT: the star flares (edgeBreathe), the EDGE fires a gold shockwave from its core, the headline flashes
    edgeFlare[idx] = 2; EDGE.ringT = 0; EDGE.ring.material.color.setHex(0xffd166); audHit();
  }
  var spawnAcc = {};   // per-family accumulator, keys created lazily in cometTick
  function cometTick(dt) {
    if (vqT > vqH) { viewAcc += dt * 3; while (viewAcc >= 1 && vqT > vqH) { viewAcc -= 1; vwLaunch(VQ[vqH++ & 31]); } } else viewAcc = 0;
    Object.keys(FAM).forEach(function (f) {
      var u = famU(FAM[f]); if (u <= 0) return;
      var per = (FAM[f].rate != null ? FAM[f].rate : MOTION.flowRate(u)) * (FAM[f].calm || 1);   // exosphere families carry their own (lower) cadence
      spawnAcc[f] = (spawnAcc[f] || 0) + dt * per * (0.5 + Math.random());   // comets per second follows the rate, jittered so they bunch like real bursts
      while (spawnAcc[f] >= 1) { spawnAcc[f] -= 1; cometSpawn(f); }
    });
    for (var i = 0; i < CN; i++) {
      var s = cometS[i], base = i * TRAIL;
      if (s.t >= 1 || !s.fam) { for (var k = 0; k < TRAIL; k++) csz[base + k] = 0; continue; }
      if (s.life > 0) { s.life -= dt; if (s.life <= 0) { s.t = 2; s.fam = null; for (var k1 = 0; k1 < TRAIL; k1++) csz[base + k1] = 0; continue; } }
      s.t += dt * s.v;
      if (s.t >= 1 && FAM[s.fam] && FAM[s.fam].onArrive) FAM[s.fam].onArrive();
      var curve = CURVES[s.fam];
      if (!curve || !FAM[s.fam]) { s.t = 2; s.fam = null; for (var k0 = 0; k0 < TRAIL; k0++) csz[base + k0] = 0; continue; }   // family retired mid-flight (station left the top set)
      _c.setHex(FAM[s.fam].color);
      for (var k2 = 0; k2 < TRAIL; k2++) {
        var tt = clamp(s.t - k2 * 0.02, 0, 1); curve.getPoint(tt, _v);
        var j = (base + k2) * 3; cpos[j] = _v.x; cpos[j + 1] = _v.y; cpos[j + 2] = _v.z;
        var f = 1 - k2 / TRAIL; csz[base + k2] = s.sz * (k2 === 0 ? 1.3 : f * 0.9) * (s.life > 0 ? Math.min(1, s.life / 0.8) : 1) * (NET_FAM[s.fam] ? NET_VIS : 1);
        var hb = k2 === 0 ? 1.25 : f * 0.75;
        ccol[j] = _c.r * hb; ccol[j + 1] = _c.g * hb; ccol[j + 2] = _c.b * hb;
      }
    }
    cg.attributes.position.needsUpdate = true; cg.attributes.color.needsUpdate = true; cg.attributes.size.needsUpdate = true;
  }
  /* routes that end at the gateway hub belong to the network system: in a host-galaxy close-up they fade with it
     (NET_VIS, eased in uniTick), comets and guide lines alike */
  var NET_FAM = NET_FAM0, NET_VIS = 1, GUIDE_MAT = {};
  // additive line material (vertex colours or a flat colour) that fades under the HUD bands
  function hudLineMat(color, opacity, vcol) {
    return new THREE.ShaderMaterial({
      uniforms: { uHud: U_HUD, uCol: { value: new THREE.Color(color || 0xffffff) }, uOp: { value: opacity }, uLineK: U_LINEK },
      vertexShader: [HUD_GLSL, 'varying vec3 vC; varying float vF;', vcol ? '' : 'uniform vec3 uCol;',
        'void main(){ vC = ' + (vcol ? 'color' : 'uCol') + '; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); vF = hudFade(gl_Position.xy / max(gl_Position.w, 0.001)); }'].join('\n'),
      fragmentShader: 'uniform float uOp, uLineK; varying vec3 vC; varying float vF; void main(){ gl_FragColor = vec4(vC, uOp * uLineK * vF); }',
      vertexColors: !!vcol, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
    });
  }
  // faint guide lines so the routes read even between comets
  Object.keys(CURVES).forEach(function (k) {
    if (NO_GUIDE[k]) return;
    var pts = CURVES[k].getPoints(64), g = new THREE.BufferGeometry().setFromPoints(pts);
    var gm = hudLineMat(FAM[k].color, 0.07, false); GUIDE_MAT[k] = gm; scene.add(new THREE.Line(g, gm));
  });

  /* ============================== rockets (2026-09-19) ==============================
     one BufferGeometry from the baked rocket.json (592 verts / 1128 tris, nose +Z), four meshes sharing it
     (one draw each): two on the bridge in opposite directions (speed follows FAM.bridge.bps), one on wan_in,
     one on wan_out. Opaque meshes with depth, so the renderer draws them before every additive point pool.
     Each drops comets of its own family behind it as an exhaust trail; a family at 0 bps parks its rocket at
     the curve start with the exhaust dimmed. Per-vertex `glow` (0..3.5) marks the emissive parts; the shader
     multiplies colour by (1+glow*uGlow) so trim/window/flame bloom, uGlow dims to 0.12 when idle. */
  var rocketVS = 'attribute float glow; varying vec3 vC; varying float vG; varying vec3 vN; void main(){ vC = color; vG = glow; vN = normalize(normalMatrix*normal); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }';
  var rocketFS = 'uniform float uGlow; uniform vec3 uTint; varying vec3 vC; varying float vG; varying vec3 vN; void main(){ float sh = 0.22 + 0.78*max(dot(normalize(vN), normalize(vec3(-0.45,0.55,0.7))), 0.0); float g = min(vG*uGlow, 1.4); vec3 c = vC * mix(sh*0.9, 1.0, clamp(g, 0.0, 1.0)) * (1.0 + g) * mix(vec3(1.0), uTint, clamp(vG, 0.0, 1.0)*0.5); gl_FragColor = vec4(c, 1.0); }';
  var ROCKET_LEN = 14, ROCKETS = [];
  var ROCKET_DEFS = [ { fam: 'bridge', dir: 1, trail: 'bridge' }, { fam: 'bridge', dir: -1, trail: 'bridge_r' }, { fam: 'wan_in', dir: 1, trail: 'wan_in' }, { fam: 'wan_out', dir: 1, trail: 'wan_out' } ];
  // 2026-10-08b: in the photographic look the rockets (a 3D model flying the bridge / WAN curves) are the most "3D rendered"
  // thing on screen and the measured streams already carry the same relations - they stay home (nxflags rockets = back)
  if (HDR && !NXF.rockets) NXF.norocket = 1;
  if (!NXF.norocket) fetch('/static/assets/rocket.json').then(function (r) { return r.json(); }).then(function (j) {
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(j.pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(j.nrm), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(j.col), 3));
    g.setAttribute('glow', new THREE.BufferAttribute(new Float32Array(j.glow), 1));
    g.setIndex(j.idx); g.computeBoundingSphere(); BOOT.rockets = true;
    var zs = j.pos.filter(function (v, i) { return i % 3 === 2; }), len = Math.max.apply(null, zs) - Math.min.apply(null, zs) || 6;
    ROCKET_DEFS.forEach(function (d, i) {
      var mat = new THREE.ShaderMaterial({ uniforms: { uGlow: { value: 0.12 }, uTint: { value: new THREE.Color(FAM[d.fam].color) } }, vertexShader: rocketVS, fragmentShader: rocketFS, vertexColors: true });
      var m = new THREE.Mesh(g, mat); m.scale.setScalar(ROCKET_LEN / len); m.renderOrder = -5; scene.add(m);
      ROCKETS.push({ fam: d.fam, dir: d.dir, trail: d.trail, mesh: m, mat: mat, base: ROCKET_LEN / len, t: d.dir < 0 ? 0.5 : 0, acc: 0, ph: i * 1.7, curve: CURVES[d.fam] });   // the return rocket starts half a lap out so the pair never runs as a mirror image
    });
  }).catch(function (e) { BOOT.rockets = true; console.warn('nexus: rocket.json', e); });
  var _rA = new THREE.Vector3(), _rB = new THREE.Vector3();
  function rocketTick(dt, t) {
    for (var i = 0; i < ROCKETS.length; i++) {
      var R = ROCKETS[i], fam = FAM[R.fam], u = famU(fam), active = u > 0, vR = 0.035 + u * 0.09;
      var rv = !NET_FAM[R.fam] || NET_VIS > 0.05; if (R.mesh.visible !== rv) R.mesh.visible = rv;   // WAN rockets leave with the network system in a close-up
      if (active) { R.t += dt * vR; if (R.t >= 1) R.t -= 1; } else R.t = 0;
      var tt = R.dir > 0 ? R.t : 1 - R.t;                          // parameter on the family's forward curve
      R.curve.getPoint(tt, _v); if (R.dir < 0) { _v.y -= 9; _v.z += 16; } R.mesh.position.copy(_v);   // return lane sits beside the outbound one: the pair pass side by side, not through each other (seen on the TV as one hull with two flames)
      R.curve.getPoint(clamp(tt + 0.012 * R.dir, 0, 1), _rA); R.curve.getPoint(clamp(tt - 0.012 * R.dir, 0, 1), _rB);
      _rA.sub(_rB); if (_rA.lengthSq() < 1e-6) _rA.set(0, 0, 1);
      _rB.copy(_v).add(_rA); R.mesh.lookAt(_rB);                   // non-camera lookAt points the mesh's +Z (the nose) down the travel direction
      R.mesh.rotateZ(Math.sin(t * 0.6 + R.ph) * 0.28);             // gentle roll about the travel axis
      R.mesh.scale.setScalar(R.base);
      R.mat.uniforms.uGlow.value = active ? 0.5 + 0.04 * Math.sin(t * 2.1 + R.ph) : 0.08;   // was a 3.7 Hz +-0.2 flicker: reads as strobing on camera
      if (active) {
        R.acc += dt * (0.9 + u * 1.2);
        while (R.acc >= 1) { R.acc -= 1; cometSpawnAt(R.trail, Math.max(0, R.t - 0.012), vR * 0.5 * (0.8 + Math.random() * 0.4), (2.2 + u * 3) * (0.7 + Math.random() * 0.6), 2.2); }
      }
    }
  }

  /* ============================== DOM labels ============================== */
  var labelLayer = $('labels'), labels = [];
  function mkLabel(cls, html) { var e = document.createElement('div'); e.className = 'lbl ' + cls; e.innerHTML = html; labelLayer.appendChild(e); var L = { el: e, pos: new THREE.Vector3(), on: true, off: [0, 0], poolItem: false }; labels.push(L); return L; }
  // "centered" landmark labels shrink-wrap in CSS now (see nexus.html) so halfW below is only
  // the PRE-MEASUREMENT fallback margin (vw-ish guess); once a real setLabelText() call has run
  // once, L.w (measured offsetWidth) takes over and the guess is never consulted again
  var BRIDGE_TITLE = NA.name + (N_NODES > 1 ? ' \u2194 ' + NB.name : '');
  var L_gal = {}, L_sun = mkLabel('sun', '<b>Internet</b><span></span>'), L_bridge = mkLabel('bridge', '<b>' + esc(BRIDGE_TITLE) + '</b><span></span>');
  L_sun.halfW = 10; L_bridge.halfW = 10; L_sun.centered = true; L_bridge.centered = true;
  // the galaxy labels carry no node id in their class (nexus.html knows no node names)
  NODES.forEach(function (n) { L_gal[n.id] = mkLabel('gal node', '<b>' + esc(n.name) + '</b><span></span>'); L_gal[n.id].halfW = 12; L_gal[n.id].centered = true; });
  var L_edge = mkLabel('gal edge', '<b>Cloudflare edge</b><span></span>'); L_edge.halfW = 14; L_edge.centered = true;
  var L_gw = mkLabel('planet', '<b>Gateway</b><span></span>'), L_sw = mkLabel('planet', '<b>Switch</b><span></span>'), L_ap = mkLabel('planet', '<b>AP</b><span></span>');
  L_gw.halfW = 9; L_sw.halfW = 9; L_ap.halfW = 9; L_gw.centered = true; L_sw.centered = true; L_ap.centered = true;
  // pool of 200 entity labels: reused for guest stars (galaxy/category shots) OR client
  // moons (fabric/ap/wired shots) — the two never show at once, see applyLabelSubject()
  var L_guest = []; for (var li = 0; li < 200; li++) { var LG = mkLabel('guest', '<b></b><span></span>'); LG.poolItem = true; LG.on = false; L_guest.push(LG); }
  /* home-network diagram labels (2026-10-07): extra hub names (planet tier), one group label per device sector, and the
     overview's single "HOME NETWORK" landmark. Moved ahead of the entity pool in `labels` so they claim their space
     first and the device names route around them (labelsTick walks `labels` in order). */
  var L_hubx = [], L_grp = [];
  for (var hx = 0; hx < 8; hx++) { var LH = mkLabel('planet', '<b></b><span></span>'); LH.on = false; LH.centered = true; LH.halfW = 7; LH.off = [0, -18]; LH.offBelow = 22; LH.maxPush = 0.03; L_hubx.push(LH); }
  for (var gx = 0; gx < 16; gx++) { var LGr = mkLabel('grp', '<b></b><span></span>'); LGr.on = false; LGr.centered = true; LGr.halfW = 5; LGr.off = [0, -10]; LGr.offBelow = 12; LGr.maxPush = 0.025; L_grp.push(LGr); }
  var L_home = mkLabel('planet home', '<b>Home network</b><span></span>'); L_home.on = false; L_home.centered = true; L_home.halfW = 8; L_home.off = [0, 18];
  (function () { var mv = L_hubx.concat(L_grp, [L_home]); mv.forEach(function (L) { labels.splice(labels.indexOf(L), 1); }); var at = labels.indexOf(L_guest[0]); Array.prototype.splice.apply(labels, [at, 0].concat(mv)); })();
  function netLabelsRefresh() {
    var i, ns = NETD.secs, nh = 0;
    // one line each (§7): "PHONES 3" - the sector's state is in the caption and the detail card, not under every name
    for (i = 0; i < L_grp.length; i++) {
      var S = ns[i];
      if (!S) { L_grp[i].sec = null; continue; }
      L_grp[i].sec = S; setLabelText(L_grp[i], S.name + ' ' + S.n, '');
    }
    for (i = 0; i < L_hubx.length; i++) L_hubx[i].hub = null;
    NETD.hubs.forEach(function (H) {
      if (!H.netHub || nh >= L_hubx.length) return;
      var L = L_hubx[nh++], dn = bodyOffline(H.b);
      L.hub = H; setLabelText(L, (shortName(H.b) || 'Switch') + downTag(H.b), '');
      setLabelClass(L, 'lbl planet' + (dn ? ' down' : '') + (H.b.lab ? ' lab' : ''));
    });
    /* the wall's definition (netscene.js system captions: sys.count from /api/universe, i.e. the bodies of sys:home), so
       both screens say the same number; it used to count every body of the core + home frames ("37" next to the wall's
       "Home 29"). Fallback when the system carries no count: sys:home bodies minus gateway / switches / APs. */
    var HF = UNI.frames['sys:home'], nb = HF && HF.sys && HF.sys.count != null ? +HF.sys.count : 0;
    if (!(HF && HF.sys && HF.sys.count != null)) Object.keys(UNI.recs).forEach(function (id) { var R = UNI.recs[id]; if (!R.b || R.b.system !== 'sys:home') return; var c = R.b['class']; if (c !== 'switch' && c !== 'ap' && c !== 'gateway') nb++; });
    setLabelText(L_home, 'Home network · ' + nb, '');
  }
  var _p = new THREE.Vector3(), _local = new THREE.Vector3();
  // write-then-read batching: a chapter/subject change can retext up to ~70 labels at once
  // (e.g. a full-galaxy host shot). Measuring offsetWidth right after each write forces a
  // synchronous layout on every single one of them (classic layout-thrashing — this is what
  // dropped a frame to ~40fps at chapter transitions); queue the changed labels instead and
  // measure them all in one pass after every write for this batch is done, so the browser
  // only has to reflow once.
  var PENDING_MEASURE = [];
  // static clash-avoidance ring pattern for pool labels, built ONCE: [side, ring] pairs, read
  // scalar-only inside the per-label per-frame search below. The old version rebuilt a fresh
  // array-of-arrays of 12 candidates for every visible label on every single frame — with up to
  // ~26 guests labelled at once (INFRA) during the showcase that's ~1500+ tiny allocations/sec
  // of nothing but GC pressure, and was very likely the source of the mid-playthrough fps dip.
  // 9 rings * 2 sides = 18 vertical slots plus 4 wide-reach corners = 22 candidates, enough
  // headroom that a 26-guest cluster only rarely has to hide one (never clip — see below).
  //
  // Candidates are walked in order and the first non-clashing one wins, so ORDER matters: they
  // must run nearest-the-star first, widening out only as far as a clash actually forces. Every
  // label's true anchor is a small FIXED screen-space offset from its projected star — ~14px
  // right, ~14px up (LBL_ANCHOR_DY, scaled by that label's own height in the loop below) — and
  // is tried first; the rest of the ring list is then walked nearest-to-that-anchor first, only
  // to dodge an actual clash. The old order ran raw ring index 0..8 (dy -4..+4) start to finish,
  // i.e. it tried the FARTHEST ring (dy -4, ~150px up) FIRST — with only 1-3 labels on screen and
  // nothing to clash with, that first candidate was always accepted, which is exactly why a lone
  // guest label (zabbix-ha-b, ch_08) was landing ~150px from its star instead of right beside it.
  var LBL_RING_N = 9, LBL_CANDS = [], LBL_ANCHOR_DY = -0.5;
  (function () {
    var half = LBL_RING_N >> 1, raw = [];
    for (var ring = 0; ring < LBL_RING_N; ring++) raw.push(ring - half);
    raw.sort(function (a, b) { return Math.abs(a - LBL_ANCHOR_DY) - Math.abs(b - LBL_ANCHOR_DY); });
    LBL_CANDS.push([1, LBL_ANCHOR_DY]); LBL_CANDS.push([-1, LBL_ANCHOR_DY]);           // the anchor itself, both sides
    raw.forEach(function (dy) { LBL_CANDS.push([1, dy]); LBL_CANDS.push([-1, dy]); }); // then widen out ring by ring
    LBL_CANDS.push([1, half + 1, 0.4]); LBL_CANDS.push([1, -half - 1, 0.4]); LBL_CANDS.push([-1, half + 1, 0.4]); LBL_CANDS.push([-1, -half - 1, 0.4]);
  })();
  // cores + sun as label obstacles: projected to screen space once a frame (animate() calls
  // projectObstacle for each, right after it computes that mesh's own capped world radius —
  // see the core/sun size-cap comments in the render loop), then consulted by every pool-label
  // candidate below so no guest/client label is ever placed on top of a bright disc (verified
  // on screen: a category's guest labels were unreadable sitting directly on the core).
  // 0/1 = galaxy cores, 2 = sun, 3/4/5 = gateway/switch/ap planets (the fabric stops frame those
  // close enough that a client label parked on the disc was unreadable — verified on screen)
  /* label-collision obstacles: one per configured galaxy core, then the sun,
     the three fabric planets and THE EDGE core. Indices are derived, never
     literal, so a 5-node estate gets 5 core obstacles. */
  // 0/1 = the composed pair's cores (galaxy.obIdx), 2 = sun, 3/4/5 = gateway/switch/ap, 6 = THE EDGE core; growth
  // galaxies append their own (ensureGalaxies)
  var OBSTACLES = []; for (var oi0 = 0; oi0 < 7; oi0++) OBSTACLES.push({ x: 0, y: 0, r: 0, active: false });
  var _obP = new THREE.Vector3();
  function projectObstacle(o, worldPos, worldR, camDist) {
    _obP.copy(worldPos).project(cam);
    if (_obP.z >= 1 || _obP.x < -1.3 || _obP.x > 1.3 || _obP.y < -1.3 || _obP.y > 1.3 || camDist < 1) { o.active = false; return; }
    o.x = (_obP.x * 0.5 + 0.5) * innerWidth; o.y = (-_obP.y * 0.5 + 0.5) * innerHeight;
    var halfVFOV = (cam.fov * Math.PI / 180) / 2;
    o.r = (worldR / camDist) / Math.tan(halfVFOV) * (innerHeight / 2);
    o.active = true;
  }
  function circleRectOverlap(cx, cy, cr, bx1, by1, bx2, by2) {
    var nx = clamp(cx, bx1, bx2), ny = clamp(cy, by1, by2), dx = cx - nx, dy = cy - ny;
    return (dx * dx + dy * dy) < cr * cr;
  }
  function setLabelText(L, title, sub) {
    if (L._title === title && L._sub === sub) return;
    L._title = title; L._sub = sub;
    L.el.firstChild.textContent = title; L.el.lastChild.textContent = sub;
    measureLater(L);
  }
  // class swap (e.g. a country label growing into the big .viewer tier) changes the box size: re-measure with the text batch
  function setLabelClass(L, cls) { if (L._cls === cls) return; L._cls = cls; L.el.className = cls; measureLater(L); }
  // lab gear (registry/Zabbix lab:true) carries a small muted LAB tag after its name; the tag changes the box width
  function labTag(L, on) { on = !!on; if (L._lab === on) return; L._lab = on; L.el.classList.toggle('lab', on); measureLater(L); }
  function measureLater(L) { if (!L._pm) { L._pm = true; PENDING_MEASURE.push(L); } }
  /* 2026-10-05: a poll used to force up to five synchronous layouts (exo, edge, planets, labels, ...) - each caller
     flushed its own batch right after its writes. Callers now only queue; labelsTick() measures everything queued in
     ONE pass at the start of the next frame, before it places anything, so no box is ever placed with a stale size. */
  function flushLabelMeasure() { }
  function flushLabelMeasureNow() {
    if (!PENDING_MEASURE.length) return;
    for (var i = 0; i < PENDING_MEASURE.length; i++) { var L = PENDING_MEASURE[i]; L._pm = false; L.w = L.el.offsetWidth; L.h = L.el.offsetHeight; }
    PENDING_MEASURE.length = 0;
  }
  /* motion fade: the whole label layer dims while the camera is genuinely flying (camSpeed is
     a screen-relative rate maintained by applyCam(); the hold-orbit sway sits far below the
     threshold, a stop-to-stop leg far above it). Labels are DOM boxes projected from 3D —
     during a 1.7s leg they streak, swap slots and re-text mid-air, which is most of what made
     transitions read as messy. Fading them out on the way and back in on arrival (plus
     deferring the subject swap to mid-leg, see D.pendingSubj) turns that into a clean reveal.
     One inline-style write on #labels, only when the quantised value changes. */
  var labelFade = 1, labelFadeStr = '';
  function labelFadeTick(dt) {
    var mot = clamp((camSpeed - 0.10) / 0.45, 0, 1), want = 1 - 0.92 * mot;
    labelFade += (want - labelFade) * (1 - Math.exp(-dt / (want < labelFade ? 0.09 : 0.22)));   // quick out, gentler in
    var s = labelFade > 0.985 ? '1' : (Math.round(labelFade * 40) / 40).toFixed(3);
    if (s !== labelFadeStr) { labelFadeStr = s; labelLayer.style.opacity = s; }
  }
  var LBL_K = 0.3;   // per-frame screen-position damping gain, recomputed from dt in labelsTick
  // damped screen placement: a label follows its (already clash-resolved) target with a ~45ms
  // time constant, which kills the frame-to-frame sub-pixel shimmer the wall's 5 Hz prog ticks
  // put into the projection during sync travel. A jump larger than 220px (slot flip, reappear)
  // snaps instead of gliding across the screen.
  function placeLabel(L, x, y) {
    if (L._vis && Math.abs(x - L.sx) + Math.abs(y - L.sy) < 220) { L.sx += (x - L.sx) * LBL_K; L.sy += (y - L.sy) * LBL_K; }
    else { L.sx = x; L.sy = y; }
    L._vis = true;
    /* §9.4 (2026-10-10): whole CSS pixels, never sub-pixel. Text resampled at a fractional offset shimmers frame to frame
       in a video; a rounded position only ever steps a full pixel. Centred labels subtract their own measured half width
       here (translateX(-50%) on an odd width put them back on a half pixel). */
    var rx = Math.round(L.centered && L.w ? L.sx - L.w / 2 : L.sx), ry = Math.round(L.sy);
    var tx = 'translate3d(' + rx + 'px,' + ry + 'px,0)' + (L.centered && !L.w ? ' translateX(-50%)' : '');
    // last-written values are cached on L (reading el.style back for ~250 labels a frame was CSSOM work for nothing)
    if (L._tx !== tx) { L._tx = tx; L.el.style.transform = tx; }
    if (L._op !== 1) { L._op = 1; L.el.style.opacity = '1'; }
  }
  function hideLabel(L) { L._vis = false; if (L._op !== 0) { L._op = 0; L.el.style.opacity = '0'; } if (L.lead && L._leadTx) { L._leadTx = ''; L.lead.style.opacity = '0'; } }
  // leader from the star (x0,y0) to the nearest point on the placed box; transform + opacity writes only when changed
  function placeLeader(L, x0, y0, w, h) {
    var tx = clamp(x0, L.sx, L.sx + w), ty = clamp(y0, L.sy, L.sy + h), dx = tx - x0, dy = ty - y0, len = Math.sqrt(dx * dx + dy * dy);
    if (len < 22) { if (L._leadTx) { L._leadTx = ''; L.lead.style.opacity = '0'; } return; }
    var ux = dx / len, uy = dy / len, gap = 11;   // start just outside the star's own glow
    var s = 'translate3d(' + Math.round(x0 + ux * gap) + 'px,' + Math.round(y0 + uy * gap) + 'px,0) rotate(' + Math.atan2(dy, dx).toFixed(2) + 'rad) scaleX(' + Math.round(len - gap) + ')';
    if (s !== L._leadTx) { if (!L._leadTx) L.lead.style.opacity = '1'; L._leadTx = s; L.lead.style.transform = s; }
  }
  var PLACED = new Float64Array(4 * 320), PLACED_N = 0, _p2 = new THREE.Vector3();
  var SLOT_DIR = [[0, -1], [0, 1], [1, 0], [-1, 0], [0.7071, -0.7071], [-0.7071, -0.7071], [0.7071, 0.7071], [-0.7071, 0.7071]];
  // hub-name leader: a hairline from the star's rim to the nearest point of the label box (callout-ring slots only)
  function hubLead(L, on, sx, sy, rpx, bx, by, bw, bh) {
    if (!on) { if (L.lead && L._leadTx) { L._leadTx = ''; L.lead.style.opacity = '0'; } return; }
    if (!L.lead) { L.lead = document.createElement('div'); L.lead.className = 'lead hub'; labelLayer.appendChild(L.lead); }
    var tx = clamp(sx, bx, bx + bw), ty = clamp(sy, by, by + bh), dx = tx - sx, dy = ty - sy, len = Math.sqrt(dx * dx + dy * dy);
    if (len < rpx + 8) { if (L._leadTx) { L._leadTx = ''; L.lead.style.opacity = '0'; } return; }
    var ux = dx / len, uy = dy / len, g0 = rpx + 3;
    var tr = 'translate3d(' + Math.round(sx + ux * g0) + 'px,' + Math.round(sy + uy * g0) + 'px,0) rotate(' + Math.atan2(dy, dx).toFixed(2) + 'rad) scaleX(' + Math.round(len - g0 - 2) + ')';
    if (tr !== L._leadTx) { if (!L._leadTx) L.lead.style.opacity = '1'; L._leadTx = tr; L.lead.style.transform = tr; }
  }
  var STAR = new Float64Array(3 * 32), STAR_N = 0, PLAN = new Float64Array(3 * 96), PLAN_N = 0, _p3 = new THREE.Vector3();
  /* 2026-10-09 label-vs-glare: a hub star is not just its disc. The photographic look (bodies3d PHOTO) draws a bright
     corona out to ~1.5 disc radii and four '+' diffraction spikes (screen-aligned, SPIKE_ROT 0) that stay visible to
     ~2.6 disc radii - measured on the wired stop's frames: a small device disc ~23 px, spikes ~±55 px; the gateway ~±100 px.
     Names used to be tested against the bare disc only, so a lab switch's name sat on its own horizontal spike and halo
     and a switch name on its vertical spike. STAR now carries the glare radius, SPK the spike arm length (both screen px, per frame, preallocated),
     and every placement also tests the two thin spike bars. Slot gaps grow with the glare so a name hugs the halo, not the
     disc; with the cardinal slots blocked by the spikes the near-ring diagonals win, like a real star chart. */
  var GLARE_K = 1.5, SPIKE_K = 2.6, SPIKE_W = 3, SPK = new Float64Array(32);
  function circPush(arr, n, cap, p, r, W, H) {
    if (n >= cap) return n;
    _p3.copy(p).project(cam); if (_p3.z >= 1) return n;
    var d = Math.max(1, cam.position.distanceTo(p)), rp = (r / d) / Math.tan(cam.fov * Math.PI / 360) * (H / 2);
    arr[n * 3] = (_p3.x * 0.5 + 0.5) * W; arr[n * 3 + 1] = (-_p3.y * 0.5 + 0.5) * H; arr[n * 3 + 2] = rp; return n + 1;
  }
  // a hub star: glare circle (GLARE_K x the disc) + spike arm (SPIKE_K x the disc, capped so a close-up does not black out the frame)
  function starPush(p, r, W, H) {
    var n0 = STAR_N; STAR_N = circPush(STAR, STAR_N, 32, p, r, W, H);
    if (STAR_N > n0) { var rp = STAR[n0 * 3 + 2]; STAR[n0 * 3 + 2] = rp * GLARE_K + 2; SPK[n0] = Math.min(220, rp * SPIKE_K); }
  }
  // does the box (b1,b2)-(b3,b4) sit on any hub star's glare or on one of its four spikes?
  function onStarGlare(b1, b2, b3, b4) {
    for (var i = 0; i < STAR_N; i++) {
      var x = STAR[i * 3], y = STAR[i * 3 + 1], a = SPK[i];
      if (circleRectOverlap(x, y, STAR[i * 3 + 2], b1, b2, b3, b4)) return true;
      if (b2 < y + SPIKE_W && b4 > y - SPIKE_W && b1 < x + a && b3 > x - a) return true;   // horizontal spike
      if (b1 < x + SPIKE_W && b3 > x - SPIKE_W && b2 < y + a && b4 > y - a) return true;   // vertical spike
    }
    return false;
  }
  // the home network's stars (every label avoids them) and its planets (the slot-placed names avoid those too),
  // computed once per frame and only while the star-system names are on screen
  function starsScreen(W, H) {
    STAR_N = 0; PLAN_N = 0;
    if (!UNI.on || !L_gw.on) return;
    starPush(fab.gateway.pos, fabR('gateway') * 1.25, W, H);
    for (var k = 0; k < NETD.hubs.length; k++) { var Hb = NETD.hubs[k]; starPush(Hb.wp, (Hb.b['class'] === 'ap' ? fabR('ap') : fabR('switch')) * 1.25, W, H); }
    for (var q = 0; q < UNI.n && PLAN_N < 96; q++) {
      var Pq = UNI.pool[q]; if (!Pq || Pq.hub || Pq.netHub || !Pq.net || Pq.F.vis < 0.5) continue;
      var n1 = PLAN_N; PLAN_N = circPush(PLAN, PLAN_N, 96, Pq.wp, R3K * Pq.ci.size * 0.85, W, H);
      // far away a planet is drawn as a star point (bodies3d starPx ~5.4 device px plus its PSF halo): never thinner than that
      if (PLAN_N > n1 && PLAN[n1 * 3 + 2] < 5) PLAN[n1 * 3 + 2] = 5;
    }
  }
  function placedPush(a, b, c, d) { if (PLACED_N + 4 > PLACED.length) return; PLACED[PLACED_N] = a; PLACED[PLACED_N + 1] = b; PLACED[PLACED_N + 2] = c; PLACED[PLACED_N + 3] = d; PLACED_N += 4; }
  function labelsTick(dt) {
    flushLabelMeasureNow();
    var W = innerWidth, H = innerHeight, placed = PLACED; PLACED_N = 0;
    LBL_K = 1 - Math.exp(-dt / 0.045);
    // the top/bottom HUD band + the two node-card zones only exist to dodge chrome that's
    // actually ON SCREEN — but the showcase hides every bit of it (cards/clock/date/status/
    // legend/brand/brackets all go opacity:0 under body.nx-showcase, see nexus.html), leaving
    // only its own thin 8.5vh letterbox bars. Reserving the old, much taller 19%/80% band (and
    // the full card zone) during showcase was hiding labels for content that wasn't actually
    // there to clash with — this was silently capping a small galaxy at 6 of its 8 guests labelled.
    // the showcase hides every bit of chrome but its letterbox bars (8.5vh); otherwise the bands are the production HUD's (HUDZ)
    var topBand = SC.active ? H * 0.085 : H * HUDZ.top, botBand = SC.active ? H * (1 - 0.085) - 44 : H * HUDZ.bot;
    var cY0 = H * HUDZ.cardY0, cY1 = H * HUDZ.cardY1, cXL = W * HUDZ.cardX, cXR = W * (1 - HUDZ.cardX), sX = W * HUDZ.statX, sY = H * HUDZ.statY;
    starsScreen(W, H);
    for (var i = 0; i < labels.length; i++) {
      var L = labels[i];
      if (!L.on) { hideLabel(L); continue; }
      var x, y, shown = true;
      if (L.slotPos) {
        /* star-system hub names and group labels (2026-10-08): SLOT placement. The network system spins, so whatever
           framing a stop lands on, the stars sit somewhere new each lap; a label pushed down by its neighbours used
           to end up far from its star (and hid) or got slid sideways into another name after its collision test.
           Now each label tries four slots hugging its own star - above, below, right, left (last lap's winner first)
           - against the HUD bands, the node cards, every already-placed label and every hub star's disc, and takes
           the first clear one. Hub names are processed before group labels, so a group label only gets what is left. */
        _p2.copy(L.slotPos).project(cam);
        if (_p2.z >= 1 || _p2.x < -1.2 || _p2.x > 1.2 || _p2.y < -1.2 || _p2.y > 1.2) { hideLabel(L); continue; }
        var sx = (_p2.x * 0.5 + 0.5) * W, sy = (-_p2.y * 0.5 + 0.5) * H;
        var rpx = L.slotR ? (L.slotR / Math.max(1, cam.position.distanceTo(L.slotPos))) / Math.tan(cam.fov * Math.PI / 360) * (H / 2) : 0;
        var hw = L.w || 150, hh = L.h || 32, okS = false, prev = L._slot == null ? -1 : L._slot, bx = 0, by = 0;
        /* candidates: 8 directions (up, down, right, left, then the diagonals) at two distances - hugging the star, and
           a callout ring ~64 px further out joined to the star by a hairline leader. Order: the slot it already holds
           (planets drifting under it never make it hop), every slot clear of planets (near ring first), then every slot
           allowing a planet to graze: a name beside its star beats a perfect empty frame. Other labels, stars, HUD
           chrome and the node cards are never overlapped. pass 1 = planets ignored. */
        /* 2026-10-09: the held slot only keeps priority while it is on the NEAR ring; a name parked out on the callout ring
           (it was crowded once, mid-leg) comes back beside its star as soon as a near slot is clear, instead of keeping a
           leader line for the rest of the stop. Order: held near slot, near ring, held far slot, far ring, then pass 1. */
        for (var si2 = 0; si2 < 34 && !okS; si2++) {
          var sl, pass;
          if (si2 === 0) { sl = prev < 8 ? prev : -1; pass = 1; }
          else if (si2 <= 8) { sl = si2 - 1; pass = 0; }
          else if (si2 === 9) { sl = prev >= 8 ? prev : -1; pass = 1; }
          else if (si2 <= 17) { sl = si2 - 2; pass = 0; }
          else { sl = si2 - 18; pass = 1; }
          if (sl < 0 || (si2 !== 0 && si2 !== 9 && sl === prev && pass === 1) || (sl >= 8 && !L.slotR)) continue;   // group labels: near ring only
          var dir = SLOT_DIR[sl & 7], far = sl >= 8, gap = (L.slotR ? rpx * GLARE_K + 8 : rpx + 6) + (far ? 64 : 0);   // hug the glare, not the disc
          var ax = sx + dir[0] * gap, ay = sy + dir[1] * gap;
          // the box sits on the far side of the anchor point along the slot direction
          var lx = dir[0] > 0.3 ? ax : dir[0] < -0.3 ? ax - hw : ax - hw / 2;
          var ty0 = dir[1] < -0.3 ? ay - hh : dir[1] > 0.3 ? ay : ay - hh / 2;
          var b1 = lx - 5, b2 = ty0 - 2, b3 = lx + hw + 5, b4 = ty0 + hh + 2;
          if (b1 < 0 || b3 > W || b2 < topBand || b4 > botBand) continue;
          if (!SC.active && b4 > cY0 && b2 < cY1 && (b1 < cXL || b3 > cXR)) continue;   // node cards
          if (!SC.active && b3 > sX && b2 < sY) continue;                                 // estate status panel
          var hitS = false;
          for (var pq = 0; pq < PLACED_N && !hitS; pq += 4) if (b1 < placed[pq + 2] && b3 > placed[pq] && b2 < placed[pq + 3] && b4 > placed[pq + 1]) hitS = true;
          if (!hitS && onStarGlare(b1, b2, b3, b4)) hitS = true;
          // pass 0: clear of every planet; pass 1 lets a planet's faint outskirts graze the box, never its bright point (4 px)
          for (var pl = 0; pl < PLAN_N && !hitS; pl++) if (circleRectOverlap(PLAN[pl * 3], PLAN[pl * 3 + 1], pass === 0 ? PLAN[pl * 3 + 2] + 2 : 4, b1, b2, b3, b4)) hitS = true;
          for (var ob2 = 0; ob2 < OBSTACLES.length && !hitS; ob2++) { var obx = OBSTACLES[ob2]; if (obx.active && circleRectOverlap(obx.x, obx.y, obx.r, b1, b2, b3, b4)) hitS = true; }
          if (hitS) continue;
          okS = true; L._slot = sl; x = lx + hw / 2; y = ty0; bx = lx; by = ty0; placedPush(b1, b2, b3, b4);
        }
        if (!okS) { L._slot = null; hideLabel(L); hubLead(L, 0); continue; }
        placeLabel(L, x, y);
        // a callout-ring slot gets its hairline leader from the star's edge to the nearest point of the drawn box
        if (L.slotR && L._slot >= 8) hubLead(L, 1, sx, sy, rpx * GLARE_K, L.sx - hw / 2, L.sy, hw, hh); else hubLead(L, 0);
        continue;
      }
      _p.copy(L.pos).project(cam);
      var vis = _p.z < 1 && _p.x > -1.1 && _p.x < 1.1 && _p.y > -1.1 && _p.y < 1.1;
      if (!vis) { hideLabel(L); continue; }
      var x0 = (_p.x * 0.5 + 0.5) * W, y0 = (-_p.y * 0.5 + 0.5) * H;
      if (L.poolItem) {
        var w = L.w || 90, h = L.h || 26, pad = 4;
        if (!SC.active && x0 > sX && y0 < sY) { hideLabel(L); continue; }   // anchor itself under the status block: never label it there
        shown = false;
        // slot hysteresis: the slot this label won LAST frame is tried before the ring walk, so a
        // label only moves when its old slot genuinely clashes now — without this, two labels
        // near each other could trade sides every frame as their projected order flickered
        var first = L._ci == null ? -1 : L._ci;
        for (var k = -1; k < LBL_CANDS.length; k++) {
          var ci = k < 0 ? first : k;
          if (ci < 0 || (k >= 0 && ci === first)) continue;
          var cd = LBL_CANDS[ci], side = cd[0], dy = cd[1] * (h + 6), reach = cd[2] || 0;
          var cx = side > 0 ? x0 + 14 + reach * w : x0 - w - 14 - reach * w, cy = y0 + dy - h * 0.5;
          var bx1 = cx - pad, by1 = cy - pad, bx2 = cx + w + pad, by2 = cy + h + pad;
          if (bx1 < 0 || bx2 > W || by1 < topBand || by2 > botBand) continue;                       // off-screen / into top or bottom HUD (or letterbox) bands
          if (!SC.active && bx2 > sX && by1 < sY) continue;                             // status block (big line + sub + THREAT chip) top-right: verified on the overview that station/guest labels parked under it read as clutter next to "1 HOST DOWN"
          if (!SC.active && by2 > cY0 && by1 < cY1 && (bx1 < cXL || bx2 > cXR)) continue;  // into the two node cards (hidden during showcase)
          var onObstacle = false;
          for (var oi = 0; oi < OBSTACLES.length; oi++) { var ob = OBSTACLES[oi]; if (ob.active && circleRectOverlap(ob.x, ob.y, ob.r, bx1, by1, bx2, by2)) { onObstacle = true; break; } }
          if (!onObstacle && onStarGlare(bx1, by1, bx2, by2)) onObstacle = true;
          if (onObstacle) continue;                                                                 // a core/sun disc (or a hub star) — never park a label on top of it
          var clash = false;
          for (var q = 0; q < PLACED_N; q += 4) { if (bx1 < placed[q + 2] && bx2 > placed[q] && by1 < placed[q + 3] && by2 > placed[q + 1]) { clash = true; break; } }
          if (!clash) { x = cx; y = cy; placedPush(bx1, by1, bx2, by2); shown = true; L._ci = ci; break; }
        }
        if (!shown) { hideLabel(L); continue; }
        if (L.lead) { placeLabel(L, x, y); placeLeader(L, x0, y0, w, h); continue; }   // placed first so the leader sees the damped box position
        var far = cam.position.distanceTo(L.pos) > 420;
        if (L._far !== far) { L._far = far; L.el.classList.toggle('far', far); }
      } else {
        var inHud = y0 < topBand || y0 > botBand || (!SC.active && y0 > cY0 && y0 < cY1 && (x0 < cXL || x0 > cXR));
        // real measured width once available (post first setLabelText+flush); the halfW guess
        // is only a pre-measurement fallback — see the comment where L_sun etc. are created
        var lw = L.w || ((L.halfW || 10) / 100 * W * 2), half = lw / 2 + 6;
        if (inHud || x0 < half || x0 > W - half) { hideLabel(L); continue; }
        x = x0 + L.off[0]; y = y0 + L.off[1];
        // landmarks can clash with EACH OTHER too, not just with pool labels routing around
        // them (verified on screen: THE ESTATE's overview angle put the WAN landmark and
        // the U7 Pro planet label close enough to genuinely overlap). A SINGLE fixed nudge
        // (the old H*0.042) was smaller than the label's own box height (H*0.065), so one pass
        // reduced the overlap without ever actually clearing it — push by the EXACT amount
        // needed to clear whichever box it's still hitting, and keep re-scanning every already-
        // placed landmark (not just the one that triggered the push) until nothing clashes or
        // the iteration cap is hit. Labels are processed in creation order (sun/bridge/galaxies
        // before the fabric planets), so that order doubles as priority: if a later landmark
        // still can't find a clear spot within the visible band, hide it rather than clash.
        var lb1, lb2, lb3, lb4;
        /* a label that had to slide far from its anchor names the wrong thing: the star-system hub / group labels
           (L.maxPush) try their usual slot above the anchor, then a slot BELOW it, and hide if neither is close */
        var tries = L.maxPush ? 2 : 1, okPlace = false, yBase = y;
        for (var tr = 0; tr < tries && !okPlace; tr++) {
          var yWant = tr === 0 ? yBase : y0 + (L.offBelow != null ? L.offBelow : 16);
          if (tr === 1 && L.pos2) { _p2.copy(L.pos2).project(cam); yWant = (-_p2.y * 0.5 + 0.5) * H + 4; }   // under its star
          y = yWant; x = x0 + L.off[0]; lb1 = x - half; lb2 = y - 3; lb3 = x + half; lb4 = y + (L.h || 22) + 3;   // the measured one-line box (was a fixed 6.5% of H for the old two-line titles)
          // a wide landmark anchored just inside the free middle still ran under a node card: slide it out of the card
          // zone FIRST, so the collision passes below test the box where it will really be drawn
          if (!SC.active && lb4 > cY0 && lb2 < cY1) {
            var cdx = lb3 > cXR ? cXR - lb3 : lb1 < cXL ? cXL - lb1 : 0;
            if (cdx) { x += cdx; lb1 += cdx; lb3 += cdx; }
          }
          // landmarks dodge the bright discs too (they never did — the WAN landmark sat across
          // the AP planet at WIRELESS, the gateway landmark across its own planet at WIRED): slide
          // the box straight down until it clears every disc it overlaps
          for (var loi = 0; loi < OBSTACLES.length; loi++) {
            var lob = OBSTACLES[loi];
            if (lob.active && circleRectOverlap(lob.x, lob.y, lob.r, lb1, lb2, lb3, lb4)) { var ody = lob.y + lob.r + H * 0.008 - lb2; y += ody; lb2 += ody; lb4 += ody; }
          }
          var lIter = 0, lMoved = true;
          while (lMoved && lIter < 8) {
            lMoved = false;
            for (var lq = 0; lq < PLACED_N; lq += 4) {
              if (lb1 < placed[lq + 2] && lb3 > placed[lq] && lb2 < placed[lq + 3] && lb4 > placed[lq + 1]) {
                var ldy = placed[lq + 3] - lb2 + H * 0.006; y += ldy; lb2 += ldy; lb4 += ldy; lMoved = true;
              }
            }
            lIter++;
          }
          okPlace = !(lb2 < topBand || lb4 > botBand) && !(L.maxPush && (y - yWant) > L.maxPush * H);
        }
        if (!okPlace) { hideLabel(L); continue; }
        placedPush(lb1, lb2, lb3, lb4);
      }
      placeLabel(L, x, y);
    }
  }
  /* scene labels (§7): a short name on one line; state only when it IS the news (down / stopped / new / back). The
     colour carries status only (critical for down / stopped); category and class live on the body itself. */
  var DOWN_INK = '#e5848a';
  function setGuestLabel(L, g) {
    L.on = true; L.mode = 'guest'; L.frame = galaxies[g.node].G; L.local = g._pos; L.rec = null; L.guest = g;
    var up = g.status === 'running';
    setLabelText(L, clip(g.name, 16) + (up ? '' : ' · stopped'), '');
    L.el.classList.toggle('down', !up);
    var GR = g._uid && UNI.recs[g._uid]; labTag(L, GR && GR.b && GR.b.lab);
  }
  /* registry down_why (2026-10-09, optional): offline | stopped | gone. Only OFFLINE is an outage (red "down"); a stopped guest
     or a device not seen for a long time reads muted ("stopped" / "not seen"), never red. Without the field every down
     body counts as offline (as before). */
  function bodyOffline(b) { return !!b && b.status === 'down' && (!b.down_why || b.down_why === 'offline'); }
  function downTag(b) { return !b || b.status !== 'down' ? '' : b.down_why === 'stopped' ? ' · stopped' : b.down_why === 'gone' ? ' · not seen' : ' · down'; }
  // a universe body (device or guest-by-record): its short name, plus its state when that is the news
  function setDevLabel(L, R) {
    if (R.role === 'guest' && R.guest && R.guest._pos) { setGuestLabel(L, R.guest); if (R.ev === 'new' && SIM_T - R.evT < 600) setLabelText(L, clip(R.guest.name, 16) + ' · new', ''); return; }
    L.on = true; L.mode = 'dev'; L.rec = R; L.guest = null;
    var b = R.b, fresh = SIM_T - R.evT < 600, dn = b.status === 'down';
    var tag = dn ? downTag(b) : (fresh && R.ev === 'new') ? ' · new' : (fresh && R.ev === 'up') ? ' · back' : '';
    setLabelText(L, (shortName(b) || cap1(String(b['class'] || 'device').replace('_', ' '))) + tag, '');
    L.el.classList.toggle('down', bodyOffline(b)); labTag(L, b.lab);
  }
  function agoStr(ts) { var a = Math.max(0, Date.now() / 1000 - (+ts || 0)); return a < 3600 ? Math.round(a / 60) + ' min ago' : a < 86400 ? Math.round(a / 3600) + ' h ago' : Math.round(a / 86400) + ' d ago'; }
  // a system's product name: `short` / its registry label, sentence case ("Remote site", "Branch site")
  // the registry's system `short` is ALL CAPS ("PVE1", "BRANCH": the wall's caption style); this screen is sentence case,
  // so a system is named by `short` only when it is not shouting, else by its label ("Branch office")
  function sysLabel(s) { return s ? String(s.short && s.short !== String(s.short).toUpperCase() ? s.short : (s.label || s.id || '')) : ''; }
  function sysName(F) { return F && F.sys ? cap1(sysLabel(F.sys)) : ''; }
  function sysCount(F) { var n = 0, dn = 0; Object.keys(UNI.recs).forEach(function (id) { var R = UNI.recs[id]; if (R.F === F) { n++; if (bodyOffline(R.b)) dn++; } }); return { n: n, dn: dn }; }
  function setHubLabel(L, F) {
    L.on = true; L.mode = 'hub'; L.hubF = F; L.rec = null; L.guest = null;
    setLabelText(L, sysName(F) + ' · ' + sysCount(F).n, '');
    L.el.classList.remove('down');
  }
  // label priority: what changed, then what is down, then the busiest - a ranking for WHICH labels show, never positions
  // news (born / went down / came back in the last 10 min) first, then live bodies by traffic; a body that has simply
  // been down for a while ranks last - it stays drawn (dim, still), it just does not take a label from the news
  function byNews(a, b) { var na = SIM_T - a.evT < 600 ? 1 : 0, nb = SIM_T - b.evT < 600 ? 1 : 0; if (na !== nb) return nb - na; var da = a.b.status === 'down' ? 1 : 0, db = b.b.status === 'down' ? 1 : 0; if (da !== db) return da - db; return b.u - a.u; }
  function notStaleDown(R) { return R.b.status !== 'down' || SIM_T - R.evT < 600; }
  function setClientLabel(L, m) {
    L.on = true; L.mode = 'client'; L.orbit = m;
    var c = m.client, cm = c.meta || {};
    /* 2026-09-14: category + dormancy come from the classifier; a sleeping client says so
       instead of claiming 0 b/s, and takes the category hue the moon itself wears */
    setLabelText(L, shortText(c.label || c.id) || 'Client', '');
    L.el.style.color = cm.offline ? '#8b949e' : '';
  }
  // which entities get a label right now, per the current subject (director state)
  var LABEL = { mode: 'over', node: null, cat: null, id: null };

  /* label budget (§7, research §4): the subject and the news first, a handful of names per stop, one line each, never an
     address. Sites always carry their caption at the overview; galaxy, hub and stream names are landmarks of their own. */
  function named(R) { return !!shortName(R.b); }
  function busiestGuests(list, n) {
    var stopped = list.filter(function (g) { return g.status !== 'running'; }).slice(0, Math.min(3, n));
    return stopped.concat(list.filter(function (g) { return g.status === 'running'; }).sort(function (a, b) { return (b.cpu || 0) - (a.cpu || 0); }).slice(0, n - stopped.length));
  }
  function refreshLabels() {
    var i = 0, pool = L_guest;
    function place(entries, setFn) { for (var e = 0; e < entries.length && i < pool.length; e++) { setFn(pool[i], entries[e]); i++; } }
    if (LABEL.mode === 'over') {
      if (UNI.on) {
        place(uniSites(), setHubLabel);
        // the universe's news only (a birth, a device that went down or came back in the last 10 min), at most two;
        // home-network devices never take an overview label (the HOME NETWORK landmark speaks for the diagram)
        place(uniEvents(12).filter(function (R) { return !isNetF(R.F) && (R.role !== 'dev' || named(R)); }).slice(0, 2), setDevLabel);
      }
    } else if (LABEL.mode === 'host') {
      // a whole galaxy: the busiest few and anything stopped (otherwise you can't tell what the stop is about)
      place(busiestGuests(guestsOf(LABEL.node).filter(function (g) { return g._pos; }), 6), setGuestLabel);
    } else if (LABEL.mode === 'blk') {
      place(busiestGuests(guestsOf(LABEL.node).filter(function (g) { return g.cat === LABEL.cat && g._pos; }), 8), setGuestLabel);
    } else if (UNI.on && LABEL.mode === 'fabric') {
      // the switch fabric: its hubs carry the names; plus the newest / down devices of the core ring
      var nb = uniNetBodies().filter(function (r) { return notStaleDown(r) && !r.netHub && named(r); });
      nb.sort(function (a, b) { var ca = a.F.kind === 'network' ? 1 : 0, cb = b.F.kind === 'network' ? 1 : 0; return (cb - ca) || byNews(a, b); });
      place(nb.slice(0, 3), setDevLabel);
    } else if (UNI.on && (LABEL.mode === 'wired' || LABEL.mode === 'ap')) {
      var kids = uniChildren(LABEL.id).filter(function (r) { return notStaleDown(r) && !r.netHub && named(r); }); kids.sort(byNews); place(kids.slice(0, 4), setDevLabel);
    } else if (UNI.on && LABEL.mode === 'sys') {
      var F = UNI.frames[LABEL.id];
      if (F && F.kind === 'galaxy') place(busiestGuests(guestsOf(F.gal.nd.id).filter(function (g) { return g._pos; }), 8), setGuestLabel);
      else if (F && (F.kind === 'network' || F.kind === 'clients')) { var nb2 = uniNetBodies().filter(function (r) { return r.F === F && notStaleDown(r) && !r.netHub && named(r); }); nb2.sort(byNews); place(nb2.slice(0, 4), setDevLabel); }
      else if (F) { var sb = []; for (var si = 0; si < UNI.n; si++) { var P = UNI.pool[si]; if (P && !P.hub && P.F === F && named(P)) sb.push(P); } sb.sort(byNews); place([F], setHubLabel); place(sb.slice(0, 8), setDevLabel); }
    } else if (LABEL.mode === 'asp') {
      // an aspect names its anchor first, then at most two busy neighbours in the same galaxy (§9.4: the subject's few)
      var AR = aspRec(aspOf(LABEL.id));
      if (AR && AR.role === 'guest' && AR.guest && AR.guest._pos) {
        place([AR.guest], setGuestLabel);
        place(busiestGuests(guestsOf(AR.F.gal.nd.id).filter(function (g) { return g._pos && g !== AR.guest && g.name !== AR.guest.name && g.status === 'running'; }), 2), setGuestLabel);
      } else if (AR && AR.role === 'dev' && named(AR)) place([AR], setDevLabel);
    } else if (LABEL.mode === 'event') {
      // an event cutaway names its subject and nothing else (the caption carries the what)
      var ER = UNI.recs[LABEL.id];
      if (ER && ER.role === 'guest' && ER.guest && ER.guest._pos) place([ER.guest], setGuestLabel);
      else if (ER && ER.role === 'dev' && named(ER)) place([ER], setDevLabel);
    } else if (LABEL.mode === 'fabric' || LABEL.mode === 'wired' || LABEL.mode === 'ap') {
      var wantKind = LABEL.mode === 'fabric' ? null : fabKindOf(LABEL.id);
      place(moonState.filter(function (m) { return !wantKind || m.kind === wantKind; }), setClientLabel);
    }
    for (; i < pool.length; i++) pool[i].on = false;
    flushLabelMeasure();
  }

  /* ============================== exosphere: the outside world (2026-09-14) ==============================
     /api/all external.top_dst / top_src (Akvorado, 1 h window): remote endpoints merged by AS
     name become stations beyond the WAN sun. Station glow = log(bps); comets sun -> station
     (outbound, magenta) and station -> sun (inbound, cyan) spawn at a cadence that follows the
     measured rate; the label carries "AS · CC" and the live rates. edge.cloudflare: an orange
     ring station orbiting the sun whose pulse follows req_per_min. Nothing is drawn without a
     measured value; stations keep their slot while they stay in the top set. */
  var EXO_N = 14, EXO_OUT = SUN.clone().normalize(), EXO_SIDE = new THREE.Vector3(-EXO_OUT.z, 0, EXO_OUT.x).normalize();
  var expos = new Float32Array(EXO_N * 3), excol = new Float32Array(EXO_N * 3), exsz = new Float32Array(EXO_N), exph = new Float32Array(EXO_N);
  var exgeo = new THREE.BufferGeometry();
  exgeo.setAttribute('position', new THREE.BufferAttribute(expos, 3)); exgeo.setAttribute('color', new THREE.BufferAttribute(excol, 3));
  exgeo.setAttribute('size', new THREE.BufferAttribute(exsz, 1)); exgeo.setAttribute('phase', new THREE.BufferAttribute(exph, 1));
  exgeo.setDrawRange(0, 0);
  var exoPts = new THREE.Points(padAttrs(exgeo), pointsMat(TEX_GLOW, 0.12, 1.0, 150)); exoPts.frustumCulled = false; scene.add(exoPts);
  var exoStations = [], exoSlots = {}, exoLines = null, exoSig = '';
  var L_exo = []; for (var xi = 0; xi < EXO_N; xi++) { var LX = mkLabel('station', '<b></b><span></span>'); LX.poolItem = true; LX.on = false; L_exo.push(LX); }
  function exoPos(slot) {
    var j = slot >> 1, odd = slot & 1, per = Math.ceil(EXO_N / 2);
    var a = -1.0 + 2.0 * ((j + 0.5 * odd + 0.5) / per);
    return SUN.clone().addScaledVector(EXO_OUT, 230 + odd * 160 + 50 * Math.abs(Math.sin(a)))
      .addScaledVector(EXO_SIDE, Math.sin(a) * (560 + odd * 130))
      .add(new THREE.Vector3(0, 170 * Math.sin(slot * 1.9) + 30 * odd, 0));
  }
  function shortAS(name, ip) {
    var s = String(name || '').replace(/,?\s*(PBC|Inc\.?|LLC|Ltd\.?|Limited|Corp\.?|Corporation|Technologies|Technology|Holdings|Group|GmbH|B\.?V\.?)\b/gi, '').replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!s) return ip || '?';
    if (/^[A-Z0-9 ]+$/.test(s)) s = s.replace(/\b([A-Z])([A-Z0-9]{3,})\b/g, function (m, a, b) { return a + b.toLowerCase(); });   // GOOGLE CLOUD -> Google Cloud; short acronyms (KT, OVH) stay   // was charAt(0)+slice(1): the \b at the slice start re-capitalised the 2nd letter ("GOogle Cloud" in the intrusion caption)
    return s.length > 18 ? s.slice(0, 17) + '…' : s;
  }
  function exoUpdate(ext) {
    var by = {}, list = [];
    function add(r, dir) {
      if (!r || !(+r.bps > 0)) return;
      var key = (r.as_name || r.ip || '?').toLowerCase(), b = by[key];
      if (!b) { b = by[key] = { key: key, name: shortAS(r.as_name, r.ip), cc: r.cc || '', out: 0, inb: 0 }; list.push(b); }
      b[dir] += +r.bps || 0; if (!b.cc && r.cc) b.cc = r.cc;
    }
    if (ext && ext.up) { (ext.top_dst || []).forEach(function (r) { add(r, 'out'); }); (ext.top_src || []).forEach(function (r) { add(r, 'inb'); }); }
    list.sort(function (a, b) { return (b.out + b.inb) - (a.out + a.inb); }); list = list.slice(0, EXO_N);
    var keep = {}; list.forEach(function (b) { keep[b.key] = 1; });
    Object.keys(exoSlots).forEach(function (k) { if (!keep[k]) { var sl = exoSlots[k]; delete exoSlots[k]; delete FAM['xo' + sl]; delete FAM['xi' + sl]; delete CURVES['xo' + sl]; delete CURVES['xi' + sl]; } });
    var used = {}; Object.keys(exoSlots).forEach(function (k) { used[exoSlots[k]] = 1; });
    list.forEach(function (b) { if (exoSlots[b.key] === undefined) { for (var s = 0; s < EXO_N; s++) if (!used[s]) { used[s] = 1; exoSlots[b.key] = s; break; } } b.slot = exoSlots[b.key]; });
    exoStations = list.filter(function (b) { return b.slot !== undefined; });
    var c = new THREE.Color(), maxSlot = 0;
    for (var i = 0; i < EXO_N; i++) { exsz[i] = 0; L_exo[i].on = false; }
    exoStations.forEach(function (s, rank) {
      var p = exoPos(s.slot); s.pos = p; s.rank = rank; maxSlot = Math.max(maxSlot, s.slot + 1);
      var uo = normBps(s.out), ui = normBps(s.inb), u = Math.max(uo, ui);
      c.setHex(0xdfefff).lerp(new THREE.Color(uo >= ui ? 0xff4fa3 : 0x5ad7ff), 0.35 + 0.4 * u);
      var j = s.slot * 3; expos[j] = p.x; expos[j + 1] = p.y; expos[j + 2] = p.z; excol[j] = c.r; excol[j + 1] = c.g; excol[j + 2] = c.b;
      exsz[s.slot] = 5 + 16 * u; exph[s.slot] = hash(s.key) * 6.28;
      var c1 = SUN.clone().addScaledVector(EXO_OUT, 110).addScaledVector(EXO_SIDE, (p.clone().sub(SUN).dot(EXO_SIDE)) * 0.2);
      var c2 = p.clone().addScaledVector(EXO_OUT, -70);
      CURVES['xo' + s.slot] = new THREE.CubicBezierCurve3(SUN.clone(), c1, c2, p.clone());
      CURVES['xi' + s.slot] = new THREE.CubicBezierCurve3(p.clone(), c2.clone(), c1.clone(), SUN.clone());
      FAM['xo' + s.slot] = { color: 0xff4fa3, bps: s.out, k: 1.0, rate: 0.10 + 1.6 * uo };
      FAM['xi' + s.slot] = { color: 0x5ad7ff, bps: s.inb, k: 1.0, rate: 0.10 + 1.6 * ui };
      var L = L_exo[s.slot];
      setLabelText(L, s.name + ' · ' + fmtBps(s.out + s.inb), '');
      L.pos.copy(p); L.el.style.color = '';
    });
    exgeo.attributes.position.needsUpdate = true; exgeo.attributes.color.needsUpdate = true; exgeo.attributes.size.needsUpdate = true; exgeo.attributes.phase.needsUpdate = true;
    exgeo.setDrawRange(0, maxSlot);
    var sig = exoStations.map(function (s) { return s.key + ':' + s.slot; }).join('|');
    if (sig !== exoSig) {                                   // faint guide arcs, rebuilt only when the station set changes
      exoSig = sig;
      if (exoLines) { scene.remove(exoLines); exoLines.geometry.dispose(); }
      var pts = [];
      exoStations.forEach(function (s) { var cp = CURVES['xo' + s.slot].getPoints(24); for (var k = 0; k + 1 < cp.length; k++) pts.push(cp[k], cp[k + 1]); });
      exoLines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts.length ? pts : [new THREE.Vector3(), new THREE.Vector3()]),
        new THREE.LineBasicMaterial({ color: 0xc9a2ff, transparent: true, opacity: 0.09 * U_LINEK.value, depthWrite: false, blending: THREE.AdditiveBlending }));
      exoLines.frustumCulled = false; scene.add(exoLines);
    }
    flushLabelMeasure();
  }
  /* ============================== THE EDGE stars (2026-09-19) ==============================
     EDGE.guests (the builder's 160-slot star pool) carries: Cloudflare PoPs from edge.cloudflare.locations
     (orange, brightest, near the core, labelled "sea08") and the viewer countries - edge.audience.by_country
     when the zone analytics token is present (size ~ uniques), else external.by_country top 8 from Akvorado
     (size ~ sqrt(bytes)). Positions are hashed from the key so they stay put between polls. Labels are
     pool-placed .lbl.station and only shown at the WAN / EDGE / threat shots (+ PoPs and top 4 at OVERVIEW). */
  var EDGE_N = 24, edgeStars = [], L_estar = [];
  // fixed per-slot state for the live EDGE animation (edgeBreathe): base size/glow from the poll, share weight
  // (-1 = PoP), seconds of arrival flare left, and the poll-time position scratch the spread pass works in
  var edgeBase = new Float32Array(EDGE_N), edgeGlow = new Float32Array(EDGE_N), edgeW = new Float32Array(EDGE_N), edgeFlare = new Float32Array(EDGE_N);
  var epx = new Float32Array(EDGE_N), epy = new Float32Array(EDGE_N), epz = new Float32Array(EDGE_N);
  /* the EDGE moves with the data, every frame, from measured values only:
     - PoP stars pulse at the same cadence the shield station uses (1.2 + req/min / 8 rad/s), amplitude with req/min
     - country stars breathe with their share of the hour's viewers (the top country swells most)
     - an arrival flares its star for 2 s (glow +2.2, size +60%, squared decay) as the mote leaves it
     One 24-float loop + two tiny attribute uploads (size, glow) per frame. */
  function edgeBreathe(dt, t) {
    var n = edgeStars.length; if (!n) return;
    var rpmU = clamp(edgeInfo.rpm / 60, 0, 1), popRate = 1.2 + Math.min(4, edgeInfo.rpm / 8);
    for (var i = 0; i < n; i++) {
      var w = edgeW[i], ph = i * 1.9, br;
      if (w < 0) br = 1 + (0.06 + 0.16 * rpmU) * Math.sin(t * popRate + ph);
      else br = 1 + (0.05 + 0.2 * w) * Math.sin(t * (0.9 + 0.5 * w) + ph);
      var fl = 0;
      if (edgeFlare[i] > 0) { edgeFlare[i] -= dt; fl = clamp(edgeFlare[i] / 2, 0, 1); fl *= fl; }
      EDGE.gs[i] = edgeBase[i] * (br + 0.6 * fl); EDGE.ggl[i] = edgeGlow[i] + 2.2 * fl;
    }
    EDGE.gg.attributes.size.needsUpdate = true; EDGE.gg.attributes.glow.needsUpdate = true;
  }
  // each EDGE star label owns a leader line (.lead, a 1-px div stretched with scaleX): the room-readable .viewer boxes
  // are ~250 px wide while neighbouring stars sit ~60 px apart, so the clash walk legitimately parks a label rows away
  // from its star - verified on a TV as "anonymous blobs" next to labels that belonged to them. labelsTick draws
  // the line from the star to the nearest edge of the box whenever they are more than a few px apart.
  for (var ei = 0; ei < EDGE_N; ei++) {
    var LE = mkLabel('station', '<b></b><span></span>'); LE.poolItem = true; LE.on = false; LE.mode = 'guest'; LE.frame = EDGE.G; LE.local = [0, 0, 0];
    LE.lead = document.createElement('i'); LE.lead.className = 'lead'; labelLayer.appendChild(LE.lead); LE._leadTx = ''; L_estar.push(LE);
  }
  /* edge.audience is the ONLY source of people: real unique humans (monitors and bots already excluded upstream).
     When it is down everything here degrades to tunnel counters and says "requests", never "viewers".
     top = countries sorted by uniques then requests. */
  var edgeInfo = { audience: false, viewers: 0, viewers1h: 0, req5m: 0, req1h: 0, bots: 0, monitors: 0, countries: 0, top: [], hosts: [], streams: 0, rpm: 0, ha: 0, pops: [] }, lastViewers = null, lastCc = null;
  function nCountries(n) { return n + (n === 1 ? ' country' : ' countries'); }
  function edgeSub() {
    return edgeInfo.audience ? plural(edgeInfo.viewers, 'viewer') + ' now · ' + edgeInfo.viewers1h + ' this hour · ' + nCountries(edgeInfo.countries)
      : edgeInfo.streams + ' in-flight · ' + Math.round(edgeInfo.rpm) + ' req/min · ' + edgeInfo.ha + ' HA · requests, not people';
  }
  // the country roll-call ("US 3 · DE 1 · BR 1 · +8 more") for the AUDIENCE caption and the HUD headline
  function audienceRoll(n) {
    var t = edgeInfo.top, s = t.slice(0, n).map(function (r) { return r.cc + ' ' + r.uniques; }).join(' · ');
    return s + (t.length > n ? ' · +' + (t.length - n) + ' more' : '');
  }
  function audienceSub() { return edgeInfo.audience && edgeInfo.top.length ? edgeSub() + ' · ' + audienceRoll(4) : edgeSub(); }
  function edgeUpdate(edge, ext) {
    var cf = (edge && edge.cloudflare) || {}, au = (edge && edge.audience) || {};
    edgeInfo.audience = !!au.up; edgeInfo.viewers = +au.viewers_5m || 0; edgeInfo.viewers1h = +au.viewers_1h || 0; edgeInfo.req5m = +au.requests_5m || 0; edgeInfo.req1h = +au.requests_1h || 0;
    edgeInfo.bots = +au.bots_1h || 0; edgeInfo.monitors = +au.monitors_1h || 0; edgeInfo.hosts = au.up ? (au.by_host || []) : [];
    edgeInfo.streams = +cf.active_streams || 0; edgeInfo.rpm = cf.up ? (+cf.req_per_min || 0) : 0; edgeInfo.ha = +cf.ha_connections || 0;
    edgeInfo.pops = cf.up ? (cf.locations || []).slice(0, 8) : [];
    // request comets: cadence follows req/min, capped so a burst stays readable (3/s); 0 req/min = none
    FAM.edge_in.u = edgeInfo.rpm > 0 ? clamp(0.3 + edgeInfo.rpm / 200, 0, 1) : 0;
    FAM.edge_in.rate = Math.min(3, 0.12 + edgeInfo.rpm / 25);
    var rows = au.up ? (au.by_country || []).filter(function (r) { return r.cc && r.cc !== '??'; }) : [];
    rows.sort(function (a, b) { return ((+b.uniques || 0) - (+a.uniques || 0)) || ((+b.requests || 0) - (+a.requests || 0)); });
    edgeInfo.top = rows.map(function (r) { return { cc: r.cc, uniques: +r.uniques || 0, requests: +r.requests || 0 }; });
    edgeInfo.countries = rows.length;
    // new people since the last poll (only when the REAL audience feed is up; tunnel counters are never viewers):
    // a country whose 1 h unique count rose names the star the mote launches from (newCc); any further viewers_5m
    // rise beyond those is a returning visitor of unknown country and launches from the core (-1)
    var newCc = {}, named = 0;
    if (au.up) {
      var cur = {}; rows.forEach(function (r) { cur[r.cc] = +r.uniques || 0; });
      if (lastCc) rows.forEach(function (r) { var d = cur[r.cc] - (lastCc[r.cc] || 0); if (d > 0) { newCc[r.cc] = d; named += d; } });
      lastCc = cur;
      var rise = (lastViewers != null && edgeInfo.viewers > lastViewers) ? edgeInfo.viewers - lastViewers : 0;
      lastViewers = edgeInfo.viewers;
      for (var ui = 0; ui < Math.min(20, rise - named); ui++) viewPush(-1);
    } else { lastViewers = null; lastCc = null; }
    var list = [];
    edgeInfo.pops.forEach(function (pp, i) { list.push({ key: 'pop:' + pp, pop: true, name: String(pp), sub: 'cloudflare pop', w: 1, rank: i }); });
    var cc = [];
    if (rows.length) {
      var mx = 1; rows.forEach(function (r) { mx = Math.max(mx, +r.uniques || 0); });
      rows.slice(0, EDGE_N - list.length).forEach(function (r) {
        var n = +r.uniques || 0;
        cc.push({ key: 'cc:' + r.cc, cc: r.cc, viewer: true, name: r.cc + ' · ' + n, sub: plural(n, 'viewer') + ' · ' + plural(+r.requests || 0, 'request'), w: n / mx, n: n, fresh: newCc[r.cc] || 0 });
      });
    } else if (ext && ext.up && (ext.by_country || []).length) {
      var rows = (ext.by_country || []).filter(function (r) { return r.cc && r.cc !== '??' && +r.bytes > 0; }).slice(0, 8), mb = 1;
      rows.forEach(function (r) { mb = Math.max(mb, Math.sqrt(+r.bytes)); });
      rows.forEach(function (r) { cc.push({ key: 'cc:' + r.cc, name: r.cc, sub: (r.bps_out ? '↑' + fmtBps(r.bps_out) : '') + (r.bps_in ? (r.bps_out ? '   ' : '') + '↓' + fmtBps(r.bps_in) : ''), w: Math.sqrt(+r.bytes) / mb }); });
    }
    cc.forEach(function (s, i) { s.rank = i; list.push(s); });
    edgeStars = list.slice(0, EDGE_N);
    var c = new THREE.Color(), nS = edgeStars.length;
    for (var i = 0; i < EDGE_N; i++) { EDGE.gs[i] = 0; edgeBase[i] = 0; edgeW[i] = -1; L_estar[i].on = false; }
    edgeStars.forEach(function (s, i) {
      var h = hash(s.key), h2 = hash(s.key + '#'), h3 = hash(s.key + '##');
      var r = s.pop ? 42 + h * 40 : 95 + Math.pow(h, 0.8) * 150, arm = h2 < 0.5 ? 0 : 1;
      var th = arm * Math.PI + r * 0.0165 + (h3 - 0.5) * 0.7;
      epx[i] = Math.cos(th) * r; epy[i] = (h2 - 0.5) * 10; epz[i] = Math.sin(th) * r;
    });
    // spread: hashed spots can coincide (three countries landed within 6 units of each other - verified on a TV as one
    // blob with one label), so a few repulsion passes push any pair closer than EDGE_MIN_D apart in the disc plane.
    // Deterministic for a given star set, so stars still stay put between polls; 24 stars, poll-time only.
    var EDGE_MIN_D = 44;
    for (var it = 0; it < 8; it++) for (var a = 0; a < nS; a++) for (var b = a + 1; b < nS; b++) {
      var dx = epx[b] - epx[a], dz = epz[b] - epz[a], d2 = dx * dx + dz * dz;
      if (d2 < EDGE_MIN_D * EDGE_MIN_D) {
        var d = Math.sqrt(d2), ux = d > 0.001 ? dx / d : 1, uz = d > 0.001 ? dz / d : 0, push = (EDGE_MIN_D - d) / 2;
        epx[a] -= ux * push; epz[a] -= uz * push; epx[b] += ux * push; epz[b] += uz * push;
      }
    }
    edgeStars.forEach(function (s, i) {
      var x = epx[i], y = epy[i], z = epz[i], j = i * 3;
      EDGE.gp[j] = x; EDGE.gp[j + 1] = y; EDGE.gp[j + 2] = z;
      // gold = people (same hue as the viewer motes), orange = tunnel PoPs, pale violet = the flow-bytes fallback.
      // size AND glow follow uniques (w = share of the top country): the top country projects ~3x the pixels of a
      // single-visitor one, still under the pool's 240 px cap on a close approach
      if (s.pop) c.setHex(0xffa050); else if (s.viewer) c.setHex(0xe6d8ff).lerp(new THREE.Color(0xffd166), 0.35 + 0.65 * s.w); else c.setHex(0xd9c8ff);
      EDGE.gc[j] = c.r; EDGE.gc[j + 1] = c.g; EDGE.gc[j + 2] = c.b;
      // base size/glow; edgeBreathe() modulates these per frame (PoP pulse at req/min, country breath by share, arrival flare)
      edgeBase[i] = s.pop ? 34 : s.viewer ? 18 + 44 * s.w : 12 + 20 * s.w; edgeGlow[i] = s.pop ? 1.2 : s.viewer ? 0.5 + 1.2 * s.w : 0.3 + 0.6 * s.w; edgeW[i] = s.pop ? -1 : s.w;
      EDGE.gs[i] = edgeBase[i]; EDGE.ggl[i] = edgeGlow[i]; EDGE.gcat[i] = 0;
      var L = L_estar[i]; L.local[0] = x; L.local[1] = y; L.local[2] = z; L.star = s;
      setLabelText(L, s.name, ''); L.el.style.color = '';
      if (s.fresh) { for (var fi = 0; fi < s.fresh && fi < 5; fi++) viewPush(i); viewerArrived(s); }
    });
    ['position', 'color', 'size', 'glow'].forEach(function (k) { EDGE.gg.attributes[k].needsUpdate = true; });
    EDGE.gg.setDrawRange(0, edgeStars.length);
    setLabelText(L_edge, 'Cloudflare edge · ' + (edgeInfo.audience ? plural(edgeInfo.viewers, 'viewer') : pluralX(edgeInfo.pops.length, 'PoP', 'PoPs')), '');
    flushLabelMeasure();
  }
  /* Cloudflare edge: a ring station on the WAN sun */
  var cfPivot = new THREE.Group(); cfPivot.rotation.set(1.15, 0, 0.35); sun.add(cfPivot);
  var cfRing = ringPlane(TEX_RING, 0xf6821f, 0); cfRing.scale.setScalar(SUN_R * 2.1); cfPivot.add(cfRing);
  var cfStation = new THREE.Sprite(new THREE.SpriteMaterial({ map: TEX_GLOW, color: 0xffa050, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }));
  cfStation.scale.set(90, 90, 1); cfPivot.add(cfStation);
  /* pool-placed (ring walk around the orbiting station) rather than a fixed-offset landmark:
     as a landmark it was shoved down off the sun disc into the WAN label and hidden */
  var L_cf = mkLabel('station cf', '<b>Cloudflare tunnel</b><span></span>'); L_cf.poolItem = true; L_cf.on = false;
  // intrusion burst (2026-09-19): a red shockwave annulus in the shield ring's own plane, fired by threatArrive()
  var thWave = ringPlane(TEX_RING, 0xff5a6a, 0); thWave.scale.setScalar(SUN_R * 2.1); cfPivot.add(thWave);
  var cfState = { up: false, rpm: 0 };
  function exoTick(dt, t, sunNear) {
    var cf = S.edge && S.edge.cloudflare, night = document.body.classList.contains('st-night');
    cfState.up = !!(cf && cf.up); cfState.rpm = cfState.up ? (+cf.req_per_min || 0) : 0;
    cfPivot.rotation.y += dt * 0.06;
    var a = t * 0.11, R = SUN_R * 2.1;
    cfStation.position.set(Math.cos(a) * R, Math.sin(a) * R, 0);
    var pulse = cfState.up ? 0.5 + 0.5 * Math.sin(t * (1.2 + Math.min(4, cfState.rpm / 8))) : 0;
    /* same close-range trim the sun's own halo gets: from the fabric stops the ring is a
       supporting body and must not fill the frame (verified on screen: it did) */
    var sn = 1 - (sunNear || 0), trim = sn * sn * (night ? 0.6 : 1);
    cfRing.material.opacity = (cfState.up ? 0.14 + 0.08 * pulse : 0.03) * trim;
    cfStation.material.opacity = (cfState.up ? 0.5 + 0.3 * pulse : 0.1) * trim;
    cfStation.getWorldPosition(L_cf.pos);
    // AUDIENCE frames people only: no AS stations (they are bytes, not viewers), every country star labelled
    var mode = LABEL.mode, wantN = (mode === 'wan' || mode === 'edge') ? EXO_N : mode === 'threat' ? 4 : 0;
    L_cf.on = cfState.up && (mode === 'wan' || mode === 'edge' || mode === 'threat' || mode === 'audience') && !SC.active;
    // EDGE stars: PoPs + every country at WAN/EDGE/threat/audience, PoPs + top 3 countries at OVERVIEW, nothing elsewhere
    var edgeAll = mode === 'wan' || mode === 'edge' || mode === 'threat' || mode === 'audience', edgeSome = false;   // the overview's label budget goes to the estate
    for (var ii = 0; ii < edgeStars.length; ii++) { var st = edgeStars[ii]; L_estar[ii].on = !night && (edgeAll || (edgeSome && (st.pop || st.rank < 3))); }
    if (L_cf.on) setLabelText(L_cf, 'Cloudflare tunnel · ' + Math.round(cfState.rpm) + ' req/min', '');
    for (var i = 0; i < exoStations.length; i++) { var s = exoStations[i]; L_exo[s.slot].on = s.rank < wantN && !night; }
    // AS stations recede in the AUDIENCE frame (eased, ~0.6 s): they are the same glow sprite as a country star and
    // read as unlabelled "viewers" otherwise - verified on a TV as eight anonymous blobs around the disc
    var exoWant = night ? 0.6 : mode === 'audience' ? 0.15 : 1;
    exoAlpha += (exoWant - exoAlpha) * (1 - Math.exp(-dt / 0.6));
    exoPts.material.uniforms.uAlpha.value = exoAlpha;
  }
  var exoAlpha = 1;

  /* ============================== THE UNIVERSE: every device (2026-10-04) ==============================
     /api/universe (docs/contracts.md) is the one registry of every device. How each body is drawn:
       guest_vm / guest_lxc  -> a star in its host galaxy's arms (the existing guest pools; category colour = legend)
       pve_host              -> that galaxy's core          gateway -> the network hub planet (fab.gateway)
       switch / ap (first)   -> the fabric hubs (the wall's gateway / switch / AP hub models), on their layout slots in the core ring
       edge "wan"            -> the WAN sun                 edge Cloudflare -> THE EDGE galaxy
       everything else       -> a real 3D class model (bodies3d.js, one instanced draw per class; the atlas Points pool
                                only under nxflags no3d) - a site's own anchor device (the SD-WAN NVR) is that site's hub model:
         sys:core (kind network)  : the inner ring round the gateway (network devices, extra switches/APs)
         sys:home (kind clients)  : the outer rings round the same hub, one ring per class (shell) - the home
                                    network reads as its own solar system with the gateway as its star
         any other system (sites, a new host) : a small satellite system out beyond the fabric, own hub glow,
                                    one tunnel line back to the gateway
         system-less edge bodies  : a ring round the sun
     Position = f(system, shell, slot, seed) through UNIVERSE_LAYOUT.place() and NOTHING else: no sort, no
     re-layout; a body keeps its pool slot for the session, a new one is appended. Inside a galaxy the layout's
     even disc is folded onto the two dust arms by armFold() - a pure function of the body's layout angle, so it
     can never move a body between polls. Radii are mapped into each frame's world band against the system's
     outermost shell radius, eased, so growth widens a system smoothly instead of jumping.
     Without /api/universe (404, error, or no UNIVERSE_LAYOUT) every path below is inert and the page draws
     exactly what it drew before (guest arms by name, topology moons). */
  var UL = window.UNIVERSE_LAYOUT || null;
  var UNI_POLL_MS = 12000, DEV_N = 1024, LINK_N = 2400;
  var CLASS_LIST = ['pve_host', 'guest_vm', 'guest_lxc', 'gateway', 'switch', 'ap', 'server', 'storage', 'computer', 'phone', 'tablet', 'tv_av',
                    'iot', 'appliance', 'camera', 'printer', 'game_console', 'network_device', 'edge', 'unknown'];
  var CELL_GLOW = 20, CELL_RING = 21;
  // fallback per-class look (used per field when the Blender manifest has no entry): relative size, emissive, spin rad/s
  var CLASS_DEF = {
    pve_host: [1.6, 0.8, 0.05], guest_vm: [0.7, 0.5, 0.1], guest_lxc: [0.6, 0.5, 0.1], gateway: [1.3, 0.7, 0.05], 'switch': [1.15, 0.6, 0.05],
    ap: [1.1, 0.6, 0.1], server: [1.1, 0.5, 0.06], storage: [1.1, 0.5, 0.05], computer: [0.9, 0.45, 0.12], phone: [0.65, 0.45, 0.2],
    tablet: [0.75, 0.45, 0.18], tv_av: [0.85, 0.5, 0.1], iot: [0.6, 0.55, 0.25], appliance: [0.75, 0.4, 0.12], camera: [0.75, 0.55, 0.15],
    printer: [0.75, 0.4, 0.1], game_console: [0.85, 0.5, 0.15], network_device: [0.95, 0.55, 0.08], edge: [1.3, 0.7, 0.05], unknown: [0.55, 0.3, 0.12]
  };
  var UNI = { on: false, doc: null, ts: 0, polls: 0, fails: 0, recs: {}, n: 0, free: [], pool: [], frames: {}, frameList: [], byTopo: {}, guestBody: {},
              counts: null, man: null, cls: {}, planet: { gateway: null, 'switch': null, ap: null }, siteN: 0, applied: 0, lastErr: '', fade: 0 };

  /* ---- one shader for both atlas pools (bodies + flares): per-vertex atlas cell, rotation, alpha ---- */
  function atlasMat(tex, cols, rows, cap, tintMix) {
    return new THREE.ShaderMaterial({
      uniforms: { map: { value: tex }, uCols: { value: cols }, uRows: { value: rows }, uPR: U_PR, uCapK: U_CAPK, uCap: { value: cap },
                  uTint: { value: tintMix }, uPremul: { value: 0 }, uAlpha: { value: 1 },
                  map2: { value: tex }, uGrid2: { value: new THREE.Vector2(cols, rows) }, map3: { value: tex }, uGrid3: { value: new THREE.Vector2(cols, rows) },
                  map4: { value: tex }, uGrid4: { value: new THREE.Vector2(cols, rows) } },
      vertexShader: [
        'attribute float size; attribute float cell; attribute float alpha; attribute float spin; attribute float sheet; attribute float dsat;',
        'uniform float uPR, uCap, uCapK; varying vec3 vC; varying float vA; varying float vCell; varying vec2 vRot; varying float vSheet; varying float vDs;',
        'void main(){ vC = color; vCell = cell; vSheet = sheet; vDs = dsat; vRot = vec2(cos(spin), sin(spin)); vec4 mv = modelViewMatrix * vec4(position, 1.0);',
        // a body smaller than ~2 device px shimmers on/off as it moves; hold it at 2 px and fade it instead
        '  float px = size * uPR * (900.0 / -mv.z); vA = alpha * clamp(px / (2.0 * uPR), 0.2, 1.0);',
        '  gl_PointSize = clamp(px, 2.0 * uPR, max(2.0 * uPR, uCap * uCapK)); gl_Position = projectionMatrix * mv; }'
      ].join('\n'),
      fragmentShader: [
        'uniform sampler2D map; uniform sampler2D map2; uniform sampler2D map3; uniform sampler2D map4; uniform vec2 uGrid2; uniform vec2 uGrid3; uniform vec2 uGrid4;',
        'uniform float uCols, uRows, uTint, uPremul, uAlpha; varying vec3 vC; varying float vA; varying float vCell; varying vec2 vRot; varying float vSheet; varying float vDs;',
        'void main(){ vec2 pc = gl_PointCoord - 0.5; pc = vec2(vRot.x * pc.x - vRot.y * pc.y, vRot.y * pc.x + vRot.x * pc.y) + 0.5;',
        '  if (pc.x < 0.0 || pc.x > 1.0 || pc.y < 0.0 || pc.y > 1.0) discard;',
        '  vec2 g = vSheet > 2.5 ? uGrid4 : vSheet > 1.5 ? uGrid3 : vSheet > 0.5 ? uGrid2 : vec2(uCols, uRows);',
        '  float col = mod(vCell, g.x), row = floor(vCell / g.x);',
        '  vec2 uv = vec2((col + clamp(pc.x, 0.004, 0.996)) / g.x, 1.0 - (row + clamp(pc.y, 0.004, 0.996)) / g.y);',   // 0.4% inset: never bleed into the neighbour cell
        '  vec4 t = vSheet > 2.5 ? texture2D(map4, uv) : vSheet > 1.5 ? texture2D(map3, uv) : vSheet > 0.5 ? texture2D(map2, uv) : texture2D(map, uv);',
        '  vec3 rgb = uPremul > 0.5 ? t.rgb / max(t.a, 0.004) : t.rgb;',
        '  rgb *= mix(vec3(1.0), vC, uTint); rgb = mix(rgb, vec3(dot(rgb, vec3(0.2126, 0.7152, 0.0722))), vDs);',   // down bodies desaturate (precoloured cells too)
        '  gl_FragColor = vec4(rgb, t.a * vA * uAlpha); }'
      ].join('\n'),
      vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
    });
  }
  /* procedural fallback atlas (8x4 cells of 128 px, white so the class tint colours it): a glowing core plus a
     simple class glyph, so even before / without the Blender atlas a phone, a camera and a printer read differently */
  function fallbackAtlas() {
    var C = 128, cv = document.createElement('canvas'); cv.width = C * 8; cv.height = C * 4;
    var x = cv.getContext('2d');
    function cell(i, fn) {
      var cx = (i % 8) * C + C / 2, cy = Math.floor(i / 8) * C + C / 2;
      x.save(); x.translate(cx, cy);
      var g = x.createRadialGradient(0, 0, 0, 0, 0, C * 0.5);
      g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.12, 'rgba(255,255,255,.85)'); g.addColorStop(0.3, 'rgba(255,255,255,.22)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = g; x.beginPath(); x.arc(0, 0, C * 0.5, 0, TAU); x.fill();
      x.strokeStyle = 'rgba(255,255,255,.8)'; x.fillStyle = 'rgba(255,255,255,.8)'; x.lineWidth = 4; x.lineJoin = 'round';
      if (fn) fn(C);
      x.restore();
    }
    function ring(r) { x.beginPath(); x.arc(0, 0, r, 0, TAU); x.stroke(); }
    function rect(w, h) { x.beginPath(); x.rect(-w / 2, -h / 2, w, h); x.stroke(); }
    function poly(n, r, a0) { x.beginPath(); for (var k = 0; k <= n; k++) { var a = (a0 || 0) + k / n * TAU; x[k ? 'lineTo' : 'moveTo'](Math.cos(a) * r, Math.sin(a) * r); } x.stroke(); }
    var G = {
      pve_host: function (c) { ring(c * 0.3); },
      gateway: function (c) { ring(c * 0.32); for (var k = 0; k < 4; k++) { var a = k * TAU / 4; x.beginPath(); x.moveTo(Math.cos(a) * c * .32, Math.sin(a) * c * .32); x.lineTo(Math.cos(a) * c * .44, Math.sin(a) * c * .44); x.stroke(); } },
      'switch': function (c) { rect(c * 0.56, c * 0.3); },
      ap: function (c) { x.beginPath(); x.arc(0, c * .1, c * .25, -2.4, -0.74); x.stroke(); x.beginPath(); x.arc(0, c * .1, c * .38, -2.4, -0.74); x.stroke(); },
      server: function (c) { rect(c * 0.44, c * 0.5); x.beginPath(); x.moveTo(-c * .22, 0); x.lineTo(c * .22, 0); x.stroke(); },
      storage: function (c) { for (var k = -1; k <= 1; k++) { x.beginPath(); x.ellipse(0, k * c * .14, c * .26, c * .07, 0, 0, TAU); x.stroke(); } },
      computer: function (c) { poly(4, c * 0.32, 0); },
      phone: function (c) { rect(c * 0.22, c * 0.46); },
      tablet: function (c) { rect(c * 0.34, c * 0.46); },
      tv_av: function (c) { rect(c * 0.62, c * 0.36); },
      iot: function (c) { for (var k = 0; k < 3; k++) { var a = k * TAU / 3 - 1.57; x.beginPath(); x.arc(Math.cos(a) * c * .32, Math.sin(a) * c * .32, c * .05, 0, TAU); x.fill(); } },
      appliance: function (c) { poly(6, c * 0.3, 0); },
      camera: function (c) { ring(c * 0.2); x.setLineDash([c * .08, c * .06]); ring(c * 0.36); x.setLineDash([]); },
      printer: function (c) { rect(c * 0.5, c * 0.28); x.beginPath(); x.moveTo(-c * .14, -c * .14); x.lineTo(-c * .14, -c * .28); x.lineTo(c * .14, -c * .28); x.lineTo(c * .14, -c * .14); x.stroke(); },
      game_console: function (c) { poly(3, c * 0.32, -1.5708); },
      network_device: function (c) { for (var k = 0; k < 6; k++) { var a = k * TAU / 6; x.beginPath(); x.moveTo(Math.cos(a) * c * .16, Math.sin(a) * c * .16); x.lineTo(Math.cos(a) * c * .38, Math.sin(a) * c * .38); x.stroke(); } },
      edge: function (c) { ring(c * 0.4); },
      unknown: null, guest_vm: null, guest_lxc: null
    };
    CLASS_LIST.forEach(function (k, i) { cell(i, G[k]); });
    // 20: a big soft glow (system hubs), 21: a thin ring (fallback birth flare)
    (function () { var cx = (CELL_GLOW % 8) * C + C / 2, cy = Math.floor(CELL_GLOW / 8) * C + C / 2, g = x.createRadialGradient(cx, cy, 0, cx, cy, C / 2);
      g.addColorStop(0, 'rgba(255,255,255,.9)'); g.addColorStop(0.2, 'rgba(255,255,255,.35)'); g.addColorStop(0.55, 'rgba(255,255,255,.08)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = g; x.fillRect(cx - C / 2, cy - C / 2, C, C); })();
    (function () { var cx = (CELL_RING % 8) * C + C / 2, cy = Math.floor(CELL_RING / 8) * C + C / 2, g = x.createRadialGradient(cx, cy, 0, cx, cy, C / 2);
      g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.72, 'rgba(255,255,255,0)'); g.addColorStop(0.86, 'rgba(255,255,255,1)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = g; x.fillRect(cx - C / 2, cy - C / 2, C, C); })();
    var t = new THREE.CanvasTexture(cv); t.anisotropy = MAX_ANISO; return t;
  }
  var ATLAS_FB = fallbackAtlas();

  /* ---- device pool: ONE Points draw for every non-guest body, whatever the count ---- */
  var dpos = new Float32Array(DEV_N * 3), dcol = new Float32Array(DEV_N * 3), dsz = new Float32Array(DEV_N), dcell = new Float32Array(DEV_N), dal = new Float32Array(DEV_N), dspin = new Float32Array(DEV_N);
  var dgeo = new THREE.BufferGeometry();
  dgeo.setAttribute('position', new THREE.BufferAttribute(dpos, 3)); dgeo.setAttribute('color', new THREE.BufferAttribute(dcol, 3));
  dgeo.setAttribute('size', new THREE.BufferAttribute(dsz, 1)); dgeo.setAttribute('cell', new THREE.BufferAttribute(dcell, 1));
  dgeo.setAttribute('alpha', new THREE.BufferAttribute(dal, 1)); dgeo.setAttribute('spin', new THREE.BufferAttribute(dspin, 1));
  var dds = new Float32Array(DEV_N), dsh = new Float32Array(DEV_N); dgeo.setAttribute('dsat', new THREE.BufferAttribute(dds, 1)); dgeo.setAttribute('sheet', new THREE.BufferAttribute(dsh, 1));
  /* turntables (Blender round two, optional manifest.classes.<cls>.turntable): classes that spin AND whose turntable matches
     the still play their 24-frame sheet instead of rotating the sprite (the light is baked, rotating it swung the sun).
     Each sheet file takes one of the bodies material's spare samplers (map2..map4, slots 1..3); TT[cls] is set when it decodes. */
  var TT = {};
  ['position', 'color', 'size', 'alpha', 'spin', 'dsat', 'cell', 'sheet'].forEach(function (k) { dgeo.attributes[k].setUsage(THREE.DynamicDrawUsage); });
  dgeo.setDrawRange(0, 0);
  var devMat = atlasMat(ATLAS_FB, 8, 4, 90, 1);
  var devPts = new THREE.Points(dgeo, devMat); devPts.frustumCulled = false; scene.add(devPts);
  /* ---- flares: birth / relight / down, FX_N pooled, one Points draw (Blender flipbook when the manifest has one) ---- */
  /* overlay pool, ONE draw: slots 0..FX_N-1 are event flares (birth / relight on the birth sheet, down on the death
     sheet), slots FX_N.. are the looping pulse overlays of classes whose manifest anim is "pulse" (frame from the body's
     latency-driven pulse phase, so the flipbook period IS MOTION.pulseT(rtt)). Sheets: 0 = atlas (ring), 1 = birth, 2 = death, 3 = pulse. */
  var FX_N = 24, PUL_N = 40, FXT = FX_N + PUL_N, fpos = new Float32Array(FXT * 3), fcol = new Float32Array(FXT * 3), fsz = new Float32Array(FXT), fcell = new Float32Array(FXT), fal = new Float32Array(FXT), fspin = new Float32Array(FXT), fsheet = new Float32Array(FXT);
  var fgeo = new THREE.BufferGeometry();
  fgeo.setAttribute('position', new THREE.BufferAttribute(fpos, 3)); fgeo.setAttribute('color', new THREE.BufferAttribute(fcol, 3));
  fgeo.setAttribute('size', new THREE.BufferAttribute(fsz, 1)); fgeo.setAttribute('cell', new THREE.BufferAttribute(fcell, 1));
  fgeo.setAttribute('alpha', new THREE.BufferAttribute(fal, 1)); fgeo.setAttribute('spin', new THREE.BufferAttribute(fspin, 1));
  fgeo.setAttribute('sheet', new THREE.BufferAttribute(fsheet, 1)); fgeo.setAttribute('dsat', new THREE.BufferAttribute(new Float32Array(FXT), 1));
  var fxMat = atlasMat(ATLAS_FB, 8, 4, HDR ? 140 : 260, 1);
  var fxPts = new THREE.Points(fgeo, fxMat); fxPts.frustumCulled = false; scene.add(fxPts);
  var FLIP = { on: false, frames: 1, fps: 12, scale: 3, death: null, pulse: null };
  var fx = []; for (var fxi = 0; fxi < FX_N; fxi++) fx.push({ t: 9, dur: 1, rec: null, frame: null, local: new THREE.Vector3(), kind: '', r: 1, g: 1, b: 1, s0: 20, s1: 120 });
  fgeo.setDrawRange(0, 0);
  var PULSE = [];   // records whose class anim is "pulse" (<= PUL_N, first come first served, stable for the session)
  /* ---- attachment lines: one LineSegments draw (child -> parent, satellite hub -> gateway, gateway -> switch/AP) ---- */
  var lpos = new Float32Array(LINK_N * 6), lcol = new Float32Array(LINK_N * 6);
  var lgeo = new THREE.BufferGeometry();
  lgeo.setAttribute('position', new THREE.BufferAttribute(lpos, 3)); lgeo.setAttribute('color', new THREE.BufferAttribute(lcol, 3));
  lgeo.attributes.position.setUsage(THREE.DynamicDrawUsage); lgeo.attributes.color.setUsage(THREE.DynamicDrawUsage);
  lgeo.setDrawRange(0, 0);
  var links = new THREE.LineSegments(lgeo, hudLineMat(0xffffff, 1, true));
  links.frustumCulled = false; scene.add(links);

  /* ---- frames: where each system lives in the scene ---- */
  // the network system: tilted toward the usual camera, spinning rigidly (NET_SPIN) about its own axis
  var NET = new THREE.Object3D(); NET.position.copy(NET_C); NET.rotation.set(0.36, 0, -0.1); scene.add(NET);
  var NET_SPIN = new THREE.Object3D(); NET.add(NET_SPIN);
  var EDGE_RING = new THREE.Object3D(); EDGE_RING.position.copy(SUN); EDGE_RING.rotation.set(0.5, 0, 0.2); scene.add(EDGE_RING);
  // epoch-derived start angle: two screens (and a reload) start the rigid rotation in the same place
  function epochAngle(w) { return ((Date.now() / 1000) * w) % TAU; }
  var SYS_ANG = epochAngle(MOTION.SYS_W);
  function bandFor(kind) { return kind === 'network' ? [26, 46] : kind === 'clients' ? [62, 118] : null; }
  // satellite systems (sites, an unknown host): an arc beside and beyond the fabric, k = append order by system.slot
  // satellite systems: a row on the GPU side mirroring the network system (k = append order by system.slot), each new
  // one a step further out and back, so growth extends the row instead of moving existing systems
  function sitePos(k) {
    // k = append order by system.slot: 0 under the left galaxy, 1 under the right one, then further pairs outward and back
    var j = k >> 1, side = k % 2 ? 1 : -1;
    return new THREE.Vector3(side * (430 + 120 * j), -300 - 30 * j, 230 - 160 * j);
  }

  function mkFrame(s, kind) {
    var F = { id: s.id, kind: kind, sys: s, gal: null, obj: null, spin: null, rIn: 0, rOut: 0, Lmax: 0, LmaxT: 0, geom: {}, hub: null, accent: new THREE.Color(s.accent || '#9aa4b2'), k: -1, center: new THREE.Vector3() };
    if (kind === 'galaxy') { F.gal = galaxies[s._node]; F.rIn = 34; F.rOut = 250; F.obj = F.gal.G; F.spin = F.gal.G; }
    else if (kind === 'network' || kind === 'clients') { var bd = bandFor(kind); F.rIn = bd[0]; F.rOut = bd[1]; F.obj = NET; F.spin = NET_SPIN; }
    else if (kind === 'edge') { F.rIn = 160; F.rOut = 200; F.obj = EDGE_RING; F.spin = EDGE_RING; }
    else {
      F.k = UNI.siteN++; var o = new THREE.Object3D(); o.position.copy(sitePos(F.k)); o.rotation.set(0.45, 0, 0.1 * (F.k % 2 ? 1 : -1)); scene.add(o);
      var sp = new THREE.Object3D(); o.add(sp); F.obj = o; F.spin = sp; F.rIn = 16; F.rOut = 60;
    }
    F.obj.getWorldPosition(F.center);
    return F;
  }
  function frameKind(s) {
    var node = String(s.topo || s.anchor || '').replace(/^pve:/, '') || String(s.id || '').replace(/^sys:/, ''), lbl = String(s.label || '').toLowerCase();
    if (s.kind === 'pvehost' && !galaxies[node] && galaxies[String(s.id || '').replace(/^sys:/, '')]) node = String(s.id).replace(/^sys:/, '');
    if (s.kind === 'pvehost') { var nid = galaxies[node] && NODES.some(function (n) { return n.id === node; }) ? node : (galaxies[lbl] && NODES.some(function (n) { return n.id === lbl; }) ? lbl : null); if (nid) { s._node = nid; return 'galaxy'; } return 'site'; }
    if (s.kind === 'network' && !UNI.netCore) return 'network';
    if (s.kind === 'clients' && !UNI.netClients) return 'clients';
    return 'site';
  }
  // layout radius -> world radius inside a frame's band, against the system's eased outermost shell radius
  function mapR(F, r) { var span = Math.max(0.5, F.Lmax - 1.2); return F.rIn + (r - 1.2) / span * (F.rOut - F.rIn); }
  function bandK(F) { return (F.rOut - F.rIn) / Math.max(0.5, F.Lmax - 1.2); }
  // galaxies: fold the layout's even disc onto the two dust arms (arms at 0 and PI in the untwisted frame, the
  // same log twist the dust uses). Depends only on theta, which never changes for a body, so it can't move one.
  function armFold(theta) { var k = Math.round(theta / Math.PI), d = theta - k * Math.PI; return k * Math.PI + d * 0.38; }
  function guestLocal(F, rec, out) {
    var p = rec.p, wr = mapR(F, Math.max(p.r, 1.2)), a = armFold(p.theta) + wr * 0.0165;
    out[0] = Math.cos(a) * wr; out[1] = p.y * bandK(F) * 2.5 + ((rec.b.seed >>> 3) % 1000 / 1000 - 0.5) * 10; out[2] = Math.sin(a) * wr;
    return out;
  }
  function guestUniPos(gal, g) {
    if (!UNI.on) return null;
    var rec = UNI.guestBody[g.node + ':' + g.id]; if (!rec) return null;
    var F = UNI.frames[rec.b.system]; if (!F || F.gal !== gal) return null;
    g._uid = rec.b.id; rec.guest = g;
    return guestLocal(F, rec, [0, 0, 0]);
  }
  function clsInfo(c) {
    var m = UNI.man && UNI.man.classes && (UNI.man.classes[c] || UNI.man.classes.unknown), d = CLASS_DEF[c] || CLASS_DEF.unknown;
    var cell = m && m.atlas != null ? +m.atlas : CLASS_LIST.indexOf(c); if (cell < 0) cell = CLASS_LIST.indexOf('unknown');
    return { cell: cell, size: m && m.size != null ? +m.size * 1.6 : d[0], emissive: m && m.emissive != null ? +m.emissive : d[1], spin: m && m.spin != null ? +m.spin : d[2], man: m || null };
  }
  function devRole(b, F) {
    var c = b['class'];
    if (c === 'guest_vm' || c === 'guest_lxc') return F && F.kind === 'galaxy' ? 'guest' : 'dev';
    if (c === 'pve_host') return F && F.kind === 'galaxy' ? 'core' : 'dev';
    if (c === 'edge') { if (b.topo === 'wan') return 'sun'; if (/cloudflare/i.test(b.id + ' ' + b.label)) return 'edgegal'; return 'dev'; }
    if (F && F.kind === 'network' && (c === 'gateway' || c === 'switch' || c === 'ap')) {
      var held = UNI.planet[c]; if (!held || held === b.id || !UNI.recs[held]) { UNI.planet[c] = b.id; return 'planet'; }
    }
    return 'dev';
  }
  /* geometry from QUANTIZED caps (shared with the wall): radii only change when a shell crosses a
     size step, so a new device rarely nudges anything. UNIVERSE_LAYOUT.quantizeCaps when it ships, else the agreed
     formula q(c) = 8 * ceil((c + max(3, ceil(c/4))) / 8) - both screens must compute the same geometry. */
  function quantCaps(caps) {
    if (UL && typeof UL.quantizeCaps === 'function') return UL.quantizeCaps(caps);
    var out = {}; Object.keys(caps || {}).forEach(function (k) { var c = +caps[k] || 0; out[k] = c > 0 ? 8 * Math.ceil((c + Math.max(3, Math.ceil(c / 4))) / 8) : 0; });
    return out;
  }
  function uniGeom(caps) { return UL.geometry(quantCaps(caps)); }

  /* ============================== HOME NETWORK STAR SYSTEM (2026-10-07, clarity pass) ==============================
     It used to be a mini spiral disc with nine thin class
     shells, every device on an epicycle and a starburst of 40 lines into the gateway. It is now a star system that reads
     "home network: gateway -> switches -> devices" from across the room, in the network system's own spinning frame:
       centre      the gateway star (fab.gateway hub model) on a soft glow
       hub orbit   every first-tier switch / AP star (parent = the gateway) on R_HUB, evenly spaced by seat k = append
                   order (system.slot, shell, slot), wired to the gateway with thin quiet lines; a switch whose parent is
                   another switch (bench switches off the core switch) is a second-tier star one TIER further out,
                   spread around its parent's bearing and wired to it. Seats re-space (eased) only on an even-count step.
       planets     the devices whose parent is a switch flagged hub:true orbit that switch star on up to two faint orbits
                   (KID_R, slowly turning); a very large switch overflows into a wedge beyond the device ring
       device ring two staggered rows (R_DEV) of class sectors - one sector per layout shell (= device class group,
                   UNIVERSE_LAYOUT.SHELL_OF_CLASS) per system, sector order fixed (SHELL_ORDER), a member's seat is
                   its rank by slot (append-only), sector widths step in 4-seat quanta with headroom and ease, so a new
                   device takes the next free seat of its sector and nothing reorders. A group label names each sector.
     No disc art, no per-shell rings (two or three faint circles instead), no epicycles on the ring: the system's slow
     rigid spin is enough life. Positions are a pure function of (class shell, system slot, slot order, parent / hub
     flags): no sorting by name, traffic or status, ever. */
  var NETD = { R_HUB: 62, TIER: 44, SPREAD: 0.62, KID_R: [15, 23], KID_W: 0.03, R_DEV: [138, 151], R_LBL: 170, FAN: [], FAN_OUT: 184, A0H: 0.35, A0R: -0.2, GAP: 1.4,
               hubs: [], nSeat: 6, secs: [], secState: {}, colW: 0.1, colWT: 0.1, ver: 0, hubMesh: {} };
  var SHELL_ORDER = [1, 2, 5, 6, 7, 8, 9, 10, 11, 12, 3, 4, 0];
  var SHELL_NAME = { 0: 'Core', 1: 'Network', 2: 'Servers', 3: 'Containers', 4: 'VMs', 5: 'Computers', 6: 'Phones', 7: 'TV & AV', 8: 'Smart home',
                     9: 'Appliances', 10: 'Printers', 11: 'Cameras', 12: 'Unknown' };
  function isNetF(F) { return !!F && (F.kind === 'network' || F.kind === 'clients'); }
  function ordKey(R) { return ((R.F && R.F.sys && R.F.sys.slot) || 0) * 1e8 + (R.b.shell | 0) * 1e5 + (R.b.slot | 0); }
  function recOf(id) { return id ? (UNI.recs[id] || UNI.recs[UNI.byTopo[id]]) : null; }
  function byOrd(a, b) { return ordKey(a) - ordKey(b); }
  function netLayout() {
    var hubs = [], ring = [];
    Object.keys(UNI.recs).forEach(function (id) {
      var R = UNI.recs[id]; R.net = null; R.netHub = false;
      if (!isNetF(R.F)) return;
      var c = R.b['class'];
      if (R.role === 'planet' && c === 'gateway') { R.net = { kind: 'gw' }; return; }
      if (c === 'switch' || c === 'ap') { hubs.push(R); return; }
      ring.push(R);
    });
    hubs.sort(byOrd);
    /* the switch TREE (registry: bench switches can hang off the core switch): a hub whose parent is another
       hub is a second-tier star, placed just outside its parent on a wider orbit and spread around its bearing;
       first-tier hubs (on the gateway) share the inner orbit evenly by seat */
    var isHub = {}; hubs.forEach(function (H) { isHub[H.b.id] = H; });
    function parentHub(H) { var P = recOf(H.b.parent); return P && isHub[P.b.id] && P !== H ? P : null; }
    var tier1 = [], sib = {};
    hubs.forEach(function (H) {
      var P = parentHub(H), t = 1, Q = P, guard = 0;          // tier = depth below the gateway (cycle-guarded)
      while (Q && guard++ < 6) { t++; Q = parentHub(Q); }
      H.net = { kind: 'hub', tier: t, parent: P, kids: [], k: 0, m: 0, M: 1 }; H.netHub = !!B3 && H.role === 'dev';
      if (!P) tier1.push(H); else (sib[P.b.id] = sib[P.b.id] || []).push(H);
    });
    tier1.forEach(function (H, k) { H.net.k = k; });
    Object.keys(sib).forEach(function (pid) { var L = sib[pid]; L.forEach(function (H, m) { H.net.m = m; H.net.M = L.length; H.net.k = isHub[pid].net.k; }); });
    NETD.hubs = hubs; NETD.nSeatT = Math.max(6, 2 * Math.ceil(tier1.length / 2)); if (!NETD.ver) NETD.nSeat = NETD.nSeatT;
    // fans: children of a hub:true switch
    var rest = [];
    ring.forEach(function (R) {
      var P = recOf(R.b.parent);
      if (P && P.net && P.net.kind === 'hub' && P.b.hub === true) P.net.kids.push(R); else rest.push(R);
    });
    hubs.forEach(function (H) { H.net.kids.sort(byOrd); H.net.kids.forEach(function (R, j) { R.net = { kind: 'fan', hub: H, j: j }; }); });
    // sectors: shell x system, fixed order
    var bySec = {};
    rest.forEach(function (R) { var key = (R.b.shell | 0) + '@' + (R.F.sys.id || ''); (bySec[key] = bySec[key] || []).push(R); });
    var keys = Object.keys(bySec).sort(function (a, b) {
      var A = bySec[a][0], B = bySec[b][0], ia = SHELL_ORDER.indexOf(A.b.shell | 0), ib = SHELL_ORDER.indexOf(B.b.shell | 0);
      if (ia < 0) ia = 99; if (ib < 0) ib = 99;
      return (ia - ib) || (((A.F.sys.slot || 0) - (B.F.sys.slot || 0)));
    });
    var col = 0, secs = [];
    keys.forEach(function (key) {
      // seats step in 4s with headroom (cf. UNIVERSE_LAYOUT.quantizeCaps), so a new device almost always lands in a free seat
      var mem = bySec[key].sort(byOrd), seats = 4 * Math.ceil((mem.length + Math.max(2, Math.ceil(mem.length / 4))) / 4);
      var st = NETD.secState[key] || (NETD.secState[key] = { c0: col, c0T: col, born: true });
      st.c0T = col; if (st.born) { st.c0 = col; st.born = false; }
      var sh = mem[0].b.shell | 0, S = { key: key, shell: sh, name: SHELL_NAME[sh] || 'DEVICES', mem: mem, st: st, n: mem.length };
      mem.forEach(function (R, j) { R.net = { kind: 'ring', sec: S, j: j }; });
      secs.push(S); col += seats / 2 + NETD.GAP;
    });
    NETD.secs = secs;
    NETD.colWT = Math.min(0.2, TAU / Math.max(1, col));
    if (!NETD.ver) NETD.colW = NETD.colWT;
    NETD.ver++;
  }
  function netEase(dt) {
    var k = 1 - Math.exp(-dt / 3);
    NETD.colW += (NETD.colWT - NETD.colW) * k;
    if (NETD.nSeatT) NETD.nSeat += (NETD.nSeatT - NETD.nSeat) * k;          // a new hub step re-spaces the hubs smoothly
    for (var i = 0; i < NETD.secs.length; i++) { var st = NETD.secs[i].st; st.c0 += (st.c0T - st.c0) * k; }
  }
  function hubAngle(k, settled) { return NETD.A0H + k * TAU / (settled && NETD.nSeatT ? NETD.nSeatT : NETD.nSeat); }
  // a hub's bearing + orbit radius in the network frame (tier 1: its seat; tier n: spread around its parent's bearing)
  function hubPolar(H, out, settled) {
    var N = H.net;
    if (!N.parent) { out[0] = hubAngle(N.k, settled); out[1] = NETD.R_HUB; return out; }
    hubPolar(N.parent, out, settled);
    out[0] += (N.m - (N.M - 1) / 2) * NETD.SPREAD * (NETD.R_HUB + NETD.TIER) / (out[1] + NETD.TIER);
    out[1] += NETD.TIER; return out;
  }
  var _hp = [0, 0];
  // a body's position in the network system's spinning frame (NET_SPIN local); settled = the eased targets
  function netLocal(R, out, settled) {
    var N = R.net, a, r, colW = settled ? NETD.colWT : NETD.colW;
    if (!N || N.kind === 'gw') { out.set(0, 0, 0); return out; }
    if (N.kind === 'hub') { hubPolar(R, _hp, settled); out.set(Math.cos(_hp[0]) * _hp[1], 0, Math.sin(_hp[0]) * _hp[1]); return out; }
    if (N.kind === 'fan') {
      /* planets of a switch star: up to two orbits around it (seat j by slot order), turning slowly together;
         a very large switch (a 48-port one) overflows into rows beyond the device ring, in its own wedge */
      hubPolar(N.hub, _hp, settled); var aH = _hp[0], hx = Math.cos(aH) * _hp[1], hz = Math.sin(aH) * _hp[1], jj = N.j;
      for (var o = 0; o < NETD.KID_R.length; o++) {
        var ro = NETD.KID_R[o], co = Math.floor(TAU * ro / 9.5);
        if (jj < co) { var ao = (jj + 0.5 * o) / co * TAU + SIM_T * NETD.KID_W * (o ? 0.7 : 1) + aH; out.set(hx + Math.cos(ao) * ro, 0, hz + Math.sin(ao) * ro); return out; }
        jj -= co;
      }
      var w = TAU / NETD.nSeat * 0.78, j = jj;
      for (var row = NETD.FAN.length; row < 40; row++) {
        r = row < NETD.FAN.length ? NETD.FAN[row] : NETD.FAN_OUT + (row - NETD.FAN.length) * 10;
        var cap = Math.max(2, Math.floor(r * w / 10));
        if (j < cap) { a = aH + (j - (cap - 1) / 2) * (w / cap); break; }
        j -= cap;
      }
      out.set(Math.cos(a) * r, 0, Math.sin(a) * r); return out;
    }
    var st = N.sec.st, c0 = settled ? st.c0T : st.c0, row2 = N.j % 2, cc = c0 + Math.floor(N.j / 2) + row2 * 0.5;
    a = NETD.A0R + cc * colW; r = NETD.R_DEV[row2];
    out.set(Math.cos(a) * r, 0, Math.sin(a) * r); return out;
  }
  // sector label anchor (NET_SPIN local): the middle of the sector's occupied columns, just outside the ring
  function secLabelLocal(S, out) {
    var cols = Math.ceil(S.n / 2), cc = S.st.c0 + (cols - 1) / 2 + (S.n > 1 ? 0.25 : 0), a = NETD.A0R + cc * NETD.colW;
    out.set(Math.cos(a) * NETD.R_LBL, 0, Math.sin(a) * NETD.R_LBL); return out;
  }
  // extra switch / AP hubs (beyond the first of each, which are the fabric planets): their own hub model, like the planets
  function netHubSync() {
    if (!B3) return;
    var keep = {};
    NETD.hubs.forEach(function (H) {
      if (!H.netHub) return;
      var id = H.b.id, cls = H.b['class'] === 'ap' ? 'ap' : 'switch'; keep[id] = 1;
      if (!NETD.hubMesh[id]) { var m = B3.hubMesh(cls, { tint: hubTintRGB(cls), tintMix: 0.85 }); m.scale.setScalar(HUB3R[cls] * 0.9); scene.add(m); NETD.hubMesh[id] = m; hubStarize(m, cls, H.wp, HUB3R[cls] * 0.81); }
    });
    Object.keys(NETD.hubMesh).forEach(function (id) { if (!keep[id]) { var m = NETD.hubMesh[id]; dropGlare(m); scene.remove(m); m.material.dispose(); delete NETD.hubMesh[id]; } });
  }
  /* QA (harness only): ?nx_synth_sw=N adds N synthetic hub switches (hub:true, parent = the gateway) to the home system
     and re-parents every third home device onto them, to judge the diagram before the registry data lands */
  var QS = {}; (location.search || '').replace(/^\?/, '').split('&').forEach(function (kv) { if (kv) { var p = kv.split('='); QS[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || '1'); } });
  function synthSwitches(doc, n) {
    doc = JSON.parse(JSON.stringify(doc));
    var gw = doc.bodies.filter(function (b) { return b['class'] === 'gateway'; })[0];
    var home = doc.systems.filter(function (s) { return s.kind === 'clients'; })[0]; if (!home) return doc;
    var NAMES = [['Switch A', '192.0.2.50', 'up'], ['Switch B', '192.0.2.53', 'up'], ['Switch C 48', '192.0.2.55', 'up'], ['Switch D', '192.0.2.101', 'down'],
                 ['Switch E', '192.0.2.60', 'up'], ['Switch F', '192.0.2.61', 'up']];
    var kids = doc.bodies.filter(function (b) { return b.system === home.id && b['class'] !== 'switch'; });
    for (var i = 0; i < n; i++) {
      var id = 'inferred:switch:qa:' + i, nm = NAMES[i % NAMES.length];
      doc.bodies.push({ id: id, label: nm[0], 'class': 'switch', cat: 'network', system: home.id, parent: gw ? gw.id : null, shell: 1, slot: i, seed: UL.hash32(id),
                        status: nm[2], first_seen: 0, last_seen: 0, 'new': false, hub: true, m: { ip: nm[1] }, src: ['qa'] });
    }
    kids.forEach(function (b, j) { if (j % 3 === 0) b.parent = 'inferred:switch:qa:' + ((j / 3 | 0) % n); });
    home.shells = home.shells || {}; home.shells['1'] = n; home.count = (home.count || 0) + n;
    return doc;
  }
  // the pulse-overlay list, in pool order (stable): devices whose manifest class anim is "pulse"
  function pulseRebuild() {
    PULSE.length = 0;
    if (B3) return;                 // the 3D bodies breathe their own emissive parts (bodies3d pulse): no sprite overlay
    for (var i = 0; i < UNI.n && PULSE.length < PUL_N; i++) { var P = UNI.pool[i]; if (P && !P.hub && P.ci && P.ci.man && P.ci.man.anim === 'pulse') PULSE.push(P); }
  }
  /* system discs from the manifest (home, ...): one additive plane per non-galaxy system, in the system's
     spinning frame, under its rings. Created once per system when both the manifest and the frame exist. The core
     ring shares the home system's centre, so it gets no disc of its own; the two host galaxies keep their baked discs. */
  var DISC_U = '/static/assets/universe/';
  function applyDiscs() {
    var man = UNI.man; if (!man || !man.discs || NXF.nodisc) return;
    UNI.frameList.forEach(function (id) {
      // the remote sites are star systems, like the home network (a hub star, its devices on faint orbits): no
      // spiral-disc art, which read as a reddish smudge under a site's accent
      var F = UNI.frames[id]; if (F.disc || F.kind === 'galaxy' || F.kind === 'edge' || F.kind === 'site' || isNetF(F)) return;
      var d = man.discs[id] || man.discs['default']; if (!d || !d.file) return;
      var mat = discGrade(new THREE.MeshBasicMaterial({ map: null, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide, color: armTint(F.accent.getHex()) }), F.accent.getHex());
      var m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat); m.rotation.x = -Math.PI / 2; m.renderOrder = -3; m.visible = false;
      F.disc = m; F.discSize = d.size || 1.4; F.spin.add(m);
      TEXL.load(DISC_U + d.file, function (t) { t.anisotropy = MAX_ANISO; mat.map = t; mat.needsUpdate = true; m.visible = true; });
    });
  }
  function poolTake() { return UNI.free.length ? UNI.free.pop() : (UNI.n < DEV_N ? UNI.n++ : -1); }
  function poolRelease(i) { if (i < 0) return; dsz[i] = 0; dal[i] = 0; UNI.pool[i] = null; UNI.free.push(i); }
  function fxFire(kind, rec, frame, local, rgb) {
    var best = fx[0]; for (var i = 1; i < FX_N; i++) if (fx[i].t / fx[i].dur > best.t / best.dur) best = fx[i];
    best.t = 0; best.kind = kind; best.rec = rec; best.frame = frame || null; if (local) best.local.copy(local);
    // Blender flipbooks (when loaded) play at their own fps for their own length at a fixed size (the sheet animates itself);
    // the procedural fallback is the atlas ring growing (birth / relight) or shrinking (down)
    // HDR (2026-10-08b): no flipbook rings - a birth / relight is a soft nova-like glow that blooms and fades (CELL_GLOW)
    var sh = HDR ? null : kind === 'down' ? FLIP.death : FLIP.on ? FLIP : null;
    best.sheet = sh ? (kind === 'down' ? 2 : 1) : 0; best.sh = sh;
    best.dur = sh ? sh.frames / sh.fps : kind === 'birth' ? MOTION.FLARE_S : kind === 'down' ? 1.6 : 1.4;
    var bsz = rec && rec.ci ? 19 * rec.ci.size : 10;
    if (sh) { best.s0 = best.s1 = Math.max(26, bsz * (sh.scale || 2) * (kind === 'relight' ? 0.8 : 1.2)); }
    else if (HDR) { best.s0 = kind === 'down' ? 46 : 14; best.s1 = kind === 'birth' ? 64 : kind === 'down' ? 6 : 44; }
    else { best.s0 = kind === 'down' ? 70 : 16; best.s1 = kind === 'birth' ? 150 : kind === 'down' ? 8 : 80; }
    best.r = rgb[0]; best.g = rgb[1]; best.b = rgb[2];
  }
  /* ---- bodies3d sync: the 3D list = every pool device in pool order (stable), minus a site's own anchor device,
     which is drawn as that system's hub model at its centre (the wall draws the same device as a hub). Membership
     changes -> setBodies (new keys are born, vanished keys shrink away); otherwise only the dynamics move, and status
     changes ease inside bodies3d. The values are the wall's (netscene_universe.js refreshDynamics) so a body has the
     same tint, brightness, spin and pulse on both screens. Spin runs on the shader clock = SIM_T (sum of clamped dts);
     a speed change re-bases the phase so the angle never jumps. */
  var SPIN3D = { phone: 0.15, tablet: 0.12, iot: 0.2, unknown: 0.12, camera: 0.05, network_device: 0.08, tv_av: 0.1,
                 game_console: 0.14, appliance: 0.12, guest_lxc: 0.1, guest_vm: 0.08, computer: 0.08, printer: 0.07, server: 0.06,
                 storage: 0.06, edge: 0.03 };
  var GUEST_HEX = { ai: '#ff4fa3', media: '#38e1ff', network: '#37f5a0', monitor: '#ffb347', web: '#9b8cff', infra: '#8fb0d0' };
  CATS.forEach(function (k) { if (C.palette && C.palette[k]) GUEST_HEX[k] = C.palette[k]; });
  var R3K = 6.0, B3L = [], B3SIG = '', B3MIN = 6;
  function b3Dyn(R, out) {
    var b = R.b, m = b.m || {}, cls = b['class'], down = b.status === 'down';
    var bps = (m.rx_bps != null || m.tx_bps != null) ? (+m.rx_bps || 0) + (+m.tx_bps || 0) : null;
    var u = bps == null ? -1 : (NBM ? NBM.actU(bps) : R.u);
    var cpuK = (m.cpu != null && b.status === 'up') ? 0.85 + 0.6 * Math.sqrt(clamp(+m.cpu, 0, 1)) : 1;
    var guest = cls === 'guest_lxc' || cls === 'guest_vm';
    var hue = UL.colourRGB({ 'class': cls, seed: b.seed, status: 'up' }, guest ? { tint: GUEST_HEX[b.cat] || GUEST_HEX.infra } : R.ci.man);
    var sw = down ? 0 : (NBM ? NBM.spinOmega(SPIN3D[cls] != null ? SPIN3D[cls] : 0.06, Math.max(0, u)) : 0.06) * ((b.seed & 1) ? 1 : -1);
    if (R.sw3 === undefined) { R.sw3 = sw; R.sph3 = ((b.seed >>> 3) % 6283) / 1000; }
    else if (sw !== R.sw3) { R.sph3 = (R.sph3 + (R.sw3 - sw) * SIM_T) % TAU; R.sw3 = sw; }
    out.tint = [hue[0], hue[1], hue[2]]; out.orbitW = 0; out.orbitPh = 0; out.spinW = sw; out.spinPh = R.sph3;
    out.bright = (NBM ? NBM.brightness(u, b.status) : (down ? 0.3 : 0.8)) * cpuK;
    out.desat = down ? 0.78 : (b.status === 'unknown' ? 0.35 : 0);
    out.pulse = down ? 0 : (NBM ? NBM.pulsePeriod(m.rtt_ms) : 0);
    out.radius = R3K * R.ci.size * (R.p ? R.p.scale : 1);
    // the home-network diagram: uniform, slightly smaller bodies (no per-seed size jitter), unidentified ones quieter
    if (isNetF(R.F)) { var unk = cls === 'unknown'; out.radius = R3K * R.ci.size * (unk ? 0.62 : 0.78); if (unk) out.bright *= 0.7; }
    // photo look: planets at a plausible size next to their stars (the wall's PHOTO_R), lit by their own star
    if (B3PHOTO) { var ci = B3.celInfo ? B3.celInfo(cls) : null; if (!(ci && ci.star)) out.radius *= 0.62; out.light = lightOf(R, out.light || [0, 0, 0, 0]); }
    return out;
  }
  /* the star that lights a body (photo look): world xyz + bodies3d colour code (2 gateway, 3 switch star, 4 red dwarf,
     1 host core, 7 warm white). Home / core devices: their switch star when they orbit one, else the gateway; a site's
     devices: the site star; the edge ring: the internet sun; a device inside a galaxy: its core. */
  function lightOf(R, out) {
    var N = R.net, F = R.F;
    if (N && N.kind === 'fan' && N.hub) { out[0] = N.hub.wp.x; out[1] = N.hub.wp.y; out[2] = N.hub.wp.z; out[3] = N.hub.b['class'] === 'ap' ? 4 : 3; return out; }
    if (isNetF(F)) { var g = fab.gateway.pos; out[0] = g.x; out[1] = g.y; out[2] = g.z; out[3] = 2; return out; }
    if (F && F.kind === 'site') { out[0] = F.center.x; out[1] = F.center.y; out[2] = F.center.z; out[3] = 3; return out; }
    if (F && F.kind === 'edge') { out[0] = SUN.x; out[1] = SUN.y; out[2] = SUN.z; out[3] = 7; return out; }
    if (F && F.kind === 'galaxy') { out[0] = F.gal.world.x; out[1] = F.gal.world.y; out[2] = F.gal.world.z; out[3] = 1; return out; }
    out[0] = out[1] = out[2] = out[3] = 0; return out;
  }
  var _lit = [0, 0, 0, 0];
  /* A/B only (nxflags g3d): the host-arm guests as guest_vm / guest_lxc models instead of stars. Rejected for the TV
     (see the report / NX3D note): at the overview a 3-6 px matcap model reads as a grey speck where a star's soft
     core reads as a light, and the category colour - the legend - survives far better as light than as a tinted
     surface. Kept behind the flag so the comparison can be re-run. */
  var G3D = !!(B3 && NXF.g3d), G3L = [];
  function g3Dyn(e, out) {
    var g = e.g, up = g.status === 'running', hex = GUEST_HEX[g.cat] || GUEST_HEX.infra, c = new THREE.Color(hex);
    var ram = Math.log2(1 + (g.maxmem || 0) / 1073741824);
    out.tint = [c.r, c.g, c.b]; out.orbitW = 0; out.orbitPh = 0; out.spinW = up ? 0.08 * ((hash(g.name) < 0.5) ? 1 : -1) : 0; out.spinPh = hash(g.name + '#') * TAU;
    out.bright = up ? 0.66 + 0.34 * clamp((g.cpu || 0) / 40, 0, 1) : 0.3; out.desat = up ? 0 : 0.78; out.pulse = 0;
    out.radius = (2.2 + 0.55 * ram) * (R3K / 6);
    return out;
  }
  function uni3dSync() {
    if (!B3) return;
    var list = [], keys = [];
    for (var i = 0; i < UNI.n; i++) { var P = UNI.pool[i]; if (P && !P.hub && !P.siteHub && !P.netHub) { list.push(P); keys.push(P.b.id); } }
    if (G3D) {
      G3L = [];
      NODES.forEach(function (n) { var gal = galaxies[n.id]; gal.list.forEach(function (g) { if (g._pos) { var e = { g3: true, g: g, gal: gal, key: 'g:' + n.id + ':' + g.id }; G3L.push(e); list.push(e); keys.push(e.key); } }); });
    }
    var sig = keys.join('|');
    if (sig !== B3SIG) {
      B3SIG = sig; B3L = list;
      var bl = list.map(function (R, k) {
        R.b3 = k;
        var it = R.g3 ? g3Dyn(R, { key: R.key, cls: R.g.type === 'qemu' ? 'guest_vm' : 'guest_lxc' }) : b3Dyn(R, { key: R.b.id, cls: CLASS_LIST.indexOf(R.b['class']) >= 0 ? R.b['class'] : 'unknown' });
        it.vis = 0; return it;
      });
      for (var j = 0; j < UNI.n; j++) { var Q = UNI.pool[j]; if (Q && (Q.siteHub || Q.netHub)) Q.b3 = -1; }
      B3.setBodies(bl);
    } else {
      var d = {}; B3L = list;
      for (var k = 0; k < list.length; k++) list[k].b3 = k;
      for (var k = 0; k < list.length; k++) B3.setDynamics(k, list[k].g3 ? g3Dyn(list[k], d) : b3Dyn(list[k], d));
    }
  }
  // a site whose anchor device is in the data wears that device as its hub model (the wall's SD-WAN NVR hub)
  function siteHubSync() {
    if (!B3) return;
    UNI.frameList.forEach(function (id) {
      var F = UNI.frames[id]; if (F.kind !== 'site') return;
      var R = null; for (var i = 0; i < UNI.n; i++) { var P = UNI.pool[i]; if (P && !P.hub && P.F === F && P.b.topo && P.b.topo === F.sys.anchor) { R = P; break; } }
      for (var j = 0; j < UNI.n; j++) { var Q = UNI.pool[j]; if (Q && !Q.hub && Q.F === F) Q.siteHub = Q === R; }
      var cls = R ? (CLASS_LIST.indexOf(R.b['class']) >= 0 ? R.b['class'] : 'unknown') : null;
      if (F.hub3 && (!R || F.hub3.userData.cls !== cls)) { dropGlare(F.hub3); scene.remove(F.hub3); F.hub3.material.dispose(); F.hub3 = null; }
      /* HDR: a site is a small real star system (docs/contracts.md) - its anchor device is drawn as the system's STAR (an orange
         K-type, whatever the device class), its members are the planets round it */
      if (R && !F.hub3) { F.hub3 = B3.hubMesh(HDR ? 'switch' : cls, { tint: hubTintRGB(HDR ? 'switch' : cls), tintMix: 0.85 }); F.hub3.userData.cls = cls; F.hub3.scale.setScalar(HDR ? 8 : 12); scene.add(F.hub3); hubStarize(F.hub3, 'site', F.center, 8 * 0.9); }
      F.hubRec = R;
    });
  }
  /* ---- GROWTH: every Proxmox node is a galaxy ----
     A pvehost system the page has no galaxy for (a third configured node, or one a cluster reports later) gets one: the next free seat of an
     append-only back row behind the estate (GAL_SEATS, then further rows alternating left / right), seat = its rank by
     system.slot among the extra nodes, so a new node never moves an existing one. Same builder as the original two
     (dust arms, core, halo, guest stars), one of the two baked discs re-tinted with the system's accent and rotated,
     drawn at 0.78 scale; no PointLight (see buildGalaxy). It joins NODES, so everything that walks NODES (the guest
     stars, the HUD card rotation, label obstacles, camera keep-outs, stop shots, the showcase, the overview fit) has it. */
  /* seats solved offline against the real overview fit (fitView, _ovDir, OV_SAFE, fov 42) so every galaxy's projected disc keeps >= 45 px from every other and
     >= 60 px from the sun, whatever the count (1..5 extra), greedily minimising how far the fitted overview has to pull
     back: the 3rd galaxy sits centre-back above the network core, the 4th and 5th flank it, 6 and 7 go a row further back. */
  var GAL_SEATS = [[0, 280, -1000], [-1100, 280, -1200], [1100, 280, -1200], [-800, 280, -2800], [800, 280, -2800]];
  function galSeat(k) {
    if (k < GAL_SEATS.length) return new THREE.Vector3().fromArray(GAL_SEATS[k]);
    var j = k - GAL_SEATS.length, row = 1 + (j >> 1), side = j % 2 ? 1 : -1;
    return new THREE.Vector3(side * (800 + 600 * row), 280, -2800 - 900 * row);
  }
  var GAL_EXTRA = 0;
  function nodeOf(s) { return String(s.topo || s.anchor || '').replace(/^pve:/, '') || String(s.id || '').replace(/^sys:/, ''); }
  function ensureGalaxies(syss) {
    // the extra nodes' seats come from their order by system.slot, computed over the WHOLE document (stable under append)
    var extra = syss.filter(function (s) { return s.kind === 'pvehost' && !NODES.some(function (n) { return n.id === nodeOf(s) && !n.dyn; }); });
    // slot order, stable for equal / missing slots (the document is normally already in slot order)
    extra = extra.map(function (s, i) { return [s, i]; }).sort(function (a, b) { var sa = a[0].slot != null ? +a[0].slot : 1e9 + a[1], sb = b[0].slot != null ? +b[0].slot : 1e9 + b[1]; return (sa - sb) || (a[1] - b[1]); }).map(function (x) { return x[0]; });
    extra.forEach(function (s, k) {
      var id = nodeOf(s); if (!id || galaxies[id] || s.count === 0) return;   // a removed node (count 0 after its hold) gets no galaxy; its seat stays reserved
      var nd = { id: id, label: String(s.label || id).toUpperCase(), name: String(s.label || id), accent: new THREE.Color(s.accent || '#9fb3cc').getHex(),
                 pos: galSeat(k), spin: k % 2 ? -1 : 1, disc: k % 2 ? 'galaxy_nb.png' : 'galaxy_gpu.png', discRot: 0.9 + k * 1.3, scale: 0.78 * GAL_K, noLight: true, dyn: true, N: 2200 };
      /* the shared pool: galaxy_pve_a / _b by the system's slot RANK among the extra nodes (k % 2), so two new nodes
         always get different plates (by seed % 2 two could match); a third
         reuses a plate but turned a further 2.1 rad so it never reads as a copy. Raw, counter-clockwise. A configured node
         keeps its CONFIG label and accent. */
      var cn = NODE_BY_ID[id]; if (cn) { nd.label = String(cn.label || id).toUpperCase(); nd.name = String(cn.label || id); if (cn.accent && C.hex) nd.accent = C.hex(cn.accent); }
      if (G2) { var pp = G2P.pve[k % 2]; nd.disc = pp.file; nd.discRot = pp.rot + (k >> 1) * 2.1; nd.raw = true; nd.rot = 1; }
      var gal = galaxies[id] = buildGalaxy(nd); NODES.push(nd);
      OBSTACLES.push({ x: 0, y: 0, r: 0, active: false }); gal.obIdx = OBSTACLES.length - 1;
      CONTENT_ANCHORS.push({ c: gal.world, r: 340 * nd.scale });
      // its caption: a galaxy landmark, placed with the other galaxy names (ahead of the hub / pool labels)
      var L = L_gal[id] = mkLabel('gal node', '<b>' + esc(nd.name) + '</b><span></span>'); L.halfW = 12; L.centered = true; L.off = [0, -40];
      labels.splice(labels.indexOf(L), 1); labels.splice(labels.indexOf(L_edge), 0, L);
      gal.spinT = MOTION.spin(0); GAL_EXTRA++;
      fillGuests(gal, guestsOf(id));
    });
  }
  var _rgb = [1, 1, 1];
  function uniApply(doc) {
    if (!doc || !doc.bodies || !UL) return;
    if (+QS.nx_synth_sw > 0) doc = synthSwitches(doc, Math.min(6, +QS.nx_synth_sw));
    var firstDoc = !UNI.doc; UNI.doc = doc; UNI.ts = +doc.ts || 0; UNI.counts = doc.counts || null; UNI.applied++;
    UNI.byTopo = {};
    doc.bodies.forEach(function (b) { if (b.topo) UNI.byTopo[b.topo] = b.id; });
    // systems -> frames, created once per id, in the server's stable system.slot order (never re-sorted afterwards)
    var syss = (doc.systems || []).slice().sort(function (a, b) { return (a.slot || 0) - (b.slot || 0); });
    ensureGalaxies(syss);
    var caps = UL.capacities(doc.bodies);
    syss.forEach(function (s) {
      var F = UNI.frames[s.id];
      if (!F) { var k = frameKind(s); F = UNI.frames[s.id] = mkFrame(s, k); if (k === 'network') UNI.netCore = s.id; if (k === 'clients') UNI.netClients = s.id; }
      // frameKind() stamps _node on the first document's system object only: carry it to every later one (without it
      // the guest records lost their galaxy key after the 2nd poll and the stars fell back to the name-based arm layout)
      if (F.kind === 'galaxy' && F.gal) s._node = F.gal.nd.id;
      F.sys = s; F.geom = uniGeom(s.shells || caps[s.id] || {});
      if (s.accent) F.accent.set(s.accent);
      // system accents come from /api/universe (one shared rule) so the two screens can never drift: a host
      // galaxy adopts its system's accent for core rim, halo, disc tint, light and beat ring (the loop reads nd.accent)
      if (F.kind === 'galaxy' && s.label) F.gal.nd.name = sysLabel(s);
      if (F.kind === 'galaxy') F.gal.nd.gone = s.count === 0;
      if (F.kind === 'galaxy' && s.accent) {
        var nd = F.gal.nd, hex = F.accent.getHex();
        if (nd.accent !== hex) { nd.accent = hex; setGalaxyTint(F.gal, hex); }
      }
    });
    if (!UNI.frames.__edge) UNI.frames.__edge = mkFrame({ id: '__edge', accent: '#e2e8f0' }, 'edge');
    UNI.frames.__edge.geom = uniGeom(caps[''] || {});
    Object.keys(UNI.frames).forEach(function (id) {
      var F = UNI.frames[id], L = 1.7; Object.keys(F.geom).forEach(function (sh) { L = Math.max(L, F.geom[sh].r1); });
      F.LmaxT = L; if (!F.Lmax) F.Lmax = L;
      if (F.kind === 'site' && F.hubIdx == null) { F.hubIdx = poolTake(); if (F.hubIdx >= 0) UNI.pool[F.hubIdx] = { hub: F }; }
      if (F.kind === 'site') F.rOut = 34 + 9 * Math.sqrt(Math.max(1, (F.sys.count || 4)));   // a satellite system widens with its member count
    });
    var seen = {}, guestBody = {};
    EVC.cand.length = 0;
    doc.bodies.forEach(function (b) {
      if (!b || !b.id) return;
      seen[b.id] = 1;
      var F = b.system == null ? UNI.frames.__edge : UNI.frames[b.system];
      var rec = UNI.recs[b.id], created = false;
      if (!rec) {
        created = true;
        rec = UNI.recs[b.id] = { b: b, F: F, role: '', idx: -1, p: null, wp: new THREE.Vector3(), loc: new THREE.Vector3(), orbA: 0, spinA: 0, pulA: 0,
                                 alpha: 0, rgb: [1, 1, 1], rgbT: [1, 1, 1], born: -1, status: b.status, evT: -1e9, ev: '', u: 0, guest: null };
        rec.orbA = (b.seed >>> 11) % 6283 / 1000; rec.spinA = rec.orbA * 1.7; rec.pulA = rec.orbA * 0.6; rec.ttA = (b.seed >>> 5) % 24;
      }
      var prevStatus = rec.status;
      rec.b = b; rec.F = F;
      if (!rec.role) rec.role = devRole(b, F);
      rec.p = UL.place(b, F ? F.geom : null);
      var m = b.m || {}; rec.u = normBps((+m.rx_bps || 0) + (+m.tx_bps || 0));
      rec.ci = clsInfo(b['class']);
      UL.colourRGB(b, rec.ci.man).forEach(function (v, i) { rec.rgbT[i] = v; });
      if (created) { rec.rgb[0] = rec.rgbT[0]; rec.rgb[1] = rec.rgbT[1]; rec.rgb[2] = rec.rgbT[2]; }
      if (rec.role === 'guest' && m.vmid != null) guestBody[(F.sys._node || '') + ':' + m.vmid] = rec;
      if (rec.role === 'dev' && rec.idx < 0) { rec.idx = poolTake(); if (rec.idx >= 0) UNI.pool[rec.idx] = rec; }
      // events: a body we have never seen is a birth when the server says new, or when it shows up after our first
      // document (it is genuinely new to this screen); status changes are down / relight, in place
      var now = SIM_T;
      if (created) {
        if (b['new'] || !firstDoc) { rec.born = 0; rec.ev = 'new'; rec.evT = now; uniFlare('birth', rec); if (!firstDoc) evcNote(rec, 'new'); }
        else rec.born = MOTION.BIRTH_S;
        rec.alpha = b.status === 'down' ? MOTION.DOWN_ALPHA : 1;
      } else if (prevStatus !== b.status) {
        if (b.status === 'down') { rec.ev = 'down'; rec.evT = now; if (!B3) uniFlare('down', rec); evcNote(rec, 'down'); }   // 3D: the body itself dims + desaturates in place (wall parity)
        else if (prevStatus === 'down') { rec.ev = 'up'; rec.evT = now; uniFlare('relight', rec); evcNote(rec, 'up'); }
      }
      rec.status = b.status;
    });
    evcPick();
    /* a document that suddenly carries under half of the bodies we hold is a feed fault (a registry rebuild answered
       with an empty body list was seen 2026-10-08), never ~150 devices leaving at once: keep every record for up to
       five polls (no removals, so no false births when they come back); a drop that persists is accepted */
    var prevN = Object.keys(UNI.recs).length, shrink = !firstDoc && prevN > 20 && doc.bodies.length < prevN * 0.5;
    UNI.shrinkN = shrink ? (UNI.shrinkN || 0) + 1 : 0;
    if (shrink && UNI.shrinkN <= 5) { UNI.shrinkSeen = (UNI.shrinkSeen || 0) + 1; if (UNI.counts && UNI.lastCounts) UNI.counts = UNI.lastCounts; }
    else Object.keys(UNI.recs).forEach(function (id) {
      if (seen[id]) return;
      var r = UNI.recs[id]; poolRelease(r.idx);
      Object.keys(UNI.planet).forEach(function (k) { if (UNI.planet[k] === id) UNI.planet[k] = null; });
      delete UNI.recs[id];
    });
    if (!shrink) UNI.lastCounts = UNI.counts;
    else Object.keys(UNI.guestBody).forEach(function (k) { if (!guestBody[k] && UNI.recs[UNI.guestBody[k].b.id]) guestBody[k] = UNI.guestBody[k]; });   // held records keep their stars
    UNI.guestBody = guestBody; UNI.frameList = Object.keys(UNI.frames);
    GUESTS_U.ver = -1;                       // the bodies are in: derived guest lists rebuild from this document
    netLayout(); netHubSync(); pulseRebuild(); applyDiscs(); siteHubSync(); uni3dSync(); netLabelsRefresh();
    var wasOn = UNI.on; UNI.on = true;
    if (!wasOn) { moonState = []; mgeo.setDrawRange(0, 0); }
    // static per-body attributes (cell, colour targets) - positions/sizes/alpha are written per frame by uniTick
    for (var i = 0; i < UNI.n; i++) {
      var P = UNI.pool[i]; if (!P) continue;
      dcell[i] = P.hub ? CELL_GLOW : P.ci.cell;
    }
    dgeo.attributes.cell.needsUpdate = true; dgeo.setDrawRange(0, UNI.n);
    NODES.forEach(function (n) { var gl = guestsOf(n.id); if (gl.length || S.guests.length) fillGuests(galaxies[n.id], gl); });
    updatePlanetLabels(); refreshLabels();
    try { trafficApply(doc.traffic); } catch (e) { console.error('nexus traffic', e); }
  }
  // a flare at a body: guests flare in their galaxy's spinning frame, devices at their live world position
  function uniFlare(kind, rec) {
    var rgb = kind === 'down' ? [0.75, 0.42, 0.45] : rec.rgbT;
    if (rec.role === 'guest') { var g = rec.guest, F = rec.F; if (!g || !g._pos || !F) { rec.pendFx = kind; return; } _local.fromArray(g._pos); fxFire(kind, rec, F.gal.G, _local, rgb); }
    else fxFire(kind, rec, null, null, rgb);
  }
  var _ul = new THREE.Vector3(), _hf = new THREE.Vector3();
  // JS twin of HUD_GLSL's hudFade(): 0 under the header band, the node cards and the stop caption (soft edges)
  function sstep(a, b, x) { var t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
  function hudFadeAt(p) {
    _hf.copy(p).project(cam); if (_hf.z > 1) return 1;
    var nx = _hf.x, ny = _hf.y;
    var top = 1 - sstep(0.80, 0.88, ny);
    var corner = 1 - sstep(0.62, 0.68, nx) * sstep(0.60, 0.68, ny);
    var card = 1 - sstep(0.62, 0.68, Math.abs(nx)) * (1 - sstep(0.18, 0.24, Math.abs(ny)));
    var cap = 1 - sstep(0.70, 0.78, -ny) * (1 - sstep(0.22, 0.28, Math.abs(nx)));
    return clamp(top * corner * card * cap, 0, 1);
  }
  // per frame: ease frame radii, integrate orbits/spins/pulses (only while up), write the pool + links + flares
  function uniTick(dt) {
    if (!UNI.on) return;
    if (!SC.active) SYS_ANG = (SYS_ANG + dt * MOTION.SYS_W) % TAU;     // frozen during the showcase, like the galaxies (its shots are baked)
    // the first document's bodies, links and rings fade in together (~1.2 s) instead of popping in if it lands after the reveal
    if (UNI.fade < 1) UNI.fade = Math.min(1, UNI.fade + dt / 1.2);
    var uFade = smooth(UNI.fade);
    NET_SPIN.rotation.y = SYS_ANG; EDGE_RING.rotation.y = SYS_ANG * 0.5;
    netEase(dt);
    var kE = 1 - Math.exp(-dt / 3), kS = 1 - Math.exp(-dt / MOTION.STATUS_TAU), kV = 1 - Math.exp(-dt / 0.45);
    /* a host-galaxy close-up (host / blk stops) is about that galaxy: the network system and the sites fade out (~0.5 s,
       during the leg) so nothing sits half-cut at the frame edge or on top of the arms; everywhere else they show */
    var closeUp = LABEL.mode === 'host' || LABEL.mode === 'blk', visT = closeUp ? 0 : 1;
    var fids = UNI.frameList;
    for (var fi = 0; fi < fids.length; fi++) {
      var F = UNI.frames[fids[fi]];
      F.vis = F.vis == null ? 1 : F.vis + ((F.kind === 'galaxy' ? 1 : visT) - F.vis) * kV;
      if (F.spin !== NET_SPIN && F.spin !== EDGE_RING && F.kind !== 'galaxy') F.spin.rotation.y = SYS_ANG * (1 + 0.15 * F.k);
      if (F.disc && F.disc.visible) { var ds = F.rOut * 1.25 * F.discSize; F.disc.scale.set(ds, ds, 1); F.disc.material.opacity = (F.kind === 'site' ? 0.34 : 0.2) * F.vis; }
      F.obj.updateMatrixWorld(true); F.obj.getWorldPosition(F.center);
      if (Math.abs(F.Lmax - F.LmaxT) > 1e-4) {
        F.Lmax += (F.LmaxT - F.Lmax) * kE;
        if (F.kind === 'galaxy') guestsRelayout(F);
      }
    }
    var guestEase = false;
    for (var i = 0; i < UNI.n; i++) {
      var P = UNI.pool[i];
      if (!P) { dsz[i] = 0; dal[i] = 0; continue; }
      if (P.hub) {   // satellite system hub glow
        var H = P.hub; dpos[i * 3] = H.center.x; dpos[i * 3 + 1] = H.center.y; dpos[i * 3 + 2] = H.center.z;
        dsh[i] = 0; dcell[i] = CELL_GLOW;
        // a site's hub glow: neutral (the accent tint read as a red smear on the SD-WAN site), smaller under the 3D hub star
        dcol[i * 3] = 0.42; dcol[i * 3 + 1] = 0.5; dcol[i * 3 + 2] = 0.62; dsz[i] = B3 ? 30 : 46; dal[i] = 0.6 * H.vis * uFade; dspin[i] = 0; dds[i] = 0; continue;
      }
      var R = P, b = R.b, F2 = R.F, up = b.status !== 'down';
      if (!F2) { dsz[i] = 0; continue; }
      if (up) {
        R.orbA += dt * MOTION.orbitW(R.u);
        R.spinA += dt * MOTION.spinW(R.ci.spin, R.u);
        R.pulA += dt * TAU / MOTION.pulseT(b.m && b.m.rtt_ms);
      }
      if (R.orbA > 1e4) R.orbA -= TAU * 1000;
      if (R.net) netLocal(R, _ul, false);                 // home-network diagram: fixed seats, no epicycle
      else {
        var p = R.p, wr = p.r === 0 ? 0 : mapR(F2, p.r), er = p.r === 0 ? 0 : MOTION.ORBIT_R * 0.55 * bandK(F2) * 0.5;
        _ul.set(Math.cos(p.theta) * wr + Math.cos(R.orbA) * er, p.y * bandK(F2), Math.sin(p.theta) * wr + Math.sin(R.orbA) * er);
      }
      R.loc.copy(_ul); F2.spin.localToWorld(_ul); R.wp.copy(_ul);
      if (R.siteHub) R.wp.copy(F2.center);                 // drawn as its system's hub model, at the centre
      var aT = up ? 1 : MOTION.DOWN_ALPHA; R.alpha += (aT - R.alpha) * kS;
      for (var c = 0; c < 3; c++) R.rgb[c] += (R.rgbT[c] - R.rgb[c]) * kS;
      if (B3) {
        // 3D body: bodies3d draws it; the sprite slot stays empty. Its fade is the system's close-up fade x first-doc fade
        dsz[i] = 0; dal[i] = 0;
        if (R.born >= 0 && R.born < MOTION.BIRTH_S) R.born += dt;
        var k3 = R.b3;
        if (k3 != null && k3 >= 0 && B3L[k3] === R) {
          var P3 = B3.positions; P3[k3 * 3] = R.wp.x; P3[k3 * 3 + 1] = R.wp.y; P3[k3 * 3 + 2] = R.wp.z;
          // the HUD keep-out the point pools already get (hudFade): a planet never sits under the caption or the cards
          B3.vis[k3] = F2.vis * uFade * (U_HUD.value > 0.5 ? hudFadeAt(R.wp) : 1);
        }
        continue;
      }
      dpos[i * 3] = _ul.x; dpos[i * 3 + 1] = _ul.y; dpos[i * 3 + 2] = _ul.z;
      if (UNI.precol) {
        // Blender cells are pre-coloured: multiply by white with a +-8% per-seed jitter, emissive share boosted with activity
        var emP = (1 + R.ci.emissive * (0.25 + 0.45 * R.u)) * (0.92 + 0.16 * ((b.seed >>> 20) & 255) / 255);
        dcol[i * 3] = emP; dcol[i * 3 + 1] = emP; dcol[i * 3 + 2] = emP;
      } else {
        var em = 1 + R.ci.emissive * (0.6 + 0.6 * R.u);
        dcol[i * 3] = R.rgb[0] * em; dcol[i * 3 + 1] = R.rgb[1] * em; dcol[i * 3 + 2] = R.rgb[2] * em;
      }
      dds[i] = 0.8 * clamp((1 - R.alpha) / (1 - MOTION.DOWN_ALPHA), 0, 1);
      var birth = 1;
      if (R.born >= 0 && R.born < MOTION.BIRTH_S) { R.born += dt; birth = smootherstep(R.born / MOTION.BIRTH_S); }
      var pulse = 1 + MOTION.PULSE_A * (up ? Math.sin(R.pulA) : 0);
      dsz[i] = (UNI.precol ? 28 : 19) * R.ci.size * (R.p ? R.p.scale : 1) * pulse * birth * (1 + 0.35 * R.u);   // Blender cells carry a 20 px transparent pad: drawn larger to match
      var tt = TT[b['class']];
      if (tt) {
        if (up) R.ttA += dt * MOTION.ttFps(tt.fps, R.u);                 // down: the turntable stops on its frame
        if (R.ttA > 1e5) R.ttA -= tt.frames * 1000;
        dsh[i] = tt.slot; dcell[i] = tt.start + (Math.floor(R.ttA) % tt.frames); dsz[i] *= tt.scale; R.spinA = 0;
      } else { dsh[i] = 0; dcell[i] = R.ci.cell; }
      dal[i] = R.alpha * (0.35 + 0.65 * birth) * F2.vis * uFade;
      dspin[i] = R.spinA;
    }
    if (UNI.n) { var A = dgeo.attributes; A.position.needsUpdate = true; A.color.needsUpdate = true; A.size.needsUpdate = true; A.alpha.needsUpdate = true; A.spin.needsUpdate = true; A.dsat.needsUpdate = true; A.cell.needsUpdate = true; A.sheet.needsUpdate = true; }
    // planets ride the core ring (their layout slot), gateway stays at the hub
    for (var pk = 0; pk < 2; pk++) {
      var k = pk ? 'ap' : 'switch', pid = UNI.planet[k], PR = pid && UNI.recs[pid]; if (!PR || !PR.F) continue;
      if (PR.net) netLocal(PR, _ul, false);
      else { var pp = PR.p; _ul.set(Math.cos(pp.theta) * mapR(PR.F, pp.r), pp.y * bandK(PR.F), Math.sin(pp.theta) * mapR(PR.F, pp.r)); }
      PR.F.spin.localToWorld(_ul);
      fab[k].pos.copy(_ul); fab[k].group.position.copy(_ul); PR.wp.copy(_ul);
    }
    var gw = UNI.planet.gateway && UNI.recs[UNI.planet.gateway]; if (gw) gw.wp.copy(fab.gateway.pos);
    if (B3) {
      for (var gq = 0; gq < G3L.length; gq++) {
        var GE = G3L[gq], k4 = GE.b3; if (B3L[k4] !== GE || !GE.g._pos) continue;
        _ul.fromArray(GE.g._pos); GE.gal.G.localToWorld(_ul);
        B3.positions[k4 * 3] = _ul.x; B3.positions[k4 * 3 + 1] = _ul.y; B3.positions[k4 * 3 + 2] = _ul.z; B3.vis[k4] = uFade;
      }
      if (B3L.length) {
        B3.markPositions(); B3.markVis();
        if (B3PHOTO && B3.lights && B3.lights.length >= B3L.length * 4) {
          for (var lk = 0; lk < B3L.length; lk++) { var LR = B3L[lk]; if (LR.g3 || !LR.b) continue; lightOf(LR, _lit); B3.lights[lk * 4] = _lit[0]; B3.lights[lk * 4 + 1] = _lit[1]; B3.lights[lk * 4 + 2] = _lit[2]; B3.lights[lk * 4 + 3] = _lit[3]; }
          B3.markLights();
        }
      }
      // site hub models: at the system centre, the device's own status (wall hubStatus), the system's fade
      for (var si = 0; si < fids.length; si++) {
        var SF = UNI.frames[fids[si]], HM = SF.hub3; if (!HM) continue;
        var HR = SF.hubRec, hdn = HR && HR.b.status === 'down', hv = SF.vis * uFade;
        HM.position.copy(SF.center); HM.visible = hv > 0.01;
        B3.setHubStatus(HM, { desat: hdn ? 0.7 : (HR && HR.b.status === 'unknown' ? 0.4 : 0), bright: (hdn ? 0.45 : 1) * (HDR && !B3PHOTO ? 1.5 : 1), lvl: hv });
        if (HM.userData.glare) HM.userData.glare.lvl = hv * (hdn ? 0.3 : 1);
        hubFace(HM, SF.center, dt, 0.5, si + 3);
      }
      // extra switch / AP hubs of the home-network diagram
      for (var hq = 0; hq < NETD.hubs.length; hq++) {
        var NH = NETD.hubs[hq], NM = NETD.hubMesh[NH.b.id]; if (!NM) continue;
        var nhv = (NH.F.vis == null ? 1 : NH.F.vis) * uFade, ndn = NH.b.status === 'down';
        NM.position.copy(NH.wp); NM.visible = nhv > 0.01;
        B3.setHubStatus(NM, { desat: ndn ? 0.7 : 0, bright: (ndn ? 0.4 : 0.72) * (HDR && !B3PHOTO ? 2.1 : 1), lvl: nhv });
        if (NM.userData.glare) NM.userData.glare.lvl = nhv * (ndn ? 0.3 : 1);
        hubFace(NM, NH.wp, dt, 0.5, hq + 11);
      }
    }
    var nvF = UNI.frames[UNI.netCore], nvis = nvF ? nvF.vis : 1;
    if (NET_VIS !== nvis) { NET_VIS = nvis; for (var gk in NET_FAM) if (GUIDE_MAT[gk]) GUIDE_MAT[gk].uniforms.uOp.value = guideOp(gk); }
    for (var fk = 0; fk < FABKIND.length; fk++) { var fg = fab[FABKIND[fk]].group, show = nvis > 0.06; if (fg.visible !== show) fg.visible = show; }
    fxTick(dt);
    linksTick();
  }
  // a galaxy system's outer radius moved: rewrite its guests' arm positions in place (only while the ease runs)
  var _gl = [0, 0, 0];
  function guestsRelayout(F) {
    var gal = F.gal, n = gal.list.length;
    for (var i = 0; i < n; i++) {
      var g = gal.list[i], rec = g._uid && UNI.recs[g._uid]; if (!rec || !g._pos) continue;
      guestLocal(F, rec, _gl); g._pos[0] = _gl[0]; g._pos[1] = _gl[1]; g._pos[2] = _gl[2];
      gal.gp[i * 3] = _gl[0]; gal.gp[i * 3 + 1] = _gl[1]; gal.gp[i * 3 + 2] = _gl[2];
    }
    gal.gg.attributes.position.needsUpdate = true;
  }
  var _fxw = new THREE.Vector3();
  function fxTick(dt) {
    var live = 0;
    for (var i = 0; i < FX_N; i++) {
      var X = fx[i];
      if (X.t >= X.dur) { fsz[i] = 0; fal[i] = 0; continue; }
      live++;
      X.t += dt; var f = clamp(X.t / X.dur, 0, 1);
      if (X.frame) { _fxw.copy(X.local); X.frame.localToWorld(_fxw); } else if (X.rec) _fxw.copy(X.rec.wp); else continue;
      fpos[i * 3] = _fxw.x; fpos[i * 3 + 1] = _fxw.y; fpos[i * 3 + 2] = _fxw.z;
      var e = 1 - (1 - f) * (1 - f);
      fsz[i] = lerp(X.s0, X.s1, e);
      // a flipbook carries its own fade (first/last frames ~empty); the fallback ring fades by hand
      fal[i] = X.sh ? 1 : (X.kind === 'down' ? 0.9 : 1.0) * (1 - f) * (f < 0.08 ? f / 0.08 : 1);
      var cb = X.kind === 'down' ? 1.1 : 1.6;
      fcol[i * 3] = X.r * cb; fcol[i * 3 + 1] = X.g * cb; fcol[i * 3 + 2] = X.b * cb;
      fsheet[i] = X.sheet || 0; fcell[i] = X.sh ? Math.min(X.sh.frames - 1, Math.floor(X.t * X.sh.fps)) : HDR ? CELL_GLOW : CELL_RING; fspin[i] = 0;
    }
    // pulse overlays: frame = the body's latency-driven pulse phase; stopped (frame held, dimmed) when the body is down
    var np = 0;
    if (FLIP.pulse) {
      var PS = FLIP.pulse;
      for (var q = 0; q < PULSE.length && np < PUL_N; q++) {
        var R = PULSE[q]; if (!R.b || UNI.recs[R.b.id] !== R) continue;
        var k = FX_N + np++, ph = R.pulA / TAU; ph -= Math.floor(ph);
        fpos[k * 3] = R.wp.x; fpos[k * 3 + 1] = R.wp.y; fpos[k * 3 + 2] = R.wp.z;
        fsz[k] = 19 * R.ci.size * (PS.scale || 2.2) * (1 + 0.3 * R.u); fal[k] = 0.55 * R.alpha * (R.b.status === 'down' ? 0.4 : 1) * (R.F.vis == null ? 1 : R.F.vis);
        fcol[k * 3] = R.rgb[0]; fcol[k * 3 + 1] = R.rgb[1]; fcol[k * 3 + 2] = R.rgb[2];
        fsheet[k] = 3; fcell[k] = Math.floor(ph * PS.frames) % PS.frames; fspin[k] = 0;
      }
    }
    fgeo.setDrawRange(0, np ? FX_N + np : live ? FX_N : 0);   // nothing in flight and no pulse bodies = no draw call
    if (!live && !np) return;
    var A = fgeo.attributes; A.position.needsUpdate = true; A.size.needsUpdate = true; A.alpha.needsUpdate = true; A.color.needsUpdate = true; A.cell.needsUpdate = true; A.sheet.needsUpdate = true;
  }
  // attachment lines: child -> parent when both live in the same frame; a body whose parent is elsewhere links to
  // its own system's hub, and every satellite hub links back to the gateway (the SD-WAN tunnel). Brightness follows
  // the child's activity; the children of the selected wired/AP stop light up.
  function linkSeg(n, a, b, k, rgb) {
    if (n >= LINK_N) return n; var j = n * 6;
    lpos[j] = a.x; lpos[j + 1] = a.y; lpos[j + 2] = a.z; lpos[j + 3] = b.x; lpos[j + 4] = b.y; lpos[j + 5] = b.z;
    lcol[j] = rgb[0] * k; lcol[j + 1] = rgb[1] * k; lcol[j + 2] = rgb[2] * k; lcol[j + 3] = rgb[0] * k * 0.35; lcol[j + 4] = rgb[1] * k * 0.35; lcol[j + 5] = rgb[2] * k * 0.35;
    return n + 1;
  }
  var SPOKE_RGB = [0.35, 0.45, 0.58];
  var NET_LINE_RGB = [0.42, 0.56, 0.74];
  function linksTick() {
    var n = 0, selTopo = (LABEL.mode === 'wired' || LABEL.mode === 'ap') ? LABEL.id : null, fabricMode = LABEL.mode === 'fabric' || !!selTopo;
    if (!UNI.on) { n = linkSeg(n, fab.gateway.pos, fab.switch.pos, 0.3, SPOKE_RGB); n = linkSeg(n, fab.gateway.pos, fab.ap.pos, 0.3, SPOKE_RGB); }
    if (UNI.on) {
      /* home-network diagram: gateway -> every hub (the backbone, quiet but always there); hub -> the devices actually
         attached to it (hairlines, lit at that hub's own wired/AP stop). A device on the gateway itself gets no line:
         the ring around the gateway already says so, and 40 converging lines were the starburst. */
      var nfv = UNI.frames[UNI.netCore] ? UNI.frames[UNI.netCore].vis : 1, fade0 = smooth(UNI.fade) * (nfv == null ? 1 : nfv);
      for (var h = 0; h < NETD.hubs.length; h++) {
        var H = NETD.hubs[h], hsel = selTopo && H.b.topo === selTopo;
        if (fade0 > 0.01) n = linkSeg(n, H.net.parent ? H.net.parent.wp : fab.gateway.pos, H.wp, (hsel ? 0.5 : 0.26) * (HDR ? 0.5 : 1) * fade0 * (H.b.status === 'down' ? 0.45 : 1), NET_LINE_RGB);
        // a switch star's own orbits (only where it has planets): faint circles in the system plane, riding its spin
        if (H.net.kids.length && fade0 > 0.01) {
          hubPolar(H, _hp); var used = H.net.kids.length, ah = _hp[0], hx = Math.cos(ah) * _hp[1], hz = Math.sin(ah) * _hp[1];
          for (var oo = 0; oo < NETD.KID_R.length && used > 0; oo++) {
            var ro = NETD.KID_R[oo]; used -= Math.floor(TAU * ro / 9.5);
            for (var sg = 0; sg < 32; sg++) {
              var q0 = sg / 32 * TAU, q1 = (sg + 1) / 32 * TAU;
              _ra.set(hx + Math.cos(q0) * ro, 0, hz + Math.sin(q0) * ro); _rb.set(hx + Math.cos(q1) * ro, 0, hz + Math.sin(q1) * ro);
              NET_SPIN.localToWorld(_ra); NET_SPIN.localToWorld(_rb);
              n = linkSeg(n, _ra, _rb, (hsel ? 0.12 : 0.06) * (HDR ? 0.55 : 1) * fade0, NET_LINE_RGB);
            }
          }
        }
      }
      for (var i = 0; i < UNI.n; i++) {
        var P = UNI.pool[i]; if (!P) continue;
        if (P.hub) { if (P.hub.vis > 0.01) n = linkSeg(n, P.hub.center, fab.gateway.pos, 0.18 * P.hub.vis, SPOKE_RGB); continue; }
        if (P.netHub) continue;
        var pid = P.b.parent, PR = pid && (UNI.recs[pid] || UNI.recs[UNI.byTopo[pid]]);
        var to = null, k;
        if (P.net) {
          if (!PR || !PR.net || PR.net.kind !== 'hub') continue;                // on the gateway: implied by the ring
          to = PR.wp;
          var sel = selTopo && PR.b.topo === selTopo;
          k = (P.net.kind === 'fan' ? 0.09 : 0.035) * (sel ? 4.5 : fabricMode ? 1.3 : 1);
        } else {
          if (PR && PR.F === P.F && (PR.role === 'dev' || PR.role === 'planet')) to = PR.wp;
          else if (P.F && P.F.kind === 'site') to = P.F.center;
          if (!to) continue;
          k = (0.035 + 0.14 * P.u) * (selTopo && PR && PR.b.topo === selTopo ? 5 : fabricMode ? 1.3 : 1);
        }
        k *= (P.b.status === 'down' ? 0.4 : 1) * P.alpha * (P.F.vis == null ? 1 : P.F.vis) * smooth(UNI.fade);
        if (k < 0.002) continue;
        n = linkSeg(n, P.wp, to, k, P.net ? NET_LINE_RGB : P.rgb);
      }
    }
    n = ringsInto(n);
    lgeo.attributes.position.needsUpdate = true; lgeo.attributes.color.needsUpdate = true; lgeo.setDrawRange(0, n * 2);
  }
  /* orbit rings: one faint circle per occupied shell of the network system and of every satellite system, tinted by
     the shell's class, so the home network reads as a solar system with an orbit per kind of device. Circles are
     invariant under the system's spin, so the world-space segments are rebuilt only when a frame's radius eases. */
  var RING_SEG = 56, ringBuf = new Float32Array(0), ringCol = new Float32Array(0), ringN = 0, ringSig = -1;
  function shellClassTint(F, sh) {
    for (var id in UNI.recs) { var R = UNI.recs[id]; if (R.F === F && R.b.shell === sh) return R.rgbT; }
    return SPOKE_RGB;
  }
  var _ra = new THREE.Vector3(), _rb = new THREE.Vector3();
  function ringsInto(n) {
    if (!UNI.on) return n;
    var sig = UNI.applied * 7.3, fids = UNI.frameList;            // numeric signature: no per-frame string building
    for (var i = 0; i < fids.length; i++) { var F = UNI.frames[fids[i]]; if (F.kind !== 'galaxy' && F.kind !== 'edge' && !isNetF(F)) sig += Math.round(F.Lmax * 2000) * (i + 1) + F.rOut * 0.37; }
    if (sig !== ringSig) {
      ringSig = sig; var segs = [];
      fids.forEach(function (id) {
        var F = UNI.frames[id]; if (F.kind === 'galaxy' || F.kind === 'edge') return;
        F.obj.updateMatrixWorld(true);
        if (isNetF(F)) {
          if (F.kind !== 'network' && UNI.netCore) return;                 // drawn once, for the whole network system
          var ok = HDR ? 0.5 : 1, rcs = [[NETD.R_HUB, 0.075 * ok], [(NETD.R_DEV[0] + NETD.R_DEV[1]) / 2, 0.05 * ok]];
          if (NETD.hubs.some(function (H) { return H.net && H.net.tier === 2; })) rcs.push([NETD.R_HUB + NETD.TIER, 0.045 * ok]);
          rcs.forEach(function (rc) {
            for (var j0 = 0; j0 < RING_SEG * 2; j0++) {
              var b0 = j0 / (RING_SEG * 2) * TAU, b1 = (j0 + 1) / (RING_SEG * 2) * TAU;
              _ra.set(Math.cos(b0) * rc[0], 0, Math.sin(b0) * rc[0]); _rb.set(Math.cos(b1) * rc[0], 0, Math.sin(b1) * rc[0]);
              F.obj.localToWorld(_ra); F.obj.localToWorld(_rb);
              segs.push(_ra.x, _ra.y, _ra.z, _rb.x, _rb.y, _rb.z, NET_LINE_RGB[0] * rc[1], NET_LINE_RGB[1] * rc[1], NET_LINE_RGB[2] * rc[1]);
            }
          });
          return;
        }
        Object.keys(F.geom).forEach(function (sh) {
          var g = F.geom[sh]; if (+sh === 0) return;
          // neutral orbits, like the home network's (class tints read as a red ring set under the SD-WAN cameras)
          var r = mapR(F, (g.r0 + g.r1) / 2), tint = NET_LINE_RGB, k = (F.kind === 'site' ? 0.075 : 0.06) * (HDR ? 0.5 : 1);
          for (var j = 0; j < RING_SEG; j++) {
            var a0 = j / RING_SEG * TAU, a1 = (j + 1) / RING_SEG * TAU;
            _ra.set(Math.cos(a0) * r, 0, Math.sin(a0) * r); _rb.set(Math.cos(a1) * r, 0, Math.sin(a1) * r);
            F.obj.localToWorld(_ra); F.obj.localToWorld(_rb);
            segs.push(_ra.x, _ra.y, _ra.z, _rb.x, _rb.y, _rb.z, tint[0] * k, tint[1] * k, tint[2] * k);
          }
        });
      });
      ringN = segs.length / 9; ringBuf = new Float32Array(ringN * 6); ringCol = new Float32Array(ringN * 6);
      for (var q = 0; q < ringN; q++) { for (var c = 0; c < 6; c++) ringBuf[q * 6 + c] = segs[q * 9 + c]; for (var c2 = 0; c2 < 3; c2++) { ringCol[q * 6 + c2] = segs[q * 9 + 6 + c2]; ringCol[q * 6 + 3 + c2] = segs[q * 9 + 6 + c2]; } }
    }
    var room = Math.min(ringN, LINK_N - n), nv = (UNI.frames[UNI.netCore] ? UNI.frames[UNI.netCore].vis : 1) * smooth(UNI.fade);
    if (room <= 0 || nv < 0.01) return n;
    lpos.set(ringBuf.subarray(0, room * 6), n * 6);
    for (var q = 0; q < room * 6; q++) lcol[n * 6 + q] = ringCol[q] * nv;      // every ring belongs to the network or a site: one shared fade
    return n + room;
  }
  /* manifest (Blender bake): the class atlas, per-class look, optional galaxy discs + birth flipbook. Absent -> the
     procedural atlas above. Loaded once; a later manifest would need a reload (the TV reloads on deploy anyway). */
  function loadManifest() {
    fetch('/static/assets/universe/manifest.json', { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }).then(function (man) {
      UNI.man = man;
      var at = man.atlas || {};
      if (B3) {      // 3D bodies: no class atlas / turntables / pulse or death sheets; the manifest still gives sizes + tints
        Object.keys(UNI.recs).forEach(function (id) { var R = UNI.recs[id]; R.ci = clsInfo(R.b['class']); });
        if (UNI.on) { B3SIG = ''; uni3dSync(); }
      }
      if (at.file && !B3) TEXL.load('/static/assets/universe/' + at.file, function (t) {
        t.anisotropy = MAX_ANISO;
        var u = devMat.uniforms; u.map.value = t; u.uCols.value = at.cols || 8; u.uRows.value = at.rows || 4; u.uPremul.value = at.premultiplied ? 1 : 0;
        UNI.precol = !!at.precoloured; u.uTint.value = 1;            // precoloured: the vertex colour carries brightness only (uniTick)
        // utility cells (halo / ring) live in the same atlas: hub glows and the fallback flare ring use them
        var ut = at.util || {}; if (ut.halo != null) CELL_GLOW = +ut.halo; if (ut.ring != null) CELL_RING = +ut.ring;
        fxMat.uniforms.map.value = t; fxMat.uniforms.uCols.value = at.cols || 8; fxMat.uniforms.uRows.value = at.rows || 4;
        Object.keys(UNI.recs).forEach(function (id) { var R = UNI.recs[id]; R.ci = clsInfo(R.b['class']); });
        for (var i = 0; i < UNI.n; i++) { var P = UNI.pool[i]; if (P) dcell[i] = P.hub ? CELL_GLOW : P.ci.cell; }
        dgeo.attributes.cell.needsUpdate = true; pulseRebuild();
      }, undefined, function () { console.warn('nexus: universe atlas failed'); });
      function sheet(name, slot, cb) {
        var an = man.anims && man.anims[name]; if (!an || !an.file) return;
        TEXL.load(DISC_U + an.file, function (t) {
          var cols = an.cols || 4, rows = Math.ceil((an.frames || 16) / cols);
          fxMat.uniforms['map' + slot].value = t; fxMat.uniforms['uGrid' + slot].value.set(cols, rows);
          cb({ frames: an.frames || 16, fps: an.fps || 12, scale: an.scale || 2 });
        }, undefined, function () { console.warn('nexus: anim failed', name); });
      }
      sheet('birth', 2, function (sh) { FLIP.on = true; FLIP.frames = sh.frames; FLIP.fps = sh.fps; FLIP.scale = sh.scale; });
      if (!B3) sheet('death', 3, function (sh) { FLIP.death = sh; });
      var ttSlot = {}, ttNext = 1;
      Object.keys(man.classes || {}).forEach(function (cls) {
        var c = man.classes[cls], T = c.turntable;
        if (B3 || !T || !T.file || !T.matches_still || !(c.spin > 0)) return;          // a non-matching sheet would jump from the still
        if (ttSlot[T.file] == null) { if (ttNext > 3) return; ttSlot[T.file] = ttNext++; }
        var slot = ttSlot[T.file];
        TEXL.load(DISC_U + T.file, function (t) {
          var rows = Math.max(1, Math.round(t.image.height / (T.cell || 128)));
          devMat.uniforms['map' + (slot + 1)].value = t; devMat.uniforms['uGrid' + (slot + 1)].value.set(T.cols || 16, rows);
          TT[cls] = { slot: slot, start: T.start || 0, frames: T.frames || 24, fps: T.fps || 8, scale: T.size_vs_still ? 1 / T.size_vs_still : 1 };
        }, undefined, function () { console.warn('nexus: turntable failed', T.file); });
      });
      if (!B3) sheet('pulse', 4, function (sh) { FLIP.pulse = sh; });
      // pass-two galaxy discs: keyed by system id; skipped when it is the file the galaxy already wears
      if (man.discs && !NXF.nodisc && !G2) NODES.forEach(function (nd) {
        // (never one of the three baked plates - the page picks those itself, node 0 wears the mirrored blue-white one)
        var d = man.discs['sys:' + nd.id] || man.discs['node:' + nd.index]; if (!d || !d.file || d.file.replace('../', '') === nd.disc || /galaxy_(nb|gpu|edge)\.png$/.test(d.file)) return;
        TEXL.load(DISC_U + d.file, function (t) { t.anisotropy = MAX_ANISO; var gm = galaxies[nd.id].discMat; gm.map = t; gm.needsUpdate = true; if (d.size) galaxies[nd.id].disc.scale.setScalar(d.size / 2); });
      });
      applyDiscs();
      BOOT.manifest = true;
    }).catch(function () { BOOT.manifest = true; /* no manifest yet: procedural atlas */ });
  }
  function pollUniverse() {
    if (!UL || UNI.freeze) return;                 // UNI.freeze: QA only (an injected document stays on screen)
    fetch('/api/universe', { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) { UNI.polls++; var t0 = performance.now(); try { uniApply(d); } catch (e) { UNI.lastErr = String(e); console.error('nexus universe', e); } cpuMark('uniApply', t0); BOOT.uni = true; })
      .catch(function (e) { UNI.fails++; UNI.lastErr = String(e); BOOT.uni = true; });
  }
  // devices worth a label right now (overview): new births and status changes in the last 10 min, then the busiest
  function uniEvents(max) {
    var out = [], now = SIM_T;
    Object.keys(UNI.recs).forEach(function (id) { var R = UNI.recs[id]; if (R.ev && now - R.evT < 600 && (R.role === 'dev' || R.role === 'guest')) out.push(R); });
    out.sort(function (a, b) { return b.evT - a.evT; });
    return out.slice(0, max);
  }
  // bodies attached to a parent - excluding a remote site's members (they hang off the gateway in the data, but they
  // are drawn in their own satellite system and linked to its hub, so labelling them at a fabric stop is clutter)
  function uniChildren(topo) {
    var out = [], prId = UNI.byTopo[topo], PR = prId && UNI.recs[prId];
    for (var i = 0; i < UNI.n; i++) {
      var P = UNI.pool[i]; if (!P || P.hub || (P.b.parent !== prId && P.b.parent !== topo)) continue;
      if (P.F && P.F.kind === 'site' && (!PR || PR.F !== P.F)) continue;
      out.push(P);
    }
    return out;
  }
  function uniNetBodies() { var out = []; for (var i = 0; i < UNI.n; i++) { var P = UNI.pool[i]; if (P && !P.hub && P.F && (P.F.kind === 'network' || P.F.kind === 'clients')) out.push(P); } return out; }
  function uniSites() { var out = []; Object.keys(UNI.frames).forEach(function (k) { var F = UNI.frames[k]; if (F.kind === 'site') out.push(F); }); return out; }
  if (UL) { loadManifest(); setTimeout(pollUniverse, 0); setInterval(pollUniverse, UNI_POLL_MS); } else BOOT.manifest = true;

  /* ============================== TRAFFIC BETWEEN SYSTEMS (docs/contracts.md, 2026-10-08) ==============================
     /api/universe `traffic`: measured bits/s between systems (galaxies, the network core, the home clients, the sites)
     and from a system to the internet. Each measured direction is a LANE: a lifted cubic Bezier between the two
     systems' anchors, both directions side by side when both are measured, one centred lane when only the total is.
     A pair that is not in the document draws nothing (no fake motion, no dormant lane).
       rate  -> lane intensity u = (log10(bps) - 3) / 6, capped at 1 Gb/s, quantised to 5 steps (the legend can name
                them); u drives particle DENSITY and WIDTH, never speed (speed stays in a narrow band: 70..130 units/s)
       kind  -> a restrained tint (TR_KIND), the same one the lane's label swatch and the legend show
       dir   -> the particles' direction; an undirected lane carries particles both ways (half each)
     Rendering: ONE instanced draw (TR_MAXL lanes x TR_PER streaks). The vertex shader evaluates each streak's head and
     tail on its lane's curve from a uniform array (5 vec4 per lane: control points, travel phase, u, fade, mode,
     colour, length) and builds a screen-aligned quad between them, so a frame uploads ~200 vec4 and no buffers.
     The travel phase is integrated on the CPU with the clamped dt (a rate change never makes particles jump). */
  var TR_MAXL = 40, TR_PER = 40;
  var TR_KIND = { lan: '#8db8f2', storage: '#e8c27a', backup: '#b6a2f0', wan: '#ef9db3', vpn: '#86d9a8', media: '#7fd6e0', mixed: '#c9d1dc' };
  var TR_KIND_NAME = { lan: 'LAN', storage: 'Storage', backup: 'Backup', wan: 'Internet', vpn: 'VPN', media: 'Media', mixed: 'Mixed' };
  var TR = { lanes: {}, list: [], slots: [], ts: 0, on: false, emph: 1, pairs: [], covered: {}, labels: [], legendSig: '', roadSig: '' };
  for (var tri = 0; tri < TR_MAXL; tri++) TR.slots.push(null);
  var TR_U = new Float32Array(TR_MAXL * 20);
  var trMat = new THREE.ShaderMaterial({
    uniforms: { uL: { value: TR_U }, uPR: U_PR, uRes: { value: new THREE.Vector2(1, 1) }, uPxK: { value: 1 }, uHud: U_HUD, uRide: { value: -1 } },
    vertexShader: [
      HUD_GLSL,
      'uniform vec4 uL[' + (TR_MAXL * 5) + ']; uniform float uPR, uPxK, uRide; uniform vec2 uRes;',
      'attribute vec2 corner; attribute float aLane; attribute vec4 aSeed;',
      'varying vec2 vUv; varying vec3 vC; varying float vA;',
      'vec3 bez(vec3 a, vec3 b, vec3 c, vec3 d, float t){ float u = 1.0 - t; return u*u*u*a + 3.0*u*u*t*b + 3.0*u*t*t*c + t*t*t*d; }',
      'void main(){',
      '  int li = int(aLane + 0.5) * 5;',
      '  vec4 L0 = uL[li]; vec4 L1 = uL[li + 1]; vec4 L2 = uL[li + 2]; vec4 L3 = uL[li + 3]; vec4 L4 = uL[li + 4];',
      '  float u = L1.w; float live = L2.w; float mode = L3.w; float len = max(L4.w, 1.0);',
      '  vUv = corner; vC = L4.rgb; vA = 0.0; gl_Position = vec4(0.0, 0.0, 2.0, 1.0);',
      '  float show = clamp((0.12 + 0.48 * u - aSeed.z) * 10.0, 0.0, 1.0) * live;',          // density: 12 % .. 60 % of the lane's 40 streaks
      '  if (show < 0.003) return;',
      '  float dir = mode > 0.5 ? 1.0 : (mode < -0.5 ? -1.0 : (fract(aSeed.z * 7.13) < 0.5 ? 1.0 : -1.0));',
      '  float sp = (mode > 0.5 || mode < -0.5) ? 1.0 : 0.5;',
      '  float ph = fract(aSeed.x + L0.w * sp);',
      '  float t = dir > 0.0 ? ph : 1.0 - ph;',
      '  float tr = clamp((8.0 + 16.0 * u) * (0.75 + 0.5 * aSeed.y) * ' + (HDR ? '0.55' : '1.0') + ' / len, 0.003, 0.16);',
      '  float tt = clamp(t - dir * tr, 0.0, 1.0);',
      '  vec4 h = projectionMatrix * modelViewMatrix * vec4(bez(L0.xyz, L1.xyz, L2.xyz, L3.xyz, t), 1.0);',
      '  vec4 c = projectionMatrix * modelViewMatrix * vec4(bez(L0.xyz, L1.xyz, L2.xyz, L3.xyz, tt), 1.0);',
      '  if (h.w < 1.0 || c.w < 1.0) return;',
      '  vec2 hs = h.xy / h.w;',
      '  vec2 cs = c.xy / c.w;',
      '  vec2 dd = (hs - cs) * uRes * 0.5;',
      '  vec2 sdir = normalize(dd + vec2(0.0001, 0.0));',
      '  vec2 snrm = vec2(-sdir.y, sdir.x);',
      '  float w = clamp((1.7 + 2.4 * u) * aSeed.w * uPxK / h.w, 1.1 * uPR, 5.5 * uPR);',
      '  float cap = corner.y > 0.5 ? 1.0 : -0.6;',
      '  vec2 p = mix(cs, hs, corner.y) + (sdir * (w * cap) + snrm * (corner.x * w)) / (uRes * 0.5);',
      '  float ww = mix(c.w, h.w, corner.y);',
      '  float zz = mix(c.z / c.w, h.z / h.w, corner.y);',
      '  gl_Position = vec4(p * ww, zz * ww, ww);',
      '  float nearF = abs(aLane - uRide) < 0.5 ? smoothstep(18.0, 70.0, h.w) : smoothstep(140.0, 460.0, h.w);',   // streaks near the lens fade out (the ridden lane only right at it)
      '  vA = show * smoothstep(0.0, 0.05, t) * (1.0 - smoothstep(0.95, 1.0, t)) * (0.55 + 0.35 * u) * nearF * hudFade(hs); }'   // never smoothstep(e0 > e1): undefined in GLSL
    ].join('\n'),
    fragmentShader: [
      'varying vec2 vUv; varying vec3 vC; varying float vA;',
      'void main(){ float x = vUv.x, y = clamp(vUv.y, 0.0, 1.0);',
      '  float body = exp(-x * x * 2.6) * pow(y, 1.6), head = smoothstep(0.8, 1.0, y) * exp(-x * x * 5.0);',
      '  float a = vA * (0.8 * body + 0.9 * head); if (a < 0.002) discard;',
      '  gl_FragColor = vec4(vC * (0.9 + 1.7 * head) * a, a); }'
    ].join('\n'),
    // DoubleSide: the quad's winding follows the streak's screen direction (width axis = its left normal), i.e. it is
    // clockwise for every streak; under the default FrontSide every quad was back-face culled and nothing drew
    side: THREE.DoubleSide, transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor
  });
  (function () {
    var g = new THREE.InstancedBufferGeometry(), n = TR_MAXL * TR_PER;
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));          // unused; three wants one
    g.setAttribute('corner', new THREE.BufferAttribute(new Float32Array([-1, 0, 1, 0, -1, 1, 1, 1]), 2));
    g.setIndex([0, 1, 2, 2, 1, 3]);
    var lane = new Float32Array(n), seed = new Float32Array(n * 4);
    for (var i = 0; i < n; i++) {
      var k = i % TR_PER; lane[i] = Math.floor(i / TR_PER);
      seed[i * 4] = HDR ? hash('trp' + i) : (k + 0.4 * hash('trp' + i)) / TR_PER;   // position phase (HDR: random - a stream of stars, not a dashed line)
      seed[i * 4 + 1] = hash('trl' + i);                           // trail length jitter
      seed[i * 4 + 2] = hash('trv' + i);                           // visibility rank (density mask), decorrelated from position
      seed[i * 4 + 3] = 0.75 + 0.5 * hash('trw' + i);              // width jitter
    }
    g.setAttribute('aLane', new THREE.InstancedBufferAttribute(lane, 1));
    g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 4));
    g.instanceCount = n;
    var m = new THREE.Mesh(g, trMat); m.frustumCulled = false; m.renderOrder = 4; m.visible = false; scene.add(m); TR.mesh = m;
  })();
  // the lane roads: one faint line per lane, so a lane reads between its particles (rebuilt when the lane set changes)
  var TR_SEG = 28, trRoadPos = new Float32Array(TR_MAXL * TR_SEG * 6), trRoadCol = new Float32Array(TR_MAXL * TR_SEG * 6);
  var trRoadGeo = new THREE.BufferGeometry();
  trRoadGeo.setAttribute('position', new THREE.BufferAttribute(trRoadPos, 3)); trRoadGeo.setAttribute('color', new THREE.BufferAttribute(trRoadCol, 3));
  trRoadGeo.attributes.color.setUsage(THREE.DynamicDrawUsage); trRoadGeo.setDrawRange(0, 0);
  var trRoads = new THREE.LineSegments(trRoadGeo, hudLineMat(0xffffff, 1, true)); trRoads.frustumCulled = false; scene.add(trRoads);
  /* STREAM GLOW (2026-10-08b, docs/contracts.md "traffic lanes woven through"): what the eye reads as a real stream between two
     galaxies is a tidal stream - a soft luminous band of light, not a hairline. Every lane gets a ribbon of gaussian cross-
     section along its curve (one instanced draw: lane x segment quads, built in screen space like the streaks), its WIDTH
     the lane's log-scaled rate (the legend's "lane width = rate"), its brightness the same intensity x fade x emphasis the
     road line carries; the particles flow inside it. Additive (One/One), HDR, HUD keep-out like the streaks. */
  var trRibMat = new THREE.ShaderMaterial({
    uniforms: { uL: { value: TR_U }, uPR: U_PR, uRes: { value: new THREE.Vector2(1, 1) }, uPxK: { value: 1 }, uHud: U_HUD, uK: { value: 1 } },
    vertexShader: [
      HUD_GLSL,
      'uniform vec4 uL[' + (TR_MAXL * 5) + ']; uniform float uPR, uPxK, uK; uniform vec2 uRes;',
      'attribute vec2 corner; attribute float aLane; attribute float aSeg;',
      'varying float vX; varying vec3 vC; varying float vA;',
      'vec3 bez(vec3 a, vec3 b, vec3 c, vec3 d, float t){ float u = 1.0 - t; return u*u*u*a + 3.0*u*u*t*b + 3.0*u*t*t*c + t*t*t*d; }',
      'void main(){',
      '  int li = int(aLane + 0.5) * 5;',
      '  vec4 L0 = uL[li]; vec4 L1 = uL[li + 1]; vec4 L2 = uL[li + 2]; vec4 L3 = uL[li + 3]; vec4 L4 = uL[li + 4];',
      '  float u = L1.w, live = L2.w; vX = corner.x; vC = L4.rgb; vA = 0.0; gl_Position = vec4(0.0, 0.0, 2.0, 1.0);',
      '  if (live < 0.003) return;',
      '  float t0 = aSeg / ' + TR_SEG.toFixed(1) + ', t1 = (aSeg + 1.0) / ' + TR_SEG.toFixed(1) + ', t = mix(t0, t1, corner.y);',
      '  vec4 h = projectionMatrix * modelViewMatrix * vec4(bez(L0.xyz, L1.xyz, L2.xyz, L3.xyz, t), 1.0);',
      '  vec4 a = projectionMatrix * modelViewMatrix * vec4(bez(L0.xyz, L1.xyz, L2.xyz, L3.xyz, t0), 1.0);',
      '  vec4 b = projectionMatrix * modelViewMatrix * vec4(bez(L0.xyz, L1.xyz, L2.xyz, L3.xyz, t1), 1.0);',
      '  if (a.w < 1.0 || b.w < 1.0) return;',
      '  vec2 d = (b.xy / b.w - a.xy / a.w) * uRes * 0.5; vec2 nrm = normalize(vec2(-d.y, d.x) + vec2(0.0, 0.0001));',
      '  float w = clamp((4.0 + 12.0 * u) * uPxK / h.w, 1.5 * uPR, 18.0 * uPR);',      // world-width stream, in device px
      '  vec2 p = h.xy / h.w + nrm * corner.x * w / (uRes * 0.5);',
      '  gl_Position = vec4(p * h.w, h.z, h.w);',
      '  float ends = smoothstep(0.0, 0.07, t) * (1.0 - smoothstep(0.93, 1.0, t));',
      '  vA = live * ends * (0.045 + 0.09 * u) * uK * hudFade(h.xy / h.w) * smoothstep(60.0, 260.0, h.w); }'
    ].join('\n'),
    fragmentShader: 'varying float vX; varying vec3 vC; varying float vA; void main(){ float a = vA * exp(-vX * vX * 2.6); if (a < 0.0015) discard; gl_FragColor = vec4(vC * a, a); }',
    side: THREE.DoubleSide, transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor
  });
  (function () {
    if (!HDR) return;
    var g = new THREE.InstancedBufferGeometry(), n = TR_MAXL * TR_SEG;
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
    g.setAttribute('corner', new THREE.BufferAttribute(new Float32Array([-1, 0, 1, 0, -1, 1, 1, 1]), 2));
    g.setIndex([0, 1, 2, 2, 1, 3]);
    var lane = new Float32Array(n), seg = new Float32Array(n);
    for (var i = 0; i < n; i++) { lane[i] = Math.floor(i / TR_SEG); seg[i] = i % TR_SEG; }
    g.setAttribute('aLane', new THREE.InstancedBufferAttribute(lane, 1)); g.setAttribute('aSeg', new THREE.InstancedBufferAttribute(seg, 1));
    g.instanceCount = n;
    var m = new THREE.Mesh(g, trRibMat); m.frustumCulled = false; m.renderOrder = 3; m.visible = false; scene.add(m); TR.rib = m;
  })();
  // the top pairs' labels at the overview: rate + kind, one line (§7), placed by the shared slot pass (labelsTick)
  for (var tli = 0; tli < 6; tli++) { var LT = mkLabel('flow', '<b></b><span></span>'); LT.on = false; LT.centered = true; LT.slotR = 0; TR.labels.push(LT); }
  (function () { TR.labels.forEach(function (L) { labels.splice(labels.indexOf(L), 1); }); var at = labels.indexOf(L_home) + 1; Array.prototype.splice.apply(labels, [at, 0].concat(TR.labels)); })();
  function trU(bps) { var u = clamp((Math.log10(Math.max(1, +bps || 0)) - 3) / 6, 0, 1); return Math.round(u * 4) / 4 * 0.86 + 0.14 * (u > 0 ? 1 : 0); }
  // where a system's lanes start: the galaxy core, the gateway (network core), a site's centre; the home clients' lanes
  // leave the home device ring on the side facing the other end (computed in NET's frame, which does not spin)
  var _ta = new THREE.Vector3(), _tb = new THREE.Vector3();
  function trAnchor(sid, other, out) {
    if (sid === '__sun') { out.copy(other).sub(SUN).normalize().multiplyScalar(SUN_R * 1.05).add(SUN); return out; }
    var F = UNI.frames[sid]; if (!F) return null;
    if (F.kind === 'galaxy') return out.copy(F.gal.world);
    if (F.kind === 'network') return out.copy(NET_C);
    if (F.kind === 'clients') {
      _ta.copy(other); NET.worldToLocal(_ta); _ta.y = 0; if (_ta.lengthSq() < 400) _ta.set(0.45, 0, 1);   // core <-> home: the front of the ring
      _ta.normalize().multiplyScalar((NETD.R_DEV[0] + NETD.R_DEV[1]) / 2); return out.copy(_ta).applyMatrix4(NET.matrixWorld);
    }
    return out.copy(F.center);
  }
  function trCenter(sid) { if (sid === '__sun') return SUN; var F = UNI.frames[sid]; if (!F) return null; return F.kind === 'galaxy' ? F.gal.world : isNetF(F) ? NET_C : F.center; }
  // the existing curves a lane rides when the relation is the same (rockets and their exhaust keep flying inside it)
  function trFixedCurve(a, b) {
    var na = UNI.frames[a], nb = UNI.frames[b], ga = na && na.kind === 'galaxy' && na.gal.nd.id, gb = nb && nb.kind === 'galaxy' && nb.gal.nd.id;
    if (N_NODES > 1 && ga && gb && ((ga === NA.id && gb === NB.id) || (ga === NB.id && gb === NA.id))) return CURVES.bridge;
    if (na && na.kind === 'network' && gb && UP_FAM[gb]) return CURVES[UP_FAM[gb]];
    if (na && na.kind === 'network' && b === '__sun') return CURVES.wan_out;
    return null;
  }
  var _tsv = new THREE.Vector3();
  function trGeometry(L) {
    var A = trCenter(L.a), B = trCenter(L.b); if (!A || !B) return false;
    if (!trAnchor(L.a, B, L.p0) || !trAnchor(L.b, A, L.p3)) return false;
    var fc = trFixedCurve(L.a, L.b);
    if (fc) { L.p0.copy(fc.v0); L.p1.copy(fc.v1); L.p2.copy(fc.v2); L.p3.copy(fc.v3); }
    else {
      _ta.subVectors(L.p3, L.p0); var len = _ta.length(), lift = clamp(len * 0.24, 40, 260), spl = (hash(L.pair) - 0.5) * 0.22 * len;
      _tsv.crossVectors(_ta, _UP); if (_tsv.lengthSq() < 1e-6) _tsv.set(1, 0, 0); _tsv.normalize();
      L.p1.copy(L.p0).addScaledVector(_ta, 0.25).addScaledVector(_UP, lift).addScaledVector(_tsv, spl);
      L.p2.copy(L.p0).addScaledVector(_ta, 0.75).addScaledVector(_UP, lift).addScaledVector(_tsv, spl);
    }
    // two measured directions: two lanes side by side (forward on the right of a -> b), a touch apart vertically too
    if (L.side) {
      _ta.subVectors(L.p3, L.p0); _tsv.crossVectors(_ta, _UP); if (_tsv.lengthSq() < 1e-6) _tsv.set(1, 0, 0); _tsv.normalize();
      var off = clamp(_ta.length() * 0.016, 6, 14) * L.side;
      [L.p0, L.p1, L.p2, L.p3].forEach(function (v) { v.addScaledVector(_tsv, off).addScaledVector(_UP, off * 0.35); });
    }
    // length of the curve (chord sum over 16 samples) for the speed and the trail
    var len2 = 0, pv = _tb.copy(L.p0);
    for (var i = 1; i <= 16; i++) { var t = i / 16, u = 1 - t; _ta.set(0, 0, 0).addScaledVector(L.p0, u * u * u).addScaledVector(L.p1, 3 * u * u * t).addScaledVector(L.p2, 3 * u * t * t).addScaledVector(L.p3, t * t * t); len2 += _ta.distanceTo(pv); pv.copy(_ta); }
    L.len = Math.max(1, len2); L.geoOk = true; return true;
  }
  function trLane(key, pair, a, b, mode, side, bps, kind, partial) {
    var L = TR.lanes[key];
    if (!L) {
      var slot = TR.slots.indexOf(null); if (slot < 0) return null;
      L = TR.lanes[key] = { key: key, pair: pair, a: a, b: b, slot: slot, s: hash(key), u: 0, live: 0, p0: new THREE.Vector3(), p1: new THREE.Vector3(), p2: new THREE.Vector3(), p3: new THREE.Vector3(), len: 1, col: new THREE.Color() };
      TR.slots[slot] = L;
    }
    // a flow-layer pair is a LOWER BOUND with no direction (docs/contracts.md): one centred lane, drawn quieter
    L.mode = mode; L.side = side; L.bps = bps; L.partial = !!partial; L.uT = trU(bps) * (partial ? 0.8 : 1); L.kind = TR_KIND[kind] ? kind : 'mixed'; L.col.set(TR_KIND[L.kind]); L.liveT = 1; L.seen = TR.ver;
    trGeometry(L); return L;
  }
  // a new /api/universe document: rebuild the lane SET (eased: lanes fade in / out, intensities glide)
  function trafficApply(tr) {
    TR.ver = (TR.ver || 0) + 1;
    var pairs = [], covered = {};
    if (tr && (tr.pairs || tr.wan)) {
      (tr.pairs || []).forEach(function (p) {
        if (!p || !p.a || !p.b || !(+p.bps > 0) || !UNI.frames[p.a] || !UNI.frames[p.b]) return;
        var pk = p.a + '|' + p.b, kind = p.kind || 'mixed', part = !!p.partial || p.layer === 'flow', dir = !part && p.a_to_b_bps != null && p.b_to_a_bps != null;
        if (dir) {
          if (+p.a_to_b_bps > 0) trLane(pk + '>', pk, p.a, p.b, 1, 1, +p.a_to_b_bps, kind);
          if (+p.b_to_a_bps > 0) trLane(pk + '<', pk, p.a, p.b, -1, -1, +p.b_to_a_bps, kind);
        } else trLane(pk + '~', pk, p.a, p.b, 0, 0, +p.bps, kind, part);
        pairs.push({ key: pk, a: p.a, b: p.b, bps: +p.bps, kind: kind, dir: dir, partial: part });
        var fc = trFixedCurve(p.a, p.b); if (fc === CURVES.bridge) covered.bridge = +p.bps; else Object.keys(UP_FAM).forEach(function (id) { if (fc === CURVES[UP_FAM[id]]) covered[UP_FAM[id]] = +p.bps; });
      });
      (tr.wan || []).forEach(function (w) {
        if (!w || !UNI.frames[w.system]) return;
        var pk = w.system + '|__sun', part = !!w.partial || w.layer === 'flow', dir = !part && w.in_bps != null && w.out_bps != null;
        var inb = +w.in_bps || 0, outb = +w.out_bps || 0, tot = +w.bps || inb + outb, core = UNI.frames[w.system].kind === 'network';
        if (dir) { if (outb > 0) trLane(pk + '>', pk, w.system, '__sun', 1, 1, outb, 'wan'); if (inb > 0) trLane(pk + '<', pk, w.system, '__sun', -1, -1, inb, 'wan'); }
        else if (tot > 0) trLane(pk + '~', pk, w.system, '__sun', 0, 0, tot, 'wan', part);
        // the core's WAN is the Internet landmark's own number: it never takes a stream label
        if (tot > 0) pairs.push({ key: pk, a: w.system, b: '__sun', bps: tot, kind: 'wan', dir: dir, partial: part, noLabel: core });
        if (core) covered.wan = 1;
      });
    }
    Object.keys(TR.lanes).forEach(function (k) { if (TR.lanes[k].seen !== TR.ver) TR.lanes[k].liveT = 0; });
    TR.on = Object.keys(TR.lanes).length > 0; TR.pairs = pairs.sort(function (x, y) { return y.bps - x.bps; });
    // the old bead families that drew the same relation stop auto-spawning (the rockets keep flying, at the measured
    // rate); with no traffic in the document they come straight back
    ['bridge'].concat(Object.keys(UP_FAM).map(function (id) { return UP_FAM[id]; })).forEach(function (f) { var c = covered[f] != null; FAM[f].rate = c ? 0 : null; FAM[f].covered = c; if (c) FAM[f].bps = covered[f]; });
    FAM.bridge_r.bps = FAM.bridge.bps;
    ['wan_in', 'wan_out'].forEach(function (f) { FAM[f].rate = covered.wan ? 0 : FAM[f].rate0; FAM[f].covered = !!covered.wan; });
    Object.keys(GUIDE_MAT).forEach(function (k) { GUIDE_MAT[k].uniforms.uOp.value = guideOp(k); });
    TR.roadSig = ''; trLegend();
  }
  function guideOp(k) { return FAM[k] && FAM[k].covered ? 0 : 0.07 * (NET_FAM[k] ? NET_VIS : 1); }
  // how much each lane speaks at the current stop: the overview shows every lane; a stop keeps the lanes that touch its
  // subject (quietly at a galaxy close-up, which is about the guests) and all but hides the rest
  var TR_FOCUS = { sys: {}, mode: '' };
  function trFocus() {
    var m = SC.active ? 'show' : LABEL.mode, f = TR_FOCUS; f.sys = {}; f.mode = m;
    if (m === 'host' || m === 'blk') { UNI.frameList.forEach(function (k) { var F = UNI.frames[k]; if (F.kind === 'galaxy' && F.gal.nd.id === LABEL.node) f.sys[k] = 1; }); }
    else if (m === 'sys') f.sys[LABEL.id] = 1;
    else if (m === 'fabric' || m === 'wired' || m === 'ap') { f.sys[UNI.netCore] = 1; f.sys[UNI.netClients] = 1; }
    else if (m === 'wan') { f.sys.__sun = 1; f.sys[UNI.netCore] = 1; }
    else if (m === 'stream' && LABEL.id) { var sp = LABEL.id.split('>'); f.pair = trPairKey('sys:' + sp[0], 'sys:' + sp[1]); }
  }
  function trLaneEmph(L) {
    var m = TR_FOCUS.mode;
    if (m === 'over' || m === 'show') return m === 'over' ? 1 : 0.9;
    if (m === 'stream') return L.pair === TR_FOCUS.pair ? 1 : 0.12;          // the ride: its own lane, the rest a backdrop
    var touch = TR_FOCUS.sys[L.a] || TR_FOCUS.sys[L.b];
    if (m === 'host' || m === 'blk') return touch ? 0.22 : 0.04;
    if (m === 'sys') { var F = UNI.frames[LABEL.id]; return touch ? (F && F.kind === 'galaxy' ? 0.3 : 0.75) : 0.08; }
    if (m === 'fabric' || m === 'wired' || m === 'ap' || m === 'wan') return touch ? 0.55 : 0.12;
    return 0.25;                                            // edge / audience / threat cuts: the estate is a backdrop
  }
  function trafficTick(dt) {
    if (!TR.on) { if (TR.mesh.visible) TR.mesh.visible = false; if (TR.rib) TR.rib.visible = false; trRoadGeo.setDrawRange(0, 0); return; }
    trFocus(); var kE = 1 - Math.exp(-dt / 0.6);
    var kU = 1 - Math.exp(-dt / 1.5), kIn = 1 - Math.exp(-dt / 1.0), kOut = 1 - Math.exp(-dt / 1.6), any = false, roadSig = '';
    for (var i = 0; i < TR_MAXL; i++) {
      var L = TR.slots[i], j = i * 20;
      if (!L) { TR_U[j + 11] = 0; continue; }
      L.u += (L.uT - L.u) * kU; L.live += (L.liveT - L.live) * (L.liveT > L.live ? kIn : kOut);
      L.fe = L.fe == null ? trLaneEmph(L) : L.fe + (trLaneEmph(L) - L.fe) * kE;
      if (L.liveT === 0 && L.live < 0.01) { delete TR.lanes[L.key]; TR.slots[i] = null; TR_U[j + 11] = 0; TR.roadSig = 'x'; continue; }
      var speed = 70 + 60 * L.u;                                           // world units / s: a narrow band (rate is width + density)
      L.s = (L.s + dt * speed / L.len) % 1000;
      TR_U[j] = L.p0.x; TR_U[j + 1] = L.p0.y; TR_U[j + 2] = L.p0.z; TR_U[j + 3] = L.s;
      TR_U[j + 4] = L.p1.x; TR_U[j + 5] = L.p1.y; TR_U[j + 6] = L.p1.z; TR_U[j + 7] = L.u;
      TR_U[j + 8] = L.p2.x; TR_U[j + 9] = L.p2.y; TR_U[j + 10] = L.p2.z; TR_U[j + 11] = L.live * L.fe * (L.partial ? 0.65 : 1);
      TR_U[j + 12] = L.p3.x; TR_U[j + 13] = L.p3.y; TR_U[j + 14] = L.p3.z; TR_U[j + 15] = L.mode;
      TR_U[j + 16] = L.col.r; TR_U[j + 17] = L.col.g; TR_U[j + 18] = L.col.b; TR_U[j + 19] = L.len;
      any = true; roadSig += L.key + ',';
    }
    TR.mesh.visible = any; if (TR.rib) TR.rib.visible = any;
    var rideL = LABEL.mode === 'stream' && D.toSubj && D.toSubj.kind === 'stream' ? streamLane(D.toSubj) : null; trMat.uniforms.uRide.value = rideL ? rideL.L.slot : -1;
    var db = rndr.getDrawingBufferSize(_trSz); trMat.uniforms.uRes.value.set(db.x, db.y); trMat.uniforms.uPxK.value = db.y / (2 * Math.tan(cam.fov * Math.PI / 360));
    trRibMat.uniforms.uRes.value.set(db.x, db.y); trRibMat.uniforms.uPxK.value = trMat.uniforms.uPxK.value;
    // roads: geometry when the lane set changes, colour (intensity x fade x emphasis) every frame
    if (roadSig !== TR.roadSig) {
      TR.roadSig = roadSig; var n = 0;
      for (var q = 0; q < TR_MAXL; q++) {
        var R = TR.slots[q]; if (!R) continue;
        for (var sg = 0; sg < TR_SEG; sg++) {
          bezAt(R, sg / TR_SEG, _ta); bezAt(R, (sg + 1) / TR_SEG, _tb);
          var o = (n * TR_SEG + sg) * 6; trRoadPos[o] = _ta.x; trRoadPos[o + 1] = _ta.y; trRoadPos[o + 2] = _ta.z; trRoadPos[o + 3] = _tb.x; trRoadPos[o + 4] = _tb.y; trRoadPos[o + 5] = _tb.z;
        }
        R.road = n++;
      }
      trRoadGeo.attributes.position.needsUpdate = true; trRoadGeo.setDrawRange(0, n * TR_SEG * 2); TR.roadN = n;
    }
    for (var r = 0; r < TR_MAXL; r++) {
      var RL = TR.slots[r]; if (!RL || RL.road == null) continue;
      var kk = (0.035 + 0.075 * RL.u) * RL.live * RL.fe * (RL.partial ? 0.65 : 1);
      for (var sg2 = 0; sg2 < TR_SEG; sg2++) {
        var e = Math.min(1, Math.min(sg2, TR_SEG - 1 - sg2) / 3), o2 = (RL.road * TR_SEG + sg2) * 6, kc = kk * (0.35 + 0.65 * e);
        trRoadCol[o2] = trRoadCol[o2 + 3] = RL.col.r * kc; trRoadCol[o2 + 1] = trRoadCol[o2 + 4] = RL.col.g * kc; trRoadCol[o2 + 2] = trRoadCol[o2 + 5] = RL.col.b * kc;
      }
    }
    if (TR.roadN) trRoadGeo.attributes.color.needsUpdate = true;
    trLabelsTick();
  }
  var _trSz = new THREE.Vector2();
  function bezAt(L, t, out) { var u = 1 - t; return out.set(0, 0, 0).addScaledVector(L.p0, u * u * u).addScaledVector(L.p1, 3 * u * u * t).addScaledVector(L.p2, 3 * u * t * t).addScaledVector(L.p3, t * t * t); }
  // the overview names the top three pairs: "4.6 Mb/s · Storage", anchored on the busier lane's apex
  function trLabelsTick() {
    var on = (LABEL.mode === 'over' || LABEL.mode === 'stream') && !SC.active && TR.on, cand = TR.pairs.filter(function (p) { return !p.noLabel && (LABEL.mode !== 'stream' || p.key === TR_FOCUS.pair); });
    /* the top three pairs, plus every galaxy's own lane to the core (a new node's lane always keeps its rate, even when it
       is the quietest): galaxy <-> core pairs first, then the busiest others, up to max(3, galaxies + 1), at most 6 */
    if (LABEL.mode === 'over' && NODES.length > 2) {
      var gc = [], rest = [];
      for (var ci = 0; ci < cand.length; ci++) { var Q = cand[ci], ga = UNI.frames[Q.a], gb = UNI.frames[Q.b];
        if ((Q.a === 'sys:core' && gb && gb.kind === 'galaxy') || (Q.b === 'sys:core' && ga && ga.kind === 'galaxy')) gc.push(Q); else rest.push(Q); }
      cand = gc.concat(rest.slice(0, Math.max(0, Math.max(3, NODES.length + 1) - gc.length)));
    }
    var nLab = Math.min(TR.labels.length, cand.length);
    for (var i = 0; i < TR.labels.length; i++) {
      var L = TR.labels[i], P = on && i < nLab ? cand[i] : null;
      if (!P) { L.on = false; continue; }
      var best = null; Object.keys(TR.lanes).forEach(function (k) { var X = TR.lanes[k]; if (X.pair === P.key && X.live > 0.3 && (!best || X.bps > best.bps)) best = X; });
      if (!best) { L.on = false; continue; }
      L.on = true; bezAt(best, 0.5, L.pos); L.slotPos = L.pos;
      setLabelText(L, (P.partial ? '≥ ' : '') + fmtRate(P.bps) + ' · ' + TR_KIND_NAME[P.kind], '');   // a flow-layer pair is "at least"
      if (L._k !== P.kind) { L._k = P.kind; L.el.style.setProperty('--k', TR_KIND[P.kind]); }
    }
  }
  // the overview legend row: what the lanes mean (kinds present, width = rate, two lanes = both directions measured)
  function trLegend() {
    var kinds = {}; TR.pairs.forEach(function (p) { kinds[p.kind] = 1; });
    var sig = Object.keys(kinds).sort().join(','); if (sig === TR.legendSig) return; TR.legendSig = sig;
    var el = $('legend-tr'); if (!el) return;
    el.innerHTML = '<em>Traffic</em>' + Object.keys(kinds).sort().map(function (k) { return '<span><i class="ln" style="background:' + TR_KIND[k] + '"></i>' + TR_KIND_NAME[k] + '</span>'; }).join('');
    el.classList.toggle('has', !!sig); var n2 = $('legend-tr2'); if (n2) n2.classList.toggle('has', !!sig);
  }

  /* ============================== DETAIL CARD (docs/contracts.md, 2026-10-08) ==============================
     Click / tap a body: ONE clean card with what the scene label leaves out (full name, class, status, IP, vendor,
     switch port, rates, latency, role). An empty click or 12 s closes it; it follows its body while open. The
     director is never touched: the TV stays in sync with the wall. During a tour hold the card also opens by itself
     for a subject the HUD panels do not already describe (a remote site, a switch's wired / wireless stop). */
  var DC = { on: false, kind: '', ref: null, until: 0, auto: false, key: '', W: 300 };
  var _dp = new THREE.Vector3();
  // a card that opened by itself (tour hold) never shows addresses: an IP only appears when a host is clicked
  function dcRows(rows) { return rows.filter(function (r) { return r && r[1] !== '' && r[1] != null && !(DC.auto && (r[0] === 'IP' || r[0] === 'MAC')); }).slice(0, 9).map(function (r) { return hRow(r[0], r[1], r[2] || ''); }).join(''); }
  function dcRate(m) { return (m.rx_bps != null || m.tx_bps != null) ? fmtRate(m.rx_bps || 0) + unit(' in') + ' · ' + fmtRate(m.tx_bps || 0) + unit(' out') : ''; }
  function dcBody(R) {
    var b = R.b, m = b.m || {}, P = recOf(b.parent), dn = b.status === 'down';
    var port = m.uplink_port != null ? ' · port ' + m.uplink_port : m.port != null ? ' · port ' + m.port : '';
    var dw = dn ? (b.down_why === 'stopped' ? 'Stopped' : b.down_why === 'gone' ? 'Not seen' : 'Down') : '';
    var st = dn ? (b.last_seen ? dw + ' · last seen ' + agoStr(b.last_seen) : dw) : b.status === 'unknown' ? 'Unknown' : 'Up';
    return { title: b.label || b.id, meta: cap1(String(b['class'] || 'device').replace('_', ' ')) + (b.lab ? ' · lab' : ''), rows: [
      ['Status', esc(st), bodyOffline(b) ? 'crit' : ''], ['IP', esc(m.ip || '')], ['Vendor', esc(m.vendor || '')],
      ['Connected to', P ? esc((shortName(P.b) || P.b.label || '') + port) : ''], ['Traffic', dcRate(m)],
      ['Latency', m.rtt_ms != null ? (+m.rtt_ms).toFixed(1) + unit(' ms') : ''], ['CPU', m.cpu != null ? Math.round(+m.cpu * 100) + unit('%') : ''],
      ['System', esc(sysName(R.F) || '')], ['MAC', /^mac:/.test(b.id) ? '<span style="font-family:ui-monospace,monospace;font-size:12px">' + esc(b.id.slice(4)) + '</span>' : '']] };
  }
  function dcGuest(g) {
    var R = g._uid && UNI.recs[g._uid], m = (R && R.b.m) || {}, up = g.status === 'running';
    return { title: g.name, meta: (g.type === 'qemu' ? 'VM ' : 'Container ') + g.id, rows: [
      ['Status', up ? 'Running' : esc(cap1(g.status || 'stopped')), up ? '' : 'crit'], ['Node', esc(nodeName(g.node))], ['Category', esc(CAT_NAME[g.cat] || g.cat || '')],
      ['CPU', (g.cpu || 0).toFixed(0) + unit('%')], ['Memory', ((g.mem || 0) / 1073741824).toFixed(1) + ' / ' + fmtGB(g.maxmem || 0) + unit(' GB')],
      ['IP', esc(m.ip || '')], ['Traffic', dcRate(m)], ['Latency', m.rtt_ms != null ? (+m.rtt_ms).toFixed(1) + unit(' ms') : '']] };
  }
  function dcGalaxy(id) {
    var nd = S.nodes.filter(function (x) { return x.node === id; })[0] || {}, gl = guestsOf(id);
    var peers = TR.pairs.filter(function (p) { var F = UNI.frames[p.a === '__sun' ? p.b : p.a], F2 = UNI.frames[p.b]; return (F && F.gal && F.gal.nd.id === id) || (F2 && F2.gal && F2.gal.nd.id === id); }).slice(0, 2);
    return { title: nodeName(id), meta: 'Proxmox node', rows: [
      ['Guests', gl.filter(function (g) { return g.status === 'running'; }).length + ' / ' + gl.length + unit(' running')], ['CPU', num(nd.cpu, 0) + unit('%')],
      ['Memory', fmtGB(nd.mem_used || 0) + ' / ' + fmtGB(nd.mem_total || 0) + unit(' GB')], ['Load', num(nd.load, 1) + ' / ' + (nd.cores || '—') + unit(' cores')],
      ['Uptime', nd.uptime ? Math.round(nd.uptime / 86400) + unit(' d') : '']].concat(peers.map(function (p) { return ['Traffic', fmtRate(p.bps) + ' · ' + TR_KIND_NAME[p.kind]]; })) };
  }
  function dcSite(F) {
    var c = sysCount(F), hub = F.hubRec && F.hubRec.b, pr = TR.pairs.filter(function (p) { return p.a === F.id || p.b === F.id; })[0];
    return { title: sysName(F), meta: 'Remote site', rows: [['Devices', c.n + (c.dn ? ' · ' + c.dn + ' down' : ' · all up'), c.dn ? 'warn' : ''],
      ['Hub', hub ? esc(shortName(hub) || hub.label) : ''], ['Hub IP', hub && hub.m && hub.m.ip ? esc(hub.m.ip) : ''],
      ['Link', pr ? fmtRate(pr.bps) + ' · ' + TR_KIND_NAME[pr.kind] : 'not measured']] };
  }
  function dcInternet() {
    return { title: 'Internet', meta: 'WAN uplink', rows: [['Download', fmtRate(FAM.wan_in.bps)], ['Upload', fmtRate(FAM.wan_out.bps)],
      ['Latency', S.unifi && S.unifi.latency != null ? S.unifi.latency + unit(' ms') : ''], ['Viewers', edgeInfo.audience ? edgeInfo.viewers + unit(' now') : '']] };
  }
  function dcContent() {
    if (DC.kind === 'body') return UNI.recs[DC.ref.b.id] === DC.ref ? dcBody(DC.ref) : null;
    if (DC.kind === 'guest') return dcGuest(DC.ref);
    if (DC.kind === 'galaxy') return galaxies[DC.ref] ? dcGalaxy(DC.ref) : null;
    if (DC.kind === 'site') return dcSite(DC.ref);
    if (DC.kind === 'sun') return dcInternet();
    return null;
  }
  function dcWorld(out) {
    if (DC.kind === 'body') return out.copy(DC.ref.wp);
    if (DC.kind === 'guest') { var g = DC.ref, gal = galaxies[g.node]; if (!g._pos || !gal) return null; return gal.G.localToWorld(out.fromArray(g._pos)); }
    if (DC.kind === 'galaxy') return out.copy(galaxies[DC.ref].world);
    if (DC.kind === 'site') return out.copy(DC.ref.center);
    if (DC.kind === 'sun') return out.copy(SUN);
    return null;
  }
  function dcOpen(kind, ref, auto) {
    DC.on = true; DC.kind = kind; DC.ref = ref; DC.auto = !!auto; DC.until = performance.now() + 12000; DC.html = '';
    dcRender(); $('detail').classList.add('on'); $('pick').classList.toggle('on', !DC.auto);   // the ring marks a CLICKED body only
  }
  function dcClose() { if (!DC.on) return; DC.on = false; DC.ref = null; DC.key = ''; $('detail').classList.remove('on'); $('pick').classList.remove('on'); }
  function dcRender() {
    var c = dcContent(); if (!c) { dcClose(); return; }
    var html = '<div class="ph"><b>' + esc(c.title) + '</b><em>' + esc(c.meta) + '</em></div><div class="rows">' + dcRows(c.rows) + '</div>';
    if (html !== DC.html) { DC.html = html; $('detail').innerHTML = html; DC.h = 0; }
  }
  // what is under a click: the nearest projected body within ~28 px (a galaxy core or a site counts within its disc)
  function dcPick(px, py) {
    var best = null, bd = 28 * 28, W = innerWidth, H = innerHeight;
    function test(p, kind, ref, r) {
      _dp.copy(p).project(cam); if (_dp.z >= 1 || _dp.z <= -1) return;
      var x = (_dp.x * 0.5 + 0.5) * W, y = (-_dp.y * 0.5 + 0.5) * H, d = (x - px) * (x - px) + (y - py) * (y - py), lim = Math.max(bd, (r || 0) * (r || 0));
      if (d < lim && (!best || d < best.d)) { best = { kind: kind, ref: ref, d: d }; if (!r) bd = d; }
    }
    for (var i = 0; i < UNI.n; i++) { var P = UNI.pool[i]; if (P && !P.hub && P.F && (P.F.vis == null || P.F.vis > 0.5)) test(P.wp, 'body', P); }
    Object.keys(UNI.recs).forEach(function (id) { var R = UNI.recs[id]; if (R.role === 'planet') test(R.wp, 'body', R); });
    NODES.forEach(function (n) { var gal = galaxies[n.id]; gal.list.forEach(function (g) { if (g._pos) test(gal.G.localToWorld(_ta.fromArray(g._pos)), 'guest', g); }); });
    if (!best) {
      NODES.forEach(function (n) { if (!n.gone) test(galaxies[n.id].world, 'galaxy', n.id, 60); });
      uniSites().forEach(function (F) { test(F.center, 'site', F, 50); });
      test(SUN, 'sun', null, 50);
    }
    return best;
  }
  addEventListener('pointerdown', function (e) {
    if (e.target && e.target.closest && e.target.closest('#detail')) return;
    var hit = dcPick(e.clientX, e.clientY);
    if (hit) dcOpen(hit.kind, hit.ref, false); else dcClose();
  });
  var mouseT = 0;
  addEventListener('mousemove', function () { document.body.classList.add('mouse'); clearTimeout(mouseT); mouseT = setTimeout(function () { document.body.classList.remove('mouse'); }, 3000); });
  // during a sync / free hold: a site or a switch stop opens its card (closed again by the next leg)
  function dcAutoTick() {
    var holding = (D.mode === 'sync' ? !D.inTravel : D.t >= 1) && !SC.active && !TC.on;
    var subj = D.subject || {}, want = null;
    if (SC.active) { if (SC.spot && galaxies[SC.spot[1]]) want = [SC.spot[0], SC.spot[1], 'sc:' + SC.spot[1]]; holding = !!want; }
    else if (holding && D.hold > 1.2) {
      if (subj.kind === 'sys' && UNI.frames[subj.id] && UNI.frames[subj.id].kind === 'site') want = ['site', UNI.frames[subj.id], 'sys:' + subj.id];
      else if ((subj.kind === 'wired' || subj.kind === 'ap') && UNI.on) {
        var home = UNI.frames[UNI.netClients], R = recOf(subj.id);
        if (R && !(home && (home.sys.topo === subj.id || home.sys.anchor === subj.id))) want = ['body', R, subj.kind + ':' + subj.id];
      }
    }
    if (want) { if (!DC.on || (DC.auto && DC.key !== want[2])) { dcOpen(want[0], want[1], true); DC.key = want[2]; } DC.until = performance.now() + 2000; }
    else if (DC.on && DC.auto && !holding) dcClose();
  }
  function dcTick() {
    dcAutoTick();
    if (!DC.on) return;
    if (performance.now() > DC.until) { dcClose(); return; }
    if (!dcWorld(_dp)) { dcClose(); return; }
    _dp.project(cam); if (_dp.z >= 1) { dcClose(); return; }
    var W = innerWidth, H = innerHeight, x = (_dp.x * 0.5 + 0.5) * W, y = (-_dp.y * 0.5 + 0.5) * H, el = $('detail');
    var pk = $('pick'), ptx = 'translate3d(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px,0)'; if (pk._tx !== ptx) { pk._tx = ptx; pk.style.transform = ptx; }
    if (!DC.h) DC.h = el.offsetHeight || 180;
    // a card the tour opened docks in the right column under the node card (it never covers the subject); a clicked
    // body's card sits beside it
    var cx = x + 28 + DC.W > W - 24 ? x - 28 - DC.W : x + 28, cy = clamp(y - DC.h / 2, H * HUDZ.top, H * HUDZ.bot - DC.h);
    if (DC.auto) { cx = W - 24 - DC.W; cy = H * HUDZ.cardY1 + 14; }
    var tx = 'translate3d(' + Math.round(cx) + 'px,' + Math.round(cy) + 'px,0)'; if (el._tx !== tx) { el._tx = tx; el.style.left = '0'; el.style.top = '0'; el.style.transform = tx; }
  }
  setInterval(function () { if (DC.on) dcRender(); }, 2000);

  /* ============================== director / shots ============================== */
  // establishing "OVERVIEW" shot, computed live from the bounding sphere of both galaxy
  // cores (+ a fixed envelope margin covering each galaxy's dust arms/haze, which reach well
  // past the core mesh) instead of a hand-picked constant. Verified on screen: the old fixed
  // (0,520,1250)->(0,0,0) shot, fed through the showcase's generic dwellPair() ~30° swing +
  // 0.86x dolly-in, rotated the GPU galaxy clean off the left edge for the back half of THE
  // ESTATE's pan (only the bridge arc + the near core stayed on screen). The distance
  // below is derived straight from the camera's actual vertical FOV so the sphere always
  // lands well inside the middle 80% of the frame, with slack to spare for the hold-orbit
  // sway (directorSyncTick/directorFreeTick) and the ESTATE chapter's own gentle pan.
  var GAL_ENVELOPE_R = 300;
  /* the bounding sphere of the composed pair (one galaxy on a one-node estate); growth galaxies are framed by the fitted
     overview below */
  function overviewBounds() {
    var ga = galaxies[NA.id], gb = galaxies[NB.id], a = ga.world, b = gb.world;
    var c = a.clone().add(b).multiplyScalar(0.5), half = a.distanceTo(b) * 0.5;
    var rA = GAL_ENVELOPE_R + ga.coreR, rB = GAL_ENVELOPE_R + gb.coreR;
    return { c: c, r: half + Math.max(rA, rB) };
  }
  /* GROWTH: with more than the two composed galaxies the overview is FITTED: every galaxy (with its arm envelope), the
     network system and every site, as spheres, inside the safe frame between the HUD bands, from the same elevated
     angle. With only the composed pair it is exactly the approved composition above, untouched. */
  var _ovDir = new THREE.Vector3(0, 0.40, 1).normalize(), _ovR = new THREE.Vector3(), _ovU = new THREE.Vector3(), _ovF = new THREE.Vector3(), _ovP = new THREE.Vector3();
  function fitView(spheres, dir, safe) {
    var c = new THREE.Vector3(); spheres.forEach(function (q) { c.add(q.c); }); c.multiplyScalar(1 / spheres.length);
    var tV = Math.tan((cam.fov * Math.PI / 180) / 2), tH = tV * cam.aspect, d = 1600;
    for (var it = 0; it < 12; it++) {
      _ovP.copy(c).addScaledVector(dir, d); _ovF.copy(dir).negate(); _ovR.crossVectors(_ovF, _UP).normalize(); _ovU.crossVectors(_ovR, _ovF);
      var x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
      for (var i = 0; i < spheres.length; i++) {
        var q = spheres[i]; _mv.subVectors(q.c, _ovP); var z = Math.max(1, _mv.dot(_ovF)), x = _mv.dot(_ovR), y = _mv.dot(_ovU);
        var ry = q.ry || q.r;
        x0 = Math.min(x0, (x - q.r) / (z * tH)); x1 = Math.max(x1, (x + q.r) / (z * tH)); y0 = Math.min(y0, (y - ry) / (z * tV)); y1 = Math.max(y1, (y + ry) / (z * tV));
      }
      c.addScaledVector(_ovR, ((x0 + x1) / 2 - (safe[0] + safe[1]) / 2) * d * tH * 0.9).addScaledVector(_ovU, ((y0 + y1) / 2 - (safe[2] + safe[3]) / 2) * d * tV * 0.9);
      d *= Math.pow(Math.max((x1 - x0) / (safe[1] - safe[0]), (y1 - y0) / (safe[3] - safe[2])), 0.85);
    }
    return { pos: c.clone().addScaledVector(dir, d), look: c };
  }
  /* 2026-10-08b (docs/contracts.md, "when it zooms out i want the screen filled"): EVERY overview is fitted - the galaxies
     (their arm envelope at their scale), the network system and every site, as spheres, into the safe frame between the
     HUD cards, caption and header, from the same elevated angle, filling ~90% of it. The two-galaxy composition is just
     the n = 2 case now (it used to be a fixed 70%-of-width rule that left the frame's corners and bottom empty), and a new
     Proxmox galaxy re-frames it: the hold eases toward the refitted pose (overviewTrack), never a jump. */
  var OV_SAFE = [-0.66, 0.66, -0.74, 0.78];
  function overviewShot() {
    var sp = [];
    // a galaxy is a tilted disc: it projects about 0.6 of its radius vertically from this elevation
    NODES.forEach(function (nd) { if (nd.gone) return; var g = galaxies[nd.id], r = (GAL_ENVELOPE_R * 0.86 + g.coreR) * (nd.scale || 1); sp.push({ c: g.world, r: r, ry: r * 0.62 }); });
    sp.push({ c: NET_C, r: NETD.R_LBL + 10 });
    if (UNI.on) uniSites().forEach(function (F) { sp.push({ c: F.center, r: F.rOut + 30 }); });
    return fitView(sp, _ovDir, OV_SAFE);
  }
  /* holding on an overview: the held pose follows the refitted one (a galaxy joined, a site grew) through a critically damped
     spring (omega 1.5 /s: settles in ~3 s, starts and ends with zero velocity - no jump, no snap at the start); the target is
     refitted 4x a second */
  var OVT = { t: 9, tgt: null, vp: new THREE.Vector3(), vl: new THREE.Vector3(), w: 1.5 }, _ova = new THREE.Vector3();
  function overviewTrack(dt) {
    var subj = D.toSubj || D.subject; if (!subj || subj.kind !== 'over' || !D.toShot || SC.active) { OVT.vp.set(0, 0, 0); OVT.vl.set(0, 0, 0); OVT.tgt = null; return; }
    if ((OVT.t += dt) >= 0.25 || !OVT.tgt) { OVT.t = 0; OVT.tgt = overviewShot(); }
    var w = OVT.w, sh = D.toShot;
    _ova.subVectors(OVT.tgt.pos, sh.pos).multiplyScalar(w * w).addScaledVector(OVT.vp, -2 * w); OVT.vp.addScaledVector(_ova, dt); sh.pos.addScaledVector(OVT.vp, dt);
    _ova.subVectors(OVT.tgt.look, sh.look).multiplyScalar(w * w).addScaledVector(OVT.vl, -2 * w); OVT.vl.addScaledVector(_ova, dt); sh.look.addScaledVector(OVT.vl, dt);
  }
  var SHOTS_STATIC = {
    // WAN looks between the sun and the EDGE core so the third galaxy sits in frame behind/above the sun
    wan: { pos: new THREE.Vector3(430, 240, 640), look: SUN.clone().lerp(EDGE_POS, 0.28) },
    fabric: { pos: fab.gateway.pos.clone().add(new THREE.Vector3(60, 190, 420)), look: fab.gateway.pos.clone() }
  };
  /* one fallback establishing shot per node, derived from its x (the old pair
     at +/-400 reproduces the hand-tuned shots exactly) */
  var SHOTS_NODE = {};
  NODES.forEach(function (n) {
    SHOTS_NODE[n.id] = { pos: new THREE.Vector3(n.x - Math.sign(n.x || -1) * 80, 340, 660),
                         look: new THREE.Vector3(n.x, -10, 0) };
  });
  function parseStop(key) {
    key = key || '';
    if (key.indexOf('over') === 0) return { kind: 'over' };
    if (key === 'wan') return { kind: 'wan' };
    if (key === 'edge') return { kind: 'edge' };
    if (key === 'audience') return { kind: 'audience' };
    if (key === 'fabric') return { kind: 'fabric' };
    if (key.indexOf('asp:') === 0) return { kind: 'asp', id: key };   // §9.2 aspect stop: resolved against our own /api/tour copy
    if (key.indexOf('wired:') === 0) return { kind: 'wired', id: key.slice(6) };
    if (key.indexOf('ap:') === 0) return { kind: 'ap', id: key.slice(3) };
    // the wall's FOLLOW THE STREAM stop (2026-10-08): stream:<from>><to> (system ids without the sys: prefix)
    if (key.indexOf('stream:') === 0) { var sp = key.slice(7).split('>'); return { kind: 'stream', id: key.slice(7), from: 'sys:' + (sp[0] || ''), to: 'sys:' + (sp[1] || '') }; }
    if (key.indexOf('host:pve:') === 0) return { kind: 'host', node: key.slice(9) };
    if (key.indexOf('blk:pve:') === 0) { var p = key.split(':'); return { kind: 'blk', node: p[2], cat: p[3] }; }
    // universe-mode wall stops: "sys:<system id>" (system ids already carry the prefix; tolerate a doubled one)
    if (key.indexOf('sys:') === 0) { var sid = UNI.frames[key] ? key : (UNI.frames[key.slice(4)] ? key.slice(4) : key); return { kind: 'sys', id: sid }; }
    return { kind: 'over' };
  }
  function categoryCluster(node, cat) {
    var gal = galaxies[node]; if (!gal) return null;
    var pts = gal.list.filter(function (g) { return g.cat === cat && g._pos; });
    if (!pts.length) return null;
    var c = new THREE.Vector3(); pts.forEach(function (g) { c.x += g._pos[0]; c.y += g._pos[1]; c.z += g._pos[2]; });
    c.multiplyScalar(1 / pts.length);
    var r = 20;
    pts.forEach(function (g) { var d = Math.sqrt(Math.pow(g._pos[0] - c.x, 2) + Math.pow(g._pos[1] - c.y, 2) + Math.pow(g._pos[2] - c.z, 2)); if (d > r) r = d; });
    var worldC = c.clone(); gal.G.localToWorld(worldC);
    return { c: worldC, r: r, loc: c.clone() };
  }
  // whole-galaxy bounding sphere from the guests' actual (live) positions — used for the
  // host establishing shot so it always frames every star + the core, not a guessed offset
  function galaxyBounds(node) {
    var gal = galaxies[node]; if (!gal || !gal.list.length) return null;
    var c = new THREE.Vector3(); gal.list.forEach(function (g) { if (g._pos) { c.x += g._pos[0]; c.y += g._pos[1]; c.z += g._pos[2]; } });
    c.multiplyScalar(1 / gal.list.length);
    var r = gal.coreR * 1.6;
    gal.list.forEach(function (g) { if (g._pos) { var d = Math.sqrt(Math.pow(g._pos[0] - c.x, 2) + Math.pow(g._pos[1] - c.y, 2) + Math.pow(g._pos[2] - c.z, 2)); if (d > r) r = d; } });
    var worldC = c.clone(); gal.G.localToWorld(worldC);
    return { c: worldC, r: r, loc: c.clone() };
  }
  function fabricBounds() {
    if (UNI.on) return { c: NET_C, r: bandFor('clients')[1] + 40 };
    var pts = [SUN, fab.gateway.pos, fab.switch.pos, fab.ap.pos], c = new THREE.Vector3();
    pts.forEach(function (p) { c.add(p); }); c.multiplyScalar(1 / pts.length);
    var r = 60; pts.forEach(function (p) { var d = p.distanceTo(c); if (d > r) r = d; });
    return { c: c, r: r };
  }
  /* universe mode: guests are placed by the layout's slots, not grouped by category on one arm, so a category is spread
     across the whole disc. A category stop then frames the whole galaxy face-on-ish (the same elevated angle the old
     static host shots used) and the category focus (uFocus) dims every other star - instead of fitting a camera to a
     cluster that spans the disc, which put the lens inside the arms looking back at the sun. */
  // 820 units out, 42 deg up, swung 20 deg toward the estate centre (solved offline: the other galaxy then falls out of frame): the WAN sun stays clear of the top edge
  // (it was clipped at the old 28 deg) and the neighbour systems fall outside the frame or are faded (uniVisTick)
  function galaxyFaceShot(node, azOff, dk) {
    // 2026-10-08b: 820 -> 660 units (docs/contracts.md, "restore the A/C scale"): the galaxy fills the frame between the cards
    var gal = galaxies[node], az = (gal.world.x > 0 ? -20 : 20) * Math.PI / 180 + (azOff || 0), el = 42 * Math.PI / 180, d = 660 * (dk || 1) * (gal.nd.scale || 1);
    var off = new THREE.Vector3(d * Math.cos(el) * Math.sin(az), d * Math.sin(el), d * Math.cos(el) * Math.cos(az));
    return { pos: gal.world.clone().add(off), look: gal.world.clone().add(new THREE.Vector3(0, -10, 0)) };
  }
  function hostShot(node) {
    if (UNI.on && galaxies[node]) return galaxyFaceShot(node);
    var b = galaxyBounds(node); if (!b) return SHOTS_NODE[node] || SHOTS_NODE[NA.id];
    var gal = galaxies[node], dir = b.c.clone().sub(gal.world); if (dir.lengthSq() < 1) dir.set(1, 0.3, 0); dir.normalize();
    return { pos: b.c.clone().add(dir.multiplyScalar(b.r * 1.7)).add(new THREE.Vector3(0, b.r * 0.55 + 30, 0)), look: b.c.clone(), track: { obj: gal.G, local: b.loc } };
  }
  function blkShot(node, cat) {
    var cl = categoryCluster(node, cat); if (!cl) return hostShot(node);
    // universe mode: whole galaxy + category focus dim (see galaxyFaceShot), each category from its own bearing (+-20 deg)
    // and a little closer than the host shot, so host <-> category legs are real orbits around the galaxy, not a pause
    if (UNI.on) return galaxyFaceShot(node, (Math.max(0, CATS.indexOf(cat)) - 2.5) * 0.14 * (galaxies[node].world.x > 0 ? 1 : -1), 0.9);
    var gal = galaxies[node], dir = cl.c.clone().sub(gal.world), distFromCore = dir.length();
    if (distFromCore < 1) dir.set(1, 0.3, 0); else dir.normalize();
    // when the cluster centroid sits close to the core (small distFromCore relative to the
    // core's own radius — verified on screen for a dense category whose guests hug the
    // core), a purely radial placement looks straight back down that same line and puts the
    // core DIRECTLY BEHIND the cluster, filling the frame the guest labels then sit on top
    // of. Blend in a tangential (perpendicular) component so the approach goes oblique
    // instead — the core reads as a bright shape BESIDE the cluster, not a backdrop behind it.
    var perp = new THREE.Vector3(-dir.z, 0, dir.x);
    var nearness = clamp(1 - distFromCore / (gal.coreR * 5), 0, 1);
    var approach = dir.clone().multiplyScalar(1 - 0.7 * nearness).add(perp.multiplyScalar(0.7 * nearness));
    if (approach.lengthSq() < 1e-6) approach.copy(dir); else approach.normalize();
    return { pos: cl.c.clone().add(approach.multiplyScalar(cl.r * 2.4 + 25)).add(new THREE.Vector3(0, cl.r * 0.65 + 22, 0)), look: cl.c.clone(), track: { obj: gal.G, local: cl.loc } };
  }
  function planetShotFor(kind) {
    var f = fab[kind]; if (!f) return SHOTS_STATIC.fabric;
    // distance derived from the planet's own radius (was a flat 70 regardless of kind — at
    // FAB_RAD 9 that framed close enough for the low-poly icosahedron to fill most of the
    // screen as a flat-shaded blob instead of reading as a small glowing planet)
    var rad = FAB_RAD[kind], dist = rad * 11 + 45;
    var dirp = f.pos.clone().sub(SUN).normalize();
    return { pos: f.pos.clone().add(dirp.multiplyScalar(dist)).add(new THREE.Vector3(0, rad * 3 + 20, rad * 2 + 15)), look: f.pos.clone() };
  }
  // universe: a wired / AP stop frames the WHOLE home-network diagram (the hub's attachments are lit, not isolated)
  function fabricShotForId(id) { if (UNI.on) return netShot(); var kind = fabKindOf(id); return kind ? planetShotFor(kind) : SHOTS_STATIC.fabric; }
  /* universe shots (2026-10-04). Every one is fitted to a measured bounding sphere and seen from the estate side,
     elevated, so the WAN sun hangs behind the subject; a subject that rotates carries `track` (its point in the
     rotating frame) and the director slides the shot with it every frame (trackShot), so it never drifts off. */
  var _NET_VIEW = new THREE.Vector3(0.15, 0.62, 0.77).normalize();   // from the estate camera side, high: the WAN lanes and rockets recede away from the lens toward the sun (out of frame)
  function fitShot(c, r, dir, k) {
    var d = r / Math.tan((cam.fov * Math.PI / 180) / 2) * (k || 1.15);
    return { pos: c.clone().addScaledVector(dir, d), look: c.clone() };
  }
  // the diagram is tilted toward the lens, so its near rim projects lowest: aim a little toward the near side so the
  // whole system clears the caption band, and fit the outer labels
  /* NETWORK CORE (sys:core): the switch fabric itself - the gateway star and its switch stars, closer and from a
     quarter-turn round, so the core -> home pair of stops reads as two different shots of one star system */
  var _CORE_VIEW = new THREE.Vector3(-0.38, 0.66, 0.65).normalize();
  function coreShot() {
    var sh = fitShot(NET_C, NETD.R_HUB + NETD.TIER + 34, _CORE_VIEW, 1.08);
    _side.set(_CORE_VIEW.x, 0, _CORE_VIEW.z).normalize(); sh.look.addScaledVector(_side, 22); sh.pos.addScaledVector(_side, 22);
    return sh;
  }
  function netShot() {
    if (!UNI.on) return fitShot(NET_C, bandFor('clients')[1] + 25, _NET_VIEW, 1.05);
    var sh = fitShot(NET_C, NETD.R_LBL + 14, _NET_VIEW, 1.06);
    _side.set(_NET_VIEW.x, 0, _NET_VIEW.z).normalize(); sh.look.addScaledVector(_side, 34); sh.pos.addScaledVector(_side, 34);
    return sh;
  }
  // a wired/AP stop: the parent planet plus every body attached to it
  function parentShot(topo) {
    var kind = fabKindOf(topo), pr = kind ? fab[kind].pos : (UNI.recs[UNI.byTopo[topo]] || {}).wp;
    if (!pr) return netShot();
    var kids = uniChildren(topo), r = 70;
    for (var i = 0; i < kids.length; i++) r = Math.max(r, kids[i].wp.distanceTo(pr));
    var sh = fitShot(pr, Math.min(r, 320) + 20, _NET_VIEW, 1.1);
    sh.track = { obj: NET_SPIN, local: NET_SPIN.worldToLocal(pr.clone()) };
    return sh;
  }
  function sysShot(id) {
    var F = UNI.frames[id]; if (!F) return overviewShot();
    if (F.kind === 'galaxy') return hostShot(F.sys._node);
    if (F.kind === 'network' && UNI.on) return coreShot();
    if (F.kind === 'network' || F.kind === 'clients') return netShot();
    return fitShot(F.center, F.rOut + 30, new THREE.Vector3(0.12, 0.62, 0.78).normalize(), 1.3);   // centred, from the estate camera's side
  }
  var _trk = new THREE.Vector3(), _trk2 = new THREE.Vector3();
  function trackShot(sh) {
    if (sh && sh.follow) {                                    // an aspect shot rides its body (galaxy spin, orbits), like an event cut
      if (evcWorld(sh.follow, _trk)) { if (sh.fp) { _trk2.copy(_trk).sub(sh.fp); sh.look.add(_trk2); sh.pos.add(_trk2); sh.fp.copy(_trk); } else sh.fp = _trk.clone(); }
      return;
    }
    if (!sh || !sh.track) return;
    _trk.copy(sh.track.local); sh.track.obj.localToWorld(_trk); _trk.sub(sh.look);
    sh.look.add(_trk); sh.pos.add(_trk);
  }
  // THE EDGE: camera parked just estate-side of the sun, off its axis, so the sun sits in the lower-left
  // foreground (halo trimmed by sunNear) and the violet disc fills the frame behind it
  function edgeShot() { return { pos: SUN.clone().add(new THREE.Vector3(-180, 60, 520)), look: SUN.clone().lerp(EDGE_POS, 0.5) }; }
  // intrusion cut: tighter on the sun so the shield ring reads, EDGE still behind it
  function threatShot() { return { pos: SUN.clone().add(new THREE.Vector3(-150, 50, 400)), look: SUN.clone().lerp(EDGE_POS, 0.32) }; }
  // AUDIENCE: the EDGE disc face-on, seen from its sun-side normal, so the country stars spread across the
  // frame instead of stacking along the edge-on THE EDGE view; the look point leans a little toward the sun so the WAN
  // sun hangs at the frame's edge as the destination the motes fly to. Distance frames the ~540-unit star radius.
  var AUD_SHOT = { dist: 1700, lean: 0.28 };   // tunable live via NEXUS.AUD_SHOT (see testShot)
  function audienceShot() {
    var n = new THREE.Vector3(0, 1, 0).applyQuaternion(EDGE.O.quaternion), toSun = SUN.clone().sub(EDGE_POS).normalize();
    // the disc normal points almost straight at the sun (n.toSun = 0.85, measured), so from the sun side a face-on
    // disc always has the sun BEHIND the camera and the camera INSIDE the EDGE->sun comet lane (verified on a TV:
    // request comets flew through the lens as quarter-screen blobs). So: the FAR side, looking back through the
    // violet disc at the sun - face-on, 1400+ units clear of the lane, the sun framed lower-centre behind the disc
    // with the estate beneath it, and every mote flies INTO the frame toward its destination.
    if (n.dot(toSun) > 0) n.negate();
    return { pos: EDGE_POS.clone().addScaledVector(n, AUD_SHOT.dist), look: EDGE_POS.clone().lerp(SUN, AUD_SHOT.lean) };
  }
  // a point on the bridge curve alone is real-but-sparse content — just a couple of comet
  // sprites in open space between the galaxies (verified: under 5% of frame, functionally a
  // blank shot). Blend the look-target toward the nearer galaxy's core so the shot always has
  // a galaxy's dust/glow filling the frame alongside the comet trail, not just empty transit.
  function bridgeShot(t, nearNode) {
    var p = CURVES.bridge.getPoint(t), nearC = galaxies[nearNode].world;
    var look = p.clone().lerp(nearC, 0.35);
    var dir = p.clone().sub(nearC); if (dir.lengthSq() < 1) dir.set(0, 1, 0); dir.normalize();
    return { pos: look.clone().add(dir.multiplyScalar(230)).add(new THREE.Vector3(0, 130, 0)), look: look };
  }
  // turn any single {pos,look} shot into a 2-keyframe "dwell": a slow orbit around the same
  // look target, at roughly the same distance, so the showcase spline actually lingers on the
  // subject across that chapter's whole arc-length span instead of passing through one point
  // and moving straight on to the next chapter. angle/distScale/yScale default to the original
  // ~30°-swing + 0.86x dolly-in, which is fine for a single tight subject (a cluster/planet/
  // one galaxy) but was verified on screen to rotate the OVERVIEW's second (far) galaxy clean
  // off frame — callers framing wide, multi-subject content (see overviewShot()'s use below)
  // pass a smaller angle and distScale 1.0 so the pan stays a gentle orbit, not a lateral slide.
  function dwellPair(sh, angle, distScale, yScale) {
    angle = angle == null ? 0.52 : angle; distScale = distScale == null ? 0.86 : distScale; yScale = yScale == null ? 0.82 : yScale;
    var c = sh.look.clone(), rel = sh.pos.clone().sub(c);
    var rel2 = rel.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), angle).multiplyScalar(distScale);
    rel2.y = rel.y * yScale;
    return [{ pos: sh.pos.clone(), look: c.clone() }, { pos: c.clone().add(rel2), look: c.clone() }];
  }
  function lowPass(node) {
    if (UNI.on && galaxies[node]) return dwellPair(galaxyFaceShot(node), 0.4, 0.9, 0.9);
    var b = galaxyBounds(node); if (!b) return dwellPair(hostShot(node));
    var gal = galaxies[node], armDir = b.c.clone().sub(gal.world); if (armDir.lengthSq() < 1) armDir.set(1, 0, 0); armDir.normalize();
    var perp = new THREE.Vector3(-armDir.z, 0, armDir.x);
    // both points share the SAME perpendicular offset (not +/-) so the straight leg between
    // them is a chord that stays roughly b.r*1.1 from the centroid the whole way across —
    // verified on the real screen that the old +/- version put the camera almost on top of
    // the look target at the pan's midpoint (a straight line between two opposite-side points
    // passes near the center they're opposite of), leaving a near-blank frame with the whole
    // star field behind/beside the camera instead of framed in front of it
    var away = perp.clone().multiplyScalar(b.r * 1.1);
    var p1 = b.c.clone().add(armDir.clone().multiplyScalar(b.r * 0.75)).add(away).add(new THREE.Vector3(0, b.r * 0.4 + 25, 0));
    var p2 = b.c.clone().add(armDir.clone().multiplyScalar(-b.r * 0.75)).add(away).add(new THREE.Vector3(0, b.r * 0.4 + 25, 0));
    return [{ pos: p1, look: b.c.clone() }, { pos: p2, look: b.c.clone() }];
  }
  /* ============================== the complete tour: aspects (docs/contracts.md / §9.2, 2026-10-10) ==============================
     The wall inserts one stop per aspect (key asp:*); this screen resolves the key against its OWN /api/tour copy: the anchor
     body id -> where that body is drawn (a guest star, a pool body, a hub planet, a galaxy core, the WAN sun, the Cloudflare
     galaxy), a sys:<id> anchor -> that system's shot. The shot is a calm push-in with the body's own star system behind it
     (§8a), the subject near the frame centre so a 9:16 centre crop still holds it (§9.4). The caption becomes the aspect
     card: name + one row of up to 4 facts. /api/tour missing (404) or an unknown key: the estate wide shot and the wall's
     stop name - never an error, never a stall. */
  var TOUR = { ok: false, aspects: {}, problems: null, ts: 0 };
  function pollTour() {
    fetch('/api/tour', { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error('tour ' + r.status); return r.json(); }).then(function (d) {
      var m = {}; ((d && d.aspects) || []).forEach(function (a) { if (a && typeof a.key === 'string' && a.key.indexOf('asp:') === 0) m[a.key] = a; });
      TOUR.ok = true; TOUR.aspects = m; TOUR.problems = d && Array.isArray(d.problems) ? d.problems : null; TOUR.ts = Date.now();
      alertRefresh(); statusRender();
    }).catch(function () { if (!TOUR.ts || Date.now() - TOUR.ts > 120000) { TOUR.ok = false; TOUR.aspects = {}; TOUR.problems = null; } });
  }
  function aspOf(key) { return (key && TOUR.aspects[key]) || null; }
  function aspRec(a) { return a && a.anchor ? (UNI.recs[a.anchor] || null) : null; }
  var _aspR = new THREE.Vector3();
  function aspShot(key) {
    var a = aspOf(key); if (!a) return overviewShot();
    var anc = String(a.anchor || ''), R = aspRec(a);
    if (!R && anc.indexOf('sys:') === 0 && UNI.frames[anc]) return sysShot(anc);
    if (R && R.role === 'sun') {             // the internet: a push-in on the WAN sun along the WAN EDGE stop's own bearing, the EDGE behind it
      var wl = SHOTS_STATIC.wan.look, look = SUN.clone().lerp(EDGE_POS, 0.1);
      return { pos: look.clone().add(_aspR.copy(SHOTS_STATIC.wan.pos).sub(wl).normalize().multiplyScalar(ASP_SHOT.sun)), look: look };
    }
    if (R && R.role === 'edgegal') {         // security: the sun's shield ring in front, the Cloudflare galaxy straight behind it - one centred column
      var sl = SUN.clone().lerp(EDGE_POS, ASP_SHOT.secLean), back = _aspR.copy(SUN).sub(EDGE_POS).normalize();
      return { pos: SUN.clone().addScaledVector(back, ASP_SHOT.secD).add(new THREE.Vector3(0, ASP_SHOT.secH, 0)), look: sl };
    }
    if (R && R.role === 'core' && R.F && R.F.gal) return galaxyFaceShot(R.F.gal.nd.id, ASP_SHOT.coreAz * (R.F.gal.world.x > 0 ? 1 : -1), ASP_SHOT.coreK);
    var p = new THREE.Vector3();
    if (R && evcWorld(R, p)) {
      var C = R.role === 'guest' && R.F && R.F.gal ? R.F.gal.world : isNetF(R.F) ? NET_C : (R.F && R.F.center && R.F.center.lengthSq() > 0 ? R.F.center : null);
      // the camera stands OUTSIDE the body, on its own radial from the system centre, high: the body sits in front of its star
      var dir = new THREE.Vector3(0.15, 0.6, 0.78), dC = C ? p.distanceTo(C) : 0;
      if (C && dC > 8) { dir.subVectors(p, C); dir.y = 0; if (dir.lengthSq() < 1) dir.set(0.15, 0, 0.78); dir.normalize().multiplyScalar(0.72); dir.y = ASP_SHOT.lift; }
      dir.normalize();
      var r = R.role === 'planet' ? 80 : R.role === 'guest' ? 85 : 60, look = p.clone();
      if (C) { look.lerp(C, ASP_SHOT.lean); r = clamp(Math.max(r, dC * ASP_SHOT.rk), r, 260); }
      var sh = fitShot(look, r, dir, 1.15); sh.follow = R; return sh;
    }
    if (R && R.F && R.F.sys && UNI.frames[R.F.sys.id]) return sysShot(R.F.sys.id);
    var af = a.after && String(a.after).indexOf('asp:') !== 0 ? parseStop(a.after) : null;   // anchor not drawn here: the stop it follows
    return af ? shotFor(af) : overviewShot();
  }
  var ASP_SHOT = { sun: 1100, coreAz: 0.35, coreK: 0.62, lift: 0.45, lean: 0.35, rk: 0.7, secLean: 0.3, secD: 650, secH: 190 };   // tunable live via NEXUS.ASP_SHOT
  // the label subject an aspect stands for: the anchor itself (+ a couple of neighbours), never a crowd
  function aspLabelSubj(key) {
    var a = aspOf(key), R = aspRec(a);
    if (!a) return { kind: 'over' };
    if (R && (R.role === 'sun' || R.role === 'edgegal')) return { kind: 'threat' };
    if (!R && String(a.anchor || '').indexOf('sys:') === 0) return { kind: 'sys', id: a.anchor };
    return { kind: 'asp', id: key, net: !!(R && isNetF(R.F)) };
  }
  // the aspect card's second line: up to 4 facts (k small grey, v tabular, unit small; colour only for warn / crit)
  function aspFacts(a) {
    var f = (a.facts || []).filter(function (x) { return x && x.k != null && x.v != null && x.v !== ''; }).slice(0, 4);
    if (!f.length) return a.line ? String(a.line) : (a.status === 'unknown' ? 'Feed unavailable' : '');
    return { h: '<span class="facts">' + f.map(function (x) {
      var st = x.s === 'warn' || x.s === 'crit' ? ' ' + x.s : '';
      return '<span class="f' + st + '"><em>' + esc(clip(x.k, 14)) + '</em><b>' + esc(clip(x.v, 22)) + '</b>' + (x.u ? '<small>' + esc(clip(x.u, 12)) + '</small>' : '') + '</span>';
    }).join('') + '</span>' };
  }
  function shotFor(subj) {
    switch (subj.kind) {
      case 'asp': return aspShot(subj.id);
      case 'over': return overviewShot();
      case 'wan': return SHOTS_STATIC.wan;
      case 'edge': return edgeShot();
      case 'audience': return audienceShot();
      case 'fabric': return UNI.on ? coreShot() : SHOTS_STATIC.fabric;   // NETWORK CORE: the switch fabric, closer, a quarter-turn round
      case 'sys': return sysShot(subj.id);
      case 'wired': return fabricShotForId(subj.id);
      case 'ap': return fabricShotForId(subj.id);
      case 'host': return hostShot(subj.node);
      case 'blk': return blkShot(subj.node, subj.cat);
      case 'stream': return streamShot(subj, 0) || overviewShot();
    }
    return overviewShot();
  }
  function pluralX(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  // the caption's second line: one or two plain facts with units (§7a)
  function subFor(subj) {
    var running = function (g) { return g.status === 'running'; };
    switch (subj.kind) {
      case 'asp':
        var asp = aspOf(subj.id); return asp ? aspFacts(asp) : '';
      case 'over':
        var ag = allGuests(); return ag.filter(running).length + ' / ' + ag.length + ' services running' + (UNI.on && UNI.counts ? ' · ' + (UNI.counts.total || 0) + ' devices' : '');
      case 'wan':
        return fmtBps(FAM.wan_in.bps) + ' in · ' + fmtBps(FAM.wan_out.bps) + ' out' + (S.unifi && S.unifi.latency != null ? ' · ' + S.unifi.latency + ' ms' : '');
      case 'edge':
        return (edgeInfo.audience ? plural(edgeInfo.viewers, 'viewer') + ' · ' : '') + pluralX(edgeInfo.pops.length, 'PoP', 'PoPs') + ' · ' + Math.round(edgeInfo.rpm) + ' req/min';
      case 'audience':
        return edgeInfo.audience ? plural(edgeInfo.viewers, 'viewer') + ' now · ' + edgeInfo.viewers1h + ' this hour' : 'Audience feed unavailable';
      case 'fabric':
        if (UNI.on) {
          var nsw = 0, nap = 0, hdn = 0; NETD.hubs.forEach(function (H) { if (H.b['class'] === 'ap') nap++; else nsw++; if (bodyOffline(H.b)) hdn++; });
          return pluralX(nsw, 'switch', 'switches') + ' · ' + pluralX(nap, 'access point', 'access points') + (hdn ? ' · ' + hdn + ' down' : ' · all up');
        }
        return moonState.length + ' clients';
      case 'sys':
        var F = UNI.frames[subj.id]; if (!F) return '';
        if (F.kind === 'galaxy') return subFor({ kind: 'host', node: F.sys._node });
        var c = sysCount(F); return plural(c.n, 'device') + (c.dn ? ' · ' + c.dn + ' down' : ' · all up');
      case 'wired': case 'ap':
        if (UNI.on) {
          var home = UNI.frames[UNI.netClients];
          if (home && (home.sys.topo === subj.id || home.sys.anchor === subj.id)) { var hc = sysCount(home); return plural(hc.n, 'device') + (hc.dn ? ' · ' + hc.dn + ' down' : ' · all up'); }
          var kids = uniChildren(subj.id), kd = kids.filter(function (r) { return bodyOffline(r.b); }).length;
          return plural(kids.length, 'device') + (kd ? ' · ' + kd + ' down' : '');
        }
        return moonState.filter(function (m) { return m.kind === fabKindOf(subj.id); }).length + ' clients';
      case 'host':
        var gl = guestsOf(subj.node), nd = S.nodes.filter(function (n) { return n.node === subj.node; })[0] || {};
        return gl.filter(running).length + ' / ' + plural(gl.length, 'guest') + ' running' + (nd.cpu != null ? ' · CPU ' + (+nd.cpu).toFixed(0) + '%' : '');
      case 'blk':
        var gl2 = guestsOf(subj.node).filter(function (g) { return g.cat === subj.cat; });
        return gl2.filter(running).length + ' / ' + plural(gl2.length, 'guest') + ' running';
      case 'threat':
        return '';
      case 'stream':
        var SP = trPairOf(subj.from, subj.to); return SP ? (SP.partial ? '≥ ' : '') + fmtRate(SP.bps) + ' · ' + TR_KIND_NAME[SP.kind] : 'stream not measured right now';
    }
    return '';
  }
  /* the TV's own product name for a stop (§7a): plain, sentence case, from the stop KEY - the wall's ALL-CAPS stop_name
     only feeds the hidden sync text. Every stop kind the wall can publish has a name here. */
  function nodeName(id) { var g = galaxies[id]; return (g && g.nd.name) || String(id || ''); }
  // both screens name a stop the same way: the wall's stop_name once it is product copy (not ALL CAPS), else ours
  function wallName(name, key) { name = String(name || '').trim(); return name && /[a-z]/.test(name) && name.toLowerCase() !== String(key).toLowerCase() ? name : viewName(key); }
  function viewName(key) {
    var subj = parseStop(key);
    switch (subj.kind) {
      case 'over': return 'Overview';
      case 'wan': return 'Internet edge';
      case 'edge': return 'Cloudflare edge';
      case 'audience': return 'Audience';
      case 'fabric': return 'Network core';
      case 'wired': case 'ap':
        var home = UNI.on && UNI.frames[UNI.netClients];
        if (home && (home.sys.topo === subj.id || home.sys.anchor === subj.id)) return 'Home network';
        var R = recOf(subj.id); return (R ? shortName(R.b) || 'Switch' : (subj.kind === 'ap' ? 'Wireless' : 'Wired')) + (subj.kind === 'ap' ? ' · wireless' : ' · wired');
      case 'host': return nodeName(subj.node);
      case 'blk': return nodeName(subj.node) + ' · ' + (CAT_NAME[subj.cat] || cap1(subj.cat));
      case 'stream': return trSysName(subj.from) + ' → ' + trSysName(subj.to);
      case 'asp': var an = aspOf(subj.id); return an && an.name ? String(an.name) : cap1(String(subj.id).slice(4).replace(/[-_]+/g, ' '));
      case 'sys':
        var F = UNI.frames[subj.id]; if (!F) return 'System';
        if (F.kind === 'galaxy') return nodeName(F.sys._node);
        if (F.kind === 'network') return 'Network core';
        if (F.kind === 'clients') return 'Home network';
        return sysName(F);
    }
    return 'Overview';
  }
  function applyLabelSubject(subj) {
    if (subj.kind === 'asp') subj = aspLabelSubj(subj.id);
    LABEL.mode = subj.kind; LABEL.node = subj.node; LABEL.cat = subj.cat; LABEL.id = subj.id; LABEL.net = !!subj.net; refreshLabels();
  }
  function setFocus(catIdx, galId) { NODES.forEach(function (n) { galaxies[n.id].guests.material.uniforms.uFocus.value = (galId === n.id) ? catIdx : -1; }); }
  function focusFor(subj) { setFocus(subj.kind === 'blk' ? CATS.indexOf(subj.cat) : -1, (subj.kind === 'blk' || subj.kind === 'host') ? subj.node : null); }
  /* ARRIVAL ACCENT (one per stop: fired on the wall's beat, which ticks once per arrival). A single thin ring opens
     around the subject in its own plane and fades, plus a small bloom breath; no global flash, no strobe. */
  var ARR = { t: 9, dur: 1.5, r1: 100, mesh: null, breath: 0 };
  (function () {
    var m = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ map: ringTex(0.94, 1.0), color: 0xa9d4ff, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }));
    m.visible = false; scene.add(m); ARR.mesh = m;
  })();
  var _arrQ = new THREE.Quaternion(), _arrX = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  function shockwave() {
    var sh = D.toShot || D.to, subj = D.toSubj || D.subject || { kind: 'over' };
    if (!sh || SC.active || TC.on) return;
    ARR.t = 0; ARR.mesh.position.copy(sh.look);
    // the subject's own plane: a galaxy's disc, the network system's plane, else horizontal
    var gal = (subj.kind === 'host' || subj.kind === 'blk') && galaxies[subj.node];
    if (gal) gal.O.getWorldQuaternion(_arrQ); else if (subj.kind === 'wired' || subj.kind === 'ap' || subj.kind === 'fabric' || (subj.kind === 'sys' && UNI.frames[subj.id] && isNetF(UNI.frames[subj.id]))) NET.getWorldQuaternion(_arrQ); else _arrQ.identity();
    ARR.mesh.quaternion.copy(_arrQ).multiply(_arrX);
    ARR.r1 = clamp(sh.pos.distanceTo(sh.look) * 0.42, 60, subj.kind === 'over' ? 360 : 520);
    var w = getComputedStyle(document.documentElement).getPropertyValue('--wall');
    try { ARR.mesh.material.color.set(w && w.trim() ? w.trim() : '#a9d4ff').lerp(new THREE.Color(0xdde8f5), 0.62); } catch (e) { ARR.mesh.material.color.setHex(0xa9d4ff); }
    ARR.mesh.visible = true;
  }
  function arrivalTick(dt) {
    if (ARR.t >= ARR.dur) { if (ARR.mesh.visible) { ARR.mesh.visible = false; ARR.mesh.material.opacity = 0; } ARR.breath = 0; return; }
    ARR.t += dt; var f = clamp(ARR.t / ARR.dur, 0, 1), e = 1 - Math.pow(1 - f, 3);
    ARR.mesh.scale.setScalar(ARR.r1 * (0.25 + 0.75 * e));
    ARR.mesh.material.opacity = 0.26 * smooth(f / 0.12) * (1 - f) * (1 - f);
    var b = clamp(f / 0.5, 0, 1); ARR.breath = Math.sin(Math.PI * b) * 0.5 * (1 - f);          // smooth bump, no step on the attack
  }

  /* content-anchored waypoint insertion, shared by every director state (sync/free/showcase):
     a straight pos+look lerp between two shots can swing the look-target across genuinely
     empty sky when the shots are on opposite sides of the estate (e.g. the AP planet out by
     the sun -> a category cluster in a far galaxy) — this was the actual cause of "panning to
     blank space". needsHub() checks whether the leg's look-target midpoint passes near any
     real content; if not, the travel is routed through the OVERVIEW shot instead (it always
     frames both galaxies + the sun, so the screen is never empty) via travelLerp()'s 2-half split. */
  var BRIDGE_MID = new THREE.Vector3(0, 90, 0);
  var CONTENT_ANCHORS = NODES.map(function (n) { return { c: galaxies[n.id].world, r: 340 * GAL_K }; })
    .concat([{ c: SUN, r: 300 }, { c: BRIDGE_MID, r: 280 }, { c: EDGE_POS, r: 700 }]);
  var _hubMid = new THREE.Vector3();
  function nearContent(p) {
    for (var i = 0; i < CONTENT_ANCHORS.length; i++) { if (p.distanceTo(CONTENT_ANCHORS[i].c) < CONTENT_ANCHORS[i].r) return true; }
    var fb = fabricBounds(); if (p.distanceTo(fb.c) < fb.r + 160) return true;
    var st = UNI.on ? uniSites() : []; for (var k = 0; k < st.length; k++) if (p.distanceTo(st[k].center) < st[k].rOut + 150) return true;
    return false;
  }
  function needsHub(lookA, lookB) { _hubMid.copy(lookA).add(lookB).multiplyScalar(0.5); return !nearContent(_hubMid); }
  /* a travel leg is ONE quadratic Bezier in position and in look-target, eased once with
     smootherstep over its whole length — continuous velocity start to end, no interior stop.
     The old version split a hub-routed leg into two independently-eased halves, which brought
     the camera to a dead halt at the hub in the middle of a 1.7s move (accelerate, brake,
     accelerate, brake): that stutter was the single most visible "not clean" part of a stop
     change. Control points are prepared once per leg (legSetup) into preallocated vectors:
       - hub leg: C = 2*hub - (A+B)/2, so the curve passes EXACTLY through the hub shot at its
         midpoint (same content-anchoring guarantee as before: the overview is always in frame
         mid-leg) but as a smooth arc;
       - plain leg: a crane arc — the control point is the chord midpoint lifted by up to 220
         units (28% of the leg length), so the camera rises over the estate on a long move and
         only barely on a short hop between two clusters in the same galaxy. The look target
         gets a much smaller lift so the framing tilts down slightly at the apex. */
  var _UP = new THREE.Vector3(0, 1, 0), _rel = new THREE.Vector3(), _tp = new THREE.Vector3(), _tl = new THREE.Vector3();
  function mkLeg() { return { cp: new THREE.Vector3(), cl: new THREE.Vector3(), c1: new THREE.Vector3(), c2: new THREE.Vector3(), move: null, dir: 1 }; }
  /* CINEMATIC LEGS (2026-10-07). The wall publishes the style of each leg in /api/lightstate (optional `move`,
     `move_dir`); this screen plays its own version of the same move on its own geometry while following the wall's
     prog exactly as before (directorSyncTick's follower), so both screens share the energy of every stop change.
       glide     today's crane arc (also what an old wall without `move` gets, unramped)
       swoop     the chord's control point is pushed sideways (move_dir: +1 = toward screen right) so the camera swings
                 out ~30% of the leg and curls into the subject, ending with a small azimuth overshoot around it that
                 settles with zero velocity (sin^2 envelope)
       dive      pull-back reveal then dive: a cubic whose first control point climbs high and back toward an
                 estate-wide altitude, the second hangs above the destination, so the move rises, sees the estate,
                 then plunges in; the gaze passes through the estate centre
       reveal    pull back and up to a wide destination with a gentle roll (<= 2.6 deg) that returns to 0
       slingshot orbit about the destination's centre, sweeping in direction move_dir (counter-clockwise from above for +1),
                 dipping in closer and lower past the core mid-sweep, the gaze arriving early (stops inside one system)
       orbit     the same polar sweep, but it rises and pulls out mid-way (a high crane orbit over the system) and settles
                 back into the destination pose (wall v11 addition)
       dolly     a near-straight push with a gentle roll (<= 2.6 deg, sign move_dir) peaking mid-leg
     Every styled move uses the speed ramp e = smootherstep(s + 0.25 s (1 - s)): a soft start, a fast middle and a
     long soft landing. Positions are pure functions of the leg progress, so velocity is continuous and the motion is
     frame-rate independent; the roll is 0 at both ends. */
  var MOVES = { glide: 1, swoop: 1, dive: 1, reveal: 1, slingshot: 1, orbit: 1, dolly: 1 };
  var _side = new THREE.Vector3(), _mv = new THREE.Vector3(), _mv2 = new THREE.Vector3();
  function legSetup(leg, from, to, hub, lift, move, dir) {
    lift = lift == null ? 1 : lift;
    leg.move = MOVES[move] ? move : null; leg.dir = dir === -1 ? -1 : 1; leg.hub = !!hub;
    var len = from.pos.distanceTo(to.pos); leg.len = len;
    if (hub && leg.move !== 'dive') {
      leg.cp.copy(from.pos).add(to.pos).multiplyScalar(-0.5).addScaledVector(hub.pos, 2);
      leg.cl.copy(from.look).add(to.look).multiplyScalar(-0.5).addScaledVector(hub.look, 2);
    } else {
      leg.cp.copy(from.pos).add(to.pos).multiplyScalar(0.5); leg.cp.y += lift * Math.min(len * 0.28, 220);
      leg.cl.copy(from.look).add(to.look).multiplyScalar(0.5); leg.cl.y += lift * Math.min(len * 0.05, 36);
    }
    if (!leg.move || leg.move === 'glide') return;
    // screen-right of the travel direction (forward x up), horizontal
    _side.subVectors(to.pos, from.pos); _side.y = 0; if (_side.lengthSq() < 1) _side.subVectors(to.look, from.pos).setY(0);
    if (_side.lengthSq() < 1) _side.set(0, 0, -1); _side.normalize(); _side.set(-_side.z, 0, _side.x);
    if (leg.move === 'slingshot' || leg.move === 'orbit') {
      var fx = from.pos.x - to.look.x, fz = from.pos.z - to.look.z, tx = to.pos.x - to.look.x, tz = to.pos.z - to.look.z;
      var rf = Math.sqrt(fx * fx + fz * fz), rt = Math.sqrt(tx * tx + tz * tz);
      if (rt < 1 || rf > rt * 3 || rf < rt * 0.25) leg.move = 'swoop';      // not an orbit-shaped leg: swoop instead
      else {
        var d0 = Math.atan2(tz, tx) - Math.atan2(fz, fx); d0 = ((d0 + Math.PI) % TAU + TAU) % TAU - Math.PI;
        var want = -leg.dir;                                                // +1 = counter-clockwise seen from above
        if (d0 * want < 0) d0 += want * TAU;
        if (Math.abs(d0) > 1.45 * Math.PI) d0 -= Math.sign(d0) * TAU;          // never more than ~260 deg: go the short way
        leg.dsign = d0 >= 0 ? 1 : -1;                                        // the sweep's sense, re-applied every frame (the target tracks)
        leg.osh = Math.abs(d0) < Math.PI / 2 ? 0.3 * leg.dsign : 0;          // a short sweep still gets a visible swing
        return;
      }
    }
    if (leg.move === 'swoop') leg.cp.addScaledVector(_side, leg.dir * 0.62 * Math.max(len, 120));
    else if (leg.move === 'dolly') { if (!hub) { leg.cp.copy(from.pos).add(to.pos).multiplyScalar(0.5); leg.cp.y += Math.min(len * 0.05, 30); } }
    else if (leg.move === 'reveal') leg.cp.y += Math.min(len * 0.22, 180);
    else if (leg.move === 'dive') {
      var H = clamp(len * 0.55, 180, 520);
      _mv.subVectors(from.pos, to.look).setY(0); if (_mv.lengthSq() < 1) _mv.set(0, 0, 1); _mv.normalize();
      leg.c1.copy(from.pos).addScaledVector(_mv, 0.25 * Math.max(len, 200)); leg.c1.y += H;
      leg.c2.copy(to.pos); leg.c2.y += H * 0.85;
      var ov = overviewShot().look;
      leg.cl.copy(from.look).add(to.look).multiplyScalar(0.5).lerp(ov, 0.45);
    }
  }
  function moveRamp(raw) { var w = raw + 0.25 * raw * (1 - raw); return smootherstep(w); }
  // raw is the UNEASED 0..1 leg progress; writes straight into the shared camPos/camLook, no allocation
  function travelLerp(from, to, raw, leg) {
    var mv = leg.move, e = mv ? moveRamp(raw) : smootherstep(raw), a, b, c;
    leg.roll = 0;
    if (mv === 'slingshot' || mv === 'orbit') {
      var fx = from.pos.x - to.look.x, fz = from.pos.z - to.look.z, tx = to.pos.x - to.look.x, tz = to.pos.z - to.look.z;
      var af = Math.atan2(fz, fx), d = Math.atan2(tz, tx) - af; d = ((d + Math.PI) % TAU + TAU) % TAU - Math.PI;
      if (d * leg.dsign < 0) d += leg.dsign * TAU;
      var sn = Math.sin(Math.PI * e), ang = af + d * e + (leg.osh || 0) * sn * sn;
      var rr = lerp(Math.sqrt(fx * fx + fz * fz), Math.sqrt(tx * tx + tz * tz), e), rt0 = Math.sqrt(tx * tx + tz * tz);
      var yy = lerp(from.pos.y - to.look.y, to.pos.y - to.look.y, e);
      if (mv === 'orbit') { rr *= 1 + 0.3 * sn; yy += sn * 0.5 * rt0; }       // rise and pull out over the system
      else { rr *= 1 - 0.2 * sn; yy += sn * 0.04 * rr; }                       // dip in close past the core
      camPos.set(to.look.x + Math.cos(ang) * rr, to.look.y + yy, to.look.z + Math.sin(ang) * rr);
      var eg = smootherstep(Math.min(1, (raw + 0.25 * raw * (1 - raw)) / 0.72));
      camLook.copy(from.look).lerp(to.look, eg);
      return;
    }
    if (mv === 'dive') {
      var u = 1 - e, k0 = u * u * u, k1 = 3 * u * u * e, k2 = 3 * u * e * e, k3 = e * e * e;
      camPos.copy(from.pos).multiplyScalar(k0).addScaledVector(leg.c1, k1).addScaledVector(leg.c2, k2).addScaledVector(to.pos, k3);
      a = u * u; b = 2 * u * e; c = e * e;
      camLook.copy(from.look).multiplyScalar(a).addScaledVector(leg.cl, b).addScaledVector(to.look, c);
      return;
    }
    a = (1 - e) * (1 - e); b = 2 * (1 - e) * e; c = e * e;
    camPos.copy(from.pos).multiplyScalar(a).addScaledVector(leg.cp, b).addScaledVector(to.pos, c);
    camLook.copy(from.look).multiplyScalar(a).addScaledVector(leg.cl, b).addScaledVector(to.look, c);
    var s1 = Math.sin(Math.PI * e);
    if (mv === 'swoop') {
      // the late azimuth overshoot about the subject: sin^2 * e peaks ~2/3 through and leaves with zero slope
      var os = -leg.dir * 0.14 * s1 * s1 * e, co = Math.cos(os), si = Math.sin(os);
      _mv.subVectors(camPos, to.look); var x = _mv.x, z = _mv.z; _mv.x = x * co - z * si; _mv.z = x * si + z * co;
      camPos.copy(to.look).add(_mv);
      leg.roll = leg.dir * 0.03 * s1;
    } else if (mv === 'dolly') leg.roll = leg.dir * 0.045 * s1;
    else if (mv === 'reveal') leg.roll = leg.dir * 0.04 * s1;
  }
  /* free-roam / unsynced: the same vocabulary, chosen by what the leg IS (wide -> close dives, close -> wide reveals,
     inside one system slingshot / orbit / dolly in turn, between systems swoop / dolly / swoop / glide) with the side
     alternating every two legs, so the TV never repeats a move back to back even with no wall to follow */
  var FREE_ALT = ['swoop', 'dolly', 'swoop', 'glide'];
  function sameSystem(a, b) {
    if (!a || !b) return false;
    var na = (a.kind === 'host' || a.kind === 'blk') ? a.node : null, nb = (b.kind === 'host' || b.kind === 'blk') ? b.node : null;
    if (na && na === nb) return true;
    var net = { wired: 1, ap: 1, fabric: 1 };
    var an = net[a.kind] || (a.kind === 'sys' && UNI.frames[a.id] && isNetF(UNI.frames[a.id])), bn = net[b.kind] || (b.kind === 'sys' && UNI.frames[b.id] && isNetF(UNI.frames[b.id]));
    return !!(an && bn);
  }
  function pickMove(fromSubj, toSubj, n) {
    if (toSubj && toSubj.kind === 'over') return 'reveal';
    if (fromSubj && fromSubj.kind === 'over') return 'dive';
    if (sameSystem(fromSubj, toSubj)) return ['slingshot', 'orbit', 'dolly'][n % 3];
    return FREE_ALT[n % FREE_ALT.length];
  }

  var camPos = overviewShot().pos.clone(), camLook = overviewShot().look.clone();
  var D = { mode: 'free', hold: 0, orbit: 0, t: 1, dur: 1.6, from: { pos: new THREE.Vector3(), look: new THREE.Vector3() }, to: null, leg: mkLeg(),
            toShot: null, toSubj: null, subject: { kind: 'over' }, inTravel: false, freeIdx: 0,
            settleFrom: { pos: new THREE.Vector3(), look: new THREE.Vector3() }, settleT: 1, pendingSubj: null, travelRaw: 0, travelP0: 0 };

  // the one place camPos/camLook become the camera, for every director. Also keeps camSpeed:
  // a screen-relative motion rate (translation + look shift, over subject distance, per second)
  // that the label layer fades on. The three clampAwayFrom() floors used to be showcase-only;
  // a Bezier leg can cut a corner near a core just as a spline could, so they apply everywhere.
  var camSpeed = 0, _prevPos = new THREE.Vector3(), _prevLook = new THREE.Vector3();
  function applyCam(dt) {
    clampAwayFrom(SUN, 170);
    clampAwayFrom(EDGE_POS, 170);   // the AUDIENCE legs fly through the EDGE disc (a feature) but never through its core
    for (var ci2 = 0; ci2 < NODES.length; ci2++) { var gC = galaxies[NODES[ci2].id]; clampAwayFrom(gC.world, (gC.coreR * 3 + 40) * (NODES[ci2].scale || 1)); }
    var dist = Math.max(60, camPos.distanceTo(camLook));
    var v = dt > 0 ? (camPos.distanceTo(_prevPos) + camLook.distanceTo(_prevLook)) / dist / dt : 0;
    _prevPos.copy(camPos); _prevLook.copy(camLook);
    camSpeed += (v - camSpeed) * (1 - Math.exp(-dt / 0.1));
    cam.position.copy(camPos);
    // a styled leg's roll (0 at both ends of the leg, 0 in every hold): tilt the up vector about the view axis
    var roll = (!SC.active && !TC.on && (D.inTravel || (D.mode === 'free' && D.t < 1))) ? (D.leg.roll || 0) : 0;
    D.rollS = roll;
    if (roll) { _mv2.subVectors(camLook, camPos).normalize(); cam.up.set(0, 1, 0).applyAxisAngle(_mv2, roll); } else cam.up.set(0, 1, 0);
    cam.lookAt(camLook);
    // intrusion shake: a decaying, distance-relative jitter on the final camera pose only (camPos/camLook, the
    // director's own state, are untouched, so the shot settles back exactly where it was)
    if (shakeT > 0) {
      shakeT -= dt; var sa = clamp(shakeT / 0.6, 0, 1), sm = sa * sa * dist * 0.014, st = U_TIME.value;
      cam.position.x += Math.sin(st * 61) * sm; cam.position.y += Math.cos(st * 47) * sm * 0.7; cam.position.z += Math.sin(st * 53 + 1.3) * sm * 0.5;
    }
    sky.position.copy(camPos);
  }
  // parked on a shot: the slow orbit sway, entered through a short eased settle from wherever
  // the camera actually is. The sync director used to hard-copy the hold shot into camPos the
  // instant the wall reported "hold" — and because shotFor() recomputes from the galaxy's live
  // rotation, that shot never quite matched the one the travel leg had been flying toward, so
  // every arrival ended on a visible pop. Now it glides the last few units over ~0.7s.
  function holdPose(sh, dt) {
    if (sh && sh.stream && D.toSubj && D.toSubj.kind === 'stream') {          // the stream ride: the pose moves along the lane over the hold
      D.hold += dt; var hs = Math.max(2, D.holdS || 5.2), rp = streamShot(D.toSubj, clamp(D.hold / hs, 0, 1));
      if (rp) { sh.pos.copy(rp.pos); sh.look.copy(rp.look); }
      if (D.settleT < 1) { D.settleT = Math.min(1, D.settleT + dt / (D.settleDur || 0.7)); var e0 = smootherstep(D.settleT); camPos.lerpVectors(D.settleFrom.pos, sh.pos, e0); camLook.lerpVectors(D.settleFrom.look, sh.look, e0); }
      else { camPos.copy(sh.pos); camLook.copy(sh.look); }
      return;
    }
    D.hold += dt; D.orbit += dt;
    // the sway fades in over SWAY_IN s: a leg ends at zero velocity, so the hold must start at zero velocity too
    var amp = smoothstep01(D.hold / MOTION.SWAY_IN);
    _rel.copy(sh.pos).sub(sh.look).applyAxisAngle(_UP, Math.sin(D.orbit * 0.11) * 0.16 * amp); _rel.y += Math.sin(D.orbit * 0.07) * 18 * amp;
    _tp.copy(sh.look).add(_rel); _tl.copy(sh.look);
    if (D.settleT < 1) {
      D.settleT = Math.min(1, D.settleT + dt / (D.settleDur || 0.7)); var e = smootherstep(D.settleT);
      camPos.lerpVectors(D.settleFrom.pos, _tp, e); camLook.lerpVectors(D.settleFrom.look, _tl, e);
    } else { camPos.copy(_tp); camLook.copy(_tl); }
  }
  function smoothstep01(t) { return smooth(t); }
  function beginHold(sh) { D.settleFrom.pos.copy(camPos); D.settleFrom.look.copy(camLook); D.settleT = 0; D.settleDur = 0.7; D.hold = 0; D.orbit = 0; D.toShot = sh; D.to = sh; }
  function beginTravel(sh, subj, hubShot) {
    D.from.pos.copy(camPos); D.from.look.copy(camLook); D.toShot = sh; D.to = sh; D.toSubj = subj; D.subject = subj;
    legSetup(D.leg, D.from, sh, hubShot, 1, D.nextMove, D.nextDir); D.nextMove = null; D.pendingSubj = subj; D.travelRaw = 0;
  }
  function sameSubj(a, b) { return !!a && !!b && a.kind === b.kind && a.node === b.node && a.cat === b.cat && a.id === b.id; }
  // the subject swap (label retext + category focus) is deferred to 40% of the leg — by then
  // the label layer has faded out (labelFadeTick), so the new set fades IN on arrival instead
  // of popping into existence at the old camera angle the moment the move starts
  function travelSubjectTick(raw) { if (D.pendingSubj && raw >= 0.4) { var s = D.pendingSubj; D.pendingSubj = null; applyLabelSubject(s); focusFor(s); } }
  var CAP_T = null, CAP_CUR = null;
  // caption crossfade (was showcase-only; the sync/free directors swapped the text instantly).
  // A sub-line-only change (live numbers under the same title) is written directly.
  function setCaption(cap, sub) {
    if (THREAT.capHold) { THREAT.pendCap = cap; THREAT.pendSub = sub; return; }   // an intrusion owns the caption for 5 s; the director's request is applied when it ends
    setCaptionRaw(cap, sub);
  }
  /* the sub-line is plain text, or {h: html} for an aspect card's fact row (§9.2); CAP_SUBV keeps what is on screen so an
     event caption can restore it exactly */
  var CAP_SUBK = null, CAP_SUBV = '';
  function subKey(sub) { return sub && typeof sub === 'object' ? 'h:' + sub.h : 't:' + (sub == null ? '' : sub); }
  function writeSub(el, sub) {
    var k = subKey(sub); if (k === CAP_SUBK) return; CAP_SUBK = k; CAP_SUBV = sub;
    if (sub && typeof sub === 'object') {
      el.innerHTML = sub.h;
      // the fact row must fit the 9:16 centre crop (608 px): drop trailing facts, never wrap or shrink the type
      var row = el.firstChild; while (row && row.children && row.children.length > 2 && row.offsetWidth > 600) row.removeChild(row.lastChild);
    } else el.textContent = sub == null ? '' : sub;
  }
  function setCaptionRaw(cap, sub) {
    var capEl = $('captxt'), subEl = $('capsub');          // #cap = the wall-sync dot (#sync) + this text
    if (cap === CAP_CUR) { if (!CAP_T) writeSub(subEl, sub); else CAP_NEXT = sub; return; }
    CAP_CUR = cap; CAP_NEXT = sub;
    capEl.style.opacity = '0'; subEl.style.opacity = '0';
    if (CAP_T) clearTimeout(CAP_T);
    CAP_T = setTimeout(function () { CAP_T = null; capEl.textContent = cap; writeSub(subEl, CAP_NEXT); capEl.style.opacity = '1'; subEl.style.opacity = '1'; }, 380);
  }
  var CAP_NEXT = '';

  function directorSyncTick(dt) {
    if (D.toShot) trackShot(D.toShot);
    if (D.inTravel && D.toShot) {
      // our leg starts at 0 from wherever the camera really was when the wall's travel first reached us (SSE
      // latency means prog can already be 0.1-0.3 by then) and lands at 1 with the wall. 2026-10-04: the leg is no
      // longer SET to the wall's extrapolated prog (each ~5 Hz re-anchor that came in behind the extrapolation
      // parked the camera until the wall caught up: a stop-go hitch). It is a follower: it always advances at the
      // nominal leg speed scaled by how far the wall is ahead/behind, within TOUR_MIN..TOUR_MAX, so speed changes
      // are continuous and it can never run backwards. Once the wall reports hold (D.arrived), the target is 1.
      var span = Math.max(0.02, 1 - D.travelP0), localWall = 1;
      if (!D.arrived) {
        var el = (performance.now() - D.travelT0) / 1000, rawWall = clamp(D.travelProgBase + el / D.travelS, 0, 1);
        localWall = D.travelP0 < 0.98 ? clamp((rawWall - D.travelP0) / span, 0, 1) : 1;
      }
      // the follower runs on REAL elapsed time (capped 0.25 s), not the 50 ms-clamped dt: it has to stay locked to the
      // wall's clock, and at a low frame rate the clamped dt would let it fall behind every leg
      var nowMs = performance.now(), rdt = D.syncLastMs ? clamp((nowMs - D.syncLastMs) / 1000, 0, 0.25) : dt; D.syncLastMs = nowMs;
      var nominal = rdt / Math.max(0.8, D.travelS * span);       // a late join still gets >= 0.8 s, never a snap
      // the rate itself is low-passed (0.12 s): each ~5 Hz packet re-anchors localWall by its own latency jitter, and an
      // instant rate change on every packet was a small velocity step 5 times a second
      var rateT = clamp(1 + MOTION.TOUR_GAIN * (localWall - D.travelRaw), MOTION.TOUR_MIN, MOTION.TOUR_MAX);
      D.tourRate = D.tourRate == null ? 1 : D.tourRate + (rateT - D.tourRate) * (1 - Math.exp(-rdt / 0.12));
      var local = Math.min(1, D.travelRaw + nominal * D.tourRate);
      if (localWall >= 1 && local > 0.998) local = 1;
      D.travelRaw = local;
      travelLerp(D.from, D.toShot, local, D.leg); travelSubjectTick(local);
      if (local >= 1 && D.arrived) {                              // leg done and the wall already holds: the hold starts exactly here
        D.inTravel = false; D.arrived = false;
        D.settleFrom.pos.copy(camPos); D.settleFrom.look.copy(camLook); D.settleT = 1; D.hold = 0; D.orbit = 0;
      }
    } else { D.syncLastMs = 0; if (D.toShot) { overviewTrack(dt); holdPose(D.toShot, dt); } }
    applyCam(dt);
  }
  // #cap only ever shows a DISPLAY name: the wall's stop_name when it has one, else a fixed title per stop kind.
  // (A raw key like "over:0" leaked into the caption once via a caller passing the key as the name.)
  var KIND_NAME = { sys: 'SYSTEM', over: 'OVERVIEW', wan: 'WAN EDGE', edge: 'THE EDGE', audience: 'AUDIENCE', fabric: 'THE FABRIC', wired: 'WIRED', ap: 'WIRELESS', host: 'GALAXY', blk: 'CATEGORY', none: 'THE ESTATE' };
  function stopName(key, name) {
    if (name && name.toLowerCase() !== String(key).toLowerCase()) return name;
    var st = freeStops().filter(function (x) { return x.key === key; })[0];
    if (st && st.name) return st.name;
    var subj = parseStop(key);
    if (subj.kind === 'host') return String(subj.node || '').toUpperCase() + ' GALAXY';
    if (subj.kind === 'blk') return String(subj.node || '').toUpperCase() + ' · ' + String(subj.cat || '').toUpperCase();
    if (subj.kind === 'sys') { var F = UNI.frames[subj.id]; return F ? String(F.sys.label || subj.id).toUpperCase() : 'SYSTEM'; }
    return KIND_NAME[subj.kind] || 'OVERVIEW';
  }
  function freeGoto(key, name) {
    var subj = parseStop(key), sh = shotFor(subj), n = D.freeN = (D.freeN || 0) + 1;
    D.nextMove = pickMove(D.subject, subj, n); D.nextDir = (n >> 1) % 2 ? -1 : 1; D.lastMove = D.nextMove;
    beginTravel(sh, subj, needsHub(camLook, sh.look) ? overviewShot() : null);
    D.t = 0; D.dur = D.leg.move === 'glide' ? 2.0 : 2.6; D.stopKey = key;
    setCaption(wallName(name, key), subFor(subj));
  }
  function directorFreeTick(dt) {
    if (D.to) trackShot(D.to);
    if (D.t < 1) {
      D.t = Math.min(1, D.t + dt / D.dur);
      travelLerp(D.from, D.to, D.t, D.leg); travelSubjectTick(D.t);
      if (D.t >= 1) { beginHold(D.to); if (!D.pinStop) shockwave(); }
    } else {
      overviewTrack(dt); holdPose(D.to, dt);
      if (D.hold > 5.5 && !D.pinStop) {
        var stops = freeStops();
        D.freeIdx = (D.freeIdx + 1) % stops.length;
        freeGoto(stops[D.freeIdx].key, stops[D.freeIdx].name);
      }
    }
    applyCam(dt);
  }
  // the wall's own stop list plus THE EDGE (a TV-only stop: the wall has no such subject)
  var EDGE_STOP = { key: 'edge', name: 'Cloudflare edge' }, AUDIENCE_STOP = { key: 'audience', name: 'Audience' };
  function freeStops() { return (WALL.stops.length ? WALL.stops : [{ key: 'over:0', name: 'OVERVIEW' }]).concat([EDGE_STOP, AUDIENCE_STOP]); }
  function enterFreeRoam() {
    D.mode = 'free'; D.freeIdx = 0;
    var stops = freeStops();
    freeGoto(stops[0].key, stops[0].name);
  }
  addEventListener('keydown', function (e) { if (e.key === ' ') { D.mode = 'free'; D.hold = 999; } });

  /* wall sync v2: SSE stream of /api/lightstate (falls back to 1 Hz polling) drives the
     director in lockstep — travel legs ease with the wall's own prog, re-anchored on
     every update so motion stays smooth between the wall's ~5 Hz ticks. */
  var WALL = { stops: [], lastKey: '', lastBeat: -1, lastTs: 0 };
  function applyWallState(s) {
    if (WALL.qaOnly && !(s && s.qa)) return;                // QA injection owns the director (NEXUS.wallState)
    var fresh = s && s.ts && (Date.now() / 1000 - s.ts) < 20;
    if (s && s.ts) WALL.lastTs = s.ts;
    if (fresh && s.rgb) document.documentElement.style.setProperty('--wall', 'rgb(' + s.rgb.join(',') + ')');
    if (fresh && s.stops && s.stops.length) WALL.stops = s.stops;
    if (fresh && typeof s.beat === 'number') { if (WALL.lastBeat >= 0 && s.beat !== WALL.lastBeat) shockwave(); WALL.lastBeat = s.beat; }
    var chip = $('sync');
    if (SC.active) return;                                    // showcase owns the camera; still track wall state above so resuming is instant
    if (TC.on) return;                                        // so does an intrusion cut (5 s); endThreatCut() forces a re-anchor when it ends
    if (!fresh || s.manual || D.pinFree) {
      if (D.mode !== 'free') enterFreeRoam();
      chip.className = 'off'; chip.querySelector('span').textContent = (fresh && s.manual) ? 'wall manual' : 'free roam';
      return;
    }
    D.mode = 'sync'; D.stopKey = s.phase === 'travel' && s.to ? s.to : s.stop; if (s.hold_s) D.holdS = +s.hold_s;
    chip.className = 'on'; chip.querySelector('span').textContent = s.stop_name || s.stop || '';
    // caption/sub always reflect the latest server state (cheap, two textContent writes) —
    // camera snap / label rebuild / focus are the expensive parts and stay change-gated below,
    // otherwise a brief free-roam interruption (stale poll, wall mouse blip) can leave the
    // caption stuck on the old subject even after the pill and camera have moved on.
    if (s.phase === 'travel' && s.to) {
      var toSubj = parseStop(s.to), key = 'travel:' + s.to;
      if (WALL.lastKey !== key) {
        WALL.lastKey = key;
        var sTo = shotFor(toSubj);
        // the wall's leg style (optional, lightstate v11): absent -> today's glide, exactly as before
        D.nextMove = MOVES[s.move] ? s.move : null; D.nextDir = s.move_dir === -1 ? -1 : 1; D.lastMove = D.nextMove || 'none';
        beginTravel(sTo, toSubj, needsHub(camLook, sTo.look) ? overviewShot() : null);
        D.travelP0 = clamp(s.prog || 0, 0, 1); D.arrived = false; D.tourRate = 1; D.syncLastMs = 0;
      }
      D.travelProgBase = s.prog || 0; D.travelT0 = performance.now(); D.travelS = Math.max(0.1, s.travel_s || 2); D.inTravel = true;
      /* The camera flies toward s.to from the START of the leg, but the WALL's own
         caption hands over at the leg MIDPOINT - that is exactly what s.stop /
         s.stop_name encode (lightsync.js: "stop (and colour) hand over at the
         travel midpoint, matching the camera's own focus handover"). Captioning
         from s.to_name here therefore put this screen AHEAD of the wall: measured
         across 7 consecutive stop changes, the TV read a median 909 ms early,
         worst case 1504 ms. Fly early, read in step. */
      var capSubj = parseStop(s.stop || s.to);
      setCaption(wallName(s.stop_name || s.to_name, s.stop || s.to), subFor(capSubj));
    } else {
      var subj = parseStop(s.stop), hkey = 'hold:' + s.stop;
      if (WALL.lastKey !== hkey || (D.inTravel && !D.arrived)) {
        WALL.lastKey = hkey;
        if (D.inTravel && sameSubj(D.toSubj, subj)) {
          // the wall arrived before our leg did: finish the leg on our own follower (target 1), then hold from
          // exactly where it ends - the old instant beginHold() re-eased from mid-leg = a stop and a restart
          D.arrived = true;
        } else {
          D.inTravel = false; D.arrived = false;
          beginHold(shotFor(subj));
          // the travel leg normally applies the subject itself at 40% (travelSubjectTick); only
          // a hold that arrives without one (fresh sync, or a leg cut short) still needs it
          if (D.pendingSubj || !sameSubj(D.toSubj, subj)) { D.pendingSubj = null; applyLabelSubject(subj); focusFor(subj); }
          D.toSubj = subj;
        }
      }
      D.subject = subj;
      setCaption(wallName(s.stop_name, s.stop), subFor(subj));
    }
  }
  var lightstatePoll = null;
  function pollLightstate() { fetch('/api/lightstate', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(applyWallState).catch(function () { }); }
  function startWallSync() {
    if (typeof EventSource === 'function') {
      try {
        sse('/api/lightstate/stream', function (ev) { try { applyWallState(JSON.parse(ev.data)); } catch (e) { } },
            function () { if (!lightstatePoll) lightstatePoll = setInterval(pollLightstate, 1000); });
        return;
      } catch (e) { }
    }
    lightstatePoll = setInterval(pollLightstate, 1000);
  }
  startWallSync(); pollLightstate();

  /* Watchdog for a SILENT authority. The freshness test above only runs when a
     packet arrives, so an SSE socket that stays open and quiet leaves this screen
     in 'sync' mode parked on the last stop indefinitely - observed on a TV that
     held one stop in sync mode for ~25 minutes while /api/lightstate was
     1612 s stale and the wall toured on. Free roam is the honest fallback; the
     next packet puts us straight back in sync via applyWallState. */
  setInterval(function () {
    try {
      if (SC.active || TC.on) return;                 // showcase / cut own the camera
      if (!WALL.lastTs) return;
      var age = Date.now() / 1000 - WALL.lastTs;
      if (age < 20) return;
      /* The SSE socket can go silent WITHOUT firing onerror, so the failover poll
         at startWallSync() never arms and nothing ever calls applyWallState again.
         Verified: with the stream in that state the wall was publishing 0.1 s-fresh
         packets while this screen sat in free roam, and a single pollLightstate()
         put it back in sync instantly. Poll while stale - it is one request per
         2 s and it is the only path back. */
      pollLightstate();
      if (age > 35 && D.mode === 'sync') {            // grace, so a brief hiccup does not flick the camera
        enterFreeRoam();
        var c = $('sync');
        if (c) { c.className = 'off'; c.querySelector('span').textContent = 'wall silent'; }
      }
    } catch (e) { }
  }, 2000);

  /* ============================== showcase (the playthrough) ==============================
     a flat sequence of {pos,look,chapter} waypoints, walked leg by leg with the same
     smootherstep travelLerp() the lockstep/free directors use — NOT a single global
     Catmull-Rom spline through every chapter's keyframes. That was tried first and had two
     real bugs verified on the actual screen: (1) getPointAt() on a closed curve through ~34
     wildly uneven, sparse keyframes overshoots between distant chapters — caught it mid-flight
     with the caption reading the NEXT chapter's title while the camera was still parked on the
     GPU/sun region, i.e. exactly the "panning to blank space" complaint; (2) it allocates a
     fresh Vector3 on every single getPointAt() call (three.js's Curve.getPoint has no target-
     reuse overload), twice a frame, every frame, for the whole ~3-minute loop — enough GC
     pressure to be a real suspect for the mid-playthrough fps dip. A flat leg list with
     content-anchored hub insertion (needsHub/travelLerp, shared with the other two director
     states) fixes both: no curve overshoot possible (it's a lerp), no per-frame allocation,
     and the caption is tagged directly on the waypoint that earns it instead of guessed via
     nearest-sample-on-the-spline. */
  var SC = { active: false, manual: null, _lastBody: false, legIdx: 1, legT: 0, chapter: -1, built: false, chapters: [], seq: [],
             from: { pos: new THREE.Vector3(), look: new THREE.Vector3() }, leg: mkLeg(), legDur: 1, legReady: false };
  function wantShowcase() {
    var bodyOn = document.body.classList.contains('st-showcase');
    // a real server-driven mode change always wins over a stale local 'p' press — otherwise
    // pressing p once locks SC.manual forever and the TV never notices the wall moved back
    // to st-wall (this is exactly how it got stuck showing the flythrough during st-wall)
    if (bodyOn !== SC._lastBody) { SC._lastBody = bodyOn; SC.manual = null; }
    return SC.manual !== null ? SC.manual : bodyOn;
  }
  SC._lastBody = document.body.classList.contains('st-showcase');
  var PAN_S = 6.5, TRANS_S = 3.2;    // seconds: pan across a chapter's own dwell arc / travel into a new chapter (or half a hub-routed one)
  function buildShowcase() {
    var CH = [], SEQ = [], OV = overviewShot();     // one snapshot for this build — same bounding-sphere shot used for the ESTATE chapter and every hub splice below
    // pts is always a 2-point arc from dwellPair()/lowPass()/an explicit pair — every chapter
    // holds and pans instead of the camera just passing through a single point. panMul (default
    // 1) stretches just the pan itself, for a chapter that wants more screen time than the rest.
    function chapter(cap, subFn, subj, pts, panMul, spot) {
      panMul = panMul || 1;
      var idx = CH.length; CH.push({ cap: cap, sub: subFn, subj: subj || { kind: 'over' }, spot: spot || null });
      if (SEQ.length && needsHub(SEQ[SEQ.length - 1].look, pts[0].look)) {
        SEQ.push({ pos: OV.pos.clone(), look: OV.look.clone(), chapter: -1, dur: TRANS_S });
      }
      pts.forEach(function (p, i) { SEQ.push({ pos: p.pos.clone(), look: p.look.clone(), chapter: idx, dur: SEQ.length === 0 ? PAN_S : (i === 0 ? TRANS_S : PAN_S * panMul) }); });
    }

    // every chapter below frames its subject from the SAME geometry the lockstep director uses
    // (hostShot/blkShot/planetShotFor/categoryCluster — all driven by live star/entity
    // positions), so a content-derived control point, never a hard-coded one

    // ESTATE's pan uses a small angle + distScale 1.0 (no dolly-in) instead of dwellPair's
    // default ~30°/0.86x swing — verified on screen that the default swing, applied to a wide
    // two-galaxy OVERVIEW, rotated the far galaxy off frame (see overviewShot()'s comment).
    // This keeps it a gentle orbit around the bounding-sphere centroid at ~constant distance.
    chapter('Overview', function () { return subFor({ kind: 'over' }); }, { kind: 'over' }, dwellPair(OV, 0.2, 1.0, 0.92));
    /* beat ("follow a strong arc"): the camera rides the busiest measured link along its own lane,
       above and a little behind the streaks, looking ahead down the arc (only when the document carries traffic) */
    var arc = showcaseArc();
    if (arc) chapter('Busiest link · ' + arc.name, function () { return (arc.partial ? '≥ ' : '') + fmtRate(arc.bps) + ' · ' + TR_KIND_NAME[arc.kind]; }, { kind: 'over' }, arc.pts, 0.7);
    chapter(viewName('wan'), function () { return subFor({ kind: 'wan' }); }, { kind: 'wan' }, dwellPair(SHOTS_STATIC.wan));
    chapter(viewName('edge'), function () { return subFor({ kind: 'edge' }); }, { kind: 'edge' }, dwellPair(edgeShot(), 0.3, 0.92, 0.9));
    // the people beat: the EDGE face-on with every viewer country labelled, held 1.6x a normal pan so the roll-call reads
    chapter('Audience', function () { return subFor({ kind: 'audience' }); }, { kind: 'audience' }, dwellPair(audienceShot(), 0.26, 0.94, 0.96), 1.6);

    var fb = fabricBounds();
    if (UNI.on) {
      chapter('Network core', function () { return subFor({ kind: 'fabric' }); }, { kind: 'fabric' }, dwellPair(netShot(), 0.34, 0.9, 0.9));
      if (fabIds.ap) chapter('Wireless', function () { return plural(uniChildren(fabIds.ap).length, 'wireless device'); }, { kind: 'ap', id: fabIds.ap }, dwellPair(parentShot(fabIds.ap)));
      uniSites().forEach(function (F) { chapter(sysName(F), function () { return subFor({ kind: 'sys', id: F.id }); }, { kind: 'sys', id: F.id }, dwellPair(sysShot(F.id), 0.4, 0.9, 0.9)); });
    } else {
    chapter('Network core', function () { return moonState.length + ' clients'; }, { kind: 'fabric' },
      dwellPair({ pos: fb.c.clone().add(new THREE.Vector3(fb.r * 1.6, fb.r * 0.9, fb.r * 1.2)), look: fb.c.clone() }));

    chapter('Wireless', function () { var n = moonState.filter(function (m) { return m.kind === 'ap'; }).length; return n + ' wireless clients'; }, { kind: 'ap', id: fabIds.ap }, dwellPair(planetShotFor('ap')));
    }

    // dwellPair (not two independent bridgeShot() endpoints): verified on the real screen that
    // panning end-to-end across the whole curve put the camera equidistant from BOTH galaxies
    // at the pan's midpoint — the exact "empty sky" case, self-inflicted within one chapter.
    // Orbiting a single anchor near the first galaxy keeps a galaxy in frame for the whole chapter.
    if (N_NODES > 1) chapter(BRIDGE_TITLE, function () { return FAM.bridge.bps > 0 ? fmtBps(FAM.bridge.bps) : 'idle'; }, { kind: 'none' }, dwellPair(bridgeShot(0.2, NA.id)));

    // every Proxmox node, in NODES order (growth appends). Only the featured node (CONFIG.featured_node, by default the
    // one with the most guests; the wall makes per-category stops for it alone) gets per-category chapters: on a node
    // with 1-3 guests per category that shot is one small star lost in the background starfield. Every other node gets
    // the reclaimed time as a slower lowPass() sweep (a real pan across the arm) at 2.2x the normal pan length.
    NODES.forEach(function (nd) {
      var id = nd.id; if (nd.gone) return;
      var feat = id === FEATURED;
      chapter(nodeName(id), function () { return subFor({ kind: 'host', node: id }); }, { kind: 'host', node: id }, lowPass(id), feat ? 1 : 2.2, ['galaxy', id]);
      if (feat) CATS.forEach(function (cat) {
        if (!guestsOf(id).some(function (g) { return g.cat === cat; })) return;     // never frame an empty category
        chapter(nodeName(id) + ' · ' + CAT_NAME[cat], function () { return subFor({ kind: 'blk', node: id, cat: cat }); }, { kind: 'blk', node: id, cat: cat }, dwellPair(blkShot(id, cat)));
      });
    });

    // close the loop back to chapter 0's first point — same hub rule as any other leg
    var first = SEQ[0], last = SEQ[SEQ.length - 1];
    if (needsHub(last.look, first.look)) SEQ.push({ pos: OV.pos.clone(), look: OV.look.clone(), chapter: -1, dur: TRANS_S });

    SC.chapters = CH; SC.seq = SEQ; SC.built = true;
  }
  function trPairKey(a, b) { return a < b ? a + '|' + b : b + '|' + a; }
  function trPairOf(from, to) { var k = trPairKey(from, to); return TR.pairs.filter(function (p) { return p.key === k; })[0] || null; }
  function trSysName(sid) { var F = UNI.frames[sid]; return !F ? String(sid || '').replace(/^sys:/, '') : F.kind === 'galaxy' ? nodeName(F.gal.nd.id) : F.kind === 'network' ? 'core' : F.kind === 'clients' ? 'home' : sysName(F); }
  // the lane a stream stop rides, oriented from -> to: the directed lane of that direction, else the pair's centred lane
  function streamLane(subj) {
    var k = trPairKey(subj.from, subj.to), want = subj.from < subj.to ? 1 : -1, best = null;
    Object.keys(TR.lanes).forEach(function (key) { var L = TR.lanes[key]; if (L.pair !== k || L.liveT === 0) return; if (L.mode === want || (!best && L.mode === 0)) best = L; });
    if (!best) Object.keys(TR.lanes).forEach(function (key) { var L = TR.lanes[key]; if (L.pair === k && L.liveT !== 0 && !best) best = L; });
    return best ? { L: best, rev: subj.from > subj.to } : null;
  }
  /* the ride's chase pose at progress e (0..1 of the hold): behind and above the point it has reached on the lane, looking
     ahead along it toward the destination - the TV's own version of the wall's stream ride (same stop, same hold) */
  var _sr = new THREE.Vector3(), _sq = new THREE.Vector3(), _st = new THREE.Vector3(), _ss = new THREE.Vector3();
  function streamShot(subj, e) {
    var SL = streamLane(subj); if (!SL) return null;
    var L = SL.L, u = 0.06 + 0.5 * smooth(e), tA = SL.rev ? 1 - u : u, tB = SL.rev ? Math.max(0, tA - 0.03) : Math.min(1, tA + 0.03);
    bezAt(L, tA, _sr); bezAt(L, tB, _sq); _st.subVectors(_sq, _sr); if (_st.lengthSq() < 1e-6) _st.subVectors(L.p3, L.p0); _st.normalize();
    _ss.crossVectors(_st, _UP); if (_ss.lengthSq() < 1e-6) _ss.set(1, 0, 0); _ss.normalize();
    var back = clamp(L.len * 0.14, 70, 170), tL = SL.rev ? Math.max(0, tA - 0.24) : Math.min(1, tA + 0.24);
    return { pos: _sr.clone().addScaledVector(_st, -back).addScaledVector(_UP, back * 0.5).addScaledVector(_ss, back * 0.3), look: bezAt(L, tL, new THREE.Vector3()), stream: true };
  }
  // the busiest measured link (not the core's WAN, which the Internet landmark carries) as three camera waypoints along its lane
  function showcaseArc() {
    var P = TR.pairs.filter(function (p) { return !p.noLabel; })[0]; if (!P) return null;
    var L = null; Object.keys(TR.lanes).forEach(function (k) { var X = TR.lanes[k]; if (X.pair === P.key && X.live > 0.3 && (!L || X.bps > L.bps)) L = X; });
    if (!L) return null;
    var pts = [], a = new THREE.Vector3(), b = new THREE.Vector3(), tg = new THREE.Vector3(), sd = new THREE.Vector3();
    [0.12, 0.5, 0.86].forEach(function (t) {
      bezAt(L, t, a); bezAt(L, Math.min(1, t + 0.06), b); tg.subVectors(b, a).normalize(); sd.crossVectors(tg, _UP).normalize();
      var back = clamp(L.len * 0.16, 60, 160);
      pts.push({ pos: a.clone().addScaledVector(tg, -back).addScaledVector(_UP, back * 0.55).addScaledVector(sd, back * 0.35), look: bezAt(L, Math.min(1, t + 0.22), new THREE.Vector3()) });
    });
    var nm = function (sid) { if (sid === '__sun') return 'internet'; var F = UNI.frames[sid]; return !F ? sid : F.kind === 'galaxy' ? nodeName(F.gal.nd.id) : F.kind === 'network' ? 'core' : F.kind === 'clients' ? 'home' : sysName(F); };
    return { pts: pts, name: nm(P.a) + ' ↔ ' + nm(P.b), bps: P.bps, kind: P.kind, partial: P.partial };
  }
  // extra safety net on top of needsHub: even a hub-routed leg can pass close enough to a core
  // (e.g. cutting the corner near a galaxy on the way to/from the hub) to clip through it —
  // push the camera radially outward if it ever gets nearer than a safe floor
  var _clampV = new THREE.Vector3();
  function clampAwayFrom(p, minD) {
    var d = camPos.distanceTo(p);
    if (d < minD && d > 0.001) { _clampV.copy(camPos).sub(p).multiplyScalar(minD / d); camPos.copy(p).add(_clampV); }
  }
  // start the leg that ends at seq[SC.legIdx]: from the camera's ACTUAL pose (so legs chain
  // continuously even after a clampAwayFrom nudge), through a hub entry if the next seq item
  // is one — hub waypoints (chapter -1) are passed THROUGH as the Bezier control, not stopped
  // at, with the two legs' durations merged. A chapter's own dwell pan (both ends tagged with
  // the same chapter) is a flat orbit: no crane lift, it would fight the deliberate framing.
  function showcaseLeg() {
    var seq = SC.seq, n = seq.length, to = seq[SC.legIdx], hub = null, dur = to.dur || TRANS_S, prevCh = seq[(SC.legIdx - 1 + n) % n].chapter;
    if (to.chapter < 0 && n > 1) { hub = to; SC.legIdx = (SC.legIdx + 1) % n; to = seq[SC.legIdx]; dur += to.dur || TRANS_S; }
    SC.from.pos.copy(camPos); SC.from.look.copy(camLook);
    legSetup(SC.leg, SC.from, to, hub, (!hub && prevCh === to.chapter && to.chapter >= 0) ? 0 : 1);
    SC.legDur = dur; SC.legReady = true;
  }
  function showcaseTick(dt) {
    var seq = SC.seq, n = seq.length;
    if (!SC.legReady) showcaseLeg();
    SC.legT += dt / SC.legDur;
    if (SC.legT >= 1) {
      SC.legT = SC.legT > 2 ? 0 : SC.legT - 1;   // clamp instead of chaining if a frame ever stalls badly
      SC.legIdx = (SC.legIdx + 1) % n; showcaseLeg();
    }
    var to = seq[SC.legIdx];
    travelLerp(SC.from, to, SC.legT, SC.leg); travelSubjectTick(SC.legT);
    applyCam(dt);
    if (to.chapter >= 0 && to.chapter !== SC.chapter) {
      SC.chapter = to.chapter; var ch = SC.chapters[to.chapter];
      setCaption(ch.cap, ch.sub()); shockwave();
      D.pendingSubj = ch.subj;   // applied by travelSubjectTick once the label layer has faded out
      SC.spot = ch.spot;         // "node close-up with stats": dcAutoTick opens the node's card for this chapter
    }
    var sp = $('scbar');
    if (sp) { var frac = (SC.legIdx + SC.legT) / n; var tx = 'scaleX(' + frac.toFixed(3) + ')'; if (sp.dataset.tx !== tx) { sp.dataset.tx = tx; sp.style.transform = tx; } }
  }
  function toggleShowcase(on) {
    SC.active = on; document.body.classList.toggle('nx-showcase', on);
    if (on) {
      buildShowcase(); SC.legIdx = 1; SC.legT = 0; SC.chapter = -1; SC.legReady = false;
      camPos.copy(SC.seq[0].pos); camLook.copy(SC.seq[0].look);   // snap to the first waypoint so leg 1 starts from where it's actually drawn, not wherever the camera was a moment ago
    } else { WALL.lastKey = ''; D.pendingSubj = null; D.inTravel = false; D.arrived = false; pollLightstate(); }   // force an immediate re-sync back to the wall
  }
  addEventListener('keydown', function (e) { if (e.key === 'p' || e.key === 'P') SC.manual = !wantShowcase(); });

  /* ============================== threats (2026-09-19) ==============================
     /api/threats/stream (SSE, one frame per seq change = a NEW event) with a 5 s /api/threats poll fallback.
     crowdsec  -> red intrusion comet from the EDGE rim (angle hashed from cc) to the sun; on arrival the
                  shield ring flashes red + a red shockwave bursts; caption cuts to INTRUSION BLOCKED for 5 s
                  (then the director's caption is restored); outside the showcase the camera cuts to
                  threatShot() for those 5 s (re-entrant: another event extends, never stacks).
     secmon    -> the status line flashes the finding title red for 6 s; the affected guest's galaxy rings red.
     window.NEXUS.threat(evt) injects one for QA. */
  var THREAT = { seq: null, capHold: false, capUntil: 0, capCls: '', pendCap: null, pendSub: null, prevCap: null, prevSub: null,
                 secUntil: 0, secOn: false, flashT: 0, waveT: 9, nextCurve: 0, chip: '', level: 0, last: null };
  // TC is the shared "cut" director state: kind 'threat' (intrusion, 5 s) or 'audience' (a new viewer, 8 s). A threat
  // always wins: it takes over a running audience cut, and an audience cut never interrupts a threat.
  var TC = { on: false, kind: '', until: 0, follow: null, followP: new THREE.Vector3(), from: { pos: new THREE.Vector3(), look: new THREE.Vector3() }, to: null, leg: mkLeg(), t: 1, dur: 0.9, hold: 0 };
  function galaxyForHost(h) {
    h = String(h || ''); if (galaxies[h] && NODES.some(function (n) { return n.id === h; })) return h;
    var nodes = (S.topo && S.topo.nodes) || [];
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i]; if (n.ip !== h && n.label !== h && n.id !== h) continue;
      var m = /^guest:([a-z0-9_-]+):/i.exec(n.id || ''); if (m && galaxies[m[1]]) return m[1];
      var pm = /^pve:([a-z0-9_-]+)$/i.exec(n.parent || ''); if (pm && galaxies[pm[1]]) return pm[1];
      if (n.node && galaxies[n.node]) return n.node;
    }
    return null;
  }
  // a caption owned by an event for ms milliseconds (body class colours it: nx-threat red, nx-audience gold); the
  // director's own caption requests queue behind it (setCaption -> pendCap) and are applied when it ends
  function holdCaption(cap, sub, ms, cls) {
    if (!THREAT.capHold) { THREAT.capHold = true; THREAT.prevCap = CAP_CUR; THREAT.prevSub = CAP_T ? CAP_NEXT : CAP_SUBV; THREAT.pendCap = null; }
    if (THREAT.capCls && THREAT.capCls !== cls) document.body.classList.remove(THREAT.capCls);
    THREAT.capCls = cls; document.body.classList.add(cls);
    setCaptionRaw(cap, sub); THREAT.capUntil = performance.now() + ms;
  }
  function threatCaption(cap, sub) { holdCaption(cap, sub, 5000, 'nx-threat'); }
  function threatCaptionTick(now) {
    if (!THREAT.capHold || now < THREAT.capUntil) return;
    THREAT.capHold = false; if (THREAT.capCls) document.body.classList.remove(THREAT.capCls); THREAT.capCls = '';
    if (THREAT.pendCap != null) setCaptionRaw(THREAT.pendCap, THREAT.pendSub); else if (THREAT.prevCap != null) setCaptionRaw(THREAT.prevCap, THREAT.prevSub);
    THREAT.pendCap = null;
  }
  function beginCut(kind, shot, ms) {
    if (SC.active) return;
    var now = performance.now();
    if (TC.on) {
      if (TC.kind === kind) { TC.until = Math.max(TC.until, now + ms); return; }   // re-entrant: a second event of the same kind only extends the cut
      if (kind !== 'threat') return;                                                // an audience cut never interrupts a threat cut
    }
    TC.on = true; TC.kind = kind; TC.until = now + ms; TC.t = 0; TC.hold = 0; TC.from.pos.copy(camPos); TC.from.look.copy(camLook); TC.to = shot;
    TC.follow = shot.follow || null;                             // an event cut rides with its body (orbits, galaxy spin)
    if (TC.follow && !evcWorld(TC.follow, TC.followP)) TC.follow = null;
    TC.dur = kind === 'threat' ? 0.9 : 2.4;                     // an intrusion is a hard cut; a viewer arriving is an eased crane out through the EDGE
    legSetup(TC.leg, TC.from, TC.to, null, kind === 'threat' ? 0.35 : kind === 'event' ? 0.4 : 0.8);
    applyLabelSubject(shot.subj || { kind: kind }); setFocus(-1, null);
  }
  function beginThreatCut() { beginCut('threat', threatShot(), 5000); }
  /* a new person (a country's 1 h unique count rose): cut to the AUDIENCE shot for 8 s with the country named, at most
     once per AUD_CUT_GAP so a busy hour never turns the screen into a slideshow; the mote + ping fire regardless */
  var AUD_CUT_MS = 8000, AUD_CUT_GAP = 120000, audLastCut = -1e9;
  var audPend = null;   // {cc, t}: in sync mode the cut waits for a hold window (see audTickCut), like the event cutaways
  function viewerArrived(s) {
    var now = performance.now();
    if (now - audLastCut < AUD_CUT_GAP || SC.active || (TC.on && TC.kind === 'threat') || (THREAT.capHold && THREAT.capCls === 'nx-threat')) return;
    audLastCut = now;
    if (D.mode === 'sync') { audPend = { cc: s.cc, t: now }; return; }
    holdCaption('New viewer · ' + s.cc, audienceRoll(4), AUD_CUT_MS, 'nx-audience');
    beginCut('audience', audienceShot(), AUD_CUT_MS);
  }
  // sync mode: the audience cut lives inside one hold (>= EVC.SYNC_MIN s left, ends 0.3 s before the wall departs); 30 s TTL
  function audTickCut(nowMs) {
    if (!audPend) return;
    if (nowMs - audPend.t > 30000 || D.mode !== 'sync') { audPend = null; return; }
    if (SC.active || TC.on || THREAT.capHold || D.inTravel || D.hold < EVC.HOLD_MIN) return;
    var left = (+D.holdS || 3.3) - D.hold; if (left < EVC.SYNC_MIN) return;
    var ms = Math.max(1500, Math.min(AUD_CUT_MS, (left - 0.3) * 1000)), cc = audPend.cc; audPend = null; audLastCut = nowMs;
    holdCaption('New viewer · ' + cc, audienceRoll(4), ms, 'nx-audience');
    beginCut('audience', audienceShot(), ms);
  }
  /* EVENT CUTAWAYS (2026-10-09): when a body goes down, comes back, or a new device appears (the universe records' R.ev),
     the director takes one calm look at it: an eased push-in from the current camera bearing, the body named in the caption
     ("Lab switch · down", "New device · Phone"), ~7 s, then the same glide home the audience cut uses. Rules:
       - at most one per EVC.GAP (2 min), and never within 30 s of an audience cut; a threat always wins (beginCut);
       - never on the wall-synced arrival beat: it waits until the TV has held the stop for EVC.HOLD_MIN s, never mid-leg;
       - lab gear (b.lab) never cuts away for down (it is a bench); a "new" cutaway is for devices only (not guests);
       - down / back up only for infrastructure (EVC_INFRA classes, hubs, guests) and only when the registry says offline
         (down_why), never for a phone or TV going to sleep, a stopped guest or a long-gone device;
       - a poll that changes more than EVC.MASS bodies at once is a feed event (a registry rebuild, a switch reboot), not
         news: no cutaway; the hosts-down alert already speaks for real outages;
       - a pending event that finds no window within EVC.TTL is dropped (old news is not news).
     Priority within one poll: down > new > up. NEXUS.eventCut(id, kind) injects one for QA (bypasses the gap). */
  var EVC = { cand: [], pend: null, pendKind: '', pendT: 0, last: -1e9, GAP: 120000, MS: 6000, HOLD_MIN: 0.9, SYNC_MIN: 2.2, MASS: 3, TTL: 90000 };
  var EVC_INFRA = { pve_host: 1, gateway: 1, 'switch': 1, ap: 1, server: 1, storage: 1, network_device: 1, camera: 1 };
  var EVC_PRI = { down: 3, 'new': 2, up: 1 }, _evW = new THREE.Vector3(), _evD = new THREE.Vector3();
  function evcNote(R, kind) {
    if (!R || !R.b) return;
    if (R.role !== 'dev' && R.role !== 'guest' && R.role !== 'planet') return;
    if (kind === 'down' && (R.b.lab || !bodyOffline(R.b))) return;   // a stopped guest / long-gone device is not an outage
    // phones, TVs, smart plugs and PCs sleep and wake all day: their down / up is not news (a NEW one still is)
    if (kind !== 'new' && R.role === 'dev' && !EVC_INFRA[R.b['class']]) return;
    if (kind === 'new' && R.role !== 'dev') return;
    EVC.cand.push(R); R._evcK = kind;
  }
  function evcPick() {
    var n = EVC.cand.length; if (!n) return;
    if (n > EVC.MASS) { EVC.cand.length = 0; return; }
    var best = null;
    for (var i = 0; i < n; i++) { var R = EVC.cand[i]; if (!best || EVC_PRI[R._evcK] > EVC_PRI[best._evcK]) best = R; }
    EVC.cand.length = 0;
    if (EVC.pend && EVC_PRI[EVC.pendKind] > EVC_PRI[best._evcK]) return;   // a pending outage outranks a newer, lesser event
    EVC.pend = best; EVC.pendKind = best._evcK; EVC.pendT = performance.now();
  }
  // where the body is drawn right now, in place (no allocation): a guest star in its galaxy, else the pool body
  function evcWorld(R, out) {
    if (R.role === 'guest') { if (!R.guest || !R.guest._pos || !R.F || !R.F.gal) return false; out.fromArray(R.guest._pos); R.F.gal.G.localToWorld(out); return true; }
    if (R.role === 'dev' || R.role === 'planet') { out.copy(R.wp); return out.lengthSq() > 0; }
    return false;
  }
  function evcName(R) { return (R.role === 'guest' && R.guest && R.guest.name) ? clip(R.guest.name, 18) : (shortName(R.b) || 'Device'); }
  var EVC_CLS = { guest_vm: 'VM', guest_lxc: 'Container', pve_host: 'Proxmox host', ap: 'Access point', tv_av: 'TV / AV', iot: 'IoT device',
                  network_device: 'Network device', nas: 'NAS', pc: 'Computer', phone: 'Phone' };
  function evcSub(R) {
    var c = String(R.b['class'] || 'device'), w = EVC_CLS[c] || cap1(c.replace(/_/g, ' '));
    var sys = R.F && R.F.sys ? sysLabel(R.F.sys) : '';
    return w + (sys ? ' · ' + cap1(sys) : '');
  }
  function evcShot(R) {
    var p = new THREE.Vector3(); if (!evcWorld(R, p)) return null;
    // keep the bearing the camera already has (a push-in, not a swing round), lifted a little so the body sits over its system
    var dir = camPos.clone().sub(p); if (dir.lengthSq() < 1) dir.set(0.15, 0.6, 0.78); dir.normalize(); dir.y += 0.35; dir.normalize();
    /* the body plus its context (§8a: never a lone dot in a void): the look leans toward its system's centre - the galaxy
       core for a guest, the network star for the home network, the site star for a site - and the fit radius grows to hold
       both, so the subject sits off-centre in front of its own star system */
    var C = R.role === 'guest' && R.F && R.F.gal ? R.F.gal.world : isNetF(R.F) ? NET_C : (R.F && R.F.center && R.F.center.lengthSq() > 0 ? R.F.center : null);
    var r = R.role === 'planet' ? 70 : R.role === 'guest' ? 75 : 50, look = p.clone();
    if (C) { var dC = p.distanceTo(C); look.lerp(C, 0.3); r = clamp(Math.max(r, dC * 0.55), r, 240); }
    var sh = fitShot(look, r, dir, 1.15);
    sh.follow = R;
    sh.subj = R.role === 'guest' ? { kind: 'event', id: R.b.id, node: R.F && R.F.gal ? R.F.gal.nd.id : null } : { kind: 'event', id: R.b.id };
    return sh;
  }
  function evcFire(R, kind, ms) {
    var sh = evcShot(R); if (!sh) return false; ms = ms || EVC.MS;
    var nm = evcName(R), cap = kind === 'new' ? 'New device · ' + nm : nm + (kind === 'down' ? ' · down' : ' · back up');
    EVC.last = performance.now();
    holdCaption(cap, evcSub(R), ms, kind === 'down' ? 'nx-evdown' : 'nx-event');
    beginCut('event', sh, ms);
    return true;
  }
  function evcTick(nowMs) {
    if (!EVC.pend) return;
    if (nowMs - EVC.pendT > EVC.TTL) { EVC.pend = null; return; }
    if (!BOOT.revealed || SC.active || TC.on || THREAT.capHold) return;
    if (!EVC.force && (nowMs - EVC.last < EVC.GAP || nowMs - audLastCut < 30000)) return;
    if (D.mode === 'sync' && (D.inTravel || D.hold < EVC.HOLD_MIN)) return;   // the arrival beat (and the leg) belong to the wall
    if (D.mode !== 'sync' && D.hold < EVC.HOLD_MIN) return;
    /* sync is sacred (the room lights and the TV follow the wall): in sync mode a cutaway lives inside ONE hold - it waits
       for a hold with >= EVC.SYNC_MIN s left (in practice the 4.8 s overview holds) and ends 0.3 s before the wall departs,
       so the next leg starts on time instead of the TV missing a stop */
    var ms = EVC.MS;
    if (D.mode === 'sync') {
      var left = (+D.holdS || 3.3) - D.hold;
      if (left < EVC.SYNC_MIN && !EVC.force) return;
      ms = Math.max(1500, Math.min(EVC.MS, (left - 0.3) * 1000));
    }
    var R = EVC.pend, k = EVC.pendKind; EVC.pend = null; EVC.force = false;
    if (R.b && UNI.recs[R.b.id] === R) evcFire(R, k, ms);
  }
  function threatCutTick(dt) {
    if (TC.follow && evcWorld(TC.follow, _evW)) { _evW.sub(TC.followP); TC.followP.add(_evW); TC.to.look.add(_evW); TC.to.pos.add(_evW); }   // ride the body's own motion
    if (TC.t < 1) { TC.t = Math.min(1, TC.t + dt / TC.dur); travelLerp(TC.from, TC.to, TC.t, TC.leg); }
    else { TC.hold += dt; _rel.copy(TC.to.pos).sub(TC.to.look).applyAxisAngle(_UP, Math.sin(TC.hold * 0.35) * 0.05); camPos.copy(TC.to.look).add(_rel); camLook.copy(TC.to.look); }
    applyCam(dt);
  }
  function endThreatCut() {
    TC.on = false;
    if (SC.active) return;
    applyLabelSubject(D.subject || { kind: 'over' }); focusFor(D.subject || { kind: 'over' });
    // the way back: a 5 s threat cut snaps back fast; the audience beat glides home over ~2.4 s (a clean exit, not a jump)
    var back = TC.kind === 'threat' ? 1.2 : 2.4; TC.follow = null;
    if (D.mode === 'sync') { D.inTravel = false; D.arrived = false; if (D.toShot) { beginHold(D.toShot); D.settleDur = back; } WALL.lastKey = ''; pollLightstate(); }
    else if (D.to) { D.from.pos.copy(camPos); D.from.look.copy(camLook); legSetup(D.leg, D.from, D.to, null, 0.35); D.t = 0; D.dur = back; D.pendingSubj = null; }
  }
  // the hit: shield flash + red shockwave (as before) plus a bloom kick and a short camera shake, both decaying over
  // ~0.6 s (hitKick feeds bloom.strength in the loop, shakeT the jitter in applyCam) - an impact, not a colour change
  var hitKick = 0, shakeT = 0;
  function threatArrive() { THREAT.flashT = 1.3; THREAT.waveT = 0; hitKick = 1; shakeT = 0.6; }
  function threat(e) {
    if (!e) return; THREAT.last = e;
    if (e.src === 'secmon') {
      // the finding owns the alert bar for 6 s (alertRefresh); the frame loop clears it
      THREAT.secTitle = clip(String(e.title || 'Security finding'), 90);
      THREAT.secUntil = performance.now() + 6000; THREAT.secOn = true; alertRefresh();
      (e.hosts || []).forEach(function (h) { var gid = galaxyForHost(h); if (gid) { galaxies[gid].ringT = 0; galaxies[gid].ringRed = 1.4; } });
      return;
    }
    // crowdsec: launch from the EDGE rim at an angle hashed from the country, two comets a beat apart
    var ang = hash(e.cc || e.id || 'x') * 6.283, ci = THREAT.nextCurve++ % TH_N, cv = CURVES['th' + ci];
    _local.set(Math.cos(ang) * 235, 0, Math.sin(ang) * 235); EDGE.G.localToWorld(_local);
    cv.v0.copy(_local); cv.v3.copy(SUN); cv.v1.copy(_local).lerp(SUN, 0.3); cv.v1.y += 70; cv.v2.copy(SUN).lerp(_local, 0.3); cv.v2.y += 50;
    cometSpawn('th' + ci, 0); cometSpawn('th' + ci, -0.025); cometSpawn('th' + ci, -0.05); cometSpawn('th' + ci, -0.075);
    var as = shortAS(e.as_name, ''), parts = [e.cc, as !== '?' ? as : '', e.title, e.events ? plural(+e.events, 'event') : ''].filter(function (x) { return !!x; });
    threatCaption('Intrusion blocked', parts.join(' · '));
    beginThreatCut();
  }
  // the threat level is a plain word in the status panel (THREAT_WORD), not a mood colour
  function threatChip(d) {
    if (!d) return;
    var c = d.counts || {}, lvl = clamp(+d.level || 0, 0, 3), sig = lvl + '|' + (c.banned || 0) + '|' + (c.secmon_critical || 0) + '|' + (c.secmon_high || 0);
    THREAT.level = lvl; THREAT.counts = c;
    if (sig !== THREAT.chip) { THREAT.chip = sig; statusRender(); }
  }
  function threatFrame(d) {
    if (!d || !d.up) return;
    threatChip(d);
    if (THREAT.seq === null) { THREAT.seq = d.seq; return; }         // first frame is the baseline, never an event
    if (d.seq !== THREAT.seq) { THREAT.seq = d.seq; var e = d.latest || (d.events && d.events[0]); if (e) threat(e); }
  }
  /* POLL ONLY, deliberately no EventSource: this page + showtime.js already hold 5 SSE sockets and Chrome allows
     6 per host - /api/threats/stream as the 6th was verified on the TV to wedge navigation (see STREAMS above)
     and would starve every fetch poll of a socket. A 5 s poll comparing `seq` costs one short request. */
  var threatPoll = null;
  function pollThreats() { fetch('/api/threats', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(threatFrame).catch(function () { }); }
  if (!NXF.nothreat) { pollThreats(); threatPoll = setInterval(pollThreats, 5000); }

  /* ============================== data ============================== */
  var S = { guests: [], nodes: [], gpus: [], flows: [], totals: {}, showtime: null, pools: [], storage: [], topo: null };
  function updatePlanetLabels() {
    FABKIND.forEach(function (k) {
      var L = k === 'gateway' ? L_gw : k === 'switch' ? L_sw : L_ap, m = fab[k].meta; if (!m) return;
      var mm = m.meta || {}, n = UNI.on ? uniChildren(fabIds[k]).length : moonState.filter(function (x) { return x.kind === k; }).length;
      // 2026-10-07 clarity: name + role + attachments; the live rates belong to the caption, not to every hub label
      var PR = UNI.planet[k] && UNI.recs[UNI.planet[k]], dn = m.status && m.status !== 'up';
      setLabelText(L, ((PR && shortName(PR.b)) || shortText(m.label) || cap1(k)) + (dn ? ' · down' : ''), '');
      setLabelClass(L, 'lbl planet' + (dn ? ' down' : '') + (PR && PR.b.lab ? ' lab' : ''));
    });
    flushLabelMeasure();
  }
  function pollAll() {
    fetch('/api/all', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) {
      var t0 = performance.now(); BOOT.all = true; S.lastAll = Date.now();
      S.tele = d.telemetry || null; S.guests = d.guests || []; S.nodes = d.nodes || []; S.pools = d.pools || []; S.storage = d.storage || []; S.zbx = d.zabbix || {}; S.unifi = d.unifi || {};
      S.edge = d.edge || null; S.external = d.external || null; S.backups = d.backups || null;
      NODES.forEach(function (n) { fillGuests(galaxies[n.id], guestsOf(n.id)); });
      try { exoUpdate(S.external); } catch (e) { console.error('nexus exo', e); }
      try { edgeUpdate(S.edge, S.external); } catch (e) { console.error('nexus edge', e); }
      if (S.edge && S.edge.threats && THREAT.seq === null) threatChip(S.edge.threats);
      hud();
      cpuMark('all', t0);
    }).catch(function () { BOOT.all = true; });
    fetch('/api/topology', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) {
      var t0 = performance.now(); BOOT.topo = true;
      S.topo = d; S.flows = d.flows || []; S.totals = d.totals || {};
      var gwN = null, swN = null, apN = null;
      (d.nodes || []).forEach(function (n) { if (n.kind === 'gateway') gwN = n; else if (n.kind === 'switch') swN = n; else if (n.kind === 'ap') apN = n; });
      if (gwN) { fabIds.gateway = gwN.id; fab.gateway.meta = gwN; fab.gateway.down = gwN.status !== 'up'; }
      if (swN) { fabIds.switch = swN.id; fab.switch.meta = swN; fab.switch.down = swN.status !== 'up'; }
      if (apN) { fabIds.ap = apN.id; fab.ap.meta = apN; fab.ap.down = apN.status !== 'up'; }
      fillFabric((d.nodes || []).filter(function (n) { return n.kind === 'client'; }));
      var linkBps = {}; (d.links || []).forEach(function (l) { linkBps[l.source + '>' + l.target] = +l.bps || 0; });
      /* the bridge carries every measured flow BETWEEN two different configured
         nodes (not one hardcoded pair), so a third node's NFS traffic is on it too */
      var bridge = 0; S.flows.forEach(function (f) {
        var a = /^pve:(.+)$/.exec(String(f.src || '')), b = /^pve:(.+)$/.exec(String(f.dst || ''));
        if (a && b && a[1] !== b[1] && NODE_BY_ID[a[1]] && NODE_BY_ID[b[1]]) bridge += +f.bps || 0;
      });
      FAM.bridge.bps = bridge; FAM.bridge_r.bps = bridge; FAM.wan_in.bps = +S.totals.wan_rx_bps || 0; FAM.wan_out.bps = +S.totals.wan_tx_bps || 0;
      if (fabIds.gateway) {
        NODES.forEach(function (n) { if (UP_FAM[n.id]) FAM[UP_FAM[n.id]].bps = linkBps[fabIds.gateway + '>pve:' + n.id] || 0; });
      }
      // routed through setLabelText (not a direct .textContent poke) so the shrink-wrapped
      // box gets re-measured whenever the sub-line's length changes — see labelsTick's use
      // of L.w for the true edge-clipping guard
      setLabelText(L_bridge, BRIDGE_TITLE + ' · ' + (bridge > 0 ? fmtBps(bridge) : 'idle'), '');
      setLabelText(L_sun, 'Internet · ' + fmtBps(FAM.wan_in.bps) + ' in · ' + fmtBps(FAM.wan_out.bps) + ' out', '');
      updatePlanetLabels();
      refreshLabels();                                                     // client label content (rx/tx) just moved
      cpuMark('topo', t0);
    }).catch(function () { BOOT.topo = true; });
  }
  function pollShowtime() {
    fetch('/api/showtime', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) { S.showtime = d; hud(); }).catch(function () { });
    fetch('/api/gpu').then(function (r) { return r.json(); }).then(function (j) { S.gpus = (j && j.gpus) || []; hud(); }).catch(function () { });
  }
  setInterval(pollAll, 6000); pollAll();
  setInterval(pollTour, 15000); pollTour();
  setInterval(pollShowtime, 5000); pollShowtime();

  /* ============================== HUD (2026-10-08 production chrome, docs/contracts.md) ==============================
     Everything the old HUD showed is still here, presented the way a NOC product does it:
       #status   the estate's state, never rotates: hosts down (critical), open problems (warning), services, threat
                 level (plain words, not a mood colour), viewers. Colour + a dot shape carry status, nothing else.
       #card-*   one card per Proxmox node, a title plus five rows; longer row lists page every CARD_S seconds (fade).
       #alert    real alarms only (hosts down, the backend's alert mode reason, a security finding): hidden otherwise.
       #updated  a stale marker ("Data 40 s old") instead of a permanent LIVE badge. */
  var AUD = { now: 0, hour: 0, hit: 0 };
  function audHit() { AUD.hit = 1.4; var el = $('st-viewers'); if (el) el.classList.add('hit'); }
  function audTick(dt) { if (AUD.hit > 0) { AUD.hit -= dt; if (AUD.hit <= 0) { var el = $('st-viewers'); if (el) el.classList.remove('hit'); } } }
  var CARD_S = 9, CARDS = { page: 0, pageR: 0, t: 0, tR: CARD_S / 2, rows: {}, shown: {} };   // the two cards turn half a period apart, never together
  var unit = function (u) { return '<small>' + u + '</small>'; };
  var num = function (v, d) { return (v == null || isNaN(v)) ? '—' : Number(v).toFixed(d || 0); };
  function hRow(k, v, cls, id) { return '<div class="r' + (cls ? ' ' + cls : '') + '"' + (id ? ' id="' + id + '"' : '') + '><span class="k">' + esc(k) + '</span><span class="v">' + v + '</span></div>'; }
  function hDot(k, v, cls, id) { return '<div class="r ' + (cls || '') + '"' + (id ? ' id="' + id + '"' : '') + '><i class="dot"></i><span class="k">' + esc(k) + '</span><span class="v">' + v + '</span></div>'; }
  function hBar(k, pct, v, cls) {
    pct = clamp(+pct || 0, 0, 100); var bc = pct >= 95 ? 'crit' : pct >= 85 ? 'warn' : '';
    return '<div class="r' + (cls ? ' ' + cls : '') + '"><span class="k">' + esc(k) + '</span><i class="bar"><b class="' + bc + '" style="width:' + pct.toFixed(0) + '%"></b></i><span class="v">' + v + '</span></div>';
  }
  function gpuName(n) { return String(n || '').replace(/NVIDIA\s+/i, '').replace(/GeForce\s+/i, ''); }
  function tb(b) { return (b / 1099511627776).toFixed(1); }
  function relAgo(sec) { sec = Math.max(0, sec); return sec < 3600 ? Math.round(sec / 60) + ' min ago' : sec < 86400 ? Math.round(sec / 3600) + ' h ago' : Math.round(sec / 86400) + ' d ago'; }
  /* backups: the backend's authoritative /api/all `backups` block (pbs_exporter, the same one the wall reads), not the
     Prometheus pbs_vms/pbs_stale telemetry, which counts differently (it said "8 stale of 111" while PBS had 103 / 110
     backed, 7 never backed, 0 older than 7 d). Plain facts like the wall: "103 / 110 · 7 missing"; warn only when
     something is missing or older than 7 d; a broken or absent feed reads "unknown", never a red zero. */
  function backupsRow() {
    var b = S.backups;
    if (!b || b.unknown || b.error || (b.guests == null && b.backed == null)) return hRow('Backups', '<small>unknown</small>');
    var miss = +b.missing || 0, st7 = +b.stale7 || 0, v = (b.backed != null ? b.backed : '—') + ' / ' + (b.guests != null ? b.guests : '—');
    if (miss) v += ' · ' + miss + unit(' missing');
    if (st7) v += ' · ' + st7 + unit(' > 7 d old');
    if (!miss && !st7 && b.newest_age_h != null) v += unit(' · newest ' + (b.newest_age_h < 1 ? '< 1 h' : Math.round(b.newest_age_h) + ' h') + ' ago');
    if (b.stale) v += unit(' · as of ' + relAgo(+b.age_s || 0));
    return hRow('Backups', v, miss || st7 ? 'warn' : '');
  }
  /* the node's last vzdump run (/api/all backups.runs[], 2026-10-09 backend, optional): "05:00 · 17 / 17 ok"; a partial run
     warns ("03:00 · 5 / 6 ok · 1 failed"), a failed one is critical, a run in progress is neutral ("Running · 4 done"),
     a last run older than 30 h warns with its age. Absent field or no row for this node = no row. */
  function backupRunRow(id) {
    var runs = S.backups && S.backups.runs; if (!runs || !runs.length) return null;
    var r = null; for (var i = 0; i < runs.length; i++) if (runs[i] && runs[i].node === id && (!r || (+runs[i].start || 0) > (+r.start || 0))) r = runs[i];
    if (!r) return null;
    if (r.running || r.state === 'running') { var rn = r.running || {}; return hRow('Last backup', 'Running' + (rn.done != null ? ' · ' + rn.done + unit(' done') : '')); }
    var t = r.start ? new Date(r.start * 1000) : null, hhmm = t ? ('0' + t.getHours()).slice(-2) + ':' + ('0' + t.getMinutes()).slice(-2) : '—';
    var v = hhmm + ' · ' + (r.ok != null ? r.ok : '—') + ' / ' + (r.guests != null ? r.guests : '—') + unit(' ok');
    if (+r.failed) v += ' · ' + r.failed + unit(' failed');
    var age = r.end ? (Date.now() / 1000 - r.end) / 3600 : (r.age_h != null ? +r.age_h : 0), old = age > 30;
    if (old) v += unit(' · ' + relAgo(age * 3600));
    return hRow('Last backup', v, r.state === 'failed' ? 'crit' : (r.state === 'partial' || +r.failed || old) ? 'warn' : '');
  }
  // one Proxmox node's rows, most important first (page 1 = the first five)
  function nodeRows(id) {
    var nd0 = S.nodes.filter(function (x) { return x.node === id; })[0], nd = nd0 || {}, rows = [];
    if (!nd0) {                                                 // a new node the stats feed has not reported yet: what is known, no zeros
      var gl0 = guestsOf(id), host = null; Object.keys(UNI.recs).forEach(function (k) { var R = UNI.recs[k]; if (R.role === 'core' && R.F && R.F.gal && R.F.gal.nd.id === id) host = R.b; });
      rows.push(hRow('Guests', gl0.filter(function (g) { return g.status === 'running'; }).length + ' / ' + gl0.length + unit(' running')));
      if (host) rows.push(hRow('Host', host.status === 'down' ? 'down' : 'up', host.status === 'down' ? 'crit' : ''));
      rows.push(hRow('CPU / memory', '<small>not reported yet</small>'));
      var br0 = backupRunRow(id); if (br0) rows.push(br0);
      return rows;
    }
    var memp = nd.mem_total ? nd.mem_used / nd.mem_total * 100 : 0;
    rows.push(hBar('CPU', nd.cpu || 0, num(nd.cpu, 0) + unit('%')));
    rows.push(hBar('Memory', memp, fmtGB(nd.mem_used || 0) + ' / ' + fmtGB(nd.mem_total || 0) + unit(' GB')));
    rows.push(hRow('Load', num(nd.load, 1) + ' / ' + (nd.cores || '—') + unit(' cores')));
    var br = backupRunRow(id); if (br) rows.push(br);
    var T = S.tele && S.tele.up ? S.tele : null, st = S.showtime || {};
    /* the GPUs a node owns: /api/gpu entries carry `host` when the dashboard knows it, else they are local to the first
       configured node. That node leads with GPU rows; the featured node (CONFIG.featured_node) carries the estate-wide
       rows (backups, power, SLOs, the edge). */
    var mine = S.gpus.filter(function (g) { return g.host ? g.host === id : id === CFG_NODES[0].id; });
    if (mine.length) {
      mine.forEach(function (g) { rows.push(hBar(gpuName(g.name), g.util || 0, (g.util || 0) + unit('%') + ' · ' + num(g.temp) + unit(' °C'))); });
      mine.forEach(function (g) { rows.push(hBar(gpuName(g.name).replace(/^(RTX|GTX)\s+/, '') + ' VRAM', g.mem_total ? g.mem_used / g.mem_total * 100 : 0, (g.mem_used / 1024).toFixed(1) + ' / ' + (g.mem_total / 1024).toFixed(0) + unit(' GB'))); });
      rows.push(hRow('GPU power', mine.map(function (g) { return Math.round(g.power || 0); }).join(' + ') + unit(' W')));
      (st.ollama || []).forEach(function (o) { var m = (o.loaded || []).map(function (x) { return x.name; }).join(', '); if (m) rows.push(hRow('Ollama ' + o.name, esc(m), (o.loaded || []).some(function (x) { return x.busy; }) ? '' : '')); });
      var cor = st.coral; if (cor) rows.push(hRow('Detector', esc(cor.model || cor.detector || '—') + (cor.inference_ms != null ? ' · ' + cor.inference_ms.toFixed(1) + unit(' ms') : '')));
      if (T) {
        if ((T.smart_n || {})[id] != null) rows.push(hRow('Drives', num((T.smart_n || {})[id]) + ' ok · ' + num((T.smart_hot || {})[id]) + unit(' °C')));
        if (T.llm_req_h > 0 || T.llm_tok_h > 0) rows.push(hRow('LLM gateway', num(T.llm_req_h) + unit(' req/h')));
      }
    } else {
      S.pools.filter(function (p) { return p.node === id; }).forEach(function (p) {
        var bad = p.health && p.health !== 'ONLINE';
        rows.push(hBar('ZFS ' + p.name, p.size ? p.alloc / p.size * 100 : 0, bad ? esc(String(p.health).toLowerCase()) : tb(p.alloc) + ' / ' + (p.size / 1099511627776).toFixed(0) + unit(' TB'), bad ? 'crit' : ''));
      });
    }
    if (id === FEATURED) {
      rows.push(backupsRow());                                    // its own feed: stays even when Prometheus telemetry is down
      if (T) {
        if (!mine.length && (T.smart_n || {})[id] != null) rows.push(hRow('Drives', num((T.smart_n || {})[id]) + ' ok · ' + num((T.smart_hot || {})[id]) + unit(' °C'), T.smart_bad ? 'crit' : ''));
        rows.push(hRow('Power', num(T.watts) + unit(' W') + ' · ' + num(T.inlet_c) + unit(' °C inlet')));
        var em = st.emby; if (em) rows.push(hRow('Emby', plural(em.count || 0, 'session') + ((em.playing || []).length ? ' · ' + em.playing.length + ' playing' : '')));
        rows.push(hRow('SLO', (T.slo_total ? T.slo_ok + ' / ' + T.slo_total + ' up' : '—'), T.slo_total && T.slo_ok < T.slo_total ? 'warn' : ''));
        var Ecf = (S.edge && S.edge.cloudflare) || {}, Ecs = (S.edge && S.edge.crowdsec) || {};
        rows.push(hRow('Cloudflare', Ecf.up ? num(Ecf.ha_connections) + ' conn · ' + num(Ecf.req_per_min) + unit(' req/min') : 'down', Ecf.up ? '' : 'warn'));
        // the security facts come from /api/tour (Prometheus) when present: a CrowdSec export can read a false 0
        var aSec = aspOf('asp:security'), secF = function (k) { var f = aSec && (aSec.facts || []).filter(function (x) { return x.k === k; })[0]; return f ? esc(f.v) + (f.u ? unit(' ' + esc(f.u)) : '') : null; };
        if (secF('Attacks 24h')) rows.push(hRow('Attacks', secF('Attacks 24h') + unit(' / 24 h')));
        else rows.push(hRow('Attacks', Ecs.up ? num(Ecs.alerts_24h) + unit(' / 24 h') : num(T.cs_alerts_h) + unit(' / h')));
        var La = null; (Ecs.top_attackers || []).forEach(function (a) { if (a && a.ts && (!La || a.ts > La.ts)) La = a; });
        if (La) rows.push(hRow('Last attack', relAgo(Date.now() / 1000 - La.ts) + ' · ' + esc(La.cn || '??') + ' · ' + esc(String(La.scenario || '').replace(/^crowdsecurity\//, ''))));
        if (secF('Banned IPs')) rows.push(hRow('Banned IPs', secF('Banned IPs')));
        else if (Ecs.up) rows.push(hRow('Banned IPs', num(Ecs.banned)));
        rows.push(hRow('Flow export', num(T.flows_fps, 1) + unit(' flows/s')));
      }
    }
    return rows;
  }
  // a card = title + meta + one page of five rows. A page turn fades out, swaps and fades back in; a data refresh on the
  // same page only rewrites the rows (no animation), so nothing blinks on every poll. pages: [{title, meta, rows[]}]
  function cardRender(el, key, pages, pi) {
    if (!el || !pages.length) return;
    if (!el.firstChild) el.innerHTML = '<div class="ph"><b></b><em></em></div><div class="rows"></div>';
    pi = pi % pages.length; var P = pages[pi];
    var dots = pages.length > 1 ? pages.map(function (q, j) { return '<i' + (j === pi ? ' class="on"' : '') + '></i>'; }).join('') : '';
    var head = esc(P.meta) + dots, body = P.rows.join(''), ph = el.firstChild, rw = el.lastChild, prev = CARDS.shown[key];
    var swap = function () { if (ph.firstChild.textContent !== P.title) ph.firstChild.textContent = P.title; if (ph.lastChild.innerHTML !== head) ph.lastChild.innerHTML = head; };
    if (prev && prev.pi !== pi) {
      rw.classList.add('fade'); CARDS.shown[key] = { pi: pi, body: body };
      setTimeout(function () { swap(); rw.innerHTML = CARDS.shown[key].body; rw.classList.remove('fade'); }, 360);
    } else {
      if (!prev) swap(); else if (!rw.classList.contains('fade')) swap();
      if (!prev || prev.body !== body) { CARDS.shown[key] = { pi: pi, body: body }; if (!rw.classList.contains('fade')) rw.innerHTML = body; }
    }
  }
  function nodePages(id) {
    var R = CARDS.rows[id], out = []; if (!R) return out;
    var np = Math.max(1, Math.ceil(R.rows.length / 5)), per = Math.ceil(R.rows.length / np);   // balanced: 11 rows = 4 + 4 + 3
    for (var i = 0; i < R.rows.length; i += per) out.push({ title: R.title, meta: R.meta, rows: R.rows.slice(i, i + per) });
    return out;
  }
  // lab gear (Zabbix lab group, lab-* hosts, registry lab:true names) never counts as a host down: it is a bench, not the estate
  function isLabHost(h, a) {
    if ((a && a.lab) || /^lab[-_]/i.test(h)) return true;
    var k = String(h).toLowerCase(), hit = false;
    Object.keys(UNI.recs).forEach(function (id) { var b = UNI.recs[id].b; if (b && b.lab && (String(b.label || '').toLowerCase() === k || String(b.short || '').toLowerCase() === k)) hit = true; });
    return hit;
  }
  /* ============================== problems, one vocabulary (docs/contracts.md, 2026-10-10) ==============================
     "<short host> · <short problem>", grouped by host (worst kept), worst first, lab last; at most 3 then "+N more".
     Red only for a real outage (sev >= 4 on a non-lab host), amber for warnings, lab never red. The source is the
     backend's normalised /api/tour problems when present; otherwise the same rules applied here to Zabbix alert_hosts
     (so the TV behaves when /api/tour is absent). A security finding and the backend's alert mode join the same list. */
  function normKey(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }
  var HOSTMAP = { sig: '', m: {} };
  function hostShort(h) {
    var ids = Object.keys(UNI.recs), sig = String(ids.length);
    if (HOSTMAP.sig !== sig) {
      HOSTMAP.sig = sig; HOSTMAP.m = {};
      ids.forEach(function (id) { var b = UNI.recs[id].b; if (!b || !b.short) return; [b.label, b.short].forEach(function (x) { var k = normKey(x); if (k && !HOSTMAP.m[k]) HOSTMAP.m[k] = b.short; }); });
    }
    return HOSTMAP.m[normKey(h)] || clip(String(h || ''), 18);
  }
  var PROB_PHRASE = [
    [/unavailable by icmp|icmp.*unavailable|no ping/i, 'ping unavailable'], [/icmp.*(response time|ping time)|high ping/i, 'high ping'],
    [/icmp.*loss|packet loss/i, 'packet loss'], [/unreachable/i, 'unreachable'], [/system status is in critical/i, 'status critical'],
    [/too many processes/i, 'too many processes'], [/swap/i, 'high swap'], [/disk space|free disk|filesystem.*(full|space)/i, 'disk space warning'],
    [/high cpu|cpu utili[sz]ation/i, 'high CPU'], [/memory/i, 'high memory'], [/restarted|has been restarted/i, 'restarted'],
    [/certificate.*expir|ssl.*expir|tls.*expir/i, 'TLS cert expiring'], [/smtp/i, 'SMTP down']];
  function probText(host, name) {
    var t = String(name || ''), m;
    m = /(LXC|VM)\s*\[[^\]]*\((?:lxc|qemu)\/(\d+)\)[^\]]*\]\s*:?\s*not running/i.exec(t); if (m) return (m[1].toUpperCase() === 'LXC' ? 'CT ' : 'VM ') + m[2] + ' not running';
    m = /^Interface\s+([^:(]+?)\s*(?:\(([^)]*)\))?\s*:\s*(.+)$/i.exec(t); if (m) return ((m[2] || m[1]).trim() + ' ' + m[3].trim().toLowerCase()).trim();
    m = /port\s+(\d+)\s+(?:is\s+)?not responding/i.exec(t); if (m) return 'port ' + m[1] + ' not responding';
    for (var i = 0; i < PROB_PHRASE.length; i++) if (PROB_PHRASE[i][0].test(t)) return PROB_PHRASE[i][1];
    t = t.replace(/\s*\((?:CT|VM|LXC|QEMU)\s*\d+\)|\s*\((?:lxc|qemu)\/\d+\)|\s*\(synthetic\)|\s*\([^)]*\)/gi, '').replace(/^(?:[A-Za-z][\w .\/-]{0,24}:\s+)+/, '');
    [host, hostShort(host)].forEach(function (h) { if (h) t = t.replace(new RegExp('\\b' + String(h).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'ig'), ''); });
    t = t.replace(/\s+(on|for|of|at)\s*$/i, '').replace(/^\s*(is|has|on)\s+/i, '').replace(/\s{2,}/g, ' ').trim();
    if (t && !/^[A-Z0-9]{2,}\b/.test(t)) t = t.charAt(0).toLowerCase() + t.slice(1);
    return clip(t || 'problem', 28);
  }
  function probSev(v) {
    if (typeof v === 'number') return v;
    v = String(v || '').toLowerCase();
    return /crit|disaster|high|down/.test(v) ? 4 : /warn|average/.test(v) ? 3 : /info|low/.test(v) ? 1 : (+v || 0);
  }
  var PROB = { list: [], src: '' };
  function probList() {
    var out = [], tp = TOUR.ok && Array.isArray(TOUR.problems) ? TOUR.problems : null;
    if (tp) tp.forEach(function (p) { if (p && p.host) out.push({ host: String(p.host), text: String(p.text || 'problem'), sev: probSev(p.sev), lab: !!p.lab }); });
    else {
      var ah = (S.zbx && S.zbx.alert_hosts) || {}, by = {};
      Object.keys(ah).forEach(function (h) {
        var a = ah[h] || {}, nm = (a.names || [])[0] || '', lab = isLabHost(h, a) || /^demo[-_]/i.test(h) || /\(synthetic\)/i.test(nm);
        var sh = hostShort(h), k = normKey(sh), p = { host: sh, text: probText(h, nm), sev: +a.sev || 0, lab: lab };
        if (!by[k] || p.sev > by[k].sev) by[k] = p;
      });
      Object.keys(by).forEach(function (k) { out.push(by[k]); });
    }
    out = out.filter(function (p) { return p.sev >= 2; });
    out.forEach(function (p) { p.cls = p.lab ? 'lab' : p.sev >= 4 ? 'crit' : 'warn'; });
    var rank = { crit: 0, warn: 1, lab: 2 };
    out.sort(function (a, b) { return (rank[a.cls] - rank[b.cls]) || (b.sev - a.sev); });
    if (THREAT.secOn) out.unshift({ host: 'Security', text: THREAT.secTitle ? clip(sentence(THREAT.secTitle).toLowerCase(), 28) : 'finding', sev: 4, cls: 'crit' });
    var why = document.body.classList.contains('st-alert') ? (((document.querySelector('#st-alert .why') || {}).textContent) || '').trim() : '';
    if (why && why !== '—') out.splice(out.filter(function (p) { return p.cls === 'crit'; }).length, 0, { host: 'Alert', text: clip(why.toLowerCase(), 28), sev: 3, cls: 'warn' });
    PROB.list = out; PROB.src = tp ? 'tour' : 'zabbix';
    return out;
  }
  function critHosts() { return PROB.list.filter(function (p) { return p.cls === 'crit' && p.host !== 'Security' && p.host !== 'Alert'; }).map(function (p) { return p.host; }); }
  var THREAT_WORD = ['Normal', 'Elevated', 'High', 'Critical'];
  var ALERT = { html: '', cls: '', t: 0 };
  // the chip: never wider than its content, top centre inside the header band (never on the subject). A content change
  // fades out, swaps, fades in (§9.4); the chip itself fades rather than display-toggling.
  function alertRefresh() {
    var list = probList(), html, cls;
    if (!list.length) { html = '<span class="p ok"><i></i>All systems normal</span>'; cls = 'calm'; }
    else {
      html = list.slice(0, 3).map(function (p) { return '<span class="p ' + p.cls + '"><i></i>' + esc(p.host) + ' · ' + esc(p.text) + '</span>'; }).join('')
        + (list.length > 3 ? '<span class="more">+' + (list.length - 3) + ' more</span>' : '');
      cls = list[0].cls === 'crit' ? 'crit' : 'calm';
    }
    if (html === ALERT.html && cls === ALERT.cls) return;
    var el = $('alert'), first = !ALERT.html;
    ALERT.html = html; ALERT.cls = cls;
    if (first) { el.innerHTML = html; el.className = 'hud on ' + cls; return; }
    el.classList.add('swap'); clearTimeout(ALERT.t);
    ALERT.t = setTimeout(function () { el.innerHTML = ALERT.html; el.className = 'hud on ' + ALERT.cls; }, 320);
  }
  function statusRender() {
    if (!PROB.src) probList();
    var crit = critHosts().length, warns = PROB.list.filter(function (p) { return p.cls === 'warn'; }).length, lvl = THREAT.level || 0, c = THREAT.counts || {};
    var all = allGuests(), upAll = all.filter(function (g) { return g.status === 'running'; }).length;
    var rows = [
      hDot('Outages', String(crit), crit ? 'crit' : 'ok'),                 // the same list (and words) as the chip, §9.3
      hDot('Warnings', String(warns), warns ? 'warn' : 'ok'),
      hDot('Services', upAll + ' / ' + all.length + unit(' running'), ''),
      hDot('Threat level', THREAT_WORD[lvl] + (c.banned ? ' · ' + c.banned + unit(' banned') : ''), lvl >= 2 ? 'crit' : lvl === 1 ? 'warn' : 'ok'),
      hDot('Viewers', edgeInfo.audience ? edgeInfo.viewers + unit(' now') + ' · ' + edgeInfo.viewers1h + unit(' / h') : Math.round(edgeInfo.rpm) + unit(' req/min'), '', 'st-viewers')
    ].join('');
    var rw = $('status-rows'); if (rw.innerHTML !== rows) { rw.innerHTML = rows; if (AUD.hit > 0) { var v = $('st-viewers'); if (v) v.classList.add('hit'); } }
    var m = UNI.on && UNI.counts ? (UNI.counts.total || 0) + ' devices' : ((S.unifi && S.unifi.clients) || 0) + ' clients';
    var mm = $('status-m'); if (mm.textContent !== m) mm.textContent = m;
  }
  function hud() {
    NODES.forEach(function (n) {
      if (n.gone) { delete CARDS.rows[n.id]; return; }
      var nd = S.nodes.filter(function (x) { return x.node === n.id; })[0] || {}, gl = guestsOf(n.id);
      var up = gl.filter(function (g) { return g.status === 'running'; }).length, memp = nd.mem_total ? nd.mem_used / nd.mem_total * 100 : 0;
      CARDS.rows[n.id] = { title: nodeName(n.id), meta: up + ' / ' + gl.length + ' guests', rows: nodeRows(n.id) };
      setLabelText(L_gal[n.id], nodeName(n.id) + ' · ' + plural(gl.length, 'guest'), '');
      // scene: core size follows memory in use; spin TARGET only (the loop eases gal.spin toward it, MOTION.SPIN_TAU)
      var gal = galaxies[n.id]; gal.coreR = 16 + memp * 0.16; gal.spinT = MOTION.spin(nd.cpu);
    });
    cardsRender();
    alertRefresh(); statusRender();                              // the chip builds PROB.list, the Estate panel counts from it
    refreshLabels();                                            // guest numbers (cpu/mem) just moved
  }
  // the left card is the first composed node; the right card pages through every other node (growth nodes included), so
  // a new Proxmox node joins the rotation instead of adding a third panel
  function cardsRender() {
    var gp = nodePages(NA.id); if (gp.length) cardRender($('card-l'), 'l', gp, CARDS.page);
    var right = []; NODES.forEach(function (n) { if (n.id !== NA.id) right = right.concat(nodePages(n.id)); });
    if (right.length) cardRender($('card-r'), 'r', right, CARDS.pageR);
  }
  // once a second (animate's dataset tick): the stale marker, the backend's alert mode and the overview-only legend row
  var HUD1 = { st: null, upd: null, over: null };
  function hudSecond() {
    var age = S.lastAll ? (Date.now() - S.lastAll) / 1000 : 0, u = age > 30 ? 'Data ' + Math.round(age) + ' s old' : '';
    if (u !== HUD1.upd) { HUD1.upd = u; $('updated').textContent = u; }
    var st = document.body.classList.contains('st-alert'); if (st !== HUD1.st) { HUD1.st = st; alertRefresh(); }
    var ov = LABEL.mode === 'over' && !SC.active; if (ov !== HUD1.over) { HUD1.over = ov; document.body.classList.toggle('nx-over', ov); }
    // free roam writes its caption once per stop: keep the live sub-line current (it read "0 / 0 services" until the next stop)
    if (D.mode === 'free' && !SC.active && !TC.on && !THREAT.capHold && CAP_CUR && D.subject) setCaption(CAP_CUR, subFor(D.subject));
  }
  function cardTick(dt) {
    CARDS.t += dt; CARDS.tR += dt;
    if (CARDS.t >= CARD_S) { CARDS.t = 0; CARDS.page++; cardsRender(); }
    if (CARDS.tR >= CARD_S) { CARDS.tR = 0; CARDS.pageR++; cardsRender(); }
  }
  /* ============================== beat ============================== */
  var beat = 0, beatSev = 0;
  (function () {
    if (typeof EventSource !== 'function') return;
    /* 2026-10-07: the data heartbeat only breathes the cores now. It used to fire both galaxies' shockwave rings and a
       bloom bump on every pulse - every 2.5-4 s, and `sev` is the estate's standing problem level (3 for days at a time),
       not an event - so the camera saw ring after ring, red, competing with the one arrival accent per stop. The
       severity still shows: a harder core breath. Real intrusions keep their own visual (threat cut, shield ring). */
    sse('/api/pulse/stream', function (ev) {
      try { var d = JSON.parse(ev.data); beatSev = d.sev || 0; beat = beatSev >= 3 ? 0.7 : 0.45; } catch (e) { }
      // the page's only pulse socket: showtime.js (NB_PULSE_SHARED, set in nexus.html) listens to this re-broadcast
      try { window.dispatchEvent(new CustomEvent('nb:pulse', { detail: ev.data })); } catch (e) { }
    });
  })();

  /* ============================== loop ============================== */
  var clock = new THREE.Clock();
  var RENDER_ACTIVE = true, animRunning = true;
  var SIM_PAUSE = false, QA_HOLD = false;
  function animate() {
    // Room empty (see /api/presence): drop the rAF chain; the SSE below restarts it.
    if (!RENDER_ACTIVE) { animRunning = false; return; }
    requestAnimationFrame(animate);
    var dt = Math.min(clock.getDelta(), MOTION.DT_MAX);
    if (SIM_PAUSE) return;
    if (QA_HOLD) dt = 0;                         // QA: keep rendering the SAME instant (A/B of render paths on identical frames)                       // NEXUS.sim() is stepping the scene by hand
    var c0 = performance.now();
    frame(dt);
    if (RS.pending) rsApply();                   // a render-scale step lands BEFORE this frame's render, never mid-chain
    perfBegin(); composer.render(); perfEnd();
    lsTick(c0);
    bootTick();
    perfTick(c0, performance.now() - c0);
    // live state for the verifier (final_verify.py reads body.dataset): one string build + at most one DOM write per second
    dsAcc += dt; dsFrames++;
    if (dsAcc >= 1) {
      var dsS = 'nodes=' + NODES.length + ' director=' + (SC.active ? 'showcase' : TC.on ? 'cut:' + TC.kind : D.mode) + ' stop=' + (D.stopKey || '') + ' cap=' + (CAP_CUR || '')
        + ' phase=' + (SC.active ? 'showcase' : (D.mode === 'sync' ? D.inTravel : D.t < 1) ? 'travel' : 'hold') + ' threat=' + THREAT.level + ' fps=' + Math.round(dsFrames / dsAcc)
        + ' viewers=' + edgeInfo.viewers + '/' + edgeInfo.viewers1h + ' countries=' + edgeInfo.countries + ' audience=' + (edgeInfo.audience ? 'up' : 'down') + ' queue=' + viewQueue()
        + ' universe=' + (UNI.on ? Object.keys(UNI.recs).length + '/' + UNI.n : 'off') + ' move=' + (D.lastMove || 'none')
        + ' rs=' + RS.s.toFixed(2) + ' gpu=' + (PERF.ext ? PERF.p75.toFixed(1) : 'na');
      if (dsS !== dsStr) { dsStr = dsS; document.body.dataset.nexus = dsS; }
      dsAcc = 0; dsFrames = 0;
      hudSecond();
    }
  }
  /* one simulation step: everything that moves, integrated over the (clamped) dt. No rendering here, so
     NEXUS.sim() can step it at any forced frame rate to prove motion is frame-rate independent. */
  function frame(dt) {
    SIM_T += dt; var t = SIM_T; U_HUD.value = SC.active ? 0 : 1;
    skyTick(dt);
    U_TIME.value = t;
    beat = Math.max(0, beat - dt * 0.9);
    var alert = document.body.classList.contains('st-alert'), night = document.body.classList.contains('st-night');
    // shared projected-radius cap for every core/sun mesh: 0.18 * half-VFOV, i.e. a world-space
    // sphere at that angle projects to ~9% of the screen's height regardless of camera distance
    // (small-angle: projected half-height fraction = angle/halfVFOV, and we want that <= 0.18)
    var maxCoreAngle = 0.18 * ((cam.fov * Math.PI / 180) / 2);
    NODES.forEach(function (n) {
      var g = galaxies[n.id];
      if (g.O.visible === !!n.gone) g.O.visible = !n.gone;
      if (n.gone) { OBSTACLES[g.obIdx].active = false; return; }
      // frozen during the showcase: buildShowcase() bakes every chapter's camera/look
      // target from a ONE-TIME snapshot of each guest star's world position (galaxyBounds/
      // categoryCluster call gal.G.localToWorld() once, at build time) but a chapter near
      // the end of the ~3-minute loop doesn't play for another minute or more — verified on
      // the real screen: by the time a late chapter arrived, this rotation had carried
      // the actual stars well away from the frozen look-target, so the shot framed empty sky
      // (with only the distant sun's halo, still on its old bearing, left dominating the frame).
      // Freezing rotation for the run keeps every baked shot valid for its entire lifetime;
      // the lockstep/free directors don't need this since they compute shots fresh right
      // before each hold/travel, only a few seconds before they're used.
      if (g.spinT != null) g.spin += (g.spinT - g.spin) * (1 - Math.exp(-dt / MOTION.SPIN_TAU));
      if (!SC.active) g.G.rotation.y += dt * g.spin * (n.rot || n.spin);
      // computed once up front: feeds the core shader AND the halo/light below, so a close
      // showcase dwell dims the whole core+glow+light group together instead of just the core
      // mesh (the halo sprite alone was still blowing out to a full-screen wash close-up).
      // Far threshold is intentionally generous (not just coreR*9): verified on the real screen
      // that a category close-up's camera sits ~200-500 units from the CORE even though it's
      // framing a cluster nowhere near that core — well past the old far bound, so it got zero
      // damping and still bloomed to a flat white disc despite never being "close" in the
      // close-up sense. This is the dominant source of the reported core blow-out.
      var camDistG = cam.position.distanceTo(g.world);
      var near = nearFactor(camDistG, g.coreR * 2, Math.max(650, g.coreR * 22));
      var rDesired = g.coreR * (1 + Math.sin(t * 0.8) * 0.03 + beat * 0.16);
      // projected-radius cap, independent of coreR: coreR grows with the node's memory in
      // use (hud(), ~16 to ~32+ world units) but that's an unbounded live metric, not a
      // screen budget — verified on screen that a ~104GB-used core, uncapped,
      // projected to a near-full-height white disc in that node's chapters, burying its
      // own guest labels. maxCoreAngle is a FRACTION of the camera's actual half-VFOV, so the
      // cap tracks any FOV/aspect change too, not just a hand-tuned world-space constant.
      var r = Math.min(rDesired, camDistG * Math.tan(maxCoreAngle));
      // HDR bulge: a soft profile reads ~0.7 of its mesh radius, and a bulge is oblate (flattened along the disc normal = G's y)
      if (HDR) g.core.scale.set(r * 1.35, r * 0.95, r * 1.35); else { g.core.scale.setScalar(r); g.core.rotation.y += dt * 0.25; g.core.rotation.x += dt * 0.07; }
      g.coreMat.uniforms.pulse.value = beat * (beatSev >= 3 ? 1 : 0.6);
      // halo size capped as a fraction of camera distance (not just its own near/far opacity
      // ramp) — a sprite with a fixed world-space scale reads fine from the distance it was
      // tuned at but increasingly dominates the frame as the camera closes in from any other
      // shot, exactly the additive-bloom-to-white effect seen on the galaxy establishing shots
      // TEX_GLOW's hot centre is much tighter than TEX_STAR's, so the sprite is scaled up to
      // put its long soft skirt where the old flat disc used to end
      var hs = Math.min(r * 6.5 + beat * 30, camDistG * 0.38); g.halo.scale.set(hs, hs, 1);
      /* 2026-10-09: a close-up (host / category stop) used to burn the bulge to a flat white disc (0.5-0.8 % of the core
         crop at 255 in all channels, measured at 4K): the bulge's own gain and the halo sprite now ease down
         with closeness, so the photographed bulge keeps its gradient and dust lanes up close; wide shots are untouched */
      g.halo.material.opacity = 0.42 * g.haloK * (1 - 0.78 * near) * TVL.halo;   // 0.42: the A/C value (the 2026-10-07 restraint had 0.3); half over a shared plate
      if (g.coreGain0 == null) g.coreGain0 = g.coreMat.uniforms.gain.value;
      g.coreMat.uniforms.gain.value = g.coreGain0 * (1 - 0.4 * near * TVL.core);
      g.light.intensity = (2.5 + beat * 5) * (1 - 0.3 * near); g.light.color.setHex(alert ? 0xff5a6a : n.accent);
      if (g.ringRed > 0) g.ringRed -= dt;
      if (g.ringT < 1.4) { g.ringT += dt; var s = r + g.ringT * 190; g.ring.scale.set(s, s, s); g.ring.material.opacity = 0.5 * (1 - g.ringT / 1.4); g.ring.material.color.setHex((alert || g.ringRed > 0) ? 0xff5a6a : n.accent); }
      else g.ring.material.opacity = 0;
      edgeOnTick(g); discTick(g, near, dt);
      var hzK = clamp((camDistG - 1000 * (n.scale || 1)) / (600 * (n.scale || 1)), 0, 1);
      for (var hzi = 0; hzi < g.hazeOut.length; hzi++) { var HZ = g.hazeOut[hzi]; HZ.material.opacity = HZ.userData.op * hzK; HZ.visible = hzK > 0.01; }
      if (g.list.length && (g.gF || 0) < 1) g.gF = Math.min(1, (g.gF || 0) + dt / 1.2);   // first guests fade in, never pop
      g.guests.material.uniforms.uAlpha.value = (night ? 0.7 : 1) * smooth(g.gF || 0);
      if (HDR) { if (alert) g.coreMat.uniforms.c2.value.setHex(0xff5a6a); else g.coreMat.uniforms.c2.value.copy(g.bulgeC2); } else g.coreMat.uniforms.c2.value.setHex(alert ? 0xff5a6a : n.accent);
      g.coreMat.uniforms.near.value = near;
      // register this core as a label obstacle (see OBSTACLES/projectObstacle up in the
      // labels section) using the SAME capped radius just applied to the mesh, so the clash
      // test always matches what's actually drawn, never the uncapped/unbounded coreR
      projectObstacle(OBSTACLES[g.obIdx], g.world, r * (n.scale || 1), camDistG);
    });
    // THE EDGE: same spin/near/cap/halo treatment, in its own (scaled) frame; a 7th label obstacle
    if (!SC.active) EDGE.G.rotation.y += dt * EDGE.spin;
    var camDistE = cam.position.distanceTo(EDGE.world), nearE = nearFactor(camDistE, 250, 1700);
    var rE = Math.min(EDGE.coreR * (1 + Math.sin(t * 0.8) * 0.03 + beat * 0.1), camDistE * Math.tan(maxCoreAngle * (LABEL.mode === 'audience' ? 0.3 : 1)) / EDGE_SCALE);   // the audience frame is about the people: a glowing bulge, not a big pale coin
    if (HDR) EDGE.core.scale.set(rE * 1.35, rE * 0.95, rE * 1.35); else { EDGE.core.scale.setScalar(rE); EDGE.core.rotation.y += dt * 0.2; EDGE.core.rotation.x += dt * 0.05; }
    EDGE.coreMat.uniforms.pulse.value = beat * 0.3; EDGE.coreMat.uniforms.near.value = nearE;
    var hsE = Math.min(Math.max(rE, 24) * 6.5, camDistE * 0.38 / EDGE_SCALE); EDGE.halo.scale.set(hsE, hsE, 1); EDGE.halo.material.opacity = (LABEL.mode === 'audience' ? 0.4 : 0.3) * (1 - 0.55 * nearE);
    // the EDGE's own shockwave ring (gold, fired from vwLaunch on every viewer arrival - an event, not the heartbeat)
    if (EDGE.ringT < 1.4) { EDGE.ringT += dt; var sE = rE + EDGE.ringT * 130; EDGE.ring.scale.set(sE, sE, sE); EDGE.ring.material.opacity = 0.6 * (1 - EDGE.ringT / 1.4); }
    else if (EDGE.ring.material.opacity !== 0) EDGE.ring.material.opacity = 0;
    edgeBreathe(dt, t);
    discTick(EDGE, nearE, dt);
    projectObstacle(OBSTACLES[6], EDGE.world, rE * EDGE_SCALE, camDistE);
    var camDistSun = cam.position.distanceTo(SUN);
    var sunNear = nearFactor(camDistSun, 170, 1100);
    sunMesh.rotation.y += dt * 0.05;
    sunMat.uniforms.pulse.value = beat * 0.3;
    sunMat.uniforms.near.value = sunNear;
    // same projected-radius cap as the galaxy cores just above: the sun's mesh radius is a
    // fixed constant (SUN_R=70, never driven by live data) but still read as a flat white
    // blob filling much of the frame from the FABRIC/AP chapters, whose camera sits close
    // enough that 70 world units alone exceeds the same screen budget
    // tighter cap than the cores (0.12 vs 0.18 of half-VFOV): from the fabric stops the sun is
    // a supporting body, not the subject, and at the shared cap it was a pale frame-dominating
    // coin; the halo carries its presence at that range instead
    var sunR = Math.min(SUN_R, camDistSun * Math.tan(maxCoreAngle * 0.67));
    sunMesh.scale.setScalar(sunR / SUN_R);
    projectObstacle(OBSTACLES[2], SUN, sunR, camDistSun);
    // same distance-relative cap as the galaxy halos: the sun's halo is a fixed 520-unit
    // sprite tuned to look right from the ~2000-unit WAN EDGE establishing shot, but the
    // fabric sits only ~400-600 units from the sun — verified on screen that a fabric/AP
    // close-up let the halo balloon to most of the frame at that range even though the
    // camera wasn't "close" to the sun by the old near/far distance check
    var sunHaloScale = Math.min(640, camDistSun * 0.32);
    sunHalo.scale.set(sunHaloScale, sunHaloScale, 1);
    // harder close-range trim than the cores get: the sun is the one body whose halo, mesh AND
    // bloom all stack in the same amber, and from the FABRIC/AP stops (~500 units) that sum was
    // verified on screen to saturate into a frame-filling white disc
    sunHalo.material.opacity = 0.8 * (1 - 0.8 * sunNear);
    // far trim: from the AUDIENCE frame (~3000 units) the sun is a small disc whose bloom still summed to a
    // white dot; ease the gain down beyond 2000 units so it stays an amber body at the bottom of that frame
    var sunFar = 1 - nearFactor(camDistSun, 2000, 3400);
    sunMat.uniforms.gain.value = HDR ? 3.2 * (1 - 0.3 * sunNear) : 1.3 - 0.6 * sunNear - 0.4 * sunFar;
    if (SUN_GLARE) SUN_GLARE.lvl = 1 - 0.75 * sunNear;
    // fabric planets: pulse with the beat, switch rings red while down
    FABKIND.forEach(function (k, ki) {
      var f = fab[k], camDistF = cam.position.distanceTo(f.pos);
      f.ring.material.opacity = f.down ? (0.5 + Math.sin(t * 2) * 0.2) : 0;
      if (f.mat) {
        f.mat.uniforms.pulse.value = beat * 0.5;
        f.mat.uniforms.c2.value.setHex(f.down ? 0xff3b4a : FAB_COL[k]);
        f.mat.uniforms.near.value = nearFactor(camDistF, FAB_RAD[k] * 3, FAB_RAD[k] * 16);
        f.mesh.rotation.y += dt * 0.05;
      } else {
        // the wall's hub status (down = dim + desaturate), a lift on the shared beat, and the network system's fade
        B3.setHubStatus(f.mesh, { desat: f.down ? 0.7 : 0, bright: (f.down ? 0.4 : 0.78) * (1 + 0.08 * beat) * (HDR && !B3PHOTO ? (k === 'gateway' ? 2.8 : 2.1) : 1), lvl: NET_VIS });
        if (f.mesh.userData.glare) f.mesh.userData.glare.lvl = NET_VIS * (f.down ? 0.3 : 1) * (f.group.visible ? 1 : 0);
        hubFace(f.mesh, f.pos, dt, k === 'ap' ? 1 : 0.5, ki);
      }
      // label obstacle (radius padded for bloom) + keep the planet's own landmark label clear of
      // the disc: viewed from above, its anchor (FAB_RAD+20 over the centre) projects INSIDE it
      var obF = OBSTACLES[3 + ki]; projectObstacle(obF, f.pos, fabR(k) * 1.25, camDistF);
      var LF = k === 'gateway' ? L_gw : k === 'switch' ? L_sw : L_ap;
      LF.off[1] = -20 - (obF.active ? obF.r * 1.05 + 6 : 0);
    });
    // moons: cheap CPU orbit (<=96 points) around whichever planet they belong to
    for (var mi = 0; mi < moonState.length; mi++) {
      var m = moonState[mi], pp = fab[m.kind].pos, a = m.ang + t * 0.05, j = m.i * 3;
      mpos[j] = pp.x + Math.cos(a) * m.r; mpos[j + 1] = pp.y + m.y; mpos[j + 2] = pp.z + Math.sin(a) * m.r;
    }
    if (moonState.length) mgeo.attributes.position.needsUpdate = true;
    // the universe: device pool + flares + attachment lines (after the galaxies spun, so guest flares sit on their star)
    for (var gi = 0; gi < NODES.length; gi++) galaxies[NODES[gi].id].G.updateMatrixWorld(true);
    uniTick(dt);
    trafficTick(dt);
    if (B3) {
      // px floor on a 3D body (CSS px diameter): the overview constellation still reads as bodies, a close-up as models
      var far = LABEL.mode === 'over' || LABEL.mode === 'wan' || LABEL.mode === 'edge' || LABEL.mode === 'audience' || LABEL.mode === 'threat';
      B3MIN += ((far ? 6 : 9) - B3MIN) * (1 - Math.exp(-dt * 3));
      B3.tick(SIM_T, { now: SIM_T, orbitR: 0, minPx: B3MIN, pxPerUnit: innerHeight / (2 * Math.tan(cam.fov * Math.PI / 360)) });
    }
    L_sw.pos.set(fab.switch.pos.x, fab.switch.pos.y + fabR('switch') + 16, fab.switch.pos.z);
    L_ap.pos.set(fab.ap.pos.x, fab.ap.pos.y + fabR('ap') + 16, fab.ap.pos.z);
    if (!UNI.on) linksTick();
    cometTick(dt);
    rocketTick(dt, t);
    exoTick(dt, t, sunNear);
    // intrusion effects: shield ring flash (red, decays) + shockwave burst in the ring's plane
    if (THREAT.flashT > 0) { THREAT.flashT -= dt; var fl = clamp(THREAT.flashT / 1.3, 0, 1); cfRing.material.color.setHex(0xff5a6a); cfRing.material.opacity = Math.max(cfRing.material.opacity, 0.85 * fl); }
    else if (cfRing.material.color.getHex() !== 0xf6821f) cfRing.material.color.setHex(0xf6821f);
    if (THREAT.waveT < 1.6) { THREAT.waveT += dt; var ws = SUN_R * 2.1 + THREAT.waveT * 420; thWave.scale.set(ws, ws, ws); thWave.material.opacity = 0.7 * (1 - THREAT.waveT / 1.6); }
    else if (thWave.material.opacity !== 0) thWave.material.opacity = 0;
    var nowMs = performance.now();
    threatCaptionTick(nowMs);
    if (THREAT.secOn && nowMs > THREAT.secUntil) { THREAT.secOn = false; hud(); }
    if (TC.on && nowMs > TC.until) endThreatCut();
    audTickCut(nowMs); evcTick(nowMs);
    pingTick(dt); audTick(dt); cardTick(dt);
    var showcaseOn = wantShowcase();
    if (showcaseOn !== SC.active) toggleShowcase(showcaseOn);
    if (SC.active) showcaseTick(dt); else if (TC.on) threatCutTick(dt); else if (D.mode === 'free') directorFreeTick(dt); else directorSyncTick(dt);
    // §9.4: side panels dim to ~35 % while the camera travels (CSS body.nx-leg, eased), and come back for the hold
    var legNow = !SC.active && (TC.on ? TC.t < 1 : D.mode === 'sync' ? !!D.inTravel : D.t < 1);
    if (legNow !== LEG_ON) { LEG_ON = legNow; document.body.classList.toggle('nx-leg', legNow); }
    glareTick();                                  // after the camera moved: glare is sized and offset from the lens
    deepTick();
    if (hitKick > 0) hitKick = Math.max(0, hitKick - dt * 1.6);
    arrivalTick(dt);
    // 2026-10-07: the data heartbeat no longer touches the bloom (it only breathes the cores); the one arrival accent
    // per stop adds a small smooth breath, and the threat hit keeps its kick
    bloom.strength = BLOOM_BASE * (night ? 0.7 : 1) + ARR.breath * 0.24 + hitKick * hitKick * 0.8;
    // label anchors
    // anchor in the galaxy's own local space then transform through O (the static tilt group,
    // not G which spins continuously) — a raw world-space guess here ignored the tilt entirely
    // and drifted far from the core once the camera saw the galaxy from angles the old fixed
    // 5-shot director never used (the showcase flythrough)
    // (the fixed landmark positions/offsets are set once, right after animate — no per-frame
    // Vector3/array allocation here; only the galaxy labels need re-deriving from coreR)
    // the AUDIENCE frame is about people: the estate's own landmarks (galaxies, bridge, sun) stay quiet in it
    var estateLbl = LABEL.mode !== 'audience';
    // the fabric planets now sit in the network system, which the OVERVIEW sees end-on behind the right-hand galaxy:
    // their landmark labels only show where the network is (part of) the subject, or they stack onto the galaxy
    var netLbl = !UNI.on ? estateLbl : (LABEL.mode === 'fabric' || LABEL.mode === 'wired' || LABEL.mode === 'ap' || LABEL.mode === 'wan' || LABEL.mode === 'sys' || (LABEL.mode === 'asp' && LABEL.net));
    L_sun.on = estateLbl; L_bridge.on = estateLbl && !FAM.bridge.covered; L_gw.on = netLbl; L_sw.on = netLbl; L_ap.on = netLbl;
    var netFocus = UNI.on && (LABEL.mode === 'wired' || LABEL.mode === 'ap' || (LABEL.mode === 'sys' && UNI.frames[LABEL.id] && UNI.frames[LABEL.id].kind === 'clients'));
    for (var gli = 0; gli < L_grp.length; gli++) {
      var LGg = L_grp[gli]; LGg.on = netFocus && !!LGg.sec;
      if (LGg.on) { secLabelLocal(LGg.sec, _local); NET_SPIN.localToWorld(_local); LGg.pos.copy(_local); LGg.slotPos = LGg.pos; LGg.slotR = 0; }
    }
    for (var hli = 0; hli < L_hubx.length; hli++) {
      var LHh = L_hubx[hli]; LHh.on = netLbl && !!LHh.hub;
      if (LHh.on) { LHh.pos.copy(LHh.hub.wp); LHh.slotPos = LHh.hub.wp; LHh.slotR = fabR('switch') * 1.25; }
    }
    // the gateway / first switch / first AP names use the same slot placement in the universe (their stars are fab.*)
    if (UNI.on) {
      L_gw.slotPos = fab.gateway.pos; L_gw.slotR = fabR('gateway') * 1.25;
      L_sw.slotPos = fab.switch.pos; L_sw.slotR = fabR('switch') * 1.25;
      L_ap.slotPos = fab.ap.pos; L_ap.slotR = fabR('ap') * 1.25;
    } else { L_gw.slotPos = L_sw.slotPos = L_ap.slotPos = null; }
    L_home.on = UNI.on && (LABEL.mode === 'over');
    L_home.pos.set(NET_C.x, NET_C.y - 30, NET_C.z + 150);
    /* a galaxy's caption sits just above ITS OWN disc on screen: anchored on the core, lifted by the disc's projected
       half-height (the tilted arms project ~0.6 of their radius vertically). The old anchor, 150 units above and behind
       the core in disc space, landed on the next galaxy once growth put a second row behind the first. */
    var pxK = innerHeight / (2 * Math.tan(cam.fov * Math.PI / 360));
    NODES.forEach(function (n) {
      var gal = galaxies[n.id], L = L_gal[n.id]; L.on = estateLbl && !n.gone; L.pos.copy(gal.world);
      var dC = Math.max(1, cam.position.distanceTo(gal.world)), rpx = 245 * (n.scale || 1) * 0.6 / dC * pxK;
      L.off[1] = -Math.min(rpx + 14, innerHeight * 0.42);
    });
    // world-space anchor (not O-local like the two estate galaxies): the EDGE's steep tilt puts O's +Y almost
    // along the view axis, so an O-local "above the core" landed beside the disc and off the right edge
    L_edge.pos.set(EDGE_POS.x, EDGE_POS.y + EDGE.coreR * EDGE_SCALE + 150, EDGE_POS.z);
    for (var ei2 = 0; ei2 < L_estar.length; ei2++) { var LE2 = L_estar[ei2]; if (LE2.on) { _local.fromArray(LE2.local); EDGE.G.localToWorld(_local); LE2.pos.copy(_local); } }
    L_guest.forEach(function (L) {
      if (!L.on) return;
      if (L.mode === 'guest') { _local.fromArray(L.local); L.frame.localToWorld(_local); L.pos.copy(_local); }
      else if (L.mode === 'client') { var j2 = L.orbit.i * 3; L.pos.set(mpos[j2], mpos[j2 + 1], mpos[j2 + 2]); }
      else if (L.mode === 'dev') L.pos.copy(L.rec.wp);
      else if (L.mode === 'hub') L.pos.copy(L.hubF.center);
    });
    labelFadeTick(dt);
    labelsTick(dt);
    dcTick();
  }
  var dsAcc = 0, dsFrames = 0, dsStr = '', LEG_ON = false;
  NODES.forEach(function (n) { L_gal[n.id].off = [0, -40]; }); L_edge.off = [0, -40];
  L_sun.pos.set(SUN.x, SUN.y - 120, SUN.z); L_sun.off = [0, 40];
  L_bridge.pos.set(0, 176, 0); L_bridge.off = [0, -30];
  L_gw.pos.set(fab.gateway.pos.x, fab.gateway.pos.y + fabR('gateway') + 20, fab.gateway.pos.z); L_gw.off = [0, -20];
  L_sw.pos.set(fab.switch.pos.x, fab.switch.pos.y + fabR('switch') + 16, fab.switch.pos.z); L_sw.off = [0, -20];
  L_ap.pos.set(fab.ap.pos.x, fab.ap.pos.y + fabR('ap') + 16, fab.ap.pos.z); L_ap.off = [0, -20];
  enterFreeRoam();
  (function () {
    if (typeof EventSource !== 'function') return;
    sse('/api/presence/stream', function (ev) {
      try {
        var d = JSON.parse(ev.data);
        RENDER_ACTIVE = ('effective' in d) ? d.effective : d.active;
        // keep elapsedTime across the pause, or the director fast-forwards the
        // whole idle period on the first frame back (see index.html wakeRender)
        if (RENDER_ACTIVE && !animRunning) {
          animRunning = true;
          var keep = clock.elapsedTime; clock.getDelta(); clock.elapsedTime = keep;
          requestAnimationFrame(animate);
        }
      } catch (e) { }
    });
  })();
  /* ============================== performance (2026-10-05) ==============================
     PERF: one EXT_disjoint_timer_query_webgl2 query around composer.render() per frame (pooled, read back a few frames
     later, never stalls). perfTick() turns the measured GPU ms into the render scale RS.s with hysteresis:
       - down one step after ~1.5 s above RS_HI, then no step back up for 15 s;
       - a step that did not buy at least 15% is undone and down-steps are blocked for 60 s: measured on a GPU shared with
         an NVR detector, a detection burst inflates this page's GPU time by the same ~10 ms at ANY resolution (it is waiting,
         not drawing), and trading picture for nothing is the worst outcome;
       - up one step only after ~4 s where even the PREDICTED time at the next step (ms x pixel ratio) stays under
         0.6 x RS_HI, at most one step per 4 s - the scale never flickers between two levels;
       - floor: RS_K's last step (0.7 x the cap = a 1920x1080 scene on the 4K panel).
     Without the extension it falls back to rAF intervals and only ever steps down (rAF can lie about frames, so
     it never raises the scale on that evidence). NEXUS.PERF.lock(s) / nxflags rs=0.7 pins a scale for A/B. */
  var RS_K = [1, 0.88, 0.78, 0.7], RS_HI = 11.0;
  RS.idx = 0;
  var PERF = { ext: null, pool: [], live: [], cur: null, ms: new Float32Array(48), n: 0, w: 0, p75: 0, hot: 0, cool: 0, lastStep: 0, blockUp: 0, nextEval: 0,
               pauseTimer: false, steps: [], late: 0, frames: 0, lastRaf: 0, cpu: {}, blockDown: 0, preP: 0, verifyAt: 0 };
  try { if (rndr.capabilities.isWebGL2) PERF.ext = rndr.getContext().getExtension('EXT_disjoint_timer_query_webgl2'); } catch (e) { }
  function perfBegin() {
    if (!PERF.ext || PERF.pauseTimer || PERF.cur) return;
    var gl = rndr.getContext(); if (PERF.live.length > 6) return;                      // results not coming back: do not pile up queries
    var q = PERF.pool.pop() || gl.createQuery(); gl.beginQuery(PERF.ext.TIME_ELAPSED_EXT, q); PERF.cur = q;
  }
  function perfEnd() { if (!PERF.cur) return; var gl = rndr.getContext(); gl.endQuery(PERF.ext.TIME_ELAPSED_EXT); PERF.live.push(PERF.cur); PERF.cur = null; }
  function perfHarvest() {
    if (!PERF.ext) return;
    var gl = rndr.getContext();
    while (PERF.live.length) {
      var q = PERF.live[0]; if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      var disj = gl.getParameter(PERF.ext.GPU_DISJOINT_EXT), ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
      PERF.live.shift(); PERF.pool.push(q);
      if (!disj) { PERF.ms[PERF.w] = ns / 1e6; PERF.w = (PERF.w + 1) % PERF.ms.length; if (PERF.n < PERF.ms.length) PERF.n++; }
    }
  }
  var _p75 = new Float32Array(48);
  function perfP75() { var n = PERF.n; if (!n) return 0; for (var i = 0; i < n; i++) _p75[i] = PERF.ms[i]; var a = _p75.subarray(0, n); a.sort(); return a[Math.min(n - 1, Math.floor(n * 0.75))]; }
  function rsStep(d, why) {
    var idx = clamp(RS.idx + d, 0, RS_K.length - 1); if (idx === RS.idx) return;
    RS.idx = idx; RS.s = Math.max(0.25, RS.sMax * RS_K[idx]); RS.pending = true;
    var now = performance.now(); PERF.lastStep = now; PERF.hot = 0; PERF.cool = 0; PERF.n = 0; PERF.late = 0; PERF.frames = 0;
    if (d > 0) { PERF.blockUp = now + 15000; PERF.verifyAt = why === 'undo' ? 0 : now + 3000; } else PERF.verifyAt = 0;
    PERF.steps.push([Math.round(now), +RS.s.toFixed(3), why]); if (PERF.steps.length > 20) PERF.steps.shift();
  }
  function perfTick(nowMs, cpuMs) {
    var c = PERF.cpu.frame || (PERF.cpu.frame = { last: 0, max: 0 }); c.last = cpuMs; if (cpuMs > c.max) c.max = cpuMs;
    perfHarvest();
    if (PERF.lastRaf) { var iv = nowMs - PERF.lastRaf; PERF.frames++; if (iv > 27) PERF.late++; }
    PERF.lastRaf = nowMs;
    if (nowMs < PERF.nextEval) return;
    PERF.nextEval = nowMs + 500;
    if (RS.lock || !BOOT.revealed || PERF.pauseTimer) return;                          // pinned / still loading (compiles and uploads are not the steady state)
    if (PERF.ext) {
      if (PERF.n < 20) return;
      var p = PERF.p75 = perfP75();
      if (PERF.verifyAt && nowMs >= PERF.verifyAt) {                                   // did the last down-step actually help?
        PERF.verifyAt = 0;
        if (p > PERF.preP * 0.85) { PERF.blockDown = nowMs + 60000; rsStep(-1, 'undo'); PERF.blockUp = 0; return; }
      }
      PERF.hot = p > RS_HI ? PERF.hot + 1 : 0;
      // one step at a time: never step again before the last step has been verified (PERF.verifyAt)
      if (PERF.hot >= 3 && !PERF.verifyAt && nowMs - PERF.lastStep > 1500 && nowMs > PERF.blockDown && RS.idx < RS_K.length - 1) { PERF.preP = p; rsStep(1, 'gpu ' + p.toFixed(1) + 'ms'); return; }
      var k = RS.idx > 0 ? RS_K[RS.idx - 1] / RS_K[RS.idx] : 0;
      PERF.cool = (k && nowMs > PERF.blockUp && p * k * k < RS_HI * 0.6) ? PERF.cool + 1 : 0;
      if (PERF.cool >= 8 && nowMs - PERF.lastStep > 4000) rsStep(-1, 'gpu ' + p.toFixed(1) + 'ms');
    } else if (PERF.frames >= 50) {
      var lateK = PERF.late / PERF.frames; PERF.late = 0; PERF.frames = 0;
      PERF.hot = lateK > 0.25 ? PERF.hot + 1 : 0;
      if (PERF.hot >= 2 && nowMs - PERF.lastStep > 3000) rsStep(1, 'late ' + Math.round(lateK * 100) + '%');
    }
  }
  function cpuMark(name, t0) { var d = performance.now() - t0, c = PERF.cpu[name] || (PERF.cpu[name] = { last: 0, max: 0, n: 0 }); c.last = d; c.n++; if (d > c.max) c.max = d; }
  // apply RS.s (and/or a new window size) to the canvas, the composer's targets and every pixel-specified shader input
  function rsApply() {
    RS.pending = false;
    var pr = BASE_PR * RS.s;
    rndr.setPixelRatio(pr);
    composer.setPixelRatio(pr);                         // resizes both composer targets and calls setSize on every pass (bloom stays native-pinned)
    U_PR.value = pr; U_CAPK.value = RS.s; U_LINEK.value = RS.s;
    if (exoLines) exoLines.material.opacity = 0.09 * RS.s;
  }
  function onResize() {
    var w = innerWidth, h = innerHeight; if (w < 1 || h < 1) return;
    var wasTiny = NATIVE.w < 64 * BASE_PR || NATIVE.h < 64 * BASE_PR;
    BASE_PR = Math.min(window.devicePixelRatio || 1, 2);
    NATIVE.w = w * BASE_PR; NATIVE.h = h * BASE_PR;
    cam.aspect = w / h; cam.updateProjectionMatrix();
    RS.sMax = rsMaxFor(w, h); RS.s = RS.lock || Math.max(0.25, RS.sMax * RS_K[RS.idx]);
    rndr.setSize(w, h);
    composer.setSize(w, h);
    rsApply();
    PERF.n = 0;
    // labels are sized in vw: every measured box (the clash walk's L.w/L.h) is stale after a resize - one batched re-measure
    for (var i = 0; i < labels.length; i++) measureLater(labels[i]);
    flushLabelMeasureNow();
    // shots are fitted to the aspect (overviewShot fits the pair to the frame width): re-fit the shot we are holding on.
    // Coming back from the unplugged 4x4 window nobody saw the old framing, so snap; otherwise glide (hold settle).
    if (SC.active || TC.on) return;
    var subj = D.subject || { kind: 'over' }, sh = shotFor(subj);
    var holding = D.mode === 'sync' ? !D.inTravel : D.t >= 1;
    if (!holding && !wasTiny) return;
    if (D.mode === 'sync') { D.inTravel = false; D.arrived = false; }
    else { D.t = 1; }
    D.to = D.toShot = sh;
    beginHold(sh);
    if (wasTiny) { camPos.copy(sh.pos); camLook.copy(sh.look); D.settleT = 1; } else D.settleDur = 0.9;
  }
  addEventListener('resize', onResize);

  /* lightsync pixels (2026-10-05): lightsync.js used to drawImage + getImageData the WebGL canvas twice a second - a
     synchronous full-frame GPU readback (16-33 MB at 4K) that stalls the main thread until the GPU drains (25-55 ms
     every 500 ms on an integrated GPU; the same stall happens on a discrete one whenever another process holds it).
     lightsync.js now asks window.NB_PIXELS.request(W, H) first (the same contract index.html implements): it returns
     the newest finished W x H RGBA sample (rows bottom-up) or null, and asks for a fresh one. Here the final pass is
     re-run into a W x H target (bilinear taps of the same picture), read back through a pixel-pack buffer + fence and
     handed over on a later frame, so nothing ever waits on the GPU. No WebGL2: NB_PIXELS stays unset and lightsync
     falls back to reading the canvas exactly as before. */
  var LS = null;
  (function () {
    if (!rndr.capabilities.isWebGL2) return;
    try {
      var gl = rndr.getContext();
      LS = { rt: null, W: 0, H: 0, buf: null, sync: null, issued: 0, n: 0, want: null, ready: null, pbo: gl.createBuffer() };
      window.NB_PIXELS = { request: function (W, H) { LS.want = [W | 0, H | 0]; var r = LS.ready; LS.ready = null; return r; } };
    } catch (e) { LS = null; }
  })();
  function lsTick(nowMs) {
    if (!LS) return;
    var gl = rndr.getContext();
    if (LS.sync) {
      var st = gl.clientWaitSync(LS.sync, 0, 0);
      if (st === gl.TIMEOUT_EXPIRED && nowMs - LS.issued < 2000) return;
      gl.deleteSync(LS.sync); LS.sync = null;
      if (st !== gl.ALREADY_SIGNALED && st !== gl.CONDITION_SATISFIED) return;
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, LS.pbo); gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, LS.buf); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      LS.ready = LS.buf; LS.n++;
      return;
    }
    if (!LS.want || !gradePass.uniforms.tDiffuse.value) return;
    var W = Math.max(1, Math.min(512, LS.want[0])), H = Math.max(1, Math.min(512, LS.want[1])); LS.want = null;
    if (W !== LS.W || H !== LS.H) {
      LS.W = W; LS.H = H; LS.buf = new Uint8Array(W * H * 4);
      if (LS.rt) LS.rt.dispose();
      LS.rt = new THREE.WebGLRenderTarget(W, H, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false });
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, LS.pbo); gl.bufferData(gl.PIXEL_PACK_BUFFER, W * H * 4, gl.STREAM_READ); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    }
    var prev = rndr.getRenderTarget();
    rndr.setRenderTarget(LS.rt); gradePass.fsQuad.render(rndr);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, LS.pbo); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, 0); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    LS.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0); LS.issued = nowMs; gl.flush();
    rndr.setRenderTarget(prev);
  }

  /* reveal (2026-10-05): the canvas and the HUD start hidden (body.nx-boot, nexus.html) while the scene already renders
     behind the veil - textures decode and upload, every program compiles (prewarm), the first /api/all, /api/topology and
     /api/universe answers land. Three frames after all of that is resident the page fades in (canvas 1.6 s, HUD a beat
     later), so the first visible frame is the fully dressed one and nothing pops in afterwards. Hard cap 8 s: a dead feed
     or a missing asset can delay the reveal, never block it (late arrivals fade in on their own: sky, discs, bodies). */
  function bootReady() { return BOOT.inflight <= 0 && (!B3 || B3.loaded()) && BOOT.manifest && BOOT.all && BOOT.topo && (BOOT.uni || !UL) && (BOOT.rockets || NXF.norocket); }
  function bootTick() {
    if (BOOT.revealed) return;
    BOOT.frames++;
    var now = performance.now();
    if (!BOOT.tReady && bootReady()) { BOOT.tReady = now; prewarm(); BOOT.readyFrame = BOOT.frames; }
    if ((BOOT.tReady && BOOT.frames - BOOT.readyFrame >= 3) || now - BOOT.t0 > 8000) reveal();
  }
  function reveal() {
    BOOT.revealed = true; BOOT.tReveal = performance.now();
    var b = document.body; b.classList.add('nx-ready'); b.classList.remove('nx-boot');
    var q = SSE_Q.splice(0); q.forEach(function (a) { try { sse(a[0], a[1], a[2]); } catch (e) { } });
    setTimeout(function () { b.classList.remove('nx-ready'); }, 3200);       // the staggered reveal delays must not linger on later HUD fades
  }
  // compile every material's program up front (all objects, visible or not): at the reveal gate (after the data, the
  // manifest and the flipbooks have created their materials) and once more at 12 s, so no stop's first frame pays for one
  function prewarm() { var t0 = performance.now(); try { var v = []; scene.traverse(function (o) { if (o.visible === false) { v.push(o); o.visible = true; } }); rndr.compile(scene, cam); v.forEach(function (o) { o.visible = false; }); } catch (e) { } cpuMark('prewarm', t0); }
  setTimeout(prewarm, 12000);
  animate();
  window.composer = composer;           // the render-count probe looks for this
  window.NEXUS = { S: S, D: D, SC: SC, galaxies: galaxies, fab: fab, FAM: FAM, composer: composer, play: function (v) { SC.manual = !!v; },
                   EDGE: EDGE, THREAT: THREAT, TC: TC, ROCKETS: ROCKETS, threat: threat, edgeStars: function () { return edgeStars; },
                   edgeUpdate: edgeUpdate, edgeInfo: edgeInfo, viewQueue: viewQueue, audienceShot: audienceShot, AUD_SHOT: AUD_SHOT,
                   // QA: fly (free-roam, pinned) to an arbitrary {pos,look} so a framing can be tuned live before it is baked into a shot
                   testShot: function (pos, look, sub) { D.pinFree = true; D.mode = 'free'; var sh = { pos: new THREE.Vector3().fromArray(pos), look: new THREE.Vector3().fromArray(look) }; beginTravel(sh, { kind: sub || 'audience' }, null); D.t = 0; D.dur = 1.4; D.hold = 0; },
                   // QA: NEXUS.arrive('DE') = a new viewer from that country (mote from its star + ping + the 8 s AUDIENCE cut, gap permitting)
                   arrive: function (cc, n) { var idx = -1; for (var i = 0; i < edgeStars.length; i++) if (edgeStars[i].cc === cc) idx = i; for (var k = 0; k < (n || 1); k++) viewPush(idx); if (idx >= 0) viewerArrived(edgeStars[idx]); return idx; },
                   // QA: feed a lightstate packet straight in (sync tests in the harness, whose POSTs are blocked); from the
                   // first call on, packets from the live SSE / poll path are ignored so only injected ones drive the director
                   // QA: every label on screen right now: title, kind, drawn box (CSS px) - for overlap / coverage probes
                   labelState: function () {
                     var out = [];
                     labels.forEach(function (L) {
                       if (!L._vis || L._op !== 1 || !L.el) return;
                       var w = L.w || L.el.offsetWidth, h = L.h || L.el.offsetHeight, x = L.centered ? L.sx - w / 2 : L.sx;
                       out.push({ t: L._title || (L.el.firstChild && L.el.firstChild.textContent) || '', k: L.slotPos ? (L_grp.indexOf(L) >= 0 ? 'grp' : 'hub') : L.poolItem ? 'pool' : 'mark',
                                  slot: L._slot, box: [Math.round(x), Math.round(L.sy), Math.round(w), Math.round(h)] });
                     });
                     return out;
                   },
                   // QA: put the network system at a given spin angle (the label sweep checks every rotation phase)
                   setSysAng: function (a) { SYS_ANG = +a || 0; },
                   // QA (2026-10-08b look-dev): retune the overview framing live - dir (camera side) and the safe NDC box
                   ovTune: function (o) { if (o.dir) _ovDir.set(o.dir[0], o.dir[1], o.dir[2]).normalize(); if (o.safe) for (var i = 0; i < 4; i++) OV_SAFE[i] = o.safe[i]; return { dir: _ovDir.toArray(), safe: OV_SAFE.slice() }; },
                   STARS: STARS, DEEP: DEEP, GRADE: GRADE, gradeU: gradePass.uniforms,
                   // the shared deep-sky plate: NEXUS.skyCfg (levels, rotation, the voids found, the fillers painted),
                   // NEXUS.skyTune({ close: 0.35, wide: 0.42, fill: 1, rot: [ry, rx, rz] }) - re-paints when fill / rot change
                   skyCfg: SKY, skyTune: skyTune,
                   wallState: function (o) { WALL.qaOnly = true; if (o && !o.ts) o.ts = Date.now() / 1000; if (o) o.qa = true; applyWallState(o); }, ARR: ARR, NETD: NETD,
                   goto: function (key, name, pin) { D.mode = 'free'; D.pinStop = !!pin; if (pin) D.pinFree = true; freeGoto(key, name); }, sky: sky, stopName: stopName,
                   pinFree: function (v) { D.pinFree = !!v; if (!v) { WALL.lastKey = ''; pollLightstate(); } },
                   moons: function () { return moonState.map(function (m) { return { id: m.client.id, kind: m.kind, status: m.client.status }; }); },
                   // ---- universe QA (2026-10-04) ----
                   UNI: UNI, MOTION: MOTION, TT: TT, uniApply: uniApply, pollUniverse: pollUniverse, TR: TR, trMat: trMat, DC: DC, dcOpen: dcOpen, dcClose: dcClose, NODES: NODES,
                   B3: B3, B3L: function () { return B3L; },
                   // world position of bodies by id (devices: live pool position; guests: their star in the galaxy)
                   bodyPos: function (ids) { var out = {}; (ids || Object.keys(UNI.recs)).forEach(function (id) { var w = bodyWorld(id); if (w) out[id] = [+w.x.toFixed(3), +w.y.toFixed(3), +w.z.toFixed(3)]; }); return out; },
                   // projected screen px of bodies by id (null when behind the camera)
                   project: function (ids) { cam.updateMatrixWorld(); var out = {}; (ids || Object.keys(UNI.recs)).forEach(function (id) { var w = bodyWorld(id); if (!w) return; w.project(cam); out[id] = w.z < 1 ? [+((w.x * 0.5 + 0.5) * innerWidth).toFixed(2), +((-w.y * 0.5 + 0.5) * innerHeight).toFixed(2)] : null; }); return out; },
                   // a body's HOME slot (no orbit offset) in world space, at the frames' current eased radius (settled=false) or the
                   // radius they are easing toward (settled=true): the growth-stability probe compares these before/after an append
                   homePos: function (ids, settled) { var out = {}; (ids || Object.keys(UNI.recs)).forEach(function (id) { var w = homeWorld(id, settled); if (w) out[id] = [+w.x.toFixed(4), +w.y.toFixed(4), +w.z.toFixed(4)]; }); return out; },
                   homeProject: function (ids, settled) { cam.updateMatrixWorld(); var out = {}; (ids || Object.keys(UNI.recs)).forEach(function (id) { var w = homeWorld(id, settled); if (!w) return; w.project(cam); if (w.z < 1) out[id] = [+((w.x * 0.5 + 0.5) * innerWidth).toFixed(3), +((-w.y * 0.5 + 0.5) * innerHeight).toFixed(3)]; }); return out; },
                   sim: simSteps, motionAudit: motionAudit, SIM: function () { return SIM_T; },
                   // ---- performance QA (2026-10-05) ----
                   hold: function (v) { QA_HOLD = !!v; }, scene: scene, cam: cam, rndr: rndr, gradePass: gradePass, bloom: bloom,
                   PERF: PERF, RS: RS, BOOT: BOOT, READY: BOOT, LS: function () { return LS && { n: LS.n, W: LS.W, H: LS.H }; },
                   // pin the render scale (0 = adaptive again); returns the scale in effect
                   lockScale: function (sc) { RS.lock = sc ? clamp(+sc, 0.25, 1) : 0; RS.s = RS.lock || Math.max(0.25, RS.sMax * RS_K[RS.idx]); RS.pending = true; return RS.s; },
                   perfSnapshot: function () { return { s: RS.s, sMax: RS.sMax, idx: RS.idx, lock: RS.lock, p75: PERF.p75, ext: !!PERF.ext, steps: PERF.steps.slice(), cpu: JSON.parse(JSON.stringify(PERF.cpu)),
                     buf: [rndr.getContext().drawingBufferWidth, rndr.getContext().drawingBufferHeight], rt: [composer.renderTarget1.width, composer.renderTarget1.height],
                     bloom: [bloom.renderTargetBright.width, bloom.renderTargetBright.height], boot: { ready: Math.round(BOOT.tReady - BOOT.t0), reveal: Math.round((BOOT.tReveal || 0) - BOOT.t0) } }; } };
  window.NEXUS.eventCut = function (id, kind) { var R = UNI.recs[id]; if (!R) return 'no such body'; EVC.pend = R; EVC.pendKind = kind || 'down'; EVC.pendT = performance.now(); EVC.force = true; return 'queued'; };
  window.NEXUS.EVC = EVC;
  // QA (§9.2 / §9.3): the tour copy, the problem list, and a pinned free-roam flight to one aspect stop exactly as the
  // sync director resolves it (unknown keys must degrade to the estate wide with a plain name)
  window.NEXUS.TOUR = TOUR; window.NEXUS.ASP_SHOT = ASP_SHOT; window.NEXUS.probList = probList; window.NEXUS.pollTour = pollTour;
  window.NEXUS.testAspect = function (key, name) { D.mode = 'free'; D.pinStop = true; D.pinFree = true; freeGoto(key, name || ''); return aspOf(key) ? 'aspect ' + key : 'unknown ' + key + ' (fallback)'; };
  window.NEXUS.TVL = TVL;
  function homeWorld(id, settled) {
    var R = UNI.recs[id]; if (!R || !R.F || !R.p) return null;
    var F = R.F, keep = F.Lmax; if (settled) F.Lmax = F.LmaxT;
    var v = null;
    if (R.role === 'guest') { var a = guestLocal(F, R, [0, 0, 0]); v = new THREE.Vector3(a[0], a[1], a[2]); F.gal.G.updateMatrixWorld(true); F.gal.G.localToWorld(v); }
    else if ((R.role === 'dev' || R.role === 'planet') && R.net) { v = netLocal(R, new THREE.Vector3(), settled); F.spin.updateMatrixWorld(true); F.spin.localToWorld(v); }
    else if (R.role === 'dev' || R.role === 'planet') { var p = R.p, wr = p.r === 0 ? 0 : mapR(F, p.r); v = new THREE.Vector3(Math.cos(p.theta) * wr, p.y * bandK(F), Math.sin(p.theta) * wr); F.spin.updateMatrixWorld(true); F.spin.localToWorld(v); }
    F.Lmax = keep; return v;
  }
  function bodyWorld(id) {
    var R = UNI.recs[id]; if (!R) return null;
    if (R.role === 'guest') { if (!R.guest || !R.guest._pos) return null; var v = new THREE.Vector3().fromArray(R.guest._pos); R.F.gal.G.updateMatrixWorld(true); return R.F.gal.G.localToWorld(v); }
    if (R.role === 'dev' || R.role === 'planet') return R.wp.clone();
    return null;
  }
  /* dt-independence probe: step the whole simulation (no rendering) for `sec` seconds at a forced `fps` from a
     snapshot, record where things are, restore the snapshot. Run it twice at two frame rates and compare. */
  function simSteps(sec, fps, ids) {
    SIM_PAUSE = true;
    var snap = { T: SIM_T, sys: SYS_ANG, cam: [camPos.clone(), camLook.clone()], gal: {}, recs: {}, frames: {}, D: {}, edge: EDGE.G.rotation.y, net: NET_SPIN.rotation.y };
    NODES.forEach(function (n) { snap.gal[n.id] = [galaxies[n.id].G.rotation.y, galaxies[n.id].spin]; });
    Object.keys(UNI.recs).forEach(function (id) { var R = UNI.recs[id]; snap.recs[id] = [R.orbA, R.spinA, R.pulA, R.born, R.alpha, R.rgb.slice()]; });
    Object.keys(UNI.frames).forEach(function (id) { snap.frames[id] = UNI.frames[id].Lmax; });
    ['mode', 'hold', 'orbit', 't', 'dur', 'settleT', 'settleDur', 'travelRaw', 'inTravel', 'arrived', 'freeIdx', 'to', 'toShot', 'toSubj', 'subject', 'pendingSubj', 'travelP0', 'travelProgBase', 'travelT0', 'travelS'].forEach(function (k) { snap.D[k] = D[k]; });
    var vecs = [D.from.pos, D.from.look, D.settleFrom.pos, D.settleFrom.look, D.leg.cp, D.leg.cl]; snap.vecs = vecs.map(function (v) { return v.clone(); });
    var shotV = D.toShot ? [D.toShot.pos.clone(), D.toShot.look.clone()] : null;
    var n = Math.round(sec * fps), dt = 1 / fps;
    for (var i = 0; i < n; i++) frame(Math.min(dt, MOTION.DT_MAX));   // exactly what animate() feeds frame()
    var out = { sec: sec, fps: fps, frames: n, simT: +(SIM_T - snap.T).toFixed(4), cam: camPos.toArray().map(function (v) { return +v.toFixed(3); }),
                gal: {}, bodies: NEXUS.bodyPos(ids), sw: fab.switch.pos.toArray().map(function (v) { return +v.toFixed(3); }) };
    NODES.forEach(function (n2) { out.gal[n2.id] = +galaxies[n2.id].G.rotation.y.toFixed(5); });
    // restore
    SIM_T = snap.T; U_TIME.value = SIM_T; SYS_ANG = snap.sys; camPos.copy(snap.cam[0]); camLook.copy(snap.cam[1]); EDGE.G.rotation.y = snap.edge; NET_SPIN.rotation.y = snap.net;
    NODES.forEach(function (n3) { galaxies[n3.id].G.rotation.y = snap.gal[n3.id][0]; galaxies[n3.id].spin = snap.gal[n3.id][1]; });
    Object.keys(snap.recs).forEach(function (id) { var R = UNI.recs[id], q = snap.recs[id]; if (!R) return; R.orbA = q[0]; R.spinA = q[1]; R.pulA = q[2]; R.born = q[3]; R.alpha = q[4]; R.rgb = q[5]; });
    Object.keys(snap.frames).forEach(function (id) { if (UNI.frames[id]) UNI.frames[id].Lmax = snap.frames[id]; });
    Object.keys(snap.D).forEach(function (k) { D[k] = snap.D[k]; });
    vecs.forEach(function (v, i) { v.copy(snap.vecs[i]); });
    if (shotV && snap.D.toShot) { snap.D.toShot.pos.copy(shotV[0]); snap.D.toShot.look.copy(shotV[1]); }
    SIM_PAUSE = false; clock.getDelta();
    return out;
  }
  // the fastest thing on screen, by construction: every rate below is read from the live state, in rad/s
  function motionAudit() {
    var o = { galaxySpin: {}, sysRotation: MOTION.SYS_W, maxBodyOrbit: 0, maxBodySpin: 0, maxBodyOrbitSpeedUnits: 0, cometsPerSecCap: MOTION.flowRate(1), pulsePeriod: [MOTION.pulseT(0), MOTION.pulseT(1e9)] };
    NODES.forEach(function (n) { o.galaxySpin[n.id] = +galaxies[n.id].spin.toFixed(4); });
    for (var i = 0; i < UNI.n; i++) { var P = UNI.pool[i]; if (!P || P.hub) continue; var w = P.b.status === 'down' ? 0 : MOTION.orbitW(P.u); o.maxBodyOrbit = Math.max(o.maxBodyOrbit, w); o.maxBodySpin = Math.max(o.maxBodySpin, P.b.status === 'down' ? 0 : MOTION.spinW(P.ci.spin, P.u)); o.maxBodyOrbitSpeedUnits = Math.max(o.maxBodyOrbitSpeedUnits, w * MOTION.ORBIT_R * 0.55 * bandK(P.F) * 0.5); }
    o.camSpeed = +camSpeed.toFixed(3);
    return o;
  }
})();
