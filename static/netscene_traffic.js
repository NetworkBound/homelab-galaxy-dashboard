/* ============================================================================
   netscene_traffic.js - MEASURED traffic between galaxies, on the wall
   (2026-10-08; docs/contracts.md section 6 + 7)

   Source: /api/universe `traffic` (data), read from the universe poll
   netscene_universe.js already makes (NETSCENE.U.data) - no extra request.
     pairs[]  {a, b, bps, a_to_b_bps?, b_to_a_bps?, kind, links, top, src}
     wan[]    {system, in_bps, out_bps, via}

   WHAT IT DRAWS
   * One stream per measured system pair, galaxy core to galaxy core, and one
     per system with measured WAN traffic, to the Internet node. A stream is a
     low arc over the galactic plane (bowed sideways so two lanes never sit on
     top of each other), rendered as a soft camera-facing ribbon with a slow
     energy pattern travelling in the measured direction, plus particles.
   * Direction measured  -> two lanes, each with its own rate and direction.
     Only a total         -> one neutral lane, particles both ways at half
                             density (direction unknown: never invented).
     No entry             -> nothing at all. Never a fake animation.
   * Intensity is log-scaled and capped (NB_MOTION.actU: 1 kb/s .. 100 Mb/s):
     ribbon width, brightness, particle count and speed (flowLaps, capped).
     Colour = kind, restrained: lan, storage, backup, wan, vpn, media, mixed.
   * Labels: at the overview the top three streams get "4.6 Mb/s · storage"
     (rate + kind, nothing else; a sampled value reads "≈ 4.6 Mb/s"). At a
     close-up only the subject's strongest stream keeps its label, the other
     streams fade to a quiet trace.
   * Fades in / out over ~1.5 s when a pair appears or disappears.

   COST: ONE instanced draw for every ribbon lane and ONE Points draw for every
   particle; both animate in the vertex shader from a uniform clock (clamped
   dt accumulation, motion grammar section 3), so the per-frame JS is a few
   uniform writes. The arcs are recomputed only while their galaxies move.

   TOUR: NETSCENE.T.strongest() names the strongest measured pair for the
   tour's "follow the stream" stop (netscene.js), and NETSCENE.T.arc() gives
   its curve for the camera ride.
   ========================================================================== */
