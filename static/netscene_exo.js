/* ============================================================================
   netscene_exo.js - the OUTSIDE of the estate, drawn on the wall's network scene
   (overlay on netscene.js, same pattern as netscene_flows.js)

   Reads:  /api/topology .external {up, top_dst[], top_src[], by_country{},
           talkers[]}, .edge {cloudflare{}, crowdsec{}, audience{}, threats{}},
           .flows[], the wan node's meta.cloudflare, and /api/threats(/stream).
   Everything here is driven by a measured field; nothing is decorative-only:

   * EXOSPHERE  - topology.external.top_dst / top_src (Akvorado, 1 h window):
                  remote endpoints merged by AS name become beacons on two
                  shells beyond the WAN node (the -X side, "outside"). Beacon
                  size and arc brightness = log(bps); label = "AS · CC".
                  Arc particles: WAN -> beacon = outbound (magenta, same lane
                  convention as netscene's tx), beacon -> WAN = inbound (cyan).
   * COUNTRY RING - topology.external.by_country: a thin ring past the outer
                  shell whose segments are sized by sqrt(bytes) share; the
                  top countries get a small CC tag.
   * TALKER PATHS - topology.external.talkers[].node: the top internal
                  talkers' real parent chain (node -> ... -> WAN) is lit and
                  a runner travels it; if an ntopng flow from that node names
                  an AS that has a beacon, the runner continues to it.
   * TUNNEL EDGE  - wan.meta.cloudflare (= topology.edge.cloudflare):
                  a station above the WAN with `ha_connections` strands to
                  whichever guest runs the tunnel daemon - found by matching
                  TUNNEL_RE against the guest LABEL, never a hardcoded guest
                  id, since every estate numbers its guests differently.
                  Request comets at req_per_min. These are REQUESTS, never
                  "viewers": only edge.audience carries unique visitors.
                  Non-2xx deltas of by_code fly off as flecks.
   * CROWDSEC   - topology.edge.crowdsec.top_attackers: each (ip,ts) once,
                  a short red impact ring on the shield with a "CC · AS ·
                  scenario" tag that fades. Nothing red is ever left behind.

   * THREATS    - v6: /api/threats/stream (SSE, 5 s poll of
                  /api/threats as fallback). A NEW frame (seq changed) fires
                  each unseen event once: crowdsec -> a red intrusion streak
                  (14 tapered points) from the country ring at the event's cc
                  angle to the shield, ending in an impact ring + "BLOCKED ·
                  CC · AS / scenario" tag; secmon -> the estate-side node whose
                  ip is in hosts[] is ringed red for ~6 s with the finding
                  title (fallback: the WAN). A THREAT LEVEL plate by the
                  tunnel station ("THREAT RED · 1h 0 · 24h 79 · 11 banned",
                  level colour, slow pulse at RED/BLACK) is the only persistent
                  red, and only at RED/BLACK. window.NETEXO.threat(evt) injects
                  a fake event for QA; every new seq also dispatches a
                  window 'galaxy:threat' CustomEvent (lightsync.js -> room lights).
   * AUDIENCE   - edge.audience (Cloudflare zone analytics) when up: one gold
                  mote per NEW unique viewer (delta of viewers_5m, <= 20) rides
                  the HA strands on top of the request comets.

   Labels opt into netscene's single collision pass with userData.lbl = true
   (lowest rank: the outside world never hides a host name) and are counted by
   NETSCENE.auditLabels(). Draw calls: beacon dots (1 Points), arcs (1
   LineSegments), particles (1 Points), country ring (1), talker paths (1),
   CF strands (1), station (3 meshes) + label sprites. Per frame: one float
   loop over <= 400 particles, no allocation.
   ========================================================================== */
