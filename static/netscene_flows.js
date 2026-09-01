/* ============================================================================
   netscene_flows.js — MEASURED host-to-host traffic arcs on top of netscene.js
   Data source: DATA["topology"].flows from topology.py's ntopng poller
   (real conversations sniffed on the PVE host's vmbr0 bridge — includes
   guest-to-guest traffic that never reaches the physical switch).

   VISUAL LANGUAGE (deliberately distinct from the physical `links`)
   ----------------------------------------------------------------------
   * Physical links: cylinders / low arcs / straight lines in the plane.
     Flow arcs: HIGH quadratic arcs well above the topology plane, drawn as
     camera-facing soft-edged RIBBONS (additive triangle strips) whose WIDTH
     scales with the measured rate, colour-coded — internal (LAN<->LAN)
     flows by L7 protocol, WAN-crossing flows a fixed amber. Non-chatter
     ribbons carry comet-shaped brightness PULSES travelling src -> dst at
     the same measured-rate speed as the particles (sharp leading edge,
     long tail — direction and rate read from the motion alone). Soft wide
     elements survive video compression where 1px hairlines strobe.
   * SALIENCE: flows under TAIL_BPS render very dim (they exist, they are
     real, but they must not drown the conversations that matter). Larger
     flows get brightness/particles on a log curve fitted to the actual
     spread of ntopng rates (~200 b/s .. ~15 Mb/s).
   * DIRECTION: particle comets (bright head, fading tail) run src -> dst
     (ntopng src = client); each arc also brightens toward its dst end, and
     every working (non-chatter) flow carries a chevron sprite at t=0.62,
     rotated to the arc's projected tangent every frame — direction reads
     at a glance from the wall, under any camera motion.
   * LABELS: the top conversations get an in-scene sprite label
     "client → server / PROTO · rate", tracked to the arc apex. Flows that
     share a source AND protocol family (librenms SNMP-polling 5 hosts,
     cloudflared's 4 tunnel legs) collapse into ONE label whose rate is the
     Σ of the group's measured rates — never an invented number. Discovery
     chatter (MDNS/SSDP/ICMP...) only gets a label if slots are left over.
     A per-frame screen-space pass declutters labels (vertical + lateral
     candidates along camera-right); a label that cannot find a clear spot
     INSIDE the HUD-safe region (SAFE fractions) is hidden, never drawn
     overlapping or out of frame — validated against the eased position
     too, so a flying camera cannot drag a label outside.
   * COLLISION: every arc's apex is splayed laterally by a deterministic
     per-flow hash (SPLAY) so apexes stop stacking into one central tangle;
     arcs sharing an endpoint pair get an extra even spread (DUP_SP), and
     arcs anchored at the WAN cloud fan out to deterministic per-remote-IP
     points around the cloud instead of converging on one.
   * Endpoints resolve to live node positions via NETSCENE.byId (tween-aware:
     arcs follow nodes while the layout animates). A flow endpoint that is
     not a known node (internet host) routes to the WAN cloud when the flow
     is external; internal flows with an unresolvable endpoint are skipped.
   * HONESTY: a flow with measured !== true is NEVER drawn, full stop.
     Every number shown is a measured bps or a sum of measured bps.

   INTEGRATION (see flows_integration.md)
   ----------------------------------------------------------------------
   Load this file AFTER netscene.js. It exposes:
       window.netFlowsUpdate(flows)   // feed topology.flows (any cadence)
       window.netFlowsTick(t, dt)     // call every frame after netSceneTick
   Zero-touch fallbacks are built in: it wraps window.netSceneUpdate /
   window.netSceneTick when possible and self-polls /api/topology every 5 s,
   so simply including the script is normally enough. Everything is guarded;
   a failure here can only make flows invisible, never break the base scene.
   ========================================================================== */
