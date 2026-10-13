/* ============================================================================
   netscene.js — live network-topology scene for the homelab wall dashboard
   A data-driven view of the real network:
   WAN -> gateway -> switches/APs -> Proxmox hosts -> guests, with traffic
   animated along the real physical links only.

   Reads:   /api/topology (pushed in by the page as netSceneUpdate(topo)):
              nodes[] {id,kind,label,parent,ip,status,rx,tx,measured,meta{}}
              links[] {a,b,measured,bps,...}, totals{}, edge{}, external[]
            window.CONFIG: palette{} + categories[] (guest block colours),
              nodes[] (per-Proxmox-node label/accent for the tour stop names),
              wan_label (the "<label> · WAN" stop caption).

   LAYOUT ALGORITHM (deterministic — same topology in => same picture out)
   ----------------------------------------------------------------------
   A layered/tidy tree in the XZ plane, hierarchy running along +X:
     depth 0 (WAN) at the far left, each hop right by TIER_X units.
   * The tree is built from each node's `parent` field; orphans are attached
     via their first link, else to the root. `kind` never guesses topology.
   * Children of a device are split into "infra" children (wan/gateway/switch/
     ap/pvehost/external — recursed) and "leaf" children (guest/client —
     packed into a compact grid block: columns spread across Z, extra rows
     step further along +X). Blocks count as a single child for spacing.
   * Each subtree's Z-span is the sum of its children's spans (+ gaps);
     children are placed centred on their parent's Z, sorted by (kind, id) —
     wired clients sort by switch port. No randomness anywhere in layout;
     the only RNG (backdrop dust, particle phase) is a seeded mulberry32.
   * Wireless clients ride 26 units above the plane on arced links from the
     AP; `external` nodes (SD-WAN sites) float at y=70 on a dashed riser.
   * After placement the whole graph is re-centred on the origin so the
     orbiting camera can frame it inside the HUD-free centre of the wall.

   BPS -> VISUAL MAPPING (log scale; the network spans idle .. ~1 Gbps)
   ----------------------------------------------------------------------
     u = clamp( (log10(bits/s) - 4) / 5.3 , 0, 1 )
       => 0 at <=10 kb/s (idle), 1 at ~2 Gb/s.
   * Link brightness  : colour lerp  dim slate -> accent cyan  by u.
   * Trunk thickness  : cylinder radius 0.55 + 3.2u.
   * Particle density : trunks 0..26/direction, leaf links 0..6/direction.
   * Particle speed   : 50 + 240u world-units/s along the link.
   * Direction        : on the uplink of node N, parent->N carries N.rx
     (cyan), N->parent carries N.tx (magenta), in separate offset lanes.
   HONESTY RULES: pairwise flows are NOT in the data, so packets travel only
   along real physical links. `measured:false` links render as static dashed
   grey (no motion, ever). If a link is measured but its endpoint is not,
   direction is unknown: a neutral half-density stream runs both ways.

   UNIVERSE MODE (2026-10-04, netscene_universe.js + /api/universe)
   ----------------------------------------------------------------------
   Every device the estate knows is placed in its system's galaxy disc
   around the system hub (see uni() / computeLayout); leaves are drawn by
   ONE instanced atlas draw in netscene_universe.js, and this file keeps the
   spine meshes, links, labels, tour and collision pass. Without
   /api/universe the original block layout below runs unchanged.
   Data -> motion curves live in ONE place: static/motion.js.
   Camera follow is a critically damped spring (exact step, any dt); tour
   departures/arrivals are scheduled times, so lap timing is fps-independent.

   2026-10-08 (contracts 6 / 7 / 7a)
   ----------------------------------------------------------------------
   * ESTATE MAP: systems placed by role, left to right outside -> inside
     (Internet, sites, core with home below it, compute growing to the
     right); append-only, a new host moves nothing (computeLayout).
   * SCENE TEXT: one 2D canvas paints every label (Inter, 11-16 px, one
     line, short names, no IPs); sprites only carry position + verdict.
   * DETAILS ON CLICK: one card per body (identity, health, traffic, role);
     a click never takes the tour into manual mode, a drag does.
   * FOLLOW THE STREAM: one stop per lap rides the strongest measured
     system-to-system stream (netscene_traffic.js); key stream:<from>><to>,
     leg move "stream".

   PERF BUDGET (24/7 on a GTX 1080 Ti; must survive SwiftShader)
   ----------------------------------------------------------------------
   * Guests + clients are two InstancedMesh draws; leaf links are one merged
     LineSegments + one merged arc Line set + one dashed set. Trunks are
     ~8 shared-geometry cylinders. ~25 draw calls for the whole graph.
   * All packets live in ONE THREE.Points buffer (cap 4096, drawRange set to
     the active count; typically 300-900 alive). CPU per frame: one float
     loop over active particles, zero allocations (pooled vectors).
   * Layout/mesh rebuilds happen only when the node/link id-set changes;
     routine 5 s data refreshes just retint materials, rescale trunks and
     re-seed particle slots. Labels are prebaked canvas sprites; only the
     handful of trunk rate labels are ever redrawn, and only on change.
   ========================================================================== */