(function () {
  'use strict';
  var THREE = window.THREE; if (!THREE) return;
  var Q = (location.search.match(/[?&]traffic=(\w+)/) || [])[1] || '';
  if (Q === 'off') return;

  var MAXL = 48;                 // ribbon lanes (pairs x 2 + wan x 2)
  var SEG = 40;                  // ribbon cross-sections per lane
  var MAXP = 1400;               // particles
  var PER_LANE = 40;             // particles per lane at full rate
  var KIND = {                   // restrained: ~45 % toward neutral, status colours stay unique
    lan: '#7fb4d8', storage: '#6fc7a5', backup: '#a99ad6', wan: '#d9a866',
    vpn: '#d98f96', media: '#cf8fbf', mixed: '#9aa8ba'
  };
  var KIND_NAME = { lan: 'LAN', storage: 'storage', backup: 'backup', wan: 'internet', vpn: 'VPN', media: 'media', mixed: 'mixed' };
  var LBL_TOP = 3;

  var NS = null, M = null;
  var S = {
    lanes: [], pairs: {}, sig: '', mesh: null, pts: null, labels: [],
    clock: 0, ctrl: null, laneA: null, pAttr: null, built: false, dataTs: 0,
    strongest: null
  };

  function fmtBps(b) {
    b = +b || 0;
    if (b < 1e3) return b.toFixed(0) + ' b/s';
    if (b < 1e6) return (b / 1e3).toPrecision(3).replace(/\.0+$|(\.\d*?)0+$/, '$1') + ' kb/s';
    if (b < 1e9) return (b / 1e6).toPrecision(3).replace(/\.0+$|(\.\d*?)0+$/, '$1') + ' Mb/s';
    return (b / 1e9).toPrecision(3) + ' Gb/s';
  }
  /* a lower bound (flow layer: only what the flow sensor saw) is not the
     same thing as a sampled estimate: "≥" vs "≈" */
  function lowerBound(p) { return !!(p && (p.partial || p.layer === 'flow' || (p.wan && (p.wan.partial || p.wan.layer === 'flow')))); }
  function sampled(p) {
    if (p.sampled) return true;
    var s = p.src || [];
    for (var i = 0; i < s.length; i++) if (/akvorado|ipfix|sflow|netflow|sampled/i.test(String(s[i]))) return true;
    return false;
  }

  /* ---------------- shaders ---------------- */
  /* ribbon lane: instance = one lane. aP0/aP1/aP2 = quadratic bezier control
     points (world), aLane = (offset side px-ish world, width, intensity, dir),
     aCol = colour, aFade = (fade, focus, phase, speed). position.x = t along the
     lane (0..1), position.y = side (-1 / +1). */
  var RIB_VS = [
    'attribute vec3 aP0; attribute vec3 aP1; attribute vec3 aP2;',
    'attribute vec4 aLane; attribute vec3 aCol; attribute vec4 aAnim;',
    'uniform float uTime; uniform float uPx; uniform float uCap;',
    'varying vec3 vCol; varying float vT; varying float vS; varying float vA; varying float vFog; varying float vDir; varying float vPh;',
    'void main(){',
    '  float t = position.x, u = 1.0 - t;',
    '  vec3 p = u * u * aP0 + 2.0 * u * t * aP1 + t * t * aP2;',
    '  vec3 tg = normalize(2.0 * u * (aP1 - aP0) + 2.0 * t * (aP2 - aP1));',
    '  vec4 mv = modelViewMatrix * vec4(p, 1.0);',
    '  vec3 tv = normalize((modelViewMatrix * vec4(tg, 0.0)).xyz);',
    '  vec3 cr = cross(tv, vec3(0.0, 0.0, 1.0)); float cl = length(cr);',
    '  vec3 side = cl > 1e-4 ? cr / cl : vec3(1.0, 0.0, 0.0);',
    /* taper both ends into the galaxy cores */
    '  float taper = smoothstep(0.0, 0.10, t) * (1.0 - smoothstep(0.90, 1.0, t));',
    /* the width is in world units, so a close-up blew a lane up into a wide white
       beam across the frame (2026-10-09): cap its half-width on screen at ~9 px,
       the overview (where lanes are ~5-11 px) is untouched */
    '  float hw = aLane.y * 2.2 * (0.35 + 0.65 * taper), hpx = hw * uPx / max(1.0, -mv.z);',
    '  mv.xyz += side * position.y * hw * min(1.0, uCap / max(hpx, 1e-3));',
    '  vCol = aCol; vT = t; vS = position.y; vA = aAnim.x * aAnim.y * aLane.z * taper; vDir = aLane.w;',
    '  vPh = aAnim.z + aAnim.w * uTime;',
    '  vFog = -mv.z;',
    '  gl_Position = projectionMatrix * mv;',
    '}'].join('\n');
  var RIB_FS = [
    'varying vec3 vCol; varying float vT; varying float vS; varying float vA; varying float vFog; varying float vDir; varying float vPh;',
    'uniform float uFog;',
    'void main(){',
    /* profile across the lane: a bright core (inner 40 %) over a soft halo
       that fades to nothing at the ribbon edge - a beam, not a flat strip */
    '  float a = abs(vS), core = 1.0 - smoothstep(0.0, 0.38, a), halo = pow(1.0 - a, 2.2);',
    '  float edge = core + 0.32 * halo;',
    /* energy pattern: soft crests travelling along the lane; a neutral lane
       (vDir 0) only breathes, it never pretends to have a direction */
    '  float k = vDir == 0.0 ? 0.5 + 0.5 * sin(vPh * 6.2832) : fract(vT * 6.0 - vDir * vPh);',
    '  float crest = vDir == 0.0 ? 0.55 + 0.25 * k : 0.45 + 0.75 * pow(k, 6.0);',
    '  float f = 1.0 - exp(-uFog * uFog * vFog * vFog);',
    '  vec3 c = vCol * vA * edge * crest * (1.0 - clamp(f, 0.0, 0.85)) * smoothstep(120.0, 420.0, vFog);',
    '  if (c.r + c.g + c.b < 0.003) discard;',
    '  gl_FragColor = vec4(c, 1.0);',
    '}'].join('\n');
  /* particles: each point knows its lane (control points copied in), its
     phase and lane speed; position along the bezier is computed here */
  var PT_VS = [
    'attribute vec3 aP0; attribute vec3 aP1; attribute vec3 aP2; attribute vec4 aPar; attribute vec3 aCol; attribute float aSide;',
    'uniform float uTime; uniform float uPx;',
    'varying vec3 vCol; varying float vFog; varying float vAng;',
    'void main(){',
    /* aPar: x phase, y laps/s (signed by direction), z brightness, w size */
    '  float t = fract(aPar.x + aPar.y * uTime), u = 1.0 - t;',
    '  vec3 p = u * u * aP0 + 2.0 * u * t * aP1 + t * t * aP2;',
    '  vec3 tg = normalize(2.0 * u * (aP1 - aP0) + 2.0 * t * (aP2 - aP1));',
    '  vec4 mv = modelViewMatrix * vec4(p, 1.0);',
    '  vec3 tv = normalize((modelViewMatrix * vec4(tg, 0.0)).xyz);',
    '  vec3 cr = cross(tv, vec3(0.0, 0.0, 1.0)); float cl = length(cr);',
    '  mv.xyz += (cl > 1e-4 ? cr / cl : vec3(1.0, 0.0, 0.0)) * aSide;',
    '  float env = smoothstep(0.0, 0.08, t) * (1.0 - smoothstep(0.92, 1.0, t));',
    '  vCol = aCol * aPar.z * env; vFog = -mv.z;',
    '  float z = max(1.0, -mv.z);',
    '  gl_Position = projectionMatrix * mv;',
    /* screen direction of travel (sign = direction of motion) */
    '  vec4 q = projectionMatrix * (mv + vec4(tv * sign(aPar.y) * 4.0, 0.0));',
    '  vec2 d = q.xy / max(1e-4, q.w) - gl_Position.xy / max(1e-4, gl_Position.w);',
    '  vAng = atan(-d.y, d.x);',
    '  gl_PointSize = vCol.r + vCol.g + vCol.b < 0.002 ? 0.0 : clamp(aPar.w * 2.2 * uPx / z, 3.0, 22.0);',
    '}'].join('\n');
  var PT_FS = [
    'uniform sampler2D uTex; uniform float uFog; varying vec3 vCol; varying float vFog; varying float vAng;',
    'void main(){',
    /* a comet: bright head, tail behind it along the direction of travel */
    '  vec2 p = gl_PointCoord - 0.5; float ca = cos(vAng), sa = sin(vAng);',
    '  vec2 r = vec2(ca * p.x + sa * p.y, -sa * p.x + ca * p.y);',
    '  float body = exp(-pow(r.y * 9.0, 2.0)) * smoothstep(-0.46, 0.18, r.x) * (1.0 - smoothstep(0.18, 0.32, r.x));',
    '  float head = exp(-dot(r - vec2(0.22, 0.0), r - vec2(0.22, 0.0)) * 90.0);',
    '  float a = clamp(0.55 * body + head, 0.0, 1.2);',
    '  float f = 1.0 - exp(-uFog * uFog * vFog * vFog);',
    '  vec3 c = vCol * a * (1.0 - clamp(f, 0.0, 0.85)) * smoothstep(90.0, 300.0, vFog);',
    '  if (c.r + c.g + c.b < 0.003) discard;',
    '  gl_FragColor = vec4(c, 1.0);',
    '}'].join('\n');

  function dotTex() {
    var s = 64, cv = document.createElement('canvas'); cv.width = cv.height = s;
    var x = cv.getContext('2d'), g = x.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.35, 'rgba(255,255,255,.55)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.fillRect(0, 0, s, s);
    return new THREE.CanvasTexture(cv);
  }

  /* ---------------- build ---------------- */
  function ensure() {
    if (S.mesh) return;
    var fog = NS.scene.fog, fd = fog && fog.density !== undefined ? fog.density : 0.0006;
    var U = { uTime: { value: 0 }, uFog: { value: fd * 0.6 }, uPx: { value: 500 }, uCap: { value: 9 }, uTex: { value: dotTex() } };
    S.U = U;
    /* ribbon: an instanced strip */
    var base = new THREE.BufferGeometry(), P = [], I = [];
    for (var i = 0; i <= SEG; i++) { var t = i / SEG; P.push(t, -1, 0, t, 1, 0); }
    for (var j = 0; j < SEG; j++) { var a = j * 2; I.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    var g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setIndex(I);
    S.ia = {};
    [['aP0', 3], ['aP1', 3], ['aP2', 3], ['aLane', 4], ['aCol', 3], ['aAnim', 4]].forEach(function (d) {
      var at = new THREE.InstancedBufferAttribute(new Float32Array(MAXL * d[1]), d[1]).setUsage(THREE.DynamicDrawUsage);
      g.setAttribute(d[0], at); S.ia[d[0]] = at;
    });
    g.instanceCount = 0;
    S.mesh = new THREE.Mesh(g, new THREE.ShaderMaterial({ uniforms: U, vertexShader: RIB_VS, fragmentShader: RIB_FS,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    S.mesh.frustumCulled = false; S.mesh.renderOrder = 1; S.mesh.userData.traffic = true;
    NS.scene.add(S.mesh);
    /* particles */
    var pg = new THREE.BufferGeometry();
    S.pa = {};
    [['position', 3], ['aP0', 3], ['aP1', 3], ['aP2', 3], ['aPar', 4], ['aCol', 3], ['aSide', 1]].forEach(function (d) {
      var at = new THREE.BufferAttribute(new Float32Array(MAXP * d[1]), d[1]).setUsage(THREE.DynamicDrawUsage);
      pg.setAttribute(d[0], at); S.pa[d[0]] = at;
    });
    pg.setDrawRange(0, 0);
    pg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    S.pts = new THREE.Points(pg, new THREE.ShaderMaterial({ uniforms: U, vertexShader: PT_VS, fragmentShader: PT_FS,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    S.pts.frustumCulled = false; S.pts.renderOrder = 2; S.pts.userData.traffic = true;
    NS.scene.add(S.pts);
  }

  /* hub node of a system (the galaxy core), or the Internet node */
  function hubOf(sysId) {
    if (sysId === '__wan') return NS.byId && NS.byId.wan;
    var U = NS.U, sy = U && U.sysById ? U.sysById[sysId] : null;
    return sy && NS.byId ? NS.byId[sy.anchor] : null;
  }
  function coreHub() {
    var U = NS.U, sy = null;
    (U.systems || []).forEach(function (q) { if (!sy && q.kind === 'network') sy = q; });
    return sy ? NS.byId[sy.anchor] : null;
  }
  function sysR(sysId) {
    if (sysId === '__wan') return 30;
    var sy = NS.U && NS.U.sysById ? NS.U.sysById[sysId] : null;
    return sy && sy.R ? sy.R : 60;
  }

  /* data -> lane list (stable order: pairs by a/b, then wan by system) */
  function readTraffic() {
    var U = NS.U, d = U && U.data, tr = d && d.traffic;
    var lanes = [];
    if (!tr || !U.active) return lanes;
    var M2 = M || window.NB_MOTION;
    function lane(key, a, b, bps, dir, kind, pair, sub) {
      var u = M2 ? M2.actU(bps) : Math.min(1, Math.max(0, (Math.log(bps) / Math.LN10 - 3) / 5));
      lanes.push({ key: key, a: a, b: b, bps: bps, dir: dir, kind: KIND[kind] ? kind : 'mixed', u: Math.max(0, u), pair: pair, sub: sub || 0, lb: lowerBound(pair) });
    }
    (tr.pairs || []).forEach(function (p) {
      if (!p || !(+p.bps > 0) || !p.a || !p.b || p.a === p.b) return;
      if (!hubOf(p.a) || !hubOf(p.b)) return;            // a galaxy we cannot place: draw nothing
      var k = p.a + '~' + p.b, hasDir = p.a_to_b_bps != null && p.b_to_a_bps != null;
      if (hasDir) {
        if (+p.a_to_b_bps > 0) lane(k + '>', p.a, p.b, +p.a_to_b_bps, 1, p.kind, p, 1);
        if (+p.b_to_a_bps > 0) lane(k + '<', p.b, p.a, +p.b_to_a_bps, 1, p.kind, p, -1);
      } else lane(k + '=', p.a, p.b, +p.bps, 0, p.kind, p, 0);
    });
    (tr.wan || []).forEach(function (w) {
      if (!w || !w.system || !hubOf(w.system) || !hubOf('__wan')) return;
      var tot = w.bps != null ? +w.bps : (+w.in_bps || 0) + (+w.out_bps || 0);
      var k = w.system + '~wan', p = { a: w.system, b: '__wan', bps: tot, kind: 'wan', src: w.src, sampled: w.sampled || w.partial, wan: w };
      if (!(p.bps > 0)) return;
      if (w.out_bps != null && w.in_bps != null) {
        if (+w.out_bps > 0) lane(k + '>', w.system, '__wan', +w.out_bps, 1, 'wan', p, 1);
        if (+w.in_bps > 0) lane(k + '<', '__wan', w.system, +w.in_bps, 1, 'wan', p, -1);
      } else lane(k + '=', w.system, '__wan', p.bps, 0, 'wan', p, 0);
    });
    return lanes.slice(0, MAXL);
  }

  /* the arc for a lane: core edge to core edge, lifted over the plane and
     bowed sideways (lanes of one pair bow to opposite sides) */
  var _a = new THREE.Vector3(), _b = new THREE.Vector3(), _d = new THREE.Vector3();
  function arcFor(L, out0, out1, out2) {
    var A = hubOf(L.a), B = hubOf(L.b);
    if (!A || !B) return false;
    _a.set(A._cx, A._cy, A._cz); _b.set(B._cx, B._cy, B._cz);
    _d.subVectors(_b, _a);
    var len = Math.max(1, _d.length());
    /* start / end just inside each galaxy's core glow, not at the star */
    var ra = Math.min(sysR(L.a) * 0.22, len * 0.18), rb = Math.min(sysR(L.b) * 0.22, len * 0.18);
    out0.copy(_a).addScaledVector(_d, ra / len);
    out2.copy(_b).addScaledVector(_d, -rb / len);
    /* control point: midpoint, up by a gentle lift, sideways by the bow.
       The side is fixed per PAIR (sorted ids), so the two lanes of a pair bow
       apart symmetrically instead of crossing. */
    var hx = -_d.z / len, hz = _d.x / len;
    var pa = L.pair ? L.pair.a : L.a, sideSign = (L.a === pa ? 1 : -1);
    var bow = (L.sub ? 0.06 * len + 10 : 0) * sideSign * (L.sub || 1);
    var lift = Math.min(160, 30 + 0.12 * len);
    if (L.pair && L.pair.wan) {
      /* Internet traffic leaves through the gateway: a WAN lane bends through
         the core, so every galaxy's lane joins one bundle to the Internet
         instead of cutting across the map (and that is the physical path) */
      var C = NS.byId && NS.U && NS.U.sysById ? coreHub() : null;
      if (C) {
        var lane2 = (L.sub || 0) * 9 + ((LAY_HASH(L.pair.a) % 5) - 2) * 7;
        out1.set(C._cx + hx * lane2, C._cy + lift * 0.9, C._cz + hz * lane2);
        L.len = len;
        return true;
      }
    }
    out1.set((out0.x + out2.x) / 2 + hx * bow, Math.max(out0.y, out2.y) + lift, (out0.z + out2.z) / 2 + hz * bow);
    L.len = len;
    return true;
  }

  function rebuild() {
    ensure();
    var lanes = readTraffic();
    var prev = {}; S.lanes.forEach(function (L) { prev[L.key] = L; });
    /* keep fading-out lanes for a moment so nothing pops */
    var now = S.clock, out = [];
    lanes.forEach(function (L) {
      var o = prev[L.key];
      L.fade = o ? o.fade : 0; L.fadeT = 1;
      L.ph = o ? o.ph : ((LAY_HASH(L.key) % 1000) / 1000);
      L.spd0 = o ? o.spd : null;
      L.laps0 = o ? o.laps0 : null; L.rbF = o ? (o.rbF || 0) : 0; L.rbR = o ? (o.rbR || 0) : 0;
      if (o) { L.w = o.w; L.inten = o.inten; L.w0key = o.w0key; L.foc = o.foc; }
      out.push(L); delete prev[L.key];
    });
    Object.keys(prev).forEach(function (k) { var o = prev[k]; if (o.fade > 0.02) { o.fadeT = 0; out.push(o); } });
    S.lanes = out.slice(0, MAXL);
    /* rank for labels: the top measured pairs (both lanes of a pair share a label) */
    var pairs = {};
    S.lanes.forEach(function (L) { if (!L.fadeT) return; var pk = L.pair ? (L.pair.a + '~' + L.pair.b) : L.key; var e = pairs[pk] || (pairs[pk] = { key: pk, pair: L.pair, bps: 0, lanes: [] }); e.bps = L.pair ? +L.pair.bps : e.bps + L.bps; e.lanes.push(L); });
    S.pairList = Object.keys(pairs).map(function (k) { return pairs[k]; }).sort(function (a, b) { return b.bps - a.bps; });
    var top0 = S.pairList.length ? S.pairList[0].bps : 1;
    S.pairList.forEach(function (e, ri) {
      var rel = top0 > 0 && e.bps > 0 ? 1 + Math.log(e.bps / top0) / Math.LN10 / 2 : 0;   // 1 = as busy as the top, 0 = 1 %
      e.lanes.forEach(function (L) { L.prk = ri; L.prel = rel; });
    });
    /* the strongest system-to-system pair (not the Internet) for the tour */
    var best = null;
    S.pairList.forEach(function (e) { if (!best && e.pair && e.pair.b !== '__wan' && e.pair.a !== '__wan') best = e; });
    var sOld = S.strongest ? S.strongest.a + '~' + S.strongest.b + S.strongest.from : '';
    S.strongest = best ? strongestOf(best) : null;
    var sNew = S.strongest ? S.strongest.a + '~' + S.strongest.b + S.strongest.from : '';
    if (sNew !== sOld) S.tourDirty = true;
    writeStatic();
    buildLabels();
    S.built = true;
  }
  function strongestOf(e) {
    var p = e.pair, from = p.a, to = p.b;
    if (p.a_to_b_bps != null && p.b_to_a_bps != null && +p.b_to_a_bps > +p.a_to_b_bps) { from = p.b; to = p.a; }
    return { a: p.a, b: p.b, from: from, to: to, bps: +p.bps, kind: KIND[p.kind] ? p.kind : 'mixed', sampled: sampled(p), lb: lowerBound(p),
             dir: p.a_to_b_bps != null && p.b_to_a_bps != null, top: p.top || [] };
  }
  function LAY_HASH(s) { var L = window.UNIVERSE_LAYOUT; return L ? L.hash32(s) : 7; }

  var _c = new THREE.Color(), _p0 = new THREE.Vector3(), _p1 = new THREE.Vector3(), _p2 = new THREE.Vector3();
  function writeStatic() {
    var ia = S.ia, n = S.lanes.length, pc = 0, pa = S.pa;
    for (var i = 0; i < n; i++) {
      var L = S.lanes[i];
      _c.set(KIND[L.kind]);
      ia.aCol.setXYZ(i, _c.r, _c.g, _c.b);
      /* width (world units at the lane, camera-facing) and intensity, log + capped */
      var w = 1.6 + 6.5 * L.u, inten = 0.20 + 0.85 * L.u;
      if (!L.dir) inten *= 0.8;
      if (L.lb) { inten *= 0.7; w *= 0.8; }      // a lower bound: undirected and quieter (data rule)
      var laps = M ? M.flowLaps(L.u, Math.max(200, L.len || 600)) : Math.min(0.6, (50 + 240 * L.u) / 600);
      /* a new rate re-bases the particle phases so nothing jumps (motion
         grammar): phase + dir * laps * t stays continuous at this instant */
      if (L.laps0 != null && L.laps0 !== laps) {
        L.rbF = (L.rbF + (L.laps0 - laps) * S.clock) % 1;
        L.rbR = (L.rbR - (L.laps0 - laps) * S.clock) % 1;
      }
      L.laps0 = laps;
      /* re-base the pattern phase on a speed change so nothing jumps */
      var spd = 0.35 + 1.1 * L.u;
      if (L.spd0 != null && L.spd0 !== spd) L.ph = (L.ph + (L.spd0 - spd) * S.clock) % 1;
      L.spd = spd; L.laps = laps;
      /* width and intensity ease toward a new rate (~1 s) instead of stepping
         at every poll */
      L.wT = w; L.iT = inten;
      if (L.w === undefined || L.w0key !== L.key) { L.w = w; L.inten = inten; L.w0key = L.key; }
      ia.aLane.setXYZW(i, 0, L.w, L.inten, L.dir ? 1 : 0);
      /* particles: count by rate; a neutral lane runs half each way */
      var cnt = Math.max(2, Math.round(L.u * PER_LANE)), sidePx = 0, seed = (LAY_HASH(L.key) % 1000) / 1000;
      L.p0 = pc;
      for (var k = 0; k < cnt && pc < MAXP; k++, pc++) {
        /* golden-ratio spacing: independent of the count, so a rate change
           adds or drops particles without moving the others */
        var two = !L.dir && (k % 2), ph = ((k * 0.6180339887 + seed) % 1) + (two ? L.rbR : L.rbF);
        pa.aPar.setXYZW(pc, ph, (two ? -1 : 1) * laps, 0, 2.2 + 2.2 * L.u);
        pa.aCol.setXYZ(pc, _c.r, _c.g, _c.b);
        pa.aSide.setX(pc, ((k * 7919 % 13) / 13 - 0.5) * w * 0.9 + sidePx);
      }
      L.pn = pc - L.p0;
    }
    S.mesh.geometry.instanceCount = n;
    S.pts.geometry.setDrawRange(0, pc);
    ['aCol', 'aLane'].forEach(function (k) { ia[k].needsUpdate = true; });
    ['aPar', 'aCol', 'aSide'].forEach(function (k) { pa[k].needsUpdate = true; });
    S.pcount = pc;
    writeGeometry(true);
    writeAnim();
  }
  /* control points (instances + particles) - only while something moves */
  var _key = '';
  function writeGeometry(force) {
    var n = S.lanes.length, ia = S.ia, pa = S.pa, sig = '';
    for (var i = 0; i < n; i++) {
      var A = hubOf(S.lanes[i].a), B = hubOf(S.lanes[i].b);
      if (A && B) sig += (A._cx | 0) + ',' + (A._cz | 0) + ',' + (B._cx | 0) + ',' + (B._cz | 0) + ';';
    }
    if (!force && sig === _key) return;
    _key = sig;
    for (var j = 0; j < n; j++) {
      var L = S.lanes[j];
      if (!arcFor(L, _p0, _p1, _p2)) { L.ok = false; continue; }
      L.ok = true;
      L.c0 = (L.c0 || new THREE.Vector3()).copy(_p0); L.c1 = (L.c1 || new THREE.Vector3()).copy(_p1); L.c2 = (L.c2 || new THREE.Vector3()).copy(_p2);
      ia.aP0.setXYZ(j, _p0.x, _p0.y, _p0.z); ia.aP1.setXYZ(j, _p1.x, _p1.y, _p1.z); ia.aP2.setXYZ(j, _p2.x, _p2.y, _p2.z);
      for (var k = L.p0; k < L.p0 + L.pn; k++) {
        pa.aP0.setXYZ(k, _p0.x, _p0.y, _p0.z); pa.aP1.setXYZ(k, _p1.x, _p1.y, _p1.z); pa.aP2.setXYZ(k, _p2.x, _p2.y, _p2.z);
        pa.position.setXYZ(k, _p1.x, _p1.y, _p1.z);
      }
    }
    ['aP0', 'aP1', 'aP2'].forEach(function (k) { ia[k].needsUpdate = true; pa[k].needsUpdate = true; });
    pa.position.needsUpdate = true;
    placeLabels();
  }
  /* fade x focus per lane, written when they change */
  function writeAnim() {
    var ia = S.ia, pa = S.pa;
    for (var i = 0; i < S.lanes.length; i++) {
      var L = S.lanes[i], a = (L.fade || 0) * (L.foc === undefined ? 1 : L.foc) * (L.ok === false ? 0 : 1);
      ia.aAnim.setXYZW(i, a, 1, L.ph || 0, L.spd || 0.5);
      /* a lane faded to nothing collapses to zero width: no fragments at all */
      ia.aLane.setXYZW(i, 0, a > 0.06 ? (L.w || 0) : 0, L.inten || 0, L.dir ? 1 : 0);
      for (var k = L.p0; k < L.p0 + L.pn; k++) pa.aPar.setZ(k, a * (0.55 + 0.6 * L.u));
    }
    ia.aAnim.needsUpdate = true; ia.aLane.needsUpdate = true; pa.aPar.needsUpdate = true;
  }

  /* ---------------- labels: "4.6 Mb/s · storage" ---------------- */
  /* labels are kept per pair across data polls (a poll only updates the text):
     rebuilding them every 12 s made them fade back in from nothing each time */
  S.lblByKey = {};
  function buildLabels() {
    if (!NS.textLabel) return;
    var keep = {}, list = [];
    (S.pairList || []).slice(0, 8).forEach(function (e, i) {
      var p = e.pair, kind = p && KIND[p.kind] ? p.kind : 'mixed';
      var txt = (lowerBound(p) ? '\u2265 ' : p && sampled(p) ? '\u2248 ' : '') + fmtBps(e.bps) + ' \u00b7 ' + KIND_NAME[kind];
      var l = S.lblByKey[e.key];
      if (!l) {
        l = NS.textLabel(txt, 'stream', { dot: KIND[kind] });
        l.userData.tStream = e.key; l.userData.rank = 2; l.userData.op = 0;
        l.userData.dy = -13;                     // just above the stream, never on top of its glow
        S.lblByKey[e.key] = l;
      }
      l.userData.txt = txt; l.userData.dot = KIND[kind]; l.userData.rk = i; l.userData.score = e.bps; l.userData.e = e;
      keep[e.key] = 1; list.push(l);
    });
    Object.keys(S.lblByKey).forEach(function (k) { if (!keep[k]) delete S.lblByKey[k]; });
    /* netscene rebuilds NS.labels with the graph: make sure ours are in it, once */
    NS.labels = NS.labels.filter(function (l) { return !l.userData.tStream || keep[l.userData.tStream]; });
    list.forEach(function (l) { if (NS.labels.indexOf(l) < 0) NS.labels.push(l); });
    S.labels = list;
    placeLabels();
  }
  function placeLabels() {
    S.labels.forEach(function (l) {
      var e = l.userData.e, L = null;
      for (var i = 0; i < e.lanes.length; i++) if (e.lanes[i].ok) { L = e.lanes[i]; break; }
      if (!L) return;
      /* at the arc's apex, between the two lanes */
      var t = 0.5, u = 0.5;
      var x = u * u * L.c0.x + 2 * u * t * L.c1.x + t * t * L.c2.x, y = u * u * L.c0.y + 2 * u * t * L.c1.y + t * t * L.c2.y, z = u * u * L.c0.z + 2 * u * t * L.c1.z + t * t * L.c2.z;
      if (e.lanes.length > 1 && e.lanes[1].ok) {
        var M2 = e.lanes[1], x2 = u * u * M2.c0.x + 2 * u * t * M2.c1.x + t * t * M2.c2.x, z2 = u * u * M2.c0.z + 2 * u * t * M2.c1.z + t * t * M2.c2.z;
        x = (x + x2) / 2; z = (z + z2) / 2;
      }
      l.position.set(x, y + 10, z);
      /* alternative spots along the same arc for the collision pass (a short arc
         puts its apex on a galaxy caption): nearer each end, alternating */
      var alts = l.userData.alts || (l.userData.alts = [0, 1, 2, 3, 4, 5].map(function () { return new THREE.Vector3(); }));
      [0.5, 0.38, 0.62, 0.28, 0.72, 0.2].forEach(function (tt, ai) {
        var uu = 1 - tt;
        alts[ai].set(uu * uu * L.c0.x + 2 * uu * tt * L.c1.x + tt * tt * L.c2.x,
                     uu * uu * L.c0.y + 2 * uu * tt * L.c1.y + tt * tt * L.c2.y + 10,
                     uu * uu * L.c0.z + 2 * uu * tt * L.c1.z + tt * tt * L.c2.z);
      });
    });
  }

  /* ---------------- per frame ---------------- */
  function focusOfLane(L, oK, subj) {
    /* overview: every stream; close-up: the subject's streams quiet, the rest a
       trace; the stream stop: its own pair full, the rest a trace */
    /* overview (2026-10-09): the busiest LBL_TOP pairs carry the picture at full
       strength; the rest drop to a quiet trace, weaker the smaller they are next
       to the busiest, so a dozen small pairs never read as clutter */
    if (oK > 0.5 && !subj.stream) {
      if (L.prk === undefined || L.prk < LBL_TOP) return 1;
      return 0.12 + 0.18 * Math.min(1, Math.max(0, L.prel || 0));
    }
    var inS = subj.sys && (subj.sys[L.a] || subj.sys[L.b]);
    if (subj.stream) {
      var mine = L.pair && ((L.pair.a === subj.stream.a && L.pair.b === subj.stream.b));
      return mine ? 1 : 0.06;
    }
    /* a close-up belongs to its galaxy: its own streams stay as a quiet
       trace (the body-level conversations take over there), the rest fade */
    var base = inS ? 0.32 : 0.05;
    return base + (1 - base) * Math.max(0, oK * 2 - 1);
  }
  function subject() {
    var TR = NS.tour, o = { sys: null, stream: null };
    if (!TR || !TR.stops || !TR.stops.length) return o;
    var st = TR.stops[(TR.phase === 'travel' && TR.switched) ? TR.next : TR.idx];
    if (!st) return o;
    if (st.stream) { o.stream = st.stream; return o; }
    if (st.sysId) { o.sys = {}; o.sys[st.sysId] = 1; }
    var k = st.key || '';
    if (k === 'wan') { o.sys = { __wan: 1 }; }
    if (k.indexOf('host:') === 0 || k.indexOf('blk:') === 0) {
      var hid = k.indexOf('host:') === 0 ? k.slice(5) : k.split(':').slice(1, 3).join(':');
      var sy = NS.U && NS.U.sysOfAnchor ? NS.U.sysOfAnchor(hid) : null;
      if (sy) { o.sys = {}; o.sys[sy.id] = 1; }
    }
    return o;
  }
  function tick(t, dt) {
    if (!NS || !NS.U) return;
    var d = NS.U.data, tr = d && d.traffic, ts = tr ? (tr.ts || d.ts || 0) : -1;
    if (ts !== S.dataTs || (NS.graph && NS.graph !== S.graph)) {
      S.dataTs = ts; S.graph = NS.graph;
      if (tr || S.lanes.length) rebuild();
    }
    /* a new strongest pair re-plans the tour's stream stop, at a safe moment
       (never while that stop is on screen or being flown to) */
    if (S.tourDirty && NS.refreshTour && (t - (S.tourTry || 0)) > 1) { S.tourTry = t; if (NS.refreshTour()) S.tourDirty = false; }
    if (!S.mesh) return;
    dt = Math.min(0.05, Math.max(0, dt || 0));
    S.clock += dt;
    S.U.uTime.value = S.clock;
    var h = window.NB_RS ? NB_RS.ptH : NS.rndr.getContext().drawingBufferHeight;
    S.U.uPx.value = h / (2 * Math.tan(NS.cam.fov * Math.PI / 360));
    S.U.uCap.value = 9 * h / Math.max(1, innerHeight);     // 9 CSS px in buffer px
    writeGeometry(false);
    var oK = NS.overK === undefined ? 1 : NS.overK, subj = subject(), ch = false, keep = [];
    var aIn = 1 - Math.exp(-dt * 2.0), aOut = 1 - Math.exp(-dt * 1.2), af = 1 - Math.exp(-dt * 5.0);
    for (var i = 0; i < S.lanes.length; i++) {
      var L = S.lanes[i];
      var f0 = L.fade || 0, f1 = f0 + ((L.fadeT || 0) - f0) * (L.fadeT ? aIn : aOut); if (Math.abs(f1 - L.fadeT) < 0.003) f1 = L.fadeT;
      var g0 = L.foc === undefined ? 1 : L.foc, gt = focusOfLane(L, oK, subj), g1 = g0 + (gt - g0) * af; if (Math.abs(g1 - gt) < 0.003) g1 = gt;
      if (f1 !== f0 || g1 !== g0) ch = true;
      if (L.wT !== undefined && (L.w !== L.wT || L.inten !== L.iT)) {
        var ae = 1 - Math.exp(-dt * 3.0);
        L.w += (L.wT - L.w) * ae; L.inten += (L.iT - L.inten) * ae;
        if (Math.abs(L.w - L.wT) < 0.01) L.w = L.wT;
        if (Math.abs(L.inten - L.iT) < 0.002) L.inten = L.iT;
        ch = true;
      }
      L.fade = f1; L.foc = g1;
      if (L.fadeT || L.fade > 0.01) keep.push(L);
    }
    if (keep.length !== S.lanes.length) { S.lanes = keep; writeStatic(); }
    else if (ch) writeAnim();
    /* label opacity: the top LBL_TOP at the overview; at a close-up only the
       subject's strongest; the stream stop names its own stream */
    for (var j = 0; j < S.labels.length; j++) {
      var l = S.labels[j], e = l.userData.e, lf = 0;
      for (var q = 0; q < e.lanes.length; q++) lf = Math.max(lf, (e.lanes[q].fade || 0) * (e.lanes[q].foc === undefined ? 1 : e.lanes[q].foc));
      var want = 0;
      if (subj.stream) want = e.pair && e.pair.a === subj.stream.a && e.pair.b === subj.stream.b ? 1 : 0;
      else if (oK > 0.5) want = l.userData.rk < LBL_TOP ? 1 : 0;
      else if (subj.sys && e.pair && (subj.sys[e.pair.a] || subj.sys[e.pair.b])) want = firstOfSubject(e, subj) ? 1 : 0;
      var tgt = want * Math.min(1, lf * 1.4);
      var o0 = l.userData.op || 0, o1 = o0 + (tgt - o0) * af; if (Math.abs(o1 - tgt) < 0.01) o1 = tgt;
      l.userData.op = o1;
    }
  }
  function firstOfSubject(e, subj) {
    var L = S.pairList || [];
    for (var i = 0; i < L.length; i++) { var p = L[i].pair; if (p && (subj.sys[p.a] || subj.sys[p.b])) return L[i] === e; }
    return false;
  }

  /* ---------------- tour interface ---------------- */
  var API = {
    strongest: function () { return S.strongest; },
    /* the curve of a pair (from -> to), for the camera ride: [p0, p1, p2] */
    arc: function (from, to) {
      for (var i = 0; i < S.lanes.length; i++) {
        var L = S.lanes[i]; if (!L.ok || !L.c0) continue;
        if (L.a === from && L.b === to) return [L.c0, L.c1, L.c2];
      }
      for (var j = 0; j < S.lanes.length; j++) {
        var M2 = S.lanes[j]; if (!M2.ok || !M2.c0) continue;
        if (M2.a === to && M2.b === from) return [M2.c2, M2.c1, M2.c0];
      }
      return null;
    },
    fmt: fmtBps, kindName: function (k) { return KIND_NAME[k] || k; }, kindColor: function (k) { return KIND[k] || KIND.mixed; },
    active: function () { return S.lanes.length > 0; },
    kinds: KIND, debug: function () { return { lanes: S.lanes.map(function (L) { return [L.key, Math.round(L.bps), L.dir, +(L.fade || 0).toFixed(2), +(L.foc || 0).toFixed(2), L.ok]; }), particles: S.pcount, strongest: S.strongest }; }
  };

  function boot() {
    NS = window.NETSCENE; M = window.NB_MOTION;
    if (!NS || !NS.scene || !NS.textLabel) { setTimeout(boot, 300); return; }
    NS.T = API;
    NS.tTick = tick;
    window.NETTRAFFIC = API;
  }
  boot();
})();