(function () {
  'use strict';

  /* ---------------- tunables ---------------- */
  var SEG = 20;            // bezier segments per arc (ribbon cross-sections - 1)
  var MAXF = 64;           // hard cap on drawn flows (payload is ~30-40)
  var P_CAP = 1024;        // flow-particle pool
  var MAXP_FLOW = 6;       // max comets for a maxed-out flow (xTRAIL particles)
  var TRAIL = 4;           // particles per comet: head + fading tail = direction
  var RIB_MIN  = 1.0;      // ribbon half-width (world units) at norm(bps)=0
  var RIB_MAX  = 5.5;      // ribbon half-width at norm(bps)=1 — rate reads as WIDTH
  var RIB_TAIL = 0.55;     // half-width for chatter flows (kept present, kept thin)
  var ARC_BASE = 46;       // minimum arc peak height above endpoints
  var ARC_MAX  = 132;      // ceiling: unclamped long arcs shot off the top of frame
  var ARC_RISE = 0.20;     // + this * distance
  var TAIL_BPS = 3000;     // below this a flow is "chatter": drawn dim, one slow mover
  var DUP_SP   = 16;       // world-units spread between arcs sharing an endpoint pair
  var SPLAY    = 34;       // per-flow lateral apex offset range (world units) so
                           // arcs stop peaking in one central tangle
  var CHEV_T   = 0.62;     // curve parameter where the direction chevron sits
  var CHEV_SZ  = 10.5;     // chevron sprite size (world units)
  /* HUD-safe region as viewport fractions (measured: x 388-1513, y 129-807 at
     1920x1080). Labels are the widest thing in the scene — a label candidate
     whose screen rect leaves this region is REJECTED, at every camera pose. */
  var SAFE = { x0: 388 / 1920, x1: 1513 / 1920, y0: 129 / 1080, y1: 807 / 1080, pad: 14 };
  var FAN_R    = 22;       // radius of the per-IP fan around the WAN cloud anchor
  var LBL_MAX      = 5;    // label sprite pool. NB: the selector backfills up
                           // to this from the leftovers, so the per-category
                           // caps below cannot reduce the total on their own.
  var LBL_MAX_INT  = 3;    // label slots reserved for LAN conversations
  var LBL_MAX_EXT  = 2;    // label slots reserved for WAN conversations
  var LBL_MIN_BPS  = 900;  // don't label flows slower than this
  var LBL_W = 148;         // label sprite world width
  var EXT_HEX = 0xffb347;  // WAN-crossing flows (amber)
  var UNK_HEX = 0x8fb0d0;  // internal flow, protocol unknown
  var PROTO_HEX = {        // internal flows, by L7 family (base name before '.')
    NFS: 0x37f5a0, SMB: 0x2fe08c, ISCSI: 0x37f5a0, RSYNC: 0x2fe08c, SYSLOG: 0x2fe08c,
    TLS: 0x5ad7ff, HTTPS: 0x5ad7ff, HTTP: 0x77dcff, QUIC: 0x77dcff, WEBSOCKET: 0x77dcff,
    SSH: 0x9b8cff, RDP: 0x9b8cff, VNC: 0x9b8cff, TELNET: 0x9b8cff,
    DNS: 0xffd166, NTP: 0xffd166, MDNS: 0xffd166, DHCP: 0xffd166, SNMP: 0xffd166,
    RTSP: 0xff4fa3, RTP: 0xff4fa3, SRTP: 0xff4fa3, RTMP: 0xff4fa3,
    POSTGRESQL: 0xff8fab, MYSQL: 0xff8fab, REDIS: 0xff8fab, RESP: 0xff8fab,
    MONGODB: 0xff8fab, MQTT: 0xff8fab
  };
  /* background chatter: real, shown, but never outranks a working protocol */
  var CHATTER = { MDNS: 1, SSDP: 1, ICMP: 1, IGMP: 1, LLMNR: 1, NETBIOS: 1,
                  DHCP: 1, DHCPV6: 1, BROADCAST: 1, ARP: 1 };
  /* protos that don't NAME a remote service — fall back to IP for the label */
  var GENERIC = { TLS: 1, HTTP: 1, HTTPS: 1, QUIC: 1, DNS: 1, ICMP: 1, SSH: 1,
                  NTP: 1, MDNS: 1, SSDP: 1, SNMP: 1, TCP: 1, UDP: 1, UNKNOWN: 1 };

  function ns() { return window.NETSCENE || null; }

  /* bits/s -> 0..1 salience. Fitted to the observed flow spread (~200 b/s
     chatter .. ~15 Mb/s NFS) so mid-size flows are visually separable —
     monotonic in the MEASURED rate, never invents motion. */
  function norm(bps) {
    var b = Math.max(0, +bps || 0);
    if (b < 100) return 0;
    return Math.min(1, Math.max(0, (Math.log(b) / Math.LN10 - 2.5) / 4.5));
  }
  function fmtBps(v) {
    var b = Math.max(0, +v || 0);
    if (b < 1e3) return b.toFixed(0) + ' b/s';
    if (b < 1e6) return (b / 1e3).toFixed(1) + ' kb/s';
    if (b < 1e9) return (b / 1e6).toFixed(1) + ' Mb/s';
    return (b / 1e9).toFixed(2) + ' Gb/s';
  }
  function fmtBytes(v) {
    var b = Math.max(0, +v || 0);
    if (b < 1e6) return (b / 1e3).toFixed(1) + ' kB';
    if (b < 1e9) return (b / 1e6).toFixed(1) + ' MB';
    return (b / 1e9).toFixed(2) + ' GB';
  }
  function protoFam(f) { return String(f.proto || '').split('.')[0]; }
  function protoKey(f) { return protoFam(f).toUpperCase(); }
  var _c = null; // lazy THREE.Color scratch
  function flowColor(f, out) {
    if (!f.internal) { out.setHex(EXT_HEX); return out; }
    var p = protoKey(f);
    if (!p) { out.setHex(UNK_HEX); return out; }
    if (PROTO_HEX[p]) { out.setHex(PROTO_HEX[p]); return out; }
    var h = 0;                                    // stable hash -> hue
    for (var i = 0; i < p.length; i++) h = (h * 31 + p.charCodeAt(i)) >>> 0;
    return out.setHSL((h % 360) / 360, 0.6, 0.62);
  }
  function hash32(s) {
    s = String(s || 'x');
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h;
  }

  /* ============================ boot ============================ */
  var FL = null;
  function boot() {
    if (!(window.THREE && window.scene && ns())) { setTimeout(boot, 400); return; }
    try { init(); } catch (e) { console.error('netflows: init failed', e); }
  }
  boot();

  function dotTex() {
    var s = 64, cv = document.createElement('canvas'); cv.width = cv.height = s;
    var x = cv.getContext('2d'), gr = x.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.4, 'rgba(255,255,255,.65)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = gr; x.fillRect(0, 0, s, s);
    return new window.THREE.CanvasTexture(cv);
  }
  /* soft cross-profile for the ribbon: bright core, feathered edges.
     Sampled across uv.x (vertex A = 0.02, vertex B = 0.98). */
  function ribTex() {
    var w = 128, cv = document.createElement('canvas'); cv.width = w; cv.height = 4;
    var x = cv.getContext('2d'), gr = x.createLinearGradient(0, 0, w, 0);
    gr.addColorStop(0.00, 'rgba(255,255,255,0)');
    gr.addColorStop(0.24, 'rgba(255,255,255,0.22)');
    gr.addColorStop(0.50, 'rgba(255,255,255,1)');
    gr.addColorStop(0.76, 'rgba(255,255,255,0.22)');
    gr.addColorStop(1.00, 'rgba(255,255,255,0)');
    x.fillStyle = gr; x.fillRect(0, 0, w, 4);
    var t = new window.THREE.CanvasTexture(cv);
    t.minFilter = window.THREE.LinearFilter;
    return t;
  }
  function chevTex() {                      // ">" arrowhead pointing +x
    var s = 64, cv = document.createElement('canvas'); cv.width = cv.height = s;
    var x = cv.getContext('2d');
    x.strokeStyle = 'rgba(255,255,255,1)';
    x.lineWidth = 11; x.lineCap = 'round'; x.lineJoin = 'round';
    x.beginPath(); x.moveTo(17, 13); x.lineTo(46, 32); x.lineTo(17, 51); x.stroke();
    return new window.THREE.CanvasTexture(cv);
  }

  function init() {
    var THREE = window.THREE;
    _c = new THREE.Color();
    FL = {
      grp: new THREE.Group(),
      flows: [], geom: [], sig: '',
      line: null, posArr: null, colArr: null,
      picks: [],
      pickGeo: new THREE.SphereGeometry(8, 8, 6),
      pickMat: new THREE.MeshBasicMaterial({ visible: false }),  // raycasts, never renders
      pGeo: null, pPts: null,
      pPos: new Float32Array(P_CAP * 3), pCol: new Float32Array(P_CAP * 3),
      pFlow: new Int16Array(P_CAP), pProg: new Float32Array(P_CAP), pActive: 0,
      ray: new THREE.Raycaster(), tipOurs: false, hoverFrame: 0,
      tip: document.getElementById('tip'),
      lblPool: [], labeledIdx: {}, lblFrame: 0,
      chev: [], chevTex: null, ribTex: null, taper: null
    };
    FL.chevTex = chevTex();
    FL.ribTex = ribTex();
    /* endpoint taper: ribbons narrow into their nodes instead of butting a
       full-width slab against a small sphere (precomputed, static) */
    FL.taper = new Float32Array(SEG + 1);
    for (var ti = 0; ti <= SEG; ti++)
      FL.taper[ti] = 0.30 + 0.70 * Math.pow(Math.sin(Math.PI * ti / SEG), 0.6);
    window.scene.add(FL.grp);

    FL.pGeo = new THREE.BufferGeometry();
    FL.pGeo.setAttribute('position', new THREE.BufferAttribute(FL.pPos, 3).setUsage(THREE.DynamicDrawUsage));
    FL.pGeo.setAttribute('color', new THREE.BufferAttribute(FL.pCol, 3).setUsage(THREE.DynamicDrawUsage));
    FL.pGeo.setDrawRange(0, 0);
    FL.pGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 6000);
    FL.pPts = new THREE.Points(FL.pGeo, new THREE.PointsMaterial({
      size: 8.5, map: dotTex(), vertexColors: true, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true
    }));
    FL.pPts.frustumCulled = false;
    FL.grp.add(FL.pPts);

    for (var i = 0; i < LBL_MAX; i++) FL.lblPool.push(makeFlowLabel());

    window.netFlowsUpdate = netFlowsUpdate;
    window.netFlowsTick = netFlowsTick;
    window.NETFLOWS = FL;

    wrapNetscene();

    /* self-poll fallback: netscene's internal poll calls its own closure, not
       window.netSceneUpdate, so fetch flows ourselves; harmless if the app
       already pushes them through netFlowsUpdate. */
    setInterval(function () {
      try {
        fetch('/api/topology').then(function (r) { return r.ok ? r.json() : null; })
          .then(function (j) { if (j && j.flows) netFlowsUpdate(j.flows); })
          .catch(function () { });
      } catch (e) { }
    }, 5000);
  }

  /* chain onto netscene's public API so no host-page edits are strictly
     required; the host can also call netFlowsUpdate/netFlowsTick directly. */
  function wrapNetscene() {
    var tries = 0;
    (function w() {
      try {
        if (typeof window.netSceneUpdate === 'function' && !window.netSceneUpdate.__flows) {
          var u = window.netSceneUpdate;
          var wu = function (topo) {
            u(topo);
            try { if (topo && topo.flows) netFlowsUpdate(topo.flows); } catch (e) { }
          };
          wu.__flows = true; window.netSceneUpdate = wu;
        }
        if (typeof window.netSceneTick === 'function' && !window.netSceneTick.__flows) {
          var k = window.netSceneTick;
          var wk = function (t, dt) {
            k(t, dt);
            try { netFlowsTick(t, dt); } catch (e) { }
          };
          wk.__flows = true; window.netSceneTick = wk;
        }
      } catch (e) { }
      var done = window.netSceneUpdate && window.netSceneUpdate.__flows &&
                 window.netSceneTick && window.netSceneTick.__flows;
      if (!done && tries++ < 60) setTimeout(w, 500);
    })();
  }

  /* ============================ data in ============================ */
  function netFlowsUpdate(flows) {
    if (!FL) return;
    try {
      var list = [];
      (Array.isArray(flows) ? flows : []).forEach(function (f) {
        if (!f || f.measured !== true) return;       // NEVER draw unmeasured flows
        if (!f.src_ip || !f.dst_ip) return;
        if (list.length < MAXF) list.push(f);
      });
      FL.flows = list;
      var sig = list.map(function (f) { return (f.src || f.src_ip) + '>' + (f.dst || f.dst_ip); }).join('|');
      if (sig !== FL.sig) { FL.sig = sig; rebuild(); }
      else refresh();
    } catch (e) { console.error('netflows: update failed', e); }
  }

  function rebuild() {
    var THREE = window.THREE;
    if (FL.line) {
      FL.grp.remove(FL.line);
      FL.line.geometry.dispose(); FL.line.material.dispose();
      FL.line = null;
    }
    FL.picks.forEach(function (m) { FL.grp.remove(m); });   // shared geo/mat: no dispose
    FL.picks = []; FL.geom = [];
    var n = FL.flows.length;
    if (!n) { FL.posArr = FL.colArr = null; buildLabels(); reseed(); return; }

    /* camera-facing ribbon strip: (SEG+1) cross-sections x 2 verts per flow.
       Positions/colours rewritten per frame; uv + index are static. */
    var vps = SEG + 1;
    FL.posArr = new Float32Array(n * vps * 2 * 3);
    FL.colArr = new Float32Array(n * vps * 2 * 3);
    var uv = new Float32Array(n * vps * 2 * 2);
    for (var vi = 0; vi < n * vps; vi++) {
      uv[vi * 4]     = 0.02; uv[vi * 4 + 1] = 0.5;   // side A -> soft edge
      uv[vi * 4 + 2] = 0.98; uv[vi * 4 + 3] = 0.5;   // side B -> soft edge
    }
    var idx = new Uint32Array(n * SEG * 6);
    var w2 = 0;
    for (var fi = 0; fi < n; fi++) {
      for (var sj = 0; sj < SEG; sj++) {
        var a = (fi * vps + sj) * 2;
        idx[w2++] = a;     idx[w2++] = a + 1; idx[w2++] = a + 2;
        idx[w2++] = a + 1; idx[w2++] = a + 3; idx[w2++] = a + 2;
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(FL.posArr, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(FL.colArr, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 6000);
    FL.line = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      map: FL.ribTex, vertexColors: true, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
    }));
    FL.line.frustumCulled = false;
    FL.grp.add(FL.line);

    /* arcs sharing an (unordered) endpoint pair get spread indices so they
       curve apart instead of overdrawing into one bright smear */
    var pairs = {};
    for (var i = 0; i < n; i++) {
      var f = FL.flows[i];
      var ka = f.src || (f.internal ? '?' + f.src_ip : 'wan');
      var kb = f.dst || (f.internal ? '?' + f.dst_ip : 'wan');
      var pk = ka < kb ? ka + '~' + kb : kb + '~' + ka;
      if (!pairs[pk]) pairs[pk] = [];
      pairs[pk].push(i);
    }
    for (i = 0; i < n; i++) {
      var f2 = FL.flows[i];
      FL.geom.push({ ok: false, ax: 0, ay: 0, az: 0, bx: 0, by: 0, bz: 0,
                     mx: 0, my: 0, mz: 0, len: 1, u: 0, dupIdx: 0, dupN: 1,
                     h: hash32((f2.src || f2.src_ip) + '>' + (f2.dst || f2.dst_ip) + '|' + (f2.proto || '')) });
      var m = new THREE.Mesh(FL.pickGeo, FL.pickMat);
      m.userData.flowIdx = i;
      FL.grp.add(m); FL.picks.push(m);
    }
    Object.keys(pairs).forEach(function (pk) {
      var idxs = pairs[pk];
      for (var j = 0; j < idxs.length; j++) {
        FL.geom[idxs[j]].dupIdx = j;
        FL.geom[idxs[j]].dupN = idxs.length;
      }
    });
    /* one direction chevron per flow (shared texture, own material: rotation
       and tint are per-sprite). Pool only grows; visibility is per-frame. */
    while (FL.chev.length < n) {
      var cs = new THREE.Sprite(new THREE.SpriteMaterial({
        map: FL.chevTex, transparent: true, depthWrite: false, depthTest: false,
        blending: THREE.AdditiveBlending
      }));
      cs.scale.set(CHEV_SZ, CHEV_SZ, 1);
      cs.visible = false; cs.userData.on = false;
      FL.grp.add(cs); FL.chev.push(cs);
    }
    for (i = 0; i < FL.chev.length; i++) { FL.chev[i].visible = false; FL.chev[i].userData.on = false; }
    refresh();
  }

  /* colours + labels + particle seeding (every data refresh). The ribbon's
     vertex colours themselves are animated per frame in tickColors(); here we
     only derive and store each flow's static parameters from its MEASURED
     rate: base colour, salience, width, pulse cadence. */
  function refresh() {
    buildLabels();                               // sets FL.labeledIdx first
    for (var i = 0; i < FL.flows.length; i++) {
      var f = FL.flows[i], L = FL.geom[i];
      if (!L) continue;
      var u = norm(f.bps);
      var tail = (+f.bps || 0) < TAIL_BPS;
      /* salience: chatter recedes, working flows dominate, labelled flows
         stay traceable even when individually slow */
      var mul = tail ? 0.10 + 0.15 * u : 0.30 + 0.70 * u;
      if (FL.labeledIdx[i] && mul < 0.32) mul = 0.32;
      flowColor(f, _c);
      L.u = u; L.mul = mul;
      L.cr = _c.r; L.cg = _c.g; L.cb = _c.b;
      L.pulse = !tail;                           // chatter ribbons stay static
      L.w = tail ? RIB_TAIL : RIB_MIN + (RIB_MAX - RIB_MIN) * u;
      /* pulses along the arc: count deterministic per flow (stable across
         refreshes), phase persists so a data poll never visibly "jumps" */
      L.cyc = 2 + ((L.h >> 7) % 2) + Math.round(2 * u);
      if (L.ph === undefined) L.ph = ((L.h >> 11) % 100) / 100;
    }
    /* chevrons: only working (non-chatter) flows get one — direction of real
       traffic at a glance; chatter keeps its single slow mover instead */
    for (var ci2 = 0; ci2 < FL.chev.length; ci2++) {
      var cs = FL.chev[ci2], cf = FL.flows[ci2];
      if (!cf || (+cf.bps || 0) < TAIL_BPS) { cs.userData.on = false; cs.visible = false; continue; }
      var cu = norm(cf.bps);
      cs.userData.on = true;
      cs.material.color.copy(flowColor(cf, _c));
      cs.material.opacity = 0.45 + 0.5 * cu;
    }
    reseed();
    updateGeometry();
  }

  function reseed() {
    var slot = 0;
    var decay = [1, 0.5, 0.24, 0.1];             // comet: head bright, tail fades
    for (var i = 0; i < FL.flows.length && slot < P_CAP; i++) {
      var f = FL.flows[i], L = FL.geom[i];
      if (!L) continue;
      var u = norm(f.bps);
      L.u = u; L.pStart = slot; L.pCount = 0;
      // any measured flow gets at least one mover: it is real traffic, and a
      // still line would read as "nothing happening" when something is.
      var tail = (+f.bps || 0) < TAIL_BPS;
      var cnt = tail ? 1 : Math.max(1, Math.round(u * MAXP_FLOW));
      /* comet length stretches with the measured rate: a fast flow trails a
         long streak, a slow one a compact dot — rate reads from the shape */
      var sp = tail ? 0.012 : 0.014 + 0.034 * u;
      flowColor(f, _c).multiplyScalar(tail ? 0.28 : 0.55 + 0.45 * u);
      for (var k = 0; k < cnt && slot + TRAIL <= P_CAP; k++) {
        var base = (k / cnt + 0.618033 * i) % 1;
        for (var j = 0; j < TRAIL; j++, slot++) {
          FL.pFlow[slot] = i;
          FL.pProg[slot] = ((base - j * sp) % 1 + 1) % 1;
          FL.pCol[slot * 3]     = _c.r * decay[j];
          FL.pCol[slot * 3 + 1] = _c.g * decay[j];
          FL.pCol[slot * 3 + 2] = _c.b * decay[j];
        }
      }
      L.pCount = slot - L.pStart;
    }
    FL.pActive = slot;
    FL.pGeo.setDrawRange(0, slot);
    FL.pGeo.attributes.color.needsUpdate = true;
  }

  /* ============================ labels ============================ */
  function shortName(s, n) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }
  /* best displayable name for an external remote: a real hostname beats an
     IP; an ntopng-identified service (TLS.Telegram, Cloudflare) beats both */
  function extDstName(f) {
    var parts = String(f.proto || '').split('.');
    if (parts.length > 1 && parts[1]) return parts[1];
    if (!GENERIC[protoKey(f)] && parts[0]) return parts[0];
    var dl = String(f.dst_label || '');
    if (dl && !/^\d+\.\d+\.\d+\.\d+$/.test(dl)) return dl;
    return f.dst_ip || '?';
  }
  /* which endpoint of a WAN-crossing flow is the external one? ntopng maps
     internal endpoints to node ids; the side WITHOUT an id is the remote. */
  function wanSide(f) {
    if (f.internal) return null;
    if (!f.src && f.dst) return 'src';        // inbound: remote is the client
    return 'dst';
  }
  /* inbound remote: the IP/hostname identifies the peer (service name only
     as a last resort) — never print the protocol where a host should be */
  function extSrcName(f) {
    var sl = String(f.src_label || '');
    if (sl) return sl;
    var parts = String(f.proto || '').split('.');
    if (parts.length > 1 && parts[1]) return parts[1];
    return f.src_ip || '?';
  }

  function makeFlowLabel() {
    var THREE = window.THREE;
    var W = 704, H = 120;
    var cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    var x = cv.getContext('2d');
    var t = new THREE.CanvasTexture(cv); t.minFilter = THREE.LinearFilter;
    var sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: t, transparent: true, depthWrite: false, depthTest: false
    }));
    sp.scale.set(LBL_W, LBL_W * H / W, 1);
    sp.visible = false;
    sp.userData.entry = null;
    sp.userData.lift = 0; sp.userData.liftT = 0;
    sp.userData.liftX = 0; sp.userData.liftXT = 0;
    var last = '';
    sp.userData.setText = function (l1, l2, colHex) {
      var key = l1 + '|' + l2 + '|' + colHex;
      if (key === last) return; last = key;
      x.clearRect(0, 0, W, H);
      x.textAlign = 'center'; x.textBaseline = 'middle';
      x.font = '700 34px ui-monospace,Consolas,monospace';
      var w1 = x.measureText(l1).width;
      x.font = '600 27px ui-monospace,Consolas,monospace';
      var w2 = x.measureText(l2).width;
      var pw = Math.min(W - 4, Math.max(w1, w2) + 40), px0 = (W - pw) / 2;
      sp.userData.plateFrac = pw / W;              // true plate width for declutter rects
      var col = '#' + ('00000' + (colHex >>> 0).toString(16)).slice(-6);
      x.beginPath();
      var r = 14, py0 = 6, ph = H - 12;
      x.moveTo(px0 + r, py0);
      x.arcTo(px0 + pw, py0, px0 + pw, py0 + ph, r);
      x.arcTo(px0 + pw, py0 + ph, px0, py0 + ph, r);
      x.arcTo(px0, py0 + ph, px0, py0, r);
      x.arcTo(px0, py0, px0 + pw, py0, r);
      x.closePath();
      x.fillStyle = 'rgba(4,10,18,0.74)'; x.fill();
      x.globalAlpha = 0.55; x.strokeStyle = col; x.lineWidth = 2.5; x.stroke();
      x.globalAlpha = 1;
      x.font = '700 34px ui-monospace,Consolas,monospace';
      x.fillStyle = '#eaf6ff'; x.fillText(l1, W / 2, 38);
      x.font = '600 27px ui-monospace,Consolas,monospace';
      x.fillStyle = col; x.fillText(l2, W / 2, 82);
      t.needsUpdate = true;
    };
    FL ? FL.grp.add(sp) : null;
    return sp;
  }

  /* pick which conversations deserve a permanent on-scene label.
     Grouped by (src endpoint, protocol family, internal?) so one poller
     fanning out to N hosts is ONE label with the Σ of measured rates. */
  function buildLabels() {
    var groups = {};
    FL.flows.forEach(function (f, i) {
      var fam = protoKey(f) || 'UNKNOWN';
      /* internal flows group by protocol family (one poller -> N hosts);
         external flows group by the identified remote service, so
         one host's Telegram legs never blur into "3 peers" with other TLS.
         Inbound WAN flows anchor on their INTERNAL (dst) endpoint. */
      var ws = wanSide(f);
      var anchor = ws === 'src' ? (f.dst || f.dst_ip) : (f.src || f.src_ip);
      var extN = ws === 'src' ? extSrcName(f) : extDstName(f);
      var key = anchor + '|' +
                (f.internal ? fam : 'x:' + extN) + '|' + (f.internal ? 1 : 0);
      var g = groups[key];
      if (!g) g = groups[key] = { bps: 0, members: [], internal: !!f.internal,
                                  ws: ws, chatter: !!CHATTER[fam], best: -1, bestBps: -1 };
      g.bps += Math.max(0, +f.bps || 0);
      g.members.push(i);
      if ((+f.bps || 0) > g.bestBps) { g.bestBps = +f.bps || 0; g.best = i; }
    });
    var all = Object.keys(groups).map(function (k) { return groups[k]; })
      .filter(function (g) { return g.bps >= LBL_MIN_BPS && g.best >= 0; });
    var byPrio = function (a, b) {
      if (a.chatter !== b.chatter) return a.chatter ? 1 : -1;
      return b.bps - a.bps;
    };
    var internal = all.filter(function (g) { return g.internal; }).sort(byPrio);
    var external = all.filter(function (g) { return !g.internal; }).sort(byPrio);
    var chosen = internal.slice(0, LBL_MAX_INT).concat(external.slice(0, LBL_MAX_EXT));
    var rest = internal.slice(LBL_MAX_INT).concat(external.slice(LBL_MAX_EXT)).sort(byPrio);
    while (chosen.length < LBL_MAX && rest.length) chosen.push(rest.shift());
    chosen.sort(function (a, b) { return b.bps - a.bps; });   // prio for declutter

    FL.labeledIdx = {};
    for (var i = 0; i < FL.lblPool.length; i++) {
      var sp = FL.lblPool[i], g = chosen[i];
      if (!g) { sp.userData.entry = null; sp.visible = false; continue; }
      var f = FL.flows[g.best];
      var nMem = g.members.length;
      var srcName = shortName(f.src_label || f.src_ip, 15);
      var dstName;
      if (g.internal) dstName = nMem > 1 ? nMem + ' hosts' : shortName(f.dst_label || f.dst_ip, 15);
      else if (g.ws === 'src') {
        /* inbound: the remote peer is the CLIENT — name it on the left and
           keep the real internal destination on the right */
        var inNames = {};
        g.members.forEach(function (mi) { inNames[extSrcName(FL.flows[mi])] = 1; });
        var inUniq = Object.keys(inNames);
        srcName = inUniq.length === 1
          ? shortName(inUniq[0], 15) + (nMem > 1 ? ' ×' + nMem : '')
          : nMem + ' peers';
        dstName = shortName(f.dst_label || f.dst_ip, 15);
      } else {
        var names = {};
        g.members.forEach(function (mi) { names[extDstName(FL.flows[mi])] = 1; });
        var uniq = Object.keys(names);
        dstName = uniq.length === 1
          ? shortName(uniq[0], 15) + (nMem > 1 ? ' ×' + nMem : '')
          : nMem + ' peers';
      }
      var fam = protoFam(f) || 'unknown';
      var l2 = fam + ' · ' + (nMem > 1 ? 'Σ ' : '') + fmtBps(g.bps)
             + (g.internal ? '' : ' · WAN');
      sp.userData.entry = { flowIdx: g.best, bps: g.bps };
      sp.userData.setText(srcName + ' → ' + dstName, l2, flowColor(f, _c).getHex());
      g.members.forEach(function (mi) { FL.labeledIdx[mi] = true; });
    }
  }

  /* place labels near their arc apex, decluttered EVERY frame (the camera may
     be flying, so screen rects are recomputed fresh — nothing screen-space is
     cached across frames). Candidates include vertical nudges AND lateral
     slides along the camera-right axis, since arcs peak in a shared band and
     vertical-only nudging cannot separate them. A candidate whose rect leaves
     the HUD-safe region is rejected outright; if no candidate is clear the
     label is HIDDEN rather than drawn overlapping (higher-rate label wins). */
  function tickLabels() {
    var NS = ns();
    if (!NS || !NS.cam) return;
    var THREE = window.THREE;
    var cam = NS.cam, placed = [];
    var vW = window.innerWidth || 1920, vH = window.innerHeight || 1080;
    if (!_r) _r = new THREE.Vector3();
    _r.set(1, 0, 0).applyQuaternion(cam.quaternion);   // camera-right, world space
    var sx0 = vW * SAFE.x0 + SAFE.pad, sx1 = vW * SAFE.x1 - SAFE.pad;
    var sy0 = vH * SAFE.y0 + SAFE.pad, sy1 = vH * SAFE.y1 - SAFE.pad;
    /* netscene's own text is an obstacle set: never sit on a node name, a
       hot-guest callout or a trunk rate label (fields guarded + world
       positions used — the base scene is being reworked under us) */
    try {
      var obst = (NS.labels || []).concat(NS.hotLabels || [], NS.rateLabels || []);
      if (!_wv) _wv = new THREE.Vector3();
      for (var oi = 0; oi < obst.length; oi++) {
        var os = obst[oi];
        if (!os || !os.visible || !os.getWorldPosition) continue;
        if (os.material && os.material.opacity !== undefined && os.material.opacity < 0.15) continue;
        os.getWorldPosition(_wv);
        var r0 = screenRect(os, _wv.x, _wv.y, _wv.z, cam);
        if (r0) placed.push(r0);
      }
    } catch (e) { }
    for (var i = 0; i < FL.lblPool.length; i++) {
      var sp = FL.lblPool[i], e = sp.userData.entry;
      if (!e) { sp.visible = false; continue; }
      var L = FL.geom[e.flowIdx];
      if (!L || !L.ok) { sp.visible = false; continue; }
      var ax = 0.25 * L.ax + 0.5 * L.mx + 0.25 * L.bx;
      var ay = 0.25 * L.ay + 0.5 * L.my + 0.25 * L.by;
      var az = 0.25 * L.az + 0.5 * L.mz + 0.25 * L.bz;
      /* [lateral (along camera right), vertical] — current target first for
         hysteresis, so a settled label doesn't wander between clear spots */
      var cand = [[sp.userData.liftXT, sp.userData.liftT],
                  [0, 16], [0, 48], [0, -40], [64, 28], [-64, 28], [0, 80],
                  [110, 44], [-110, 44], [64, 84], [-64, 84], [0, -76], [0, 112]];
      var pick = null, pickRect = null, best = Infinity;
      for (var ci = 0; ci < cand.length; ci++) {
        var lx = cand[ci][0], ly = cand[ci][1];
        var rect = screenRect(sp, ax + _r.x * lx, ay + _r.y * lx + ly, az + _r.z * lx, cam);
        if (!rect) continue;
        if (rect.x0 < sx0 || rect.x1 > sx1 || rect.y0 < sy0 || rect.y1 > sy1) continue;  // HUD-safe
        var ov = 0;
        for (var pi = 0; pi < placed.length; pi++) ov += overlapArea(rect, placed[pi]);
        if (ov < best) { best = ov; pick = cand[ci]; pickRect = rect; }
        if (ov === 0) break;                       // clear spot: take it
      }
      var ownArea = pickRect ? Math.max(1, (pickRect.x1 - pickRect.x0) * (pickRect.y1 - pickRect.y0)) : 1;
      // strict: drop rather than show overlapping / out-of-frame text
      if (pick === null || best > ownArea * 0.02) { sp.visible = false; continue; }
      sp.userData.liftXT = pick[0]; sp.userData.liftT = pick[1];
      placed.push(pickRect);
      sp.userData.lift += (sp.userData.liftT - sp.userData.lift) * 0.3;
      sp.userData.liftX += (sp.userData.liftXT - sp.userData.liftX) * 0.3;
      var gx = sp.userData.liftX, gy = sp.userData.lift;
      var ex = ax + _r.x * gx, ey = ay + _r.y * gx + gy, ez = az + _r.z * gx;
      /* re-validate the EASED position under the CURRENT camera: with a
         flying camera, easing lag can drag a label out of the safe region
         even though its target is legal — snap to the validated target. */
      var er = screenRect(sp, ex, ey, ez, cam);
      if (!er || er.x0 < sx0 || er.x1 > sx1 || er.y0 < sy0 || er.y1 > sy1) {
        sp.userData.liftX = gx = pick[0]; sp.userData.lift = gy = pick[1];
        ex = ax + _r.x * gx; ey = ay + _r.y * gx + gy; ez = az + _r.z * gx;
      }
      sp.position.set(ex, ey, ez);
      sp.visible = true;
    }
  }
  var _v = null, _wv = null, _r = null;
  /* EXACT screen rect: project the sprite's edge points through the live
     camera (viewOffset included) — the pinhole fovScale/dist approximation
     under-read at close range once the camera started flying. */
  function screenRect(sp, x, y, z, cam) {
    var THREE = window.THREE;
    if (!_v) _v = new THREE.Vector3();
    _v.set(x, y, z).project(cam);
    if (_v.z > 1) return null;
    var W = window.innerWidth || 1920, H = window.innerHeight || 1080;
    var sx = (_v.x * 0.5 + 0.5) * W, sy = (-_v.y * 0.5 + 0.5) * H;
    var frac = sp.userData && sp.userData.plateFrac ? sp.userData.plateFrac : 1;
    _v.set(x + sp.scale.x * 0.5 * frac, y, z).project(cam);
    var hw = Math.abs((_v.x * 0.5 + 0.5) * W - sx);
    _v.set(x, y + sp.scale.y * 0.5, z).project(cam);
    var hh = Math.abs((-_v.y * 0.5 + 0.5) * H - sy);
    return { x0: sx - hw, x1: sx + hw, y0: sy - hh, y1: sy + hh };
  }
  function overlapArea(a, b) {
    var pad = 4;
    var w = Math.min(a.x1, b.x1 + pad) - Math.max(a.x0, b.x0 - pad);
    var h = Math.min(a.y1, b.y1 + pad) - Math.max(a.y0, b.y0 - pad);
    return (w > 0 && h > 0) ? w * h : 0;
  }

  /* ============================ geometry ============================ */
  /* endpoint -> {node, wan:bool}. Unmapped endpoint: external flows anchor
     at the WAN cloud; internal flows with an unknown endpoint are skipped. */
  function resolveEnd(f, side) {
    var NS = ns();
    if (!NS || !NS.byId) return null;
    var id = side ? f.dst : f.src;
    var n = id ? NS.byId[id] : null;
    if (n) return { n: n, wan: false };
    if (!f.internal && NS.byId.wan) return { n: NS.byId.wan, wan: true };
    return null;
  }
  function px(n) { return n._cx !== undefined ? n._cx : (n._x || 0); }
  function py(n) { return (n._cy !== undefined ? n._cy : (n._y || 0)) + (n._h || 5) + 3; }
  function pz(n) { return n._cz !== undefined ? n._cz : (n._z || 0); }

  function updateGeometry() {
    if (!FL.posArr) return;
    var NSc = ns(), cam = NSc && NSc.cam;
    var cx = 0, cy = 1e6, cz = 0;                // side-vector fallback: top-down
    if (cam && cam.position) { cx = cam.position.x; cy = cam.position.y; cz = cam.position.z; }
    var vps = SEG + 1;
    for (var i = 0; i < FL.flows.length; i++) {
      var f = FL.flows[i], L = FL.geom[i];
      var ra = resolveEnd(f, 0), rb = resolveEnd(f, 1);
      var o = i * vps * 2 * 3, k;
      /* Follow the tour's focus. During a close-up a conversation whose
         endpoints are not part of the subject is not merely irrelevant - its
         arc and label come to rest under the HUD panels, which reads as a
         rendering bug rather than a camera move. NETSCENE.nodeFocus(id) is a
         0..1 weight and focusAll is true at overview, where everything draws
         exactly as before. Reuses the existing collapse path, so line,
         particles, chevron, pick target and label all fall silent together. */
      var NSf = ns(), foc = 1;
      if (ra && rb && NSf && NSf.focusAll === false && typeof NSf.nodeFocus === 'function') {
        foc = Math.min(NSf.nodeFocus(ra.n.id), NSf.nodeFocus(rb.n.id));
      }
      L.foc = foc;
      if (!ra || !rb || ra.n === rb.n || foc < 0.35) {
        if (L.ok || L.init === undefined) {          // collapse: draws nothing
          L.ok = false; L.init = 1;
          for (k = 0; k < vps * 2 * 3; k++) FL.posArr[o + k] = 0;
          if (FL.picks[i]) FL.picks[i].position.set(0, -1e5, 0);
        }
        continue;
      }
      var a = ra.n, b = rb.n;
      L.ok = true;
      L.ax = px(a); L.ay = py(a); L.az = pz(a);
      L.bx = px(b); L.by = py(b); L.bz = pz(b);
      /* external arcs fan into deterministic per-remote-IP points around the
         WAN cloud instead of all converging on its centre */
      if (ra.wan || rb.wan) {
        var hip = hash32(ra.wan ? f.src_ip : f.dst_ip);
        var ang = (hip % 628) / 100, fx = Math.cos(ang) * FAN_R, fz = Math.sin(ang) * FAN_R;
        var fy = ((hip >> 4) % 11) - 5;
        if (ra.wan) { L.ax += fx; L.az += fz; L.ay += fy; }
        else { L.bx += fx; L.bz += fz; L.by += fy; }
      }
      var dx = L.bx - L.ax, dy = L.by - L.ay, dz = L.bz - L.az;
      L.len = Math.max(1, Math.sqrt(dx * dx + dy * dy + dz * dz));
      var hsh = L.h || 0;
      var peak = Math.min(ARC_MAX, ARC_BASE + L.len * ARC_RISE) + (hsh % 5) * 9;  // staggered, capped
      L.mx = (L.ax + L.bx) / 2; L.mz = (L.az + L.bz) / 2;
      L.my = Math.max(L.ay, L.by) + peak;
      /* lateral splay: every arc's apex slides perpendicular to its chord by a
         deterministic per-flow amount, so apexes stop stacking into one central
         tangle; arcs sharing an endpoint pair get an extra even spread on the
         same axis so they read as separate conversations */
      var hl = Math.max(1, Math.sqrt(dx * dx + dz * dz));
      var off = (((hsh >> 3) % 1001) / 1000 - 0.5) * 2 * SPLAY;
      if (L.dupN > 1) off += (L.dupIdx - (L.dupN - 1) / 2) * DUP_SP;
      L.mx += (-dz / hl) * off; L.mz += (dx / hl) * off;
      /* depth cue: flows nearer the camera render brighter (their ribbons are
         already wider on screen by perspective); far ones recede. Mild, so
         a far NFS stream still outranks a near keepalive. */
      var apx = 0.25 * L.ax + 0.5 * L.mx + 0.25 * L.bx - cx;
      var apy = 0.25 * L.ay + 0.5 * L.my + 0.25 * L.by - cy;
      var apz = 0.25 * L.az + 0.5 * L.mz + 0.25 * L.bz - cz;
      var cd = Math.sqrt(apx * apx + apy * apy + apz * apz) || 1;
      L.dk = Math.max(0.88, Math.min(1.25, 0.82 + 280 / cd));
      /* ribbon strip: at each cross-section offset +-halfwidth along
         normalize(tangent x viewDir) so the ribbon always faces the camera */
      for (var s = 0; s <= SEG; s++) {
        var tv = s / SEG, uu = 1 - tv;
        var pxx = uu * uu * L.ax + 2 * uu * tv * L.mx + tv * tv * L.bx;
        var pyy = uu * uu * L.ay + 2 * uu * tv * L.my + tv * tv * L.by;
        var pzz = uu * uu * L.az + 2 * uu * tv * L.mz + tv * tv * L.bz;
        var tx = uu * (L.mx - L.ax) + tv * (L.bx - L.mx);   // tangent (unnorm.)
        var ty = uu * (L.my - L.ay) + tv * (L.by - L.my);
        var tz = uu * (L.mz - L.az) + tv * (L.bz - L.mz);
        var vx = pxx - cx, vy = pyy - cy, vz = pzz - cz;    // to-camera dir
        var sx = ty * vz - tz * vy, sy = tz * vx - tx * vz, sz = tx * vy - ty * vx;
        var sl = Math.sqrt(sx * sx + sy * sy + sz * sz);
        var hw = L.w * FL.taper[s] / (sl || 1);
        if (!isFinite(hw)) hw = 0;
        sx *= hw; sy *= hw; sz *= hw;
        var vo = o + s * 6;
        FL.posArr[vo]     = pxx - sx; FL.posArr[vo + 1] = pyy - sy; FL.posArr[vo + 2] = pzz - sz;
        FL.posArr[vo + 3] = pxx + sx; FL.posArr[vo + 4] = pyy + sy; FL.posArr[vo + 5] = pzz + sz;
      }
      if (FL.picks[i]) {          // pick target at the arc apex (t = 0.5)
        FL.picks[i].position.set(
          0.25 * L.ax + 0.5 * L.mx + 0.25 * L.bx,
          0.25 * L.ay + 0.5 * L.my + 0.25 * L.by,
          0.25 * L.az + 0.5 * L.mz + 0.25 * L.bz);
      }
    }
    FL.line.geometry.attributes.position.needsUpdate = true;
  }
  /* per-frame ribbon colours: comet-shaped brightness pulses travel src->dst
     at the SAME measured-rate speed as the particles (wall-clock dt, so a
     recording never judders). Sharp-but-softened leading edge, long tail:
     direction is readable from the pulse shape alone. Chatter ribbons stay
     static and dim. Focus fade (L.foc) and depth cue (L.dk) multiply in. */
  function tickColors(dt) {
    if (!FL.colArr || !FL.line) return;
    var vps = SEG + 1;
    for (var i = 0; i < FL.flows.length; i++) {
      var L = FL.geom[i];
      if (!L) continue;
      var o = i * vps * 2 * 3;
      if (!L.ok) {
        if (!L.dark) { for (var k = o; k < o + vps * 6; k++) FL.colArr[k] = 0; L.dark = 1; }
        continue;
      }
      L.dark = 0;
      var foc = L.foc === undefined ? 1 : Math.max(0, Math.min(1, (L.foc - 0.35) / 0.65));
      var mul = L.mul * (L.dk || 1) * foc;
      /* pulse speed follows the particles' measured-rate speed, but the
         TEMPORAL frequency is capped: on a short arc an uncapped pattern
         cycles at ~19 Hz, which strobes badly on video. 2.2 Hz max. */
      if (L.pulse) L.ph = (L.ph + Math.min((40 + 240 * L.u) / L.len * L.cyc, 2.2) * dt) % 1;
      for (var s = 0; s <= SEG; s++) {
        var tv = s / SEG;
        var br = mul * (0.55 + 0.45 * tv);       // still brightens toward dst
        if (L.pulse) {
          var w = ((tv * L.cyc - L.ph) % 1 + 1) % 1;
          var b = (1 - w) * (1 - w);             // sawtooth tail behind the head
          if (w < 0.1) b *= w * 10;              // soften the leading edge
          br *= 0.45 + (0.7 + 1.2 * L.u) * b;
        }
        var vo = o + s * 6;
        FL.colArr[vo]     = FL.colArr[vo + 3] = L.cr * br;
        FL.colArr[vo + 1] = FL.colArr[vo + 4] = L.cg * br;
        FL.colArr[vo + 2] = FL.colArr[vo + 5] = L.cb * br;
      }
    }
    FL.line.geometry.attributes.color.needsUpdate = true;
  }

  /* ============================ per-frame ============================ */
  function netFlowsTick(t, dt) {
    if (!FL || !window.scene) return;
    try {
      var d = +dt > 0 ? Math.min(+dt, 0.1) : 0.016;
      updateGeometry();                     // arcs follow tweening nodes
      tickColors(d);                        // travelling pulses on the ribbons
      tickParticles(d);
      tickChevrons();
      tickLabels();
      hover();
    } catch (e) { /* never break the host render loop */ }
  }

  /* orient each chevron along its arc's PROJECTED tangent, recomputed from
     scratch every frame (camera may orbit or fly; nothing is cached). Sprite
     rotation is screen-space CCW; pixel y runs down, hence the sign flip. */
  var _cv1 = null, _cv2 = null;
  function tickChevrons() {
    var NS = ns();
    if (!NS || !NS.cam || !FL.chev.length) return;
    var THREE = window.THREE, cam = NS.cam;
    if (!_cv1) { _cv1 = new THREE.Vector3(); _cv2 = new THREE.Vector3(); }
    var W = window.innerWidth || 1920, H = window.innerHeight || 1080;
    for (var i = 0; i < FL.chev.length; i++) {
      var cs = FL.chev[i], L = FL.geom[i];
      if (!cs.userData.on || !L || !L.ok) { cs.visible = false; continue; }
      var t0 = CHEV_T - 0.04, t1 = CHEV_T + 0.04, u0 = 1 - t0, u1 = 1 - t1;
      _cv1.set(u0 * u0 * L.ax + 2 * u0 * t0 * L.mx + t0 * t0 * L.bx,
               u0 * u0 * L.ay + 2 * u0 * t0 * L.my + t0 * t0 * L.by,
               u0 * u0 * L.az + 2 * u0 * t0 * L.mz + t0 * t0 * L.bz);
      _cv2.set(u1 * u1 * L.ax + 2 * u1 * t1 * L.mx + t1 * t1 * L.bx,
               u1 * u1 * L.ay + 2 * u1 * t1 * L.my + t1 * t1 * L.by,
               u1 * u1 * L.az + 2 * u1 * t1 * L.mz + t1 * t1 * L.bz);
      cs.position.copy(_cv1).lerp(_cv2, 0.5);          // midpoint = CHEV_T
      _cv1.project(cam); _cv2.project(cam);
      if (_cv1.z > 1 || _cv2.z > 1) { cs.visible = false; continue; }
      var dx = (_cv2.x - _cv1.x) * W, dy = -(_cv2.y - _cv1.y) * H;
      cs.material.rotation = Math.atan2(-dy, dx);
      cs.visible = true;
    }
  }

  function tickParticles(dt) {
    var n = FL.pActive;
    if (!n) return;
    for (var s = 0; s < n; s++) {
      var L = FL.geom[FL.pFlow[s]];
      if (!L || !L.ok) { FL.pPos[s * 3 + 1] = -1e5; continue; }
      var speed = (40 + 240 * L.u) / L.len;          // rate encodes measured bps
      var pr = FL.pProg[s] + speed * dt;
      if (pr >= 1) pr -= 1;
      FL.pProg[s] = pr;
      var u = 1 - pr;
      FL.pPos[s * 3]     = u * u * L.ax + 2 * u * pr * L.mx + pr * pr * L.bx;
      FL.pPos[s * 3 + 1] = u * u * L.ay + 2 * u * pr * L.my + pr * pr * L.by + 1.2;
      FL.pPos[s * 3 + 2] = u * u * L.az + 2 * u * pr * L.mz + pr * pr * L.bz;
    }
    FL.pGeo.attributes.position.needsUpdate = true;
  }

  /* hover: runs AFTER netscene's hover each frame, so a flow hit overrides the
     (hidden-or-node) tip; when we lose the hit we hide only what we showed. */
  function hover() {
    var NS = ns();
    if (!NS || !FL.tip || !NS.mouse || !NS.cam) return;
    if ((FL.hoverFrame++) & 1) return;
    if (NS.mouse.x < -2 || !FL.picks.length) return;
    FL.ray.setFromCamera(NS.mouse, NS.cam);
    var hits = FL.ray.intersectObjects(FL.picks, false);
    var f = null;
    if (hits.length && hits[0].object.userData.flowIdx !== undefined) {
      var idx = hits[0].object.userData.flowIdx;
      if (FL.geom[idx] && FL.geom[idx].ok) f = FL.flows[idx];
    }
    if (!f) {
      if (FL.tipOurs) { FL.tipOurs = false; FL.tip.style.display = 'none'; }
      return;
    }
    var col = '#' + ('00000' + flowColor(f, _c).getHex().toString(16)).slice(-6);
    var rows = [
      '<b>' + esc(f.src_label || f.src_ip) + ' → ' + esc(f.dst_label || f.dst_ip) + '</b>',
      esc(f.src_ip) + ' → ' + esc(f.dst_ip),
      '<span style="color:' + col + '">' + esc(f.proto || 'unknown proto') + '</span> · ' +
        (f.internal ? 'LAN flow' : 'via WAN') + ' · ntopng/vmbr0',
      fmtBps(f.bps) + ' · ' + fmtBytes(f.bytes) + ' total'
    ];
    FL.tip.innerHTML = rows.join('<br>');
    FL.tip.style.display = 'block';
    FL.tipOurs = true;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
})();