(function () {
  'use strict';

  /* ---------------- palette (matches the HUD) ---------------- */
  var PAL = {
    bg: 0x02050b, text: 0xd6ecff, dim: 0x6f8faf,
    cyan: 0x5ad7ff, magenta: 0xff4fa3, ok: 0x37f5a0,
    warn: 0xffb347, alert: 0xff5a6a,
    linkDim: 0x12293e, linkHot: 0x2f9dd4,
    leafDim: 0x21405e, leafHot: 0x77dcff,
    unk: 0x5a6a7c, body: 0x0e1a29
  };
  /* Guest category colours and the per-Proxmox-node identity come from
     window.CONFIG (docs/contracts.md), never from a literal here: a homelab
     with four nodes and its own category names must colour correctly. */
  function C() { return window.CONFIG || {}; }
  function catHex(cat) {
    var c = C();
    if (c.catHex) return c.catHex(cat);
    return 0x8fb0d0;
  }
  function nodeLabel(id) { var c = C(); return c.nodeLabel ? c.nodeLabel(id) : String(id || '').replace(/^(host:)?pve:/, '').toUpperCase(); }
  function wanLabel() { return (C().wan_label || 'ISP'); }
  /* group-caption ink: the category colours lifted toward white so the names
     read as type, not as more neon */
  /* HUD keep-out: a trunk seen end-on from a host stop ran as a
     thick beam straight down through the caption and the ticker. Lines and
     their packets now fade out over the caption/ticker band and the side
     panels (screen space, soft 0.1 edges); uHudInv = 1 / scene-target px,
     written once a frame (the target follows the adaptive render scale). */
  var HUD_INV = { value: new THREE.Vector2(1 / 1920, 1 / 1080) };
  var HUD_KEEP_GLSL = [
    'uniform vec2 uHudInv;',
    'float hudKeep(){ vec2 n = gl_FragCoord.xy * uHudInv;',
    '  return smoothstep(0.20, 0.31, n.y) * smoothstep(0.15, 0.23, n.x) * (1.0 - smoothstep(0.75, 0.82, n.x)); }'
  ].join('\n');
  /* the category table, derived once from CONFIG (scripts load after config.js
     resolved): CAT[cat] = palette colour, CAT_TITLE[cat] = display name,
     GUEST_CAT_HEX[cat] = the colour lifted toward white for caption ink */
  var CAT = {}, CAT_TITLE = {}, GUEST_CAT_HEX = {};
  (function () {
    var cats = (C().categories && C().categories.length) ? C().categories : ['ai', 'media', 'network', 'monitor', 'web', 'infra'];
    var short = { ai: 'AI', web: 'Web', monitor: 'Monitoring' };
    cats.forEach(function (k) {
      var v = catHex(k); CAT[k] = v;
      CAT_TITLE[k] = short[k] || (C().catName ? C().catName(k) : k);
      var r = v >> 16 & 255, g = v >> 8 & 255, b = v & 255, f = 0.45;
      r = Math.round(r + (255 - r) * f); g = Math.round(g + (255 - g) * f); b = Math.round(b + (255 - b) * f);
      GUEST_CAT_HEX[k] = '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
    });
  })();
  var KIND_ORDER = { wan: 0, gateway: 1, switch: 2, ap: 3, pvehost: 4, external: 5, guest: 6, client: 7 };

  /* ---------------- tunables ---------------- */
  // TIER_X was 168: five tiers made a ~700-unit spine hanging off a ~76-unit
  // guest cube, so the graph read as a long thin tail with all its mass at one
  // end. Compressing the spine squares the silhouette, which also lets the
  // camera sit closer and every node render larger.
  var TIER_X = 120, LEAF_SP = 19, GAP = 30, MIN_SPAN = 52;
  var P_CAP = 4096;
  var TRUNK_MAXP = 34, LEAF_MAXP = 8;   // 2026-09-14: denser streams (was 26/6); pool cap unchanged
  var LANE = 6.5;                       // half-gap between rx and tx lanes
  var CAM_EL = 0.60;                   // camera elevation (rad)
  /* FRAMING. These describe where on screen the graph is allowed to live, and
     they exist because the dense HUD only leaves a box in the middle. Hero mode
     hands the whole viewport back, so they are variables now, not constants,
     and NS.setFrame() re-fits the camera and the tour stops without a rebuild. */
  var VOFF_X = 0.0052, VOFF_Y = 0.0676; // frustum shift: puts the camera axis
                                        // on the HUD-safe box centre (950,467)
  var FRAC_X = 0.649, FRAC_Y = 0.589;   // fraction of the viewport the graph may fill
  var CENTER_DX = -14;                  // nudge off the left rail

  function applyViewOffset() {
    if (!NS || !NS.cam) return;
    var W = window.innerWidth, H = window.innerHeight;
    NS.cam.setViewOffset(W, H, Math.round(VOFF_X * W), Math.round(VOFF_Y * H), W, H);
  }
  var CAM_PERIOD = 55;                  // seconds per full orbit sway (1.6x, 2026-09-05)
  var CAM_SWAY = 0.26;                  // rad of azimuth sway
  var MANUAL_HOLD = 25;                 // s of user control before auto-cam resumes
  var CAT_GAP = 27;                     // gap between guest category blocks

  /* ---- auto-tour timings (see tourTick) ---- */
  /* 2026-10-07: travel grew 1.7-4.0 -> 2.2-3.2 s for the cinematic legs, so
     the dwells gave back ~0.5 s each and a lap stays about as long */
  /* 2026-10-13 (Connor: "the tour improved and faster to the lights in the server room so it looks insane"):
     dwells 3.3/4.8 -> 2.4/3.4 s and legs 2.2-3.2 -> 1.5-2.3 s; a lap ~2m38s -> ~1m50s. The room lights now predict
     each arrival from travel_s/prog, so a shorter beat still lands exactly on the camera's touchdown. */
  var T_HOLD = 2.4;                     // s dwell at a focused stop
  var T_HOLD_OVER = 3.4;                // s dwell at the overview
  var T_SWAY = 0.045;                   // rad azimuth sway while holding a stop
  var T_SWAY_PERIOD = 29;               // s period of that sway (1.6x)
  var ECO_WIDE = 1.22;                  // pull every focused stop back: show the
                                        // subject IN the context of the wider ecosystem
  var FOC_FLOOR = 0.17;                 // off-subject nodes never fully vanish - the
                                        // whole network stays a dim backdrop constellation
  var FOC_FLOOR_UNI = 0.34;             // universe mode: the backdrop constellation stays
                                        // visible, so no frame of a flight goes near-black

  function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

  function bpsNorm(bytesPerSec) {
    var bits = Math.max(0, (+bytesPerSec || 0)) * 8;
    if (bits < 1e4) return 0;                               // <10 kb/s = idle
    return Math.min(1, (Math.log(bits) / Math.LN10 - 4) / 5.3);
  }
  function fmtRate(bytesPerSec) {
    var b = Math.max(0, (+bytesPerSec || 0)) * 8;
    if (b < 1e3) return b.toFixed(0) + ' b/s';
    if (b < 1e6) return (b / 1e3).toFixed(1) + ' kb/s';
    if (b < 1e9) return (b / 1e6).toFixed(1) + ' Mb/s';
    return (b / 1e9).toFixed(2) + ' Gb/s';
  }
  function hex(c) { return '#' + ('00000' + c.toString(16)).slice(-6); }

  /* ============================ boot ============================ */
  var NS = null, NS_OVE = null;
  function boot() {
    if (!(window.THREE && window.scene && window.cam && window.rndr && window.ctrl)) { setTimeout(boot, 300); return; }
    try { init(); } catch (e) { console.error('netscene: init failed', e); }
    // index.html's resize handler rebuilds the projection matrix from the
    // camera's stored full-size, so the offset must be restated at the new size
    window.addEventListener('resize', function () { setTimeout(applyViewOffset, 0); });
  }
  boot();

  function disposeDeep(obj) {
    obj.traverse(function (o) {
      if (o.geometry && !(o.geometry.userData && o.geometry.userData.shared)) o.geometry.dispose();   // bodies3d models are shared
      var ms = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
      ms.forEach(function (m) { if (m.map && !m.map.nbKeep) m.map.dispose(); m.dispose(); });
    });
  }

  function init() {
    var scene = window.scene, cam = window.cam, rndr = window.rndr, ctrl = window.ctrl, bloom = window.bloom;

    /* -- clear anything a previous scene left behind (idempotent) -- */
    for (var i = scene.children.length - 1; i >= 0; i--) {
      var ch = scene.children[i]; scene.remove(ch); disposeDeep(ch);
    }
    scene.background = new THREE.Color(PAL.bg);
    scene.fog = new THREE.FogExp2(PAL.bg, 0.00060);
    if (rndr.toneMappingExposure !== undefined) rndr.toneMappingExposure = 1.15;
    if (bloom) { bloom.strength = 0.5; bloom.radius = 0.45; bloom.threshold = 0.72; }
    ctrl.minDistance = 120; ctrl.maxDistance = 3200; ctrl.autoRotate = false;

    NS = {
      scene: scene, cam: cam, rndr: rndr, ctrl: ctrl,
      backdrop: new THREE.Group(), graph: null,
      byId: {}, nodes: [], links: [], infra: [],
      guestIM: null, clientIM: null, guestIdx: [], clientIdx: [],
      labels: [], rateLabels: [], alertRings: [],
      pick: [], sig: '', lastTs: -1,
      tweenUntil: 0, center: new THREE.Vector3(), fitDist: 900,
      manualAt: -1e9, mouse: new THREE.Vector2(-9, -9), ray: new THREE.Raycaster(),
      tip: document.getElementById('tip'),
      // particle pool
      pGeo: null, pPts: null, pPos: null, pCol: null,
      pLink: new Int16Array(P_CAP), pDir: new Int8Array(P_CAP),
      pProg: new Float32Array(P_CAP), pRate: new Float32Array(P_CAP),
      pActive: 0,
      tmpV: new THREE.Vector3(), tmpQ: new THREE.Quaternion(), tmpM: new THREE.Matrix4(),
      up: new THREE.Vector3(0, 1, 0), t: 0,
      /* cinematic exploded view (cinema.js): 0 = the real layout, 1 = guests
         lifted / clients dropped by explodeY so the three tiers separate */
      explode: 0, explodeY: 90,
      /* constants the camera overlays (cinema.js) frame against */
      CAM_EL: CAM_EL, CAM_SWAY: CAM_SWAY, MANUAL_HOLD: MANUAL_HOLD
    };
    NS.ray.params.Points = { threshold: 0 };
    scene.add(NS.backdrop);
    buildBackdrop();
    buildParticlePool();

    addEventListener('mousemove', function (e) {
      NS.mouse.x = (e.clientX / innerWidth) * 2 - 1;
      NS.mouse.y = -(e.clientY / innerHeight) * 2 + 1;
      if (NS.tip) { NS.tip.style.left = (e.clientX + 14) + 'px'; NS.tip.style.top = (e.clientY + 12) + 'px'; }
    });
    /* a CLICK opens the detail card and leaves the tour alone (section 7: the
       light sync and the TV keep following, one beat per stop). Only a
       deliberate drag or a wheel takes the camera (MANUAL_HOLD). */
    addEventListener('pointerdown', cardDown);
    addEventListener('pointermove', cardMove);
    addEventListener('pointerup', cardUp);
    addEventListener('keydown', function (e) { if (e.key === 'Escape') closeCard(); });
    addEventListener('wheel', function () { NS.manualAt = NS.t; closeCard(); });

    window.netSceneUpdate = netSceneUpdate;
    window.netSceneTick = netSceneTick;
    /* Driven by the render loop AFTER ctrl.update(), so the collision pass and
       the hover raycast see the camera the frame is actually drawn through.
       Calling it flips _lpExternal, which switches off the in-tick fallback -
       so an older template that does not call this still works, just a frame
       behind as before. */
    NS.labelPass = function () { NS._lpExternal = true; labelPass(); };
    NS.auditLabels = auditLabels;
    NS.setFlowTex = setFlowTex;
    NS.renderOverlay = renderOverlay;
    NS.LBL_LAYER = LBL_LAYER;
    /* the scene-text toolkit, shared with the overlay files (universe stubs,
       traffic streams, flows, exosphere): one typeface, one painter */
    NS.shortName = shortName; NS.textLabel = textLabel; NS.textRect = spriteRect;
    NS.mutedAccent = mutedAccent; NS.STATUS_INK = STATUS_INK; NS.sysName = sysName;
    NS.b3dCreate = b3dCreate;
    /* QA: visible scene text overlapping each other or a HUD panel, in px.
       { pairs: [[a, b, overlapPx2]], hud: [[label, panel, overlapPx2]] } */
    NS.auditOverlaps = function () {
      var L = auditLabels().filter(function (r) { return r.kind !== 'deco'; }), H = hudRects(), out = { n: L.length, pairs: [], hud: [] };
      function ov(a, b) { var w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0); return w > 0 && h > 0 ? Math.round(w * h) : 0; }
      for (var i = 0; i < L.length; i++) {
        for (var j = i + 1; j < L.length; j++) { var o = ov(L[i], L[j]); if (o > 40) out.pairs.push([L[i].txt, L[j].txt, o]); }
        for (var k = 0; k < H.length; k++) {   // HUD rects carry a 6 px pad; test the bare panel
          var hb = { x0: H[k].x0 + 6, x1: H[k].x1 - 6, y0: H[k].y0 + 6, y1: H[k].y1 - 6 };
          var o2 = ov(L[i], hb); if (o2 > 40) out.hud.push([L[i].txt, H[k].hud, o2]);
        }
      }
      return out;
    };
    /* Retarget the framing at runtime. hero.js calls this when the HUD gets out
       of the way, so the graph actually grows into the space instead of staying
       in the box it was sized for. Re-fits from the stored extents and rebuilds
       the tour stop distances; no graph rebuild, no flicker. */
    NS.setFrame = function (o) {
      o = o || {};
      if (o.fracX !== undefined) FRAC_X = o.fracX;
      if (o.fracY !== undefined) FRAC_Y = o.fracY;
      if (o.voffX !== undefined) VOFF_X = o.voffX;
      if (o.voffY !== undefined) VOFF_Y = o.voffY;
      if (o.ecoWide !== undefined) ECO_WIDE = o.ecoWide;
      if (o.centerDx !== undefined) CENTER_DX = o.centerDx;
      if (NS.fitEx && NS.cam) {
        var vf2 = NS.cam.fov * Math.PI / 360, ta2 = Math.tan(vf2) * NS.cam.aspect;
        var az2 = CAM_SWAY + 0.06;
        var h2 = (NS.fitEx.x * Math.cos(az2) + NS.fitEx.z * Math.sin(az2)) / (ta2 * FRAC_X);
        var v2 = (NS.fitEx.z * Math.sin(CAM_EL) + NS.fitEx.y * Math.cos(CAM_EL) + 44)
                 / (Math.tan(vf2) * FRAC_Y);
        NS.fitDist = Math.max(h2, v2, 480);
      }
      if (NS.bboxCenter) {
        NS.center.copy(NS.bboxCenter); NS.center.x += CENTER_DX;
      }
      applyViewOffset();
      if (uni() && NS.nodes && NS.nodes.length) fitOverviewUni();
      if (NS.nodes && NS.nodes.length) buildTour();
    };
    window.NETSCENE = NS;
    /* netscene_universe.js calls this when the universe layout changes (a new
       device, a shell growing a size step). Re-lays out from the last topology;
       existing nodes tween from where they are, nothing is re-sorted. */
    /* QA: park the tour at a stop by key (prefix match), camera snapped */
    NS.tourGoto = function (k) {
      var TR = NS.tour; if (!TR) return false;
      for (var i = 0; i < TR.stops.length; i++) {
        /* key prefix, or the system id alias ("sys:home" finds the home
           galaxy even though its wire key is wired:<switch id>) */
        if (TR.stops[i].key.indexOf(k) !== 0 && !(TR.stops[i].sysId && TR.stops[i].sysId === k)) continue;
        var st = TR.stops[i];
        TR.idx = TR.next = i; TR.phase = 'hold'; TR.t0 = TR.tHold = NS.t; TR.manual = false; NS.manualAt = -1e9;
        forceFocus(st.ids || null, stopSpread(st));
        if (!TP.pos) { TP.pos = new THREE.Vector3(); TP.tgt = new THREE.Vector3(); }
        tourPose(st, 0, TP.pos, TP.tgt);
        NS.cam.position.copy(TP.pos); NS.ctrl.target.copy(TP.tgt);
        if (TP.vp) { TP.vp.set(0, 0, 0); TP.vt.set(0, 0, 0); TP.gp = null; }
        return st.name;
      }
      return false;
    };
    NS.qaTP = function () { return TP; };       // QA: camera follow state (dt-independence test)
    NS.refreshTour = function () { return refreshTour(); };
    NS.aspectOf = aspectOf;
    Object.defineProperty(NS, 'aspTune', { get: function () { return ASP_TUNE; } });   // QA: aspect framing knobs (refreshTour() after a change)
    tourDataPoll();
    NS.relayout = function () {
      if (!NS.lastTopo) return;
      NS.lastTs = -1; NS.sig = '';
      netSceneUpdate(NS.lastTopo);
    };
    /* for overlays (netscene_flows.js): 1 = node fully shown, 0 = hidden by
       the tour's focus. NS.focusAll === false while a close-up is framed. */
    NS.nodeFocus = function (id) {
      var n = NS.byId[id];
      return !n || n._foc === undefined ? 1 : n._foc;
    };
    /* the crossfade itself, for keyed things with no topology node (universe
       bodies: focusOf('u:' + body.id, topoId)); NS.focusLive() is true while
       a leg is running, i.e. targets move every frame */
    NS.focusOf = function (id, id2) { return focusOf(id, id2); };
    NS.focusLive = function () { return NS_FOC.live; };

    /* self-poll fallback; harmless if /api/all already pushes d.topology */
    setInterval(function () {
      try {
        fetch('/api/topology').then(function (r) { return r.ok ? r.json() : null; })
          .then(function (j) { if (j && j.nodes) netSceneUpdate(j); }).catch(function () { });
        pollBaseline();
      } catch (e) { }
    }, 5000);
  }

  /* ============================ backdrop ============================ */
  /* ============================================================
     Deep-space backdrop. The topology is the subject; this is the room it
     sits in. Everything here is decorative and carries NO data - it must
     never be mistaken for a node, a link or a rate, so it stays dim, cool
     and slow. Tagged userData.bg = true so measurement harnesses can skip it.

     NOTE: the scene runs FogExp2 at 0.0006, which is fully opaque by ~1500
     units - every material here sets fog:false or the starfield simply is
     not there. Bloom threshold is 0.72, so star brightness stays under it;
     only the nebula cores are allowed to catch any glow.
     ============================================================ */

  function buildBackdrop() {
    var g = NS.backdrop;
    g.add(new THREE.HemisphereLight(0x35577a, 0x070b12, 1.0));
    var dl = new THREE.DirectionalLight(0xcfe4ff, 1.05); dl.position.set(-420, 540, 320); g.add(dl);
    g.add(new THREE.AmbientLight(0x223448, 0.6));

    // ground grid: spatial reference for the graph plane, deliberately faint
    var grid = new THREE.GridHelper(2600, 52, 0x11273f, 0x081525);
    grid.position.y = -64;
    grid.material.transparent = true; grid.material.opacity = 0.20;
    grid.material.depthWrite = false; grid.material.fog = true;
    grid.userData.bg = true;
    /* photo look (2026-10-08): a ground grid under the galaxies is the most "3D rendered"
       cue on the wall; the galaxy discs carry the plane now */
    if (!window.NB_HDR) g.add(grid);

  }   /* starfield/nebulae now live in galaxy.js (own file, own owner) */

  /* ---------------- soft round sprite texture for packets ---------------- */
  function dotTex() {
    var s = 64, cv = document.createElement('canvas'); cv.width = cv.height = s;
    var x = cv.getContext('2d'), gr = x.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.4, 'rgba(255,255,255,.65)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = gr; x.fillRect(0, 0, s, s);
    return new THREE.CanvasTexture(cv);
  }

  function buildParticlePool() {
    NS.pPos = new Float32Array(P_CAP * 3);
    NS.pCol = new Float32Array(P_CAP * 3);
    NS.pBase = new Float32Array(P_CAP * 3);   // pre-focus colours
    NS.pGeo = new THREE.BufferGeometry();
    NS.pGeo.setAttribute('position', new THREE.BufferAttribute(NS.pPos, 3).setUsage(THREE.DynamicDrawUsage));
    NS.pGeo.setAttribute('color', new THREE.BufferAttribute(NS.pCol, 3).setUsage(THREE.DynamicDrawUsage));
    NS.pGeo.setDrawRange(0, 0);
    NS.pGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 5000); // never recompute
    NS.pPts = new THREE.Points(NS.pGeo, new THREE.PointsMaterial({
      size: 7.5, map: dotTex(), vertexColors: true, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true
    }));
    NS.pPts.frustumCulled = false;
    NS.scene.add(NS.pPts);
    /* per-particle travel direction, for the Blender flow-strip comets */
    NS.pVel = new Float32Array(P_CAP * 3);
    NS.pGeo.setAttribute('aVel', new THREE.BufferAttribute(NS.pVel, 3).setUsage(THREE.DynamicDrawUsage));
  }

  /* Blender's flow strip (manifest anims.flow: 512x64, head toward +u) as the
     packet sprite: each particle is drawn as a short comet oriented along its
     own screen-space direction of travel. Same single Points draw, same pool;
     swapped in when netscene_universe.js has loaded the texture. */
  var FLOW_VS = [
    'attribute vec3 color; attribute vec3 aVel;',
    'uniform float uSize; uniform float uScale;',
    'varying vec3 vCol; varying float vAng; varying float vFog;',
    'void main(){',
    '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
    '  vec4 a = projectionMatrix * mv;',
    '  vec4 b = projectionMatrix * modelViewMatrix * vec4(position + aVel * 6.0, 1.0);',
    '  vec2 d = b.xy / max(1e-4, b.w) - a.xy / max(1e-4, a.w);',
    '  vAng = atan(-d.y, d.x);',                       // point coords run y-down
    '  vCol = color; vFog = -mv.z;',
    /* eye comfort (2026-10-05): a packet that passes the lens used to grow to
       256 px of additive light (the magenta pillar at the GPU stops); cap it
       and let it fade out as it nears the camera instead */
    '  gl_PointSize = clamp(uSize * 2.6 * uScale / max(1.0, -mv.z), 0.0, 72.0);',
    '  gl_Position = a;',
    '}'].join('\n');
  var FLOW_FS = [
    HUD_KEEP_GLSL,
    'uniform sampler2D uTex; uniform float fogDensity;',
    'varying vec3 vCol; varying float vAng; varying float vFog;',
    'void main(){',
    '  vec2 q = gl_PointCoord - 0.5;',
    '  float c = cos(vAng), s = sin(vAng);',
    '  vec2 r = vec2(c * q.x + s * q.y, -s * q.x + c * q.y);',   // into the strip frame
    '  if (abs(r.y) > 0.0625) discard;',                        // 64/512: the strip is 1/8 as tall
    '  vec4 t = texture2D(uTex, vec2(r.x + 0.5, r.y * 8.0 + 0.5));',
    '  float f = 1.0 - exp(-fogDensity * fogDensity * vFog * vFog);',
    '  vec3 rgb = vCol * t.rgb * t.a * 1.6 * (1.0 - clamp(f, 0.0, 0.9)) * smoothstep(30.0, 150.0, vFog) * hudKeep();',
    '  if (rgb.r + rgb.g + rgb.b < 0.004) discard;',
    '  gl_FragColor = vec4(rgb, 1.0);',
    '}'].join('\n');
  function setFlowTex(tex) {
    if (!NS || !NS.pPts || !tex) return;
    var fog = NS.scene.fog;
    var m = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: tex }, uSize: { value: 7.5 }, uScale: { value: 540 }, uHudInv: HUD_INV,
                  fogDensity: { value: fog && fog.density !== undefined ? fog.density : 0.0006 } },
      vertexShader: FLOW_VS, fragmentShader: FLOW_FS,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
    });
    var old = NS.pPts.material; NS.pPts.material = m; if (old) old.dispose();
    NS.flowTex = tex;
  }

  /* ============================ labels ============================ */
  /* Text sprites were minified with a plain LinearFilter and no mipmaps, so at
     any distance the glyphs aliased and shimmered as the camera moved - the
     thing that reads as "blurry" on a 1:1 panel. WebGL2 handles NPOT mipmaps
     (these canvases are 704x64), and anisotropy keeps them legible at the
     grazing angles this camera spends most of its time at. */
  function sharpTex(t) {
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    try {
      var caps = NS && NS.rndr && NS.rndr.capabilities;
      if (caps && caps.getMaxAnisotropy) t.anisotropy = Math.min(8, caps.getMaxAnisotropy());
    } catch (e) { }
    return t;
  }

  /* ---- scene text, 2026-10-08 (contracts section 7 / 7a) -----------------
     Every scene label is now painted by ONE 2D canvas laid over the WebGL
     canvas, in the product typeface (Inter) at a FIXED pixel size: crisp
     11-12 px text like the DOM HUD, which a minified texture sprite never was
     (the old 704 px canvases were shrunk ~4x and read soft and "vibe coded").
     The THREE.Sprite objects stay - they carry each label's world position,
     focus, opacity and the collision verdict, and every pool (this file,
     netscene_universe, netscene_flows, netscene_exo, netscene_traffic) keeps
     driving them exactly as before - but no label canvas or texture is made
     and WebGL never draws them: layer 1 is painted here instead.
       one line per label, short names only, no IPs / MACs / glyph prefixes;
       the product type scale: body labels 12 px / 400, hub names 13 px / 500,
       a galaxy name 16 px / 500 with its one fact at 12 px, meta 11 px (the
       floor); letter-spacing 0; a 1 px dark outline (not a glow) keeps it
       legible over the starfield. */
  var TXT = {
    font: 'Inter, "Inter Variable", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    S: {
      hub:    { px: 13, w: 500, c: '#e6e9ee' },
      cap:    { px: 16, w: 500, c: '#e6e9ee' },
      fact:   { px: 12, w: 400, c: '#9aa4b1' },
      grp:    { px: 12, w: 400, c: '#9aa4b1' },
      leaf:   { px: 12, w: 400, c: '#c5ccd6' },
      stream: { px: 12, w: 400, c: '#d0d6de' },
      exo:    { px: 11, w: 400, c: '#9aa4b1' },
      flow:   { px: 11, w: 400, c: '#9aa4b1' },
      badge:  { px: 9,  w: 600, c: '#9aa4b1' }
    },
    cv: null, ctx: null, W: 0, H: 0, dpr: 1, wc: {}, wcN: 0
  };
  var STATUS_INK = { down: '#e5848c', warn: '#e3b341', crit: '#f85149', ok: '#56d364', fresh: '#56d364' };
  function txtFont(st) { return st.w + ' ' + st.px + 'px ' + TXT.font; }
  function txtCtx() {
    if (TXT.ctx) return TXT.ctx;
    var cv = document.getElementById('nblbl');
    if (!cv) {
      cv = document.createElement('canvas'); cv.id = 'nblbl';
      cv.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:1';
      var c3 = document.getElementById('c');
      if (c3 && c3.parentNode) c3.parentNode.insertBefore(cv, c3.nextSibling); else document.body.appendChild(cv);
    }
    TXT.cv = cv; TXT.ctx = cv.getContext('2d');
    return TXT.ctx;
  }
  /* text width in CSS px, cached (labels change rarely; ~150 distinct strings) */
  function txtW(txt, st) {
    var k = st.px + '|' + st.w + '|' + txt, w = TXT.wc[k];
    if (w !== undefined) return w;
    var x = txtCtx(); x.font = txtFont(st);
    w = x.measureText(txt).width;
    if (++TXT.wcN > 3000) { TXT.wc = {}; TXT.wcN = 0; }
    TXT.wc[k] = w;
    return w;
  }
  /* short display names (section 7). The registry's `short` wins when present;
     otherwise the rules below. Returns '' when a body has no name worth
     printing (IP-only, MAC-only): such bodies stay unlabelled, the click card
     names them. */
  /* generic fallbacks only: device names are the registry's job (universe.py `short`) */
  var SHORT_EXACT = {
    'homeassistant': 'Home Assistant', 'proxmox-backup-server': 'PBS', 'homelab-dashboard': 'Dashboard'
  };
  var IP_RE = /^\d{1,3}(\.\d{1,3}){3}$/, MAC_RE = /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i;
  function shortName(label, body) {
    if (body && body.short) return String(body.short);
    if (body && body.id && NS && NS.U && NS.U.hasShort) return '';       // the registry names what deserves a name

    var s = String(label == null ? '' : label).trim();
    if (!s || IP_RE.test(s) || MAC_RE.test(s)) return '';
    var k = s.toLowerCase();
    if (SHORT_EXACT[k]) return SHORT_EXACT[k];
    var m = /^switch on (\w+) port (\d+)$/i.exec(s);
    if (m) return 'Port ' + m[2] + ' switch';
    s = s.replace(/^(tp-link|tplink|ubiquiti|unifi)\s+/i, '')
         .replace(/\s+(switch|router|gateway)$/i, '')
         .replace(/\s*\((.*)\)$/, '');
    if (s.length > 16) s = s.slice(0, 15) + '…';
    return s;
  }
  /* a system's display name: the registry's short name, else its label in
     sentence case with the usual acronyms kept upper case */
  var ACRO = { gpu: 'GPU', nas: 'NAS', nvr: 'NVR', udm: 'UDM', usw: 'USW', ai: 'AI', dns: 'DNS', vpn: 'VPN',
               wan: 'WAN', lan: 'LAN', pve: 'PVE', 'sd-wan': 'SD-WAN', pbs: 'PBS', tv: 'TV', av: 'AV' };
  function sysName(sy) {
    if (!sy) return '';
    var raw = String(sy.short || sy.label || String(sy.id || '').replace(/^sys:/, ''));
    /* the registry's system shorts arrive in capitals ("PVE1"): on the
       wall that reads as shouting (section 7a), so they are set in sentence
       case here, acronyms kept */
    var shout = /[A-Z]/.test(raw) && raw === raw.toUpperCase();
    var w = raw.split(/\s+/).map(function (t, i) {
      var k = t.toLowerCase(), m = /^([a-z-]+?)(\d*)$/.exec(k);
      if (ACRO[k]) return ACRO[k];
      if (m && ACRO[m[1]]) return ACRO[m[1]] + m[2];
      if (shout) t = k;
      return i === 0 ? t.charAt(0).toUpperCase() + t.slice(1) : t;
    });
    return w.join(' ');
  }
  /* full painted width of a label: [dot] name [ · fact] */
  function l2dWidth(ud) {
    var st = TXT.S[ud.l2d] || TXT.S.leaf, w = ud.txt ? txtW(ud.txt, st) : 0;
    if (ud.fact) w += txtW(' \u00b7 ' + ud.fact, TXT.S.fact);
    if (ud.dot) w += 11;
    if (ud.badge) w += 6 + txtW(ud.badge, TXT.S.badge) + 8;
    return w;
  }
  /* category / system accents are muted 50 % toward neutral so status colour
     always wins (research spec: accents desaturated 40-60 %) */
  var _mc = null, _mg = null;
  function mutedAccent(hexStr) {
    if (!hexStr) return null;
    if (!_mc) { _mc = new THREE.Color(); _mg = new THREE.Color('#8a94a3'); }
    try { _mc.set(hexStr); } catch (e) { return null; }
    _mc.lerp(_mg, 0.45);
    return '#' + _mc.getHexString();
  }
  /* a label object: a hidden Sprite (data only) tagged with its paint style */
  var SPR_MAT = null;
  function textLabel(txt, style, opts) {
    opts = opts || {};
    if (!SPR_MAT) SPR_MAT = new THREE.SpriteMaterial({ transparent: true, depthWrite: false, depthTest: false });
    var s = new THREE.Sprite(SPR_MAT.clone());
    s.layers.set(LBL_LAYER);
    s.userData.l2d = style;
    s.userData.txt = txt;
    if (opts.col) s.userData.col = opts.col;
    if (opts.dot) s.userData.dot = opts.dot;
    if (opts.fact) s.userData.fact = opts.fact;
    if (opts.badge) s.userData.badge = opts.badge;
    s.userData.fade = opts.fade || null;
    s.scale.set(1, 1, 1);
    /* born hidden: a label draws only once a collision pass has approved it */
    s.visible = false;
    s.material.opacity = 0;
    NS.labels.push(s);
    return s;
  }

  var _sv = null, _sv2 = null;
  /* Screen rect of a label in CSS px. Painted labels (userData.l2d) have a
     fixed pixel size: project the anchor, then the text's own metrics. Any
     legacy sprite still on screen keeps the projected-scale rect. */
  function spriteRect(sp, x, y, z) {
    if (!_sv) { _sv = new THREE.Vector3(); _sv2 = new THREE.Vector3(); }
    var cam = NS.cam;
    _sv.set(x, y, z).project(cam);
    if (_sv.z > 1) return null;                        // behind the camera
    var W = window.innerWidth, H = window.innerHeight;
    var sx = (_sv.x * 0.5 + 0.5) * W, sy = (-_sv.y * 0.5 + 0.5) * H;
    var ud = sp.userData || {};
    if (ud.l2d) {
      var tw = l2dWidth(ud), st = TXT.S[ud.l2d] || TXT.S.leaf;
      var hw2 = tw / 2 + 3, hh2 = st.px * 0.68, ox = ud.dx || 0, oy = ud.dy || 0;
      ud.sx = sx + ox; ud.sy = sy + oy; ud.tw = tw;
      return { x0: sx + ox - hw2, x1: sx + ox + hw2, y0: sy + oy - hh2, y1: sy + oy + hh2 };
    }
    var frac = ud.plateFrac ? ud.plateFrac : 1;
    _sv2.set(x + sp.scale.x * 0.5 * frac, y, z).project(cam);
    var hw = Math.abs((_sv2.x * 0.5 + 0.5) * W - sx);
    _sv2.set(x, y + sp.scale.y * 0.5, z).project(cam);
    var hh = Math.abs((-_sv2.y * 0.5 + 0.5) * H - sy);
    return { x0: sx - hw, x1: sx + hw, y0: sy - hh, y1: sy + hh };
  }
  function rectsOverlap(a, b) {
    return !(a.x1 < b.x0 || b.x1 < a.x0 || a.y1 < b.y0 || b.y1 < a.y0);
  }
  var LBL_PAD = 6;
  /* ---- the paint pass: after the composer, straight onto the overlay ------
     Draws every label the collision pass approved THIS frame (lpFrame stamp),
     at the position it judged it at, so text never trails a moving camera. */
  var LBL_LAYER = 1;
  var _paintList = [], _ovW = null;
  function renderOverlay() {
    if (!NS || !NS.cam) return;
    if (!_ovW) _ovW = new THREE.Vector3();
    NS._ovl = true;                                    // the main camera never draws layer 1
    var x = txtCtx(), dpr = Math.min(window.devicePixelRatio || 1, 2), W = window.innerWidth, H = window.innerHeight;
    if (TXT.W !== W || TXT.H !== H || TXT.dpr !== dpr) {
      TXT.W = W; TXT.H = H; TXT.dpr = dpr;
      TXT.cv.width = Math.round(W * dpr); TXT.cv.height = Math.round(H * dpr);
    }
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, W, H);
    var L = _paintList; L.length = 0;
    var t = NS.t;
    /* VIDEO-GRADE TEXT (2026-10-10, contracts 9.4): the collision verdict is
       binary per frame, and painting it raw made every name blink on or off the
       moment it won or lost a spot (the "pop" on a recording). Each label now
       carries a paint alpha that eases toward its verdict (~0.25 s in, ~0.2 s
       out); a label fading out is re-projected each frame so it stays glued to
       its body instead of hanging where it was last judged. */
    /* capped at two frames: a hitch must not turn a fade into a jump */
    var dtL = Math.min(0.034, Math.max(0, t - (TXT.lt == null ? t : TXT.lt))); TXT.lt = t;
    var kIn = 1 - Math.exp(-dtL / 0.085), kOut = 1 - Math.exp(-dtL / 0.065);
    /* QA (NETSCENE.qaPaint = {} to arm): per-frame alpha steps (a pop is a jump > 0.4)
       and 1 px back-and-forth position reversals (shimmer) of painted labels */
    var QP = NS.qaPaint || null;
    if (QP) { QP.frames = (QP.frames || 0) + 1; QP.maxStep = QP.maxStep || 0; QP.pops = QP.pops || 0; QP.rev = QP.rev || 0; QP.moves = QP.moves || 0; }
    function take(arr) {
      for (var i = 0; i < (arr || []).length; i++) {
        var s = arr[i]; if (!s) continue;
        var ud = s.userData; if (!ud || !ud.l2d || !ud.txt) continue;
        var op = s.material ? s.material.opacity : 1;
        var live = s.visible && !ud.hidden && ud.lpFrame === t && op > 0.02;
        var tgt = live ? Math.min(1, op) : 0, pa = ud.pa === undefined ? 0 : ud.pa;
        if (dtL === 0 && ud.pa === undefined) pa = tgt;      // the first painted frame: no fade from nothing
        var pa0 = pa;
        pa += (tgt - pa) * (tgt > pa ? kIn : kOut);
        if (Math.abs(tgt - pa) < 0.01) pa = tgt;
        ud.pa = pa;
        if (QP) { var stp = Math.abs(pa - pa0); if (stp > QP.maxStep) QP.maxStep = stp; if (stp > 0.4) QP.pops++; }
        if (pa <= 0.02) continue;
        if (SC.on && isSubjLabel(ud)) continue;           // the subject callout names it
        if (!live) {
          if (!s.parent) { ud.pa = 0; continue; }
          s.getWorldPosition(_ovW);
          if (!spriteRect(s, _ovW.x, _ovW.y, _ovW.z)) { ud.pa = 0; continue; }
        }
        L.push(s);
      }
    }
    take(NS.labels); take(NS.rateLabels); take(NS.hotLabels); take(NS._extLblCache);
    paintSubject(x, dtL);
    if (!L.length) return;
    x.textAlign = 'left'; x.textBaseline = 'middle'; x.lineJoin = 'round';
    var FS = TXT.S.fact, ff = txtFont(FS), curFont = '';
    for (var j = 0; j < L.length; j++) {
      var s2 = L[j], u = s2.userData, st = TXT.S[u.l2d] || TXT.S.leaf;
      var op2 = u.pa;
      var tw = u.tw || l2dWidth(u), fxp = u.sx - tw / 2, fyp = u.sy;
      /* whole pixels with hysteresis (contracts 9.4): plain rounding flips a slow
         label 1 px back and forth whenever the camera's sway hovers about a .5
         boundary - the shimmer on a recording. Hold the painted pixel until the
         true position is 0.75 px away from it. */
      if (u.hx === undefined || Math.abs(fxp - u.hx) >= 0.75) u.hx = Math.round(fxp);
      if (u.hy === undefined || Math.abs(fyp - u.hy) >= 0.75) u.hy = Math.round(fyp);
      var px = u.hx, py = u.hy + 0.5;
      if (QP) {
        if (u.qf === QP.frames - 1) {
          var ddx = px - u.qx, ddy = py - u.qy;
          if (ddx || ddy) QP.moves++;
          /* a reversal within 8 frames of the last step = shimmer, not a slow sway turning */
          if (((ddx && u.qdx && ddx * u.qdx < 0 && QP.frames - (u.qfx || 0) <= 8)) || ((ddy && u.qdy && ddy * u.qdy < 0 && QP.frames - (u.qfy || 0) <= 8))) { QP.rev++; if (QP.who) QP.who[u.txt + '|' + (u.l2d || '') + '|' + NS.tour.phase] = (QP.who[u.txt + '|' + (u.l2d || '') + '|' + NS.tour.phase] || 0) + 1; }
          if (ddx) { u.qdx = ddx; u.qfx = QP.frames; } if (ddy) { u.qdy = ddy; u.qfy = QP.frames; }
        } else { u.qdx = 0; u.qdy = 0; }
        u.qx = px; u.qy = py; u.qf = QP.frames;
      }
      x.globalAlpha = op2;
      if (u.dot) {
        x.beginPath(); x.arc(px + 4, py, 3.5, 0, 6.2832);
        x.fillStyle = u.dot; x.fill();
        px += 11;
      }
      var f = txtFont(st); if (f !== curFont) { x.font = f; curFont = f; }
      /* label backing (2026-10-08): a soft wide halo under the tight stroke, so a
         name stays legible over a bright galaxy core without dimming the scene */
      x.lineWidth = 7; x.strokeStyle = 'rgba(3,5,9,0.32)';
      x.strokeText(u.txt, px, py);
      x.lineWidth = 3.4; x.strokeStyle = 'rgba(4,6,10,0.88)';
      x.strokeText(u.txt, px, py);
      x.fillStyle = u.col || st.c;
      x.fillText(u.txt, px, py);
      if (u.fact) {
        var nw = txtW(u.txt, st), fx = Math.round(px + nw), ft = ' \u00b7 ' + u.fact;
        x.font = ff; curFont = ff;
        x.strokeText(ft, fx, py + 1);
        x.fillStyle = FS.c; x.fillText(ft, fx, py + 1);
      }
      /* role badge (lab gear): a small outlined tag after the name, muted, never a colour */
      if (u.badge) {
        var BS = TXT.S.badge, bx = px + txtW(u.txt, st) + (u.fact ? txtW(' \u00b7 ' + u.fact, FS) : 0) + 6,
            bw = txtW(u.badge, BS) + 8, bh = 12;
        x.lineWidth = 1; x.strokeStyle = 'rgba(154,164,177,0.55)'; x.fillStyle = 'rgba(4,6,10,0.6)';
        x.beginPath(); x.rect(Math.round(bx) + 0.5, Math.round(py - bh / 2) + 0.5, Math.round(bw), bh); x.fill(); x.stroke();
        var bf = txtFont(BS); x.font = bf; curFont = bf;
        x.fillStyle = BS.c; x.fillText(u.badge, Math.round(bx) + 4, py + 0.5);
      }
    }
    x.globalAlpha = 1;
  }
  /* ---- the aspect stop's subject (contracts 9.2) ----------------------------
     At an aspect stop the body the camera flew to gets a quiet callout: a thin
     ring around it and its short name in the hub style beside it, faded in as
     the camera settles and out as it leaves. Its rect is reserved in the
     collision pass so no other name lands on it; its ordinary label is not
     painted while the callout shows. */
  var SC = { on: false, a: 0, x: 0, y: 0, txt: '', id: '' };
  var _scV = null;
  function isSubjLabel(ud) {
    var SJ = NS._subj; if (!SJ) return false;
    var n = ud.focN;
    return !!((SJ.topo && n && n.id === SJ.topo) || (ud.inst && ud.inst.b && ud.inst.b.id === SJ.id));
  }
  function subjScreen() {
    var SJ = NS._subj, TR = NS.tour;
    var want = !!(SJ && TR && !TR.manual && TR.phase === 'hold');
    SC.on = want || SC.a > 0.02;
    if (!SJ) { SC.want = false; return null; }
    SC.want = want;
    if (!_scV) _scV = new THREE.Vector3();
    var n = SJ.topo && NS.byId[SJ.topo], w = null;
    if (n && n._cx !== undefined) _scV.set(n._cx, n._cy, n._cz);
    else if ((w = window.NETUNI && NETUNI.worldOf ? NETUNI.worldOf(SJ.id) : null)) _scV.set(w[0], w[1], w[2]);
    else return null;
    _scV.project(NS.cam);
    if (_scV.z > 1) return null;
    SC.x = (_scV.x * 0.5 + 0.5) * window.innerWidth; SC.y = (-_scV.y * 0.5 + 0.5) * window.innerHeight;
    if (SC.id !== SJ.id) {
      SC.id = SJ.id;
      var b = NS.U && NS.U.byId ? NS.U.byId[SJ.id] : null;
      SC.txt = b ? (shortName(b.label || b.id, b) || String(b.label || '')) : '';
    }
    var tw = SC.txt ? txtW(SC.txt, TXT.S.hub) : 0;
    SC.rect = { x0: SC.x - 16, x1: SC.x + 22 + tw + 4, y0: SC.y - 16, y1: SC.y + 16 };
    return SC;
  }
  function paintSubject(x, dt) {
    var tgt = SC.want ? 1 : 0;
    SC.a += (tgt - SC.a) * (1 - Math.exp(-dt / (tgt ? 0.16 : 0.1)));
    if (Math.abs(tgt - SC.a) < 0.01) SC.a = tgt;
    if (SC.a <= 0.02 || !SC.rect) return;
    if (SC.hx === undefined || Math.abs(SC.x - SC.hx) >= 0.75) SC.hx = Math.round(SC.x);
    if (SC.hy === undefined || Math.abs(SC.y - SC.hy) >= 0.75) SC.hy = Math.round(SC.y);
    var cx = SC.hx + 0.5, cy = SC.hy + 0.5;
    x.globalAlpha = SC.a;
    x.lineWidth = 3; x.strokeStyle = 'rgba(4,6,10,0.55)';
    x.beginPath(); x.arc(cx, cy, 12, 0, 6.2832); x.stroke();
    x.lineWidth = 1; x.strokeStyle = 'rgba(230,233,238,0.85)';
    x.beginPath(); x.arc(cx, cy, 12, 0, 6.2832); x.stroke();
    if (SC.txt) {
      var st = TXT.S.hub, px = SC.hx + 20, py = SC.hy + 0.5;
      x.font = txtFont(st); x.textAlign = 'left'; x.textBaseline = 'middle'; x.lineJoin = 'round';
      x.lineWidth = 7; x.strokeStyle = 'rgba(3,5,9,0.32)'; x.strokeText(SC.txt, px, py);
      x.lineWidth = 3.4; x.strokeStyle = 'rgba(4,6,10,0.88)'; x.strokeText(SC.txt, px, py);
      x.fillStyle = st.c; x.fillText(SC.txt, px, py);
    }
    x.globalAlpha = 1;
  }
  var LEAF_BUDGET = 10, LEAF_BUDGET_OVER = 6;   // universe mode: leaf names per frame (was 14 at a close-up)
  var LEAF_MIN_PX = 30;     // sprite height (px) floor for the subject's leaf names (~18-24 px of text)
  /* what earns a leaf a name: down / new first, then measured activity */
  function leafScore(ud) {
    var n = ud.focN; if (!n) return 0;
    var SJ = NS._subj;
    if (SJ && ((SJ.topo && n.id === SJ.topo) || (ud.inst && ud.inst.b && ud.inst.b.id === SJ.id))) return 1e5;
    if (ud.uStub) {                                   // universe-only body label
      var b = ud.inst && ud.inst.b; if (!b) return 0;
      var m = b.m || {};
      return (b.status === 'down' ? 6 : 0) + (b['new'] ? 900 : 0) + Math.log(1 + (+m.rx_bps || 0) + (+m.tx_bps || 0)) / Math.LN10;
    }
    var mm = n.meta || {};
    return (n.status === 'down' ? 6 : 0) + ((mm['new'] || (n._ub && n._ub['new'])) ? 900 : 0)
         + Math.log(1 + ((+n.rx || 0) + (+n.tx || 0)) * 8) / Math.LN10 + (mm.cpu != null ? Math.min(3, +mm.cpu / 10) : 0);
  }
  function rectsOverlapPad(a, b) {
    return !(a.x1 + LBL_PAD < b.x0 || b.x1 + LBL_PAD < a.x0 || a.y1 + LBL_PAD < b.y0 || b.y1 + LBL_PAD < a.y0);
  }

  /* HUD panels are obstacles too (2026-10-04). Every pool already avoided the
     other pools, but nothing knew the DOM panels existed, so scene labels ran
     straight under NOW PLAYING / AUDIENCE / the caption. The visible panel
     rects are read from the DOM at most once a second (layout reads are not
     free) and seed the collision pass, so a label that would sit under a panel
     simply loses, like any other collision. */
  var HUD_SEL = '#herotop,#herobot,#h-aud,#cin,#st-live,#st-ai,#st-emby,.st,.panel,#np,#nbcard,.nbp';
  var _hud = { t: -1e9, rects: [] };
  function hudRects() {
    var now = (window.performance && performance.now) ? performance.now() : Date.now();
    if (now - _hud.t < 1000) return _hud.rects;
    _hud.t = now;
    var out = [];
    try {
      var els = document.querySelectorAll(HUD_SEL), W = window.innerWidth, H = window.innerHeight;
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (el.id === 'tip' || el.id === 'chat') continue;
        var r = el.getBoundingClientRect();
        if (r.width < 24 || r.height < 12 || r.width > W * 0.95 && r.height > H * 0.5) continue;
        if (r.right < 0 || r.bottom < 0 || r.left > W || r.top > H) continue;
        var cs = window.getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity < 0.05) continue;
        out.push({ x0: r.left - 6, x1: r.right + 6, y0: r.top - 6, y1: r.bottom + 6, hud: el.id || el.className });
      }
    } catch (e) { }
    _hud.rects = out;
    return out;
  }

  /* Overlap auditor. The label layer has three independent pools that used to
     know nothing about each other, so "is it clean?" could only be answered by
     squinting at a screenshot. This returns every visible label's screen rect
     with its text, and a headless check turns that into a pass/fail. */
  function auditLabels() {
    var fs = (NS && NS.cam && NS.cam.fov)
      ? (window.innerHeight / 2) / Math.tan(NS.cam.fov * Math.PI / 360) : 0;
    var out = [];
    if (!fs) return out;
    function collect(arr, kind) {
      for (var i = 0; i < (arr || []).length; i++) {
        var L = arr[i];
        if (!L || !L.visible) continue;
        if (L.material && L.material.opacity <= 0.02) continue;
        var r = spriteRect(L, L.position.x, L.position.y, L.position.z, fs);
        if (!r) continue;
        out.push({ kind: kind, txt: (L.userData && L.userData.txt) || '',
                   x0: r.x0, x1: r.x1, y0: r.y0, y1: r.y1 });
      }
    }
    collect(NS.labels, 'label');
    collect(NS.rateLabels, 'rate');
    collect(NS.hotLabels, 'hot');

    /* Sweep the whole scene for any OTHER visible text sprite. netscene_flows
       keeps its own pool, and auditing only the pools this file happens to know
       about is how a fourth one goes unmeasured for months. Backdrop sprites
       (galaxy, nebulae, meteors) carry userData.bg and are skipped. */
    var known = {};
    [NS.labels, NS.rateLabels, NS.hotLabels].forEach(function (arr) {
      (arr || []).forEach(function (o) { if (o) known[o.uuid] = 1; });
    });
    if (window.scene) {
      window.scene.traverse(function (o) {
        if (!o.isSprite || known[o.uuid] || o.userData.bg) return;
        if (!o.visible || (o.material && o.material.opacity <= 0.02)) return;
        var w = o.getWorldPosition(new THREE.Vector3());
        var r = spriteRect(o, w.x, w.y, w.z, fs);
        // distinguish real text from decorative sprites (flow direction
        // chevrons, particle heads): overlapping a chevron is not a legibility
        // problem, overlapping another label is
        var kind = o.userData.lbl ? 'flowlbl' : 'deco';
        if (r) out.push({ kind: kind, txt: (o.userData && o.userData.txt) || ('(' + kind + ')'),
                          x0: r.x0, x1: r.x1, y0: r.y0, y1: r.y1 });
      });
    }
    return out;
  }

  /* tour focus of a node: 1 = in focus / no tour focus active, 0 = hidden */
  function nodeFocus(n) { return !n || n._foc === undefined ? 1 : n._foc; }
  function linkFocus(L) {
    return Math.min(nodeFocus(NS.byId[L.aId]), nodeFocus(NS.byId[L.bId]));
  }
  function spriteFocus(ud) {
    if (ud.focN) return nodeFocus(ud.focN);
    if (ud.focList) {
      var m = 0;
      for (var i = 0; i < ud.focList.length && m < 1; i++) m = Math.max(m, nodeFocus(ud.focList[i]));
      return m;
    }
    return 1;
  }

  function updateHotLabels() {
    var pool = NS.hotLabels;
    if (!pool || !pool.length) return;
    if (NS.focusAll === false) {          // tour close-up: per-node labels take over
      for (var hi = 0; hi < pool.length; hi++) {
        pool[hi].visible = false;
        if (NS.hotLeaders && NS.hotLeaders[hi]) NS.hotLeaders[hi].visible = false;
      }
      return;
    }
    var busy = NS.nodes.filter(function (n) {
      return n._inst && n.status === 'up' && n.meta && n.meta.cpu != null && n.meta.cpu >= HOT_MIN;
    }).sort(function (a, b) { return b.meta.cpu - a.meta.cpu; });

    /* node names already on screen are obstacles: a callout drawn over another
       label is worse than no callout at all */
    var fovScale = (NS.cam && NS.cam.fov)
      ? (window.innerHeight / 2) / Math.tan(NS.cam.fov * Math.PI / 360) : 0;
    var obstacles = [];
    if (fovScale) {
      for (var li = 0; li < NS.labels.length; li++) {
        var lb = NS.labels[li];
        if (!lb || !lb.visible) continue;
        if (lb.material && lb.material.opacity < 0.15) continue;
        var lr = spriteRect(lb, lb.position.x, lb.position.y, lb.position.z, fovScale);
        if (lr) obstacles.push(lr);
      }
      // link rate labels are obstacles too - they were not considered at all,
      // so the ladder happily "found room" on top of one
      for (var rli = 0; rli < NS.rateLabels.length; rli++) {
        var rb = NS.rateLabels[rli];
        if (!rb || !rb.visible) continue;
        if (rb.material && rb.material.opacity < 0.15) continue;
        var rr = spriteRect(rb, rb.position.x, rb.position.y, rb.position.z, fovScale);
        if (rr) obstacles.push(rr);
      }
    }

    for (var i = 0; i < pool.length; i++) {
      var n = busy[i], sp = pool[i];
      if (!n) {
        sp.visible = false;
        if (NS.hotLeaders && NS.hotLeaders[i]) NS.hotLeaders[i].visible = false;
        continue;
      }
      // the busiest guests are often neighbours in the lattice, so try a ladder
      // of lifts and take the first that collides with nothing already placed
      var lift = null;
      if (fovScale) {
        var CAND = [58, 104, 150, 196, 26];
        for (var ci = 0; ci < CAND.length; ci++) {
          var r = spriteRect(sp, n._cx, n._cy + CAND[ci], n._cz, fovScale);
          if (!r) continue;
          var clash = false;
          for (var oi = 0; oi < obstacles.length; oi++) {
            if (rectsOverlap(r, obstacles[oi])) { clash = true; break; }
          }
          if (!clash) { lift = CAND[ci]; obstacles.push(r); break; }
        }
      } else {
        lift = 58 + i * 62;
      }
      if (lift === null) {                    // nowhere clear: stay silent
        sp.visible = false;
        if (NS.hotLeaders && NS.hotLeaders[i]) NS.hotLeaders[i].visible = false;
        continue;
      }
      sp.visible = true;
      sp.position.set(n._cx, n._cy + lift, n._cz);
      var ld = NS.hotLeaders && NS.hotLeaders[i];
      if (ld) {
        var pa = ld.geometry.attributes.position;
        pa.setXYZ(0, n._cx, n._cy + 4, n._cz);
        pa.setXYZ(1, n._cx, n._cy + lift - 7, n._cz);
        pa.needsUpdate = true;
        ld.visible = true;
      }
      sp.userData.setText(n.label || n.id, n.meta.cpu,
                          Math.max(n.meta.dr || 0, n.meta.dw || 0), n.meta.mem_pct);
    }
  }

  /* ============================ layout ============================ */
  /* ---- universe mode (2026-10-04) --------------------------------------
     When netscene_universe.js has /api/universe, every device the estate
     knows about lives in a SYSTEM (a galaxy) whose hub is a topology node -
     a PVE host, the gateway, the core switch, the SD-WAN NVR. The spine
     (WAN -> UDM -> switch -> hosts) keeps this file's tidy-tree layout; each
     system hub reserves a disc of radius R around itself in that tree, and a
     leaf that belongs to a system is placed at
         hub + UNIVERSE_LAYOUT.place(system, shell, slot, seed) * scale
     - never by sorting, so a new device never moves an old one. Without
     universe data (endpoint missing / errored) everything below is a no-op
     and the original block layout runs unchanged. */
  function uni() { return NS && NS.U && NS.U.active ? NS.U : null; }

  function computeLayout(topo) {
    var byId = {}, kids = {}, i;
    var U = uni();
    var uSys = {}, uLeaf = {};             // anchor id -> system ; leaf id -> body
    if (U) {
      topo.nodes.forEach(function (n) { byId[n.id] = n; });
      topo.nodes.forEach(function (n) {
        var sy = U.sysOfAnchor(n.id);
        if (sy) { uSys[n.id] = sy; n._uSys = sy; } else n._uSys = null;
      });
      topo.nodes.forEach(function (n) {
        n._ub = null;
        if (uSys[n.id] || (n.kind !== 'guest' && n.kind !== 'client')) return;
        var b = U.bodyOfTopo(n.id), sy = b && U.sysOf(b);
        if (b && sy && byId[sy.anchor]) { uLeaf[n.id] = b; n._ub = b; }
      });
      /* switch hubs carry the REGISTRY's name and status. The topology may only
         know them as UniFi clients, and UniFi's names for third-party switches can
         be wrong: a fingerprint guess ("iPhone"), a bare IP (so the IP-only rule
         below hid it), or a stale SNMP record reporting "down" while it answers.
         The registry reconciles every feed plus the declared devices; it is what
         the TV draws. A second topology node for a hub's own MAC (its UniFi client
         record) is an alias of that hub: it keeps its place in the tree but gets
         no label of its own. */
      var hubMacs = {};
      (U.bodies || []).forEach(function (b) {
        if (!b.hub || !b.m) return;
        [b.m.mac].concat(b.m.chassis_macs || []).forEach(function (mac) { if (mac) hubMacs[String(mac).toLowerCase()] = b; });
      });
      topo.nodes.forEach(function (n) {
        n._alias = null;
        var hb = n._ub && n._ub.hub ? n._ub : null;
        if (hb) {
          if (hb.label) n.label = hb.label;
          if (hb.status === 'up' || hb.status === 'down') n.status = hb.status;
          return;
        }
        if (n.kind === 'client' && !U.bodyOfTopo(n.id)) {
          var ab = hubMacs[String(n.id).replace(/^client:/, '').toLowerCase()];
          if (ab && ab.topo !== n.id) n._alias = ab;
        }
      });
      byId = {};
    } else topo.nodes.forEach(function (n) { n._uSys = null; n._ub = null; });
    /* the tree reserves room for a disc in coarse 96-unit steps, so a disc
       that grows a little (a shell crossing a capacity step) does not shift
       the rest of the spine; only a step change re-spaces it */
    function discR(n) { return (n && uSys[n.id]) ? Math.ceil(uSys[n.id].R / 96) * 96 : 0; }
    topo.nodes.forEach(function (n) { byId[n.id] = n; n._x = 0; n._y = 0; n._z = 0; });
    var root = null;
    topo.nodes.forEach(function (n) { if (!root && n.kind === 'wan') root = n; });
    if (!root) root = topo.nodes[0];

    // resolve parents: declared parent, else first link peer, else root
    var linkPeer = {};
    (topo.links || []).forEach(function (l) {
      if (!linkPeer[l.source]) linkPeer[l.source] = l.target;
      if (!linkPeer[l.target]) linkPeer[l.target] = l.source;
    });
    topo.nodes.forEach(function (n) {
      if (n === root) { n._par = null; return; }
      var lp = linkPeer[n.id];
      // a link peer that calls THIS node its parent would form a 2-cycle, and
      // place() never reaches anything inside a cycle -- it would all stay at
      // (0,0,0). Happens whenever UniFi is stale: a PVE host loses its uplink
      // link, so its first link peer is one of its own guests.
      if (lp && (!byId[lp] || lp === n.id || byId[lp].parent === n.id)) lp = null;
      var p = (n.parent && byId[n.parent]) ? n.parent : (lp || root.id);
      n._par = p;
      (kids[p] = kids[p] || []).push(n);
    });

    /* ---- reachability repair -------------------------------------------
       place() recurses into INFRA children only; guest/client children are
       positioned inline by their parent's block loop and never recursed into.
       So a node parented to a guest is never visited by place() at all and
       keeps its (0,0,0) init -- landing exactly on top of the WAN root. That
       is live right now: the SD-WAN camera NVR hangs off the frigate
       container. Longer parent cycles do the same to everything beneath them.
       Re-attach anything place() cannot reach to the nearest ancestor it can. */
    function leafKind(n) { return (n.kind === 'guest' || n.kind === 'client') && !uSys[n.id]; }
    var reach = {};
    (function walk(n, guard) {
      reach[n.id] = 1;
      if (guard > 64) return;
      var ks = kids[n.id] || [];
      for (var w = 0; w < ks.length; w++) {
        var k = ks[w];
        if (reach[k.id]) continue;              // seen already: a cycle, stop
        if (leafKind(k)) { reach[k.id] = 1; continue; }   // placed inline
        walk(k, guard + 1);
      }
    })(root, 0);

    var rehomed = 0;
    topo.nodes.forEach(function (n) {
      if (n === root || reach[n.id]) return;
      var anc = byId[n._par], tgt = root, hop = 0;
      while (anc && hop++ < 64) {
        if (reach[anc.id]) { tgt = leafKind(anc) ? (byId[anc._par] || root) : anc; break; }
        anc = byId[anc._par];
      }
      var old = kids[n._par];
      if (old) { var ix = old.indexOf(n); if (ix >= 0) old.splice(ix, 1); }
      n._par = tgt.id;
      (kids[tgt.id] = kids[tgt.id] || []).push(n);
      reach[n.id] = 1;
      rehomed++;
    });
    if (rehomed) console.info('netscene: re-homed ' + rehomed + ' node(s) place() could not reach');
    // depth with cycle guard
    function depth(n, guard) {
      if (n._depth !== undefined) return n._depth;
      guard = guard || 0;
      n._depth = (!n._par || guard > 12) ? 0 : depth(byId[n._par], guard + 1) + 1;
      return n._depth;
    }
    topo.nodes.forEach(function (n) { depth(n); });

    function sortKids(arr) {
      arr.sort(function (a, b) {
        var ka = KIND_ORDER[a.kind] || 9, kb = KIND_ORDER[b.kind] || 9;
        if (ka !== kb) return ka - kb;
        var pa = a.meta && a.meta.port, pb = b.meta && b.meta.port;
        if (pa != null && pb != null && pa !== pb) return pa - pb;
        return a.id < b.id ? -1 : 1;
      });
    }
    function split(id) {
      var all = kids[id] || [], infra = [], leaf = [];
      all.forEach(function (k) {
        if (uLeaf[k.id]) return;                         // placed by its system, below
        (leafKind(k) ? leaf : infra).push(k);
      });
      sortKids(infra); sortKids(leaf);
      return { infra: infra, leaf: leaf };
    }
    /* Clients still pack into one roughly cubic lattice (n^(1/3) per axis). */
    function blockDims(n, kind) {
      var side = Math.max(1, Math.ceil(Math.pow(n, 1 / 3)));
      var cols = Math.min(n, side);                                  // Z
      var lays = Math.max(1, Math.min(Math.ceil(n / cols), side));   // Y
      var rows = Math.ceil(n / (cols * lays));                       // X
      return { cols: cols, lays: lays, rows: rows, span: cols * LEAF_SP + 8 };
    }
    /* GUESTS: one undifferentiated cube was honest but unreadable — you could
       not tell which box was which or why. Guests now cluster by meta.cat
       into per-category mini-blocks (hue already = category, so the grouping
       makes the picture self-explaining), arranged two cells wide across Z
       with overflow rows stepping +X (the empty side beyond the last tier).
       Each block gets a floating caption ("AI · 9"). Deterministic:
       categories sort by (count desc, name), guests by id. */
    function guestPlan(leaf) {
      var groups = {};
      leaf.forEach(function (k) { var c = (k.meta && k.meta.cat) || 'infra'; (groups[c] = groups[c] || []).push(k); });
      var cats = Object.keys(groups).sort(function (a, b) {
        return (groups[b].length - groups[a].length) || (a < b ? -1 : 1);
      });
      var blocks = cats.map(function (c) {
        var g = groups[c]; g.sort(function (a, b) { return a.id < b.id ? -1 : 1; });
        var n = g.length;
        var lays = Math.min(3, Math.ceil(Math.sqrt(n)));             // Y
        var cols = Math.min(3, Math.ceil(Math.sqrt(n / lays)));      // Z
        var rows = Math.ceil(n / (cols * lays));                     // X
        return { cat: c, list: g, lays: lays, cols: cols, rows: rows };
      });
      var gcols = Math.min(2, blocks.length), cellW = 0, cellD = 0;
      blocks.forEach(function (b) {
        cellW = Math.max(cellW, b.cols * LEAF_SP);
        cellD = Math.max(cellD, b.rows * LEAF_SP);
      });
      return {
        blocks: blocks, gcols: gcols, cellW: cellW, cellD: cellD,
        span: gcols * cellW + (gcols - 1) * CAT_GAP + 10
      };
    }
    var spanMemo = {}, caps = [];
    function leafSpan(leafArr) {
      return leafArr[0].kind === 'guest' ? guestPlan(leafArr).span
                                         : blockDims(leafArr.length, leafArr[0].kind).span;
    }
    function span(n) {
      if (spanMemo[n.id] !== undefined) return spanMemo[n.id];
      var s = split(n.id), items = [], tot = 0;
      s.infra.forEach(function (k) { items.push(span(k)); });
      if (s.leaf.length) items.push(leafSpan(s.leaf));
      items.forEach(function (v) { tot += v; });
      tot += Math.max(0, items.length - 1) * GAP;
      /* MIN_SPAN reserved room for the node BOX but not for its label, so two
         small infra siblings sat ~88 units apart carrying 116-wide always-on-top
         labels. Floor the reservation at the label's own world width. */
      var lw = leafKind(n) ? 0 : ((n.kind === 'wan' || n.kind === 'gateway') ? 130 : 116);
      // a system hub reserves its whole disc across Z, plus a gutter
      return (spanMemo[n.id] = Math.max(MIN_SPAN, lw, tot, discR(n) ? 2 * discR(n) + GAP * 2 : 0));
    }
    function place(n, z, px, pR) {
      /* X: one tier per hop, but never less than both discs need to clear
         each other (a hub's disc must not swallow its parent switch) */
      var myR = discR(n);
      n._x = (px === undefined) ? 0 : px + Math.max(TIER_X, (pR || 0) + myR + (myR || pR ? 46 : 0));
      n._z = z;
      n._y = n.kind === 'external' ? 120 : 0;
      var s = split(n.id), items = [];
      s.infra.forEach(function (k) { items.push({ node: k, span: span(k) }); });
      var isGuests = s.leaf.length && s.leaf[0].kind === 'guest';
      var blk = null;
      if (s.leaf.length) {
        blk = isGuests ? guestPlan(s.leaf) : blockDims(s.leaf.length, s.leaf[0].kind);
        items.push({ block: blk, span: blk.span });
      }
      var tot = 0; items.forEach(function (it) { tot += it.span; }); tot += Math.max(0, items.length - 1) * GAP;
      var cur = z - tot / 2;
      items.forEach(function (it) {
        var c = cur + it.span / 2;
        if (it.node) place(it.node, c, n._x, myR);
        else if (isGuests) {
          /* category grid: gcols cells across Z, overflow rows stepping +X */
          var plan = blk, x0 = n._x + Math.max(TIER_X * 0.62, myR + 30);
          var w = plan.gcols * plan.cellW + (plan.gcols - 1) * CAT_GAP;
          n._tourBlocks = [];
          plan.blocks.forEach(function (B, bi) {
            var gr = Math.floor(bi / plan.gcols), gc = bi % plan.gcols;
            var bz = c - w / 2 + gc * (plan.cellW + CAT_GAP) + plan.cellW / 2;
            var bx = x0 + gr * (plan.cellD + CAT_GAP);
            B.list.forEach(function (k, idx) {
              var col = idx % B.cols;
              var row = Math.floor(idx / B.cols) % B.rows;
              var lay = Math.floor(idx / (B.cols * B.rows));
              k._z = bz + (col - (B.cols - 1) / 2) * LEAF_SP;
              k._x = bx + row * LEAF_SP;
              k._y = (lay - (B.lays - 1) / 2) * LEAF_SP;
              k._lstag = (col + 2 * row + lay) % 3;   // lay was missing: same-layer rows collided
              k._bcx = bx + (B.rows - 1) * LEAF_SP / 2; k._bcy = 0; k._bcz = bz;
            });
            caps.push({
              txt: (CAT_TITLE[B.cat] || B.cat), fact: String(B.list.length),
              col: CAT[B.cat] !== undefined ? hex(CAT[B.cat]) : '#8fb0d0',
              list: B.list,
              x: bx + (B.rows - 1) * LEAF_SP / 2,
              y: ((B.lays - 1) / 2) * LEAF_SP + 34, z: bz
            });
            n._tourBlocks.push({ cat: B.cat, list: B.list });
          });
        } else {
          s.leaf.forEach(function (k, idx) {
            var per = blk.cols * blk.lays;
            var row = Math.floor(idx / per), rem = idx % per;
            var lay = Math.floor(rem / blk.cols), col = rem % blk.cols;
            k._z = c + (col - (blk.cols - 1) / 2) * LEAF_SP;
            k._x = n._x + Math.max(TIER_X * 0.62, myR + 30) + row * LEAF_SP;
            k._y = (lay - (blk.lays - 1) / 2) * LEAF_SP
                 + ((k.kind === 'client' && n.kind === 'ap') ? 26 : 0);
            k._lstag = (col + lay + row) % 3;       // row was missing: same-column rows collided
            if (n.kind !== 'ap') {
              k._bcx = n._x + TIER_X * 0.62 + ((blk.rows - 1) / 2) * LEAF_SP;
              k._bcy = 0; k._bcz = c;
            }
          });
          if (s.leaf[0].kind === 'client' && n.kind !== 'ap' && s.leaf.length >= 3) {
            n._clientBlock = s.leaf.slice();
            caps.push({
              txt: (shortName(n.label || n.id) || 'Switch') + ' wired', fact: String(s.leaf.length),
              col: '#8fb0d0', list: s.leaf.slice(),
              x: n._x + TIER_X * 0.62 + ((blk.rows - 1) / 2) * LEAF_SP,
              y: ((blk.lays - 1) / 2) * LEAF_SP + 34, z: c
            });
          }
        }
        cur += it.span + GAP;
      });
    }
    place(root, 0);

    /* ---- universe mode: an ESTATE MAP by role (2026-10-08) ------------------
       Was: every system hub, the WAN and the bare infra on ONE ring round the
       core, in slot order, with the slack shared out - so a new host moved
       every other galaxy, and the ring said nothing about what anything was.
       Now the map reads left to right, outside -> inside, and has the 16:9
       frame's shape (the camera looks from +Z, so -Z is the top of the frame):
         internet  the WAN at the far left; the exosphere opens beyond it
         sites     remote sites in two rows left of the core, either side of
                   the Internet axis (they are reached through it)
         core      the gateway's system, at the origin
         home      the home network's star system below the core
         infra     bare APs / switches that anchor no system, just off the
                   core toward home
         compute   Proxmox galaxies in two rows right of the core, growing to
                   the right: each new host joins the shorter row, just clear
                   of the galaxy before it. Nothing placed earlier ever moves.
       Only HUB positions are decided here; every body keeps its system-local
       offset, so growth stability inside a galaxy is untouched. No recentring:
       the core stays at the origin and the overview camera re-fits instead. */
    if (U) {
      var core = null;
      topo.nodes.forEach(function (n) { if (!core && n.kind === 'gateway') core = n; });
      if (core) {
        var old = {};
        topo.nodes.forEach(function (n) { old[n.id] = [n._x, n._y, n._z]; });
        core._x = 0; core._y = 0; core._z = 0;
        var coreR = uSys[core.id] ? uSys[core.id].R : 60, GAPZ = 70, Z0 = 60, X0 = coreR + GAPZ;
        var wanN = byId.wan;
        var sysHubs = Object.keys(uSys).map(function (aid) { return byId[aid]; })
          .filter(function (h) { return h && h !== core; })
          .sort(function (a, b) { return (uSys[a.id].slot | 0) - (uSys[b.id].slot | 0) || (a.id < b.id ? -1 : 1); });
        var Z = { compute: [], home: [], site: [], infra: [] };
        sysHubs.forEach(function (h) {
          var k = uSys[h.id].kind, z = k === 'clients' ? 'home' : k === 'site' ? 'site' : 'compute';
          Z[z].push({ n: h, R: uSys[h.id].R });
        });
        topo.nodes.forEach(function (n) {
          if (n === core || n === wanN || uSys[n.id] || leafKind(n)) return;
          if (n.kind === 'switch' || n.kind === 'ap' || n.kind === 'pvehost' || n.kind === 'external') Z.infra.push({ n: n, R: 40 });
        });
        Z.infra.sort(function (a, b) { return a.n.id < b.n.id ? -1 : 1; });
        function put(m, x, z) { m.n._x = x; m.n._y = 0; m.n._z = z; }
        /* DEEP-FIELD PACKING (2026-10-09). The rows spaced galaxies by their orbit
           radius R, but a photographic plate shows ~1.45 R of bright disc, so at
           the overview Core, SD-WAN, Home and GPU piled onto each other. Now each
           galaxy is packed round the core by its VISIBLE radius (VIS x R, the
           outer haze may still touch: it reads as a deep field, not a pile), in
           registry slot order, on its kind's side of the map (compute right, home
           below, sites upper/lower left, clear of the Internet axis): the closest
           clear spot wins, a small penalty per degree off that side. Greedy in
           slot order, so a galaxy placed earlier never moves when a new Proxmox
           node arrives - it simply takes the next clear spot on the right. */
        var VIS = 1.42, SEP = 50, PREF = { compute: 10, home: 90, site: 185 };
        var packed = [{ x: 0, z: 0, r: coreR * VIS }];
        function pack(m, zone) {
          var rv = m.R * VIS, c0 = PREF[zone] || 0, best = null;
          for (var k = 0; k <= 18; k++) {
            var dd = k === 0 ? 0 : (k % 2 ? -1 : 1) * Math.ceil(k / 2) * 10;   // top side first on a tie
            if (zone === 'site' && Math.abs(dd) < 30) continue;               // keep the Internet axis clear
            var th = (c0 + dd) * Math.PI / 180, cx = Math.cos(th), cz = Math.sin(th);
            var r = coreR * VIS + SEP + rv;
            for (var it = 0; it < 600; it++) {
              var x = r * cx, z = r * cz, ok = true;
              for (var q = 0; q < packed.length; q++) {
                var P = packed[q]; if (Math.hypot(P.x - x, P.z - z) < P.r + rv + SEP) { ok = false; break; }
              }
              if (ok) break;
              r += 6;
            }
            var sc = r * (1 + 0.0035 * Math.abs(dd));
            if (!best || sc < best.s - 1e-6) best = { s: sc, x: r * cx, z: r * cz };
          }
          put(m, best.x, best.z); packed.push({ x: best.x, z: best.z, r: rv });
        }
        var zoneOf = {};
        Object.keys(Z).forEach(function (zk) { Z[zk].forEach(function (m) { zoneOf[m.n.id] = zk; }); });
        sysHubs.forEach(function (h) {
          var zk = zoneOf[h.id]; if (!zk || zk === 'infra') return;
          var m = Z[zk].filter(function (q) { return q.n === h; })[0]; if (m) pack(m, zk);
        });
        var leftEdge = 0;
        packed.forEach(function (P) { leftEdge = Math.min(leftEdge, P.x - P.r); });
        Z.infra.forEach(function (m, i) {
          var rho = coreR + 46, th = 1.9 + 0.32 * i;
          put(m, rho * Math.cos(th), rho * Math.sin(th));
        });
        /* the Internet sits beyond the leftmost galaxy (only a new SITE can move it) */
        if (wanN && wanN !== core) { wanN._x = Math.min(-(coreR + 640), leftEdge - 150); wanN._y = 0; wanN._z = 0; }
        /* leaves that are in no system (rare in universe mode: an alias MAC
           record, a device the registry has not adopted) sit on a small ring
           round their parent hub at a hashed angle. They used to keep their
           tidy-tree block offset, which could be ~1000 units away from the
           hub once the hub moved - and the overview fit framed that. */
        var LH = window.UNIVERSE_LAYOUT;
        topo.nodes.forEach(function (n) {
          if (!leafKind(n) || uLeaf[n.id]) return;
          var p = byId[n._par]; if (!p) return;
          var R0 = p._uSys ? p._uSys.R : (uSys[p.id] ? uSys[p.id].R : 50);
          var h = LH ? LH.hash32(n.id) : 7, a = (h % 6283) / 1000, r = Math.max(40, R0 * 0.85);
          n._x = p._x + r * Math.cos(a); n._y = 0; n._z = p._z + r * Math.sin(a);
          if (n._bcx !== undefined) { n._bcx = n._x; n._bcz = n._z; }
        });
        caps.forEach(function (cp) {
          if (cp.sys) return;
          var m0 = cp.list && cp.list[0]; if (!m0) return;
          cp.x = m0._x; cp.z = m0._z;
        });
      }
    }

    /* universe leaves: hub position + canonical system-local placement */
    if (U) {
      topo.nodes.forEach(function (n) {
        var b = uLeaf[n.id]; if (!b) return;
        var hub = byId[U.sysOf(b).anchor], o = U.offset(b);
        n._x = hub._x + o.x; n._y = hub._y + o.y; n._z = hub._z + o.z;
        n._lstag = 0;
      });
      /* switch stars that land on the same spot of an orbit: two hubs in nearby
         slots can come out a few units apart, so one star sits behind the other and
         its name can never win a place. In slot
         order, each hub turns along its own orbit (disc plane x-z, round its system's
         anchor) until it clears every earlier hub by HUB_SEP. Deterministic from the
         persisted slots, so a hub that arrives later only ever moves itself. */
      var HUB_SEP = 90, hubsBy = {};   // ~50 px apart at the core stop: room for two one-line names
      topo.nodes.forEach(function (n) {
        var b = uLeaf[n.id]; if (!b || !b.hub) return;
        var aid = U.sysOf(b).anchor; (hubsBy[aid] = hubsBy[aid] || []).push(n);
      });
      Object.keys(hubsBy).forEach(function (aid) {
        var hub = byId[aid], placed = [];
        hubsBy[aid].sort(function (p, q) { return (uLeaf[p.id].shell - uLeaf[q.id].shell) || (uLeaf[p.id].slot - uLeaf[q.id].slot); });
        hubsBy[aid].forEach(function (n) {
          var dx = n._x - hub._x, dz = n._z - hub._z, r = Math.sqrt(dx * dx + dz * dz);
          var clear = function (x, z) { return placed.every(function (q) { return Math.hypot(q[0] - x, q[1] - z) >= HUB_SEP; }); };
          var x = n._x, z = n._z;
          if (r > 1 && !clear(x, z)) {
            var a0 = Math.atan2(dz, dx), step = Math.min(0.35, HUB_SEP / r) / 2;
            for (var k = 1; k <= 24; k++) {
              var a = a0 + step * Math.ceil(k / 2) * (k % 2 ? 1 : -1), tx = hub._x + Math.cos(a) * r, tz = hub._z + Math.sin(a) * r;
              if (clear(tx, tz)) { x = tx; z = tz; break; }
            }
            n._x = x; n._z = z;
          }
          placed.push([n._x, n._z]);
        });
      });
      /* one caption per system, on the disc's camera-side rim */
      Object.keys(uSys).forEach(function (aid) {
        var sy = uSys[aid], hub = byId[aid]; if (!hub) return;
        var members = topo.nodes.filter(function (m) { return m === hub || (m._ub && U.sysOf(m._ub) === sy); });
        caps.push({ txt: sysName(sy), fact: String(sy.count), col: sy.accent || '#8fb0d0',
                    list: members, x: hub._x, y: hub._y - 6, z: hub._z + sy.R + 16, sys: sy.id });
        /* group captions (2026-10-07): one per category sector of a PVE host,
           one per class ring elsewhere, so a viewer can tell what each cluster
           IS. Shown only at close-ups of their own system (labelPass: grp). */
        var GR = (U.groups && U.groups[sy.id]) || [];
        GR.forEach(function (q, qi) {
          var gl = [];
          q.members.forEach(function (bid) { var bb = U.byId[bid], nn = bb && bb.topo ? byId[bb.topo] : null; if (nn && !uSys[nn.id]) gl.push(nn); });   // another system's hub is not this ring's member
          if (!gl.length) return;
          var th, rr;
          if (q.kind === 'sector') { th = (q.a0 + q.a1) / 2 + (q.twist || 0) * 1.05; rr = q.rOut + 26; }   // at the arm's tip
          else {
            /* rings: names stacked down the camera-near side of the disc, each
               on its own ring, fanned a little so neighbours never share a line */
            th = Math.PI / 2 - 0.25 + (qi % 2 ? 0.30 : -0.30) + (qi - GR.length / 2) * 0.06;
            rr = q.rOut + 4;
          }
          caps.push({ txt: q.label, fact: String(q.n), col: q.kind === 'sector' ? (CAT[q.key] !== undefined ? hex(CAT[q.key]) : '#8fb0d0') : null,
                      list: gl, x: hub._x + rr * Math.cos(th), y: hub._y + 4, z: hub._z + rr * Math.sin(th), sys: sy.id, grp: q.kind });
        });
      });
    }

    // recentre on origin (category captions shift with their blocks)
    var bb = new THREE.Box3();
    topo.nodes.forEach(function (n) {
      bb.expandByPoint(NS.tmpV.set(n._x, n._y, n._z));
      var R = discR(n);
      if (R) { bb.expandByPoint(NS.tmpV.set(n._x - R, n._y, n._z - R)); bb.expandByPoint(NS.tmpV.set(n._x + R, n._y, n._z + R)); }
    });
    /* universe mode keeps the core at the origin (growth: a new galaxy must
       not shift every other one in world space); the classic tree recentres */
    var c = U ? new THREE.Vector3(0, 0, 0) : bb.getCenter(new THREE.Vector3());
    topo.nodes.forEach(function (n) {
      n._x -= c.x; n._z -= c.z;
      if (n._bcx !== undefined) { n._bcx -= c.x; n._bcz -= c.z; }
    });
    caps.forEach(function (cp) { cp.x -= c.x; cp.z -= c.z; });
    NS.layoutCaps = caps;
    bb.min.sub(c); bb.max.sub(c);
    return bb;
  }

  /* ============================ geometry per kind ============================ */
  var GEO = null;
  function geos() {
    if (GEO) return GEO;
    GEO = {
      gateway: new THREE.BoxGeometry(44, 13, 21),
      switch: new THREE.BoxGeometry(38, 10, 17),
      pvehost: new THREE.BoxGeometry(22, 30, 22),
      ap: new THREE.CylinderGeometry(11, 12.5, 4.5, 24),
      external: new THREE.BoxGeometry(22, 14, 14),
      wanCore: new THREE.SphereGeometry(18, 20, 16),
      wanWire: new THREE.IcosahedronGeometry(24, 1),
      guest: new THREE.BoxGeometry(7, 7, 7),
      client: new THREE.OctahedronGeometry(4.8, 0),
      ring: new THREE.RingGeometry(16, 19, 40),
      cyl: new THREE.CylinderGeometry(1, 1, 1, 8, 1, true)
    };
    return GEO;
  }

  function switchFaceTex(ports) {
    var cv = document.createElement('canvas'); cv.width = 128; cv.height = 32;
    var x = cv.getContext('2d');
    x.fillStyle = '#0b1522'; x.fillRect(0, 0, 128, 32);
    var perRow = Math.ceil(ports / 2);
    for (var i = 0; i < ports; i++) {
      var row = i < perRow ? 0 : 1, colI = i % perRow;
      x.fillStyle = 'rgba(90,215,255,0.28)';
      x.fillRect(8 + colI * (112 / perRow), 8 + row * 12, Math.max(2, 112 / perRow - 3), 7);
    }
    var t = sharpTex(new THREE.CanvasTexture(cv));
    return t;
  }

  function accentFor(n) {
    if (n.status === 'down') return PAL.alert;
    if (n.status === 'unknown') return PAL.unk;
    var cat = n.meta && n.meta.cat;
    if (cat) return catHex(cat);
    return { wan: PAL.cyan, gateway: PAL.cyan, switch: PAL.cyan, ap: 0x9b8cff, pvehost: PAL.ok, external: PAL.warn }[n.kind] || PAL.dim;
  }

  /* Additive back-side fresnel shell. On a dark scene this is the single
     cheapest way to make solid geometry read as lit hardware rather than a grey
     box: the silhouette picks up the node's accent and the bloom pass catches
     it. One extra draw per infra node, no lights involved, never picked by the
     raycaster.
     The colour is not decorative - it carries the measured reachability, so a
     host losing packets glows amber and a dead one glows red from across the
     room. */
  var RIM_VS = [
    'varying vec3 vN; varying vec3 vV;',
    'void main(){',
    '  vN = normalize(normalMatrix * normal);',
    '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
    '  vV = normalize(-mv.xyz);',
    '  gl_Position = projectionMatrix * mv;',
    '}'
  ].join('\n');
  var RIM_FS = [
    'varying vec3 vN; varying vec3 vV;',
    'uniform vec3 c; uniform float pw; uniform float st;',
    'void main(){',
    '  float f = pow(1.0 - abs(dot(vN, vV)), pw);',
    '  gl_FragColor = vec4(c * f * st, 1.0);',
    '}'
  ].join('\n');

  function rimMat(col) {
    return new THREE.ShaderMaterial({
      uniforms: { c: { value: new THREE.Color(col) },
                  pw: { value: 2.2 }, st: { value: 0.85 } },
      vertexShader: RIM_VS, fragmentShader: RIM_FS,
      transparent: true, blending: THREE.AdditiveBlending,
      side: THREE.BackSide, depthWrite: false, fog: false
    });
  }

  /* ---- trunk energy flow -----------------------------------------------
     The trunk links are the spine of the graph and they were flat: a solid
     cylinder whose only variable was brightness. The travelling particles
     already carry throughput, but they read as dots beside a link, not as the
     link itself being alive.

     So the trunk material now runs two bands along its own axis - cyan toward
     the child (download) and magenta back toward the parent (upload), the same
     colour convention the particles use. Both are driven by MEASURED rates:
     amplitude and speed come from the same normalised throughput the colour
     ramp uses, and a link with nothing measured gets dn = up = 0, so it shows
     no flow at all rather than a convincing-looking idle shimmer.

     One shared time uniform for every trunk, so animating this is one number
     per frame, not one per link. Fog is applied by hand because a raw
     ShaderMaterial gets none, and the scene is fogged at 0.0006 - without it
     the far trunks would sit in front of their own backdrop. */
  var TRUNK_T = { value: 0 };            // shared by every trunk material


  var TRUNK_VS = [
    'varying vec2 vUv; varying float vFog;',
    'void main(){',
    '  vUv = uv;',
    '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
    '  vFog = -mv.z;',
    '  gl_Position = projectionMatrix * mv;',
    '}'
  ].join('\n');

  var TRUNK_FS = [
    HUD_KEEP_GLSL,
    'varying vec2 vUv; varying float vFog;',
    'uniform vec3 cBase; uniform vec3 cDn; uniform vec3 cUp;',
    'uniform float opa; uniform float dn; uniform float up; uniform float reps;',
    'uniform float t; uniform vec3 fogColor; uniform float fogDensity;',
    /* a narrow crest rather than a sine, so it reads as a pulse travelling
       along the link instead of a stripey texture */
    'float band(float x){ return pow(max(0.0, 1.0 - abs(fract(x) - 0.5) * 2.0), 9.0); }',
    'void main(){',
    '  vec3 c = cBase;',
    '  if (dn > 0.0) c += cDn * band(vUv.y * reps - t * (0.18 + 0.7 * dn)) * (0.35 + 0.9 * dn);',
    '  if (up > 0.0) c += cUp * band(vUv.y * reps + t * (0.18 + 0.7 * up)) * (0.30 + 0.8 * up);',
    '  float f = 1.0 - exp(-fogDensity * fogDensity * vFog * vFog);',
    /* near fade: a trunk the tour camera flies past was a screen-wide slab
       of flat cyan cutting across the subject; it now thins to nothing in
       the last ~250 units before the lens */
    '  gl_FragColor = vec4(mix(c, fogColor, clamp(f, 0.0, 1.0)), opa * smoothstep(160.0, 700.0, vFog) * hudKeep());',
    '}'
  ].join('\n');

  function trunkMat() {
    var fog = window.scene && window.scene.fog;
    return new THREE.ShaderMaterial({
      uniforms: {
        cBase: { value: new THREE.Color(PAL.linkDim) },
        cDn: { value: new THREE.Color(PAL.cyan) },
        cUp: { value: new THREE.Color(PAL.magenta) },
        opa: { value: 0.95 }, dn: { value: 0 }, up: { value: 0 },
        reps: { value: 3 }, t: TRUNK_T, uHudInv: HUD_INV,
        fogColor: { value: new THREE.Color(fog ? fog.color : PAL.bg) },
        fogDensity: { value: fog && fog.density !== undefined ? fog.density : 0.0006 }
      },
      vertexShader: TRUNK_VS, fragmentShader: TRUNK_FS,
      transparent: true, depthWrite: false
    });
  }

  /* What the rim should be saying right now, and how loudly.

     The latency test used to be a flat `rtt > 60`, which the stored history
     shows is simply wrong for a real estate: a wifi client can sit at a 6 h
     median of ~72 ms and be perfectly healthy, so it glowed amber permanently
     while nothing at all was wrong with it. A rim that is always on is one nobody
     reads. It now uses the same baseline-relative severity as the links - a
     host is only flagged when it is slow FOR ITSELF - and falls back to the
     absolute threshold only where there is no baseline to compare against. */
  function rimColor(n) {
    var m = n.meta || {};
    if (n.status === 'down') return PAL.alert;
    if (m.loss != null && m.loss >= 100) return PAL.alert;
    if (m.loss) return PAL.warn;
    var sev = latSeverity(n);
    if (sev > 0.7) return PAL.alert;
    if (sev > 0.2) return PAL.warn;
    if (sev < 0 && m.rtt != null && m.rtt > 60) return PAL.warn;   // no baseline yet
    if (m.discovered) return PAL.warn;
    if (m.new) return PAL.ok;
    return accentFor(n);
  }
  /* the halo part: a node in trouble glows harder, not just differently, so it
     is findable in peripheral vision on a wall display */
  function rimStrength(n) {
    if (n.status === 'down') return 1.5;
    var sev = latSeverity(n);
    /* a star hub's corona already says "alive": the halo only speaks up for trouble */
    if (n._celHub && !(n.meta && n.meta.loss) && sev <= 0.2) return 0;
    return 0.85 + (sev > 0 ? 0.9 * sev : 0);
  }
  function addRim(n, grp, geo) {
    var rim = new THREE.Mesh(geo, rimMat(rimColor(n)));
    rim.material.uniforms.st.value = rimStrength(n);
    rim.scale.set(1.16, 1.16, 1.16);
    rim.renderOrder = -2;
    rim.userData.rim = true;
    grp.add(rim);
    n._rim = rim;
  }

  /* hub model radius (world units) ~ the half-diagonal of the box it replaces */
  var HUB_R = { gateway: 30, 'switch': 28, pvehost: 30, ap: 19, external: 20 };
  var CEL_HUB_K = { gateway: 0.55, 'switch': 0.5, pvehost: 0.5, ap: 0.5, external: 0.75 };
  function hubModels() {
    if (NS.b3d) return NS.b3d;
    if (!window.BODIES3D || !NS.scene) return null;
    NS.b3d = b3dCreate();
    return NS.b3d;
  }
  /* the ONE bodies3d instance of the page (hubs here, devices in
     netscene_universe.js). 2026-10-08 (contracts 8): the photo look - bodies lit
     by their own star, far bodies drawn as stars - whenever the page renders HDR
     (index.html NB_HDR); the old celestial look otherwise */
  function b3dCreate() {
    var fog = NS.scene.fog;
    var o = { scene: NS.scene, fogDensity: fog && fog.density !== undefined ? fog.density : 0.0006 };
    /* amb: the galaxy's own diffuse light on a night side (a body inside a bright disc is
       never black); the TV uses a little more (it frames its rings from the side) */
    if (window.NB_HDR) o.photo = { lod: [5.0, 12.0], lodFocus: 1.6, starPx: 5.4, starGain: 1.6, sun: 2.0, amb: [0.085, 0.092, 0.115], hazeK: 0.55 };
    return window.BODIES3D.create(o);
  }
  /* hubs wear their CLASS tint (universe_layout's palette, same as the
     preview and the nexus); reachability rides on the fresnel rim as before */
  var HUB_CLS = { gateway: 'gateway', 'switch': 'switch', ap: 'ap', pvehost: 'pve_host', external: 'storage' };
  function hubTint(n) {
    var L = window.UNIVERSE_LAYOUT, c = HUB_CLS[n.kind] || 'unknown';
    return L && L.colourRGB ? L.colourRGB({ 'class': c, seed: 0, status: 'up' }, null) : accentFor(n);
  }
  function hubStatus(n) {
    if (!n._b3dHub || !NS.b3d) return;
    var down = n.status === 'down';
    NS.b3d.setHubStatus(n._b3dHub, { tint: hubTint(n), desat: down ? 0.7 : (n.status === 'unknown' ? 0.4 : 0), bright: down ? 0.45 : 1 });
  }
  function makeInfraNode(n) {
    var G = geos(), grp = new THREE.Group(), acc = accentFor(n);
    var body, edge;
    if (n.kind === 'wan' && hubModels() && hubModels().look === 'celestial') {
      /* the Internet edge: a distant blue-white star seen through haze (the
         celestial manifest's 'edge' class), not a wireframe globe */
      var BW = hubModels(); n._celHub = true;
      body = BW.hubMesh('edge', { tint: accentFor(n) });
      var eS = BW.photo ? 6 : 13;       // photo look: a distant star with glare, not a white ball
      body.scale.set(eS, eS, eS);
      grp.add(body);
      addRim(n, grp, BW.hubGeometry('edge'));
      n._rim.scale.multiplyScalar(eS);
      n._b3dHub = body;
      n._h = 18;
    } else if (n.kind === 'wan') {
      body = new THREE.Mesh(G.wanCore, new THREE.MeshStandardMaterial({ color: 0x0c2030, roughness: 0.4, metalness: 0.3, emissive: 0x0a2436, emissiveIntensity: 0.6 }));
      var wire = new THREE.Mesh(G.wanWire, new THREE.MeshBasicMaterial({ color: acc, wireframe: true, transparent: true, opacity: 0.5 }));
      grp.add(body, wire);
      addRim(n, grp, G.wanCore);
      n._h = 25;
    } else if (hubModels() && HUB_R[n.kind]) {
      /* 3D hub model (bodies3d.js: Blender model when manifest.models has
         one, a clean placeholder until then; the geometry swaps in place) */
      var R = HUB_R[n.kind], B3 = hubModels();
      n._celHub = !!(window.BODIES3D && B3.look === 'celestial');
      if (n._celHub) R *= CEL_HUB_K[n.kind] || 0.6;      // a star reads big through its corona; the sphere stays modest
      body = B3.hubMesh(n.kind, { tint: hubTint(n), tintMix: 0.85 });
      body.scale.set(R, R, R);
      grp.add(body);
      addRim(n, grp, B3.hubGeometry(n.kind));
      n._rim.scale.multiplyScalar(R);
      n._b3dHub = body;
      hubStatus(n);
      /* photo look: a hub that is not a star (the SD-WAN NVR, a ringed giant)
         is lit from afar by the gateway, like the bodies of its system */
      if (B3.photo && B3.setHubLight && n.kind !== 'gateway' && !(B3.celInfo && B3.celInfo(HUB_CLS[n.kind] || n.kind).star)) {
        /* lit by its galaxy's core light from above the disc (the camera always
           looks down at it), not from the distant gateway behind it */
        B3.setHubLight(body, [n._x, n._y + 420, n._z + 60], 7);
      }
      n._h = { gateway: 12, switch: 10, pvehost: 18, ap: 8, external: 12 }[n.kind] || 10;
    } else {
      var geo = G[n.kind] || G.external;
      var mat = new THREE.MeshStandardMaterial({ color: PAL.body, roughness: 0.5, metalness: 0.45, emissive: 0x0a1624, emissiveIntensity: 0.55 });
      if (n.kind === 'switch') {
        var ports = (n.meta && n.meta.model && /24/.test(n.meta.model)) ? 24 : 16;
        mat = [
          new THREE.MeshStandardMaterial({ color: PAL.body, roughness: 0.5, metalness: 0.55 }),
          new THREE.MeshStandardMaterial({ color: PAL.body, roughness: 0.5, metalness: 0.55 }),
          new THREE.MeshStandardMaterial({ color: 0x101e2e, roughness: 0.45, metalness: 0.55 }),
          new THREE.MeshStandardMaterial({ color: PAL.body, roughness: 0.5, metalness: 0.55 }),
          new THREE.MeshStandardMaterial({ map: switchFaceTex(ports), roughness: 0.5, metalness: 0.35 }),
          new THREE.MeshStandardMaterial({ color: PAL.body, roughness: 0.5, metalness: 0.55 })
        ];
      }
      body = new THREE.Mesh(geo, mat);
      edge = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: acc, transparent: true, opacity: 0.85 }));
      grp.add(body, edge);
      addRim(n, grp, geo);
      n._h = { gateway: 7, switch: 6, pvehost: 16, ap: 3, external: 8 }[n.kind] || 8;
    }
    n._r = { wan: 22, gateway: 26, switch: 23, pvehost: 19, ap: 14, external: 14 }[n.kind] || 14;
    grp.position.set(n._x, n._y, n._z);
    body.userData.nsId = n.id;
    NS.pick.push(body);
    n._grp = grp; n._body = body; n._edge = edge || null;

    if (ringWanted(n)) addAlertRing(n, grp);

    /* one line, short name, no address (section 7). A Proxmox host's galaxy
       caption already names it ("PVE2 · 88"), so its star carries no
       second copy of the same word; the click card has the full record. */
    var hubTxt = n.kind === 'wan' ? 'Internet' : shortName(n.label || n.id, n._ub || (uni() && uni().bodyOfTopo ? uni().bodyOfTopo(n.id) : null));
    if (hubTxt && !(n.kind === 'pvehost' && n._uSys)) {
      var hubB = n._ub || (uni() && uni().bodyOfTopo ? uni().bodyOfTopo(n.id) : null);
      var lbl = textLabel(hubTxt, 'hub', { col: n.status === 'down' ? STATUS_INK.down : null, badge: hubB && hubB.lab ? 'LAB' : null });
      lbl.position.set(n._x, n._y + (n.kind === 'external' ? -(n._h + 22) : n._h + 18), n._z);
      lbl.userData.focN = n;
      NS.graph.add(lbl);
      n._lbl = lbl;
    }
    return grp;
  }

  /* a node earns a ring for being down, for losing packets, or for having just
     appeared -- three different reasons, three different colours, one mesh */
  function ringColor(n) {
    if (n.status === 'down' && !isDormant(n)) return PAL.alert;
    var m = n.meta || {};
    if (m.loss != null && m.loss >= 100) return PAL.alert;
    if (m.loss) return PAL.warn;
    if (m.new || m.discovered) return PAL.ok;
    return PAL.alert;
  }
  function ringWanted(n) {
    var m = n.meta || {};
    return (n.status === 'down' && !isDormant(n)) || !!m.loss || !!m.new || !!m.discovered;
  }
  function addAlertRing(n, grp) {
    var ring = new THREE.Mesh(geos().ring, new THREE.MeshBasicMaterial({ color: ringColor(n), transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = -(n._h || 4) - 1;
    grp.add(ring); NS.alertRings.push(ring); n._ring = ring; n._hasRing = true;
  }

  var HOT = new THREE.Color(0xffb347);

  /* Hue = what the guest IS (category). Brightness = what it is DOING right
     now (live CPU). An idle guest sits dim, a working one lights up, and
     anything genuinely loaded bleeds toward amber. Refreshed every poll by
     applyDynamics(), so the lattice reads as an activity map at a glance. */
  function loadU(n) {
    var cpu = n.meta && n.meta.cpu;
    if (cpu == null) return null;
    cpu = Math.max(0, Math.min(100, +cpu));
    return Math.min(1, Math.pow(cpu / 100, 0.5));   // perceptual: 4% cpu still reads
  }

  /* clients carry no CPU, so they used to all sit at the same dim slate. Hue now
     says what KIND of thing it is (meta.cat from the topology classifier) and a
     known-but-asleep client (meta.offline) is dormant: dim, small, not red. */
  var CLIENT_CAT = { pc: 0x9bd8ff, phone: 0xb08cff, appliance: 0xffb347, 'smart-home': 0x37f5a0, av: 0xff4fa3,
                     printer: 0xffd166, '3dprinter': 0xff8a5b, network: 0x7fa3c8, unknown: 0x6f8faf };
  var CLIENT_GLYPH = { pc: '▣', phone: '◧', appliance: '⚙', 'smart-home': '⌂', av: '▶', printer: '▤', '3dprinter': '◈', network: '▦' };
  /* dormant = asleep, powered off on purpose, or long gone: drawn quiet, never red.
     The registry's down_why (2026-10-09) tells a stopped guest or a device not seen
     for days apart from a real outage; absent field = the old rule only. */
  function isDormant(n) {
    if (n.kind === 'client' && n.meta && n.meta.offline) return true;
    var w = n.status === 'down' && n._ub ? n._ub.down_why : null;
    return w === 'stopped' || w === 'gone';
  }
  function guestColor(n) {
    var c = new THREE.Color();
    if (isDormant(n)) { c.setHex(0x2b3648); return c; }
    if (n.kind === 'client') {
      if (n.status === 'down') { c.setHex(0x96242f); return c; }
      if (n.status === 'unknown') { c.setHex(0x39465a); return c; }
      c.setHex(CLIENT_CAT[(n.meta && n.meta.cat) || 'unknown'] || CLIENT_CAT.unknown);
      var live = bpsNorm(Math.max(+n.rx || 0, +n.tx || 0));      // a talking device glows a little harder
      c.multiplyScalar(0.62 + 0.5 * live);
      return c;
    }
    if (n.status === 'down') { c.setHex(0x96242f); return c; }
    if (n.status === 'unknown') { c.setHex(0x39465a); return c; }
    c.setHex(catHex((n.meta && n.meta.cat) || 'infra'));
    var u = loadU(n);
    if (u === null) { c.multiplyScalar(0.55); return c; }   // running, load unknown
    c.multiplyScalar(0.40 + 0.95 * u);
    if (u > 0.55) c.lerp(HOT, (u - 0.55) / 0.45 * 0.5);
    return c;
  }

  function guestScale(n) {
    if (isDormant(n)) return 0.62;
    if (n.status !== 'up') return 1;
    var u = loadU(n);
    return u === null ? 1 : 1 + 0.75 * u;
  }

  function fmtIO(b) {
    b = +b || 0;
    if (b < 1024) return b.toFixed(0) + ' B/s';
    if (b < 1048576) return (b / 1024).toFixed(0) + ' kB/s';
    return (b / 1048576).toFixed(1) + ' MB/s';
  }

  /* ============================ graph build ============================ */
  function rebuildGraph(topo) {
    var oldPos = {};
    if (NS.graph) {
      NS.nodes.forEach(function (n) { oldPos[n.id] = { x: n._x, y: n._y, z: n._z }; });
      /* dispose a second later, not now: freeing every material here released
         its GL program, so the identical new materials recompiled them all on
         the next frame (~40 ms of shader compiles per rebuild). Kept alive
         until the new graph has drawn, the programs are simply reused. */
      var oldG = NS.graph; NS.scene.remove(oldG); setTimeout(function () { disposeDeep(oldG); }, 1500);
    }
    NS.graph = new THREE.Group(); NS.scene.add(NS.graph);
    NS.pick = []; NS.labels = []; NS.rateLabels = []; NS.alertRings = [];
    NS.links = []; NS.guestIdx = []; NS.clientIdx = [];
    NS.byId = {}; NS.nodes = topo.nodes;
    topo.nodes.forEach(function (n) { NS.byId[n.id] = n; });

    var bb = computeLayout(topo);
    var G = geos();

    /* seed current (tween-from) positions BEFORE geometry is built */
    var hadOld = Object.keys(oldPos).length > 0;
    topo.nodes.forEach(function (n) {
      var o = oldPos[n.id];
      n._cx = o ? o.x : n._x; n._cy = o ? o.y : n._y; n._cz = o ? o.z : n._z;
    });

    /* infra nodes */
    topo.nodes.forEach(function (n) {
      if (n.kind === 'guest' || n.kind === 'client') return;
      NS.graph.add(makeInfraNode(n));
    });

    /* guests + clients: instanced */
    var guests = topo.nodes.filter(function (n) { return n.kind === 'guest'; });
    var clients = topo.nodes.filter(function (n) { return n.kind === 'client'; });
    NS.guestIM = makeInstanced(G.guest, guests, 'guestIdx');
    NS.clientIM = makeInstanced(G.client, clients, 'clientIdx');
    /* universe mode: netscene_universe.js draws EVERY leaf (one instanced atlas
       draw). These two stay in the scene graph, invisible, purely as hover
       pick targets (the raycaster does not test .visible). */
    if (uni()) {
      if (NS.guestIM) NS.guestIM.visible = false;
      if (NS.clientIM) NS.clientIM.visible = false;
    }

    /* small labels for guests & near clients (distance-faded, focus-aware).
       Bigger type than v1: they only materialise when the tour flies close,
       so overview clutter is unaffected. Neighbouring labels stagger in Y
       (checkerboard) so a 19-unit grid doesn't smear into one line of ink. */
    /* Names are NOT unique in this estate -- there are two containers called
       "homeassistant", two called "ubuntu", and a printer that shows up on both
       its wired and wireless MACs. Two identical names sitting next to each
       other is the other half of "hosts stacked on top of each other": the nodes
       are genuinely distinct, the labels are indistinguishable. Qualify the
       repeats with whatever actually tells them apart. */
    var _seen = {}, _dup = {};
    guests.concat(clients).forEach(function (n) {
      var k = (n.label || n.id).toLowerCase();
      if (_seen[k]) _dup[k] = 1; else _seen[k] = 1;
    });
    function labelFor(n) {
      var base = n.label || n.id, sh = shortName(base, n._ub);
      if (!sh || !_dup[base.toLowerCase()]) return sh;
      /* a repeated name keeps a short qualifier, never an address */
      var q = (n.meta && n.meta.vmid != null) ? '#' + n.meta.vmid
            : (n.meta && n.meta.wired === false) ? '(Wi-Fi)' : '';
      return q ? sh + ' ' + q : sh;
    }

    /* universe mode: label meaningful bodies only. A leaf whose only name is
       its IP (unknown / ping-discovered) gets no standing label unless it is
       new in the universe (first 10 min) - a dozen bare-address tags read as
       clutter, and the hover card still names it. */
    var IP_ONLY = /^\d{1,3}(\.\d{1,3}){3}$/;
    guests.concat(clients).forEach(function (n) {
      if (uni() && n.kind === 'client' && IP_ONLY.test(String(n.label || n.id))
          && !(n._ub && n._ub['new'])) return;
      if (n._alias) return;                  // a hub's second MAC record: the hub itself is named
      var isHub = !!(n._ub && n._ub.hub);
      var dorm = isDormant(n);
      /* colour only for meaning: down, newly seen, ping-discovered; asleep is dim */
      var lc = dorm ? '#7d8693'
             : n.status === 'down' ? STATUS_INK.down
             : (n.meta && n.meta.discovered) ? STATUS_INK.warn
             : (n.meta && n.meta.new) ? STATUS_INK.fresh : null;
      var txt = labelFor(n);
      if (!txt) return;
      /* a switch hub (registry hub:true) is named like the other hubs */
      var l = textLabel(txt, isHub ? 'hub' : 'leaf', { col: lc, badge: n._ub && n._ub.lab ? 'LAB' : null, fade: isHub ? null : (uni() ? { near: 800, far: 1300 } : { near: 340, far: 640 }) });
      l.position.set(n._x, n._y + 9.5 + 5.5 * (n._lstag || 0), n._z);
      l.userData.focN = n;
      NS.graph.add(l); n._lbl = l;
    });

    /* category captions over each guest block: the lattice explains itself */
    (NS.layoutCaps || []).forEach(function (cp) {
      /* galaxy captions: name + one fact, a muted accent dot; group captions
         (arms / rings) smaller and quieter, close-ups only (labelPass) */
      var s = textLabel(cp.txt, cp.grp ? 'grp' : 'cap', { dot: mutedAccent(cp.col), fact: cp.fact });
      s.position.set(cp.x, cp.y, cp.z);
      s.userData.focList = cp.list;
      if (cp.grp) s.userData.grp = cp.grp;
      if (cp.sys) s.userData.sysCap = cp.sys;
      NS.graph.add(s);
      cp.spr = s;
    });

    buildLinks(topo);

    /* the floating "busiest guest" callouts (name / cpu / mem / io) are gone
       (section 7: no per-body numbers in the scene); the click card and the
       stop caption carry them */
    NS.hotLabels = []; NS.hotLeaders = [];

    /* camera fit: frame the graph inside the HUD-free centre */
    /* the exosphere overlay (netscene_exo.js) lives beyond the WAN: fold most of
       its envelope into the fit so the beacons are framed, not clipped (2026-09-14) */
    if (NS.exoEnvelope && NS.byId.wan) {
      try { NS.exoEnvelope(NS.byId.wan).forEach(function (p) { bb.expandByPoint(NS.tmpV.set(p[0] + 34, p[1], p[2])); }); } catch (e) { }
    }
    bb.getCenter(NS.center); NS.center.x += CENTER_DX;
    NS.bboxCenter = bb.getCenter(new THREE.Vector3());
    var exX = (bb.max.x - bb.min.x) / 2 + 60, exZ = (bb.max.z - bb.min.z) / 2 + 40;
    // guest blocks now have real height, so vertical extent is no longer just
    // the tilted depth -- ignoring exY would push the lattice out of frame
    var exY = (bb.max.y - bb.min.y) / 2 + 26;
    var vf = NS.cam.fov * Math.PI / 360, ta = Math.tan(vf) * NS.cam.aspect;
    // (FRAC_* retuned 2026-08-22 for the narrowed HUD-safe box x 400-1500,
    // y 129-805, measured against the worst-case footprint over a full orbit
    // INCLUDING label sprite widths -- node centres alone under-read it by
    // ~100 px and the WAN label clipped behind the left HUD panel.)
    var azMax = CAM_SWAY + 0.06;
    var dH = (exX * Math.cos(azMax) + exZ * Math.sin(azMax)) / (ta * FRAC_X);
    var dV = (exZ * Math.sin(CAM_EL) + exY * Math.cos(CAM_EL) + 44) / (Math.tan(vf) * FRAC_Y);
    NS.fitDist = Math.max(dH, dV, 480);
    NS.fitEx = { x: exX, y: exY, z: exZ };   // kept so setFrame() can re-fit
    /* the exploded view's tier gap scales with the estate: a 4-node layout
       is wider, so its guests lift further before the tiers read as separate */
    NS.explodeY = Math.max(70, Math.min(190, exX * 0.3));
    applyViewOffset();
    if (uni()) fitOverviewUni();
    NS.tweenUntil = NS.t + (hadOld ? 1.6 : 0);
    NS.needSettle = true;
    NS.nodes.forEach(function (n) { n._foc = 1; n._focT = 1; });
    NS.focusAll = true; NS.focusAnim = false;
    buildTour();
    syncNodeTransforms(hadOld ? 0.1 : 1);
    updateLinkGeometry(true);
    if (NS.onRebuild) { try { NS.onRebuild(hadOld); } catch (e) { console.error('netscene: onRebuild failed', e); } }
  }

  function makeInstanced(geo, list, idxKey) {
    if (!list.length) return null;
    var im = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ color: 0xffffff }), list.length);
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    list.forEach(function (n, i) {
      NS.tmpM.makeTranslation(n._x, n._y, n._z);
      im.setMatrixAt(i, NS.tmpM);
      im.setColorAt(i, guestColor(n));
      NS[idxKey].push(n.id);
      n._inst = { im: im, i: i };
    });
    im.userData.nsInstanced = idxKey;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    NS.graph.add(im); NS.pick.push(im);
    return im;
  }

  /* ============================ links ============================ */
  function childOf(l) {
    var a = NS.byId[l.source], b = NS.byId[l.target];
    if (!a || !b) return null;
    return (a._depth > b._depth) ? a : b;
  }
  function isInfra(n) { return n && n.kind !== 'guest' && n.kind !== 'client'; }

  function buildLinks(topo) {
    var G = geos();
    var straightV = [], straightMap = [];       // measured leaf links
    var arcV = [], arcMap = [];                 // measured wireless arcs
    var dashV = [];                             // unmeasured anything

    (topo.links || []).forEach(function (l, li) {
      var a = NS.byId[l.source], b = NS.byId[l.target];
      if (!a || !b) return;
      var child = childOf(l), parent = (child === a) ? b : a;
      var L = {
        data: l, aId: parent.id, bId: child.id, childId: child.id,
        trunk: isInfra(a) && isInfra(b),
        arc: (parent.kind === 'ap' && child.kind === 'client') || child.kind === 'external' || parent.kind === 'external',
        measured: !!l.measured, mesh: null, mat: null, lbl: null,
        ax: 0, ay: 0, az: 0, bx: 0, by: 0, bz: 0, px: 0, pz: 0, len: 1, peak: 0,
        vStart: -1, vCount: 0, set: null
      };
      NS.links.push(L);

      if (!L.measured) { L.set = 'dash'; L.vStart = dashV.length; dashV.push(0, 0, 0, 0, 0, 0); L.vCount = 2; return; }

      if (L.trunk && !L.arc) {
        L.mat = trunkMat();
        L.mesh = new THREE.Mesh(G.cyl, L.mat);
        NS.graph.add(L.mesh);
        /* no per-link rate plates (section 7): link rates live in the click card */
      } else if (L.arc) {
        var SEG = 13;
        L.set = 'arc'; L.vStart = arcV.length / 3; L.vCount = SEG * 2;
        for (var s = 0; s < SEG * 2; s++) arcV.push(0, 0, 0);
        arcMap.push(L);
      } else {
        L.set = 'line'; L.vStart = straightV.length / 3; L.vCount = 2;
        straightV.push(0, 0, 0, 0, 0, 0);
        straightMap.push(L);
      }
    });

    function mkLineSet(verts, dashed) {
      var g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3).setUsage(THREE.DynamicDrawUsage));
      var col = new Float32Array(verts.length);
      g.setAttribute('color', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
      /* additive: a line dimmed by focus/length fades toward nothing instead of
         drawing a dark stroke across a lit galaxy disc */
      var m = dashed
        ? new THREE.LineDashedMaterial({ color: 0xffffff, vertexColors: true, dashSize: 6, gapSize: 5, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false })
        : new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 1.0, blending: THREE.AdditiveBlending, depthWrite: false });
      var ls = new THREE.LineSegments(g, m);
      ls.frustumCulled = false;
      NS.graph.add(ls);
      return ls;
    }
    NS.lineSet = straightV.length ? mkLineSet(straightV, false) : null;
    NS.arcSet = arcV.length ? mkLineSet(arcV, false) : null;
    NS.dashSet = dashV.length ? mkLineSet(dashV, true) : null;

    updateLinkGeometry(true);
    applyDynamics({ nodes: NS.nodes, links: topo.links });
  }

  /* refresh cached endpoints + geometry (called each frame during tween, once after) */
  function updateLinkGeometry(force) {
    var tween = NS.t < NS.tweenUntil;
    if (!tween && !force) return;
    NS.links.forEach(function (L) {
      var a = NS.byId[L.aId], b = NS.byId[L.bId];
      if (!a || !b) return;
      L.ax = a._cx; L.ay = a._cy + (a._h ? a._h * 0.15 : 0); L.az = a._cz;
      L.bx = b._cx; L.by = b._cy; L.bz = b._cz;
      var dx = L.bx - L.ax, dy = L.by - L.ay, dz = L.bz - L.az;
      /* leaf spokes (and their particles) start at the hub model's edge, not its
         centre: 80 spokes converging on a busy host's station washed it out */
      if (!L.mesh && L.set !== 'arc' && a._b3dHub && !L.trunk) {
        var gl = Math.sqrt(dx * dx + dy * dy + dz * dz), gap = (HUB_R[a.kind] || 20) * 1.35 * (a._grp ? a._grp.scale.x : 1);
        if (gl > gap * 2) { L.ax += dx / gl * gap; L.ay += dy / gl * gap; L.az += dz / gl * gap; dx = L.bx - L.ax; dy = L.by - L.ay; dz = L.bz - L.az; }
      }
      L.len = Math.max(1e-3, Math.sqrt(dx * dx + dy * dy + dz * dz));
      var hl = Math.max(1e-3, Math.sqrt(dx * dx + dz * dz));
      if (hl > 2) { L.px = -dz / hl; L.pz = dx / hl; } else { L.px = 1; L.pz = 0; }
      L.peak = L.arc ? (10 + L.len * 0.16) : 0;

      if (L.mesh) {   // trunk cylinder (trimmed so it meets the chassis, not the centre)
        var rA = a._r || 6, rB = b._r || 6, trim = Math.min(L.len * 0.4, rA + rB) / 2;
        var ux = dx / L.len, uy = dy / L.len, uz = dz / L.len;
        var tLen = Math.max(2, L.len - rA - rB);
        L.mesh.position.set((L.ax + L.bx) / 2 + ux * (rA - rB) / 2, (L.ay + L.by) / 2 + uy * (rA - rB) / 2, (L.az + L.bz) / 2 + uz * (rA - rB) / 2);
        NS.tmpV.set(ux, uy, uz);
        L.mesh.quaternion.setFromUnitVectors(NS.up, NS.tmpV);
        var r = L.mesh.userData.r || 0.9;
        L.mesh.scale.set(r, tLen, r);
        // ~one pulse per 90 world units, so a long trunk does not get one
        // stretched blob and a short one a barcode
        if (L.mat.uniforms) L.mat.uniforms.reps.value = Math.max(1.5, tLen / 90);
        if (L.lbl) L.lbl.position.set((L.ax + L.bx) / 2, (L.ay + L.by) / 2 - 14, (L.az + L.bz) / 2);
      } else if (L.set === 'line' && NS.lineSet) {
        var p = NS.lineSet.geometry.attributes.position.array, o = L.vStart * 3;
        p[o] = L.ax; p[o + 1] = L.ay; p[o + 2] = L.az; p[o + 3] = L.bx; p[o + 4] = L.by; p[o + 5] = L.bz;
      } else if (L.set === 'arc' && NS.arcSet) {
        var pa = NS.arcSet.geometry.attributes.position.array, oo = L.vStart * 3, SEG = L.vCount / 2;
        for (var s = 0; s < SEG; s++) {
          var t0 = s / SEG, t1 = (s + 1) / SEG;
          writeBez(pa, oo + s * 6, L, t0); writeBez(pa, oo + s * 6 + 3, L, t1);
        }
        if (L.lbl) L.lbl.position.set((L.ax + L.bx) / 2, (L.ay + L.by) / 2 + L.peak + 10, (L.az + L.bz) / 2);
      } else if (L.set === 'dash' && NS.dashSet) {
        var pd = NS.dashSet.geometry.attributes.position.array, od = L.vStart;
        pd[od] = L.ax; pd[od + 1] = L.ay; pd[od + 2] = L.az; pd[od + 3] = L.bx; pd[od + 4] = L.by; pd[od + 5] = L.bz;
      }
    });
    if (NS.lineSet) NS.lineSet.geometry.attributes.position.needsUpdate = true;
    if (NS.arcSet) NS.arcSet.geometry.attributes.position.needsUpdate = true;
    if (NS.dashSet) { NS.dashSet.geometry.attributes.position.needsUpdate = true; NS.dashSet.computeLineDistances(); }
  }
  /* universe mode: a leaf hung off a far-away parent (an SD-WAN client on the
     UDM, a home client on the gateway) is still drawn - it is a real
     attachment - but long leaf lines fade with length so 30 of them do not
     hatch across the whole frame. In focus they come back up. */
  /* 2026-10-07 (clean pass): the spokes were a starburst at every host stop -
     88 lit lines out of one hub. They are now a whisper everywhere, and the
     in-focus boost shrinks with how many leaves share the stop: the three
     MEDIA guests get readable lines, eighty-eight guests get a faint halo. */
  function spokeK() {
    if (NS._skSeq !== NS.focusSeq) {
      NS._skSeq = NS.focusSeq;
      var ids = NS.focusIds, n = 0, k;
      if (ids) { for (k in ids) n++; } else n = NS.nodes.length;
      NS._focN = n;
      NS._sk = Math.min(0.42, 1.3 / Math.sqrt(Math.max(1, n)));
      /* photo look (2026-10-08): the subject's spokes stay readable but quieter -
         a fan of bright lines over a photographic galaxy read as a diagram */
      if (window.NB_HDR) NS._sk *= 0.6;
    }
    return NS._sk;
  }
  function leafLenFade(L) {
    if (!uni() || L.trunk) return 1;
    var f = Math.max(0.04, Math.min(0.12, 40 / Math.max(1, L.len)));
    /* a leaf whose spoke crosses into another galaxy (a home client on a core AP)
       draws a long straight line over two plates: at the overview, where the
       measured streams tell the traffic story, those step almost out (2026-10-09) */
    if (L.len > 260) f *= 1 - 0.8 * trafficOverK();
    var on = Math.max(0, (L._lf || 0) - 0.5) * 2 * (1 - (NS.overK === undefined ? (NS.focusAll === false ? 0 : 1) : NS.overK));
    return f + (Math.max(f, spokeK()) - f) * on;
  }
  function writeBez(arr, o, L, t) {
    var mx = (L.ax + L.bx) / 2, my = (L.ay + L.by) / 2 + L.peak, mz = (L.az + L.bz) / 2;
    var u = 1 - t;
    arr[o] = u * u * L.ax + 2 * u * t * mx + t * t * L.bx;
    arr[o + 1] = u * u * L.ay + 2 * u * t * my + t * t * L.by;
    arr[o + 2] = u * u * L.az + 2 * u * t * mz + t * t * L.bz;
  }

  /* ============================ dynamics (every data refresh) ============================ */
  var _cDim = new THREE.Color(), _cHot = new THREE.Color(), _cTmp = new THREE.Color();
  function applyDynamics(topo) {
    // refresh node data refs (rebuild path already replaced NS.nodes)
    var linkByKey = {};
    NS.links.forEach(function (L) { linkByKey[L.data.source + '>' + L.data.target] = L; });
    (topo.links || []).forEach(function (l) {
      var L = linkByKey[l.source + '>' + l.target]; if (L) L.data = l;
    });

    /* nodes: colours + status */
    NS.nodes.forEach(function (n) {
      if (n._inst) {
        n._inst.im.setColorAt(n._inst.i, guestColor(n));
      } else if (n._edge) {
        n._edge.material.color.setHex(accentFor(n));
      } else if (n._b3dHub) {
        hubStatus(n);
      }
      if (n._lbl && n._lbl.userData.l2d) {        // painted label: status is its only colour
        var dm = isDormant(n);
        n._lbl.userData.col = dm ? '#7d8693' : n.status === 'down' ? STATUS_INK.down
          : (n.meta && n.meta.discovered) ? STATUS_INK.warn : (n.meta && n.meta.new) ? STATUS_INK.fresh : null;
      }
    });
    if (NS.guestIM && NS.guestIM.instanceColor) NS.guestIM.instanceColor.needsUpdate = true;
    if (NS.clientIM && NS.clientIM.instanceColor) NS.clientIM.instanceColor.needsUpdate = true;

    /* size follows load too; alpha 0 rewrites the matrices without disturbing
       an in-flight position tween */
    NS.nodes.forEach(function (n) { if (n._inst) n._scl = guestScale(n); });
    syncNodeTransforms(0);
    /* NOT updateHotLabels() here: this runs from the poll's fetch callback,
       i.e. BETWEEN frames, and re-seated the hot callouts with no label pass
       after them. On a kiosk the gap to the next pass is <16 ms; in a
       software-GL browser (~2 fps) it is up to 430 ms, and a label audit
       sampled a callout sitting on a flow label 1 frame in 60. netSceneTick
       calls updateHotLabels() before every render anyway. */

    restyleLinks();
    updateLinkGeometry(true);
    allocParticles();
  }

  /* ---- link colour by latency -----------------------------------------
     The link ramp already carries throughput (dim -> hot). Latency is a
     different question and gets its own channel: a tint toward amber/red laid
     over that ramp, so a link can read "busy AND fine" or "idle AND sick".

     Severity is measured against each host's OWN 6 h median from the sampler,
     not a fixed threshold -- 0.3 ms is normal for a wired guest and 25 ms is
     normal for a phone on wifi, so one number cannot judge both. A host with
     no baseline yet is simply not tinted; the scene never claims a health it
     has not measured.

     Two conditions must BOTH be met before anything colours, which is what
     keeps it quiet: the RTT has to be a real multiple of the host's own median
     AND far enough above it in absolute ms to matter. A 0.2 ms host at 0.9 ms
     is 4.5x its median and still perfectly healthy. */
  var _base = { t: 0, ips: {}, pending: false, have: false };
  var BASE_TTL = 120;

  /* NOTE: _base is assigned here, well after init() runs, so pollBaseline must
     only ever be called from the poll interval - never eagerly from init(). */
  function pollBaseline() {
    var now = Date.now() / 1000;
    if (_base.pending || now - _base.t < BASE_TTL) return;
    _base.pending = true;
    fetch('/api/rtt/baseline')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        _base.pending = false; _base.t = Date.now() / 1000;
        if (j && j.ips) { _base.ips = j.ips; _base.have = true; }
      })['catch'](function () { _base.pending = false; _base.t = Date.now() / 1000; });
  }

  var RATIO_LO = 2, RATIO_HI = 8;      // x median: start tinting / fully red
  var ABS_LO = 2, ABS_HI = 40;         // ms above median: same two ends

  /* -1 = not measured (do not tint). 0..1 = measured severity. */
  function latSeverity(n) {
    if (!n || !n.meta || n.status === 'down' || !_base) return -1;
    var m = n.meta, sev = -1;
    if (m.loss != null) {
      if (m.loss >= 100) return 1;                 // answered nothing at all
      if (m.loss > 0) sev = Math.min(1, 0.4 + m.loss / 100 * 0.6);
    }
    if (m.rtt != null && n.ip) {
      var b = _base.ips[n.ip];
      if (b && b.p50 != null) {
        var p50 = Math.max(b.p50, 0.05);
        var rs = (Math.log(m.rtt / p50) / Math.LN2 - 1) / 2;   // 2x->0, 8x->1
        var as = (m.rtt - p50 - ABS_LO) / (ABS_HI - ABS_LO);
        var ls = Math.max(0, Math.min(1, Math.min(rs, as)));
        if (ls > sev) sev = ls;
      }
    }
    return sev;
  }

  var _cSev = new THREE.Color(), _cWarn = new THREE.Color(), _cAlert = new THREE.Color();
  function sevColor(sev) {
    _cWarn.setHex(PAL.warn); _cAlert.setHex(PAL.alert);
    return _cSev.copy(_cWarn).lerp(_cAlert, Math.max(0, (sev - 0.5) * 2));
  }
  /* how hard the tint bites: never a full replace, so the throughput ramp
     underneath stays readable at every severity */
  function sevMix(sev) { return 0.25 + 0.55 * sev; }

  /* links: colour, thickness, rate labels — all multiplied by tour focus
     (merged line sets can't toggle per-segment visibility, but multiplying
     a line's colour to black on this background removes it just as well) */
  function restyleLinks() {
    var lineCol = NS.lineSet ? NS.lineSet.geometry.attributes.color.array : null;
    var arcCol = NS.arcSet ? NS.arcSet.geometry.attributes.color.array : null;
    var dashF = 0;
    var dashCol = NS.dashSet && NS.dashSet.geometry.attributes.color ? NS.dashSet.geometry.attributes.color.array : null;
    NS.links.forEach(function (L) {
      var lf = linkFocus(L);
      L._lf = lf;
      if (!L.measured) {
        dashF = Math.max(dashF, lf);
        if (dashCol) {      // per-link focus (was one opacity for the whole set)
          var dk = 0.62 * lf * leafLenFade(L);
          for (var dq = 0; dq < 6; dq += 3) { var od = L.vStart + dq; dashCol[od] = 0.43 * dk; dashCol[od + 1] = 0.50 * dk; dashCol[od + 2] = 0.58 * dk; }
        }
        return;
      }
      var u = bpsNorm(L.data.bps);
      var child = NS.byId[L.childId];
      var known = child && child.measured;
      /* latency of the node this link leads to. The link is the path that
         RTT was measured over, so it is the honest place to show it. */
      var sev = latSeverity(child);
      L._sev = sev;
      if (L.mesh) {
        var U = L.mat.uniforms;
        _cDim.setHex(PAL.linkDim); _cHot.setHex(PAL.linkHot);
        U.cBase.value.copy(_cDim).lerp(_cHot, u);
        /* utilisation vs the port's real capacity whitens the trunk: a 10G link
           at 0.5 % is a different story from a 1G link at 5 % (2026-09-14) */
        var capU = L.data.capacity_bps ? (+L.data.bps || 0) / L.data.capacity_bps : 0;
        if (capU > 0.002) U.cBase.value.lerp(_cTmp.setHex(0xf2f8ff), Math.min(0.4, capU * 12));
        if (sev > 0) U.cBase.value.lerp(sevColor(sev), sevMix(sev));
        /* with measured traffic streams on screen (netscene_traffic.js) the
           overview's traffic story is the streams: the physical trunks step
           back to quiet structure there, and come back up at a close-up */
        U.opa.value = 0.72 * lf * (1 - 0.6 * trafficOverK());
        /* Flow amplitude is the child's own MEASURED rates. If the child was
           never measured both stay 0 and the trunk simply does not flow -
           the link still shows its throughput colour, it just does not invent
           a direction it cannot see. */
        if (known) {
          U.dn.value = bpsNorm(child.rx);
          U.up.value = bpsNorm(child.tx);
        } else { U.dn.value = 0; U.up.value = 0; }
        L.mesh.visible = lf > 0.02;
        L.mesh.userData.r = 0.38 + 1.5 * u;    // heavier links read wider (thin curves, 2026-10-07; was 0.6 + 2.8u)
        L.mesh.scale.x = L.mesh.scale.z = L.mesh.userData.r;
      } else if (L.set === 'line' && lineCol) {
        _cDim.setHex(PAL.leafDim); _cHot.setHex(PAL.leafHot);
        _cTmp.copy(_cDim).lerp(_cHot, u);
        if (sev > 0) _cTmp.lerp(sevColor(sev), sevMix(sev));
        _cTmp.multiplyScalar(lf * leafLenFade(L));
        for (var k = 0; k < 6; k += 3) { var o = L.vStart * 3 + k; lineCol[o] = _cTmp.r; lineCol[o + 1] = _cTmp.g; lineCol[o + 2] = _cTmp.b; }
      } else if (L.set === 'arc' && arcCol) {
        _cDim.setHex(0x27334e); _cHot.setHex(0xa9b4ff);
        _cTmp.copy(_cDim).lerp(_cHot, u);
        if (sev > 0) _cTmp.lerp(sevColor(sev), sevMix(sev));
        _cTmp.multiplyScalar(lf * leafLenFade(L));
        for (var k2 = 0; k2 < L.vCount; k2++) { var o2 = (L.vStart + k2) * 3; arcCol[o2] = _cTmp.r; arcCol[o2 + 1] = _cTmp.g; arcCol[o2 + 2] = _cTmp.b; }
      }
      if (L.lbl) L.lbl.userData.setText(known ? child.rx : 0, known ? child.tx : 0, !!known,
        child && child.meta ? child.meta.port : null);
    });
    if (NS.lineSet) NS.lineSet.geometry.attributes.color.needsUpdate = true;
    if (NS.arcSet) NS.arcSet.geometry.attributes.color.needsUpdate = true;
    if (NS.dashSet) {
      if (dashCol) { NS.dashSet.material.opacity = 1; NS.dashSet.geometry.attributes.color.needsUpdate = true; }
      else NS.dashSet.material.opacity = 0.75 * dashF;
    }
  }

  /* ============================ particles ============================ */
  var _pc = new THREE.Color();
  function allocParticles() {
    var slot = 0, rnd = mulberry32(9001);
    NS.links.forEach(function (L, li) {
      L.pStart = slot; L.pCount = 0;
      if (!L.measured) return;
      var child = NS.byId[L.childId];
      var down, up, neutral = false;
      if (child && child.measured && child.status !== 'down') { down = child.rx; up = child.tx; }
      else if (child && child.status === 'down') { return; }
      else { down = (L.data.bps || 0) / 2; up = (L.data.bps || 0) / 2; neutral = true; }
      slot = seed(L, li, down, +1, neutral ? 0x8fb0d0 : PAL.cyan, slot, rnd, neutral);
      slot = seed(L, li, up, -1, neutral ? 0x8fb0d0 : PAL.magenta, slot, rnd, neutral);
      L.pCount = slot - L.pStart;
    });
    NS.pActive = slot;
    NS.pGeo.setDrawRange(0, slot);
    applyParticleFocus();
  }

  /* additive particles vanish when multiplied to black, so out-of-focus
     links keep their pool slots but emit nothing during tour close-ups */
  /* 0 without measured streams; the overview fraction (NS.overK) with them */
  function trafficOverK() {
    if (!(NS.T && NS.T.active && NS.T.active())) return 0;
    var TR = NS.tour, st = TR && TR.stops && TR.stops[(TR.phase === 'travel' && TR.switched) ? TR.next : TR.idx];
    if (st && st.stream) return 1;                       // the stream stop is about the stream, like the overview
    return NS.overK === undefined ? 1 : NS.overK;
  }
  function applyParticleFocus() {
    var n = NS.pActive, td = 1 - 0.85 * trafficOverK();
    for (var s = 0; s < n; s++) {
      var L = NS.links[NS.pLink[s]];
      var f = (L && L._lf !== undefined ? L._lf : 1) * td;
      if (L && !L.trunk && uni()) f *= Math.min(1, leafLenFade(L) * 1.6);   // leaf flows follow their quiet spokes
      NS.pCol[s * 3] = NS.pBase[s * 3] * f;
      NS.pCol[s * 3 + 1] = NS.pBase[s * 3 + 1] * f;
      NS.pCol[s * 3 + 2] = NS.pBase[s * 3 + 2] * f;
    }
    NS.pGeo.attributes.color.needsUpdate = true;
  }
  function seed(L, li, bps, dir, colHex, slot, rnd, neutral) {
    var u = bpsNorm(bps);
    if (u <= 0) return slot;
    var max = L.trunk ? TRUNK_MAXP : LEAF_MAXP;
    var n = Math.max(1, Math.round(u * max));
    if (neutral) n = Math.max(1, n >> 1);
    /* laps/s, capped (motion.js FLOW_LAPS_MAX): a short arc used to run its
       particles at whatever 290/len came to - several laps a second */
    var rate = window.NB_MOTION ? NB_MOTION.flowLaps(u, L.len) : Math.min(0.6, (50 + 240 * u) / L.len);
    _pc.setHex(colHex).multiplyScalar(0.55 + 0.45 * u);
    for (var i = 0; i < n && slot < P_CAP; i++, slot++) {
      NS.pLink[slot] = li; NS.pDir[slot] = dir;
      NS.pProg[slot] = (i / n + rnd() * 0.9 / n) % 1;
      NS.pRate[slot] = rate;
      NS.pBase[slot * 3] = _pc.r; NS.pBase[slot * 3 + 1] = _pc.g; NS.pBase[slot * 3 + 2] = _pc.b;
    }
    return slot;
  }

  function tickParticles(dt) {
    var n = NS.pActive; if (!n) return;
    var P = NS.pPos, links = NS.links;
    for (var s = 0; s < n; s++) {
      var L = links[NS.pLink[s]];
      var pr = NS.pProg[s] + NS.pRate[s] * dt;
      if (pr >= 1) pr -= Math.floor(pr);
      NS.pProg[s] = pr;
      var t = NS.pDir[s] > 0 ? pr : 1 - pr;
      var x, y, z;
      if (L.peak) {
        var u2 = 1 - t, mx = (L.ax + L.bx) / 2, my = (L.ay + L.by) / 2 + L.peak, mz = (L.az + L.bz) / 2;
        x = u2 * u2 * L.ax + 2 * u2 * t * mx + t * t * L.bx;
        y = u2 * u2 * L.ay + 2 * u2 * t * my + t * t * L.by;
        z = u2 * u2 * L.az + 2 * u2 * t * mz + t * t * L.bz;
      } else {
        x = L.ax + (L.bx - L.ax) * t; y = L.ay + (L.by - L.ay) * t; z = L.az + (L.bz - L.az) * t;
      }
      var lane = NS.pDir[s] * LANE;
      P[s * 3] = x + L.px * lane; P[s * 3 + 1] = y + 0.8; P[s * 3 + 2] = z + L.pz * lane;
      /* direction of travel (chord direction is close enough for a 6-unit
         comet; arcs use the bezier tangent) */
      var V = NS.pVel, sg = NS.pDir[s], vx, vy, vz;
      if (L.peak) {
        var mx2 = (L.ax + L.bx) / 2, my2 = (L.ay + L.by) / 2 + L.peak, mz2 = (L.az + L.bz) / 2;
        vx = 2 * (1 - t) * (mx2 - L.ax) + 2 * t * (L.bx - mx2);
        vy = 2 * (1 - t) * (my2 - L.ay) + 2 * t * (L.by - my2);
        vz = 2 * (1 - t) * (mz2 - L.az) + 2 * t * (L.bz - mz2);
      } else { vx = L.bx - L.ax; vy = L.by - L.ay; vz = L.bz - L.az; }
      var il = sg / Math.max(1e-3, Math.sqrt(vx * vx + vy * vy + vz * vz));
      V[s * 3] = vx * il; V[s * 3 + 1] = vy * il; V[s * 3 + 2] = vz * il;
    }
    NS.pGeo.attributes.position.needsUpdate = true;
    if (NS.pGeo.attributes.aVel) NS.pGeo.attributes.aVel.needsUpdate = true;
    if (NS.flowTex && NS.pPts.material.uniforms) NS.pPts.material.uniforms.uScale.value = (window.NB_RS ? NB_RS.ptH : NS.rndr.getContext().drawingBufferHeight) / 2;
  }

  /* ============================ node transform sync (tween) ============================ */
  function syncNodeTransforms(alpha) {
    var touchedG = false, touchedC = false;
    var ex = NS.explode || 0, exY = NS.explodeY || 90;
    NS.nodes.forEach(function (n) {
      var sp = n._sprd || 0;
      var tx = n._x + (sp ? sp * SPR_L * (n._x - n._bcx) : 0);
      var ty = n._y + (sp ? sp * SPR_V * (n._y - n._bcy) : 0);
      var tz = n._z + (sp ? sp * SPR_L * (n._z - n._bcz) : 0);
      /* exploded view: guests rise, clients sink, the infra tier stays - the
         links are re-stretched by updateLinkGeometry(true) so they follow */
      if (ex) ty += ex * (n.kind === 'guest' ? exY : n.kind === 'client' ? -0.7 * exY : 0);
      n._cx += (tx - n._cx) * alpha; n._cy += (ty - n._cy) * alpha; n._cz += (tz - n._cz) * alpha;
      if (n._grp) n._grp.position.set(n._cx, n._cy, n._cz);
      if (n._lbl) n._lbl.position.set(n._cx, n._cy + (n.kind === 'external' ? -((n._h || 8) + 22)
        : (!n._grp && uni()) ? (n._lflip ? -17 : 17)   // clear of the (bigger) atlas body + its wobble; a switch name crowded above tries below
        : ((n._h || 4) + (n._grp ? 18 : 5.5) + 5.5 * (n._lstag || 0))), n._cz);
      if (n._inst) {
        // load-driven size (guestScale) x tour focus (0 = shrunk away)
        var sc = (n._scl || 1) * (n._foc === undefined ? 1 : n._foc);
        if (sc < 0.002) sc = 0.002;
        NS.tmpM.makeScale(sc, sc, sc);
        NS.tmpM.setPosition(n._cx, n._cy, n._cz);
        n._inst.im.setMatrixAt(n._inst.i, NS.tmpM);
        if (n._inst.im === NS.guestIM) touchedG = true; else touchedC = true;
      }
    });
    if (touchedG && NS.guestIM) NS.guestIM.instanceMatrix.needsUpdate = true;
    if (touchedC && NS.clientIM) NS.clientIM.instanceMatrix.needsUpdate = true;
  }

  /* ============================ auto-tour ============================ */
  /* The HUD has promised "AUTO-TOUR" since day one; this makes it true.
     Cycle: overview -> WAN edge -> switch fabric -> wireless -> overview ->
     each PVE host -> each guest category block -> loop.
     At a focused stop everything OUTSIDE the stop fades out and shrinks
     away: a close-up that kept the rest of the graph on screen would smear
     it under the HUD panels (the clipped-corner complaint, three times).
     Per transition: hold -> depart IMMEDIATELY (no parked fade: that put a
     near-empty frame on screen for ~1 s, which reads as the screen breaking
     on video) -> travel 3.6-8 s with the UNION of both stops materialised
     (the outgoing subject recedes while the incoming one grows) -> halfway
     through the flight the frame is handed over to the destination alone ->
     arrive slightly wide and push in (settle) while holding.
     Stop distances are computed so the stop's own content INCLUDING label
     sprite extents fits the same viewport fractions as the overview fit
     (0.664 / 0.591, calibrated against the HUD-safe region), plus the
     near-face depth term. MANUAL_HOLD is untouched: pointer/wheel input
     pauses the tour and restores the full graph; after 25 s idle the tour
     flies home to the overview and resumes. */
  var TP = { pos: null, tgt: null };

  /* close-up "exploded view": at a single-block stop the guests spread out
     from their block centroid so 17 labels stop fighting for 3 columns */
  var SPR_L = 0.6, SPR_V = 0.35;              // extra lateral / vertical spread

  /* FOCUS IS A CROSSFADE (2026-10-05, round 4). Round two lit the WHOLE estate
     for every flight (universe mode) and narrowed it again at the midpoint, so
     every move read dim -> bright -> dim: the "flash before it moves". Now a
     flight is a leg A -> B and each node's focus is a pure function of the
     travel progress s (the same smootherstep the dolly uses):
         f(n) = fA(n) + (fB(n) - fA(n)) * s,   fX(n) = 1 in stop X, else floor
     - off-subject estate: floor -> floor, constant, never jumps
     - outgoing subject:   1 -> floor, eased down across the travel
     - incoming subject:   floor -> 1, eased up across the travel
     - overview (ids null) is "every node in" on its side of the leg.
     NS.overK is the same crossfade of "is this the overview" (0..1), for the
     few things that used to switch on the focusAll boolean (disc art opacity,
     body px floor, bloom density, spoke boost). NS.focusAll / focusIds still
     hand over at the midpoint for consumers that need a discrete answer
     (label regime, hot callouts, exosphere fold, universe stop membership). */
  var NS_FOC = { a: null, b: null, s: 1, live: false };
  function focFloor() { return uni() ? FOC_FLOOR_UNI : FOC_FLOOR; }
  function focIn(ids, id, id2) { return !ids || !!ids[id] || (id2 !== undefined && !!ids[id2]); }
  /* focus of any keyed thing under the current leg; netscene_universe.js uses it
     for bodies with no topology node ('u:<body id>' keys) */
  function focusOf(id, id2) {
    var L = NS_FOC, fl = focFloor();
    var a = focIn(L.a, id, id2) ? 1 : fl, b = focIn(L.b, id, id2) ? 1 : fl;
    return a + (b - a) * L.s;
  }
  function legOverK() { var L = NS_FOC; return (L.a ? 0 : 1) + ((L.b ? 0 : 1) - (L.a ? 0 : 1)) * L.s; }

  function setFocus(ids, spreadIds) {         // ids: {nodeId:1} or null = all
    NS_FOC.a = NS_FOC.b = ids || null; NS_FOC.s = 1; NS_FOC.live = false;
    NS.focusAll = !ids;
    NS.focusIds = ids || null;                // netscene_universe.js reads this ('u:<body id>' keys too)
    NS.focusSeq = (NS.focusSeq || 0) + 1;
    NS.nodes.forEach(function (n) {
      n._focT = (!ids || ids[n.id]) ? 1 : focFloor();
      n._sprdT = (spreadIds && spreadIds[n.id] && n._bcx !== undefined) ? 1 : 0;
    });
    NS.focusAnim = true;
    if (NS.focusAll === false && NS.hotLabels) {
      for (var i = 0; i < NS.hotLabels.length; i++) {
        NS.hotLabels[i].visible = false;
        if (NS.hotLeaders && NS.hotLeaders[i]) NS.hotLeaders[i].visible = false;
      }
    }
  }
  /* departure: start a crossfade leg from stop a to stop b. The discrete
     focusAll/focusIds keep describing the stop we are leaving until the
     midpoint handover (setLegHandover). */
  function setFocusLeg(a, b, spreadIds) {
    NS_FOC.a = a.ids || null; NS_FOC.b = b.ids || null; NS_FOC.s = 0; NS_FOC.live = true;
    NS.focusSeq = (NS.focusSeq || 0) + 1;
    NS.nodes.forEach(function (n) {
      n._focT = focusOf(n.id);
      n._sprdT = (spreadIds && spreadIds[n.id] && n._bcx !== undefined) ? 1 : 0;
    });
    NS.focusAnim = true;
  }
  function setLegProgress(s) {
    NS_FOC.s = s;
    for (var i = 0; i < NS.nodes.length; i++) { var n = NS.nodes[i]; n._focT = focusOf(n.id); }
    NS.focusAnim = true;
  }
  function setLegHandover(b) {
    NS.focusAll = !b.ids;
    NS.focusIds = b.ids || null;
    NS.focusSeq = (NS.focusSeq || 0) + 1;
    if (NS.focusAll === false && NS.hotLabels) {
      for (var i = 0; i < NS.hotLabels.length; i++) {
        NS.hotLabels[i].visible = false;
        if (NS.hotLeaders && NS.hotLeaders[i]) NS.hotLeaders[i].visible = false;
      }
    }
  }

  function stopSpread(st) { return st.spread ? st.ids : null; }
  function unionSpread(a, b) {
    var sa = stopSpread(a), sb = stopSpread(b);
    if (!sa) return sb;
    if (!sb) return sa;
    var f = {}, k;
    for (k in sa) f[k] = 1;
    for (k in sb) f[k] = 1;
    return f;
  }
  /* re-apply a focus with no fade (used after a graph rebuild, where a slow
     fade would flash hidden content into a close-up frame) */
  function forceFocus(ids, spreadIds) {
    setFocus(ids, spreadIds);
    NS.nodes.forEach(function (n) { n._foc = n._focT; n._sprd = n._sprdT || 0; });
    NS.focusAnim = true;              // one focusTick pass applies the visuals
  }
  function forceLeg(a, b, s, switched) {
    setFocusLeg(a, b, unionSpread(a, b));
    setLegProgress(s);
    /* 2026-10-07: the discrete focus must describe the stop being LEFT until
       the midpoint. rebuildGraph() resets focusAll to true, and this used to
       leave it there for a rebuild in the first half of a leg - so every
       overview-only layer (all flow arcs, the hot callouts) burst onto a
       close-up for a second: the "web of arcs" flash seen on video. */
    setLegHandover(switched ? b : a);
    NS.nodes.forEach(function (n) { n._foc = n._focT; n._sprd = n._sprdT || 0; });
  }

  function focusTick(dt) {
    NS.overK = legOverK();
    if (!NS.focusAnim) return;
    /* in a leg the target already moves smoothly (smootherstep of the travel),
       so follow it closely; outside one (arrival, manual, rebuild) the old
       gentle ease */
    var a = 1 - Math.exp(-dt * (NS_FOC.live ? 14.0 : 4.0)), moving = NS_FOC.live ? 1 : 0;
    NS.nodes.forEach(function (n) {
      var tgt = n._focT === undefined ? 1 : n._focT;
      var f0 = n._foc === undefined ? 1 : n._foc;
      var f = f0 + (tgt - f0) * a;
      if (Math.abs(f - tgt) < 0.004) f = tgt; else moving++;
      n._foc = f;
      var st = n._sprdT || 0, s0 = n._sprd || 0, sp = s0 + (st - s0) * a;
      if (Math.abs(sp - st) < 0.01) sp = st; else moving++;
      n._sprd = sp;
      if (n._grp) {
        n._grp.visible = f > 0.02;
        var sc = Math.max(0.001, f);
        n._grp.scale.set(sc, sc, sc);
      }
    });
    syncNodeTransforms(1 - Math.exp(-dt * 4.5));
    updateLinkGeometry(true);
    restyleLinks();
    applyParticleFocus();
    if (!moving) NS.focusAnim = false;
  }

  /* frame a stop: bbox of its nodes + label extents -> camera distance */
  function mkStop(name, list, az, zoom, spread, el) {
    var st = { name: name, az: az || 0, el: el || CAM_EL, list: list, ids: {}, spread: !!spread };
    var bb = new THREE.Box3();
    list.forEach(function (n) {
      st.ids[n.id] = 1;
      var x = n._x, y = n._y, z = n._z;
      if (spread && n._bcx !== undefined) {         // exploded-view positions
        x += SPR_L * (x - n._bcx); y += SPR_V * (y - n._bcy); z += SPR_L * (z - n._bcz);
      }
      var lw, yTop, yBot = 10;
      if (n.kind === 'guest' || n.kind === 'client') { lw = 30; yTop = 46; }
      else if (n.kind === 'external') { lw = 46; yTop = 16; yBot = 40; }
      else { lw = (n.kind === 'wan' || n.kind === 'gateway') ? 68 : 62; yTop = (n._h || 8) + 34; }
      bb.expandByPoint(NS.tmpV.set(x - lw, y - yBot, z - lw));
      bb.expandByPoint(NS.tmpV.set(x + lw, y + yTop, z + lw));
    });
    st.c = bb.getCenter(new THREE.Vector3());
    var ex = (bb.max.x - bb.min.x) / 2, ey = (bb.max.y - bb.min.y) / 2, ez = (bb.max.z - bb.min.z) / 2;
    var vf = NS.cam.fov * Math.PI / 360, ta = Math.tan(vf) * NS.cam.aspect;
    var w = 0, dep = 0;
    for (var i = -2; i <= 2; i++) {
      var a2 = st.az + i * (T_SWAY + 0.03) / 2;
      w = Math.max(w, ex * Math.abs(Math.cos(a2)) + ez * Math.abs(Math.sin(a2)));
      dep = Math.max(dep, ex * Math.abs(Math.sin(a2)) + ez * Math.abs(Math.cos(a2)));
    }
    var dH = w / (ta * FRAC_X) + dep;
    var dV = (dep * Math.sin(st.el) + ey * Math.cos(st.el)) / (Math.tan(vf) * FRAC_Y) + dep;
    /* the analytic bound stacks worst cases (label pads at the near face at
       worst sway) and lands ~2x too far; zoom is the measured correction per
       stop type, verified by the per-stop subject sweep */
    st.dist = Math.max(Math.max(dH, dV, 240) * 1.06 * (zoom || 1) * ECO_WIDE, 165);
    return st;
  }

  function buildTour() {
    var K = {};
    NS.nodes.forEach(function (n) { (K[n.kind] = K[n.kind] || []).push(n); });
    Object.keys(K).forEach(function (k) {
      K[k].sort(function (a, b) { return a.id < b.id ? -1 : 1; });
    });
    var wan = (K.wan || [])[0], gw = (K.gateway || [])[0];
    function key(st, k) { st.key = k; return st; }
    var stops = [key({ name: 'Overview', ids: null }, 'over:0')];
    /* the WAN stop also frames the exosphere envelope (external beacons, Cloudflare
       station) when netscene_exo.js is present; pseudo-nodes carry only a position */
    var exo = NS.exoStopNodes ? NS.exoStopNodes() : [];
    if (wan || gw) stops.push(key(mkStop('Internet edge', [wan, gw].filter(Boolean).concat(exo), -0.5, exo.length ? 0.56 : 0.62, false, 0.46), 'wan'));
    /* switch fabric; small wired groups (<3 clients) ride along */
    var fab = [gw].concat(K.switch || [], K.pvehost || []).filter(Boolean);
    var wired = [];
    [gw].concat(K.switch || []).filter(Boolean).forEach(function (sw) {
      if (sw._clientBlock) wired.push(sw);
      else (K.client || []).forEach(function (c) { if (c.parent === sw.id) fab.push(c); });
    });
    if (uni()) {
      /* the hosts now sit beyond their own galaxy discs, so a fabric stop that
         framed gateway -> hosts was a 1400-unit wide shot of empty space.
         Frame the core (gateway, switches, APs and the core system's own
         devices); the trunks run on out of frame toward the hosts, which get
         their own stops. Key stays 'fabric' for the TV and the lights. */
      var coreSys = gw ? uni().sysOfAnchor(gw.id) : null;
      var core = [gw].concat(K.switch || [], K.ap || []).filter(Boolean);
      if (coreSys) NS.nodes.forEach(function (n) { if (n._ub && uni().sysOf(n._ub) === coreSys) core.push(n); });
      if (core.length > 1) {
        /* round 5: frame the UDM's own system. Framing the switch (home hub) and
           the AP as well made a ~1400 u wide shot in which the 14 core devices
           were one knot whose names all collided. Switch + AP stay in focus
           (lit); their trunks run out of frame like the host trunks do. */
        var frameL = coreSys ? core.filter(function (n) { return n === gw || (n._ub && uni().sysOf(n._ub) === coreSys) || n.kind === 'switch'; }) : core;
        if (frameL.length < 3) frameL = core;
        var cst = key(withExtras(mkStop('Network core', frameL, -0.15, frameL === core ? 0.70 : 0.95, false, 0.70), coreSys), 'fabric');
        core.forEach(function (n) { cst.ids[n.id] = 1; });
        if (coreSys) cst.sysId = coreSys.id;
        stops.push(cst);
      }
      buildUniverseStops(stops, key, coreSys);
      aspectStops(stops);
      streamStop(stops, key);
      return finishTour(stops);
    }
    if ((K.switch || []).length > 0) stops.push(key(mkStop('Network core', fab, -0.15, 0.72, false, 0.68), 'fabric'));
    /* wired client blocks: framed alone (their switch sits hundreds of units
       away — including it turns the stop into an unreadable wide shot; the
       block's caption names the switch instead) */
    wired.forEach(function (sw) {
      stops.push(key(mkStop((shortName(sw.label || sw.id) || 'Switch') + ' wired clients',
                            sw._clientBlock, -0.3, 0.62, true, 0.55), 'wired:' + sw.id));
    });
    (K.ap || []).forEach(function (ap) {
      var cl = (K.client || []).filter(function (c) { return c.parent === ap.id; });
      if (cl.length) stops.push(key(mkStop((shortName(ap.label || 'AP') || 'AP') + ' wireless clients', [ap].concat(cl), 0.35, 0.78, false, 0.40), 'ap:' + ap.id));
    });
    stops.push(key({ name: 'Overview', ids: null }, 'over:1'));
    (K.pvehost || []).forEach(function (h) {
      var blocks = h._tourBlocks || [], total = 0;
      blocks.forEach(function (B) { total += B.list.length; });
      /* the tour names a Proxmox node the way the operator named it
         (CONFIG.nodes[].label), else the server's short name, else the raw id */
      var Cnd = C().nodeById ? C().nodeById(h.id) : null;
      var hn = (Cnd && Cnd.label) || shortName(h.label || h.id) || h.id;
      if (total && total <= 9) {
        var lst = [h];
        blocks.forEach(function (B) { lst = lst.concat(B.list); });
        stops.push(key(mkStop(hn, lst, 1.15, 0.58, false, 0.52), 'host:' + h.id));
      } else {
        blocks.forEach(function (B) {
          stops.push(key(mkStop(hn + ' \u00b7 ' + (CAT_TITLE[B.cat] || B.cat), B.list, 1.05, 0.66, true, 0.70),
                     'blk:' + h.id + ':' + B.cat));
        });
      }
    });
    finishTour(stops);
  }

  /* universe mode tour: one stop per system galaxy (whole disc), then, for a
     big PVE system, one stop per guest category - the camera circles the
     galaxy while each category lights up inside it. Stop KEYS keep the
     formats the TV (nexus.js parseStop), galaxy.js and netscene_exo.js
     already parse: host:pve:<n>, blk:pve:<n>:<cat>, wired:<switch id>,
     ap:<ap id>; anything else is sys:<system id> (TV falls back to overview). */
  function buildUniverseStops(stops, key, skipSys) {
    var U = uni(), pve = [], other = [];
    (U.systems || []).forEach(function (sy) {
      var hub = NS.byId[sy.anchor];
      if (!hub || sy === skipSys) return;
      var mem = NS.nodes.filter(function (n) { return n._ub && U.sysOf(n._ub) === sy; });
      if (mem.length + 1 < 3) return;
      (hub.kind === 'pvehost' ? pve : other).push({ sy: sy, hub: hub, mem: mem });
    });
    other.forEach(function (o) {
      var sid = String(o.sy.id).replace(/^sys:/, '');
      var k = o.hub.kind === 'switch' ? 'wired:' + o.hub.id : o.hub.kind === 'ap' ? 'ap:' + o.hub.id : 'sys:' + sid;
      /* a big, sparse system (home: 31 devices over R~370) read empty at the
         generic 0.66 zoom; frame it tighter, the label floor keeps names legible */
      /* a remote site is framed from the Internet side, looking back in: the
         estate's galaxies glow behind it instead of empty sky */
      var oz = (o.sy.R || 0) > 300 ? 0.54 : o.sy.kind === 'site' ? 0.42 : 0.66;
      var ost = key(withExtras(mkStop(sysName(o.sy),
                            [o.hub].concat(o.mem), o.sy.kind === 'site' ? -1.05 : 0.25, oz, false, 0.78), o.sy), k);
      ost.sysId = o.sy.id; stops.push(ost);
    });
    stops.push(key({ name: 'Overview', ids: null }, 'over:1'));
    pve.forEach(function (o) {
      var hn = sysName(o.sy) || String(o.hub.label || o.hub.id);
      var hst = key(withExtras(mkStop(hn, [o.hub].concat(o.mem), 0.2, 0.78, false, 0.82), o.sy),
                     'host:' + o.hub.id);
      hst.sysId = o.sy.id; stops.push(hst);
      if (o.mem.length <= 9) return;
      var byCat = {};
      o.mem.forEach(function (n) { var c = (n.meta && n.meta.cat) || 'infra'; (byCat[c] = byCat[c] || []).push(n); });
      var cats = Object.keys(byCat).filter(function (c) { return byCat[c].length >= 3; })
        .sort(function (a, b) { return (byCat[b].length - byCat[a].length) || (a < b ? -1 : 1); });
      /* the complete tour (contracts 9.2): with the aspect stops in, a lap keeps
         to ~3 min by keeping only the busiest categories per host (measured
         traffic first, then size); without /api/tour the tour is unchanged */
      if (tourAspects().length && cats.length > BLK_KEEP) {
        var busy = function (c) { var s = 0; byCat[c].forEach(function (n) { s += (+n.rx || 0) + (+n.tx || 0); }); return s; };
        var keep = cats.slice().sort(function (a, b) { return (busy(b) - busy(a)) || (byCat[b].length - byCat[a].length) || (a < b ? -1 : 1); }).slice(0, BLK_KEEP);
        cats = cats.filter(function (c) { return keep.indexOf(c) >= 0; });
      }
      cats.forEach(function (c, i) {
        var az = cats.length > 1 ? -0.35 + 1.4 * i / (cats.length - 1) : 0.3;
        /* sectored host (presentGroups): look at the category from its own
           side, so the sector sits in the foreground with the hub behind it */
        var sec = ((U.groups && U.groups[o.sy.id]) || []).filter(function (q) { return q.kind === 'sector' && q.key === c; })[0];
        if (sec) az = Math.PI / 2 - ((sec.a0 + sec.a1) / 2 + (sec.twist || 0) * 0.5);
        /* frame the category's members but keep the hub in shot for context */
        var bst;
        if (sec) {
          /* the arm in context: frame the whole galaxy a little tighter than
             the host stop, from the arm's side, and light only the arm */
          bst = mkStop(hn + ' \u00b7 ' + (CAT_TITLE[c] || c), [o.hub].concat(o.mem), az, 0.66, false, 0.80);
          bst.ids = {}; bst.ids[o.hub.id] = 1; byCat[c].forEach(function (n) { bst.ids[n.id] = 1; });
          bst.list = [o.hub].concat(byCat[c]);
        } else bst = mkStop(hn + ' \u00b7 ' + (CAT_TITLE[c] || c), [o.hub].concat(byCat[c]), az, 0.70, false, 0.74);
        stops.push(key(bst, 'blk:' + o.hub.id + ':' + c));
      });
    });
  }

  /* FOLLOW THE STREAM (2026-10-08): one stop per lap rides the strongest
     MEASURED system-to-system stream (netscene_traffic.js), from the galaxy it
     leaves toward the one it reaches - Noah's "zoom along one strong arc".
     It is an ordinary stop for the protocol (its own arrival beat, its own
     key and name; the TV and the lights follow it like any other), placed
     right after the source galaxy's stops so the ride continues the story.
     No measured stream, or a weak one: no stop. */
  var T_HOLD_STREAM = 3.8, STREAM_MIN_BPS = 50000;
  function streamStop(stops, key) {
    var T = NS.T, s = T && T.strongest ? T.strongest() : null, U = uni();
    if (!s || !U || !(s.bps >= STREAM_MIN_BPS)) return;
    var syA = U.sysById[s.from], syB = U.sysById[s.to];
    if (!syA || !syB) return;
    var hA = NS.byId[syA.anchor], hB = NS.byId[syB.anchor];
    if (!hA || !hB) return;
    var list = [hA, hB];
    var st = mkStop(sysName(syA) + ' \u2192 ' + sysName(syB), list, 0, 0.9, false, 0.55);
    st.ids = {}; st.ids[hA.id] = 1; st.ids[hB.id] = 1;
    NS.nodes.forEach(function (n) { if (n._ub && (U.sysOf(n._ub) === syA || U.sysOf(n._ub) === syB)) st.ids[n.id] = 1; });
    withExtras(st, syA); withExtras(st, syB);
    st.stream = { a: s.a, b: s.b, from: s.from, to: s.to, bps: s.bps, kind: s.kind, sampled: s.sampled, lb: s.lb, dir: s.dir };
    st.hold = T_HOLD_STREAM;
    key(st, 'stream:' + String(s.from).replace(/^sys:/, '') + '>' + String(s.to).replace(/^sys:/, ''));
    var at = -1;
    for (var i = 0; i < stops.length; i++) {
      var k = stops[i].key || '';
      if (stops[i].sysId === s.from || k.indexOf('blk:' + syA.anchor + ':') === 0) at = i;
    }
    if (at < 0) for (var j = 0; j < stops.length; j++) if (stops[j].key === 'over:1') at = j;
    stops.splice(at >= 0 ? at + 1 : stops.length, 0, st);
  }
  /* ---- THE COMPLETE TOUR (2026-10-10, contracts 9.1 / 9.2) ----------------
     /api/tour lists one "aspect" per monitored subject (internet, security,
     websites, Wi-Fi, storage, power, monitoring, AI, cameras, media), each with
     an anchor body and the stop it follows. Each becomes an ordinary stop for
     the protocol: key = the aspect key (asp:*), name = the aspect name, hold
     T_HOLD_ASP; the camera pushes in on the anchor with its galaxy's core in
     frame behind it, and cinema.js turns the caption into the aspect card.
     404 / empty / malformed: no aspect stops, the tour is exactly as before. */
  var T_HOLD_ASP = 3.2, BLK_KEEP = 3, TOUR_POLL_MS = 30000;
  /* aspect framing: camera on the star's side of the subject, swung `rot` off
     the subject->core line (planets star-lit, ~2/3 phase), look point pulled
     `lerp` toward the core so the core rides in at the frame's side */
  var ASP_TUNE = { rot: 1.25, el: 0.45, k: 1.35, base: 80, min: 150, max: 460, lerp: 0.22 };
  function tourAspects() {
    var d = NS && NS.tourData, a = d && Array.isArray(d.aspects) ? d.aspects : [];
    return a.filter(function (x) { return x && typeof x.key === 'string' && x.key.indexOf('asp:') === 0 && x.name; });
  }
  function aspectOf(key) {          // the freshest copy of an aspect (cinema.js caption: NS.aspectOf)
    var a = tourAspects();
    for (var i = 0; i < a.length; i++) if (a[i].key === key) return a[i];
    return null;
  }
  function tourDataPoll() {
    var sig = '', fails = 0;
    function resig() {
      var s = tourAspects().map(function (a) { return a.key + '@' + a.anchor + '>' + a.after; }).join('|');
      if (s !== sig) { sig = s; NS.tourDirty = true; }
    }
    function once() {
      /* facts and ts change on every poll and are read in place (NS.aspectOf); the
         tour is re-planned only when the SET / ORDER of aspects or an anchor / after
         changes. A failed poll keeps the last good copy (a blip must not drop the
         aspect stops mid-lap); three in a row, or a 404, retire it. */
      fetch('/api/tour', { cache: 'no-store' }).then(function (r) {
        if (r.status === 404) return { gone: true };
        return r.ok ? r.json() : null;
      }).then(function (j) {
        var ok = j && typeof j === 'object' && !j.gone;
        fails = ok ? 0 : fails + 1;
        if (ok) NS.tourData = j;
        else if ((j && j.gone) || fails >= 3) NS.tourData = null;
        resig();
      }).catch(function () { fails++; if (fails >= 3) { NS.tourData = null; resig(); } })
        .then(function () { setTimeout(once, fails > 2 ? 4 * TOUR_POLL_MS : TOUR_POLL_MS); });
    }
    once();
  }
  /* the anchor's world position: its topology node, else the instanced body */
  function aspectPos(b) {
    var n = b.topo && NS.byId[b.topo];
    if (n && n._x !== undefined) return { n: n, p: new THREE.Vector3(n._x, n._y, n._z) };
    var w = window.NETUNI && NETUNI.worldOf ? NETUNI.worldOf(b.id) : null;
    if (w) return { n: null, p: new THREE.Vector3(w[0], w[1], w[2]) };
    /* an edge body drawn by the exosphere, not the registry (the Cloudflare
       station sits at the WAN + (22, 62, -26), netscene_exo.js) */
    var wn = b['class'] === 'edge' && NS.byId.wan;
    if (wn) return { n: /cloudflare/i.test(b.id + ' ' + b.label) ? null : wn,
                     p: new THREE.Vector3(wn._x, wn._y, wn._z).add(/cloudflare/i.test(b.id + ' ' + b.label) ? new THREE.Vector3(22, 62, -26) : new THREE.Vector3()) };
    return null;
  }
  function aspectStops(stops) {
    var A = tourAspects(), U = uni();
    if (!A.length || !U) return;
    var wanSt = null, after = {}, i, j;
    for (i = 0; i < stops.length; i++) if (stops[i].key === 'wan') wanSt = stops[i];
    var made = 0;
    var grp = {};
    A.forEach(function (a) {
      /* the camera's variant by position inside its `after` group, so siblings
         (AI / cameras / media all live in the GPU galaxy) never repeat a frame */
      var gi = grp[a.after] = (grp[a.after] === undefined ? 0 : grp[a.after] + 1);
      var st = aspectStop(a, U, wanSt, gi);
      if (!st) return;
      /* after its `after` stop, behind any aspect already placed there (listed
         order kept); `after` absent: just before the lap closes */
      var at = -1;
      if (after[a.after] !== undefined) at = after[a.after];
      else for (j = 0; j < stops.length; j++) if (stops[j].key === a.after) { at = j; break; }
      if (at < 0) { stops.push(st); return; }
      stops.splice(at + 1, 0, st);
      for (var k in after) if (after[k] > at) after[k]++;
      after[a.after] = at + 1;
      made++;
    });
    NS.tourAspectsN = made;
  }
  function aspectStop(a, U, wanSt, ai) {
    var anc = String(a.anchor || ''), b = null, sy = null, hub = null, st;
    if (anc.indexOf('sys:') === 0) sy = U.sysById[anc] || null;
    else { b = U.byId[anc] || null; if (b) sy = U.sysOf(b); }
    if (sy) hub = NS.byId[sy.anchor] || null;
    var side = ai % 2 ? -1 : 1, v3 = ai % 3 === 2;
    var mem = sy ? NS.nodes.filter(function (n) { return n._ub && U.sysOf(n._ub) === sy; }) : [];
    var ids = {};
    if (hub) ids[hub.id] = 1;
    mem.forEach(function (n) { ids[n.id] = 1; });
    var AP = b ? aspectPos(b) : null;
    if (!AP && !hub && !(wanSt && b && b['class'] === 'edge')) {
      if (!b || !sy) return null;
    }
    if (!AP && hub) b = null;                     // anchor missing: the system it belongs to
    if (!b && hub) {
      /* a whole system: its galaxy, framed like the host stop but from the side */
      st = mkStop(sysName(sy), [hub].concat(mem), 0.2 + 0.5 * side, 0.72, false, 0.70);
      st.ids = ids;
    } else if (b && !sy && wanSt) {
      /* an edge body (the Internet, Cloudflare): from the WAN stop's side, the
         estate's galaxies glowing behind it */
      if (!AP) return null;
      st = { list: wanSt.list, ids: wanSt.ids, spread: false };
      st.c = AP.p.clone();
      if (!AP.n) {
        /* the Cloudflare station: close, from the estate's side, low */
        st.az = (wanSt.az || -0.5) + 1.05; st.el = 0.26; st.dist = 170;
      } else {
        /* the Internet star with its exosphere of beacons around it */
        st.az = (wanSt.az || -0.5) - 0.4; st.el = 0.42;
        st.dist = Math.max(220, Math.min(560, (wanSt.dist || 600) * 0.5));
      }
    } else if (b && AP && hub) {
      var hp = new THREE.Vector3(hub._x, hub._y, hub._z), isHub = AP.n === hub || b.hub;
      if (AP.n) ids[AP.n.id] = 1; ids['u:' + b.id] = 1;
      st = { list: AP.n ? [AP.n] : [hub], ids: ids, spread: false };
      var R = sy.R || 200;
      if (isHub) {
        /* the star itself (power): a low, close push-in on the core, the
           disc's arms sweeping out around it */
        st.c = hp.clone(); st.az = 0.9 * side; st.el = 0.42;
        st.dist = Math.max(220, Math.min(560, R * 0.95));
      } else {
        /* the subject centred, its galaxy's core behind it and to one side: the
           camera stands out past the subject on the hub->subject line, swung a
           little so the core never hides behind the subject */
        var dx = AP.p.x - hp.x, dz = AP.p.z - hp.z, d = Math.sqrt(dx * dx + dz * dz) || 1, AT = ASP_TUNE;
        st.c = AP.p.clone().lerp(hp, AT.lerp);
        st.az = Math.atan2(-dx, -dz) + AT.rot * side * (v3 ? 0.55 : 1);
        st.el = v3 ? AT.el + 0.25 : AT.el;
        st.dist = Math.max(AT.min, Math.min(AT.max, AT.k * d + AT.base)) * (v3 ? 1.15 : 1);
        st.dbg = { d: Math.round(d), R: Math.round(R) };
      }
    } else return null;
    st.key = a.key; st.name = String(a.name);
    st.hold = T_HOLD_ASP; st.aspect = a.key;
    if (sy) { st.sysId = sy.id; withExtras(st, sy); }
    st.hubId = hub ? hub.id : (b && !sy ? 'wan' : null);
    /* the callout marks a planet or moon; a star (the power stop's host, the
       Internet) is its own subject */
    st.subj = b && sy && !b.hub && b['class'] !== 'pve_host' && !(AP && AP.n && AP.n === hub) ? { id: b.id, topo: b.topo || null } : null;
    st.edge = !!(b && !sy);
    return st;
  }

  /* re-plan the tour without disturbing it (finishTour resumes by key);
     refused while the stream stop is on screen or being flown to */
  function refreshTour() {
    if (!NS.nodes || !NS.nodes.length || !NS.graph) return false;
    var TR = NS.tour;
    if (TR && TR.stops && TR.stops.length) {
      var cur = TR.stops[TR.idx], nxt = TR.stops[TR.next];
      if ((cur && cur.stream) || (nxt && nxt.stream)) return false;
      if (TR.phase === 'travel') return false;
    }
    buildTour();
    return true;
  }
  /* bodies with no topology node (e.g. the SD-WAN cameras) are in focus at
     their system's whole-disc stop */
  function withExtras(st, sy) {
    if (!sy) return st;
    var ex = uni().extras ? uni().extras(sy) : [];
    for (var i = 0; i < ex.length; i++) st.ids['u:' + ex[i].id] = 1;
    return st;
  }

  function finishTour(stops) {
    var prev = NS.tour;
    NS.tour = { stops: stops, idx: 0, next: 0, phase: 'hold', t0: NS.t, tHold: NS.t,
                P0: new THREE.Vector3(), T0: new THREE.Vector3(), travelT: 5, manual: false,
                switched: true, arcH: 0 };
    /* a topology rebuild (clients come and go every few minutes) must not
       yank the tour back to the start — resume at the same named stop */
    if (prev && prev.stops.length) {
      var T = NS.tour, iCur = -1, iNxt = -1;
      var nCur = prev.stops[prev.idx] ? prev.stops[prev.idx].key : '';
      var nNxt = prev.stops[prev.next] ? prev.stops[prev.next].key : '';
      for (var i = 0; i < stops.length; i++) {
        if (stops[i].key === nCur && iCur < 0) iCur = i;
        if (stops[i].key === nNxt && iNxt < 0) iNxt = i;
      }
      if (iCur < 0 && !prev.manual) {
        /* the stop on screen left the plan (an aspect retired): hold where the lap
           was rather than jumping back to the opening overview */
        T.idx = T.next = Math.min(prev.idx, stops.length - 1); T.phase = 'hold'; T.t0 = T.tHold = NS.t;
        forceFocus(stops[T.idx].ids || null, stopSpread(stops[T.idx]));
      }
      if (iCur >= 0) {
        T.idx = iCur; T.phase = prev.phase; T.t0 = prev.t0; T.tHold = prev.tHold;
        T.next = iNxt >= 0 ? iNxt : (iCur + 1) % stops.length;
        T.P0.copy(prev.P0); T.T0.copy(prev.T0);
        T.travelT = prev.travelT; T.manual = prev.manual;
        T.switched = prev.switched; T.arcH = prev.arcH || 0;
        T.paused = !!prev.paused; T.pausedAt = prev.pausedAt || 0;   // a cinematic move in progress survives the rebuild
        T.move = prev.move; T.moveDir = prev.moveDir; T.leg = prev.leg;
        var here = stops[T.idx], there = stops[T.next];
        if (T.manual) forceFocus(null);
        else if (T.phase === 'hold') forceFocus(here.ids || null, stopSpread(here));
        else {
          var sR0 = Math.min(1, Math.max(0, (NS.t - T.t0) / (T.travelT || 1)));
          forceLeg(here, there, sR0 * sR0 * sR0 * (sR0 * (sR0 * 6 - 15) + 10), T.switched);
        }
      }
    }
  }

  /* the stream ride: a chase camera on the arc, behind and above the point it
     has reached, looking ahead along the stream toward the destination galaxy */
  var _rp = new THREE.Vector3(), _rq = new THREE.Vector3(), _rt = new THREE.Vector3(), _rs = new THREE.Vector3();
  function bez(a, out, t) { var u = 1 - t; return out.set(u * u * a[0].x + 2 * u * t * a[1].x + t * t * a[2].x, u * u * a[0].y + 2 * u * t * a[1].y + t * t * a[2].y, u * u * a[0].z + 2 * u * t * a[1].z + t * t * a[2].z); }
  function streamPose(st, e, pos, tgt) {
    var arc = NS.T && NS.T.arc ? NS.T.arc(st.stream.from, st.stream.to) : null;
    if (!arc) return false;
    var hold = st.hold || T_HOLD, s = Math.max(0, Math.min(1, e / hold));
    s = s * s * (3 - 2 * s);
    var u = 0.04 + 0.34 * s, len = arc[0].distanceTo(arc[2]);
    bez(arc, _rp, u); bez(arc, _rq, Math.min(1, u + 0.02));
    _rt.subVectors(_rq, _rp); _rt.y = 0;
    if (_rt.lengthSq() < 1e-6) _rt.subVectors(arc[2], arc[0]).setY(0);
    _rt.normalize();
    _rs.set(-_rt.z, 0, _rt.x);                    // horizontal side of the stream
    /* a wide tracking shot: far enough back and high enough that both galaxies
       and the whole stream between them stay in frame as it slides along */
    /* from one side, so the stream crosses the frame on a diagonal and the
       galaxy it leaves sits low-left, clear of the caption */
    var back = 0.50 * len + 150, up = 0.42 * len + 170, side = (st.stream.side || 1) * (0.52 * len + 140);
    pos.copy(_rp).addScaledVector(_rt, -back).addScaledVector(_rs, side); pos.y += up;
    bez(arc, tgt, Math.min(1, u + 0.46));
    tgt.y -= 0.10 * len;
    return true;
  }
  function tourPose(st, e, pos, tgt) {
    if (st.stream && streamPose(st, e, pos, tgt)) return;
    var az, dist, c, el;
    if (!st.list) {                    // overview: the original orbit sway
      /* OVE: the fit, eased (2026-10-08, contracts 8a: a new galaxy re-frames the
         overview with a smooth move, never a jump) */
      var E = OVE.c ? OVE : OV;
      az = E.az + OV.sway * Math.sin(e * 6.2832 / CAM_PERIOD) + (uni() ? 0.02 : 0.06) * Math.sin(e * 6.2832 / 31);
      dist = (OVE.c ? OVE.d : NS.fitDist) * (1.03 + 0.05 * Math.sin(e * 6.2832 / 127));
      c = E.c || NS.center; el = E.el;  // overview framing is verified at OV.el: no drift
    } else {
      az = st.az + T_SWAY * Math.sin(e * 6.2832 / T_SWAY_PERIOD);
      el = (st.el || CAM_EL) + 0.012 * Math.sin(e * 6.2832 / 41);
      dist = st.dist * (1 + 0.015 * Math.sin(e * 6.2832 / 23));
      c = st.c;
    }
    /* arrive ~5% wide, push in over the first ~3 s of the hold: the shot
       settles instead of snapping (travel's endpoint uses e=0, so the two
       phases meet at exactly the same pose) */
    dist *= 1 + 0.05 * Math.exp(-e * 0.8);
    tgt.copy(c);
    pos.set(c.x + dist * Math.cos(el) * Math.sin(az),
            c.y + dist * Math.sin(el),
            c.z + dist * Math.cos(el) * Math.cos(az));
  }

  /* Camera follow (2026-10-04): a critically damped spring, integrated with
     its exact closed-form step, replaces the first-order lerp. The lerp kept
     POSITION continuous but not VELOCITY: at every departure the path target
     jumped from the hold pose to the current camera position, so the camera's
     velocity snapped to zero, and the gain also switched 1.6 -> 3.0 -> 1.6 at
     each handover. A second-order follow keeps velocity continuous through
     every phase change and the step is exact for any dt (fps-independent).
     One stiffness for every phase, so there is no gain switch either. */
  var CAM_W = 4.5;                       // rad/s; lag 2/w = 0.44 s behind a moving target
  /* exact step of x'' = -2w x' - w^2 (x - g(t)) for a target moving LINEARLY
     from g0 to g1 over dt (the tour path is sampled once a frame, so this is
     exact up to the path's own curvature: ~1e-3 u between 24 and 60 fps) */
  function springAxis(x, v, g0, g1, w, dt) {
    var tv = (g1 - g0) / dt, ep = -2 * tv / w;          // steady lag behind a ramp
    var z = x - g0 - ep, zv = v - tv, e = Math.exp(-w * dt), k = (zv + w * z) * dt;
    _spOut[0] = g1 + ep + (z + k) * e;
    _spOut[1] = (zv - w * k) * e + tv;
  }
  var _spOut = [0, 0];
  function springVec(p, vel, g0, g1, w, dt) {
    springAxis(p.x, vel.x, g0.x, g1.x, w, dt); p.x = _spOut[0]; vel.x = _spOut[1];
    springAxis(p.y, vel.y, g0.y, g1.y, w, dt); p.y = _spOut[0]; vel.y = _spOut[1];
    springAxis(p.z, vel.z, g0.z, g1.z, w, dt); p.z = _spOut[0]; vel.z = _spOut[1];
  }
  /* ---- overview fit, universe mode (2026-10-04 review) -------------------
     The analytic fit above assumed a long thin spine seen from el 0.60, and
     with galaxy discs on it that left the estate in a thin band with black
     above and below. This one is MEASURED: it projects the real content
     (nodes, disc rims, infra label heads, the exosphere pulled half-way in)
     through the real camera, view offset included, and bisects the distance
     until the content fits the gap between the HUD panels at every point of
     the sway. It tries a few elevations / azimuths and keeps whichever frames
     the estate largest, then re-centres the content in the gap. Runs only on
     a rebuild or setFrame, never per frame. */
  var OV = { az: 0, el: CAM_EL, sway: 0.05, c: null };   // smaller sway: a long chain swung 0.26 rad needed ~30 % more distance
  /* the fit box: the safe area between the side panels (x 0.204 / 0.795), the top
     bar (0.093) and the caption (0.843), less a margin - the estate's bounding
     volume fills ~85-90 % of it (contracts 8a: "when it zooms out i want the
     screen filled"); was x 0.205-0.745, y 0.13-0.735 */
  var OV_BOX = { x0: 0.215, x1: 0.775, y0: 0.115, y1: 0.80 };
  /* the overview pose actually flown: eased toward OV / fitDist (~1.6 s time
     constant) so a re-fit after growth is a glide; snaps on the first fit */
  var OVE = { c: null, az: 0, el: CAM_EL, d: 0 };
  function ovEase(dt) {
    if (!OV.c) return;
    if (!OVE.c) { OVE.c = OV.c.clone(); OVE.az = OV.az; OVE.el = OV.el; OVE.d = NS.fitDist; return; }
    var k = 1 - Math.exp(-dt / 1.6);
    OVE.c.lerp(OV.c, k); OVE.az += (OV.az - OVE.az) * k; OVE.el += (OV.el - OVE.el) * k; OVE.d += (NS.fitDist - OVE.d) * k;
  }
  NS_OVE = OVE;
  function fitOverviewUni() {
    var pts = [];
    NS.nodes.forEach(function (n) {
      pts.push([n._x, n._y, n._z]);
      if (n._grp) pts.push([n._x, n._y + (n._h || 8) + 30, n._z]);
      var R = n._uSys ? n._uSys.R : 0;
      /* a galaxy's bright disc reaches past its outermost orbit (the plate's
         haze runs further and may spill past the box: it fills, it is not content) */
      if (R) { R *= 1.12; for (var k = 0; k < 8; k++) pts.push([n._x + R * Math.cos(k * 0.785), n._y, n._z + R * Math.sin(k * 0.785)]); }
    });
    if (NS.exoEnvelope && NS.byId.wan) {
      var w = NS.byId.wan;
      /* the exosphere shells are wide and mostly empty; frame their inner
         third (the beacons nearest the WAN), let the rest run off-frame */
      try { NS.exoEnvelope(w).forEach(function (p) { pts.push([w._x + (p[0] - w._x) * 0.3, w._y + (p[1] - w._y) * 0.3, w._z + (p[2] - w._z) * 0.3]); }); } catch (e) { }
    }
    if (!pts.length) return;
    /* the fit is a pure function of these points and the projection; most
       rebuilds (a wifi client joins) move neither, so reuse the last answer */
    var memoKey = W0() + 'x' + H0() + '|' + NS.cam.projectionMatrix.elements.map(function (v) { return v.toFixed(5); }).join(',') + '|' + OV.sway + '|'
      + pts.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1) + ',' + p[2].toFixed(1); }).join(';');
    if (FIT_MEMO && FIT_MEMO.key === memoKey) {
      var m = FIT_MEMO; OV.az = m.az; OV.el = m.el; OV.c = m.c.clone(); NS.fitDist = m.fitDist; NS.ovFit = m.ovFit; return;
    }
    var cam = NS.cam.clone(); cam.copy(NS.cam);
    var W = window.innerWidth, H = window.innerHeight, v = new THREE.Vector3();
    var bx0 = OV_BOX.x0 * W, bx1 = OV_BOX.x1 * W, by0 = OV_BOX.y0 * H, by1 = OV_BOX.y1 * H;
    var c = new THREE.Vector3();
    var bb = new THREE.Box3(); pts.forEach(function (p) { bb.expandByPoint(v.set(p[0], p[1], p[2])); });
    bb.getCenter(c);
    /* ~6000 bbox() calls per fit: project with ONE premultiplied view-projection
       matrix over a flat array instead of two Matrix4 applies per Vector3 (the
       fit was ~100 ms of every topology rebuild on the main thread) */
    var PF = new Float64Array(pts.length * 3), VP = new THREE.Matrix4();
    for (var pi = 0; pi < pts.length; pi++) { PF[pi * 3] = pts[pi][0]; PF[pi * 3 + 1] = pts[pi][1]; PF[pi * 3 + 2] = pts[pi][2]; }
    function bbox(az, el, d, cc, out) {
      cam.position.set(cc.x + d * Math.cos(el) * Math.sin(az), cc.y + d * Math.sin(el), cc.z + d * Math.cos(el) * Math.cos(az));
      cam.up.set(0, 1, 0); cam.lookAt(cc); cam.updateMatrixWorld(); cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
      VP.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      var e = VP.elements, e0 = e[0], e1 = e[1], e3 = e[3], e4 = e[4], e5 = e[5], e7 = e[7], e8 = e[8], e9 = e[9], e11 = e[11], e12 = e[12], e13 = e[13], e15 = e[15];
      var x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
      for (var i = 0, n3 = PF.length; i < n3; i += 3) {
        var px = PF[i], py = PF[i + 1], pz = PF[i + 2];
        var iw = 1 / (e3 * px + e7 * py + e11 * pz + e15);
        var sx = ((e0 * px + e4 * py + e8 * pz + e12) * iw * 0.5 + 0.5) * W, sy = (-(e1 * px + e5 * py + e9 * pz + e13) * iw * 0.5 + 0.5) * H;
        if (sx < x0) x0 = sx; if (sx > x1) x1 = sx; if (sy < y0) y0 = sy; if (sy > y1) y1 = sy;
      }
      out[0] = x0; out[1] = x1; out[2] = y0; out[3] = y1; return out;
    }
    var tmp = [0, 0, 0, 0];
    function fits(az0, el, d, cc) {
      for (var s2 = -1; s2 <= 1; s2++) {
        bbox(az0 + s2 * (OV.sway + 0.02), el, d * 1.0, cc, tmp);
        if (tmp[0] < bx0 || tmp[1] > bx1 || tmp[2] < by0 || tmp[3] > by1) return false;
      }
      return true;
    }
    function solve(az0, el, cc) {
      var lo = 150, hi = 12000;
      if (!fits(az0, el, hi, cc)) return hi;
      for (var it = 0; it < 22; it++) { var mid = (lo + hi) / 2; if (fits(az0, el, mid, cc)) hi = mid; else lo = mid; }
      return hi;
    }
    var best = null;
    /* the spine is a long chain along +X, so a diagonal view (|az| up to
       0.9) at a steeper elevation is what turns the thin band into a shape */
    /* the estate map has a meaning per direction (the Internet on the left,
       compute over the top): keep the overview square-on to it, only the
       elevation is free */
    /* 2026-10-08: steeper views are tried too, and the winner is the one that
       FILLS the box (area), not merely the closest: the estate is wider than the
       safe area, so every elevation was width-limited, the first (flattest) one
       always won and the frame was a band with black above and below */
    [0.8, 0.92, 1.04, 1.16].forEach(function (el) {
      [-0.1, 0, 0.1].forEach(function (az0) {
        var cc = c.clone();
        /* two re-centring passes: shift the look-at so the content's screen
           box is centred in the gap, then re-solve the distance */
        var d = solve(az0, el, cc);
        for (var pass = 0; pass < 2; pass++) {
          bbox(az0, el, d, cc, tmp);
          var dxp = (bx0 + bx1) / 2 - (tmp[0] + tmp[1]) / 2, dyp = (by0 + by1) / 2 - (tmp[2] + tmp[3]) / 2;
          var wpp = 2 * d * Math.tan(cam.fov * Math.PI / 360) / H;     // world units per px at the target
          var right = new THREE.Vector3(Math.cos(az0), 0, -Math.sin(az0));
          var fwd = new THREE.Vector3(-Math.sin(az0), 0, -Math.cos(az0));
          cc.addScaledVector(right, -dxp * wpp).addScaledVector(fwd, dyp * wpp / Math.max(0.3, Math.sin(el)));
          d = solve(az0, el, cc);
        }
        bbox(az0, el, d, cc, tmp);
        var cov = Math.max(0, tmp[1] - tmp[0]) * Math.max(0, tmp[3] - tmp[2]) / ((bx1 - bx0) * (by1 - by0));
        if (!best || cov > best.cov + 0.01 || (Math.abs(cov - best.cov) <= 0.01 && d < best.d)) best = { d: d, el: el, az: az0, c: cc, cov: cov };
      });
    });
    OV.az = best.az; OV.el = best.el; OV.c = best.c;
    NS.fitDist = best.d / 0.98;     // the overview breathes 0.98..1.08 x fitDist
    /* report what limits the fit, for tuning */
    NS.ovFit = { d: Math.round(best.d), el: best.el, az: best.az, c: best.c.toArray().map(Math.round), npts: pts.length, W: W, H: H, cov: Math.round(best.cov * 100) / 100 };
    FIT_MEMO = { key: memoKey, az: OV.az, el: OV.el, c: OV.c.clone(), fitDist: NS.fitDist, ovFit: NS.ovFit };
  }
  var FIT_MEMO = null;
  function W0() { return window.innerWidth; }
  function H0() { return window.innerHeight; }

  function glide(dt) {
    if (!TP.vp) { TP.vp = new THREE.Vector3(); TP.vt = new THREE.Vector3(); TP.gp = null; }
    if (!TP.gp) { TP.gp = TP.pos.clone(); TP.gt = TP.tgt.clone(); }   // first frame: target at rest
    springVec(NS.cam.position, TP.vp, TP.gp, TP.pos, CAM_W, dt);
    springVec(NS.ctrl.target, TP.vt, TP.gt, TP.tgt, CAM_W, dt);
    TP.gp.copy(TP.pos); TP.gt.copy(TP.tgt);
  }

  /* QA: tour events on the page clock (video / luminance alignment), last 64 */
  function qaEv(ev, key) {
    var q = NS.qaEvents || (NS.qaEvents = []);
    q.push({ t: Math.round(performance.now()) / 1000, ev: ev, key: key });
    if (q.length > 64) q.shift();
  }
  function setTourText(txt) {
    if (NS.tourEl === undefined) NS.tourEl = document.getElementById('tour') || null;
    if (NS.tourEl && NS.tourTxt !== txt) { NS.tourTxt = txt; NS.tourEl.textContent = txt; }
  }

  /* ---------------- cinematic legs (2026-10-07) ----------------
     A leg used to be one move: an eased lerp with a crane rise. Now each leg
     picks a move from a small vocabulary, by what the leg IS, so the lap has a
     rhythm instead of fifteen identical glides:
       dive      overview -> a system: plunge in from above the subject
       reveal    anything -> overview: retreat along the view axis and rise, a
                 gentle roll, the estate opening up around the subject
       slingshot inside one system (host <-> its arms): orbit the core, dipping
                 in close as it passes, out to the next arm
       swoop     system -> system: swing out sideways and curl in, passing
                 beside the subject
       dolly     system -> system: a near-straight push with a slight roll
       glide     the original crane arc (used to break up runs)
     Never the same move twice in a row; the lateral sense alternates per leg
     and per lap so consecutive laps mirror. Every move is a pure function of
     the raw leg progress through ONE speed ramp (ease in, fast middle, long
     soft landing: zero velocity at both ends), sampled into the existing
     critically damped follow - so velocity stays continuous through every
     phase change and nothing depends on frame rate. Published to the TV and
     the room as lightstate.move / move_dir (lightsync.js). */
  var LEG = { n: 0, last: '' };
  /* the guiding mote of the energy trail (netscene_universe.js draws it):
     where the look point will be a little ahead of now, so it leads the camera
     into the destination and lands there just before the camera does */
  NS.legHead = function (out) {
    var TR = NS.tour; if (!TR || TR.phase !== 'travel' || !TR.leg || !TR.leg.dt || NS.legS == null) return false;
    var sh = Math.min(1, NS.legS + 0.16), eT = legRamp(Math.min(1, sh / 0.82));
    out.lerpVectors(TR.T0, TR.leg.dt, eT);
    return true;
  };
  NS.stopHubPos = function (st, out) {
    var h = stopHub(st), n = h ? NS.byId[h] : null;
    if (!n && st && st.sysId && uni()) { var sy = uni().sysById[st.sysId]; n = sy ? NS.byId[sy.anchor] : null; }
    if (n) { out.set(n._cx, n._cy, n._cz); return n; }
    if (st && st.c) { out.copy(st.c); return null; }
    return null;
  };
  function legRamp(s) { var w = s + 0.25 * s * (1 - s); return w * w * w * (w * (w * 6 - 15) + 10); }
  function stopHub(st) {
    var k = st && st.key || '';
    if (k.indexOf('host:') === 0) return k.slice(5);
    if (k.indexOf('blk:') === 0) { var p = k.split(':'); return p[1] + ':' + p[2]; }
    if (st && st.aspect && st.hubId) return st.hubId;     // an aspect flies within its galaxy: slingshot / orbit legs
    return null;
  }
  function legPlan(TR, a, b, D, Dt) {
    var mv, ha = stopHub(a), hb = stopHub(b);
    LEG.n++;
    if (b.stream) mv = 'stream';
    else if (a.stream && b.list) mv = 'dolly';
    else if (!b.list) mv = 'reveal';
    else if (!a.list) mv = 'dive';
    else if (ha && ha === hb) {
      var cin = ['slingshot', 'orbit', 'slingshot', 'dolly'], ci = LEG.n % cin.length;
      mv = cin[ci]; if (mv === LEG.last) mv = cin[(ci + 1) % cin.length];
    } else {
      var cyc = ['swoop', 'dolly', 'swoop', 'glide'], i = LEG.n % cyc.length;
      mv = cyc[i]; if (mv === LEG.last) mv = cyc[(i + 1) % cyc.length];
    }
    if (mv === LEG.last && mv !== 'stream') mv = mv === 'glide' ? 'swoop' : 'glide';
    LEG.last = mv;
    TR.move = mv;
    TR.moveDir = (LEG.n + Math.floor(LEG.n / Math.max(1, TR.stops.length))) % 2 ? 1 : -1;
    /* geometry the path needs, captured once */
    var L = TR.leg || (TR.leg = { c: new THREE.Vector3(), q: new THREE.Vector3(), q2: new THREE.Vector3(), side: new THREE.Vector3() });
    var len = D.distanceTo(TR.P0);
    L.len = len;
    /* lateral unit vector of the chord (horizontal), signed by moveDir */
    L.side.subVectors(D, TR.P0); L.side.set(-L.side.z, 0, L.side.x);
    if (L.side.lengthSq() < 1e-6) L.side.set(1, 0, 0);
    L.side.normalize().multiplyScalar(TR.moveDir);
    if (mv === 'slingshot' || mv === 'orbit' || mv === 'swoop') {
      /* polar about the destination's centre (slingshot / orbit: the hub's system) */
      var hubN = hb ? NS.byId[hb] : null;
      L.c.copy(mv !== 'swoop' && hubN ? new THREE.Vector3(hubN._cx, hubN._cy, hubN._cz) : Dt);
      var r0 = Math.hypot(TR.P0.x - L.c.x, TR.P0.z - L.c.z), r1 = Math.hypot(D.x - L.c.x, D.z - L.c.z);
      var a0 = Math.atan2(TR.P0.x - L.c.x, TR.P0.z - L.c.z), a1 = Math.atan2(D.x - L.c.x, D.z - L.c.z);
      var da = a1 - a0; while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI;
      L.r0 = r0; L.r1 = r1; L.a0 = a0; L.da = da; L.h0 = TR.P0.y - L.c.y; L.h1 = D.y - L.c.y;
      if (Math.abs(da) > 0.05) TR.moveDir = da > 0 ? 1 : -1;   // the orbit's real sense (published)
    } else if (mv === 'dive') {
      /* control point high over the destination: enter steeply from above */
      L.q.copy(D).lerp(TR.P0, 0.25); L.q.y = Math.max(TR.P0.y, D.y) + Math.min(420, 0.35 * len);
    } else if (mv === 'stream') {
      /* arrive moving ALONG the stream: the control point sits back along the
         ride's own direction from where the ride begins, a little high */
      L.q2.subVectors(Dt, D); L.q2.y = 0; if (L.q2.lengthSq() < 1e-6) L.q2.set(1, 0, 0);
      L.q2.normalize();
      L.q.copy(D).addScaledVector(L.q2, -0.42 * len); L.q.y = Math.max(D.y, TR.P0.y) + 0.12 * len;
    } else if (mv === 'reveal') {
      /* control point behind and above where the camera starts */
      L.q2.subVectors(TR.P0, TR.T0); L.q2.y = 0; if (L.q2.lengthSq() < 1e-6) L.q2.set(0, 0, 1);
      L.q.copy(TR.P0).addScaledVector(L.q2.normalize(), 0.35 * len); L.q.y += 0.30 * len;
    }
  }
  var _lp = new THREE.Vector3();
  function legPath(TR, s, D, Dt) {
    var e = legRamp(s), mv = TR.move || 'glide', L = TR.leg || {}, bump = Math.sin(Math.PI * e);
    var eT = legRamp(Math.min(1, s / 0.82));
    var roll = 0;
    if (mv === 'slingshot' || mv === 'orbit' || mv === 'swoop') {
      var a = L.a0 + L.da * e;
      var r = L.r0 + (L.r1 - L.r0) * e, h = L.h0 + (L.h1 - L.h0) * e;
      if (mv === 'slingshot') { r *= 1 - 0.22 * bump; h *= 1 - 0.18 * bump; }        // dip close past the core
      else if (mv === 'orbit') { r *= 1 + 0.16 * bump; h += 0.45 * Math.max(r, 1) * 0.35 * bump; }   // a high crane orbit over the disc
      else { r *= 1 + 0.10 * bump; h += 0.25 * (TR.arcH || 0) * bump; }
      _lp.set(L.c.x + r * Math.sin(a), L.c.y + h, L.c.z + r * Math.cos(a));
      if (mv === 'swoop') _lp.addScaledVector(L.side, 0.30 * L.len * bump * (1 - 0.35 * e));   // swing out, curl in
      D.copy(_lp);
      roll = (mv === 'swoop' ? 0.03 : 0.02) * TR.moveDir * bump;
    } else if (mv === 'dive' || mv === 'reveal' || mv === 'stream') {
      var u = e, iu = 1 - u;
      _lp.copy(TR.P0).multiplyScalar(iu * iu).addScaledVector(L.q, 2 * iu * u).addScaledVector(D, u * u);
      D.copy(_lp);
      if (mv === 'reveal') roll = 0.025 * TR.moveDir * bump;
      if (mv === 'dive') eT = legRamp(Math.min(1, s / 0.7));       // gaze locks onto the target early, then the plunge
    } else if (mv === 'dolly') {
      D.lerpVectors(TR.P0, D, e); D.y += 0.25 * (TR.arcH || 0) * bump;
      eT = legRamp(Math.min(1, s / 0.6));
      roll = 0.035 * TR.moveDir * bump;
    } else {
      D.lerpVectors(TR.P0, D, e); D.y += (TR.arcH || 0) * bump;      // glide: the crane arc
    }
    (L.dt || (L.dt = new THREE.Vector3())).copy(Dt);      // the destination's look point (the trail's goal)
    Dt.lerpVectors(TR.T0, Dt, eT);
    NS.legRoll = roll;
    NS.legS = s;
  }

  function tourTick(t, dt) {
    var TR = NS.tour;
    if (!TR || !TR.stops.length) return;
    if (!TP.pos) { TP.pos = new THREE.Vector3(); TP.tgt = new THREE.Vector3(); }
    if (t - NS.manualAt <= MANUAL_HOLD) {          // user holds the camera
      if (!TR.manual) { TR.manual = true; setFocus(null); setTourText('Manual camera'); closeCard(); }
      if (TP.vp) { TP.vp.set(0, 0, 0); TP.vt.set(0, 0, 0); TP.gp = null; }   // the user owns the camera now
      return;
    }
    /* a cinematic move (cinema.js) owns the camera: the tour's clocks are
       frozen, so the dwell it was in resumes exactly where it left off and the
       pose it glides back to is the one it was parked on - no jump either way.
       Frozen by TIMESTAMP, not by accumulating dt: dt is capped at 1 s, so at a
       low frame rate a per-frame shift leaked and the dwell expired under the
       move (measured in a 1 fps headless run: the tour departed the instant
       the move ended). The shift by the true elapsed time is exact at any rate. */
    if (TR.paused) { if (!TR.pausedAt) TR.pausedAt = t; return; }
    if (TR.pausedAt) { var shift = t - TR.pausedAt; TR.t0 += shift; TR.tHold += shift; TR.pausedAt = 0; }
    if (TR.manual) {                               // idle again: fly home first
      TR.manual = false; TR.idx = 0; TR.next = 0; TR.phase = 'travel'; TR.t0 = t;
      NS_FOC.live = false;
      TR.P0.copy(NS.cam.position); TR.T0.copy(NS.ctrl.target); TR.travelT = 6;
      TR.switched = true;                        // focus is already full
      tourPose(TR.stops[0], 0, TP.pos, TP.tgt);
      TR.arcH = Math.min(110, 26 + TP.pos.distanceTo(TR.P0) * 0.14);
      TR.move = 'glide'; TR.moveDir = 1;
      setTourText('Tour: Overview');
    }
    var st = TR.stops[TR.idx], e = t - TR.t0;
    /* /api/tour changed its aspect list: re-plan at a hold (refreshTour refuses
       mid-flight and around the stream ride, so this just retries) */
    if (NS.tourDirty && TR.phase === 'hold' && (t - (NS.tourDirtyTry || 0)) > 1) {
      NS.tourDirtyTry = t;
      if (refreshTour()) { NS.tourDirty = false; TR = NS.tour; st = TR.stops[TR.idx]; e = t - TR.t0; }
    }
    if (TR.phase === 'hold') {
      tourPose(st, t - TR.tHold, TP.pos, TP.tgt);
      glide(dt);
      var holdDur = st.hold || (st.list ? T_HOLD : T_HOLD_OVER);
      if (e > holdDur && !NS.tourPark) {          // tourPark: QA only, parks the tour
        /* depart IMMEDIATELY with the union of both stops materialised: the
           outgoing subject recedes while the incoming one grows, so no frame
           of the flight is empty (the old 1 s parked fade-out read as the
           screen breaking on a recording) */
        TR.next = (TR.idx + 1) % TR.stops.length;
        var nx = TR.stops[TR.next];
        setFocusLeg(st, nx, unionSpread(st, nx));
        qaEv('depart', nx.key);
        /* scheduled, not observed: departure is at exactly tHold + holdDur, so
           a slow frame cannot stretch a stop and the lap time is identical at
           any frame rate (was TR.t0 = t: up to one frame of drift per stop) */
        TR.phase = 'travel'; TR.t0 = TR.t0 + holdDur; TR.switched = false;
        TR.P0.copy(NS.cam.position); TR.T0.copy(NS.ctrl.target);
        tourPose(nx, 0, TP.pos, TP.tgt);
        var dTrav = TP.pos.distanceTo(TR.P0);
        TR.travelT = Math.min(2.3, Math.max(1.5, 1.1 + dTrav / 850));
        TR.arcH = Math.min(110, 26 + dTrav * 0.14);  // crane-shot rise, scales with leg
        legPlan(TR, st, nx, TP.pos, TP.tgt);
        setTourText('Tour: ' + nx.name);
      }
    } else {                                       // travel
      var dst = TR.stops[TR.next];
      var sR = Math.min(1, e / TR.travelT);
      var sN = legRamp(sR);                                  // the legs' speed ramp: focus crossfades in step with the move
      /* the gaze eases ahead of the dolly: the camera pans to frame the
         destination early, then the move settles in behind it */
      var sT = Math.min(1, e / (TR.travelT * 0.82));
      sT = sT * sT * sT * (sT * (sT * 6 - 15) + 10);
      /* focus crossfades with the dolly: no global lift at departure, no
         drop at arrival; the discrete stop identity hands over halfway */
      if (NS_FOC.live) setLegProgress(sN);
      if (!TR.switched && sR >= 0.5) {
        TR.switched = true;
        setLegHandover(dst);
      }
      tourPose(dst, 0, TP.pos, TP.tgt);
      legPath(TR, sR, TP.pos, TP.tgt);
      glide(dt);
      if (e >= TR.travelT) {
        var tArr = TR.t0 + TR.travelT;           // scheduled arrival (see departure)
        TR.idx = TR.next; TR.phase = 'hold'; TR.t0 = tArr; TR.tHold = tArr;
        NS.qaArrivals = (NS.qaArrivals || 0) + 1;      // QA: lightsync must beat exactly once per arrival
        NS.legRoll = 0;
        if (NS.onArrive) { try { NS.onArrive(TR.stops[TR.next], TR); } catch (e) { } }   // the arrival accent (one per stop, same instant as the light beat)
        qaEv('arrive', TR.stops[TR.next].key);
        var cur = TR.stops[TR.idx];
        setFocus(cur.ids || null, stopSpread(cur));
        setTourText('Tour: ' + cur.name);
      }
    }
  }

  /* ============================ public API ============================ */
  function netSceneUpdate(topo) {
    if (!NS || !topo || !topo.nodes || !topo.nodes.length) return;
    if (topo.ts !== undefined && topo.ts === NS.lastTs) return;
    /* first build waits (<= 5 s) for /api/universe so the page does not lay
       out once without it and then visibly re-lay itself out */
    if (NS.uniWaitUntil && Date.now() < NS.uniWaitUntil && !NS.graph) { NS.lastTopo = topo; return; }
    NS.lastTs = topo.ts;
    NS.lastTopo = topo;
    try {
      var sig = topo.nodes.map(function (n) { return n.id + ':' + (n.parent || '') + ':' + n.kind; }).sort().join('|')
        + '#' + (topo.links || []).map(function (l) { return l.source + '>' + l.target; }).sort().join('|')
        + '#' + (uni() ? uni().sig : '');
      if (sig !== NS.sig) { NS.sig = sig; rebuildGraph(topo); }
      else {
        // in-place data refresh: swap node objects but keep scene refs
        topo.nodes.forEach(function (nn) {
          var o = NS.byId[nn.id]; if (!o) return;
          o.rx = nn.rx; o.tx = nn.tx; o.measured = nn.measured; o.meta = nn.meta || o.meta; o.status = nn.status;
          // a switch hub keeps the registry's status (see computeLayout): a stale SNMP record in the topology can say a live switch is down
          var hubB = o._ub && o._ub.hub && uni() ? (uni().bodyOfTopo(o.id) || o._ub) : null;
          if (hubB && (hubB.status === 'up' || hubB.status === 'down')) o.status = hubB.status;
          // rings now key off loss / newly-seen as well as status, and those
          // change without the status ever moving -- so re-evaluate every
          // refresh. There are only a handful of infra nodes; this is free.
          if (o._rim) {
            o._rim.material.uniforms.c.value.setHex(rimColor(o));
            o._rim.material.uniforms.st.value = rimStrength(o);
          }
          if (o._grp) {
            if (ringWanted(o)) {
              if (o._hasRing) { o._ring.visible = true; o._ring.material.color.setHex(ringColor(o)); }
              else addAlertRing(o, o._grp);
            } else if (o._hasRing) o._ring.visible = false;
          }
        });
        applyDynamics(topo);
      }
      NS.totals = topo.totals || NS.totals;
    } catch (e) { console.error('netscene: update failed', e); }
  }

  function netSceneTick(t, dt) {
    if (!NS || !window.scene) return;
    if (NS._ovl) NS.cam.layers.disable(LBL_LAYER); else NS.cam.layers.enable(LBL_LAYER);
    // index.html clamps dt to 50 ms: fine for particle motion, but easing
    // driven by it runs slow whenever the frame rate dips. Real elapsed time
    // (capped at 1 s for tab-suspend resumes) keeps fades and camera glides
    // on schedule at any fps.
    var rdt = NS.pt === undefined ? Math.max(dt, 0.001) : Math.min(1, Math.max(0.001, t - NS.pt));
    NS.pt = t;
    NS.t = t;
    // ~23 min per revolution: enough that the sky is never quite the same,
    // slow enough that it never pulls the eye off the data
    var tween = t < NS.tweenUntil;
    if (tween) {
      syncNodeTransforms(1 - Math.exp(-rdt * 4.5));   // was dt*4.5: linear, fps-dependent
      updateHotLabels();
      updateLinkGeometry(false);
    } else if (NS.needSettle) {
      NS.needSettle = false;
      syncNodeTransforms(1);
      updateLinkGeometry(true);
    } else if (NS.explode !== NS._explodeApplied) {
      /* the exploded view is eased by cinema.js one value per frame; outside a
         tween nothing else re-seats the nodes, so do it here */
      NS._explodeApplied = NS.explode;
      syncNodeTransforms(1);
      updateHotLabels();
      updateLinkGeometry(true);
    }
    tickParticles(dt);
    TRUNK_T.value = t;          // one write drives every trunk's flow
    var hrt = window.composer && window.composer.renderTarget1;
    if (hrt && hrt.width) HUD_INV.value.set(1 / hrt.width, 1 / hrt.height);

    /* alert rings breathe slowly */
    for (var i = 0; i < NS.alertRings.length; i++)
      NS.alertRings[i].material.opacity = 0.4 + 0.3 * Math.sin(t * 2.2);   // absolute t: fps-free

    /* label opacity = distance fade x tour focus; fully-faded sprites are
       hidden outright so they stop being draw calls, callout obstacles and
       phantom bbox contributors */
    /* focus fades + the auto-tour camera (yields to the user via MANUAL_HOLD) */
    focusTick(rdt);
    ovEase(rdt);
    tourTick(t, rdt);
    /* universe layer (netscene_universe.js): called directly, not via another
       netSceneTick wrapper - the wrapper chain is how flows ended up ticking
       twice a frame */
    if (NS.uTick) { try { NS.uTick(t, rdt); } catch (e) { console.error('universe tick', e); NS.uTick = null; } }
    /* measured inter-galaxy traffic (netscene_traffic.js), after the universe
       layer so the galaxy cores are where they will be drawn */
    if (NS.tTick) { try { NS.tTick(t, rdt); } catch (e) { console.error('traffic tick', e); NS.tTick = null; } }

    /* Label collisions are decided in labelPass(), which the render loop calls
       after ctrl.update() - see the comment on labelPass. This fallback keeps
       netscene.js standalone if nothing external drives it. */
    if (!NS._lpExternal) labelPass();
  }

  /* ---- the label collision pass ----------------------------------------
     WHY THIS IS NOT IN netSceneTick ANY MORE.

     It used to run at the end of netSceneTick, right after focusTick/tourTick,
     on the reasoning that those move the camera so the pass must follow them.
     That is necessary but nowhere near sufficient, because the per-frame order
     is really:

        netSceneTick   tourTick writes cam.position
        cinema tick    writes cam.up (the banking roll)
        ctrl.update()  OrbitControls lookAt() -> the camera's final orientation
        composer.render() -> updateMatrixWorld() -> matrixWorldInverse

     Vector3.project() reads matrixWorldInverse, and nothing recomputes it until
     render(). So the pass was projecting through the PREVIOUS frame's camera:
     it never saw this frame's dolly, and it never saw the banking roll at all.
     Every decision was made against a camera the viewer never looked through.

     Measured: kept rects sat ~26 px above and ~5% narrower than the rects the
     same labels actually drew at, which is exactly enough for the pass to
     certify a pair as clear while they overlap by 80% on screen. It was hidden
     until the tour was sped up 1.6x - a faster camera makes a one-frame lag a
     visible one.

     So it runs from the render loop after ctrl.update(), and forces the camera
     matrices current first. Nothing else in here changed. */
  function labelPass() {
    if (!NS || !NS.cam || !window.scene) return;
    /* the whole point: project through the camera as it will actually be
       drawn, not as it was left after the last render */
    NS.cam.updateMatrixWorld();
    var t = NS.t, cp = NS.cam.position;

    /* ---- label visibility, then ONE collision pass over every pool --------
       There are three independent sprite pools - node/caption labels, link rate
       labels, and the hot work callouts - and they used to know nothing about
       each other. Measured with audit_labels.py, the single biggest source of
       overlap on this dashboard was a node name drawn straight through a link's
       rate label, because rate labels were in no collision system at all.
       Everything now competes in one pass, in a fixed priority order:
         0 infra names   - the thing the camera flew here to show
         1 block captions- what a lattice of boxes IS
         2 rate labels   - link throughput
         3 guest/client  - the densest and most expendable
       Within a rank, nearest to the camera wins. Losers go to opacity 0 for
       this frame only; nothing is permanently hidden. */
    /* candidates are pooled objects (2026-10-04): this pass used to allocate
       ~120 objects + a Vector3 clone per flow label every frame, i.e. steady
       GC churn on the wall's hottest path */
    var cand = NS._lcand || (NS._lcand = []);
    var pool = NS._lpool || (NS._lpool = []);
    cand.length = 0;
    function pushCand(L, d, rank, score) {
      var c = pool[cand.length] || (pool[cand.length] = { L: null, d: 0, rank: 0, score: 0, hot: undefined, world: null, hasWorld: false });
      c.L = L; c.d = d; c.rank = rank; c.score = score; c.hot = undefined; c.hasWorld = false;
      cand.push(c);
    }

    /* WHO SPEAKS (section 7, 2026-10-08): fewer labels, hubs and the subject
       first. At the overview only the galaxy captions, the Internet and the top
       traffic streams are named; device and hub names come in at a close-up of
       their own system, leaves within a small budget ranked by importance. */
    var oK = NS.overK === undefined ? (NS.focusAll !== false ? 1 : 0) : NS.overK;
    /* the aspect stop's subject always earns its name (contracts 9.2) */
    var TRs = NS.tour, sts = TRs && TRs.stops && TRs.stops[(TRs.phase === 'travel' && TRs.switched) ? TRs.next : TRs.idx];
    NS._subj = sts && sts.subj && !TRs.manual ? sts.subj : null;
    var _privacy = document.body.classList.contains('privacy');
    for (var li = 0; li < NS.labels.length; li++) {
      var L = NS.labels[li], ud = L.userData, op, fn = ud.focN;
      var isHubLbl = !!(fn && (isInfra(fn) || (fn._ub && fn._ub.hub)));
      if (ud.op !== undefined) op = ud.op;            // a module drives this label's opacity itself (traffic streams)
      else {
        op = spriteFocus(ud);
        op = op < 0.5 ? 0 : (op - 0.5) * 2;      // floored nodes stay dim; their labels do NOT
        if (ud.grp) {
          /* group names: close-ups only, and not at a category stop - there the
             stop caption already names the one lit arm, and the arm's tip label
             would sit in the near foreground under the caption */
          op *= Math.max(0, 1 - 2 * oK);
          if (ud.grp === 'sector') {
            var TRg = NS.tour, stg = TRg && TRg.stops[(TRg.phase === 'travel' && TRg.switched) ? TRg.next : TRg.idx];
            var wg = stg && String(stg.key).indexOf('blk:') === 0 ? 0 : 1;
            var dtg = Math.min(0.05, Math.max(0, t - (ud.gwT === undefined ? t : ud.gwT))); ud.gwT = t;   // dt-based ease, ~0.4 s
            ud.gw = ud.gw === undefined ? wg : ud.gw + (wg - ud.gw) * (1 - Math.exp(-dtg * 7));
            op *= ud.gw;
          }
        } else if (fn && fn.kind !== 'wan') op *= Math.max(0, 1 - 1.6 * oK);   // hubs + leaves: not at the overview
        else if (ud.uStub) op *= Math.max(0, 1 - 1.6 * oK);
      }
      /* recording-safe: the house-exterior cameras go unnamed */
      if (_privacy) { var lb0 = fn && fn._ub ? fn._ub : (ud.inst && ud.inst.b); if (lb0 && lb0['class'] === 'camera') op = 0; }
      var d = 0;
      if (ud.fade) {
        var dx = L.position.x - cp.x, dy = L.position.y - cp.y, dz = L.position.z - cp.z;
        d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        op *= Math.max(0, Math.min(1, (ud.fade.far - d) / (ud.fade.far - ud.fade.near)));
      } else {
        d = cp.distanceTo(L.position);
      }
      L.material.opacity = op;
      L.visible = op > 0.02;
      if (!L.visible) continue;
      // a switch hub that the topology only knows as a client still ranks with the infra names
      var rank = ud.rank !== undefined ? ud.rank : (fn ? (isHubLbl ? 0 : 3) : 1);
      if (!ud.l2d && uni() && rank < 3 && !ud.uStub && L.scale) {
        /* legacy sprite (none are created any more): keep a legible floor */
        if (!ud.bs) ud.bs = [L.scale.x, L.scale.y];
        var fsN = (window.innerHeight / 2) / Math.tan(NS.cam.fov * Math.PI / 360);
        var px = fsN * ud.bs[1] / Math.max(1, d), kk = px < 22 ? Math.min(6, 22 / px) : 1;
        L.scale.set(ud.bs[0] * kk, ud.bs[1] * kk, 1);
      }
      pushCand(L, d, rank, rank === 3 ? leafScore(ud) : (ud.score || 0));
    }

    for (var ri = 0; ri < NS.rateLabels.length; ri++) {
      var R = NS.rateLabels[ri], rop = R.userData.focL === undefined ? 1
        : linkFocus(R.userData.focL);
      rop = rop < 0.5 ? 0 : (rop - 0.5) * 2;
      R.material.opacity = rop;
      R.visible = rop > 0.02;
      if (R.visible) pushCand(R, cp.distanceTo(R.position), 3, 50);
    }

    /* The hot callouts pick their own lift from a ladder, but that ladder runs
       against the PREVIOUS frame's visibility - so on a tour transition it can
       place one straight through a name that is only just appearing. Let them
       compete here as well; the ladder chooses where, this decides whether. */
    for (var hi = 0; hi < (NS.hotLabels || []).length; hi++) {
      var H = NS.hotLabels[hi];
      if (H && H.visible) { pushCand(H, cp.distanceTo(H.position), 2, 0); cand[cand.length - 1].hot = hi; }
    }

    /* Any other pool that opts in with userData.lbl - netscene_flows keeps its
       own. It already dodged this file's text, but nothing dodged it back and
       it too ran off the previous frame. Lowest rank: a flow arc annotation is
       the most expendable thing on screen. */
    if (window.scene && NS._extLbl !== false) {
      var ext = NS._extLblCache || (NS._extLblCache = []);
      if (NS._extScan === undefined || t - NS._extScan > 2) {
        NS._extScan = t; ext.length = 0;
        window.scene.traverse(function (o) {
          if (o.isSprite && o.userData && o.userData.lbl) { ext.push(o); o.layers.set(LBL_LAYER); }
        });
      }
      for (var xi = 0; xi < ext.length; xi++) {
        var X = ext[xi];
        if (!X.visible || (X.material && X.material.opacity <= 0.02)) continue;
        X.getWorldPosition(NS.tmpV);
        pushCand(X, cp.distanceTo(NS.tmpV), 5, 0);
        var cw = cand[cand.length - 1];
        (cw.world || (cw.world = new THREE.Vector3())).copy(NS.tmpV); cw.hasWorld = true;
      }
    }

    if (cand.length > 0) {          // >0, not >1: a lone label can still sit under a HUD panel
      var fs = (NS.cam && NS.cam.fov)
        ? (window.innerHeight / 2) / Math.tan(NS.cam.fov * Math.PI / 360) : 0;
      if (fs) {
        /* within the leaf rank, universe mode ranks by IMPORTANCE (down, new,
           busiest), not nearness, and only a budget of leaves may speak at a
           close-up: 87 names around one host is noise, not information */
        cand.sort(function (a, b) { return a.rank - b.rank || b.score - a.score || a.d - b.d; });
        /* a big stop (a whole host, 88 guests) is explained by its group
           captions; it gets a handful of names, a small subject gets them all */
        spokeK();
        var leafBudget = uni() ? (NS.focusAll === false ? (NS._focN > 24 ? 6 : LEAF_BUDGET) : 0) : 1e9, leafKept = 0;
        var TRt = NS.tour, thinNow = !!(uni() && TRt && !TRt.manual && TRt.phase === 'travel' && TRt.travelT && (t - TRt.t0) / TRt.travelT < 0.8);
        var kept = NS._lkept || (NS._lkept = []);
        kept.length = 0;
        var hr = hudRects();
        for (var hk = 0; hk < hr.length; hk++) kept.push(hr[hk]);
        var scr = subjScreen();
        if (scr) kept.push(scr.rect);
        for (var ci = 0; ci < cand.length; ci++) {
          var CL = cand[ci].L, wp = cand[ci].hasWorld ? cand[ci].world : null;
          var r = wp ? spriteRect(CL, wp.x, wp.y, wp.z, fs)
                     : spriteRect(CL, CL.position.x, CL.position.y, CL.position.z, fs);
          if (!r) { CL.visible = false; CL.userData.hidden = true; CL.userData.lpFrame = t; continue; }
          var clash = false;
          /* a name sliced by the screen edge ("D · 88", "b/s") reads as a
             glitch, not information: only whole labels inside the frame */
          /* (sprite canvases are wider than their text: judge the middle 70 %) */
          var ecx = (r.x0 + r.x1) / 2, ehw = (r.x1 - r.x0) * 0.35;
          if (ecx - ehw < 12 || ecx + ehw > window.innerWidth - 12 || r.y0 < 12 || r.y1 > window.innerHeight - 12) clash = true;
          /* leaf names drawn under ~10 px of cap height are specks, not text:
             they only add clutter at the wide galaxy shots (review on the wall) */
          if (!CL.userData.l2d && cand[ci].rank === 3 && !CL.userData.setText && (r.y1 - r.y0) < 12) clash = true;
          /* rate plates and flow annotations below ~10 px of text are specks
             at the overview; they come back as the camera closes in */
          if (!CL.userData.l2d && uni() && (cand[ci].rank === 5 || CL.userData.setText) && (r.y1 - r.y0) < 22) clash = true;
          if (cand[ci].rank === 3 && !CL.userData.setText && leafKept >= leafBudget) clash = true;
          /* contracts 9.4: in flight the scene's text thins to the subject's few -
             hub and galaxy names and the aspect subject; rates, streams, flow notes
             and leaf names step back until the last fifth of the leg */
          if (thinNow && cand[ci].rank >= 2 && cand[ci].score < 1e5) clash = true;
          /* leaves keep a wider berth (10 px) so a name never kisses its neighbour */
          var padNow = cand[ci].rank === 3 ? 8 : LBL_PAD;
          for (var kj = 0; kj < kept.length; kj++) {
            if (clash) break;
            var K2 = kept[kj];
            if (!(r.x1 + padNow < K2.x0 || K2.x1 + padNow < r.x0 || r.y1 + padNow < K2.y0 || K2.y1 + padNow < r.y0)) { clash = true; break; }
          }
          /* the verdict, stamped with this frame's scene time: any pool that
             writes its own opacity later in the SAME frame (flows tickLabels,
             the exo overlay - e.g. when the in-tick fallback ran the pass first)
             must honour it, otherwise it re-raises the label this pass just
             suppressed (seen once: a flow rate label over a host node).
             A different frame time means "not judged yet" and the writer is
             free to re-arm the sprite for this pass. */
          /* a label that offers alternative spots (traffic streams: along their own
             arc) tries them in order before giving up; the winner becomes its
             position, so the next frame tries it first and nothing flickers */
          var ALT = CL.userData.alts;
          if (clash && ALT && !wp) {
            for (var ai = 0; ai < ALT.length && clash; ai++) {
              var ap = ALT[ai], r2 = spriteRect(CL, ap.x, ap.y, ap.z, fs);
              if (!r2) continue;
              var cx2 = (r2.x0 + r2.x1) / 2, hw2 = (r2.x1 - r2.x0) * 0.35, ok2 = !(cx2 - hw2 < 12 || cx2 + hw2 > window.innerWidth - 12 || r2.y0 < 12 || r2.y1 > window.innerHeight - 12);
              for (var kk = 0; kk < kept.length && ok2; kk++) {
                var K3 = kept[kk];
                if (!(r2.x1 + padNow < K3.x0 || K3.x1 + padNow < r2.x0 || r2.y1 + padNow < K3.y0 || K3.y1 + padNow < r2.y0)) ok2 = false;
              }
              if (ok2) { CL.position.copy(ap); r = r2; clash = false; }
            }
          }
          CL.userData.hidden = clash; CL.userData.lpFrame = t;
          /* switch names: two switches can sit ~15 px apart at the
             core stop, so one name always lost the collision and the switch went
             unnamed. A crowded switch name tries the other side of its star (at most
             once a second, so it never flickers); if both sides are taken it stays hidden. */
          var hubN = CL.userData.focN;
          if (clash && cand[ci].rank === 0 && hubN && hubN._ub && hubN._ub.hub && hubN._lbl === CL
              && !(hubN._lflipT > t - 1) ) { hubN._lflip = !hubN._lflip; hubN._lflipT = t; }
          if (clash) {
            CL.material.opacity = 0; CL.visible = false;
            var hx = cand[ci].hot;
            if (hx !== undefined && NS.hotLeaders && NS.hotLeaders[hx]) {
              NS.hotLeaders[hx].visible = false;   // no callout, no leader line
            }
          } else {
            kept.push(r);
            if (cand[ci].rank === 3 && !CL.userData.setText) leafKept++;
          }
          /* opt-in trace (NETSCENE._lpDebug = true): what this pass actually
             decided, so a disagreement with auditLabels() is diagnosable
             instead of arguable */
          if (NS._lpDebug) (NS._lpTrace || (NS._lpTrace = [])).push(
            { txt: (CL.userData && CL.userData.txt) || '', rank: cand[ci].rank,
              hidden: clash, r: r });
        }
        NS._keptRects = kept;      // the hot-callout ladder reuses these
        if (NS._lpDebug) { NS._lpDump = NS._lpTrace; NS._lpTrace = null;
                           NS._lpCam = NS.cam.position.clone(); NS._lpFrame = NS.t; }
      }
    }

    /* universe label quads mirror this pass's verdicts into their instance
       buffer (one draw for all of them) */
    if (NS.uAfterLabels) { try { NS.uAfterLabels(); } catch (e) { NS.uAfterLabels = null; } }
    /* raycast with the same current matrices, so the hover target is the thing
       under the cursor in the frame about to be drawn */
    hover();
  }

  /* ---- RTT sparkline -------------------------------------------------
     The prober has 48 h of per-host latency in SQLite but the card could only
     ever say "0.3 ms now". A host that is usually 0.3 ms and is currently 40 ms
     is a completely different story from one that always sits at 40, and only
     the shape tells you which. Fetched once per host and cached: hovering is a
     per-frame event and this is a database query. */
  var _spark = {};        // ip -> {t: fetchedAt, svg: string}
  var SPARK_TTL = 60;

  function sparkFor(ip, base) {
    if (!ip) return '';
    var e = _spark[ip];
    var now = Date.now() / 1000;
    if (e && now - e.t < SPARK_TTL) return e.svg;
    if (e && e.pending) return e.svg || '';
    _spark[ip] = { t: now, pending: true, svg: (e && e.svg) || '' };
    fetch('/api/history?metric=rtt&mins=120&ip=' + encodeURIComponent(ip))
      .then(function (r) { return r.json(); })
      .then(function (rows) {
        _spark[ip] = { t: Date.now() / 1000, pending: false, svg: drawSpark(rows, base) };
      })['catch'](function () { _spark[ip] = { t: Date.now() / 1000, pending: false, svg: '' }; });
    return _spark[ip].svg;
  }

  function drawSpark(rows, base) {
    if (!rows || rows.length < 3) return '';
    var W = 150, H = 22, pts = [], lost = [];
    var vals = rows.map(function (r) { return r.rtt; });
    var ok = vals.filter(function (v) { return v != null; });
    if (ok.length < 3) return '';
    var hi = Math.max.apply(null, ok), lo = Math.min.apply(null, ok);
    if (hi - lo < 0.01) { hi = lo + 0.01; }
    for (var i = 0; i < rows.length; i++) {
      var x = (i / (rows.length - 1)) * W;
      if (rows[i].rtt == null) { lost.push(x); continue; }   // gap = no reply
      var y = H - 1 - ((rows[i].rtt - lo) / (hi - lo)) * (H - 2);
      pts.push(x.toFixed(1) + ',' + y.toFixed(1));
    }
    var drops = lost.map(function (x) {
      return '<rect x="' + x.toFixed(1) + '" y="0" width="1.5" height="' + H
           + '" fill="' + hex(PAL.alert) + '" opacity=".55"/>';
    }).join('');
    /* the 6 h median, so the trace has something to be "above" */
    var ref = '';
    if (base && base.p50 != null && base.p50 >= lo && base.p50 <= hi) {
      var by = (H - 1 - ((base.p50 - lo) / (hi - lo)) * (H - 2)).toFixed(1);
      ref = '<line x1="0" y1="' + by + '" x2="' + W + '" y2="' + by + '" stroke="'
          + hex(PAL.unk) + '" stroke-width=".8" stroke-dasharray="3 3" opacity=".8"/>';
    }
    return '<svg width="' + W + '" height="' + H + '" style="display:block;margin-top:3px">'
         + drops + ref
         + '<polyline points="' + pts.join(' ') + '" fill="none" stroke="'
         + hex(PAL.cyan) + '" stroke-width="1.2" opacity=".9"/>'
         + '</svg><span style="font-size:9px;color:' + hex(PAL.unk) + '">2h &middot; '
         + lo.toFixed(1) + '\u2013' + hi.toFixed(1) + ' ms</span>';
  }

  /* ============================ hover tooltip ============================ */
  /* ============================ details on click ============================
     Section 7 (2026-10-08): the scene carries short names only; everything
     else about a body is ONE clean card, opened by a click (or tap) on it and
     closed by a click on empty space, Escape, or after 12 s. It replaces the
     old hover tooltip. Built from what the screen already holds: the
     /api/universe body (identity, class, measured m.*) and its topology node
     (live rates, latency, cpu, uptime). Absent values are omitted, never shown
     as zero. A click never sets the tour's manual mode. */
  var CARD = { el: null, timer: 0, down: null, key: '' };
  var CLASS_NAME = { pve_host: 'Proxmox host', guest_vm: 'Virtual machine', guest_lxc: 'Container', gateway: 'Gateway',
    'switch': 'Switch', ap: 'Access point', server: 'Server', storage: 'Storage', computer: 'Computer', phone: 'Phone',
    tablet: 'Tablet', tv_av: 'TV / AV', iot: 'Smart home', appliance: 'Appliance', camera: 'Camera', printer: 'Printer',
    game_console: 'Game console', network_device: 'Network device', edge: 'Internet', unknown: 'Unidentified device' };
  var KIND_CLASS = { wan: 'edge', gateway: 'gateway', 'switch': 'switch', ap: 'ap', pvehost: 'pve_host', external: 'network_device' };
  var CAT_ROLE = { ai: 'AI / inference', media: 'Media', network: 'Networking', monitor: 'Monitoring', web: 'Web / apps', infra: 'Infrastructure' };
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function bitsTxt(b) {
    b = +b || 0;
    if (b < 1e3) return b.toFixed(0) + ' b/s';
    if (b < 1e6) return (b / 1e3).toPrecision(3).replace(/\.0+$/, '') + ' kb/s';
    if (b < 1e9) return (b / 1e6).toPrecision(3).replace(/\.0+$/, '') + ' Mb/s';
    return (b / 1e9).toPrecision(3) + ' Gb/s';
  }
  function durTxt(sec) {
    sec = Math.max(0, +sec || 0);
    var d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    return d ? d + ' d ' + h + ' h' : h ? h + ' h ' + m + ' min' : m + ' min';
  }
  function cardDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    CARD.down = { x: e.clientX, y: e.clientY, t: performance.now(), drag: false, tgt: e.target };
  }
  function cardMove(e) {
    var d = CARD.down;
    if (!d || d.drag) return;
    if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 7) { d.drag = true; NS.manualAt = NS.t; closeCard(); }
  }
  function cardUp(e) {
    var d = CARD.down; CARD.down = null;
    if (!d || d.drag || performance.now() - d.t > 800) return;
    var tg = d.tgt;
    if (tg && tg !== NS.rndr.domElement && tg !== document.body && tg !== document.documentElement && tg.id !== 'nblbl') {
      if (CARD.el && CARD.el.contains(tg)) return;        // a click inside the card keeps it
      if (tg.closest && tg.closest('.panel,#chat,input,button,a')) return;
    }
    var hit = pickAt(e.clientX, e.clientY);
    if (hit) openCard(hit, e.clientX, e.clientY); else closeCard();
  }
  /* nearest body on screen within a few px of the click: topology nodes (hubs,
     guests, clients) and the universe-only bodies (no topology node) */
  var _pk = null;
  function pickAt(x, y) {
    if (!_pk) _pk = new THREE.Vector3();
    var W = window.innerWidth, H = window.innerHeight, best = null, bd = 1e9;
    NS.cam.updateMatrixWorld();
    function test(px, py, pz, r, obj, foc) {
      if (foc !== undefined && foc < 0.45) return;
      _pk.set(px, py, pz).project(NS.cam);
      if (_pk.z > 1 || _pk.z < -1) return;
      var sx = (_pk.x * 0.5 + 0.5) * W, sy = (-_pk.y * 0.5 + 0.5) * H, dd = Math.hypot(sx - x, sy - y);
      if (dd < r && dd < bd) { bd = dd; best = obj; }
    }
    for (var i = 0; i < NS.nodes.length; i++) {
      var n = NS.nodes[i]; if (n._alias) continue;
      var infra = isInfra(n) || (n._ub && n._ub.hub);
      test(n._cx, n._cy, n._cz, infra ? 24 : 15, { n: n, b: n._ub || (uni() && uni().bodyOfTopo ? uni().bodyOfTopo(n.id) : null) }, n._foc);
    }
    var UNI = window.NETUNI;
    if (UNI && UNI.U && UNI.U.insts && UNI.G && UNI.G.pos) {
      var P = UNI.G.pos, F = UNI.G.foc;
      for (var k = 0; k < UNI.U.insts.length; k++) {
        var it = UNI.U.insts[k]; if (it.node) continue;
        test(P[k * 3], P[k * 3 + 1], P[k * 3 + 2], 15, { n: null, b: it.b }, F ? F[k] : 1);
      }
    }
    return best;
  }
  function cardCss() {
    if (document.getElementById('nbcard-css')) return;
    var st = document.createElement('style'); st.id = 'nbcard-css';
    st.textContent = [
      '#nbcard{position:fixed;z-index:30;width:300px;pointer-events:auto;font:400 12px/1.5 var(--ui-font,Inter,system-ui,sans-serif);',
      '  color:var(--t1,#e6e9ee);background:rgba(16,19,24,.94);border:1px solid rgba(255,255,255,.10);border-radius:6px;',
      '  box-shadow:0 8px 24px rgba(0,0,0,.45);padding:10px 12px 8px;opacity:0;transform:translateY(4px);',
      '  transition:opacity .18s ease,transform .18s ease;font-variant-numeric:tabular-nums;letter-spacing:0}',
      '#nbcard.on{opacity:1;transform:none}',
      '#nbcard .hd{display:flex;align-items:baseline;gap:8px;margin-bottom:2px}',
      '#nbcard .nm{font-size:14px;font-weight:500;color:var(--t1,#e6e9ee);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}',
      '#nbcard .cst{font-size:11px;color:var(--t2,#a3acb9);white-space:nowrap;display:flex;align-items:center;gap:5px;flex:0 0 auto}',
      '#nbcard .cst i{width:8px;height:8px;border-radius:50%;display:inline-block;background:#6e7681}',
      '#nbcard .cst i.up{background:var(--ok,#3fb950)} #nbcard .cst i.down{background:var(--crit,#f85149)}',
      '#nbcard .cst i.idle{background:var(--warn,#d29922)} #nbcard .cst i.unknown{background:#6e7681}',
      '#nbcard .sub{font-size:12px;color:var(--t2,#a3acb9);margin-bottom:6px}',
      '#nbcard .g{border-top:1px solid rgba(255,255,255,.08);padding-top:5px;margin-top:5px}',
      '#nbcard .r{display:flex;justify-content:space-between;gap:12px;line-height:20px}',
      '#nbcard .r span{color:var(--t2,#a3acb9);white-space:nowrap}',
      '#nbcard .r b{font-weight:400;color:var(--t1,#e6e9ee);text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '#nbcard .r b.mono{font-family:"JetBrains Mono","DejaVu Sans Mono",ui-monospace,monospace;font-size:12px}',
      '#nbcard .r b.bad{color:var(--crit,#f85149)} #nbcard .r b.warn{color:var(--warn,#d29922)}'
    ].join('\n');
    document.head.appendChild(st);
  }
  function closeCard() {
    if (CARD.timer) { clearTimeout(CARD.timer); CARD.timer = 0; }
    if (CARD.el) CARD.el.classList.remove('on');
    CARD.key = '';
  }
  function openCard(hit, x, y) {
    cardCss();
    if (!CARD.el) { CARD.el = document.createElement('div'); CARD.el.id = 'nbcard'; document.body.appendChild(CARD.el); }
    var n = hit.n, b = hit.b, m = (b && b.m) || {}, meta = (n && n.meta) || {};
    var cls = (b && b['class']) || (n && (n.kind === 'guest' ? (meta.type === 'qemu' ? 'guest_vm' : 'guest_lxc') : n.kind === 'client' ? 'unknown' : KIND_CLASS[n.kind])) || 'unknown';
    var name = (b && b.label) || (n && (n.label || n.id)) || '?';
    if (n && n.kind === 'wan') name = 'Internet · ' + (n.label || 'ISP');
    var status = (b && b.status) || (n && n.status) || 'unknown';
    if (n && n.meta && n.meta.offline) status = 'idle';
    var U = uni(), sy = (b && U && U.sysOf) ? U.sysOf(b) : (n && n._uSys) || null;
    var rows = [], g2 = [], g3 = [];
    function row(arr, k, v, cls2) { if (v === undefined || v === null || v === '') return; arr.push('<div class="r"><span>' + esc(k) + '</span><b' + (cls2 ? ' class="' + cls2 + '"' : '') + '>' + esc(v) + '</b></div>'); }
    /* identity */
    /* recording-safe (hero.js, P): no addresses on screen even on demand */
    var safe = document.body.classList.contains('privacy');
    var ip = m.ip || (n && n.ip);
    if (!safe) row(rows, 'IP address', ip, 'mono');
    var mac = b && /^mac:/.test(b.id) ? b.id.slice(4) : (n && /^client:/.test(n.id) ? n.id.slice(7) : null);
    if (!safe) row(rows, 'MAC', mac, 'mono');
    row(rows, 'Vendor', m.vendor || meta.vendor || meta.model);
    var par = null;
    if (b && b.parent && U && U.byId && U.byId[b.parent]) par = shortName(U.byId[b.parent].label, U.byId[b.parent]) || U.byId[b.parent].label;
    else if (n && n.parent && NS.byId[n.parent]) par = NS.byId[n.parent].kind === 'wan' ? 'Internet (' + (NS.byId[n.parent].label || 'ISP') + ')' : (shortName(NS.byId[n.parent].label, NS.byId[n.parent]._ub) || NS.byId[n.parent].label);
    var port = meta.port != null ? meta.port : m.uplink_port;
    row(rows, 'Connected to', par ? par + (port != null ? ' · port ' + port : '') : null);
    /* health */
    var rtt = m.rtt_ms != null ? m.rtt_ms : meta.rtt, loss = m.loss != null ? m.loss : meta.loss;
    if (rtt != null) row(g2, 'Latency', (+rtt).toPrecision(2).replace(/\.?0+$/, '') + ' ms' + (loss ? ' · ' + loss + ' % loss' : ''), loss >= 100 ? 'bad' : loss ? 'warn' : '');
    else if (loss >= 100) row(g2, 'Latency', 'no reply', 'bad');
    var cpu = m.cpu_pct != null ? m.cpu_pct : meta.cpu, mem = m.mem_pct != null ? m.mem_pct : meta.mem_pct;
    if (cpu != null || mem != null) row(g2, 'CPU / memory', (cpu != null ? (+cpu).toFixed(cpu < 10 ? 1 : 0) + ' %' : '–') + ' / ' + (mem != null ? (+mem).toFixed(0) + ' %' : '–'));
    if (meta.up) row(g2, 'Uptime', durTxt(meta.up));
    else if (b && b.last_seen && status !== 'up') row(g2, 'Last seen', durTxt(Date.now() / 1000 - b.last_seen) + ' ago');
    /* traffic: bits/s (universe m.* are bits/s; topology rx/tx are bytes/s) */
    var rx = m.rx_bps != null ? m.rx_bps : (n && n.measured && n.rx != null ? n.rx * 8 : null);
    var tx = m.tx_bps != null ? m.tx_bps : (n && n.measured && n.tx != null ? n.tx * 8 : null);
    if (rx != null || tx != null) row(g3, 'Traffic in / out', bitsTxt(rx) + ' / ' + bitsTxt(tx));
    /* role: what it does */
    var role = null;
    if (cls === 'guest_vm' || cls === 'guest_lxc') role = CAT_ROLE[(b && b.cat) || meta.cat] || null;
    else if (b && b.hub || (n && isInfra(n) && n.kind !== 'wan')) {
      var kids = 0; (U && U.bodies || []).forEach(function (q) { if (b && q.parent === b.id) kids++; });
      if (!kids && n) NS.nodes.forEach(function (q) { if (q.parent === n.id) kids++; });
      if (kids) role = kids + ' connected device' + (kids === 1 ? '' : 's');
    }
    if (cls === 'pve_host' && sy) role = (sy.count - 1) + ' guests';
    row(g3, 'Role', role);
    var stTxt = { up: 'Up', down: 'Down', idle: 'Asleep', unknown: 'Unknown' }[status] || status;
    var h = '<div class="hd"><div class="nm">' + esc(name) + '</div><div class="cst"><i class="' + esc(status) + '"></i>' + esc(stTxt) + '</div></div>'
          + '<div class="sub">' + esc((CLASS_NAME[cls] || cls) + (sy ? ' · ' + sysName(sy) : '')) + '</div>';
    if (rows.length) h += '<div class="g">' + rows.join('') + '</div>';
    if (g2.length) h += '<div class="g">' + g2.join('') + '</div>';
    if (g3.length) h += '<div class="g">' + g3.join('') + '</div>';
    CARD.el.innerHTML = h;
    /* beside the click, kept inside the safe area */
    var W = window.innerWidth, H = window.innerHeight, cw = 300, chh = CARD.el.offsetHeight || 200;
    var left = x + 18, top = y - 20;
    if (left + cw > W - 24) left = x - cw - 18;
    if (top + chh > H - 90) top = H - 90 - chh;
    if (top < 90) top = 90;
    CARD.el.style.left = Math.round(Math.max(24, left)) + 'px'; CARD.el.style.top = Math.round(top) + 'px';
    CARD.el.classList.add('on');
    CARD.key = (b && b.id) || (n && n.id) || '';
    if (CARD.timer) clearTimeout(CARD.timer);
    CARD.timer = setTimeout(closeCard, 12000);
  }
  /* the old hover tooltip is retired in favour of the card */
  function hover() { }
})();
