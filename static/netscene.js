/* ============================================================================
   netscene.js — live network-topology scene for the homelab wall dashboard
   A data-driven view of the real
   UniFi/Proxmox network: WAN -> UDM -> switches/AP -> PVE hosts -> guests,
   with traffic animated along the real physical links only.

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
  var CAT = { ai: 0xff4fa3, media: 0x38e1ff, network: 0x37f5a0, monitor: 0xffb347, web: 0x9b8cff, infra: 0x8fb0d0 };
  var KIND_ORDER = { wan: 0, gateway: 1, switch: 2, ap: 3, pvehost: 4, external: 5, guest: 6, client: 7 };

  /* ---------------- tunables ---------------- */
  // TIER_X was 168: five tiers made a ~700-unit spine hanging off a ~76-unit
  // guest cube, so the graph read as a long thin tail with all its mass at one
  // end. Compressing the spine squares the silhouette, which also lets the
  // camera sit closer and every node render larger.
  var TIER_X = 120, LEAF_SP = 19, GAP = 30, MIN_SPAN = 52;
  var P_CAP = 4096;
  var TRUNK_MAXP = 26, LEAF_MAXP = 6;
  var LANE = 6.5;                       // half-gap between rx and tx lanes
  var CAM_EL = 0.60;                   // camera elevation (rad)
  var VOFF_X = 0.0052, VOFF_Y = 0.0676; // frustum shift: puts the camera axis
                                        // on the HUD-safe box centre (950,467)

  function applyViewOffset() {
    if (!NS || !NS.cam) return;
    var W = window.innerWidth, H = window.innerHeight;
    NS.cam.setViewOffset(W, H, Math.round(VOFF_X * W), Math.round(VOFF_Y * H), W, H);
  }
  var CAM_PERIOD = 88;                  // seconds per full orbit sway
  var CAM_SWAY = 0.26;                  // rad of azimuth sway
  var MANUAL_HOLD = 25;                 // s of user control before auto-cam resumes
  var CAT_GAP = 27;                     // gap between guest category blocks

  /* ---- auto-tour timings (see tourTick) ---- */
  var T_HOLD = 6.0;                     // s dwell at a focused stop
  var T_HOLD_OVER = 8.5;                // s dwell at the overview
  var T_SWAY = 0.045;                   // rad azimuth sway while holding a stop
  var T_SWAY_PERIOD = 46;               // s period of that sway
  var ECO_WIDE = 1.22;                  // pull every focused stop back: show the
                                        // subject IN the context of the wider ecosystem
  var FOC_FLOOR = 0.17;                 // off-subject nodes never fully vanish - the
                                        // whole network stays a dim backdrop constellation

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
  var NS = null;
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
      if (o.geometry) o.geometry.dispose();
      var ms = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
      ms.forEach(function (m) { if (m.map) m.map.dispose(); m.dispose(); });
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
      up: new THREE.Vector3(0, 1, 0), t: 0
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
    addEventListener('pointerdown', function () { NS.manualAt = NS.t; });
    addEventListener('wheel', function () { NS.manualAt = NS.t; });

    window.netSceneUpdate = netSceneUpdate;
    window.netSceneTick = netSceneTick;
    window.NETSCENE = NS;
    /* for overlays (netscene_flows.js): 1 = node fully shown, 0 = hidden by
       the tour's focus. NS.focusAll === false while a close-up is framed. */
    NS.nodeFocus = function (id) {
      var n = NS.byId[id];
      return !n || n._foc === undefined ? 1 : n._foc;
    };

    /* self-poll fallback; harmless if /api/all already pushes d.topology */
    setInterval(function () {
      try {
        fetch('/api/topology').then(function (r) { return r.ok ? r.json() : null; })
          .then(function (j) { if (j && j.nodes) netSceneUpdate(j); }).catch(function () { });
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
    g.add(grid);

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
  }

  /* ============================ labels ============================ */
  function textSprite(lines, wWorld, opts) {
    opts = opts || {};
    var W = 704, H = lines.length > 1 ? 132 : 64;
    var cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    var x = cv.getContext('2d'); x.textAlign = 'center'; x.textBaseline = 'middle';
    var y = lines.length > 1 ? 38 : H / 2;
    x.shadowColor = 'rgba(2,5,11,0.95)'; x.shadowBlur = 7;
    lines.forEach(function (ln) {
      x.font = (ln.bold ? '700 ' : '500 ') + (ln.size || 30) + 'px ui-monospace,Consolas,monospace';
      x.fillStyle = ln.color || '#d6ecff';
      x.fillText(ln.text, W / 2, y); y += 56;
    });
    var t = new THREE.CanvasTexture(cv); t.minFilter = THREE.LinearFilter;
    var s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false, depthTest: opts.depthTest !== false }));
    s.scale.set(wWorld, wWorld * H / W, 1);
    s.userData.fade = opts.fade || null;   // {near, far} distance fade
    NS.labels.push(s);
    return s;
  }

  /* a redrawable rate label for trunk links: rates + switch port, on a dark
     plate so the text survives whatever the starfield puts behind it */
  function rateLabel() {
    var W = 512, H = 92, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    var x = cv.getContext('2d');
    var t = new THREE.CanvasTexture(cv); t.minFilter = THREE.LinearFilter;
    var s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false, depthTest: false }));
    s.scale.set(112, 112 * H / W, 1);
    var last = '';
    s.userData.setText = function (down, upv, known, port) {
      var key = (known ? (fmtRate(down) + '|' + fmtRate(upv)) : 'nd') + '|' + port;
      if (key === last) return; last = key;
      x.clearRect(0, 0, W, H); x.textBaseline = 'middle';
      x.font = '600 36px ui-monospace,Consolas,monospace';
      var l1w = known
        ? x.measureText('↓ ' + fmtRate(down) + '  ↑ ' + fmtRate(upv)).width
        : x.measureText('no data').width;
      var l2 = port != null ? 'port ' + port : null;
      var pw = Math.min(W, l1w + 34), ph = l2 ? 88 : 54;
      x.fillStyle = 'rgba(3,9,17,0.72)';
      x.fillRect((W - pw) / 2, (H - ph) / 2, pw, ph);
      var y1 = l2 ? 30 : H / 2;
      if (!known) { x.textAlign = 'center'; x.fillStyle = '#5a6a7c'; x.fillText('no data', W / 2, y1); }
      else {
        x.textAlign = 'right'; x.fillStyle = hex(PAL.cyan); x.fillText('↓ ' + fmtRate(down), W / 2 - 8, y1);
        x.textAlign = 'left'; x.fillStyle = hex(PAL.magenta); x.fillText('↑ ' + fmtRate(upv), W / 2 + 8, y1);
      }
      if (l2) {
        x.textAlign = 'center'; x.font = '500 26px ui-monospace,Consolas,monospace';
        x.fillStyle = '#7fa3c8'; x.fillText(l2, W / 2, 66);
      }
      t.needsUpdate = true;
    };
    NS.rateLabels.push(s);
    return s;
  }

  /* Floating callouts naming the busiest guests. A 64-box lattice shows you
     THAT something is working; these say which one and at what. Text is only
     redrawn when it actually changes (canvas uploads are not free). */
  var HOT_MIN = 1.0;          // % cpu below this is noise, not work

  function workLabel() {
    var W = 512, H = 88, cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    var x = cv.getContext('2d');
    var t = new THREE.CanvasTexture(cv); t.minFilter = THREE.LinearFilter;
    var sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: t, transparent: true, depthWrite: false, depthTest: false
    }));
    sp.scale.set(150, 150 * H / W, 1);
    sp.visible = false;
    var last = '';
    sp.userData.setText = function (name, cpu, io, mem) {
      var line2 = 'cpu ' + Number(cpu).toFixed(1) + '%'
        + (mem != null ? ' · mem ' + Number(mem).toFixed(0) + '%' : '')
        + (io > 0 ? ' · io ' + fmtIO(io) : '');
      var key = name + '|' + line2;
      if (key === last) return; last = key;
      x.clearRect(0, 0, W, H);
      x.textBaseline = 'middle'; x.textAlign = 'left';
      x.shadowColor = 'rgba(2,5,11,0.95)'; x.shadowBlur = 9;
      x.font = '700 30px ui-monospace,Consolas,monospace';
      x.fillStyle = '#eaf6ff'; x.fillText(name, 6, 26);
      x.font = '600 23px ui-monospace,Consolas,monospace';
      x.fillStyle = hex(PAL.warn); x.fillText(line2, 6, 62);
      t.needsUpdate = true;
    };
    return sp;
  }

  var _sv = null;
  function spriteRect(sp, x, y, z, fovScale) {
    if (!_sv) _sv = new THREE.Vector3();
    _sv.set(x, y, z);
    var dist = NS.cam.position.distanceTo(_sv);
    if (dist < 1) return null;
    _sv.project(NS.cam);
    if (_sv.z > 1) return null;                        // behind the camera
    var W = window.innerWidth, H = window.innerHeight;
    var sx = (_sv.x * 0.5 + 0.5) * W, sy = (-_sv.y * 0.5 + 0.5) * H;
    var hw = (sp.scale.x * 0.5) * fovScale / dist;
    var hh = (sp.scale.y * 0.5) * fovScale / dist;
    return { x0: sx - hw, x1: sx + hw, y0: sy - hh, y1: sy + hh };
  }
  function rectsOverlap(a, b) {
    return !(a.x1 < b.x0 || b.x1 < a.x0 || a.y1 < b.y0 || b.y1 < a.y0);
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
  function computeLayout(topo) {
    var byId = {}, kids = {}, i;
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
      var p = (n.parent && byId[n.parent]) ? n.parent
        : (linkPeer[n.id] && byId[linkPeer[n.id]] && linkPeer[n.id] !== n.id) ? linkPeer[n.id] : root.id;
      n._par = p;
      (kids[p] = kids[p] || []).push(n);
    });
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
      all.forEach(function (k) { (k.kind === 'guest' || k.kind === 'client' ? leaf : infra).push(k); });
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
      return (spanMemo[n.id] = Math.max(MIN_SPAN, tot));
    }
    function place(n, z) {
      n._x = n._depth * TIER_X;
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
        if (it.node) place(it.node, c);
        else if (isGuests) {
          /* category grid: gcols cells across Z, overflow rows stepping +X */
          var plan = blk, x0 = n._x + TIER_X * 0.62;
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
              k._lstag = (col + 2 * row) % 3;
              k._bcx = bx + (B.rows - 1) * LEAF_SP / 2; k._bcy = 0; k._bcz = bz;
            });
            caps.push({
              txt: B.cat.toUpperCase() + ' · ' + B.list.length,
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
            k._x = n._x + TIER_X * 0.62 + row * LEAF_SP;
            k._y = (lay - (blk.lays - 1) / 2) * LEAF_SP
                 + ((k.kind === 'client' && n.kind === 'ap') ? 26 : 0);
            k._lstag = (col + lay) % 2;
            if (n.kind !== 'ap') {
              k._bcx = n._x + TIER_X * 0.62 + ((blk.rows - 1) / 2) * LEAF_SP;
              k._bcy = 0; k._bcz = c;
            }
          });
          if (s.leaf[0].kind === 'client' && n.kind !== 'ap' && s.leaf.length >= 3) {
            n._clientBlock = s.leaf.slice();
            caps.push({
              txt: (n.label || n.id).toUpperCase() + ' · WIRED × ' + s.leaf.length,
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

    // recentre on origin (category captions shift with their blocks)
    var bb = new THREE.Box3();
    topo.nodes.forEach(function (n) { bb.expandByPoint(NS.tmpV.set(n._x, n._y, n._z)); });
    var c = bb.getCenter(new THREE.Vector3());
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
    var t = new THREE.CanvasTexture(cv); t.minFilter = THREE.LinearFilter;
    return t;
  }

  function accentFor(n) {
    if (n.status === 'down') return PAL.alert;
    if (n.status === 'unknown') return PAL.unk;
    var cat = n.meta && n.meta.cat;
    if (cat && CAT[cat]) return CAT[cat];
    return { wan: PAL.cyan, gateway: PAL.cyan, switch: PAL.cyan, ap: 0x9b8cff, pvehost: PAL.ok, external: PAL.warn }[n.kind] || PAL.dim;
  }

  function makeInfraNode(n) {
    var G = geos(), grp = new THREE.Group(), acc = accentFor(n);
    var body, edge;
    if (n.kind === 'wan') {
      body = new THREE.Mesh(G.wanCore, new THREE.MeshStandardMaterial({ color: 0x0c2030, roughness: 0.4, metalness: 0.3, emissive: 0x0a2436, emissiveIntensity: 0.6 }));
      var wire = new THREE.Mesh(G.wanWire, new THREE.MeshBasicMaterial({ color: acc, wireframe: true, transparent: true, opacity: 0.5 }));
      grp.add(body, wire);
      n._h = 25;
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
      n._h = { gateway: 7, switch: 6, pvehost: 16, ap: 3, external: 8 }[n.kind] || 8;
    }
    n._r = { wan: 22, gateway: 26, switch: 23, pvehost: 19, ap: 14, external: 14 }[n.kind] || 14;
    grp.position.set(n._x, n._y, n._z);
    body.userData.nsId = n.id;
    NS.pick.push(body);
    n._grp = grp; n._body = body; n._edge = edge || null;

    if (n.status === 'down') addAlertRing(n, grp);

    var sub = n.ip || '';
    var lbl = textSprite([
      { text: n.label || n.id, size: 52, bold: true, color: n.status === 'down' ? hex(PAL.alert) : '#e2f2ff' },
      { text: sub, size: 34, color: '#7fa3c8' }
    ], n.kind === 'wan' || n.kind === 'gateway' ? 130 : (n.kind === 'external' ? 88 : 116), { depthTest: false });
    lbl.position.set(n._x, n._y + (n.kind === 'external' ? -(n._h + 22) : n._h + 18), n._z);
    lbl.userData.focN = n;
    NS.graph.add(lbl);
    n._lbl = lbl;
    return grp;
  }

  function addAlertRing(n, grp) {
    var ring = new THREE.Mesh(geos().ring, new THREE.MeshBasicMaterial({ color: PAL.alert, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false }));
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

  function guestColor(n) {
    var c = new THREE.Color();
    if (n.status === 'down') { c.setHex(0x96242f); return c; }
    if (n.status === 'unknown') { c.setHex(0x39465a); return c; }
    c.setHex(CAT[(n.meta && n.meta.cat) || 'infra'] || 0x8fb0d0);
    var u = loadU(n);
    if (u === null) { c.multiplyScalar(0.55); return c; }   // running, load unknown
    c.multiplyScalar(0.40 + 0.95 * u);
    if (u > 0.55) c.lerp(HOT, (u - 0.55) / 0.45 * 0.5);
    return c;
  }

  function guestScale(n) {
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
      NS.scene.remove(NS.graph); disposeDeep(NS.graph);
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

    /* small labels for guests & near clients (distance-faded, focus-aware).
       Bigger type than v1: they only materialise when the tour flies close,
       so overview clutter is unaffected. Neighbouring labels stagger in Y
       (checkerboard) so a 19-unit grid doesn't smear into one line of ink. */
    guests.concat(clients).forEach(function (n) {
      var l = textSprite([{ text: n.label || n.id, size: 44, color: n.status === 'down' ? hex(PAL.alert) : '#bcdcf5' }], 58, { fade: { near: 340, far: 640 } });
      l.position.set(n._x, n._y + 9.5 + 5.5 * (n._lstag || 0), n._z);
      l.userData.focN = n;
      NS.graph.add(l); n._lbl = l;
    });

    /* category captions over each guest block: the lattice explains itself */
    (NS.layoutCaps || []).forEach(function (cp) {
      var s = textSprite([{ text: cp.txt, size: 46, bold: true, color: cp.col }], 100, { depthTest: false });
      s.position.set(cp.x, cp.y, cp.z);
      s.userData.focList = cp.list;
      NS.graph.add(s);
      cp.spr = s;
    });

    buildLinks(topo);

    NS.hotLabels = []; NS.hotLeaders = [];
    for (var hli = 0; hli < 3; hli++) {
      var hl = workLabel(); NS.graph.add(hl); NS.hotLabels.push(hl);
      var lg = new THREE.BufferGeometry();
      lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3)
        .setUsage(THREE.DynamicDrawUsage));
      var ll = new THREE.Line(lg, new THREE.LineBasicMaterial({
        color: PAL.warn, transparent: true, opacity: 0.34, depthWrite: false
      }));
      ll.frustumCulled = false; ll.visible = false;
      NS.graph.add(ll); NS.hotLeaders.push(ll);
    }

    /* camera fit: frame the graph inside the HUD-free centre */
    bb.getCenter(NS.center); NS.center.x -= 14;
    var exX = (bb.max.x - bb.min.x) / 2 + 60, exZ = (bb.max.z - bb.min.z) / 2 + 40;
    // guest blocks now have real height, so vertical extent is no longer just
    // the tilted depth -- ignoring exY would push the lattice out of frame
    var exY = (bb.max.y - bb.min.y) / 2 + 26;
    var vf = NS.cam.fov * Math.PI / 360, ta = Math.tan(vf) * NS.cam.aspect;
    // horizontal: keep inside centre ~62% of screen width; vertical: ~62% of height
    var FRAC_X = 0.649, FRAC_Y = 0.589;  // fraction of the viewport the graph may fill
    // (retuned 2026-08-22 for the narrowed HUD-safe box x 400-1500, y 129-805)
    // NB: tuned against the measured worst-case footprint over a full 88 s
    // orbit INCLUDING label sprite widths -- node centres alone under-read it
    // by ~100 px and the WAN label clipped behind the left HUD panel.
    var azMax = CAM_SWAY + 0.06;
    var dH = (exX * Math.cos(azMax) + exZ * Math.sin(azMax)) / (ta * FRAC_X);
    var dV = (exZ * Math.sin(CAM_EL) + exY * Math.cos(CAM_EL) + 44) / (Math.tan(vf) * FRAC_Y);
    NS.fitDist = Math.max(dH, dV, 480);
    applyViewOffset();
    NS.tweenUntil = NS.t + (hadOld ? 1.6 : 0);
    NS.needSettle = true;
    NS.nodes.forEach(function (n) { n._foc = 1; n._focT = 1; });
    NS.focusAll = true; NS.focusAnim = false;
    buildTour();
    syncNodeTransforms(hadOld ? 0.1 : 1);
    updateLinkGeometry(true);
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
        L.mat = new THREE.MeshBasicMaterial({ color: PAL.linkDim, transparent: true, opacity: 0.95 });
        L.mesh = new THREE.Mesh(G.cyl, L.mat);
        NS.graph.add(L.mesh);
        L.lbl = rateLabel(); L.lbl.userData.focL = L; NS.graph.add(L.lbl);
      } else if (L.arc) {
        var SEG = 13;
        L.set = 'arc'; L.vStart = arcV.length / 3; L.vCount = SEG * 2;
        for (var s = 0; s < SEG * 2; s++) arcV.push(0, 0, 0);
        arcMap.push(L);
        if (L.trunk) { L.lbl = rateLabel(); L.lbl.userData.focL = L; NS.graph.add(L.lbl); }
      } else {
        L.set = 'line'; L.vStart = straightV.length / 3; L.vCount = 2;
        straightV.push(0, 0, 0, 0, 0, 0);
        straightMap.push(L);
      }
    });

    function mkLineSet(verts, dashed) {
      var g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3).setUsage(THREE.DynamicDrawUsage));
      if (!dashed) {
        var col = new Float32Array(verts.length);
        g.setAttribute('color', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
      }
      var m = dashed
        ? new THREE.LineDashedMaterial({ color: 0x6d7f94, dashSize: 6, gapSize: 5, transparent: true, opacity: 0.75 })
        : new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 1.0 });
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
      }
      if (n._lbl && n.status === 'down') n._lbl.material.color = new THREE.Color(1, 0.55, 0.6);
    });
    if (NS.guestIM && NS.guestIM.instanceColor) NS.guestIM.instanceColor.needsUpdate = true;
    if (NS.clientIM && NS.clientIM.instanceColor) NS.clientIM.instanceColor.needsUpdate = true;

    /* size follows load too; alpha 0 rewrites the matrices without disturbing
       an in-flight position tween */
    NS.nodes.forEach(function (n) { if (n._inst) n._scl = guestScale(n); });
    syncNodeTransforms(0);
    updateHotLabels();

    restyleLinks();
    updateLinkGeometry(true);
    allocParticles();
  }

  /* links: colour, thickness, rate labels — all multiplied by tour focus
     (merged line sets can't toggle per-segment visibility, but multiplying
     a line's colour to black on this background removes it just as well) */
  function restyleLinks() {
    var lineCol = NS.lineSet ? NS.lineSet.geometry.attributes.color.array : null;
    var arcCol = NS.arcSet ? NS.arcSet.geometry.attributes.color.array : null;
    var dashF = 0;
    NS.links.forEach(function (L) {
      var lf = linkFocus(L);
      L._lf = lf;
      if (!L.measured) { dashF = Math.max(dashF, lf); return; }
      var u = bpsNorm(L.data.bps);
      var child = NS.byId[L.childId];
      var known = child && child.measured;
      if (L.mesh) {
        _cDim.setHex(PAL.linkDim); _cHot.setHex(PAL.linkHot);
        L.mat.color.copy(_cDim).lerp(_cHot, u);
        L.mat.opacity = 0.95 * lf;
        L.mesh.visible = lf > 0.02;
        L.mesh.userData.r = 0.8 + 3.4 * u;
        L.mesh.scale.x = L.mesh.scale.z = L.mesh.userData.r;
      } else if (L.set === 'line' && lineCol) {
        _cDim.setHex(PAL.leafDim); _cHot.setHex(PAL.leafHot);
        _cTmp.copy(_cDim).lerp(_cHot, u).multiplyScalar(lf);
        for (var k = 0; k < 6; k += 3) { var o = L.vStart * 3 + k; lineCol[o] = _cTmp.r; lineCol[o + 1] = _cTmp.g; lineCol[o + 2] = _cTmp.b; }
      } else if (L.set === 'arc' && arcCol) {
        _cDim.setHex(0x27334e); _cHot.setHex(0xa9b4ff);
        _cTmp.copy(_cDim).lerp(_cHot, u).multiplyScalar(lf);
        for (var k2 = 0; k2 < L.vCount; k2++) { var o2 = (L.vStart + k2) * 3; arcCol[o2] = _cTmp.r; arcCol[o2 + 1] = _cTmp.g; arcCol[o2 + 2] = _cTmp.b; }
      }
      if (L.lbl) L.lbl.userData.setText(known ? child.rx : 0, known ? child.tx : 0, !!known,
        child && child.meta ? child.meta.port : null);
    });
    if (NS.lineSet) NS.lineSet.geometry.attributes.color.needsUpdate = true;
    if (NS.arcSet) NS.arcSet.geometry.attributes.color.needsUpdate = true;
    if (NS.dashSet) NS.dashSet.material.opacity = 0.75 * dashF;
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
  function applyParticleFocus() {
    var n = NS.pActive;
    for (var s = 0; s < n; s++) {
      var L = NS.links[NS.pLink[s]];
      var f = L && L._lf !== undefined ? L._lf : 1;
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
    var rate = (50 + 240 * u) / L.len;
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
      if (pr >= 1) pr -= 1;
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
    }
    NS.pGeo.attributes.position.needsUpdate = true;
  }

  /* ============================ node transform sync (tween) ============================ */
  function syncNodeTransforms(alpha) {
    var touchedG = false, touchedC = false;
    NS.nodes.forEach(function (n) {
      var sp = n._sprd || 0;
      var tx = n._x + (sp ? sp * SPR_L * (n._x - n._bcx) : 0);
      var ty = n._y + (sp ? sp * SPR_V * (n._y - n._bcy) : 0);
      var tz = n._z + (sp ? sp * SPR_L * (n._z - n._bcz) : 0);
      n._cx += (tx - n._cx) * alpha; n._cy += (ty - n._cy) * alpha; n._cz += (tz - n._cz) * alpha;
      if (n._grp) n._grp.position.set(n._cx, n._cy, n._cz);
      if (n._lbl) n._lbl.position.set(n._cx, n._cy + (n.kind === 'external' ? -((n._h || 8) + 22) : ((n._h || 4) + (n._grp ? 18 : 5.5) + 5.5 * (n._lstag || 0))), n._cz);
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

  function setFocus(ids, spreadIds) {         // ids: {nodeId:1} or null = all
    NS.focusAll = !ids;
    NS.nodes.forEach(function (n) {
      n._focT = (!ids || ids[n.id]) ? 1 : FOC_FLOOR;
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

  /* focus set for travelling from stop a to stop b: their UNION — both
     subjects stay materialised for the whole flight so a frame caught
     mid-transition is never empty (video rule: no dead air).
     null = everything (any leg that touches the overview). */
  function unionFocus(a, b) {
    if (!a.ids || !b.ids) return null;
    var f = {}, k;
    for (k in a.ids) f[k] = 1;
    for (k in b.ids) f[k] = 1;
    return f;
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

  function focusTick(dt) {
    if (!NS.focusAnim) return;
    var a = 1 - Math.exp(-dt * 4.0), moving = 0;
    NS.nodes.forEach(function (n) {
      var tgt = n._focT === undefined ? 1 : n._focT;
      var f0 = n._foc === undefined ? 1 : n._foc;
      var f = f0 + (tgt - f0) * a;
      if (Math.abs(f - tgt) < 0.012) f = tgt; else moving++;
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
    var dH = w / (ta * 0.649) + dep;
    var dV = (dep * Math.sin(st.el) + ey * Math.cos(st.el)) / (Math.tan(vf) * 0.589) + dep;
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
    var stops = [key({ name: 'OVERVIEW', ids: null }, 'over:0')];
    if (wan || gw) stops.push(key(mkStop('WAN EDGE', [wan, gw].filter(Boolean), -0.5, 0.62, false, 0.46), 'wan'));
    /* switch fabric; small wired groups (<3 clients) ride along */
    var fab = [gw].concat(K.switch || [], K.pvehost || []).filter(Boolean);
    var wired = [];
    [gw].concat(K.switch || []).filter(Boolean).forEach(function (sw) {
      if (sw._clientBlock) wired.push(sw);
      else (K.client || []).forEach(function (c) { if (c.parent === sw.id) fab.push(c); });
    });
    if ((K.switch || []).length > 0) stops.push(key(mkStop('SWITCH FABRIC', fab, -0.15, 0.72, false, 0.68), 'fabric'));
    /* wired client blocks: framed alone (their switch sits hundreds of units
       away — including it turns the stop into an unreadable wide shot; the
       block's caption names the switch instead) */
    wired.forEach(function (sw) {
      stops.push(key(mkStop((sw.label || sw.id).toUpperCase() + ' · WIRED (' + sw._clientBlock.length + ')',
                            sw._clientBlock, -0.3, 0.62, true, 0.55), 'wired:' + sw.id));
    });
    (K.ap || []).forEach(function (ap) {
      var cl = (K.client || []).filter(function (c) { return c.parent === ap.id; });
      if (cl.length) stops.push(key(mkStop('WIRELESS · ' + (ap.label || 'AP').toUpperCase(), [ap].concat(cl), 0.35, 0.78, false, 0.40), 'ap:' + ap.id));
    });
    stops.push(key({ name: 'OVERVIEW', ids: null }, 'over:1'));
    (K.pvehost || []).forEach(function (h) {
      var blocks = h._tourBlocks || [], total = 0;
      blocks.forEach(function (B) { total += B.list.length; });
      var hn = (h.label || h.id).toUpperCase();
      if (total && total <= 9) {
        var lst = [h];
        blocks.forEach(function (B) { lst = lst.concat(B.list); });
        stops.push(key(mkStop('PVE ' + hn + ' · ' + total + ' GUESTS', lst, 1.15, 0.58, false, 0.52), 'host:' + h.id));
      } else {
        blocks.forEach(function (B) {
          stops.push(key(mkStop(hn + ' · ' + B.cat.toUpperCase() + ' (' + B.list.length + ')', B.list, 1.05, 0.66, true, 0.70),
                     'blk:' + h.id + ':' + B.cat));
        });
      }
    });
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
      if (iCur >= 0) {
        T.idx = iCur; T.phase = prev.phase; T.t0 = prev.t0; T.tHold = prev.tHold;
        T.next = iNxt >= 0 ? iNxt : (iCur + 1) % stops.length;
        T.P0.copy(prev.P0); T.T0.copy(prev.T0);
        T.travelT = prev.travelT; T.manual = prev.manual;
        T.switched = prev.switched; T.arcH = prev.arcH || 0;
        var here = stops[T.idx], there = stops[T.next];
        if (T.manual) forceFocus(null);
        else if (T.phase === 'hold') forceFocus(here.ids || null, stopSpread(here));
        else if (T.switched) forceFocus(there.ids || null, stopSpread(there));
        else forceFocus(unionFocus(here, there), unionSpread(here, there));
      }
    }
  }

  function tourPose(st, e, pos, tgt) {
    var az, dist, c, el;
    if (!st.list) {                    // overview: the original orbit sway
      az = CAM_SWAY * Math.sin(e * 6.2832 / CAM_PERIOD) + 0.06 * Math.sin(e * 6.2832 / 31);
      dist = NS.fitDist * (1.03 + 0.05 * Math.sin(e * 6.2832 / 127));
      c = NS.center; el = CAM_EL;      // overview framing is verified at CAM_EL: no drift
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

  function glide(dt, k) {
    var a = 1 - Math.exp(-dt * k);
    NS.cam.position.lerp(TP.pos, a);
    NS.ctrl.target.lerp(TP.tgt, a);
  }

  function setTourText(txt) {
    if (NS.tourEl === undefined) NS.tourEl = document.getElementById('tour') || null;
    if (NS.tourEl && NS.tourTxt !== txt) { NS.tourTxt = txt; NS.tourEl.textContent = txt; }
  }

  function tourTick(t, dt) {
    var TR = NS.tour;
    if (!TR || !TR.stops.length) return;
    if (!TP.pos) { TP.pos = new THREE.Vector3(); TP.tgt = new THREE.Vector3(); }
    if (t - NS.manualAt <= MANUAL_HOLD) {          // user holds the camera
      if (!TR.manual) { TR.manual = true; setFocus(null); setTourText('◆ MANUAL · tour resumes after idle'); }
      return;
    }
    if (TR.manual) {                               // idle again: fly home first
      TR.manual = false; TR.idx = 0; TR.next = 0; TR.phase = 'travel'; TR.t0 = t;
      TR.P0.copy(NS.cam.position); TR.T0.copy(NS.ctrl.target); TR.travelT = 6;
      TR.switched = true;                        // focus is already full
      tourPose(TR.stops[0], 0, TP.pos, TP.tgt);
      TR.arcH = Math.min(110, 26 + TP.pos.distanceTo(TR.P0) * 0.14);
      setTourText('◆ AUTO-TOUR · → OVERVIEW');
    }
    var st = TR.stops[TR.idx], e = t - TR.t0;
    if (TR.phase === 'hold') {
      tourPose(st, t - TR.tHold, TP.pos, TP.tgt);
      glide(dt, 1.6);
      if (e > (st.list ? T_HOLD : T_HOLD_OVER)) {
        /* depart IMMEDIATELY with the union of both stops materialised: the
           outgoing subject recedes while the incoming one grows, so no frame
           of the flight is empty (the old 1 s parked fade-out read as the
           screen breaking on a recording) */
        TR.next = (TR.idx + 1) % TR.stops.length;
        var nx = TR.stops[TR.next];
        setFocus(unionFocus(st, nx), unionSpread(st, nx));
        TR.phase = 'travel'; TR.t0 = t; TR.switched = false;
        TR.P0.copy(NS.cam.position); TR.T0.copy(NS.ctrl.target);
        tourPose(nx, 0, TP.pos, TP.tgt);
        var dTrav = TP.pos.distanceTo(TR.P0);
        TR.travelT = Math.min(6, Math.max(2.6, 1.8 + dTrav / 320));
        TR.arcH = Math.min(110, 26 + dTrav * 0.14);  // crane-shot rise, scales with leg
        setTourText('◆ AUTO-TOUR · → ' + nx.name);
      }
    } else {                                       // travel
      var dst = TR.stops[TR.next];
      var sR = Math.min(1, e / TR.travelT);
      var sN = sR * sR * sR * (sR * (sR * 6 - 15) + 10);    // smootherstep
      /* the gaze eases ahead of the dolly: the camera pans to frame the
         destination early, then the move settles in behind it */
      var sT = Math.min(1, e / (TR.travelT * 0.82));
      sT = sT * sT * sT * (sT * (sT * 6 - 15) + 10);
      if (!TR.switched && sR >= 0.5) {             // halfway: hand the frame over
        TR.switched = true;
        setFocus(dst.ids || null, stopSpread(dst));
      }
      tourPose(dst, 0, TP.pos, TP.tgt);
      TP.pos.lerpVectors(TR.P0, TP.pos, sN);
      TP.tgt.lerpVectors(TR.T0, TP.tgt, sT);
      TP.pos.y += (TR.arcH || 0) * Math.sin(Math.PI * sN); // crane arc, 0 at both ends
      glide(dt, 3.0);
      if (e >= TR.travelT) {
        TR.idx = TR.next; TR.phase = 'hold'; TR.t0 = t; TR.tHold = t;
        var cur = TR.stops[TR.idx];
        setFocus(cur.ids || null, stopSpread(cur));
        setTourText('◆ AUTO-TOUR · ' + cur.name + (cur.ids ? '' : ' · move mouse to take control'));
      }
    }
  }

  /* ============================ public API ============================ */
  function netSceneUpdate(topo) {
    if (!NS || !topo || !topo.nodes || !topo.nodes.length) return;
    if (topo.ts !== undefined && topo.ts === NS.lastTs) return;
    NS.lastTs = topo.ts;
    try {
      var sig = topo.nodes.map(function (n) { return n.id + ':' + (n.parent || '') + ':' + n.kind; }).sort().join('|')
        + '#' + (topo.links || []).map(function (l) { return l.source + '>' + l.target; }).sort().join('|');
      if (sig !== NS.sig) { NS.sig = sig; rebuildGraph(topo); }
      else {
        // in-place data refresh: swap node objects but keep scene refs
        topo.nodes.forEach(function (nn) {
          var o = NS.byId[nn.id]; if (!o) return;
          var statusChanged = o.status !== nn.status;
          o.rx = nn.rx; o.tx = nn.tx; o.measured = nn.measured; o.meta = nn.meta || o.meta; o.status = nn.status;
          if (statusChanged && o._grp) {
            if (nn.status === 'down') { if (o._hasRing) o._ring.visible = true; else addAlertRing(o, o._grp); }
            else if (o._hasRing) o._ring.visible = false;
          }
        });
        applyDynamics(topo);
      }
      NS.totals = topo.totals || NS.totals;
    } catch (e) { console.error('netscene: update failed', e); }
  }

  function netSceneTick(t, dt) {
    if (!NS || !window.scene) return;
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
      syncNodeTransforms(Math.min(1, dt * 4.5));
      updateHotLabels();
      updateLinkGeometry(false);
    } else if (NS.needSettle) {
      NS.needSettle = false;
      syncNodeTransforms(1);
      updateLinkGeometry(true);
    }
    tickParticles(dt);

    /* alert rings breathe slowly */
    for (var i = 0; i < NS.alertRings.length; i++)
      NS.alertRings[i].material.opacity = 0.4 + 0.3 * Math.sin(t * 2.2);

    /* label opacity = distance fade x tour focus; fully-faded sprites are
       hidden outright so they stop being draw calls, callout obstacles and
       phantom bbox contributors */
    var cp = NS.cam.position;
    for (var li = 0; li < NS.labels.length; li++) {
      var L = NS.labels[li], ud = L.userData, op = spriteFocus(ud);
      op = op < 0.5 ? 0 : (op - 0.5) * 2;      // floored nodes stay dim; their labels do NOT
      if (ud.fade) {
        var dx = L.position.x - cp.x, dy = L.position.y - cp.y, dz = L.position.z - cp.z;
        var d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        op *= Math.max(0, Math.min(1, (ud.fade.far - d) / (ud.fade.far - ud.fade.near)));
      }
      L.material.opacity = op;
      L.visible = op > 0.02;
    }
    for (var ri = 0; ri < NS.rateLabels.length; ri++) {
      var R = NS.rateLabels[ri], rop = R.userData.focL === undefined ? 1
        : linkFocus(R.userData.focL);
      rop = rop < 0.5 ? 0 : (rop - 0.5) * 2;
      R.material.opacity = rop;
      R.visible = rop > 0.02;
    }

    /* focus fades + the auto-tour camera (yields to the user via MANUAL_HOLD) */
    focusTick(rdt);
    tourTick(t, rdt);

    hover();
  }

  /* ============================ hover tooltip ============================ */
  var _hoverFrame = 0;
  function hover() {
    if (!NS.tip || ((_hoverFrame++) & 1)) return;
    if (NS.mouse.x < -2) return;
    NS.ray.setFromCamera(NS.mouse, NS.cam);
    var hits = NS.ray.intersectObjects(NS.pick, false);
    var n = null;
    if (hits.length) {
      var h = hits[0];
      if (h.object.userData.nsId) n = NS.byId[h.object.userData.nsId];
      else if (h.object.userData.nsInstanced && h.instanceId !== undefined)
        n = NS.byId[NS[h.object.userData.nsInstanced][h.instanceId]];
    }
    if (!n) { NS.tip.style.display = 'none'; return; }
    var sc = n.status === 'down' ? hex(PAL.alert) : n.status === 'unknown' ? hex(PAL.unk) : hex(PAL.ok);
    var rows = ['<b>' + (n.label || n.id) + '</b> · <span style="color:' + sc + '">' + (n.status || '?') + '</span>'];
    var l2 = [];
    if (n.ip) l2.push(n.ip);
    l2.push(n.kind);
    if (n.meta && n.meta.model) l2.push(n.meta.model);
    if (n.meta && n.meta.port != null) l2.push('port ' + n.meta.port);
    rows.push(l2.join(' · '));
    rows.push(n.measured
      ? '<span style="color:' + hex(PAL.cyan) + '">↓ ' + fmtRate(n.rx) + '</span> · <span style="color:' + hex(PAL.magenta) + '">↑ ' + fmtRate(n.tx) + '</span>'
      : '<span style="color:' + hex(PAL.unk) + '">throughput not measured</span>');
    if (n.meta && (n.meta.cpu != null || n.meta.mem_pct != null)) {
      var m3 = [];
      if (n.meta.cpu != null) m3.push('cpu ' + Number(n.meta.cpu).toFixed(1) + '%');
      if (n.meta.mem_pct != null) m3.push('mem ' + Number(n.meta.mem_pct).toFixed(1) + '%');
      if (n.meta.disk_pct != null) m3.push('disk ' + Number(n.meta.disk_pct).toFixed(0) + '%');
      rows.push(m3.join(' · '));
    }
    if (n.meta && (n.meta.dr != null || n.meta.dw != null)) {
      rows.push('<span style="color:' + hex(PAL.warn) + '">disk r ' + fmtIO(n.meta.dr)
                + ' · w ' + fmtIO(n.meta.dw) + '</span>');
    }
    if (n.meta && n.meta.up) {
      var up = n.meta.up, dD = Math.floor(up / 86400), hH = Math.floor((up % 86400) / 3600);
      rows.push('<span style="color:' + hex(PAL.unk) + '">up ' + (dD ? dD + 'd ' : '') + hH + 'h</span>');
    }
    NS.tip.innerHTML = rows.join('<br>');
    NS.tip.style.display = 'block';
  }
})();