(function () {
  'use strict';
  var THREE = window.THREE; if (!THREE) return;

  /* Which guest terminates the tunnel, matched on its LABEL: guest ids are
     site-specific (guest:<node>:<vmid>) and differ on every install. Rename
     your tunnel guest and it is still found; add another daemon's name here
     if you run a different one. */
  var TUNNEL_RE = /cloudflared|cloudflare-?tunnel|\btunnel\b/i;

  var R1 = 112, R2 = 162;                  // beacon shells (world units from the WAN)
  var RING_R = 196;                        // country ring radius
  /* round 2: the shells compact to KO x at every stop except WAN EDGE, so the
     whole exosphere (ring included) sits inside the overview's framed box
     without touching the graph fit (envelope() stays full-size: the fit and
     the WAN stop are unchanged, the internal graph keeps its size). */
  var KO = 0.74;
  var TOPN = 4;                            // beacons drawn as the bold tier
  var ARC_SPAN = 1.30;                     // half-angle of the exosphere fan (rad)
  var MAXB = 14;                           // beacons
  var P_CAP = 512;                         // particle pool
  var COL = { out: 0xff4fa3, inb: 0x5ad7ff, cf: 0xf6821f, atk: 0xff5a6a, gold: 0xffd166,
              ring: 0x35577c, arcDim: 0x1e3350, arcHot: 0x8fd3ff };
  var SHIELD_R = 92;                       // where CrowdSec impacts land
  var STREAK_N = 14;                       // points per intrusion streak
  var LEVEL_COL = ['#37f5a0', '#ffb347', '#ff5a6a', '#ff2d55'];   // GREEN YELLOW RED BLACK
  var LEVEL_NAME = ['GREEN', 'YELLOW', 'RED', 'BLACK'];

  var EX = null, _c = new THREE.Color(), _c2 = new THREE.Color(), _v = new THREE.Vector3();
  function ns() { return window.NETSCENE || null; }
  function bpsNorm(bps) {                  // bits/s -> 0..1 ; 1 kb/s .. ~30 Mb/s
    var b = Math.max(0, +bps || 0); if (b < 1000) return 0;
    return Math.min(1, (Math.log(b) / Math.LN10 - 3) / 4.5);
  }
  function fmtBps(v) {
    var b = Math.max(0, +v || 0);
    if (b < 1e3) return b.toFixed(0) + ' b/s';
    if (b < 1e6) return (b / 1e3).toFixed(0) + ' kb/s';
    if (b < 1e9) return (b / 1e6).toFixed(1) + ' Mb/s';
    return (b / 1e9).toFixed(2) + ' Gb/s';
  }
  function hash32(s) { s = String(s || ''); var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }
  function shortAS(name, ip) {
    var s = String(name || '').replace(/,?\s*(PBC|Inc\.?|LLC|Ltd\.?|Limited|Corp\.?|Corporation|Technologies|Technology|Holdings|Group|S\.?A\.?|GmbH|B\.?V\.?)\b/gi, '')
      .replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!s) return ip || '?';
    if (/^[A-Z0-9 ]+$/.test(s)) s = s.toLowerCase().replace(/\b([a-z])/g, function (m) { return m.toUpperCase(); });   // GOOGLE CLOUD -> Google Cloud (was "GOogle")
    return s.length > 16 ? s.slice(0, 15) + '…' : s;
  }

  /* ---------------- textures ---------------- */
  function dotTex() {
    var s = 64, cv = document.createElement('canvas'); cv.width = cv.height = s;
    var x = cv.getContext('2d'), g = x.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.35, 'rgba(255,255,255,.75)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.fillRect(0, 0, s, s);
    return new THREE.CanvasTexture(cv);
  }
  function ringTex() {
    var s = 128, cv = document.createElement('canvas'); cv.width = cv.height = s;
    var x = cv.getContext('2d'), g = x.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0.70, 'rgba(255,255,255,0)'); g.addColorStop(0.86, 'rgba(255,255,255,1)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.fillRect(0, 0, s, s);
    return new THREE.CanvasTexture(cv);
  }
  function sharp(t) {
    var r = window.rndr && window.rndr.capabilities;
    t.anisotropy = r ? Math.min(8, r.getMaxAnisotropy()) : 1; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
    return t;
  }
  /* a redrawable single-line label sprite: canvas 704x64, tight collision rect */
  function mkLabel(wWorld, depthTest) {
    var W = 704, H = 64, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    var x = cv.getContext('2d');
    var t = sharp(new THREE.CanvasTexture(cv));
    var sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false, depthTest: depthTest !== false }));
    sp.scale.set(wWorld, wWorld * H / W, 1);
    sp.userData.lbl = true; sp.userData.txt = ''; sp.userData.plateFrac = 1;
    sp.visible = false; sp.material.opacity = 0; sp.userData.base = 1;
    /* round 2: labels grow at the WAN EDGE stop; the collision pass reads
       sp.scale every frame, so a scaled sprite is judged at its drawn size */
    sp.userData.w0 = wWorld; sp.userData.k = 1;
    sp.userData.setW = function (k) {
      if (Math.abs(k - sp.userData.k) < 0.003) return;
      sp.userData.k = k; sp.scale.set(wWorld * k, wWorld * k * H / W, 1);
    };
    /* pill: 0 = bare text (shadow only), 1 = dark plate, 2 = plate + tinted rim.
       The plate is what makes 22 px text readable over bloomed star field at 1080p. */
    sp.userData.set = function (text, color, size, sub, subColor, pill) {
      var key = text + '|' + color + '|' + size + '|' + (sub || '') + '|' + (pill || 0);
      if (sp.userData.key === key) return;
      sp.userData.key = key; sp.userData.txt = text + (sub ? ' / ' + sub : '');
      x.clearRect(0, 0, W, H);
      x.textAlign = 'center'; x.textBaseline = 'middle';
      x.font = '600 ' + size + 'px ui-monospace,Consolas,monospace';
      var tw = x.measureText(text).width, tw2 = 0;
      if (sub) { x.font = '500 ' + Math.round(size * 0.72) + 'px ui-monospace,Consolas,monospace'; tw2 = x.measureText(sub).width; }
      var full = Math.max(tw, tw2);
      var sc = full > W - 32 ? (W - 32) / full : 1;
      var pw = full * sc + 28, px0 = (W - pw) / 2, ph = sub ? 60 : Math.min(60, size * sc + 20), py0 = (H - ph) / 2, rr = 9;
      if (pill) {
        x.shadowBlur = 0;
        x.beginPath();
        x.moveTo(px0 + rr, py0); x.lineTo(px0 + pw - rr, py0); x.quadraticCurveTo(px0 + pw, py0, px0 + pw, py0 + rr);
        x.lineTo(px0 + pw, py0 + ph - rr); x.quadraticCurveTo(px0 + pw, py0 + ph, px0 + pw - rr, py0 + ph);
        x.lineTo(px0 + rr, py0 + ph); x.quadraticCurveTo(px0, py0 + ph, px0, py0 + ph - rr);
        x.lineTo(px0, py0 + rr); x.quadraticCurveTo(px0, py0, px0 + rr, py0); x.closePath();
        x.fillStyle = pill >= 2 ? 'rgba(6,10,20,.84)' : 'rgba(6,10,20,.62)'; x.fill();
        if (pill >= 2) { x.strokeStyle = color; x.globalAlpha = 0.55; x.lineWidth = 2; x.stroke(); x.globalAlpha = 1; }
      }
      x.shadowColor = 'rgba(2,5,11,.95)'; x.shadowBlur = pill ? 3 : 7;
      x.font = '600 ' + Math.floor(size * sc) + 'px ui-monospace,Consolas,monospace';
      x.fillStyle = color; x.fillText(text, W / 2, sub ? 22 : H / 2);
      if (sub) { x.font = '500 ' + Math.floor(size * 0.72 * sc) + 'px ui-monospace,Consolas,monospace'; x.fillStyle = subColor || '#7fa3c8'; x.fillText(sub, W / 2, 47); }
      sp.userData.plateFrac = Math.min(1, (pw + 4) / W);
      t.needsUpdate = true;
    };
    return sp;
  }

  /* ---------------- scene objects ---------------- */
  function init() {
    var NS = ns(); if (!NS || !NS.scene) return false;
    EX = {
      grp: new THREE.Group(), vis: 0, want: 0, t: 0, dt: 0, k: 1, kT: 1, kBuilt: 1, big: 0,
      beacons: [], slots: {}, sig: '', wan: null, cfNode: null,
      dotTex: dotTex(), ringTex: ringTex(),
      seen: {}, queue: [], impacts: [], flecks: [],
      cf: null, cfPrev: null, cfAcc: 0, cfCarrier: [],
      talkers: [], flows: [], byCountry: [], edge: null, ext: null,
      lastStop: '', tourCol: '',
      /* threats (v6) */
      th: null, thSeq: null, thSeen: {}, thQueue: [], thT: -9, streaks: [], nodeRings: [],
      audPrev: null
    };
    EX.grp.name = 'exosphere'; EX.grp.visible = false;
    NS.scene.add(EX.grp);

    /* beacon dots: one Points, per-vertex colour + fixed size (size via a second attr is
       not available on PointsMaterial; the glow size is carried by the halo sprite below) */
    EX.bPos = new Float32Array(MAXB * 3); EX.bCol = new Float32Array(MAXB * 3);
    EX.bGeo = new THREE.BufferGeometry();
    EX.bGeo.setAttribute('position', new THREE.BufferAttribute(EX.bPos, 3).setUsage(THREE.DynamicDrawUsage));
    EX.bGeo.setAttribute('color', new THREE.BufferAttribute(EX.bCol, 3).setUsage(THREE.DynamicDrawUsage));
    EX.bGeo.setDrawRange(0, 0); EX.bGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 6000);
    EX.bPts = new THREE.Points(EX.bGeo, new THREE.PointsMaterial({ size: 14, map: EX.dotTex, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true }));
    EX.bPts.frustumCulled = false; EX.grp.add(EX.bPts);
    /* per-beacon halo sprites (size = rate) + labels */
    EX.halos = []; EX.labels = [];
    for (var i = 0; i < MAXB; i++) {
      var h = new THREE.Sprite(new THREE.SpriteMaterial({ map: EX.dotTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.55 }));
      h.visible = false; h.renderOrder = -3; EX.grp.add(h); EX.halos.push(h);
      var l = mkLabel(62, false); EX.grp.add(l); EX.labels.push(l);
    }

    /* arcs WAN <-> beacon: one LineSegments, 16 segments each, vertex colours */
    var SEG = 16; EX.SEG = SEG;
    EX.aPos = new Float32Array(MAXB * SEG * 2 * 3); EX.aCol = new Float32Array(MAXB * SEG * 2 * 3);
    EX.aGeo = new THREE.BufferGeometry();
    EX.aGeo.setAttribute('position', new THREE.BufferAttribute(EX.aPos, 3).setUsage(THREE.DynamicDrawUsage));
    EX.aGeo.setAttribute('color', new THREE.BufferAttribute(EX.aCol, 3).setUsage(THREE.DynamicDrawUsage));
    EX.aGeo.setDrawRange(0, 0); EX.aGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 6000);
    EX.arcs = new THREE.LineSegments(EX.aGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
    EX.arcs.frustumCulled = false; EX.grp.add(EX.arcs);

    /* country ring: 96 segments */
    var RS = 96; EX.RS = RS;
    EX.rPos = new Float32Array(RS * 2 * 3); EX.rCol = new Float32Array(RS * 2 * 3);
    EX.rGeo = new THREE.BufferGeometry();
    EX.rGeo.setAttribute('position', new THREE.BufferAttribute(EX.rPos, 3).setUsage(THREE.DynamicDrawUsage));
    EX.rGeo.setAttribute('color', new THREE.BufferAttribute(EX.rCol, 3).setUsage(THREE.DynamicDrawUsage));
    EX.rGeo.setDrawRange(0, 0); EX.rGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 6000);
    EX.ring = new THREE.LineSegments(EX.rGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false }));
    EX.ring.frustumCulled = false; EX.grp.add(EX.ring);
    EX.ccLabels = []; for (var ci = 0; ci < 6; ci++) { var cl = mkLabel(40, false); EX.grp.add(cl); EX.ccLabels.push(cl); }

    /* talker paths: dynamic LineSegments, <= 3 talkers x 10 hops */
    EX.tPos = new Float32Array(3 * 10 * 2 * 3);
    EX.tGeo = new THREE.BufferGeometry();
    EX.tGeo.setAttribute('position', new THREE.BufferAttribute(EX.tPos, 3).setUsage(THREE.DynamicDrawUsage));
    EX.tGeo.setDrawRange(0, 0); EX.tGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 6000);
    EX.tLines = new THREE.LineSegments(EX.tGeo, new THREE.LineBasicMaterial({ color: COL.gold, transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false }));
    EX.tLines.frustumCulled = false; EX.grp.add(EX.tLines);

    /* Cloudflare station: torus + core + halo + label, strands to cloudflared */
    EX.st = new THREE.Group();
    /* round 2: ~1.5x the round-1 station - it was a 8-unit torus that read as
       a speck next to the WAN globe at 1080p */
    var torus = new THREE.Mesh(new THREE.TorusGeometry(12, 0.8, 8, 48), new THREE.MeshBasicMaterial({ color: COL.cf, transparent: true, opacity: 0.85 }));
    torus.rotation.x = Math.PI / 2; EX.st.add(torus); EX.torus = torus;
    var torus2 = new THREE.Mesh(new THREE.TorusGeometry(7.8, 0.5, 8, 40), new THREE.MeshBasicMaterial({ color: 0xffc07a, transparent: true, opacity: 0.6 }));
    torus2.rotation.y = Math.PI / 2; EX.st.add(torus2); EX.torus2 = torus2;
    var core = new THREE.Mesh(new THREE.IcosahedronGeometry(3.2, 1), new THREE.MeshBasicMaterial({ color: 0xffe0b0, transparent: true }));
    EX.st.add(core); EX.core = core;
    var halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: EX.dotTex, color: COL.cf, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.5 }));
    halo.scale.set(52, 52, 1); halo.renderOrder = -3; EX.st.add(halo); EX.halo = halo;
    EX.grp.add(EX.st);
    EX.cfLbl = mkLabel(96, false); EX.grp.add(EX.cfLbl);
    var SS = 22; EX.SS = SS;
    EX.sPos = new Float32Array(8 * SS * 2 * 3);
    EX.sGeo = new THREE.BufferGeometry();
    EX.sGeo.setAttribute('position', new THREE.BufferAttribute(EX.sPos, 3).setUsage(THREE.DynamicDrawUsage));
    EX.sGeo.setDrawRange(0, 0); EX.sGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 6000);
    EX.strands = new THREE.LineSegments(EX.sGeo, new THREE.LineBasicMaterial({ color: COL.cf, transparent: true, opacity: 0.30, blending: THREE.AdditiveBlending, depthWrite: false }));
    EX.strands.frustumCulled = false; EX.grp.add(EX.strands);

    /* particles: arcs (inbound/outbound), strand comets, flecks, talker runners */
    EX.pPos = new Float32Array(P_CAP * 3); EX.pCol = new Float32Array(P_CAP * 3);
    EX.pGeo = new THREE.BufferGeometry();
    EX.pGeo.setAttribute('position', new THREE.BufferAttribute(EX.pPos, 3).setUsage(THREE.DynamicDrawUsage));
    EX.pGeo.setAttribute('color', new THREE.BufferAttribute(EX.pCol, 3).setUsage(THREE.DynamicDrawUsage));
    EX.pGeo.setDrawRange(0, 0); EX.pGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 6000);
    EX.pPts = new THREE.Points(EX.pGeo, new THREE.PointsMaterial({ size: 6.5, map: EX.dotTex, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true }));
    EX.pPts.frustumCulled = false; EX.grp.add(EX.pPts);
    EX.P = [];                                   // slot records {kind, b, dir, p, rate, r,g,b}

    /* CrowdSec impact pool */
    EX.impR = []; EX.impL = []; EX.flares = [];
    for (var k = 0; k < 6; k++) {
      var rg = new THREE.Sprite(new THREE.SpriteMaterial({ map: EX.ringTex, color: COL.atk, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }));
      rg.visible = false; EX.grp.add(rg); EX.impR.push(rg);
      /* r2: tag sized like the top-tier beacon labels (was 66 u / 32 px - a few
         pixels at 1080p), rimmed red via pill 2 */
      var il = mkLabel(84, false); EX.grp.add(il); EX.impL.push(il);
      /* streak head flare: one soft sprite per pool slot */
      var fl = new THREE.Sprite(new THREE.SpriteMaterial({ map: EX.dotTex, color: 0xff8a95, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }));
      fl.visible = false; fl.renderOrder = 2; EX.grp.add(fl); EX.flares.push(fl);
    }
    EX.shieldFlash = 0; EX.impAct = new Float32Array(6 * 3); EX.impN = 0;   // active impact centres (for label priority)
    EX.shield = new THREE.Mesh(new THREE.TorusGeometry(SHIELD_R, 0.25, 6, 96), new THREE.MeshBasicMaterial({ color: 0x5a3a55, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false }));
    EX.shield.rotation.x = Math.PI / 2; EX.grp.add(EX.shield);

    /* THREAT LEVEL plate by the Cloudflare station (the only persistent red,
       and only when the level is RED/BLACK) */
    EX.thLbl = mkLabel(88, false); EX.grp.add(EX.thLbl);
    /* secmon node rings live in the scene itself, not the exosphere group:
       the estate side stays visible at the close-ups where the group folds */
    for (var nr = 0; nr < 3; nr++) {
      var rr = new THREE.Sprite(new THREE.SpriteMaterial({ map: EX.ringTex, color: COL.atk, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }));
      rr.visible = false; NS.scene.add(rr);
      var rl = mkLabel(70, false); NS.scene.add(rl);
      EX.nodeRings.push({ ring: rr, lbl: rl, n: null, t0: 0 });
    }

    /* our label sprites were created after netscene's last rank-5 cache scan:
       force a rescan so they are judged from their first visible frame */
    NS._extScan = undefined;
    /* hooks into netscene: framing + WAN EDGE stop envelope */
    NS.exoEnvelope = envelope;
    /* the graph may already be built and fitted without our envelope: ask for one
       rebuild on the next poll (a single tweened re-layout at boot) */
    if (NS.nodes && NS.nodes.length) NS.sig = '';
    NS.exoStopNodes = function () {
      var w = NS.byId && NS.byId.wan; if (!w) return [];
      return envelope(w).map(function (p, i) { return { id: 'exo:' + i, kind: 'external', _x: p[0], _y: p[1], _z: p[2] }; });
    };
    return true;
  }
  /* the exosphere's extent relative to a WAN node: used by netscene's overview fit
     and the WAN EDGE stop so the beacons are framed, not clipped */
  function envelope(w) {
    var s = Math.sin(ARC_SPAN), c = Math.cos(ARC_SPAN);
    return [[w._x - R2 * c - 8, w._y + 30, w._z + R2 * s], [w._x - R2 * c - 8, w._y + 30, w._z - R2 * s], [w._x - R1 - 10, w._y + 42, w._z]];
  }
  function wanPos(NS) {
    var w = NS.byId && NS.byId.wan; if (!w) return null;
    return { x: w._cx !== undefined ? w._cx : w._x, y: (w._cy !== undefined ? w._cy : w._y), z: w._cz !== undefined ? w._cz : w._z, n: w };
  }
  function nodePos(n) {
    return [n._cx !== undefined ? n._cx : n._x, (n._cy !== undefined ? n._cy : n._y) + (n._h || 5) + 2, n._cz !== undefined ? n._cz : n._z];
  }

  /* ---------------- data in ---------------- */
  function update(topo) {
    if (!EX) return;
    var NS = ns(); if (!NS || !NS.byId) return;
    var ext = topo.external || null, edge = topo.edge || null;
    var wan = NS.byId.wan;
    EX.edge = edge; EX.ext = ext;
    EX.cf = (wan && wan.meta && wan.meta.cloudflare) || (edge && edge.cloudflare) || null;
    EX.flows = (topo.flows || []).filter(function (f) { return f && f.measured && !f.internal; });
    EX.cfNode = null;
    NS.nodes.forEach(function (n) { if (!EX.cfNode && n.kind === 'guest' && TUNNEL_RE.test(n.label || '')) EX.cfNode = n; });

    /* beacons */
    var by = {}, list = [];
    function add(r, dir) {
      if (!r || !(+r.bps > 0)) return;
      var key = (r.as_name || r.ip || '?').toLowerCase();
      var b = by[key]; if (!b) { b = by[key] = { key: key, name: shortAS(r.as_name, r.ip), asn: r.asn, cc: r.cc || '', out: 0, inb: 0, bytes: 0, ips: {} }; list.push(b); }
      b[dir] += +r.bps || 0; b.bytes += +r.bytes || 0; b.ips[r.ip] = 1;
      if (!b.cc && r.cc) b.cc = r.cc;
    }
    if (ext && ext.up) { (ext.top_dst || []).forEach(function (r) { add(r, 'out'); }); (ext.top_src || []).forEach(function (r) { add(r, 'inb'); }); }
    list.sort(function (a, b) { return (b.out + b.inb) - (a.out + a.inb); });
    list = list.slice(0, MAXB);
    /* stable slots: a beacon keeps its place on the shell while it stays in the top set */
    var keep = {}; list.forEach(function (b) { keep[b.key] = 1; });
    Object.keys(EX.slots).forEach(function (k) { if (!keep[k]) delete EX.slots[k]; });
    var used = {}; Object.keys(EX.slots).forEach(function (k) { used[EX.slots[k]] = 1; });
    list.forEach(function (b) {
      if (EX.slots[b.key] === undefined) { for (var s = 0; s < MAXB; s++) if (!used[s]) { used[s] = 1; EX.slots[b.key] = s; break; } }
      b.slot = EX.slots[b.key];
    });
    EX.beacons = list.filter(function (b) { return b.slot !== undefined; });
    var sig = EX.beacons.map(function (b) { return b.key + ':' + b.slot; }).join('|');
    EX.sig = sig;                          // label text/plates are styled in rebuildStatic()
    EX.byCountry = (ext && ext.up && Array.isArray(ext.by_country)) ? ext.by_country.slice() : [];
    EX.byCountry.sort(function (a, b) { return (+b.bytes || 0) - (+a.bytes || 0); });

    /* talkers: internal node -> parent chain -> WAN (-> beacon when a flow names its AS) */
    EX.talkers = [];
    if (ext && ext.up) {
      var byAS = {}; EX.beacons.forEach(function (b) { byAS[b.key] = b; });
      (ext.talkers || []).slice(0, 6).forEach(function (t) {
        if (EX.talkers.length >= 3 || !t.node) return;
        var n = NS.byId[t.node]; if (!n || n.kind === 'wan') return;
        var chain = [n], g = 0, cur = n;
        while (cur && cur.parent && NS.byId[cur.parent] && g++ < 9) { cur = NS.byId[cur.parent]; chain.push(cur); if (cur.kind === 'wan') break; }
        if (chain[chain.length - 1].kind !== 'wan' && wan) chain.push(wan);
        var beacon = null, best = 0;
        EX.flows.forEach(function (f) { if (f.src === t.node && f.as_name && (+f.bps || 0) > best) { var b = byAS[String(f.as_name).toLowerCase()]; if (b) { best = +f.bps; beacon = b; } } });
        EX.talkers.push({ node: n, chain: chain, beacon: beacon, bps: +t.bps_out || 0, ip: t.ip });
      });
    }

    /* Cloudflare: by_code deltas -> flecks (3xx amber, 4xx/5xx red-orange) */
    if (EX.cf && EX.cf.up && EX.cf.by_code) {
      var prev = EX.cfPrev, cur2 = EX.cf.by_code, n3 = 0, n4 = 0;
      if (prev) Object.keys(cur2).forEach(function (code) {
        var d = (+cur2[code] || 0) - (+prev[code] || 0); if (d <= 0) return;
        if (/^3/.test(code)) n3 += d; else if (/^[45]/.test(code)) n4 += d;
      });
      EX.cfPrev = {}; Object.keys(cur2).forEach(function (k) { EX.cfPrev[k] = +cur2[k] || 0; });
      for (var i3 = 0; i3 < Math.min(6, n3); i3++) EX.flecks.push({ kind: 3, t: -0.15 * i3 });
      for (var i4 = 0; i4 < Math.min(6, n4); i4++) EX.flecks.push({ kind: 4, t: -0.15 * i4 });
      if (EX.flecks.length > 16) EX.flecks.length = 16;
    }
    var cf = EX.cf, ha = cf && cf.up ? Math.max(0, Math.min(8, +cf.ha_connections || 0)) : 0;
    EX.ha = ha;
    if (cf && cf.up) EX.cfLbl.userData.set('CLOUDFLARE EDGE', '#ffb073', 32,
      ha + ' conn · ' + (+cf.req_per_min || 0).toFixed(0) + ' req/min · ' + (cf.locations || []).join(' '), '#e8c9a0', 2);
    else EX.cfLbl.userData.set('CLOUDFLARE EDGE', '#7a6a60', 32, 'tunnel metrics unavailable', '#6b6b7a', 1);

    /* audience (Cloudflare zone analytics): real unique viewers. Each NEW
       viewer since the last poll is one gold mote down the HA strands. When
       the block is not up nothing extra runs (the req/min comets already do). */
    var au = edge && edge.audience;
    if (au && au.up) {
      var v5 = +au.viewers_5m || 0;
      if (EX.audPrev !== null && v5 > EX.audPrev) {
        var nv = Math.min(20, v5 - EX.audPrev);
        for (var vi = 0; vi < nv; vi++) if (EX.P.length < P_CAP - 1) EX.P.push({ kind: 'viewer', s: vi % Math.max(1, ha), p: -vi * 0.09, rate: 0.30 });
      }
      EX.audPrev = v5;
    } else EX.audPrev = null;

    /* threats: the level plate follows the poll too (the stream only speaks
       on a new event) */
    if (edge && edge.threats && edge.threats.up) threatFrame(edge.threats, true);

    /* CrowdSec: each (ip,ts) impacts once; stagger the first batch */
    var cs = edge && edge.crowdsec;
    if (cs && cs.up && Array.isArray(cs.top_attackers)) {
      var now = Date.now() / 1000;
      cs.top_attackers.slice().reverse().forEach(function (a) {
        var k = a.ip + '@' + a.ts; if (EX.seen[k]) return; EX.seen[k] = 1;
        if (a.ts && now - a.ts > 86400) return;
        EX.queue.push(a);
      });
      if (EX.queue.length > 24) EX.queue.splice(0, EX.queue.length - 24);
    }
    rebuildStatic();
    reseed();
  }

  /* beacon / ring / label positions are relative to the WAN node, which only
     moves on a topology rebuild (tweened) - cheap enough to refresh every poll */
  function beaconPos(b, w) {
    var i = b.slot, shell = ((i & 1) ? R2 : R1) * EX.k, per = Math.ceil(MAXB / 2), j = i >> 1;
    var a = -ARC_SPAN + (2 * ARC_SPAN) * ((j + ((i & 1) ? 0.5 : 0)) / per) + ARC_SPAN / per;
    return [w.x - Math.cos(a) * shell, w.y + 24 + 16 * Math.sin(j * 1.9 + (i & 1) * 2.3), w.z + Math.sin(a) * shell];
  }
  /* beacon label text + plate by tier: rank < TOPN (by bps) = bold white on a
     rimmed plate; the rest = softer text on a plain plate. Two lines always -
     round 1 alternated name/rate every 3 s, which meant the rate was unreadable
     half the time and the name the other half. */
  function styleBeaconLabel(L, b, rank) {
    var top = rank < TOPN, name = b.name + (b.cc ? ' · ' + b.cc : '');
    var sub = (b.out ? '↑' + fmtBps(b.out) : '') + (b.inb ? (b.out ? '  ' : '') + '↓' + fmtBps(b.inb) : '');
    L.userData.set(name, top ? '#ffffff' : '#cfdff0', top ? 36 : 32, sub || ' ', top ? '#9fe3ff' : '#8fb0d0', top ? 2 : 1);
    L.userData.top = top;
  }
  function rebuildStatic() {
    var NS = ns(), w = wanPos(NS); if (!w) return;
    var SEG = EX.SEG, k, i;
    /* beacons + arcs */
    var nb = 0;
    for (i = 0; i < MAXB; i++) { EX.halos[i].visible = false; EX.labels[i].userData.on = false; }
    EX.kBuilt = EX.k;
    EX.beacons.forEach(function (b, rank) {
      var p = beaconPos(b, w); b.x = p[0]; b.y = p[1]; b.z = p[2];
      styleBeaconLabel(EX.labels[b.slot], b, rank);
      var u = bpsNorm(Math.max(b.out, b.inb)), uo = bpsNorm(b.out), ui = bpsNorm(b.inb);
      _c.setHex(COL.arcDim).lerp(_c2.setHex(COL.arcHot), u);
      if (uo > ui) _c.lerp(_c2.setHex(COL.out), 0.35 * uo); else _c.lerp(_c2.setHex(COL.inb), 0.35 * ui);
      var o = nb * 3; EX.bPos[o] = b.x; EX.bPos[o + 1] = b.y; EX.bPos[o + 2] = b.z;
      /* the dot carries the direction hue (bloom would turn a white dot into a blob) */
      _c2.copy(_c).multiplyScalar(0.55 + 0.45 * u);
      EX.bCol[o] = _c2.r; EX.bCol[o + 1] = _c2.g; EX.bCol[o + 2] = _c2.b;
      var H = EX.halos[b.slot]; H.visible = true; H.position.set(b.x, b.y, b.z);
      var hs = 8 + 22 * u; H.scale.set(hs, hs, 1); H.material.color.copy(_c); H.material.opacity = 0.14 + 0.26 * u;
      var L = EX.labels[b.slot]; L.position.set(b.x, b.y - 9 - hs * 0.25, b.z); L.userData.on = true; L.userData.base = L.userData.top ? 1 : 0.66 + 0.2 * u;
      /* arc: quadratic, peaks up and slightly outward */
      var ax = w.x - 4, ay = w.y + 10, az = w.z, mx = (ax + b.x) / 2, my = Math.max(ay, b.y) + 26 + 18 * u, mz = (az + b.z) / 2;
      b.ax = ax; b.ay = ay; b.az = az; b.mx = mx; b.my = my; b.mz = mz;
      for (k = 0; k < SEG; k++) {
        var t0 = k / SEG, t1 = (k + 1) / SEG, q = (nb * SEG + k) * 6;
        EX.aPos[q] = bz(ax, mx, b.x, t0); EX.aPos[q + 1] = bz(ay, my, b.y, t0); EX.aPos[q + 2] = bz(az, mz, b.z, t0);
        EX.aPos[q + 3] = bz(ax, mx, b.x, t1); EX.aPos[q + 4] = bz(ay, my, b.y, t1); EX.aPos[q + 5] = bz(az, mz, b.z, t1);
        var f0 = 0.35 + 0.65 * t0, f1 = 0.35 + 0.65 * t1;   // brighter toward the beacon
        EX.aCol[q] = _c.r * f0; EX.aCol[q + 1] = _c.g * f0; EX.aCol[q + 2] = _c.b * f0;
        EX.aCol[q + 3] = _c.r * f1; EX.aCol[q + 4] = _c.g * f1; EX.aCol[q + 5] = _c.b * f1;
      }
      nb++;
    });
    EX.bGeo.setDrawRange(0, nb); EX.bGeo.attributes.position.needsUpdate = true; EX.bGeo.attributes.color.needsUpdate = true;
    EX.aGeo.setDrawRange(0, nb * SEG * 2); EX.aGeo.attributes.position.needsUpdate = true; EX.aGeo.attributes.color.needsUpdate = true;

    /* country ring: arc share by sqrt(bytes), colour by out/in dominance */
    var RS = EX.RS, tot = 0, cs = EX.byCountry, RR = RING_R * EX.k;
    for (i = 0; i < EX.ccLabels.length; i++) EX.ccLabels[i].userData.on = false;
    cs.forEach(function (c) { c._w = Math.sqrt(Math.max(0, +c.bytes || 0)); tot += c._w; });
    var seg = 0;
    EX.ccAng = EX.ccAng || {}; var CA = EX.ccAng; for (var ck in CA) delete CA[ck];
    if (tot > 0) {
      var a0 = -ARC_SPAN, span = 2 * ARC_SPAN, gap = 0.035;
      cs.forEach(function (c, ci) {
        var w2 = c._w / tot * span, a1 = a0 + w2;
        if (c.cc) CA[c.cc] = (a0 + a1) / 2;             // intrusion streaks start here
        var nseg = Math.max(1, Math.round(w2 / span * RS));
        var uo = bpsNorm(c.bps_out), ui = bpsNorm(c.bps_in), u = Math.max(uo, ui);
        _c.setHex(COL.ring).lerp(_c2.setHex(uo >= ui ? COL.out : COL.inb), 0.25 + 0.5 * u);
        for (k = 0; k < nseg && seg < RS; k++, seg++) {
          var s0 = a0 + gap / 2 + (w2 - gap) * k / nseg, s1 = a0 + gap / 2 + (w2 - gap) * (k + 1) / nseg, q2 = seg * 6;
          EX.rPos[q2] = w.x - Math.cos(s0) * RR; EX.rPos[q2 + 1] = w.y + 18; EX.rPos[q2 + 2] = w.z + Math.sin(s0) * RR;
          EX.rPos[q2 + 3] = w.x - Math.cos(s1) * RR; EX.rPos[q2 + 4] = w.y + 18; EX.rPos[q2 + 5] = w.z + Math.sin(s1) * RR;
          EX.rCol[q2] = _c.r; EX.rCol[q2 + 1] = _c.g; EX.rCol[q2 + 2] = _c.b; EX.rCol[q2 + 3] = _c.r; EX.rCol[q2 + 4] = _c.g; EX.rCol[q2 + 5] = _c.b;
        }
        /* cc tag: round 1 drew it 20 world units wide (invisible at 1080p) and
           only for arcs > 0.09 rad; now a plated 40-unit tag for any arc wide
           enough to carry one */
        if (ci < EX.ccLabels.length && w2 > 0.055) {
          var am = (a0 + a1) / 2, CL = EX.ccLabels[ci];
          CL.position.set(w.x - Math.cos(am) * (RR + 13), w.y + 18, w.z + Math.sin(am) * (RR + 13));
          CL.userData.set(c.cc || '??', ci === 0 ? '#e6f1ff' : '#b8cde6', 40, '', '', ci === 0 ? 2 : 1); CL.userData.on = true; CL.userData.base = 0.72 + 0.28 * u;
        }
        a0 = a1;
      });
    }
    EX.rGeo.setDrawRange(0, seg * 2); EX.rGeo.attributes.position.needsUpdate = true; EX.rGeo.attributes.color.needsUpdate = true;

    /* the tunnel station sits above/behind the WAN; strands go to the tunnel guest */
    EX.st.position.set(w.x + 22, w.y + 62, w.z - 26);
    EX.cfLbl.position.set(w.x + 22, w.y + 62 + 21, w.z - 26);
    EX.cfLbl.userData.on = !!(EX.cf);
    /* stacked ABOVE the tunnel plate: below the station it landed on the WAN
       node's own name and lost the collision pass every frame at the WAN stop */
    EX.thLbl.position.set(w.x + 22, w.y + 62 + 40, w.z - 26);
    updateStrands();
  }
  function bz(a, m, b, t) { var u = 1 - t; return u * u * a + 2 * u * t * m + t * t * b; }
  function updateStrands() {
    var SS = EX.SS, n = EX.ha, cfn = EX.cfNode;
    if (!n || !cfn) { EX.sGeo.setDrawRange(0, 0); EX.strandPts = null; return; }
    var s = EX.st.position, e = nodePos(cfn);
    var ex = e[0], ey = e[1], ez = e[2];
    var dx = ex - s.x, dz = ez - s.z, len = Math.max(1, Math.sqrt(dx * dx + dz * dz));
    var px = -dz / len, pz = dx / len;                         // lateral splay
    EX.strandPts = EX.strandPts || [];
    for (var i = 0; i < n; i++) {
      var off = (i - (n - 1) / 2) * 9, mx = (s.x + ex) / 2 + px * off, mz = (s.z + ez) / 2 + pz * off;
      var my = Math.max(s.y, ey) + 70 + Math.abs(off) * 0.6;
      EX.strandPts[i] = { ax: s.x, ay: s.y, az: s.z, mx: mx, my: my, mz: mz, bx: ex, by: ey, bz: ez };
      for (var k = 0; k < SS; k++) {
        var t0 = k / SS, t1 = (k + 1) / SS, q = (i * SS + k) * 6;
        EX.sPos[q] = bz(s.x, mx, ex, t0); EX.sPos[q + 1] = bz(s.y, my, ey, t0); EX.sPos[q + 2] = bz(s.z, mz, ez, t0);
        EX.sPos[q + 3] = bz(s.x, mx, ex, t1); EX.sPos[q + 4] = bz(s.y, my, ey, t1); EX.sPos[q + 5] = bz(s.z, mz, ez, t1);
      }
    }
    EX.strandPts.length = n;
    EX.sGeo.setDrawRange(0, n * SS * 2); EX.sGeo.attributes.position.needsUpdate = true;
  }

  /* particle seeding on every data refresh: arc streams keep their phase */
  function reseed() {
    var P = EX.P, keepP = {}, live = [];
    P.forEach(function (s) {
      if (s.kind === 'arc') keepP[s.b + ':' + s.dir + ':' + s.i] = s.p;
      /* v6: in-flight transients survive a data refresh - a poll used to wipe a
         request comet, a fleck or an intrusion streak mid-flight */
      else if (s.kind === 'req' || s.kind === 'fleck' || s.kind === 'atk' || s.kind === 'viewer') live.push(s);
    });
    P.length = 0;
    for (var li = 0; li < live.length; li++) P.push(live[li]);
    EX.beacons.forEach(function (b) {
      var uo = bpsNorm(b.out), ui = bpsNorm(b.inb);
      var no = uo > 0 ? Math.max(1, Math.round(uo * 9)) : 0, ni = ui > 0 ? Math.max(1, Math.round(ui * 9)) : 0;
      for (var i = 0; i < no; i++) P.push({ kind: 'arc', b: b, dir: 1, i: i, p: keepP[b.key + ':1:' + i] !== undefined ? keepP[b.key + ':1:' + i] : i / no, rate: 0.16 + 0.55 * uo, u: uo });
      for (var j = 0; j < ni; j++) P.push({ kind: 'arc', b: b, dir: -1, i: j, p: keepP[b.key + ':-1:' + j] !== undefined ? keepP[b.key + ':-1:' + j] : j / ni, rate: 0.16 + 0.55 * ui, u: ui });
    });
    /* carriers: one slow mote per HA strand so the tunnel reads as up even at 0 req/min */
    for (var c = 0; c < EX.ha; c++) P.push({ kind: 'carrier', s: c, p: c / Math.max(1, EX.ha), rate: 0.05 });
    /* talker runners */
    EX.talkers.forEach(function (t, ti) {
      var u = bpsNorm(t.bps), nr = Math.max(1, Math.round(1 + 3 * u));
      for (var r = 0; r < nr; r++) P.push({ kind: 'run', t: t, p: r / nr + ti * 0.13, rate: 0.10 + 0.22 * u, u: u });
    });
  }

  /* ---------------- threats (v6) ---------------- */
  function cleanTitle(t) {
    return String(t || '').replace(/^(crowdsecurity|LePresidente|[A-Za-z0-9]+)\//, '').replace(/_/g, ' ');
  }
  /* one impact ring + tag from the pool at a world position; the pool is the
     round-1 CrowdSec one, so old and new impacts look the same */
  function fireImpact(t, x, y, z, text, sub) {
    var free = -1;
    for (var ii = 0; ii < EX.impR.length; ii++) if (!EX.impR[ii].visible) { free = ii; break; }
    if (free < 0) return false;
    var R = EX.impR[free]; R.visible = true; R.position.set(x, y, z); R.userData.t0 = t;
    var IL = EX.impL[free]; IL.position.set(x, y + 16, z);
    IL.userData.set(text, '#ff8a95', 36, sub, '#e0a8b0', 2); IL.userData.on = true;
    /* the beat: shield flashes red (decays over 1 s in tick) and the bloom
       kicks once through the heartbeat API - never bloom.strength directly */
    EX.shieldFlash = 1;
    if (window.CINEMA && typeof window.CINEMA.beat === 'function') { try { window.CINEMA.beat(3); } catch (x) { } }
    return true;
  }
  function ccAngle(cc) {
    var a = EX.ccAng && cc ? EX.ccAng[cc] : undefined;
    if (a !== undefined) return a;
    return -ARC_SPAN + (hash32(cc || '??') % 1000) / 1000 * 2 * ARC_SPAN;
  }
  /* a frame from the stream or the poll: the plate always, the events only
     when seq moved (the first frame seen is the baseline - history never fires) */
  function threatFrame(f, fromPoll) {
    if (!f || !EX) return;
    EX.th = f;
    var lvl = Math.max(0, Math.min(3, +f.level || 0)), c = f.counts || {};
    EX.thLvl = lvl;
    EX.thLbl.userData.set('THREAT ' + (f.name || LEVEL_NAME[lvl]), LEVEL_COL[lvl], 30,
      '1h ' + (+c.crowdsec_1h || 0) + ' · 24h ' + (+c.crowdsec_24h || 0) + ' · ' + (+c.banned || 0) + ' banned'
      + ((+c.secmon_critical || 0) ? ' · ' + c.secmon_critical + ' crit' : ''), lvl >= 2 ? '#e0a0a8' : '#9fb8d0', 2);
    EX.thLbl.userData.on = !!f.up;
    var seq = +f.seq;
    if (!(seq >= 0)) return;
    if (EX.thSeq === null) {                     // baseline: remember, never replay
      EX.thSeq = seq; (f.events || []).forEach(function (e) { if (e && e.id) EX.thSeen[e.id] = 1; });
      return;
    }
    if (seq <= EX.thSeq) return;
    EX.thSeq = seq;
    var fired = 0;
    (f.events || []).forEach(function (e) {
      if (!e || !e.id || EX.thSeen[e.id] || fired >= 4) return;
      EX.thSeen[e.id] = 1; fired++;
      EX.thQueue.push(e);
    });
    if (fired) announce(f.events && f.events[0]);
  }
  /* the room lights (lightsync.js) and anything else on the page hear about
     a new intrusion here; one CustomEvent per new seq, never per frame */
  function announce(e) {
    try { window.dispatchEvent(new CustomEvent('galaxy:threat', { detail: { ts: Date.now(), event: e || null, level: EX.thLvl } })); } catch (x) { }
    var X = window.NETEXO; if (X && typeof X.onThreat === 'function') { try { X.onThreat(e); } catch (x) { } }
  }
  function findHostNode(NS, hosts) {
    if (!hosts || !hosts.length || !NS.nodes) return null;
    var want = {}; hosts.forEach(function (h) { want[String(h).toLowerCase()] = 1; });
    for (var i = 0; i < NS.nodes.length; i++) {
      var n = NS.nodes[i];
      if ((n.ip && want[String(n.ip).toLowerCase()]) || want[String(n.id).toLowerCase()]
          || (n.label && want[String(n.label).toLowerCase()]) || (n.id && want[String(n.id).replace(/^pve:/, '').toLowerCase()])) return n;
    }
    return null;
  }
  /* launch one queued event: crowdsec -> streak from the ring, secmon -> node ring */
  function launch(NS, w, t, e) {
    if (e.src === 'secmon') {
      var n = findHostNode(NS, e.hosts) || NS.byId.wan; if (!n) return;
      var slot = null;
      for (var i = 0; i < EX.nodeRings.length; i++) if (!EX.nodeRings[i].n) { slot = EX.nodeRings[i]; break; }
      if (!slot) slot = EX.nodeRings[0];
      slot.n = n; slot.t0 = t; slot.ring.visible = true;
      slot.lbl.userData.set(cleanTitle(e.title) || (e.kind || 'FINDING'), '#ff9aa6', 30,
        (e.kind || 'FINDING') + (e.category ? ' · ' + String(e.category).replace(/_/g, ' ') : '') + (n.label ? ' · ' + n.label : ''), '#d9a0a8', 2);
      slot.lbl.userData.on = true;
      NS._extScan = undefined;
      return;
    }
    /* crowdsec (or anything with a country): streak ring -> shield */
    if (e.id) EX.seen[String(e.id).replace(/^cs:/, '')] = 1;   // the per-poll impact must not repeat it
    var a = ccAngle(e.cc), RR = RING_R * EX.k;
    var S = { a: a, x0: w.x - Math.cos(a) * RR, y0: w.y + 18, z0: w.z + Math.sin(a) * RR,
              x1: w.x - Math.cos(a) * SHIELD_R, y1: w.y + 14 + (hash32(e.id || e.cc) % 20), z1: w.z + Math.sin(a) * SHIELD_R,
              p: 0, rate: 1 / 1.15, e: e, hit: false };
    for (var j = 0; j < STREAK_N; j++) if (EX.P.length < P_CAP - 1) EX.P.push({ kind: 'atk', S: S, tr: j });
    S.fl = -1;
    for (var fi2 = 0; fi2 < EX.flares.length; fi2++) if (!EX.flares[fi2].visible) { S.fl = fi2; EX.flares[fi2].visible = true; break; }
    EX.streaks.push(S);
  }
  function threatImpact(t, S) {
    var e = S.e;
    var scen = cleanTitle(e.title);
    fireImpact(t, S.x1, S.y1, S.z1, (e.kind || 'BLOCKED') + ' · ' + (e.cc || '??') + ' · ' + shortAS(e.as_name, ''),
      scen + (e.events ? ' · ' + e.events + ' ev' : ''));
  }
  /* 5 s poll of /api/threats (plus the edge.threats mirror on every topology
     poll). The SSE stream is opt-in (window.NB_THREAT_SSE = true) and OFF by
     default, measured 2026-09-19: the wall already holds five EventSources
     (pulse x2, presence, takeover, mode) and Chromium allows six connections
     per host, so a sixth stream left ONE slot for every poll and POST on the
     page - sky.jpg never arrived, /api/all and /api/topology froze, the load
     event never fired. Closing the stream un-froze it instantly. */
  function connectThreats() {
    if (EX.thES !== undefined) return;
    EX.thES = null;
    if (window.NB_THREAT_SSE === true && typeof window.EventSource === 'function') {
      try {
        var es = new EventSource('/api/threats/stream');
        es.onmessage = function (ev) { try { threatFrame(JSON.parse(ev.data), false); } catch (x) { } };
        EX.thES = es;
      } catch (x) { EX.thES = null; }
    }
    setInterval(function () {
      try { fetch('/api/threats').then(function (r) { return r.ok ? r.json() : null; }).then(function (j) { if (j) threatFrame(j, true); }).catch(function () { }); } catch (x) { }
    }, 5000);
  }

  /* r2: an impact tag is the beat - the beacon / country tags that share its
     patch of screen step aside for the ring's life (they are rank 5, same as
     the tag, and the nearer one would otherwise win the collision pass) */
  function nearImpact(p) {
    var A = EX.impAct, R = 80 * EX.k;
    for (var i = 0; i < EX.impN; i++) {
      var dx = p.x - A[i * 3], dy = p.y - A[i * 3 + 1], dz = p.z - A[i * 3 + 2];
      if (dx * dx + dy * dy + dz * dz < R * R) return true;
    }
    return false;
  }

  /* ---------------- per-frame ---------------- */
  function stopKey(NS) {
    var TR = NS.tour; if (!TR || !TR.stops || !TR.stops.length) return '';
    var st = TR.stops[(TR.phase === 'travel' && TR.switched) ? TR.next : TR.idx];
    return st ? (st.key || '') : '';
  }
  var TOUR_COL = { over: '#5ad7ff', wan: '#ffb347', fabric: '#5ad7ff', wired: '#9bd8ff', ap: '#37f5a0', host: '#ffb347',
                   ai: '#ff4fa3', media: '#38e1ff', network: '#37f5a0', monitor: '#ffb347', web: '#9b8cff', infra: '#8fb0d0' };
  function publishTour(key) {
    if (key === EX.lastStop) return; EX.lastStop = key;
    var c = TOUR_COL.over, m;
    if (/^wan/.test(key)) c = TOUR_COL.wan; else if (/^fabric/.test(key)) c = TOUR_COL.fabric;
    else if (/^wired/.test(key)) c = TOUR_COL.wired; else if (/^ap:/.test(key)) c = TOUR_COL.ap;
    else if ((m = /^blk:[^:]+:[^:]+:([a-z-]+)$/.exec(key))) c = TOUR_COL[m[1]] || TOUR_COL.infra;
    else if (/^host:/.test(key)) c = /gpu/.test(key) ? '#5ad7ff' : '#ffb347';
    if (c === EX.tourCol) return; EX.tourCol = c;
    var r = parseInt(c.slice(1, 3), 16), g = parseInt(c.slice(3, 5), 16), b = parseInt(c.slice(5, 7), 16);
    var st = document.documentElement.style;
    st.setProperty('--tour', c); st.setProperty('--tour-glow', 'rgba(' + r + ',' + g + ',' + b + ',.45)'); st.setProperty('--tour-soft', 'rgba(' + r + ',' + g + ',' + b + ',.16)');
  }

  function tick(t, dt) {
    if (!EX) return;
    /* once per scene frame, whatever the wrapper chain does. Measured on the
       wall 2026-09-19: cinema.js and showtime.js wrap netSceneTick without
       carrying the __exo/__flows flags, so the self-healing wrap below saw an
       unflagged function and wrapped AGAIN - this tick ran 120x/s at 60 fps
       (2x speed on every particle, 2x comets per request, 2x the CPU). */
    if (t === EX.lastT) return;
    EX.lastT = t;
    var NS = ns(); if (!NS || !NS.byId) return;
    dt = Math.min(0.1, Math.max(0.001, dt));
    EX.t = t;
    var key = stopKey(NS);
    publishTour(key);
    /* visible at the overview and the WAN EDGE stop; folded away for close-ups */
    EX.want = (NS.focusAll !== false || /^wan/.test(key) || /^fabric/.test(key)) ? 1 : 0;
    if (/^fabric/.test(key) && NS.focusAll === false) EX.want = 0.35;
    EX.vis += (EX.want - EX.vis) * (1 - Math.exp(-dt * 3.0));
    var vis = EX.vis;
    var w = wanPos(NS); if (!w) return;

    /* threat stream: one launch every 0.55 s from the new-event queue. Runs
       ahead of the visibility gate: a secmon finding rings an estate node,
       which is on screen exactly when the exosphere is folded away. */
    if (EX.thQueue.length && (t - EX.thT) > 0.55) { EX.thT = t; launch(NS, w, t, EX.thQueue.shift()); }
    /* secmon node rings: ~6 s on the estate side, independent of the group's visibility */
    for (var nri = 0; nri < EX.nodeRings.length; nri++) {
      var NR = EX.nodeRings[nri]; if (!NR.n) continue;
      var ne = t - NR.t0, nlife = 6.0;
      if (ne > nlife) { NR.n = null; NR.ring.visible = false; NR.ring.material.opacity = 0; NR.lbl.visible = false; NR.lbl.material.opacity = 0; NR.lbl.userData.on = false; continue; }
      var np = nodePos(NR.n), nk = ne / nlife;
      var foc = NS.nodeFocus ? NS.nodeFocus(NR.n.id) : 1;
      NR.ring.position.set(np[0], np[1] - 4, np[2]);
      var nrs = 26 + 12 * (0.5 + 0.5 * Math.sin(ne * 6.0)) + 40 * Math.min(1, ne * 2.0) * (1 - nk); NR.ring.scale.set(nrs, nrs, 1);
      NR.ring.material.opacity = (0.55 + 0.4 * (0.5 + 0.5 * Math.sin(ne * 6.0))) * (1 - nk * nk) * (0.35 + 0.65 * foc);
      /* the tag hangs BELOW the node: above it is where netscene draws the
         node's own name (rank 0), which this rank-5 tag would lose to every frame */
      NR.lbl.position.set(np[0], np[1] - 22, np[2]);
      NR.lbl.visible = !lpHid(NR.lbl, NS);
      NR.lbl.material.opacity = NR.lbl.visible ? Math.min(1, ne * 3) * (nk < 0.75 ? 1 : 1 - (nk - 0.75) / 0.25) * (0.4 + 0.6 * foc) : 0;
    }

    if (vis < 0.02) { if (EX.grp.visible) { EX.grp.visible = false; hideLabels(); } return; }
    EX.grp.visible = true;
    /* WAN moved (tween after a rebuild)? re-anchor */
    if (Math.abs(w.x - (EX.wx || 0)) + Math.abs(w.y - (EX.wy || 0)) + Math.abs(w.z - (EX.wz || 0)) > 0.05) { EX.wx = w.x; EX.wy = w.y; EX.wz = w.z; rebuildStatic(); }
    else if (EX.cfNode && (EX.t - (EX.strandT || 0)) > 0.5) { EX.strandT = EX.t; updateStrands(); }

    /* round 2: shells compact away from the WAN EDGE stop (fits the overview
       box), and the label tier grows into it. ~2 s of cheap rebuilds per leg. */
    var atWan = /^wan/.test(key);
    EX.kT = atWan ? 1 : KO;
    EX.k += (EX.kT - EX.k) * (1 - Math.exp(-dt * 2.5));
    if (Math.abs(EX.k - EX.kBuilt) > 0.004) rebuildStatic();
    EX.big += ((atWan ? 1 : 0) - EX.big) * (1 - Math.exp(-dt * 3.0));
    var big = EX.big;

    var beat = 0.5 + 0.5 * Math.sin(t * 1.4);
    EX.arcs.material.opacity = (0.55 + 0.15 * beat) * vis;
    EX.ring.material.opacity = (0.55 + 0.2 * big) * vis;
    EX.bPts.material.opacity = vis;
    /* r2: the shield itself flashes red on an impact (0.16 -> 0.70, 1 s decay) */
    if (EX.shieldFlash > 0) EX.shieldFlash = Math.max(0, EX.shieldFlash - dt);
    EX.shield.material.opacity = (0.16 + 0.54 * EX.shieldFlash) * vis;
    EX.shield.material.color.setHex(0x5a3a55).lerp(_c2.setHex(COL.atk), EX.shieldFlash);
    /* beacon labels: top-N 1.0x -> 1.55x at the WAN stop, the rest 0.9x -> 1.25x;
       subordinate (smaller, dimmer) everywhere else. The pass's verdict for this
       frame (lpHid) is final - see labelPass() in netscene.js. */
    for (var i = 0; i < MAXB; i++) {
      var L = EX.labels[i], on = L.userData.on, top = L.userData.top;
      L.userData.setW(top ? 1 + 0.9 * big : 0.9 + 0.5 * big);
      L.visible = !!on && vis > 0.05 && !lpHid(L, NS) && !(EX.impN && nearImpact(L.position));
      L.material.opacity = L.visible ? L.userData.base * (top ? 1 : 0.8 + 0.2 * big) * vis : 0;
    }
    for (var c = 0; c < EX.ccLabels.length; c++) {
      var CL = EX.ccLabels[c]; CL.userData.setW(1 + 0.3 * big);
      CL.visible = !!CL.userData.on && vis > 0.05 && !lpHid(CL, NS) && !(EX.impN && nearImpact(CL.position));
      /* the ring's far side projects under the HUD strips: a cc tag that lands
         outside the HUD-safe band is dropped, not drawn through the DOM text */
      if (CL.visible && NS.cam) { _v.copy(CL.position).project(NS.cam); if (_v.z > 1 || _v.y < -0.74 || _v.y > 0.74 || _v.x < -0.9 || _v.x > 0.9) CL.visible = false; }
      CL.material.opacity = CL.visible ? CL.userData.base * (0.8 + 0.2 * big) * vis : 0;
    }

    /* Cloudflare station */
    var cf = EX.cf, up = !!(cf && cf.up), rpm = up ? (+cf.req_per_min || 0) : 0;
    EX.torus.rotation.z += dt * 0.35; EX.torus2.rotation.x += dt * 0.55;
    var pulse = up ? 0.6 + 0.4 * Math.sin(t * (1.0 + Math.min(4, rpm / 10))) : 0.15;
    EX.halo.material.opacity = (0.25 + 0.35 * pulse) * vis;
    EX.torus.material.opacity = (up ? 0.85 : 0.3) * vis; EX.torus2.material.opacity = (up ? 0.6 : 0.2) * vis; EX.core.material.opacity = vis;
    EX.strands.material.opacity = (up ? 0.40 + 0.22 * pulse : 0.08) * vis;
    EX.cfLbl.userData.setW(1 + 0.45 * big);
    EX.cfLbl.visible = !!EX.cfLbl.userData.on && vis > 0.05 && !lpHid(EX.cfLbl, NS);
    EX.cfLbl.material.opacity = EX.cfLbl.visible ? (0.8 + 0.2 * big) * vis : 0;
    /* request comets at req_per_min: accumulate real time, one comet per request */
    if (up && rpm > 0 && EX.strandPts && EX.strandPts.length) {
      EX.cfAcc += dt * rpm / 60;
      while (EX.cfAcc >= 1) { EX.cfAcc -= 1; if (EX.P.length < P_CAP - 8) { var si = (EX.cfSeq = ((EX.cfSeq || 0) + 1)) % EX.strandPts.length; for (var tr = 0; tr < 6; tr++) EX.P.push({ kind: 'req', s: si, p: -tr * 0.035, rate: 0.42, tr: tr }); } }
    }
    /* flecks: non-2xx deltas shoot off the station */
    for (var fi = EX.flecks.length - 1; fi >= 0; fi--) {
      var F = EX.flecks[fi]; F.t += dt; if (F.t > 1.3) { EX.flecks.splice(fi, 1); continue; }
      if (F.t >= 0 && !F.live) { F.live = true; var ang = hash32(F.kind + ':' + fi + ':' + Math.floor(t * 7)) % 628 / 100; F.dx = Math.cos(ang); F.dz = Math.sin(ang); F.dy = 0.4 + (hash32('y' + fi + t) % 100) / 200; if (EX.P.length < P_CAP - 1) EX.P.push({ kind: 'fleck', f: F }); }
    }
    /* CrowdSec impacts: one from the queue every 1.1 s */
    if (EX.queue.length && (t - (EX.impT || -9)) > 1.1) {
      EX.impT = t; var a = EX.queue.shift();
      var ang2 = (hash32(a.ip) % 628) / 100, ang3 = -ARC_SPAN * 0.9 + (ang2 / 6.28) * ARC_SPAN * 1.8;
      var scen = String(a.scenario || '').replace(/^crowdsecurity\//, '').replace(/-probing$/, '').replace(/_/g, ' ');
      fireImpact(t, w.x - Math.cos(ang3) * SHIELD_R, w.y + 14 + (hash32(a.ip + 'y') % 20), w.z + Math.sin(ang3) * SHIELD_R,
        (a.cn || '??') + ' · ' + shortAS(a.as_name, a.ip), scen + ' · ' + (a.events || 1) + ' ev');
    }
    for (var si = EX.streaks.length - 1; si >= 0; si--) {
      var SK = EX.streaks[si];
      SK.p += dt * SK.rate;
      if (SK.p >= 1 && !SK.hit) { SK.hit = true; threatImpact(t, SK); }
      if (SK.fl >= 0) {
        var FL = EX.flares[SK.fl], hp = Math.min(1, SK.p), hpe = hp * hp * (3 - 2 * hp);
        FL.position.set(SK.x0 + (SK.x1 - SK.x0) * hpe, SK.y0 + (SK.y1 - SK.y0) * hpe + 6 * Math.sin(hp * Math.PI), SK.z0 + (SK.z1 - SK.z0) * hpe);
        var over = Math.max(0, SK.p - 1) / (0.055 * STREAK_N);        // 0 at the hit, 1 when the tail lands
        var fs = (18 + 10 * hp) * (1 + 1.6 * over); FL.scale.set(fs, fs, 1);
        FL.material.opacity = (0.55 + 0.35 * hp) * (1 - over) * vis;
      }
      if (SK.p >= 1 + 0.055 * STREAK_N) {                              // tail has landed
        if (SK.fl >= 0) { EX.flares[SK.fl].visible = false; EX.flares[SK.fl].material.opacity = 0; }
        EX.streaks.splice(si, 1);
      }
    }
    /* level plate: level colour, slow 0.4 Hz pulse at RED/BLACK */
    var thOn = !!EX.thLbl.userData.on;
    EX.thLbl.userData.setW(1 + 0.3 * big);
    EX.thLbl.visible = thOn && vis > 0.05 && !lpHid(EX.thLbl, NS);
    EX.thLbl.material.opacity = EX.thLbl.visible ? ((EX.thLvl >= 2 ? 0.72 + 0.28 * (0.5 + 0.5 * Math.sin(t * 2.5)) : 0.85) * (0.8 + 0.2 * big) * vis) : 0;
    EX.impN = 0;
    for (var ri = 0; ri < EX.impR.length; ri++) {
      var RR = EX.impR[ri]; if (!RR.visible) continue;
      EX.impAct[EX.impN * 3] = RR.position.x; EX.impAct[EX.impN * 3 + 1] = RR.position.y; EX.impAct[EX.impN * 3 + 2] = RR.position.z; EX.impN++;
      /* round 2: 4.0 s life (was 3.4), ring grows to 76 units (was 46) so it is
         noticed from across the room. Real events only - nothing here is faked. */
      /* r2: 5.0 s life (was 4.0), ring grows to ~130 units (was 76) so the
         beat is seen from across the room. Real events only - nothing here is faked. */
      var e = t - RR.userData.t0, life = 5.0;
      if (e > life) { RR.visible = false; RR.material.opacity = 0; EX.impL[ri].visible = false; EX.impL[ri].material.opacity = 0; EX.impL[ri].userData.on = false; continue; }
      var k = e / life, rs = 12 + 118 * Math.pow(k, 0.6); RR.scale.set(rs, rs, 1);
      RR.material.opacity = (1 - k) * (1 - k) * vis;
      var ILb = EX.impL[ri]; ILb.userData.setW(1 + 0.25 * big); ILb.visible = vis > 0.05 && !lpHid(ILb, NS);
      ILb.material.opacity = ILb.visible ? Math.min(1, e * 4) * (k < 0.6 ? 1 : 1 - (k - 0.6) / 0.4) * vis : 0;
    }

    /* talker paths: current node positions (they tween after a rebuild) */
    var tn = 0, tp = EX.tPos;
    EX.talkers.forEach(function (T) {
      var pts = T.pts || (T.pts = []); pts.length = 0;
      for (var h = 0; h < T.chain.length; h++) pts.push(nodePos(T.chain[h]));
      if (T.beacon) pts.push([T.beacon.x, T.beacon.y, T.beacon.z]);
      T.len = 0; T.cum = T.cum || []; T.cum.length = 0; T.cum.push(0);
      for (var s = 0; s + 1 < pts.length && tn < 30; s++) {
        var q = tn * 6; tp[q] = pts[s][0]; tp[q + 1] = pts[s][1]; tp[q + 2] = pts[s][2]; tp[q + 3] = pts[s + 1][0]; tp[q + 4] = pts[s + 1][1]; tp[q + 5] = pts[s + 1][2]; tn++;
        var ddx = pts[s + 1][0] - pts[s][0], ddy = pts[s + 1][1] - pts[s][1], ddz = pts[s + 1][2] - pts[s][2];
        T.len += Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz); T.cum.push(T.len);
      }
    });
    EX.tGeo.setDrawRange(0, tn * 2); EX.tGeo.attributes.position.needsUpdate = true;
    EX.tLines.material.opacity = (0.22 + 0.14 * beat) * vis;

    /* particles */
    var P = EX.P, pos = EX.pPos, col = EX.pCol, n = 0;
    for (var pi = P.length - 1; pi >= 0; pi--) {
      var S = P[pi], x, y, z, r, g, b2, al = 1;
      if (S.kind === 'arc') {
        S.p += dt * S.rate; if (S.p >= 1) S.p -= 1;
        var tt = S.dir > 0 ? S.p : 1 - S.p, B = S.b;
        x = bz(B.ax, B.mx, B.x, tt); y = bz(B.ay, B.my, B.y, tt) + 1.2; z = bz(B.az, B.mz, B.z, tt);
        _c.setHex(S.dir > 0 ? COL.out : COL.inb); r = _c.r; g = _c.g; b2 = _c.b; al = 0.5 + 0.5 * S.u;
        var lane = S.dir * 2.2; x += lane * 0.3; z += lane;
      } else if (S.kind === 'carrier' || S.kind === 'req' || S.kind === 'viewer') {
        var SP = EX.strandPts && EX.strandPts[S.s];
        if (!SP) { P.splice(pi, 1); continue; }
        S.p += dt * S.rate;
        if (S.kind === 'carrier') { if (S.p >= 1) S.p -= 1; }
        else if (S.p >= 1) { P.splice(pi, 1); continue; }
        var tq = Math.max(0, S.p);
        x = bz(SP.ax, SP.mx, SP.bx, tq); y = bz(SP.ay, SP.my, SP.by, tq) + (S.kind === 'viewer' ? 2.5 : 0); z = bz(SP.az, SP.mz, SP.bz, tq);
        _c.setHex(S.kind === 'viewer' ? COL.gold : COL.cf); r = _c.r; g = _c.g; b2 = _c.b;
        al = S.kind === 'carrier' ? 0.5 : S.kind === 'viewer' ? 1.6 : (S.tr === 0 ? 1.7 : 1.1 - S.tr * 0.17);
        if (S.p < 0) al = 0;
      } else if (S.kind === 'atk') {
        /* intrusion streak: head at S.p, tail points trail by 0.045 each,
           tapered; every point dies as it reaches the shield */
        var SK2 = S.S, pp = SK2.p - S.tr * 0.055;
        if (pp >= 1) { P.splice(pi, 1); continue; }
        if (pp < 0) { al = 0; x = SK2.x0; y = SK2.y0; z = SK2.z0; }
        else {
          var ppe = pp * pp * (3 - 2 * pp);
          x = SK2.x0 + (SK2.x1 - SK2.x0) * ppe; y = SK2.y0 + (SK2.y1 - SK2.y0) * ppe + 6 * Math.sin(pp * Math.PI); z = SK2.z0 + (SK2.z1 - SK2.z0) * ppe;
          var tf = 1 - S.tr / STREAK_N; al = (S.tr === 0 ? 1.8 : 1.3) * tf * tf;
        }
        _c.setHex(COL.atk); r = _c.r; g = _c.g; b2 = _c.b;
      } else if (S.kind === 'fleck') {
        var F2 = S.f; if (F2.t > 1.3 || F2.t < 0) { if (F2.t > 1.3) { P.splice(pi, 1); } continue; }
        var d = 4 + 26 * F2.t;
        x = EX.st.position.x + F2.dx * d; y = EX.st.position.y + F2.dy * d; z = EX.st.position.z + F2.dz * d;
        _c.setHex(F2.kind === 3 ? 0xffc07a : 0xff7a5a); r = _c.r; g = _c.g; b2 = _c.b; al = 1 - F2.t / 1.3;
      } else if (S.kind === 'run') {
        var T2 = S.t; if (!T2.pts || T2.pts.length < 2 || !T2.len) continue;
        S.p += dt * S.rate; if (S.p >= 1) S.p -= 1;
        var dist = S.p * T2.len, seg = 0; while (seg + 1 < T2.cum.length - 1 && T2.cum[seg + 1] < dist) seg++;
        var sl = T2.cum[seg + 1] - T2.cum[seg], ft = sl > 0 ? (dist - T2.cum[seg]) / sl : 0, A = T2.pts[seg], Bp = T2.pts[seg + 1];
        x = A[0] + (Bp[0] - A[0]) * ft; y = A[1] + (Bp[1] - A[1]) * ft + 1.5; z = A[2] + (Bp[2] - A[2]) * ft;
        _c.setHex(COL.gold); r = _c.r; g = _c.g; b2 = _c.b; al = 0.6 + 0.6 * S.u;
      } else continue;
      if (n >= P_CAP) break;
      var o = n * 3; pos[o] = x; pos[o + 1] = y; pos[o + 2] = z;
      al *= vis; col[o] = r * al; col[o + 1] = g * al; col[o + 2] = b2 * al; n++;
    }
    EX.pGeo.setDrawRange(0, n); EX.pGeo.attributes.position.needsUpdate = true; EX.pGeo.attributes.color.needsUpdate = true;
  }
  function hideLabels() {
    var all = EX.labels.concat(EX.ccLabels, EX.impL, [EX.cfLbl, EX.thLbl]);
    for (var i = 0; i < all.length; i++) { all[i].visible = false; all[i].material.opacity = 0; }
    for (var f = 0; f < EX.flares.length; f++) EX.flares[f].material.opacity = 0;
  }
  /* true when netscene's collision pass has already judged this sprite THIS
     frame and hid it: our per-frame opacity write must not re-raise it. On any
     other frame the pass has not run yet and we re-arm the sprite for it. */
  function lpHid(sp, NS) {
    var ud = sp.userData;
    return !!(ud.hidden && NS && NS.t !== undefined && ud.lpFrame === NS.t);
  }

  /* ---------------- wiring (same self-healing wrap as netscene_flows) ---------------- */
  (function w() {
    try {
      if (!EX && window.NETSCENE && window.NETSCENE.scene) { if (init()) connectThreats(); }
      if (EX && typeof window.netSceneUpdate === 'function' && !window.netSceneUpdate.__exo) {
        var u = window.netSceneUpdate;
        var wu = function (topo) { u(topo); try { if (topo && topo.nodes) update(topo); } catch (e) { console.error('exo: update failed', e); } };
        wu.__exo = true; wu.__flows = u.__flows; window.netSceneUpdate = wu;
      }
      if (EX && typeof window.netSceneTick === 'function' && !window.netSceneTick.__exo) {
        var k = window.netSceneTick;
        var wk = function (t, dt) { k(t, dt); try { tick(t, dt); } catch (e) { console.error('exo: tick failed', e); window.netSceneTick = k; } };
        wk.__exo = true; wk.__flows = k.__flows; window.netSceneTick = wk;
      }
    } catch (e) { }
    var done = EX && window.netSceneUpdate && window.netSceneUpdate.__exo && window.netSceneTick && window.netSceneTick.__exo;
    setTimeout(w, done ? 2000 : 300);
  })();
  window.NETEXO = {
    state: function () { return EX; },
    /* QA: inject a fake threat event object (same shape as edge.threats.events[])
       - it takes the exact path a real stream event does, including the room
       lights. e.g. NETEXO.threat({src:'crowdsec',kind:'BLOCKED',cc:'US',
       as_name:'GOOGLE-CLOUD-PLATFORM',title:'http-probing',events:7}) */
    threat: function (e) {
      if (!EX || !e) return false;
      e = Object.assign({}, e); e.id = e.id || ('qa:' + Date.now() + ':' + Math.random().toString(36).slice(2, 7));
      EX.thSeen[e.id] = 1; EX.thQueue.push(e); announce(e); return true;
    },
    onThreat: null
  };
})();
