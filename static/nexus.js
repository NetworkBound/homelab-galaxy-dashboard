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
  var CAT = {}, CATS = (C.categories && C.categories.length ? C.categories.slice()
                        : ['ai', 'media', 'network', 'monitor', 'web', 'infra']);
  CATS.forEach(function (k) { CAT[k] = C.catHex ? C.catHex(k) : 0x8fb0d0; });
  var CAT_STOPPED = C.palette && C.palette.stopped ? (C.hex ? C.hex(C.palette.stopped) : 0xff5a6a) : 0xff5a6a;
  var WAN_LABEL = String(C.wan_label || 'ISP').toUpperCase();

  /* N galaxies on a line through the origin: the first two keep the original
     +/-400 pair (every camera shot in this file was framed against it), and any
     further node steps 500 units further out, alternating sides, so a 5-node
     estate reads as a chain rather than a pile. One node sits at the origin. */
  var GAL_X0 = 400, GAL_STEP = 500;
  function galaxyX(i, n) {
    if (n <= 1) return 0;
    var side = (i % 2 === 0) ? -1 : 1;
    return side * (GAL_X0 + Math.floor(i / 2) * GAL_STEP);
  }
  /* Only two spiral discs were baked (amber + cyan); extra nodes alternate
     between them — the disc is a texture, the identity is the accent colour. */
  var DISC_TEX = ['galaxy_nb.png', 'galaxy_gpu.png'];
  var CFG_NODES = (C.nodes && C.nodes.length) ? C.nodes : [{ id: 'pve', label: 'PVE', accent: '#5ad7ff', index: 0 }];
  var NODES = CFG_NODES.map(function (n, i) {
    return { id: n.id, label: String(n.label || n.id).toUpperCase(),
             accent: C.hex ? C.hex(n.accent) : 0x5ad7ff,
             x: galaxyX(i, CFG_NODES.length), spin: i % 2 === 0 ? 1 : -1,
             disc: DISC_TEX[i % DISC_TEX.length], index: i };
  });
  var NODE_BY_ID = {}; NODES.forEach(function (n) { NODE_BY_ID[n.id] = n; });
  var N_NODES = NODES.length;
  var SUN = new THREE.Vector3(1120, 140, -1500);
  /* 2026-09-19 UNIVERSE: THE EDGE - a third, violet galaxy (Cloudflare's edge) beyond and above the WAN
     sun. A backdrop body: deliberately NOT part of overviewBounds()/overviewShot() - from the OVERVIEW it
     sits top-right behind the sun; WAN EDGE looks between sun and EDGE core; THE EDGE (new stop/chapter)
     frames it with the sun in the foreground. Its stars are measured (Cloudflare PoPs + viewer countries). */
  var EDGE_POS = new THREE.Vector3(2000, 420, -2750), EDGE_SCALE = 2.2, EDGE_ACC = 0xb48cff, EDGE_HOT = 0xf6821f;
  var THREAT_COL = { 0: '#37f5a0', 1: '#ffb347', 2: '#ff5a6a', 3: '#ff2d55' };
  // QA bisect switches (localStorage.nxflags = 'nosky,nodisc,notex,norocket,nothreat'); none set in production
  var NXF = {}; try { String(window.NX_FLAGS || localStorage.getItem('nxflags') || '').split(',').forEach(function (f) { if (f) NXF[f.trim()] = 1; }); } catch (e) { }
  var $ = function (id) { return document.getElementById(id); };
  var U_TIME = { value: 0 };            // shared clock uniform (declared first: the starfield below uses it before pointsMat is defined)
  var clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; };
  var lerp = function (a, b, t) { return a + (b - a) * t; };
  var smooth = function (t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
  var smootherstep = function (t) { t = clamp(t, 0, 1); return t * t * t * (t * (t * 6 - 15) + 10); };   // same curve the wall eases its travel with
  var nearFactor = function (dist, n, f) { return clamp((f - dist) / (f - n), 0, 1); };                  // 0 far away, 1 once closer than n — feeds coreFS's brightness damping
  var plural = function (n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); };                           // "1 guest" vs "3 guests", everywhere a live count is spoken
  function hash(s) { s = String(s); var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967295; }
  function fmtBps(b) { b = +b || 0; return b >= 1e9 ? (b / 1e9).toFixed(2) + ' Gb/s' : b >= 1e6 ? (b / 1e6).toFixed(1) + ' Mb/s' : b >= 1e3 ? (b / 1e3).toFixed(0) + ' kb/s' : b.toFixed(0) + ' b/s'; }
  function fmtGB(b) { return (b / 1073741824).toFixed(0); }
  function normBps(b) { b = Math.max(0, +b || 0); return clamp((Math.log10(b + 1) - 3) / 4.5, 0, 1); }   // 1 kb/s .. ~30 Mb/s -> 0..1

  /* ============================== renderer ============================== */
  var canvas = $('c');
  var scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x02040c, 0.00022);
  var cam = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 1, 6000);
  var rndr = new THREE.WebGLRenderer({ canvas: canvas, antialias: false, powerPreference: 'high-performance' });
  rndr.setSize(innerWidth, innerHeight);
  rndr.setPixelRatio(Math.min(devicePixelRatio, 2));
  // Tone mapping moved to the END of the chain (gradePass below). This is three r128: the
  // renderer-level ACES only ever ran inside built-in materials (sprites, ring meshes) — the
  // custom ShaderMaterials (cores, every point cloud) and the bloom composite have no
  // tonemapping chunk, so their output went to the screen as raw linear values and simply
  // clipped to flat white above 1.0. That clipping (core + bloom stacked additively) was the
  // blown-out white discs on the galaxy close-ups. Mapping once, post-bloom, rolls those
  // highlights off filmically instead and keeps the accent hue in the core body.
  rndr.toneMapping = THREE.NoToneMapping;
  var composer = new THREE.EffectComposer(rndr);
  composer.addPass(new THREE.RenderPass(scene, cam));
  /* bloom at half resolution: its mip chain starts at res/2 anyway, and a 4K
     bloom on the 1080 Ti is the one thing that could push this under 60 */
  var bloom = new THREE.UnrealBloomPass(new THREE.Vector2(1920, 1080), 1.0, 0.72, 0.7);
  composer.addPass(bloom);
  var BLOOM_BASE = 1.0;
  /* final grade: ACES (Narkowicz fit) + a touch of saturation + a soft vignette. One 4K
     full-screen quad with a ~10-op fragment shader — measured well under a millisecond on the
     1080 Ti. Saturation is nudged UP (never down): lightsync.js reads this canvas and only
     counts pixels with HSL saturation >= 0.25, so a desaturating grade would cost real room-
     light hue detection. The vignette is mild and only bites in the outer ~35% of the frame;
     the centre (where the subject and its colour always are) is untouched. */
  var gradePass = new THREE.ShaderPass({
    uniforms: { tDiffuse: { value: null }, uExp: { value: 1.45 }, uSat: { value: 1.12 }, uVig: { value: 0.3 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: [
      'uniform sampler2D tDiffuse; uniform float uExp, uSat, uVig; varying vec2 vUv;',
      'vec3 aces(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14), 0.0, 1.0); }',
      'void main(){ vec3 c = texture2D(tDiffuse, vUv).rgb * uExp;',
      '  c = aces(c);',
      '  float l = dot(c, vec3(0.2126, 0.7152, 0.0722)); c = mix(vec3(l), c, uSat);',
      '  vec2 q = vUv - 0.5; float v = 1.0 - uVig * smoothstep(0.16, 0.5, dot(q, q));',
      '  gl_FragColor = vec4(c * v, 1.0); }'
    ].join('\n')
  });
  composer.addPass(gradePass);
  /* baked Blender assets (2026-09-19): every texture is loaded exactly once, here, and handed to the
     material that owns it in the callback; nothing waits on them (the scene draws untextured until then) */
  /* Chrome caps HTTP/1.1 connections at 6 per host and this page holds long-lived SSE sockets (lightstate,
     pulse, presence, threats here + mode, pulse in showtime.js = 6). A navigation away needs a 7th socket,
     which only frees once the NEW page commits - verified on the TV: with the 6th stream open a reload never
     committed and the renderer sat in futex_wait until the kiosk was killed. beforeunload runs BEFORE the
     navigation request is issued, so closing our streams there hands the sockets back in time. */
  var STREAMS = [];
  function sse(url, onmsg, onerr) { var es = new EventSource(url); es.onmessage = onmsg; if (onerr) es.onerror = onerr; STREAMS.push(es); return es; }
  function closeStreams() { STREAMS.forEach(function (es) { try { es.close(); } catch (e) { } }); STREAMS.length = 0; }
  addEventListener('beforeunload', closeStreams); addEventListener('pagehide', closeStreams);
  var TEXL = new THREE.TextureLoader(), MAX_ANISO = Math.min(8, rndr.capabilities.getMaxAnisotropy());
  function loadTex(name, cb) { TEXL.load('/static/assets/' + name, function (t) { t.anisotropy = MAX_ANISO; if (cb) cb(t); }, undefined, function () { console.warn('nexus: texture failed', name); }); }
  /* sky: the 4096x2048 equirect nebula. First cut used scene.background (r128 converts an equirect to a cube
     map once) - verified on the TV that even this "dim" plate, run through the grade's 1.45 exposure + ACES,
     filled the frame at ~0.3 grey-blue and swallowed the estate. r128 has no background intensity, so it is
     a BackSide sphere that follows the camera (never rotates with it), tinted down by SKY_TINT; one draw,
     depth off, fog off. Tune live: NEXUS.sky.material.color. */
  var SKY_TINT = 0x333333;
  var sky = new THREE.Mesh(new THREE.SphereGeometry(5000, 48, 24), new THREE.MeshBasicMaterial({ map: null, color: SKY_TINT, side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false }));
  sky.renderOrder = -100; sky.frustumCulled = false; sky.visible = false; scene.add(sky);
  if (!NXF.nosky) loadTex('sky.jpg', function (t) { sky.material.map = t; sky.material.needsUpdate = true; sky.visible = true; });

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
  function pointsMat(tex, twinkle, alpha, maxPx) {
    return new THREE.ShaderMaterial({
      uniforms: { map: { value: tex }, uTime: U_TIME, uTw: { value: twinkle }, uAlpha: { value: alpha },
                  uFocus: { value: -1 }, uPR: { value: rndr.getPixelRatio() }, uCap: { value: maxPx || 240.0 } },
      vertexShader: [
        'attribute float size; attribute float phase; attribute float cat; attribute float glow;',
        'uniform float uTime, uTw, uFocus, uPR, uCap; varying vec3 vC; varying float vA;',
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
        '  gl_PointSize = min(uCap, size * g * tw * uPR * (900.0 / -mv.z)); gl_Position = projectionMatrix * mv; }'
      ].join('\n'),
      fragmentShader: [
        'uniform sampler2D map; uniform float uAlpha; varying vec3 vC; varying float vA;',
        'void main(){ vec4 t = texture2D(map, gl_PointCoord); gl_FragColor = vec4(vC * t.rgb, t.a * uAlpha * vA); }'
      ].join('\n'),
      vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
    });
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
    var discMat = new THREE.MeshBasicMaterial({ map: null, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide,
                                                color: acc.clone().lerp(new THREE.Color(0xffffff), 0.3) });
    var disc = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), discMat); disc.rotation.x = -Math.PI / 2; disc.rotation.z = nd.discRot || 0; disc.renderOrder = -2; G.add(disc);
    if (nd.disc && !NXF.nodisc) loadTex(nd.disc, function (t) { discMat.map = t; discMat.needsUpdate = true; });
    // dust: 3200 particles on two log arms + a haze
    var N = nd.N || 3200, pos = new Float32Array(N * 3), col = new Float32Array(N * 3), sz = new Float32Array(N), ph = new Float32Array(N);
    var c = new THREE.Color();
    for (var i = 0; i < N; i++) {
      var arm = i % 2, u = Math.random(), r = 18 + Math.pow(u, 0.8) * 250;
      var th = arm * Math.PI + r * 0.0165 + (Math.random() - 0.5) * (0.35 + u * 0.7);
      var haze = i % 9 === 0;
      if (haze) { th = Math.random() * 6.283; r = Math.random() * 270; }
      pos[i * 3] = Math.cos(th) * r; pos[i * 3 + 1] = (Math.random() - 0.5) * (haze ? 40 : 14) * (1 - u * 0.5); pos[i * 3 + 2] = Math.sin(th) * r;
      c.copy(acc).lerp(new THREE.Color(0xffffff), 0.35 + u * 0.4).multiplyScalar(haze ? 0.35 : 0.5 + Math.random() * 0.5);
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      sz[i] = haze ? 6 + Math.random() * 10 : 1.5 + Math.random() * 3.5; ph[i] = Math.random() * 6.28;
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('size', new THREE.BufferAttribute(sz, 1)); g.setAttribute('phase', new THREE.BufferAttribute(ph, 1));
    var dust = new THREE.Points(padAttrs(g), pointsMat(TEX_DUST, 0.15, 0.55)); G.add(dust);
    // nebula sprites
    for (var k = 0; k < 7; k++) {
      var sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: TEX_NEB, color: acc.clone().lerp(new THREE.Color(k % 2 ? 0x6d2b79 : 0x1c3a5e), 0.5), transparent: true, opacity: 0.16, depthWrite: false, blending: THREE.AdditiveBlending }));
      var a = k / 7 * 6.283, rr = 60 + k * 28; sp.position.set(Math.cos(a) * rr, (Math.random() - 0.5) * 20, Math.sin(a) * rr); var ss = 180 + k * 40; sp.scale.set(ss, ss, 1); G.add(sp);
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
    var coreMat = new THREE.ShaderMaterial({ uniforms: coreUniforms(c1, acc.clone(), nd.hot ? 0.6 : 0.22, 1.6, 0), vertexShader: coreVS, fragmentShader: coreFS, transparent: true });
    var core = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 4), coreMat); G.add(core);
    var halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: TEX_GLOW, color: nd.hot ? new THREE.Color(nd.hot).lerp(acc, 0.25) : acc, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending })); G.add(halo);
    var light = new THREE.PointLight(nd.accent, 2.5, 900); G.add(light);
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
    var guests = new THREE.Points(gg, pointsMat(TEX_STAR, 0.08, 1.0)); guests.frustumCulled = false; G.add(guests);   // same zero-sphere trap as the comet pool
    return { nd: nd, O: O, G: G, dust: dust, disc: disc, discMat: discMat, core: core, coreMat: coreMat, halo: halo, light: light, ring: ring, ringT: 9, ringRed: 0, guests: guests, gg: gg,
             gp: gp, gc: gc, gs: gs, gcat: gcat, ggl: ggl, list: [], spin: 0.02, coreR: 22, world: O.position.clone() };
  }
  NODES.forEach(function (nd) { galaxies[nd.id] = buildGalaxy(nd); });
  function discTick(gal, near) { gal.discMat.opacity = gal.discMat.map ? 0.6 * (1 - 0.55 * near) : 0; }
  /* THE EDGE galaxy itself (see EDGE_POS). Own dust/disc/core/halo from the same builder; its guest-star pool
     is repurposed as the measured EDGE stars (fillEdgeStars). Never in NODES: nothing that iterates NODES
     (hud, overview bounds, lockstep host/blk stops) should ever see it. */
  var EDGE = buildGalaxy({ id: 'edge', label: 'THE EDGE', accent: EDGE_ACC, hot: EDGE_HOT, pos: EDGE_POS, scale: EDGE_SCALE, tilt: [1.15, 0, 0.5], disc: 'galaxy_edge.png', spin: 1, N: 2400 });
  EDGE.coreR = 30; EDGE.spin = 0.012; EDGE.light.intensity = 0;

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
  function fillGuests(gal, list) {
    gal.list = list.slice(0, 160).sort(function (a, b) { return (a.cat + a.name).localeCompare(b.cat + b.name); });
    var n = gal.list.length, c = new THREE.Color();
    gal.list.forEach(function (g, i) {
      var p = placeGuest(gal, i, n); gal.gp[i * 3] = p[0]; gal.gp[i * 3 + 1] = p[1]; gal.gp[i * 3 + 2] = p[2];
      var up = g.status === 'running';
      c.setHex(up ? (CAT[g.cat] || CAT.infra) : 0xff5a6a); if (!up) c.multiplyScalar(0.45);
      gal.gc[i * 3] = c.r; gal.gc[i * 3 + 1] = c.g; gal.gc[i * 3 + 2] = c.b;
      var ram = Math.log2(1 + (g.maxmem || 0) / 1073741824);             // 0 .. ~7
      gal.gs[i] = up ? 7 + ram * 2.6 : 5;
      gal.gcat[i] = CATS.indexOf(g.cat) < 0 ? 5 : CATS.indexOf(g.cat);
      gal.ggl[i] = up ? clamp((g.cpu || 0) / 40, 0, 1.2) : 0;             // brightness follows CPU
      g._pos = p;
    });
    ['position', 'color', 'size', 'cat', 'glow'].forEach(function (k) { gal.gg.attributes[k].needsUpdate = true; });
    gal.gg.setDrawRange(0, n);
  }

  /* ============================== the sun (WAN) ============================== */
  var sun = new THREE.Group(); sun.position.copy(SUN); scene.add(sun);
  // gain 1.0 -> 1.3 with the granulation map: the multiply darkened the disc into a flat lemon (verified on the
  // WAN shot) - the extra gain lets the post-bloom ACES roll the centre back to a hot near-white
  var sunMat = new THREE.ShaderMaterial({ uniforms: coreUniforms(new THREE.Color(0xffb347), new THREE.Color(0xfff2c0), 2.0, 1.3, 0), vertexShader: coreVS, fragmentShader: coreFS });
  // SphereGeometry (Icosahedron has no UVs) so the baked granulation map wraps; rotates slowly in the loop
  var SUN_R = 70, sunMesh = new THREE.Mesh(new THREE.SphereGeometry(SUN_R, 48, 32), sunMat); sun.add(sunMesh);
  if (!NXF.notex) loadTex('sun.png', function (t) { sunMat.uniforms.uMap.value = t; sunMat.uniforms.uHasMap.value = 1; });
  var sunHalo = new THREE.Sprite(new THREE.SpriteMaterial({ map: TEX_GLOW, color: 0xffb347, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending })); sunHalo.scale.set(640, 640, 1); sun.add(sunHalo);
  sun.add(new THREE.PointLight(0xffb347, 1.5, 3000));

  /* ============================== fabric (solar system) ==============================
     gateway/switch/ap = three small planets strung out between the sun and the estate;
     clients = moons orbiting whichever of the three they're attached to, one shared
     Points pool (fixed 96) so this stays a single draw call regardless of client count. */
  var FABKIND = ['gateway', 'switch', 'ap'];
  var FAB_COL = { gateway: 0x5ad7ff, switch: 0xffb347, ap: 0x37f5a0 };
  var FAB_RAD = { gateway: 15, switch: 9, ap: 9 };
  var fab = {}, fabIds = { gateway: null, switch: null, ap: null };
  (function buildFabric() {
    var dir = SUN.clone().negate().normalize();
    var basePos = {
      gateway: SUN.clone().add(dir.clone().multiplyScalar(260)).add(new THREE.Vector3(40, -30, 10)),
      switch: SUN.clone().add(dir.clone().multiplyScalar(520)).add(new THREE.Vector3(-130, 40, 60)),
      ap: SUN.clone().add(dir.clone().multiplyScalar(520)).add(new THREE.Vector3(130, -50, -50))
    };
    FABKIND.forEach(function (k) {
      var G = new THREE.Group(); G.position.copy(basePos[k]); scene.add(G);
      var mat = new THREE.ShaderMaterial({ uniforms: coreUniforms(new THREE.Color(FAB_COL[k]).multiplyScalar(0.4).lerp(new THREE.Color(0xffffff), 0.2), new THREE.Color(FAB_COL[k]), 2.0, 1.05, 1), vertexShader: coreVS, fragmentShader: coreFS, transparent: true });
      var mesh = new THREE.Mesh(new THREE.SphereGeometry(FAB_RAD[k], 48, 32), mat); G.add(mesh);
      if (!NXF.notex) loadTex('planet_' + k + '.png', function (t) { mat.uniforms.uMap.value = t; mat.uniforms.uHasMap.value = 1; });
      // "down" alarm ring (soft textured annulus, red, opacity driven in the render loop)
      var ring = ringPlane(TEX_RING, 0xff3b4a, 0); ring.scale.setScalar(FAB_RAD[k] * 1.7); G.add(ring);
      // faint orbit band under the client moons (they orbit at r 20..42, see fillFabric) so
      // the solar system reads as a system — a soft disc, not a hairline
      var band = ringPlane(TEX_ORBIT, FAB_COL[k], 0.06); band.scale.setScalar(44); G.add(band);
      fab[k] = { group: G, mesh: mesh, mat: mat, ring: ring, pos: basePos[k], down: false, meta: null };
    });
  })();
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
  // gateway-switch / gateway-ap spokes: faint, static, just so the system reads as connected
  [['gateway', 'switch'], ['gateway', 'ap']].forEach(function (pair) {
    var g = new THREE.BufferGeometry().setFromPoints([fab[pair[0]].pos, fab[pair[1]].pos]);
    scene.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0x5a7292, transparent: true, opacity: 0.14, depthWrite: false })));
  });

  /* ============================== comets (flows) ============================== */
  /* the bridge spans the first two nodes (the pair every shot in this file was
     framed against); with one node configured it degenerates to a short arc over
     the origin and simply never carries traffic. */
  var BR_A = NODES[0].x, BR_B = (NODES[1] || NODES[0]).x;
  var CURVES = {
    bridge: new THREE.CubicBezierCurve3(new THREE.Vector3(BR_A + 30, 6, 0), new THREE.Vector3(-120, 170, 40), new THREE.Vector3(120, 170, -40), new THREE.Vector3(BR_B - 30, 6, 0)),
    wan_in: new THREE.CubicBezierCurve3(SUN.clone(), new THREE.Vector3(1000, 420, -700), new THREE.Vector3(700, 220, -100), fab.gateway.pos.clone()),
    wan_out: new THREE.CubicBezierCurve3(fab.gateway.pos.clone(), new THREE.Vector3(750, 260, -200), new THREE.Vector3(1050, 380, -800), SUN.clone())
  };
  var FAM = { bridge: { color: 0x5ad7ff, bps: 0, k: 1 }, wan_in: { color: 0x38e1ff, bps: 0, k: 2.2 }, wan_out: { color: 0xff4fa3, bps: 0, k: 2.2 } };
  /* one uplink family per configured node: gateway -> that galaxy's core, in
     the node's own accent. UP_FAM[id] is the family key ('up:<node id>'). */
  var UP_FAM = {};
  NODES.forEach(function (n) {
    var key = 'up:' + n.id, gw = fab.gateway.pos;
    CURVES[key] = new THREE.CubicBezierCurve3(
      gw.clone(),
      gw.clone().lerp(new THREE.Vector3(n.x, 40, 0), 0.4).add(new THREE.Vector3(0, 60, 0)),
      gw.clone().lerp(new THREE.Vector3(n.x, 10, 0), 0.75),
      new THREE.Vector3(n.x, 4, 0));
    FAM[key] = { color: n.accent, bps: 0, k: 0.8 };
    UP_FAM[n.id] = key;
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
  function famU(f) { return f.u != null ? f.u : normBps(f.bps); }
  /* CN 96 -> 160 (2026-09-14) to carry the exosphere comet families */
  var CN = 200, TRAIL = 7, cpos = new Float32Array(CN * TRAIL * 3), ccol = new Float32Array(CN * TRAIL * 3), csz = new Float32Array(CN * TRAIL), cph = new Float32Array(CN * TRAIL);
  var cg = new THREE.BufferGeometry();
  cg.setAttribute('position', new THREE.BufferAttribute(cpos, 3)); cg.setAttribute('color', new THREE.BufferAttribute(ccol, 3));
  cg.setAttribute('size', new THREE.BufferAttribute(csz, 1)); cg.setAttribute('phase', new THREE.BufferAttribute(cph, 1));
  // 120 px cap (was the 240 default): once the pool stopped being culled at the sun-side framings, exo comets passing
  // within ~100 units of the camera ballooned into quarter-screen orbs; a comet is a streak, never a body
  var comets = new THREE.Points(padAttrs(cg), pointsMat(TEX_STAR, 0, 1, 120)); scene.add(comets);
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
  var viewQueue = 0, viewAcc = 0;   // gold viewer comets waiting to launch (drained at ~3/s so they read as a stream, not a clump)
  var spawnAcc = {};   // per-family accumulator, keys created lazily in cometTick
  function cometTick(dt) {
    if (viewQueue > 0) { viewAcc += dt * 3; while (viewAcc >= 1 && viewQueue > 0) { viewAcc -= 1; viewQueue -= 1; cometSpawn('edge_view'); } }
    Object.keys(FAM).forEach(function (f) {
      var u = famU(FAM[f]); if (u <= 0) return;
      var per = FAM[f].rate != null ? FAM[f].rate : (0.4 + u * 7);   // exosphere families carry their own (lower) cadence
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
        var f = 1 - k2 / TRAIL; csz[base + k2] = s.sz * (k2 === 0 ? 1.3 : f * 0.9) * (s.life > 0 ? Math.min(1, s.life / 0.8) : 1);
        ccol[j] = _c.r * (k2 === 0 ? 1.6 : f); ccol[j + 1] = _c.g * (k2 === 0 ? 1.6 : f); ccol[j + 2] = _c.b * (k2 === 0 ? 1.6 : f);
      }
    }
    cg.attributes.position.needsUpdate = true; cg.attributes.color.needsUpdate = true; cg.attributes.size.needsUpdate = true;
  }
  // faint guide lines so the routes read even between comets
  Object.keys(CURVES).forEach(function (k) {
    if (NO_GUIDE[k]) return;
    var pts = CURVES[k].getPoints(64), g = new THREE.BufferGeometry().setFromPoints(pts);
    scene.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: FAM[k].color, transparent: true, opacity: 0.10, depthWrite: false, blending: THREE.AdditiveBlending })));
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
  if (!NXF.norocket) fetch('/static/assets/rocket.json').then(function (r) { return r.json(); }).then(function (j) {
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(j.pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(j.nrm), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(j.col), 3));
    g.setAttribute('glow', new THREE.BufferAttribute(new Float32Array(j.glow), 1));
    g.setIndex(j.idx); g.computeBoundingSphere();
    var zs = j.pos.filter(function (v, i) { return i % 3 === 2; }), len = Math.max.apply(null, zs) - Math.min.apply(null, zs) || 6;
    ROCKET_DEFS.forEach(function (d, i) {
      var mat = new THREE.ShaderMaterial({ uniforms: { uGlow: { value: 0.12 }, uTint: { value: new THREE.Color(FAM[d.fam].color) } }, vertexShader: rocketVS, fragmentShader: rocketFS, vertexColors: true });
      var m = new THREE.Mesh(g, mat); m.scale.setScalar(ROCKET_LEN / len); m.renderOrder = -5; scene.add(m);
      ROCKETS.push({ fam: d.fam, dir: d.dir, trail: d.trail, mesh: m, mat: mat, base: ROCKET_LEN / len, t: d.dir < 0 ? 0.5 : 0, acc: 0, ph: i * 1.7, curve: CURVES[d.fam] });   // the return rocket starts half a lap out so the pair never runs as a mirror image
    });
  }).catch(function (e) { console.warn('nexus: rocket.json', e); });
  var _rA = new THREE.Vector3(), _rB = new THREE.Vector3();
  function rocketTick(dt, t) {
    for (var i = 0; i < ROCKETS.length; i++) {
      var R = ROCKETS[i], fam = FAM[R.fam], u = famU(fam), active = u > 0, vR = 0.035 + u * 0.09;
      if (active) { R.t += dt * vR; if (R.t >= 1) R.t -= 1; } else R.t = 0;
      var tt = R.dir > 0 ? R.t : 1 - R.t;                          // parameter on the family's forward curve
      R.curve.getPoint(tt, _v); if (R.dir < 0) { _v.y -= 9; _v.z += 16; } R.mesh.position.copy(_v);   // return lane sits beside the outbound one: the pair pass side by side, not through each other (seen on the TV as one hull with two flames)
      R.curve.getPoint(clamp(tt + 0.012 * R.dir, 0, 1), _rA); R.curve.getPoint(clamp(tt - 0.012 * R.dir, 0, 1), _rB);
      _rA.sub(_rB); if (_rA.lengthSq() < 1e-6) _rA.set(0, 0, 1);
      _rB.copy(_v).add(_rA); R.mesh.lookAt(_rB);                   // non-camera lookAt points the mesh's +Z (the nose) down the travel direction
      R.mesh.rotateZ(Math.sin(t * 0.6 + R.ph) * 0.28);             // gentle roll about the travel axis
      R.mesh.scale.setScalar(R.base * (active ? 1 + 0.02 * Math.sin(t * 17 + R.ph) : 1));
      R.mat.uniforms.uGlow.value = active ? 0.55 + 0.2 * Math.sin(t * 23 + R.ph) : 0.08;
      if (active) {
        R.acc += dt * (1.5 + u * 2);
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
  function esc(x) { return String(x == null ? '' : x).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  var BRIDGE_TITLE = NODES[0].label + (NODES[1] ? ' \u21c4 ' + NODES[1].label : '');
  var L_gal = {}, L_sun = mkLabel('sun', '<b>' + esc(WAN_LABEL) + ' \u00b7 WAN</b><span>\u2014</span>'),
      L_bridge = mkLabel('bridge', '<b>' + esc(BRIDGE_TITLE) + '</b><span>\u2014</span>');
  L_sun.halfW = 10; L_bridge.halfW = 10; L_sun.centered = true; L_bridge.centered = true;
  /* one landmark label per configured node, tinted with that node's accent —
     the colour is inline, never a per-node CSS rule (nexus.html knows no ids) */
  NODES.forEach(function (n) {
    var L = mkLabel('gal node', '<b>' + esc(n.label) + '</b><span>\u2014</span>');
    L.halfW = 12; L.centered = true;
    var b = L.el.querySelector('b');
    if (b) { var h = '#' + ('00000' + n.accent.toString(16)).slice(-6);
             b.style.color = h; b.style.textShadow = '0 .05vw .16vw rgba(0,0,0,.95),0 0 .9vw ' + h + '59'; }
    L_gal[n.id] = L;
  });
  var L_edge = mkLabel('gal edge', '<b>THE EDGE</b><span>\u2014</span>'); L_edge.halfW = 14; L_edge.centered = true;
  var L_gw = mkLabel('planet', '<b>GATEWAY</b><span>—</span>'), L_sw = mkLabel('planet', '<b>SWITCH</b><span>—</span>'), L_ap = mkLabel('planet', '<b>AP</b><span>—</span>');
  L_gw.halfW = 9; L_sw.halfW = 9; L_ap.halfW = 9; L_gw.centered = true; L_sw.centered = true; L_ap.centered = true;
  // pool of 200 entity labels: reused for guest stars (galaxy/category shots) OR client
  // moons (fabric/ap/wired shots) — the two never show at once, see applyLabelSubject()
  var L_guest = []; for (var li = 0; li < 200; li++) { var LG = mkLabel('guest', '<b></b><span></span>'); LG.poolItem = true; LG.on = false; L_guest.push(LG); }
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
  var OB_SUN = N_NODES, OB_FAB = N_NODES + 1, OB_EDGE = N_NODES + 4;
  var OBSTACLES = []; for (var oi0 = 0; oi0 < N_NODES + 5; oi0++) OBSTACLES.push({ x: 0, y: 0, r: 0, active: false });
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
    PENDING_MEASURE.push(L);
  }
  function flushLabelMeasure() {
    for (var i = 0; i < PENDING_MEASURE.length; i++) { var L = PENDING_MEASURE[i]; L.w = L.el.offsetWidth; L.h = L.el.offsetHeight; }
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
    var tx = 'translate3d(' + L.sx.toFixed(1) + 'px,' + L.sy.toFixed(1) + 'px,0)' + (L.centered ? ' translateX(-50%)' : '');
    if (L.el.style.transform !== tx) L.el.style.transform = tx;
    if (L.el.style.opacity !== '1') L.el.style.opacity = '1';
  }
  function hideLabel(L) { L._vis = false; if (L.el.style.opacity !== '0') L.el.style.opacity = '0'; }
  function labelsTick(dt) {
    var W = innerWidth, H = innerHeight, placed = [];
    LBL_K = 1 - Math.exp(-dt / 0.045);
    // the top/bottom HUD band + the two node-card zones only exist to dodge chrome that's
    // actually ON SCREEN — but the showcase hides every bit of it (cards/clock/date/status/
    // legend/brand/brackets all go opacity:0 under body.nx-showcase, see nexus.html), leaving
    // only its own thin 8.5vh letterbox bars. Reserving the old, much taller 19%/80% band (and
    // the full card zone) during showcase was hiding labels for content that wasn't actually
    // there to clash with — this was silently capping GPU GALAXY at 6 of its 8 guests labelled.
    var scLb = SC.active ? H * 0.085 : H * 0.19;
    var topBand = scLb, botBand = H - scLb;
    for (var i = 0; i < labels.length; i++) {
      var L = labels[i];
      if (!L.on) { hideLabel(L); continue; }
      _p.copy(L.pos).project(cam);
      var vis = _p.z < 1 && _p.x > -1.1 && _p.x < 1.1 && _p.y > -1.1 && _p.y < 1.1;
      if (!vis) { hideLabel(L); continue; }
      var x0 = (_p.x * 0.5 + 0.5) * W, y0 = (-_p.y * 0.5 + 0.5) * H;
      var x, y, shown = true;
      if (L.poolItem) {
        var w = L.w || 90, h = L.h || 26, pad = 4;
        if (!SC.active && x0 > W * 0.62 && y0 < H * 0.25) { hideLabel(L); continue; }   // anchor itself under the status block: never label it there
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
          if (!SC.active && bx2 > W * 0.62 && by1 < H * 0.25) continue;                             // status block (big line + sub + THREAT chip) top-right: verified on the overview that station/guest labels parked under it read as clutter next to "1 HOST DOWN"
          if (!SC.active && by2 > H * 0.36 && by1 < H * 0.66 && (bx1 < W * 0.23 || bx2 > W * 0.77)) continue;  // into the two node cards (hidden during showcase)
          var onObstacle = false;
          for (var oi = 0; oi < OBSTACLES.length; oi++) { var ob = OBSTACLES[oi]; if (ob.active && circleRectOverlap(ob.x, ob.y, ob.r, bx1, by1, bx2, by2)) { onObstacle = true; break; } }
          if (onObstacle) continue;                                                                 // a core/sun disc — never park a label on top of it
          var clash = false;
          for (var q = 0; q < placed.length; q++) { var b = placed[q]; if (bx1 < b[2] && bx2 > b[0] && by1 < b[3] && by2 > b[1]) { clash = true; break; } }
          if (!clash) { x = cx; y = cy; placed.push([bx1, by1, bx2, by2]); shown = true; L._ci = ci; break; }
        }
        if (!shown) { hideLabel(L); continue; }
        var far = cam.position.distanceTo(L.pos) > 420;
        if (L._far !== far) { L._far = far; L.el.classList.toggle('far', far); }
      } else {
        var inHud = y0 < topBand || y0 > botBand || (!SC.active && y0 > H * 0.36 && y0 < H * 0.66 && (x0 < W * 0.23 || x0 > W * 0.77));
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
        var lb1 = x - half, lb2 = y - H * 0.02, lb3 = x + half, lb4 = y + H * 0.045;
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
          for (var lq = 0; lq < placed.length; lq++) {
            var lp = placed[lq];
            if (lb1 < lp[2] && lb3 > lp[0] && lb2 < lp[3] && lb4 > lp[1]) {
              var ldy = lp[3] - lb2 + H * 0.006; y += ldy; lb2 += ldy; lb4 += ldy; lMoved = true;
            }
          }
          lIter++;
        }
        if (lb2 < topBand || lb4 > botBand) { hideLabel(L); continue; }
        // inHud above only tests the ANCHOR; a wide landmark anchored just inside the free
        // middle still ran under a node card (seen: an AP label clipped by the right-hand
        // card at the overview). Slide the box back out of the card zone instead of hiding it.
        if (!SC.active && lb4 > H * 0.36 && lb2 < H * 0.66) {
          var cdx = lb3 > W * 0.77 ? W * 0.77 - lb3 : lb1 < W * 0.23 ? W * 0.23 - lb1 : 0;
          if (cdx) { x += cdx; lb1 += cdx; lb3 += cdx; }
        }
        placed.push([lb1, lb2, lb3, lb4]);
      }
      placeLabel(L, x, y);
    }
  }
  function setGuestLabel(L, g) {
    L.on = true; L.mode = 'guest'; L.frame = galaxies[g.node].G; L.local = g._pos;
    var up = g.status === 'running';
    setLabelText(L, g.name + (up ? '' : ' · STOPPED'), g.cat + ' · ' + (g.cpu || 0).toFixed(0) + '% cpu · ' + fmtGB(g.maxmem || 0) + ' GB');
    L.el.style.color = up ? ('#' + (CAT[g.cat] || CAT.infra).toString(16).padStart(6, '0')) : '#ff5a6a';
  }
  function setClientLabel(L, m) {
    L.on = true; L.mode = 'client'; L.orbit = m;
    var c = m.client, cm = c.meta || {};
    /* 2026-09-14: category + dormancy come from the classifier; a sleeping client says so
       instead of claiming 0 b/s, and takes the category hue the moon itself wears */
    var link = (m.kind === 'ap' ? 'wireless' : 'wired') + (cm.cat && cm.cat !== 'unknown' ? ' · ' + cm.cat : '');
    if (cm.offline) setLabelText(L, c.label || c.id, link + ' · asleep' + (cm.offline_h != null ? ' ' + Number(cm.offline_h).toFixed(1) + ' h' : ''));
    else setLabelText(L, c.label || c.id, link + ' · ↓' + fmtBps(c.rx) + ' ↑' + fmtBps(c.tx));
    L.el.style.color = cm.offline ? '#6c7d96' : ('#' + (CLIENT_CAT[cm.cat] || (m.kind === 'ap' ? 0x37f5a0 : 0x5ad7ff)).toString(16).padStart(6, '0'));
  }
  // which entities get a label right now, per the current subject (director state)
  var LABEL = { mode: 'over', node: null, cat: null, id: null };
  function refreshLabels() {
    var i = 0, pool = L_guest;
    function place(entries, setFn) { for (var e = 0; e < entries.length && i < pool.length; e++) { setFn(pool[i], entries[e]); i++; } }
    if (LABEL.mode === 'over') {
      var hot = S.guests.filter(function (g) { return g._pos && g.status === 'running'; }).sort(function (a, b) { return (b.cpu || 0) - (a.cpu || 0); }).slice(0, 8);
      place(hot, setGuestLabel);
    } else if (LABEL.mode === 'host') {
      place(S.guests.filter(function (g) { return g.node === LABEL.node && g._pos; }), setGuestLabel);
    } else if (LABEL.mode === 'blk') {
      place(S.guests.filter(function (g) { return g.node === LABEL.node && g.cat === LABEL.cat && g._pos; }), setGuestLabel);
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
    if (/^[A-Z0-9 ]+$/.test(s)) s = s.toLowerCase().replace(/\b([a-z])/g, function (m) { return m.toUpperCase(); });   // was charAt(0)+slice(1): the \b at the slice start re-capitalised the 2nd letter ("GOogle Cloud" in the intrusion caption)
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
      setLabelText(L, s.name + (s.cc ? ' · ' + s.cc : ''), (s.out ? '↑' + fmtBps(s.out) : '') + (s.inb ? (s.out ? '   ' : '') + '↓' + fmtBps(s.inb) : ''));
      L.pos.copy(p); L.el.style.color = uo >= ui ? '#ffb3d1' : '#a9e4ff';
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
        new THREE.LineBasicMaterial({ color: 0xc9a2ff, transparent: true, opacity: 0.09, depthWrite: false, blending: THREE.AdditiveBlending }));
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
  for (var ei = 0; ei < EDGE_N; ei++) { var LE = mkLabel('station', '<b></b><span></span>'); LE.poolItem = true; LE.on = false; LE.mode = 'guest'; LE.frame = EDGE.G; LE.local = [0, 0, 0]; L_estar.push(LE); }
  var edgeInfo = { audience: false, viewers: 0, streams: 0, rpm: 0, ha: 0, pops: [] }, lastViewers = null;
  function edgeSub() {
    return edgeInfo.audience ? plural(edgeInfo.viewers, 'viewer') + ' · 5 min'
      : edgeInfo.streams + ' in-flight · ' + Math.round(edgeInfo.rpm) + ' req/min · ' + edgeInfo.ha + ' HA';
  }
  function edgeUpdate(edge, ext) {
    var cf = (edge && edge.cloudflare) || {}, au = (edge && edge.audience) || {};
    edgeInfo.audience = !!au.up; edgeInfo.viewers = +au.viewers_5m || 0; edgeInfo.streams = +cf.active_streams || 0; edgeInfo.rpm = cf.up ? (+cf.req_per_min || 0) : 0; edgeInfo.ha = +cf.ha_connections || 0;
    edgeInfo.pops = cf.up ? (cf.locations || []).slice(0, 8) : [];
    // request comets: cadence follows req/min, capped so a burst stays readable (3/s); 0 req/min = none
    FAM.edge_in.u = edgeInfo.rpm > 0 ? clamp(0.3 + edgeInfo.rpm / 200, 0, 1) : 0;
    FAM.edge_in.rate = Math.min(3, 0.12 + edgeInfo.rpm / 25);
    // new unique viewers since the last poll (only when the REAL audience feed is up; tunnel counters are never viewers)
    if (au.up) { if (lastViewers != null && edgeInfo.viewers > lastViewers) viewQueue = Math.min(20, viewQueue + (edgeInfo.viewers - lastViewers)); lastViewers = edgeInfo.viewers; } else lastViewers = null;
    var list = [];
    edgeInfo.pops.forEach(function (pp, i) { list.push({ key: 'pop:' + pp, pop: true, name: String(pp), sub: 'cloudflare pop', w: 1, rank: i }); });
    var cc = [];
    if (au.up && (au.by_country || []).length) {
      var mx = 1; (au.by_country || []).forEach(function (r) { mx = Math.max(mx, +r.uniques || 0); });
      (au.by_country || []).slice(0, EDGE_N - list.length).forEach(function (r) { cc.push({ key: 'cc:' + r.cc, name: r.cc || '??', sub: plural(+r.uniques || 0, 'viewer'), w: (+r.uniques || 0) / mx }); });
    } else if (ext && ext.up && (ext.by_country || []).length) {
      var rows = (ext.by_country || []).filter(function (r) { return r.cc && r.cc !== '??' && +r.bytes > 0; }).slice(0, 8), mb = 1;
      rows.forEach(function (r) { mb = Math.max(mb, Math.sqrt(+r.bytes)); });
      rows.forEach(function (r) { cc.push({ key: 'cc:' + r.cc, name: r.cc, sub: (r.bps_out ? '↑' + fmtBps(r.bps_out) : '') + (r.bps_in ? (r.bps_out ? '   ' : '') + '↓' + fmtBps(r.bps_in) : ''), w: Math.sqrt(+r.bytes) / mb }); });
    }
    cc.forEach(function (s, i) { s.rank = i; list.push(s); });
    edgeStars = list.slice(0, EDGE_N);
    var c = new THREE.Color();
    for (var i = 0; i < EDGE_N; i++) { EDGE.gs[i] = 0; L_estar[i].on = false; }
    edgeStars.forEach(function (s, i) {
      var h = hash(s.key), h2 = hash(s.key + '#'), h3 = hash(s.key + '##');
      var r = s.pop ? 42 + h * 40 : 95 + Math.pow(h, 0.8) * 150, arm = h2 < 0.5 ? 0 : 1;
      var th = arm * Math.PI + r * 0.0165 + (h3 - 0.5) * 0.7;
      var x = Math.cos(th) * r, y = (h2 - 0.5) * 10, z = Math.sin(th) * r, j = i * 3;
      EDGE.gp[j] = x; EDGE.gp[j + 1] = y; EDGE.gp[j + 2] = z;
      c.setHex(s.pop ? 0xffa050 : 0xd9c8ff); EDGE.gc[j] = c.r; EDGE.gc[j + 1] = c.g; EDGE.gc[j + 2] = c.b;
      EDGE.gs[i] = s.pop ? 34 : 12 + 20 * s.w; EDGE.ggl[i] = s.pop ? 1.2 : 0.3 + 0.6 * s.w; EDGE.gcat[i] = 0;
      var L = L_estar[i]; L.local[0] = x; L.local[1] = y; L.local[2] = z; L.star = s;
      setLabelText(L, s.name, s.sub); L.el.style.color = s.pop ? '#ffb073' : '#d9c8ff';
    });
    ['position', 'color', 'size', 'glow'].forEach(function (k) { EDGE.gg.attributes[k].needsUpdate = true; });
    EDGE.gg.setDrawRange(0, edgeStars.length);
    setLabelText(L_edge, 'THE EDGE · CLOUDFLARE', edgeSub() + (edgeInfo.pops.length ? ' · ' + edgeInfo.pops.join(' ') : ''));
    flushLabelMeasure();
  }
  /* Cloudflare edge: a ring station on the WAN sun */
  var cfPivot = new THREE.Group(); cfPivot.rotation.set(1.15, 0, 0.35); sun.add(cfPivot);
  var cfRing = ringPlane(TEX_RING, 0xf6821f, 0); cfRing.scale.setScalar(SUN_R * 2.1); cfPivot.add(cfRing);
  var cfStation = new THREE.Sprite(new THREE.SpriteMaterial({ map: TEX_GLOW, color: 0xffa050, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }));
  cfStation.scale.set(90, 90, 1); cfPivot.add(cfStation);
  /* pool-placed (ring walk around the orbiting station) rather than a fixed-offset landmark:
     as a landmark it was shoved down off the sun disc into the WAN label and hidden */
  var L_cf = mkLabel('station cf', '<b>CLOUDFLARE EDGE</b><span>—</span>'); L_cf.poolItem = true; L_cf.on = false;
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
    var mode = LABEL.mode, wantN = (mode === 'wan' || mode === 'edge') ? EXO_N : (mode === 'over' || mode === 'threat') ? 4 : 0;
    L_cf.on = cfState.up && (mode === 'wan' || mode === 'over' || mode === 'edge' || mode === 'threat') && !SC.active;
    // EDGE stars: PoPs + every country at WAN/EDGE/threat, PoPs + top 4 countries at OVERVIEW, nothing elsewhere
    var edgeAll = mode === 'wan' || mode === 'edge' || mode === 'threat', edgeSome = mode === 'over';
    for (var ii = 0; ii < edgeStars.length; ii++) { var st = edgeStars[ii]; L_estar[ii].on = !night && (edgeAll || (edgeSome && (st.pop || st.rank < 4))); }
    if (L_cf.on) setLabelText(L_cf, 'CLOUDFLARE EDGE', (cf.ha_connections != null ? cf.ha_connections + ' HA · ' : '') + Math.round(cfState.rpm) + ' req/min · ' + (cf.locations || []).join(' '));
    for (var i = 0; i < exoStations.length; i++) { var s = exoStations[i]; L_exo[s.slot].on = s.rank < wantN && !night; }
    exoPts.material.uniforms.uAlpha.value = night ? 0.6 : 1;
  }

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
  /* the bounding sphere of EVERY configured galaxy, not a hardcoded pair: the
     centroid of their cores plus the furthest core's distance and envelope. */
  function overviewBounds() {
    var c = new THREE.Vector3(), rMax = 0;
    NODES.forEach(function (n) { c.add(galaxies[n.id].world); });
    c.multiplyScalar(1 / N_NODES);
    NODES.forEach(function (n) {
      var g = galaxies[n.id];
      var d = c.distanceTo(g.world) + GAL_ENVELOPE_R + g.coreR;
      if (d > rMax) rMax = d;
    });
    return { c: c, r: Math.max(rMax, GAL_ENVELOPE_R) };
  }
  function overviewShot() {
    var b = overviewBounds(), halfV = (cam.fov * Math.PI / 180) / 2;
    // The pair is wide, not tall: fit its radius against the HORIZONTAL half-FOV (vertical
    // alone put the camera ~3400 units out and both galaxies became dots). 0.8 = the pair
    // spans 80% of the frame width; the vertical term only matters for a portrait aspect.
    var tV = Math.tan(halfV), d = Math.max(b.r / (tV * cam.aspect * 0.8), GAL_ENVELOPE_R / (tV * 0.8));
    var dir = new THREE.Vector3(0, 0.40, 1).normalize();           // same elevated, slightly-behind angle the old static shot used
    return { pos: b.c.clone().add(dir.multiplyScalar(d)), look: b.c.clone() };
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
    if (key === 'fabric') return { kind: 'fabric' };
    if (key.indexOf('wired:') === 0) return { kind: 'wired', id: key.slice(6) };
    if (key.indexOf('ap:') === 0) return { kind: 'ap', id: key.slice(3) };
    if (key.indexOf('host:pve:') === 0) return { kind: 'host', node: key.slice(9) };
    if (key.indexOf('blk:pve:') === 0) { var p = key.split(':'); return { kind: 'blk', node: p[2], cat: p[3] }; }
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
    return { c: worldC, r: r };
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
    return { c: worldC, r: r };
  }
  function fabricBounds() {
    var pts = [SUN, fab.gateway.pos, fab.switch.pos, fab.ap.pos], c = new THREE.Vector3();
    pts.forEach(function (p) { c.add(p); }); c.multiplyScalar(1 / pts.length);
    var r = 60; pts.forEach(function (p) { var d = p.distanceTo(c); if (d > r) r = d; });
    return { c: c, r: r };
  }
  function hostShot(node) {
    var b = galaxyBounds(node); if (!b) return SHOTS_NODE[node] || SHOTS_NODE[NODES[0].id];
    var gal = galaxies[node], dir = b.c.clone().sub(gal.world); if (dir.lengthSq() < 1) dir.set(1, 0.3, 0); dir.normalize();
    return { pos: b.c.clone().add(dir.multiplyScalar(b.r * 1.7)).add(new THREE.Vector3(0, b.r * 0.55 + 30, 0)), look: b.c.clone() };
  }
  function blkShot(node, cat) {
    var cl = categoryCluster(node, cat); if (!cl) return hostShot(node);
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
    return { pos: cl.c.clone().add(approach.multiplyScalar(cl.r * 2.4 + 25)).add(new THREE.Vector3(0, cl.r * 0.65 + 22, 0)), look: cl.c.clone() };
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
  function fabricShotForId(id) { var kind = fabKindOf(id); return kind ? planetShotFor(kind) : SHOTS_STATIC.fabric; }
  // THE EDGE: camera parked just estate-side of the sun, off its axis, so the sun sits in the lower-left
  // foreground (halo trimmed by sunNear) and the violet disc fills the frame behind it
  function edgeShot() { return { pos: SUN.clone().add(new THREE.Vector3(-180, 60, 520)), look: SUN.clone().lerp(EDGE_POS, 0.5) }; }
  // intrusion cut: tighter on the sun so the shield ring reads, EDGE still behind it
  function threatShot() { return { pos: SUN.clone().add(new THREE.Vector3(-150, 50, 400)), look: SUN.clone().lerp(EDGE_POS, 0.32) }; }
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
  function shotFor(subj) {
    switch (subj.kind) {
      case 'over': return overviewShot();
      case 'wan': return SHOTS_STATIC.wan;
      case 'edge': return edgeShot();
      case 'fabric': return SHOTS_STATIC.fabric;
      case 'wired': return fabricShotForId(subj.id);
      case 'ap': return fabricShotForId(subj.id);
      case 'host': return hostShot(subj.node);
      case 'blk': return blkShot(subj.node, subj.cat);
    }
    return overviewShot();
  }
  function subFor(subj) {
    switch (subj.kind) {
      case 'over':
        var up = S.guests.filter(function (g) { return g.status === 'running'; }).length;
        return up + ' / ' + S.guests.length + ' services up \u00b7 ' + plural(N_NODES, 'node') + ', one estate';
      case 'wan':
        return '↓ ' + fmtBps(FAM.wan_in.bps) + '   ↑ ' + fmtBps(FAM.wan_out.bps);
      case 'edge':
        return edgeSub() + (edgeInfo.pops.length ? ' · ' + edgeInfo.pops.join(' ') : '');
      case 'fabric':
        return 'gateway · switch · ap · ' + moonState.length + ' clients';
      case 'wired': case 'ap':
        var kind = fabKindOf(subj.id), f = kind && fab[kind];
        if (!f || !f.meta) return '—';
        var mm = f.meta.meta || {}, n = moonState.filter(function (m) { return m.kind === kind; }).length;
        return (mm.model || '') + ' · ' + (f.meta.ip || '') + ' · ' + n + ' clients · ↓' + fmtBps(f.meta.rx) + ' ↑' + fmtBps(f.meta.tx);
      case 'host':
        var gl = S.guests.filter(function (g) { return g.node === subj.node; }), up2 = gl.filter(function (g) { return g.status === 'running'; }).length;
        var nd = S.nodes.filter(function (n) { return n.node === subj.node; })[0] || {};
        return subj.node + ' · ' + up2 + ' / ' + plural(gl.length, 'guest') + ' · CPU ' + (nd.cpu || 0).toFixed(0) + '%';
      case 'blk':
        var gl2 = S.guests.filter(function (g) { return g.node === subj.node && g.cat === subj.cat; }), up3 = gl2.filter(function (g) { return g.status === 'running'; }).length;
        return subj.cat.toUpperCase() + ' · ' + up3 + ' / ' + gl2.length + ' up';
    }
    return '';
  }
  function applyLabelSubject(subj) { LABEL.mode = subj.kind; LABEL.node = subj.node; LABEL.cat = subj.cat; LABEL.id = subj.id; refreshLabels(); }
  function setFocus(catIdx, galId) { NODES.forEach(function (n) { galaxies[n.id].guests.material.uniforms.uFocus.value = (galId === n.id) ? catIdx : -1; }); }
  function focusFor(subj) { setFocus(subj.kind === 'blk' ? CATS.indexOf(subj.cat) : -1, (subj.kind === 'blk' || subj.kind === 'host') ? subj.node : null); }
  function shockwave() { beat = Math.max(beat, 0.8); NODES.forEach(function (n) { galaxies[n.id].ringT = 0; }); }

  /* content-anchored waypoint insertion, shared by every director state (sync/free/showcase):
     a straight pos+look lerp between two shots can swing the look-target across genuinely
     empty sky when the shots are on opposite sides of the estate (e.g. the AP planet out by
     the sun -> a category cluster in a far galaxy) — this was the actual cause of "panning to
     blank space". needsHub() checks whether the leg's look-target midpoint passes near any
     real content; if not, the travel is routed through the OVERVIEW shot instead (it always
     frames both galaxies + the sun, so the screen is never empty) via travelLerp()'s 2-half split. */
  var BRIDGE_MID = new THREE.Vector3(0, 90, 0);
  var CONTENT_ANCHORS = NODES.map(function (n) { return { c: galaxies[n.id].world, r: 340 }; })
    .concat([{ c: SUN, r: 300 }, { c: BRIDGE_MID, r: 280 }, { c: EDGE_POS, r: 700 }]);
  var _hubMid = new THREE.Vector3();
  function nearContent(p) {
    for (var i = 0; i < CONTENT_ANCHORS.length; i++) { if (p.distanceTo(CONTENT_ANCHORS[i].c) < CONTENT_ANCHORS[i].r) return true; }
    var fb = fabricBounds(); return p.distanceTo(fb.c) < fb.r + 160;
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
  function mkLeg() { return { cp: new THREE.Vector3(), cl: new THREE.Vector3() }; }
  function legSetup(leg, from, to, hub, lift) {
    lift = lift == null ? 1 : lift;
    if (hub) {
      leg.cp.copy(from.pos).add(to.pos).multiplyScalar(-0.5).addScaledVector(hub.pos, 2);
      leg.cl.copy(from.look).add(to.look).multiplyScalar(-0.5).addScaledVector(hub.look, 2);
    } else {
      var len = from.pos.distanceTo(to.pos);
      leg.cp.copy(from.pos).add(to.pos).multiplyScalar(0.5); leg.cp.y += lift * Math.min(len * 0.28, 220);
      leg.cl.copy(from.look).add(to.look).multiplyScalar(0.5); leg.cl.y += lift * Math.min(len * 0.05, 36);
    }
  }
  // raw is the UNEASED 0..1 leg progress; writes straight into the shared camPos/camLook,
  // no allocation (copy/multiplyScalar/addScaledVector on the two shared vectors)
  function travelLerp(from, to, raw, leg) {
    var e = smootherstep(raw), a = (1 - e) * (1 - e), b = 2 * (1 - e) * e, c = e * e;
    camPos.copy(from.pos).multiplyScalar(a).addScaledVector(leg.cp, b).addScaledVector(to.pos, c);
    camLook.copy(from.look).multiplyScalar(a).addScaledVector(leg.cl, b).addScaledVector(to.look, c);
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
    for (var ci2 = 0; ci2 < N_NODES; ci2++) {
      var gC = galaxies[NODES[ci2].id];
      clampAwayFrom(gC.world, gC.coreR * 3 + 40);
    }
    var dist = Math.max(60, camPos.distanceTo(camLook));
    var v = dt > 0 ? (camPos.distanceTo(_prevPos) + camLook.distanceTo(_prevLook)) / dist / dt : 0;
    _prevPos.copy(camPos); _prevLook.copy(camLook);
    camSpeed += (v - camSpeed) * (1 - Math.exp(-dt / 0.1));
    cam.position.copy(camPos); cam.lookAt(camLook);
    sky.position.copy(camPos);
  }
  // parked on a shot: the slow orbit sway, entered through a short eased settle from wherever
  // the camera actually is. The sync director used to hard-copy the hold shot into camPos the
  // instant the wall reported "hold" — and because shotFor() recomputes from the galaxy's live
  // rotation, that shot never quite matched the one the travel leg had been flying toward, so
  // every arrival ended on a visible pop. Now it glides the last few units over ~0.7s.
  function holdPose(sh, dt) {
    D.hold += dt; D.orbit += dt;
    _rel.copy(sh.pos).sub(sh.look).applyAxisAngle(_UP, Math.sin(D.orbit * 0.11) * 0.16); _rel.y += Math.sin(D.orbit * 0.07) * 18;
    _tp.copy(sh.look).add(_rel); _tl.copy(sh.look);
    if (D.settleT < 1) {
      D.settleT = Math.min(1, D.settleT + dt / 0.7); var e = smootherstep(D.settleT);
      camPos.lerpVectors(D.settleFrom.pos, _tp, e); camLook.lerpVectors(D.settleFrom.look, _tl, e);
    } else { camPos.copy(_tp); camLook.copy(_tl); }
  }
  function beginHold(sh) { D.settleFrom.pos.copy(camPos); D.settleFrom.look.copy(camLook); D.settleT = 0; D.hold = 0; D.orbit = 0; D.toShot = sh; D.to = sh; }
  function beginTravel(sh, subj, hubShot) {
    D.from.pos.copy(camPos); D.from.look.copy(camLook); D.toShot = sh; D.to = sh; D.toSubj = subj; D.subject = subj;
    legSetup(D.leg, D.from, sh, hubShot); D.pendingSubj = subj; D.travelRaw = 0;
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
  function setCaptionRaw(cap, sub) {
    var capEl = $('cap'), subEl = $('capsub');
    if (cap === CAP_CUR) { if (!CAP_T && subEl.textContent !== sub) subEl.textContent = sub; return; }
    CAP_CUR = cap;
    capEl.style.opacity = '0'; subEl.style.opacity = '0';
    if (CAP_T) clearTimeout(CAP_T);
    CAP_T = setTimeout(function () { CAP_T = null; capEl.textContent = cap; subEl.textContent = sub; capEl.style.opacity = '1'; subEl.style.opacity = '1'; }, 380);
  }

  function directorSyncTick(dt) {
    if (D.inTravel && D.toShot) {
      var el = (performance.now() - D.travelT0) / 1000;
      var raw = clamp(D.travelProgBase + el / D.travelS, 0, 1);
      // our leg starts at 0 from wherever the camera really was when the wall's travel first
      // reached us (SSE latency means prog can already be 0.1-0.3 by then — lerping straight
      // to e(0.3) from the current pose was a visible jump) and lands at 1 with the wall
      var local = D.travelP0 < 0.98 ? clamp((raw - D.travelP0) / (1 - D.travelP0), 0, 1) : 1;
      if (local < D.travelRaw) local = D.travelRaw;    // a re-anchoring tick never runs the camera backwards
      D.travelRaw = local;
      travelLerp(D.from, D.toShot, local, D.leg); travelSubjectTick(local);
    } else if (D.toShot) holdPose(D.toShot, dt);
    applyCam(dt);
  }
  // #cap only ever shows a DISPLAY name: the wall's stop_name when it has one, else a fixed title per stop kind.
  // (A raw key like "over:0" leaked into the caption once via a caller passing the key as the name.)
  var KIND_NAME = { over: 'OVERVIEW', wan: 'WAN EDGE', edge: 'THE EDGE', fabric: 'THE FABRIC', wired: 'WIRED', ap: 'WIRELESS', host: 'GALAXY', blk: 'CATEGORY', none: 'THE ESTATE' };
  function stopName(key, name) {
    if (name && name.toLowerCase() !== String(key).toLowerCase()) return name;
    var st = freeStops().filter(function (x) { return x.key === key; })[0];
    if (st && st.name) return st.name;
    var subj = parseStop(key);
    /* the configured label, not the raw Proxmox node id */
    function nlab(id) { var n = NODE_BY_ID[id]; return n ? n.label : String(id || '').toUpperCase(); }
    if (subj.kind === 'host') return nlab(subj.node) + ' GALAXY';
    if (subj.kind === 'blk') return nlab(subj.node) + ' \u00b7 ' + String(subj.cat || '').toUpperCase();
    return KIND_NAME[subj.kind] || 'OVERVIEW';
  }
  function freeGoto(key, name) {
    var subj = parseStop(key), sh = shotFor(subj);
    beginTravel(sh, subj, needsHub(camLook, sh.look) ? overviewShot() : null);
    D.t = 0; D.dur = 1.6;
    setCaption(stopName(key, name), subFor(subj));
  }
  function directorFreeTick(dt) {
    if (D.t < 1) {
      D.t = Math.min(1, D.t + dt / D.dur);
      travelLerp(D.from, D.to, D.t, D.leg); travelSubjectTick(D.t);
      if (D.t >= 1) beginHold(D.to);
    } else {
      holdPose(D.to, dt);
      if (D.hold > 5.5) {
        var stops = freeStops();
        D.freeIdx = (D.freeIdx + 1) % stops.length;
        freeGoto(stops[D.freeIdx].key, stops[D.freeIdx].name);
      }
    }
    applyCam(dt);
  }
  // the wall's own stop list plus THE EDGE (a TV-only stop: the wall has no such subject)
  var EDGE_STOP = { key: 'edge', name: 'THE EDGE' };
  function freeStops() { return (WALL.stops.length ? WALL.stops : [{ key: 'over:0', name: 'OVERVIEW' }]).concat([EDGE_STOP]); }
  function enterFreeRoam() {
    D.mode = 'free'; D.freeIdx = 0;
    var stops = freeStops();
    freeGoto(stops[0].key, stops[0].name);
  }
  addEventListener('keydown', function (e) { if (e.key === ' ') { D.mode = 'free'; D.hold = 999; } });

  /* wall sync v2: SSE stream of /api/lightstate (falls back to 1 Hz polling) drives the
     director in lockstep — travel legs ease with the wall's own prog, re-anchored on
     every update so motion stays smooth between the wall's ~5 Hz ticks. */
  var WALL = { stops: [], lastKey: '', lastBeat: -1 };
  function applyWallState(s) {
    var fresh = s && s.ts && (Date.now() / 1000 - s.ts) < 20;
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
    D.mode = 'sync';
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
        beginTravel(sTo, toSubj, needsHub(camLook, sTo.look) ? overviewShot() : null);
        D.travelP0 = clamp(s.prog || 0, 0, 1);
      }
      D.travelProgBase = s.prog || 0; D.travelT0 = performance.now(); D.travelS = Math.max(0.1, s.travel_s || 2); D.inTravel = true;
      setCaption(s.to_name || '', subFor(toSubj));
    } else {
      var subj = parseStop(s.stop), hkey = 'hold:' + s.stop;
      if (D.inTravel || WALL.lastKey !== hkey) {
        WALL.lastKey = hkey;
        beginHold(shotFor(subj));
        // the travel leg normally applies the subject itself at 40% (travelSubjectTick); only
        // a hold that arrives without one (fresh sync, or a leg cut short) still needs it
        if (D.pendingSubj || !sameSubj(D.toSubj, subj)) { D.pendingSubj = null; applyLabelSubject(subj); focusFor(subj); }
        D.toSubj = subj;
      }
      D.subject = subj; D.inTravel = false;
      setCaption(s.stop_name || '', subFor(subj));
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
    function chapter(cap, subFn, subj, pts, panMul) {
      panMul = panMul || 1;
      var idx = CH.length; CH.push({ cap: cap, sub: subFn, subj: subj || { kind: 'over' } });
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
    chapter('THE ESTATE', function () { return plural(S.guests.length, 'guest') + ' \u00b7 ' + plural(N_NODES, 'node') + ' \u00b7 one estate'; }, { kind: 'over' }, dwellPair(OV, 0.2, 1.0, 0.92));
    chapter(WAN_LABEL + ' \u00b7 WAN', function () { return '\u2193 ' + fmtBps(FAM.wan_in.bps) + '   \u2191 ' + fmtBps(FAM.wan_out.bps); }, { kind: 'wan' }, dwellPair(SHOTS_STATIC.wan));
    chapter('THE EDGE', function () { return subFor({ kind: 'edge' }); }, { kind: 'edge' }, dwellPair(edgeShot(), 0.3, 0.92, 0.9));

    var fb = fabricBounds();
    chapter('THE FABRIC', function () { return moonState.length + ' clients · gateway · switch · ap'; }, { kind: 'fabric' },
      dwellPair({ pos: fb.c.clone().add(new THREE.Vector3(fb.r * 1.6, fb.r * 0.9, fb.r * 1.2)), look: fb.c.clone() }));

    chapter('WIRELESS', function () {
      var n = moonState.filter(function (m) { return m.kind === 'ap'; }).length;
      var apName = (fab.ap.meta && (fab.ap.meta.label || fab.ap.meta.id)) || 'access point';
      return n + ' wireless clients \u00b7 ' + apName;
    }, { kind: 'ap', id: fabIds.ap }, dwellPair(planetShotFor('ap')));

    // dwellPair (not two independent bridgeShot() endpoints): verified on the real screen that
    // panning end-to-end across the whole curve put the camera equidistant from BOTH galaxies
    // at the pan's midpoint — the exact "empty sky" case item 1 warns about, just self-inflicted
    // within one chapter instead of between two. Orbiting a single near-GPU anchor keeps a
    // galaxy in frame for the chapter's entire span, same as every other chapter.
    if (N_NODES > 1) {
      chapter('THE BRIDGE', function () { return FAM.bridge.bps > 0 ? fmtBps(FAM.bridge.bps) + ' measured' : 'bridge quiet'; }, { kind: 'none' }, dwellPair(bridgeShot(0.2, NODES[0].id)));
    }

    /* one galaxy chapter per configured node, in config order. A node with only
       a handful of guests gets no per-category chapters: with 1-3 guests per
       category that shot is one small star lost in the background starfield,
       never a usable "category" shot. It gets the reclaimed time instead as a
       slower lowPass() sweep (a real pan across the arm) at 2.2x the normal pan
       length. The threshold matches the wall's own host-vs-block tour rule. */
    var BLK_MIN = 10;
    NODES.forEach(function (nd) {
      var id = nd.id;
      var own = S.guests.filter(function (g) { return g.node === id; });
      var big = own.length >= BLK_MIN;
      chapter(nd.label + ' GALAXY',
        (function (i) { return function () { var gl = S.guests.filter(function (g) { return g.node === i; }); return plural(gl.length, 'guest') + ' \u00b7 ' + gl.filter(function (g) { return g.status === 'running'; }).length + ' up'; }; })(id),
        { kind: 'host', node: id }, lowPass(id), big ? 1 : 2.2);
      if (!big) return;
      CATS.forEach(function (cat) {
        var n = own.filter(function (g) { return g.cat === cat; }).length;
        if (!n) return;                                   // never frame an empty category
        chapter(nd.label + ' \u00b7 ' + cat.toUpperCase() + ' (' + n + ')',
          (function (i, c) { return function () { var gl = S.guests.filter(function (g) { return g.node === i && g.cat === c; }); return gl.filter(function (g) { return g.status === 'running'; }).length + ' / ' + gl.length + ' up'; }; })(id, cat),
          { kind: 'blk', node: id, cat: cat }, dwellPair(blkShot(id, cat)));
      });
    });

    // close the loop back to chapter 0's first point — same hub rule as any other leg
    var first = SEQ[0], last = SEQ[SEQ.length - 1];
    if (needsHub(last.look, first.look)) SEQ.push({ pos: OV.pos.clone(), look: OV.look.clone(), chapter: -1, dur: TRANS_S });

    SC.chapters = CH; SC.seq = SEQ; SC.built = true;
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
    }
    var sp = $('scbar');
    if (sp) { var frac = (SC.legIdx + SC.legT) / n; var tx = 'scaleX(' + frac.toFixed(3) + ')'; if (sp.dataset.tx !== tx) { sp.dataset.tx = tx; sp.style.transform = tx; } }
  }
  function toggleShowcase(on) {
    SC.active = on; document.body.classList.toggle('nx-showcase', on);
    if (on) {
      buildShowcase(); SC.legIdx = 1; SC.legT = 0; SC.chapter = -1; SC.legReady = false;
      camPos.copy(SC.seq[0].pos); camLook.copy(SC.seq[0].look);   // snap to the first waypoint so leg 1 starts from where it's actually drawn, not wherever the camera was a moment ago
    } else { WALL.lastKey = ''; D.pendingSubj = null; pollLightstate(); }   // force an immediate re-sync back to the wall
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
  var THREAT = { seq: null, capHold: false, capUntil: 0, pendCap: null, pendSub: null, prevCap: null, prevSub: null, cutUntil: 0,
                 secUntil: 0, secOn: false, flashT: 0, waveT: 9, nextCurve: 0, chip: '', last: null };
  var TC = { on: false, from: { pos: new THREE.Vector3(), look: new THREE.Vector3() }, to: null, leg: mkLeg(), t: 1, dur: 0.9, hold: 0 };
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
  function threatCaption(cap, sub) {
    if (!THREAT.capHold) { THREAT.capHold = true; THREAT.prevCap = CAP_CUR; THREAT.prevSub = $('capsub').textContent; THREAT.pendCap = null; }
    document.body.classList.add('nx-threat');
    setCaptionRaw(cap, sub); THREAT.capUntil = performance.now() + 5000;
  }
  function threatCaptionTick(now) {
    if (!THREAT.capHold || now < THREAT.capUntil) return;
    THREAT.capHold = false; document.body.classList.remove('nx-threat');
    if (THREAT.pendCap != null) setCaptionRaw(THREAT.pendCap, THREAT.pendSub); else if (THREAT.prevCap != null) setCaptionRaw(THREAT.prevCap, THREAT.prevSub);
    THREAT.pendCap = null;
  }
  function beginThreatCut() {
    THREAT.cutUntil = performance.now() + 5000;
    if (TC.on || SC.active) return;                             // re-entrant: a second event only extends the cut
    TC.on = true; TC.t = 0; TC.hold = 0; TC.from.pos.copy(camPos); TC.from.look.copy(camLook); TC.to = threatShot();
    legSetup(TC.leg, TC.from, TC.to, null, 0.35);
    applyLabelSubject({ kind: 'threat' }); setFocus(-1, null);
  }
  function threatCutTick(dt) {
    if (TC.t < 1) { TC.t = Math.min(1, TC.t + dt / TC.dur); travelLerp(TC.from, TC.to, TC.t, TC.leg); }
    else { TC.hold += dt; _rel.copy(TC.to.pos).sub(TC.to.look).applyAxisAngle(_UP, Math.sin(TC.hold * 0.35) * 0.05); camPos.copy(TC.to.look).add(_rel); camLook.copy(TC.to.look); }
    applyCam(dt);
  }
  function endThreatCut() {
    TC.on = false;
    if (SC.active) return;
    applyLabelSubject(D.subject || { kind: 'over' }); focusFor(D.subject || { kind: 'over' });
    if (D.mode === 'sync') { if (D.toShot) beginHold(D.toShot); WALL.lastKey = ''; pollLightstate(); }
    else if (D.to) { D.from.pos.copy(camPos); D.from.look.copy(camLook); legSetup(D.leg, D.from, D.to, null, 0.35); D.t = 0; D.dur = 1.4; D.pendingSubj = null; }
  }
  function threatArrive() { THREAT.flashT = 1.3; THREAT.waveT = 0; }
  function threat(e) {
    if (!e) return; THREAT.last = e;
    if (e.src === 'secmon') {
      var sb = $('status-big'), title = String(e.title || 'SECURITY FINDING').toUpperCase();
      sb.textContent = title.length > 26 ? title.slice(0, 25) + '…' : title; sb.className = 'big down sec';
      THREAT.secUntil = performance.now() + 6000; THREAT.secOn = true;
      (e.hosts || []).forEach(function (h) { var gid = galaxyForHost(h); if (gid) { galaxies[gid].ringT = 0; galaxies[gid].ringRed = 1.4; } });
      return;
    }
    // crowdsec: launch from the EDGE rim at an angle hashed from the country, two comets a beat apart
    var ang = hash(e.cc || e.id || 'x') * 6.283, ci = THREAT.nextCurve++ % TH_N, cv = CURVES['th' + ci];
    _local.set(Math.cos(ang) * 235, 0, Math.sin(ang) * 235); EDGE.G.localToWorld(_local);
    cv.v0.copy(_local); cv.v3.copy(SUN); cv.v1.copy(_local).lerp(SUN, 0.3); cv.v1.y += 70; cv.v2.copy(SUN).lerp(_local, 0.3); cv.v2.y += 50;
    cometSpawn('th' + ci, 0); cometSpawn('th' + ci, -0.025); cometSpawn('th' + ci, -0.05); cometSpawn('th' + ci, -0.075);
    var as = shortAS(e.as_name, ''), parts = [e.cc, as !== '?' ? as : '', e.title, e.events ? plural(+e.events, 'event') : ''].filter(function (x) { return !!x; });
    threatCaption('INTRUSION BLOCKED', parts.join(' · '));
    beginThreatCut();
  }
  function threatChip(d) {
    var el = $('status-threat'); if (!el || !d) return;
    var c = d.counts || {}, lvl = +d.level || 0;
    var txt = 'THREAT ' + (d.name || ['GREEN', 'YELLOW', 'RED', 'BLACK'][lvl] || '?') + ' · ' + (c.secmon_critical || 0) + ' crit · ' + (c.secmon_high || 0) + ' high · ' + (c.banned || 0) + ' banned';
    if (txt !== THREAT.chip) { THREAT.chip = txt; el.textContent = txt; el.style.color = THREAT_COL[lvl] || THREAT_COL[0]; }
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
      var mm = m.meta || {}, n = moonState.filter(function (x) { return x.kind === k; }).length;
      setLabelText(L, m.label || k.toUpperCase(), (mm.model || '') + ' · ' + (m.ip || '') + ' · ' + n + ' clients · ↓' + fmtBps(m.rx) + ' ↑' + fmtBps(m.tx));
    });
    flushLabelMeasure();
  }
  function pollAll() {
    fetch('/api/all', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) {
      S.tele = d.telemetry || null; S.guests = d.guests || []; S.nodes = d.nodes || []; S.pools = d.pools || []; S.storage = d.storage || []; S.zbx = d.zabbix || {}; S.unifi = d.unifi || {};
      S.edge = d.edge || null; S.external = d.external || null;
      NODES.forEach(function (n) { fillGuests(galaxies[n.id], S.guests.filter(function (g) { return g.node === n.id; })); });
      try { exoUpdate(S.external); } catch (e) { console.error('nexus exo', e); }
      try { edgeUpdate(S.edge, S.external); } catch (e) { console.error('nexus edge', e); }
      if (S.edge && S.edge.threats && THREAT.seq === null) threatChip(S.edge.threats);
      hud();
    }).catch(function () { });
    fetch('/api/topology', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) {
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
        NODES.forEach(function (n) { FAM[UP_FAM[n.id]].bps = linkBps[fabIds.gateway + '>pve:' + n.id] || 0; });
      }
      // routed through setLabelText (not a direct .textContent poke) so the shrink-wrapped
      // box gets re-measured whenever the sub-line's length changes — see labelsTick's use
      // of L.w for the true edge-clipping guard
      setLabelText(L_bridge, BRIDGE_TITLE, bridge > 0 ? fmtBps(bridge) + ' measured' : 'quiet');
      setLabelText(L_sun, WAN_LABEL + ' \u00b7 WAN', '\u2193 ' + fmtBps(FAM.wan_in.bps) + '   \u2191 ' + fmtBps(FAM.wan_out.bps) + (S.unifi && S.unifi.latency != null ? '   ' + S.unifi.latency + ' ms' : ''));
      updatePlanetLabels();
      refreshLabels();                                                     // client label content (rx/tx) just moved
    }).catch(function () { });
  }
  function pollShowtime() {
    fetch('/api/showtime', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) { S.showtime = d; hud(); }).catch(function () { });
    fetch('/api/gpu').then(function (r) { return r.json(); }).then(function (j) { S.gpus = (j && j.gpus) || []; hud(); }).catch(function () { });
  }
  setInterval(pollAll, 6000); pollAll();
  setInterval(pollShowtime, 5000); pollShowtime();

  /* ============================== HUD ============================== */
  var lastHud = '';
  function bar(pct, cls) { return '<i class="bar ' + (cls || '') + '"><b style="width:' + clamp(pct, 0, 100).toFixed(0) + '%"></b></i>'; }
  /* One card per configured node, created here (nexus.html ships two empty
     columns, not two hardwired ids). Even node indices go left, odd right, so
     a 2-node estate is the original left/right pair and a 5-node estate stacks
     3 + 2. The accent stripe is the node's own colour. */
  var cardEl = {};
  (function buildCards() {
    var L = $('cards-l'), R = $('cards-r');
    if (!L || !R) return;
    NODES.forEach(function (n) {
      var d = document.createElement('div');
      d.className = 'card'; d.id = 'card-' + n.index;
      d.style.setProperty('--acc', '#' + ('00000' + n.accent.toString(16)).slice(-6));
      (n.index % 2 === 0 ? L : R).appendChild(d);
      cardEl[n.id] = d;
    });
  })();
  /* A row is rendered only when the data behind it exists, so nothing here
     assumes one node owns the GPUs and another owns the disks. Estate-wide
     blocks (backup server, edge, SLO) land on the LAST card once. */
  function hud() {
    var out = {}, last = NODES[N_NODES - 1];
    NODES.forEach(function (n) {
      var nd = S.nodes.filter(function (x) { return x.node === n.id; })[0] || {}, gl = S.guests.filter(function (g) { return g.node === n.id; });
      var up = gl.filter(function (g) { return g.status === 'running'; }).length;
      var memp = nd.mem_total ? nd.mem_used / nd.mem_total * 100 : 0;
      var f = function (v, d) { return (v == null || isNaN(v)) ? '\u2014' : Number(v).toFixed(d || 0); };
      var h = '<div class="k">' + n.label + '<em>' + up + '/' + plural(gl.length, 'guest') + ' up</em></div>';
      h += '<div class="r"><span>CPU</span>' + bar(nd.cpu || 0) + '<b>' + (nd.cpu || 0).toFixed(0) + '%</b></div>';
      h += '<div class="r"><span>MEM</span>' + bar(memp) + '<b>' + fmtGB(nd.mem_used || 0) + ' / ' + fmtGB(nd.mem_total || 0) + ' GB</b></div>';
      h += '<div class="r"><span>LOAD</span><b class="mono">' + (nd.load != null ? nd.load.toFixed(1) : '\u2014') + ' / ' + (nd.cores || '\u2014') + ' cores</b></div>';

      /* GPUs: whichever node actually reports them. /api/gpu entries carry a
         `host`; with only one GPU host and no host field they fall to node 0. */
      var mine = S.gpus.filter(function (g) { return g.host ? g.host === n.id : n.index === 0; });
      mine.forEach(function (g) {
        var nm = String(g.name || 'GPU').replace('NVIDIA GeForce ', '');
        h += '<div class="r gpu"><span>' + nm + '</span>' + bar(g.util || 0, 'pink') + '<b>' + (g.util || 0) + '% \u00b7 ' + g.temp + '\u00b0C \u00b7 ' + Math.round(g.power || 0) + ' W</b></div>';
        h += '<div class="r"><span>VRAM</span>' + bar(g.mem_total ? g.mem_used / g.mem_total * 100 : 0, 'cyan') + '<b>' + (g.mem_used / 1024).toFixed(1) + ' / ' + (g.mem_total / 1024).toFixed(0) + ' GB</b></div>';
      });
      var st = S.showtime;
      if (mine.length) {
        ((st && st.ollama) || []).forEach(function (o) {
          var m = (o.loaded || []).map(function (x) { return x.name + (x.busy ? ' \u25cf' : ''); }).join(', ');
          // an 'idle' row is a row of nothing: only show the inference server when something is loaded
          if (m) h += '<div class="r"><span>llm\u00b7' + o.name + '</span><b class="hot2">' + m + '</b></div>';
        });
        var cor = st && st.coral;
        if (cor) h += '<div class="r"><span>DETECTOR</span><b>' + (cor.model || cor.detector) + ' \u00b7 ' + (cor.inference_ms != null ? cor.inference_ms.toFixed(1) + ' ms' : '') + (st.frigate && st.frigate.detection_fps != null ? ' \u00b7 ' + st.frigate.detection_fps.toFixed(0) + ' det/s' : '') + '</b></div>';
      }

      // ZFS pools reported for THIS node
      S.pools.filter(function (p) { return p.node === n.id; }).forEach(function (p) {
        var pct = p.size ? p.alloc / p.size * 100 : 0;
        h += '<div class="r"><span>zfs\u00b7' + p.name + '</span>' + bar(pct, p.health === 'ONLINE' ? 'amber' : 'red') + '<b>' + (p.alloc / 1099511627776).toFixed(1) + ' / ' + (p.size / 1099511627776).toFixed(0) + ' TB \u00b7 ' + p.health + '</b></div>';
      });

      /* telemetry exporters: the per-node maps (smart_*, arc_hit) are keyed by
         node id, so each card shows its own drives and nothing else's */
      var T = S.tele;
      if (T && T.up) {
        var sn = (T.smart_n || {})[n.id], shot = (T.smart_hot || {})[n.id], sworn = (T.smart_worn || {})[n.id], sarc = (T.arc_hit || {})[n.id];
        if (sn != null || shot != null) {
          h += '<div class="r"><span>DRIVES</span><b class="' + (T.smart_bad ? 'hot2' : '') + '">' + f(sn) + (T.smart_bad ? ' \u00b7 ' + T.smart_bad + ' FAIL' : ' ok') + ' \u00b7 ' + f(shot) + '\u00b0C' + (sworn != null ? ' \u00b7 worn ' + f(sworn) + '%' : '') + (sarc != null ? ' \u00b7 arc ' + f(sarc) + '%' : '') + '</b></div>';
        }
      }

      /* ---- estate-wide rows: once, on the last card ---- */
      if (n === last) {
        var em = st && st.emby;
        if (em) h += '<div class="r"><span>MEDIA</span><b>' + ((em.playing || []).length ? (em.playing.length + ' playing \u00b7 ') : '') + (em.count || 0) + ' sessions</b></div>';
        if (T && T.up) {
          if (T.watts != null) h += '<div class="r"><span>IRON</span>' + bar((T.watts || 0) / 6, 'amber') + '<b>' + f(T.watts) + ' W \u00b7 ' + f(T.fan_max) + ' rpm \u00b7 ' + f(T.inlet_c) + '\u00b0C</b></div>';
          if (T.pbs_up != null) h += '<div class="r"><span>BACKUPS</span>' + bar(T.pbs_used_pct || 0, T.pbs_stale ? 'amber' : 'cyan') + '<b>' + (T.pbs_up ? f(T.pbs_vms) + ' \u00b7 oldest ' + (T.pbs_oldest_h > 72 ? f(T.pbs_oldest_h / 24) + 'd' : f(T.pbs_oldest_h) + 'h') + (T.pbs_stale ? ' \u00b7 ' + T.pbs_stale + ' stale' : '') : 'DOWN') + '</b></div>';
          /* the edge line reads the tunnel + intrusion pollers; the SLO/flow-rate pair gets its own line */
          var Ecf = (S.edge && S.edge.cloudflare) || {}, Ecs = (S.edge && S.edge.crowdsec) || {}, Eau = (S.edge && S.edge.audience) || {};
          h += '<div class="r"><span>EDGE</span><b class="' + ((Ecs.alerts_1h || 0) > 0 ? 'hot2' : '') + '">'
             + (Ecf.up ? 'TUNNEL ' + f(Ecf.ha_connections) + 'c \u00b7 ' + f(Ecf.req_per_min) + ' req/m' : 'TUNNEL \u2014')
             + ' \u00b7 ' + (Ecs.up ? f(Ecs.alerts_24h) + ' atk/24h' : f(T.cs_alerts_h) + ' atk/h') + '</b></div>';
          /* REAL unique visitors only: tunnel request counters are requests, never viewers */
          if (Eau.up) h += '<div class="r"><span>AUDIENCE</span><b>' + plural(Eau.viewers_5m || 0, 'viewer') + ' \u00b7 5 min</b></div>';
          var La = null; (Ecs.top_attackers || []).forEach(function (a) { if (a && a.ts && (!La || a.ts > La.ts)) La = a; });
          if (La) {
            var ag = Math.max(0, Date.now() / 1000 - La.ts);
            var agS = ag < 3600 ? Math.round(ag / 60) + 'm' : ag < 86400 ? Math.round(ag / 3600) + 'h' : Math.round(ag / 86400) + 'd';
            var asn = String(La.as_name || '').replace(/,?\s*(PBC|Inc\.?|LLC|Ltd\.?|Limited|Corp\.?|Corporation)\b/gi, '').trim();
            if (/^[A-Z0-9 -]+$/.test(asn)) asn = asn.charAt(0) + asn.slice(1).toLowerCase();
            if (asn.length > 14) asn = asn.slice(0, 13) + '\u2026';
            /* the row ellipsises past ~30 chars: scenario before AS, AS only when it still fits */
            var line = agS + ' ago \u00b7 ' + (La.cn || '??') + ' \u00b7 ' + String(La.scenario || '').replace(/^crowdsecurity\//, '');
            if (asn && (line + ' \u00b7 ' + asn).length <= 31) line += ' \u00b7 ' + asn;
            h += '<div class="r"><span>LAST ATK</span><b>' + line + '</b></div>';
          }
          if (T.slo_total || T.flows_fps != null) {
            h += '<div class="r"><span>SLO</span><b class="' + ((T.slo_total && T.slo_ok < T.slo_total) ? 'hot2' : '') + '">' + (T.slo_total ? T.slo_ok + '/' + T.slo_total + ' up' : '\u2014') + ' \u00b7 ' + f(T.flows_fps, 1) + ' fl/s'
               + (Ecs.up && (Ecs.banned || 0) > 0 ? ' \u00b7 ' + f(Ecs.banned) + ' banned' : '') + '</b></div>';
          }
        }
      }
      // TOP-3 guest names were unreadable at TV viewing distance and just added texture
      // over the render; the per-node CPU bar above already carries the same signal.
      out[n.id] = h;
      setLabelText(L_gal[n.id], n.label, up + ' / ' + plural(gl.length, 'guest') + ' \u00b7 CPU ' + (nd.cpu || 0).toFixed(0) + '%');
      // scene: core size follows memory in use, spin follows CPU
      var gal = galaxies[n.id]; gal.coreR = 16 + memp * 0.16; gal.spin = 0.015 + (nd.cpu || 0) / 100 * 0.06;
    });
    var key = JSON.stringify(out);
    if (key !== lastHud) {
      lastHud = key;
      NODES.forEach(function (n) { if (cardEl[n.id]) cardEl[n.id].innerHTML = out[n.id]; });
    }
    // status
    var problems = (S.zbx && S.zbx.problems) || 0, sb = $('status-big'), ss = $('status-sub');
    var crit = Object.keys((S.zbx && S.zbx.alert_hosts) || {}).filter(function (h) { return (S.zbx.alert_hosts[h].sev || 0) >= 4; }).length;
    var upAll = S.guests.filter(function (g) { return g.status === 'running'; }).length;
    if (THREAT.secOn) { /* a secmon finding owns the big line for 6 s (threat()); animate() re-runs hud() when it expires */ }
    else if (crit > 0) { sb.textContent = crit + ' HOST' + (crit > 1 ? 'S' : '') + ' DOWN'; sb.className = 'big down'; }
    else if (problems > 0) { sb.textContent = 'NOMINAL · ' + problems + ' WARN'; sb.className = 'big warn'; }
    else { sb.textContent = 'ALL NOMINAL'; sb.className = 'big ok'; }
    ss.textContent = upAll + ' / ' + S.guests.length + ' SERVICES UP · ' + problems + ' OPEN PROBLEMS · ' + ((S.unifi && S.unifi.clients) || 0) + ' CLIENTS';
    refreshLabels();                                            // guest numbers (cpu/mem) just moved
  }

  /* ============================== beat ============================== */
  var beat = 0, beatSev = 0;
  (function () {
    if (typeof EventSource !== 'function') return;
    sse('/api/pulse/stream', function (ev) { try { var d = JSON.parse(ev.data); beat = 1; beatSev = d.sev || 0; NODES.forEach(function (n) { galaxies[n.id].ringT = 0; }); } catch (e) { } });
  })();

  /* ============================== loop ============================== */
  var clock = new THREE.Clock();
  var RENDER_ACTIVE = true, animRunning = true;
  /* one compound state string on <body>, the same convention the wall uses for
     data-cinema / data-doom: a headless QA run (or anyone with dev tools) can
     read what this screen is doing without reaching into the module. Written at
     most once a second, never per frame. */
  var _dsT = 0;
  function publishState(t) {
    if (t - _dsT < 1) return; _dsT = t;
    document.body.dataset.nexus =
      'nodes=' + N_NODES +
      ' director=' + (SC.active ? 'showcase' : D.mode) +
      ' stop=' + (String(CAP_CUR || '').toLowerCase().replace(/\s+/g, '_') || 'none') +
      ' phase=' + (D.t < 1 ? 'travel' : 'hold') +
      ' threat=' + (String(THREAT.chip || 'none').split(/\s+/)[1] || 'none').toLowerCase() +
      ' fps=' + Math.round(_fps);
  }
  var _fps = 0, _fpsAcc = 0, _fpsN = 0;

  function animate() {
    // Room empty (see /api/presence): drop the rAF chain; the SSE below restarts it.
    if (!RENDER_ACTIVE) { animRunning = false; return; }
    requestAnimationFrame(animate);
    var dt = Math.min(clock.getDelta(), 0.05), t = clock.getElapsedTime();
    U_TIME.value = t;
    if (dt > 0) { _fpsAcc += 1 / dt; _fpsN++; if (_fpsN >= 20) { _fps = _fpsAcc / _fpsN; _fpsAcc = 0; _fpsN = 0; } }
    publishState(t);
    beat = Math.max(0, beat - dt * 0.9);
    var alert = document.body.classList.contains('st-alert'), night = document.body.classList.contains('st-night');
    // shared projected-radius cap for every core/sun mesh: 0.18 * half-VFOV, i.e. a world-space
    // sphere at that angle projects to ~9% of the screen's height regardless of camera distance
    // (small-angle: projected half-height fraction = angle/halfVFOV, and we want that <= 0.18)
    var maxCoreAngle = 0.18 * ((cam.fov * Math.PI / 180) / 2);
    NODES.forEach(function (n) {
      var g = galaxies[n.id];
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
      if (!SC.active) g.G.rotation.y += dt * g.spin * n.spin;
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
      g.core.scale.setScalar(r); g.core.rotation.y += dt * 0.25; g.core.rotation.x += dt * 0.07;
      g.coreMat.uniforms.pulse.value = beat * (beatSev >= 3 ? 1 : 0.6);
      // halo size capped as a fraction of camera distance (not just its own near/far opacity
      // ramp) — a sprite with a fixed world-space scale reads fine from the distance it was
      // tuned at but increasingly dominates the frame as the camera closes in from any other
      // shot, exactly the additive-bloom-to-white effect seen on the galaxy establishing shots
      // TEX_GLOW's hot centre is much tighter than TEX_STAR's, so the sprite is scaled up to
      // put its long soft skirt where the old flat disc used to end
      var hs = Math.min(r * 6.5 + beat * 30, camDistG * 0.38); g.halo.scale.set(hs, hs, 1);
      g.halo.material.opacity = 0.42 * (1 - 0.55 * near);
      g.light.intensity = (2.5 + beat * 5) * (1 - 0.3 * near); g.light.color.setHex(alert ? 0xff5a6a : n.accent);
      if (g.ringRed > 0) g.ringRed -= dt;
      if (g.ringT < 1.4) { g.ringT += dt; var s = r + g.ringT * 190; g.ring.scale.set(s, s, s); g.ring.material.opacity = 0.5 * (1 - g.ringT / 1.4); g.ring.material.color.setHex((alert || g.ringRed > 0) ? 0xff5a6a : n.accent); }
      else g.ring.material.opacity = 0;
      discTick(g, near);
      g.guests.material.uniforms.uAlpha.value = night ? 0.7 : 1;
      g.coreMat.uniforms.c2.value.setHex(alert ? 0xff5a6a : n.accent);
      g.coreMat.uniforms.near.value = near;
      // register this core as a label obstacle (see OBSTACLES/projectObstacle up in the
      // labels section) using the SAME capped radius just applied to the mesh, so the clash
      // test always matches what's actually drawn, never the uncapped/unbounded coreR
      projectObstacle(OBSTACLES[n.index], g.world, r, camDistG);
    });
    // THE EDGE: same spin/near/cap/halo treatment, in its own (scaled) frame; a 7th label obstacle
    if (!SC.active) EDGE.G.rotation.y += dt * EDGE.spin;
    var camDistE = cam.position.distanceTo(EDGE.world), nearE = nearFactor(camDistE, 250, 1700);
    var rE = Math.min(EDGE.coreR * (1 + Math.sin(t * 0.8) * 0.03 + beat * 0.1), camDistE * Math.tan(maxCoreAngle) / EDGE_SCALE);
    EDGE.core.scale.setScalar(rE); EDGE.core.rotation.y += dt * 0.2; EDGE.core.rotation.x += dt * 0.05;
    EDGE.coreMat.uniforms.pulse.value = beat * 0.3; EDGE.coreMat.uniforms.near.value = nearE;
    var hsE = Math.min(rE * 6.5, camDistE * 0.38 / EDGE_SCALE); EDGE.halo.scale.set(hsE, hsE, 1); EDGE.halo.material.opacity = 0.4 * (1 - 0.55 * nearE);
    discTick(EDGE, nearE);
    projectObstacle(OBSTACLES[OB_EDGE], EDGE.world, rE * EDGE_SCALE, camDistE);
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
    projectObstacle(OBSTACLES[OB_SUN], SUN, sunR, camDistSun);
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
    sunMat.uniforms.gain.value = 1.3 - 0.6 * sunNear;
    // fabric planets: pulse with the beat, switch rings red while down
    FABKIND.forEach(function (k, ki) {
      var f = fab[k], camDistF = cam.position.distanceTo(f.pos);
      f.mat.uniforms.pulse.value = beat * 0.5;
      f.mat.uniforms.c2.value.setHex(f.down ? 0xff3b4a : FAB_COL[k]);
      f.ring.material.opacity = f.down ? (0.5 + Math.sin(t * 2) * 0.2) : 0;
      f.mat.uniforms.near.value = nearFactor(camDistF, FAB_RAD[k] * 3, FAB_RAD[k] * 16);
      f.mesh.rotation.y += dt * 0.05;
      // label obstacle (radius padded for bloom) + keep the planet's own landmark label clear of
      // the disc: viewed from above, its anchor (FAB_RAD+20 over the centre) projects INSIDE it
      var obF = OBSTACLES[OB_FAB + ki]; projectObstacle(obF, f.pos, FAB_RAD[k] * 1.25, camDistF);
      var LF = k === 'gateway' ? L_gw : k === 'switch' ? L_sw : L_ap;
      LF.off[1] = -20 - (obF.active ? obF.r * 1.05 + 6 : 0);
    });
    // moons: cheap CPU orbit (<=96 points) around whichever planet they belong to
    for (var mi = 0; mi < moonState.length; mi++) {
      var m = moonState[mi], pp = fab[m.kind].pos, a = m.ang + t * 0.05, j = m.i * 3;
      mpos[j] = pp.x + Math.cos(a) * m.r; mpos[j + 1] = pp.y + m.y; mpos[j + 2] = pp.z + Math.sin(a) * m.r;
    }
    if (moonState.length) mgeo.attributes.position.needsUpdate = true;
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
    if (TC.on && nowMs > THREAT.cutUntil) endThreatCut();
    var showcaseOn = wantShowcase();
    if (showcaseOn !== SC.active) toggleShowcase(showcaseOn);
    if (SC.active) showcaseTick(dt); else if (TC.on) threatCutTick(dt); else if (D.mode === 'free') directorFreeTick(dt); else directorSyncTick(dt);
    bloom.strength = BLOOM_BASE * (night ? 0.7 : 1) + beat * (beatSev >= 3 ? 0.9 : 0.45);
    // label anchors
    // anchor in the galaxy's own local space then transform through O (the static tilt group,
    // not G which spins continuously) — a raw world-space guess here ignored the tilt entirely
    // and drifted far from the core once the camera saw the galaxy from angles the old fixed
    // 5-shot director never used (the showcase flythrough)
    // (the fixed landmark positions/offsets are set once, right after animate — no per-frame
    // Vector3/array allocation here; only the galaxy labels need re-deriving from coreR)
    NODES.forEach(function (n) { var gal = galaxies[n.id]; _local.set(0, gal.coreR + 150, -150); gal.O.localToWorld(_local); L_gal[n.id].pos.copy(_local); });
    // world-space anchor (not O-local like the two estate galaxies): the EDGE's steep tilt puts O's +Y almost
    // along the view axis, so an O-local "above the core" landed beside the disc and off the right edge
    L_edge.pos.set(EDGE_POS.x, EDGE_POS.y + EDGE.coreR * EDGE_SCALE + 150, EDGE_POS.z);
    for (var ei2 = 0; ei2 < L_estar.length; ei2++) { var LE2 = L_estar[ei2]; if (LE2.on) { _local.fromArray(LE2.local); EDGE.G.localToWorld(_local); LE2.pos.copy(_local); } }
    L_guest.forEach(function (L) {
      if (!L.on) return;
      if (L.mode === 'guest') { _local.fromArray(L.local); L.frame.localToWorld(_local); L.pos.copy(_local); }
      else if (L.mode === 'client') { var j2 = L.orbit.i * 3; L.pos.set(mpos[j2], mpos[j2 + 1], mpos[j2 + 2]); }
    });
    labelFadeTick(dt);
    labelsTick(dt);
    composer.render();
  }
  NODES.forEach(function (n) { L_gal[n.id].off = [0, -40]; }); L_edge.off = [0, -40];
  L_sun.pos.set(SUN.x, SUN.y - 120, SUN.z); L_sun.off = [0, 40];
  L_bridge.pos.set(0, 176, 0); L_bridge.off = [0, -30];
  L_gw.pos.set(fab.gateway.pos.x, fab.gateway.pos.y + FAB_RAD.gateway + 20, fab.gateway.pos.z); L_gw.off = [0, -20];
  L_sw.pos.set(fab.switch.pos.x, fab.switch.pos.y + FAB_RAD.switch + 16, fab.switch.pos.z); L_sw.off = [0, -20];
  L_ap.pos.set(fab.ap.pos.x, fab.ap.pos.y + FAB_RAD.ap + 16, fab.ap.pos.z); L_ap.off = [0, -20];
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
  animate();
  addEventListener('resize', function () { cam.aspect = innerWidth / innerHeight; cam.updateProjectionMatrix(); rndr.setSize(innerWidth, innerHeight); composer.setSize(innerWidth, innerHeight); });
  window.composer = composer;           // the render-count probe looks for this
  window.NEXUS = { S: S, D: D, SC: SC, galaxies: galaxies, fab: fab, FAM: FAM, composer: composer, play: function (v) { SC.manual = !!v; },
                   EDGE: EDGE, THREAT: THREAT, TC: TC, ROCKETS: ROCKETS, threat: threat, edgeStars: function () { return edgeStars; },
                   edgeUpdate: edgeUpdate, edgeInfo: edgeInfo, viewQueue: function () { return viewQueue; },
                   goto: function (key, name) { D.mode = 'free'; freeGoto(key, name); }, sky: sky, stopName: stopName,
                   pinFree: function (v) { D.pinFree = !!v; if (!v) { WALL.lastKey = ''; pollLightstate(); } },
                   moons: function () { return moonState.map(function (m) { return { id: m.client.id, kind: m.kind, status: m.client.status }; }); } };
})();
