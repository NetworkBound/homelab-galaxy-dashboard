/* ============================================================================
   netscene_universe.js - every device the estate knows, on the wall (2026-10-04)

   Source: GET /api/universe (docs/contracts.md section 1), polled with fetch every
   12 s. NO EventSource: the wall already holds five streams and Chrome allows
   six connections per host.

   WHAT IT DRAWS
   * Every body that belongs to a system whose hub is on the topology spine:
     guests, wired/wireless clients, SNMP devices, probe-discovered hosts,
     cameras - including the ones with no topology node at all. Infra bodies
     (UDM, switch, AP, PVE hosts, the SD-WAN NVR) stay netscene.js meshes.
   * REAL 3D BODIES (2026-10-05, round 4): static/bodies3d.js, one instanced
     mesh per class, matcap-shaded, vertex colour x tint (Proxmox guests wear
     the CATEGORY palette, everything else the class tint), Blender models from
     manifest.models when present, clean placeholders until then. Replaces the
     atlas / turntable sprites, which read as blurry stickers on the wall.
     The Blender birth flare stays (an additive flipbook ring at the slot).
   * ONE LineSegments draw: a faint orbit ring per (system, shell).
   * ONE mesh draw: a soft glow disc under each system.
   * Names for bodies that have no topology node are stub entries in
     NS.labels: netscene's single collision pass judges them and its 2D text
     overlay paints them (2026-10-08: short names, one line, no IPs).

   WHERE A BODY GOES (never sorted, never re-laid out client-side)
     world = hub(system.anchor) + SCALE * UNIVERSE_LAYOUT.place(body, geom)
     geom  = UNIVERSE_LAYOUT.geometry(quantizeCaps(system.shells))
   quantizeCaps rounds each shell's capacity up to a step of 8 with >= 25 %
   headroom, so a new device in an inner shell does not nudge outer shells -
   radii change only when a shell crosses a step, and then ease over ~1.5 s.
   netscene.js reserves a disc of radius R around each hub in its tree layout
   and places topology leaves with offset() below, so node labels, links and
   flow arcs all land on the same spot as the sprite.

   MOTION (curves: static/motion.js, the one table)
   * epicycle: each body circles its own slot (radius ~4 units) at
     orbitOmega(actU(rx+tx)) - 90 s/rev idle .. 12 s/rev at 100 Mb/s, capped.
     Computed in the vertex shader from a uniform clock: zero per-frame JS.
     When omega changes the phase offset is re-based so nothing jumps.
   * down: omega 0 (stops where it is), dim, desaturated. Back up: resumes
     from the same spot - the slot never changes.
   * latency: brightness breathing, period pulsePeriod(rtt_ms) 2..8 s.
   * new (first 10 min): ring flare at the slot every 3.2 s, envelope keyed
     to first_seen so every screen shows the same age.
   * self spin: motion.js spinOmega, re-based like the epicycle (no jumps);
     down -> spin and epicycle stop in place, body dims + desaturates (eased).
   * tour focus: the same crossfade as netscene (NS.focusOf): an off-subject
     body sits at one constant ambient level, the subjects of a leg ease
     across the travel. No global lift at departure.

   DEBUG (URL flags, harness only)
     ?uni=off            disable (fallback to the classic topology layout)
     ?uni_new=<n>        mark n bodies new (birth flare QA)
     ?uni_down=<n>       mark n up bodies down (stillness QA)
     ?uni_synth=<n>      append n synthetic bodies (growth-stability QA)
     ?g2delay=<ms>       hold every galaxy2 plate texture back (slow-load QA: the bake stands in)
     ?park=<key>         park the tour at the first stop whose key starts with <key>
   window.NETUNI.debug() returns counts and draw stats.
   ========================================================================== */
(function () {
  'use strict';
  var Q = (function () { var o = {}; (location.search || '').replace(/^\?/, '').split('&').forEach(function (kv) { if (!kv) return; var p = kv.split('='); o[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || '1'); }); return o; })();
  if (Q.uni === 'off') return;

  var SCALE = 32;                 // world units per layout unit (SPACING 0.55 -> ~17.6 u)
  var POLL_MS = 12000;
  var FOC_FLOOR = 0.34;           // = netscene FOC_FLOOR_UNI
  var LABEL_FADE = { near: 800, far: 1300 };   // = netscene guest labels in universe mode
  var TAU = Math.PI * 2;
  var GUEST_CAT = { ai: '#ff4fa3', media: '#38e1ff', network: '#37f5a0', monitor: '#ffb347', web: '#9b8cff', infra: '#8fb0d0' };

  /* class -> procedural atlas cell + base size (world units). The manifest,
     when present, overrides atlas index / size / spin / tint per class. */
  var CLASSES = ['pve_host', 'guest_vm', 'guest_lxc', 'gateway', 'switch', 'ap', 'server', 'storage',
                 'computer', 'phone', 'tablet', 'tv_av', 'iot', 'appliance', 'camera', 'printer',
                 'game_console', 'network_device', 'edge', 'unknown'];
  var SIZE = { pve_host: 26, guest_vm: 17, guest_lxc: 15, gateway: 24, 'switch': 22, ap: 20, server: 18, storage: 18,
               computer: 16, phone: 14, tablet: 14, tv_av: 16, iot: 13, appliance: 13.5, camera: 15, printer: 14,
               game_console: 15, network_device: 14, edge: 20, unknown: 11 };
  var SPIN = { phone: 0.15, tablet: 0.12, iot: 0.2, unknown: 0.1, camera: 0.05, network_device: 0.08 };
  /* topology leaves with no universe body still need a class */
  var CLIENT_CAT_CLASS = { pc: 'computer', phone: 'phone', appliance: 'appliance', 'smart-home': 'iot', av: 'tv_av',
                           printer: 'printer', '3dprinter': 'printer', network: 'network_device', unknown: 'unknown' };

  var U = {
    active: false, sig: '', data: null, systems: [], bodies: [], byId: {}, byTopo: {}, sysById: {}, sysByAnchor: {},
    geom: {}, offs: {}, state: {}, insts: [], extraList: [], err: null, fetched: 0, manifest: null, atlasMode: 'procedural'
  };
  var NS = null, M = null, LAY = null;
  var R3 = null;   // THREE objects

  /* ---------------- interface used by netscene.js ---------------- */
  U.sysOfAnchor = function (id) { return U.sysByAnchor[id] || null; };
  U.bodyOfTopo = function (id) { return U.byTopo[id] || null; };
  U.sysOf = function (b) { return b && b.system ? (U.sysById[b.system] || null) : null; };
  U.offset = function (b) { return U.offs[b.id] || ZERO; };
  /* bodies of a system with no topology node (computed live: netscene's
     buildTour asks before this file's onRebuild has run) */
  U.extras = function (sy) {
    if (!sy || !U.active) return [];
    var out = [];
    for (var i = 0; i < U.bodies.length; i++) { var b = U.bodies[i]; if (b.system === sy.id && !(b.topo && NS.byId[b.topo])) out.push(b); }
    return out;
  };
  var ZERO = { x: 0, y: 0, z: 0 };

  function quantizeCaps(caps) {
    if (LAY && typeof LAY.quantizeCaps === 'function') return LAY.quantizeCaps(caps);
    var out = {};
    Object.keys(caps || {}).forEach(function (k) {
      var c = +caps[k] || 0;
      out[k] = c > 0 ? 8 * Math.ceil((c + Math.max(3, Math.ceil(c / 4))) / 8) : 0;
    });
    return out;
  }

  /* ---------------- data ---------------- */
  function synthesize(d) {
    // QA only: deterministic synthetic growth / status flips from URL flags
    var n = +Q.uni_synth || 0, nn = +Q.uni_new || 0, nd = +Q.uni_down || 0;
    var nk = U.fetched ? (+Q.uni_kill || 0) : 0;    // from the 2nd poll on: n up bodies go down
    nd += nk;
    if (!n && !nn && !nd) return d;
    d = JSON.parse(JSON.stringify(d));
    var B = d.bodies, caps = {};
    B.forEach(function (b) { if (!b.system) return; var k = b.system + '#' + b.shell; caps[k] = Math.max(caps[k] || 0, b.slot + 1); });
    var cls = ['phone', 'iot', 'unknown', 'tv_av', 'computer'], sys = 'sys:home', now = Date.now() / 1000;
    for (var i = 0; i < n; i++) {
      var c = cls[i % cls.length], sh = LAY.shellOf(c), k = sys + '#' + sh, slot = caps[k] || 0; caps[k] = slot + 1;
      var id = 'synth:' + i;
      B.push({ id: id, label: 'synthetic-' + i, 'class': c, cat: 'network', system: sys, parent: null, shell: sh, slot: slot,
               seed: LAY.hash32(id), status: 'up', first_seen: now - 30, last_seen: now, 'new': true, m: { rx_bps: 2e4 * (i + 1) }, src: ['qa'] });
    }
    var sysObj = d.systems.filter(function (s) { return s.id === sys; })[0];
    if (sysObj) { sysObj.shells = {}; Object.keys(caps).forEach(function (k) { var p = k.split('#'); if (p[0] === sys) sysObj.shells[p[1]] = caps[k]; }); sysObj.count = B.filter(function (b) { return b.system === sys; }).length; }
    var leaves = B.filter(function (b) { return b.system && b.status === 'up' && !/^(pve_host|gateway|switch|ap)$/.test(b['class']); });
    for (var j = 0; j < nn && j < leaves.length; j++) { leaves[j]['new'] = true; leaves[j].first_seen = now - 20 - j * 15; }
    for (var q = 0; q < nd && q < leaves.length; q++) leaves[leaves.length - 1 - q].status = 'down';
    return d;
  }

  function ingest(d) {
    if (!d || !d.bodies || !d.systems) throw new Error('bad universe payload');
    d = synthesize(d);
    /* a removed node's galaxy is kept by the registry with count 0 through
       its 30-day hold: it draws nothing and gets no stop */
    d.systems = d.systems.filter(function (s) { return s.count === undefined || s.count > 0; });
    U.hasShort = d.bodies.some(function (b) { return !!b.short; });
    U.data = d;
    var byId = {}, byTopo = {}, sysById = {}, sysByAnchor = {};
    d.systems.forEach(function (s) { sysById[s.id] = s; if (s.anchor) sysByAnchor[s.anchor] = s; });
    d.bodies.forEach(function (b) { byId[b.id] = b; if (b.topo) byTopo[b.topo] = b; });
    /* geometry per system from QUANTIZED capacities */
    var geom = {}, offs = {}, sigParts = [];
    d.systems.forEach(function (s) {
      var caps = s.shells || (LAY.capacities(d.bodies)[s.id] || {});
      var qc = quantizeCaps(caps);
      var g = LAY.geometry(qc);
      geom[s.id] = g;
      /* dense systems get more room (2026-10-04 review: 87 guests in one disc
         read as a blob). A step function of the QUANTIZED capacity, so it only
         changes when quantizeCaps already moved the radii - same rule, no new
         reshuffles. Relative placement is untouched; only world scale grows. */
      var qtot = 0; Object.keys(qc).forEach(function (k) { qtot += +qc[k] || 0; });
      s._k = SCALE * (qtot > 96 ? 1.45 : qtot > 48 ? 1.2 : 1);
      /* the network core holds the switch STARS (registry hub:true, 2026-10-07):
         at the generic scale five glowing stars sat in one knot round the UDM.
         A fixed, larger scale for the core spreads its orbit (relative layout
         untouched: a constant, so it never reshuffles anything later) */
      if (s.kind === 'network') s._k *= 1.8;
      /* the home network's class rings are sparse (29 devices over 8 rings read
         as a mostly empty bullseye ~670 units across): a tighter fixed scale
         for a 'clients' system. Constant, so it never reshuffles anything. */
      else if (s.kind === 'clients') s._k *= 0.62;
      var rmax = 0; Object.keys(g).forEach(function (k) { rmax = Math.max(rmax, g[k].r1); });
      s.R = (rmax + 0.35) * s._k;
      s._extras = [];
      sigParts.push(s.id + '@' + s.anchor + ':' + Object.keys(qc).sort().map(function (k) { return k + '=' + qc[k]; }).join(','));
    });
    d.bodies.forEach(function (b) {
      var s = sysById[b.system];
      if (!s) return;
      if (s.anchor && b.topo === s.anchor) { offs[b.id] = ZERO; return; }   // the hub sits at the centre
      var p = LAY.place(b, geom[s.id]);
      offs[b.id] = { x: p.x * s._k, y: p.y * s._k, z: p.z * s._k, phase: p.phase, scale: p.scale };
      sigParts.push(b.id + '>' + b.system + '/' + b.shell + '/' + b.slot);
    });
    var groups = presentGroups(d, geom, offs);
    Object.keys(groups).forEach(function (sid) {
      var G0 = groups[sid];
      sigParts.push('grp:' + sid + ':' + G0.map(function (q) { return q.key + '@' + q.a0.toFixed(3) + '-' + q.a1.toFixed(3); }).join(','));
    });
    U.groups = groups;
    U.byId = byId; U.byTopo = byTopo; U.sysById = sysById; U.sysByAnchor = sysByAnchor;
    U.systems = d.systems.slice(); U.bodies = d.bodies; U.geom = geom; U.offs = offs;
    sigParts.sort();                     // server order is not part of the layout
    var sig = String(sigParts.length) + '|' + hashStr(sigParts.join(';'));
    var changed = sig !== U.sig;
    U.sig = sig;
    return changed;
  }
  function hashStr(s) { return LAY.hash32(s).toString(36); }

  /* ---------------- presentation: visible groups (2026-10-07) ----------------
     "Confetti" was the complaint: 88 guests spread evenly over the whole disc by
     the R2 sequence, every colour everywhere, so a host stop had no structure.
     Slot ASSIGNMENT is untouched (server-owned, append-only); only how a PVE
     system's guest shells are PRESENTED changes:
       - the disc is cut into one sector per guest category, in a fixed order
         (the HUD legend order), sector width ~ the category's QUANTIZED size
         (quantizeCaps' rule: boundaries only move when a category crosses a
         step), with a clear gap between sectors;
       - containers (shell 3) fill the inner annulus, VMs (shell 4) the outer
         one, both radii straight from UNIVERSE_LAYOUT.geometry();
       - inside its (category, shell) group a guest's index is its rank by slot,
         and it is placed with the same R2 low-discrepancy sequence the layout
         uses, compressed into the sector. Slots are append-only, so a new guest
         takes the next index: nobody else moves.
     Every other system (home, core, sites) already rings by class (one shell
     per class); for those this only records the rings so each can be named.
     The result feeds U.groups -> netscene's group captions ("MEDIA 3"). */
  var SECT_CATS = ['ai', 'media', 'network', 'monitor', 'web', 'infra'];
  var ARM_TWIST = 1.35;     // rad an arm winds from the inner to the outer edge of the guest annulus
  var RING_NAME = { 1: 'Network gear', 2: 'Servers', 3: 'Containers', 4: 'VMs', 5: 'Computers', 6: 'Phones', 7: 'TV & AV', 8: 'Smart home',
                    9: 'Appliances', 10: 'Printers', 11: 'Cameras', 12: 'Unidentified' };
  var SECT_NAME = { ai: 'AI', media: 'Media', network: 'Network', monitor: 'Monitoring', web: 'Web', infra: 'Infra' };
  function fracU(v) { return v - Math.floor(v); }
  function presentGroups(d, geom, offs) {
    var out = {}, A1 = 0.7548776662466927, A2 = 0.5698402909980532;
    d.systems.forEach(function (s) {
      var g = geom[s.id] || {}, k = s._k || SCALE, list = [];
      d.bodies.forEach(function (b) { if (b.system === s.id && !(s.anchor && b.topo === s.anchor) && offs[b.id]) list.push(b); });
      var grp = [];
      if (s.kind === 'pvehost' || s.kind === 'k8s') {
        var by = {}, n = {};
        list.forEach(function (b) {
          if (b.shell !== 3 && b.shell !== 4) return;
          var c = SECT_CATS.indexOf(b.cat) >= 0 ? b.cat : 'infra';
          (by[c + '#' + b.shell] = by[c + '#' + b.shell] || []).push(b);
          n[c] = (n[c] || 0) + 1;
        });
        var live = SECT_CATS.filter(function (c) { return n[c] > 0; });
        if (!live.length) { out[s.id] = grp; return; }
        var q = {}, Q = 0;
        /* sector widths from QUANTIZED counts, the same rule quantizeCaps uses
           for shell radii (steps of 8 with headroom): a new guest only moves the
           sector boundaries when its category crosses a step, which is rare */
        live.forEach(function (c) { q[c] = 8 * Math.ceil((n[c] + Math.max(3, Math.ceil(n[c] / 4))) / 8); Q += q[c]; });
        var GAP_A = live.length > 1 ? 0.16 : 0, usable = TAU - GAP_A * live.length;
        var gL = g[3] || g[4], gV = g[4] || g[3];
        var rIn = Math.min(gL.r0, gV.r0), rOut = Math.max(gL.r1, gV.r1);
        /* fixed start so the first sector (ai) sits screen-left of the host
           stop's camera; purely cosmetic, never data-dependent */
        var a = 1.15, TW = ARM_TWIST;
        live.forEach(function (c) {
          var w = usable * q[c] / Q, a0 = a, a1 = a + w, mem = [];
          [3, 4].forEach(function (sh) {
            var B = by[c + '#' + sh]; if (!B) return;
            B.sort(function (x, y) { return x.slot - y.slot || (x.id < y.id ? -1 : 1); });
            var gg = sh === 3 ? gL : gV;
            B.forEach(function (b, i) {
              var rm = (gg.r0 + gg.r1) / 2, pad = Math.min(w * 0.3, 0.30 / Math.max(rm, 0.5));
              var th = a0 + pad + fracU(0.5 + i * A1) * Math.max(0.0, w - 2 * pad);
              var u = fracU(0.5 + i * A2);
              var r = Math.sqrt(gg.r0 * gg.r0 + u * (gg.r1 * gg.r1 - gg.r0 * gg.r0));
              th += TW * (r - rIn) / Math.max(0.5, rOut - rIn);        // the sector curls into a spiral arm
              var y = ((((b.seed >>> 4) & 0xff) / 255) - 0.5) * 0.10 * (gg.r1 - gg.r0);
              var o = offs[b.id];
              o.x = r * Math.cos(th) * k; o.y = y * k; o.z = r * Math.sin(th) * k;
              mem.push(b.id);
            });
          });
          grp.push({ key: c, kind: 'sector', label: SECT_NAME[c] || c, n: n[c], a0: a0, a1: a1, rIn: rIn * k, rOut: rOut * k, members: mem, twist: TW });
          a = a1 + GAP_A;
        });
      } else {
        var shells = {};
        list.forEach(function (b) { if (b.shell > 0 || s.kind !== 'network') (shells[b.shell] = shells[b.shell] || []).push(b.id); });
        Object.keys(shells).map(Number).sort(function (x, y) { return x - y; }).forEach(function (sh) {
          var gg = g[sh]; if (!gg) return;
          grp.push({ key: 'shell' + sh, kind: 'ring', shell: sh, label: RING_NAME[sh] || ('Ring ' + sh), n: shells[sh].length,
                     a0: 0, a1: TAU, rIn: gg.r0 * k, rOut: gg.r1 * k, members: shells[sh] });
        });
      }
      out[s.id] = grp;
    });
    return out;
  }

  function poll() {
    fetch('/api/universe', { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (d) {
      var first = !U.active;
      var changed = ingest(d);
      U.active = true; U.err = null; U.fetched = Date.now();
      NS.uniWaitUntil = 0;
      if (first || changed || !NS.graph) NS.relayout();       // -> rebuildGraph -> onRebuild
      /* QA: ?park=<stop key prefix> parks the tour there (harness screenshots) */
      if (first && Q.park) setTimeout(function () { NS.tourPark = true; NS.tourGoto && NS.tourGoto(Q.park); }, 1500);
      else refreshDynamics();
    }).catch(function (e) {
      U.err = String(e && e.message || e);
      /* honest fallback: no universe -> the classic topology layout. If we were
         active, keep the last good universe rather than flapping the layout. */
      if (NS.uniWaitUntil) { NS.uniWaitUntil = 0; if (NS.relayout) NS.relayout(); }
    });
  }

  /* ---------------- textures ---------------- */
  function glowTex() {
    var s = 256, cv = document.createElement('canvas'); cv.width = cv.height = s;
    var x = cv.getContext('2d'), g = x.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(255,255,255,0.55)'); g.addColorStop(0.25, 'rgba(255,255,255,0.22)');
    g.addColorStop(0.7, 'rgba(255,255,255,0.06)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.fillRect(0, 0, s, s);
    return new THREE.CanvasTexture(cv);
  }

  /* ---------------- shaders ---------------- */
  /* ---------------- build ---------------- */
  var G = { pts: null, b3d: null, rings: null, discs: null, lbl: null, glow: null,
            n: 0, cap: 0, pos: null, col: null, aA: null, aB: null, aC: null, foc: null, focT: null,
            tBase: 0, focSeq: -1, moving: true, labels: [], ringInfo: [], discInfo: [] };

  function classOf(b) { return CLASSES.indexOf(b['class']) >= 0 ? b['class'] : 'unknown'; }
  function mcls(cls) { return U.manifest && U.manifest.classes ? (U.manifest.classes[cls] || null) : null; }

  /* 3D body radius from the old sprite size (world units, quad diameter): the
     glyph filled ~60 % of the quad, a model fills its unit sphere */
  var R3D = 0.54;
  /* guests draw as clean category orbs (bodies3d orb_*), see presentGroups */
  var DRAW_CLS = { guest_lxc: 'orb_lxc', guest_vm: 'orb_vm' };
  var SPIN3D = { phone: 0.15, tablet: 0.12, iot: 0.2, unknown: 0.12, camera: 0.05, network_device: 0.08, tv_av: 0.1,
                 game_console: 0.14, appliance: 0.12, guest_lxc: 0.1, guest_vm: 0.08, computer: 0.08, printer: 0.07, server: 0.06,
                 storage: 0.06, edge: 0.03 };

  function ensureObjects() {
    if (G.pts) return;
    var fog = NS.scene.fog;
    G.glow = glowTex();
    /* one shared bodies3d instance per page (netscene.js builds the hub
       meshes from the same one, so hubs and devices share models + look) */
    G.b3d = NS.b3d || (NS.b3d = NS.b3dCreate ? NS.b3dCreate() : window.BODIES3D.create({ scene: NS.scene, fogDensity: fog && fog.density !== undefined ? fog.density : 0.0006 }));
    G.b3d.onChange(function () { queueWarm(); });
    /* uniforms shared with the birth flare overlay */
    G.mat = { uniforms: { uTime: { value: 0 }, uNow: { value: 0 }, uPx: { value: 500 }, uOrbitR: { value: M.ORBIT_R_FRAC * 0.55 * SCALE } } };
    G.pts = G.b3d;
    G.rings = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false }));
    G.rings.frustumCulled = false; G.rings.userData.universe = true; G.rings.renderOrder = -3;
    NS.scene.add(G.rings);

    G.discs = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({
      map: G.glow, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide }));
    G.discs.frustumCulled = false; G.discs.userData.universe = true; G.discs.renderOrder = -4;
    NS.scene.add(G.discs);
  }

  /* ---------------- photo look (2026-10-08, contracts 8) ----------------
     Every body is lit by ITS star: the system anchor (a Proxmox host's core, the
     gateway, the home switch star, a site's router). A system whose anchor is
     not a star (the SD-WAN NVR, a ringed giant) is lit by its galaxy's core
     light, a little above the disc where the giant sits. bodies3d gets the
     star's world position + a colour code per body (B.lights), kept current
     while the hubs tween. */
  var PHOTO_R = 0.62;           // planet radius vs the sprite-era size: plausible, not toy-like
  var STAR_CODE = { pvehost: 1, k8s: 1, gateway: 2, 'switch': 3, ap: 4, wan: 5 };
  function gatewayNode() { for (var i = 0; i < NS.nodes.length; i++) if (NS.nodes[i].kind === 'gateway') return NS.nodes[i]; return null; }
  function starOf(it) {
    var h = it.hub;
    if (!h && it.node && it.node._par) {                       // topology-only leaf: its parent, if that is a star
      var p = NS.byId[it.node._par];
      if (p && STAR_CODE[p.kind]) h = p;
    }
    if (!h) return null;
    if (STAR_CODE[h.kind]) return { n: h, code: STAR_CODE[h.kind] };
    if (h.kind === 'client') return { n: h, code: 4 };          // a site router (network gear): a red dwarf
    /* a giant at the centre (the SD-WAN NVR): its bodies are lit by the galaxy's
       own core, where the giant sits, a little above the disc (lit from the
       distant gateway, every camera at that stop looked at night sides) */
    return { n: h, code: 7, dy: 0.35 * ((it.sys && it.sys.R) || 150) };
  }
  function writeLights() {
    if (!G.b3d || !G.b3d.photo || !U.insts) return;
    var L = G.b3d.lights; if (!L || L.length < G.n * 4) return;
    for (var i = 0; i < G.n; i++) {
      var s = U.insts[i].star, o = i * 4;
      if (!s) { L[o] = L[o + 1] = L[o + 2] = L[o + 3] = 0; continue; }
      L[o] = s.n._cx; L[o + 1] = s.n._cy + (s.dy || 0); L[o + 2] = s.n._cz; L[o + 3] = s.code;
    }
    G.b3d.markLights();
  }

  /* per-index CPU arrays: slot centre, colour, (atlas idx, size, spin, seed
     phase), (omega, phase, pulse, brightness), (focus, birth) - the overlay and
     the labels read them; bodies3d gets its own copy */
  function growBuffers(n) {
    if (n <= G.cap) return;
    var cap = Math.max(64, Math.ceil(n * 1.5));
    G.cap = cap;
    G.pos = new Float32Array(cap * 3); G.col = new Float32Array(cap * 3);
    G.aA = new Float32Array(cap * 4); G.aB = new Float32Array(cap * 4); G.aC = new Float32Array(cap * 4);
    G.foc = new Float32Array(cap); G.focT = new Float32Array(cap);
  }

  /* Instances = every drawable body. Order follows the server's body order
     (and topology order for the few topology-only leaves); order only decides
     the buffer index, never a position. */
  function rebuildInstances() {
    if (!NS.graph) return;
    ensureObjects();
    var list = [], seenTopo = {};
    (U.systems || []).forEach(function (s) { s._extras = []; });
    if (U.active) {
      U.bodies.forEach(function (b) {
        var s = U.sysOf(b); if (!s) return;                  // edge bodies: netscene_exo draws the edge
        var hub = NS.byId[s.anchor]; if (!hub) return;        // hub not on the spine: cannot place honestly
        var node = b.topo ? NS.byId[b.topo] : null;
        if (node && node.kind !== 'guest' && node.kind !== 'client') return;   // infra mesh already
        if (node) seenTopo[node.id] = 1;
        else s._extras.push(b);
        list.push({ b: b, node: node, hub: hub, sys: s, cls: classOf(b) });
      });
    }
    /* topology leaves the universe does not (yet) know: still drawn, same layer */
    NS.nodes.forEach(function (n) {
      if ((n.kind !== 'guest' && n.kind !== 'client') || seenTopo[n.id]) return;
      var cat = n.meta && n.meta.cat;
      var cls = n.kind === 'guest' ? ((n.meta && n.meta.type === 'qemu') ? 'guest_vm' : 'guest_lxc') : (CLIENT_CAT_CLASS[cat] || 'unknown');
      var pb = { id: 'topo:' + n.id, label: n.label, 'class': cls, cat: cat, status: n.status === 'down' ? 'down' : (n.meta && n.meta.offline ? 'idle' : n.status),
                 seed: LAY.hash32(n.id), 'new': !!(n.meta && n.meta['new']), first_seen: n.meta && n.meta.age != null ? Date.now() / 1000 - n.meta.age : 0,
                 m: { rx_bps: (+n.rx || 0) * 8, tx_bps: (+n.tx || 0) * 8, rtt_ms: n.meta ? n.meta.rtt : null }, pseudo: true };
      list.push({ b: pb, node: n, hub: null, sys: null, cls: cls });
    });
    U.insts = list;
    G.n = list.length;
    growBuffers(G.n);
    var bl = new Array(G.n);
    for (var i = 0; i < list.length; i++) {
      var it = list[i], b = it.b, mc = mcls(it.cls), o = U.offs[b.id];
      var size = (mc && mc.size ? mc.size * 38 : SIZE[it.cls] || 12) * (o && o.scale ? o.scale : 1);
      /* celestial scale: the Blender manifest's relative radii (moon 0.45 ..
         gas giant 1.25), compressed so nothing becomes a speck or a boulder */
      if (G.b3d.celInfo) size *= Math.max(0.72, Math.min(1.45, 0.62 + 0.5 * G.b3d.celInfo(it.cls).size));
      if (b.hub) size *= 0.78;          // a switch hub is a small star (its halo and beams make it read bigger than its devices)
      var st = U.state[b.id] || (U.state[b.id] = { omega: -1, ph: (o && o.phase != null ? o.phase : (b.seed % 6283) / 1000) });
      if (st.sw === undefined) { st.sw = 0; st.sph = ((b.seed >>> 3) % 6283) / 1000; }
      G.aA[i * 4] = 0; G.aA[i * 4 + 1] = size;
      G.aA[i * 4 + 3] = ((b.seed >>> 3) % 6283) / 1000;
      it.st = st; it.k = i; it.size = size;
      G.foc[i] = focusTarget(it); G.focT[i] = G.foc[i];
      bl[i] = { key: b.id, cls: it.cls, radius: size * R3D, focus: G.foc[i] };
      if (G.b3d.photo) {
        /* photo look: plausible planet sizes, the body's own star, and the
           brightest far stars (switch hubs) carry diffraction spikes */
        var cinf = G.b3d.celInfo ? G.b3d.celInfo(it.cls) : null, isStar = !!(cinf && cinf.star);
        if (!isStar) bl[i].radius *= PHOTO_R;
        it.star = starOf(it);
        bl[i].light = it.star ? [it.star.n._cx, it.star.n._cy + (it.star.dy || 0), it.star.n._cz, it.star.code] : [0, 0, 0, 0];
        if (b.hub) { bl[i].spikes = 0.7; bl[i].mag = 1.8; }
      }
    }
    refreshDynamics(bl);
    G.b3d.setBodies(bl);
    writePositions(1);
    buildStarGlows();
    buildOverlay();
    buildRings();
    buildHubLinks();
    buildLabels();
    G.focSeq = -1;
    G.moving = true;
    queueWarm();
  }

  /* status / activity / latency -> colour, brightness, epicycle, pulse */
  /* bl: the bodies3d list being built (rebuild) - fill it in; otherwise push
     the changes into the live bodies3d instance (status changes ease there) */
  function refreshDynamics(bl) {
    if (!G.pts || !U.insts) return;
    var tNow = G.tNow || 0, nowS = Date.now() / 1000;
    for (var i = 0; i < U.insts.length; i++) {
      var it = U.insts[i], b = it.b;
      if (it.b.pseudo === undefined && U.byId[b.id]) b = it.b = U.byId[b.id];   // newest record for this id
      var m = b.m || {}, mc = mcls(it.cls);
      var bps = (m.rx_bps != null || m.tx_bps != null) ? (+m.rx_bps || 0) + (+m.tx_bps || 0) : null;
      var u = bps == null ? -1 : M.actU(bps);
      var omega = M.orbitOmega(u, b.status) * ((b.seed & 2) ? 1 : -1);
      var st = it.st || (it.st = U.state[b.id] = { omega: -1, ph: 0 });
      if (st.omega === -1) st.omega = omega;               // first sighting
      else if (st.omega !== omega) { st.ph += (st.omega - omega) * tNow; st.omega = omega; }   // continuous phase
      G.aB[i * 4] = omega; G.aB[i * 4 + 1] = st.ph % TAU;
      G.aB[i * 4 + 2] = b.status === 'down' ? 0 : M.pulsePeriod(m.rtt_ms);
      /* guests: live CPU lifts brightness too (the old lattice's activity map) */
      var cpuK = (m.cpu != null && b.status === 'up') ? 0.85 + 0.6 * Math.sqrt(Math.max(0, Math.min(1, +m.cpu))) : 1;
      G.aB[i * 4 + 3] = M.brightness(u, b.status) * cpuK * (it.node && it.node.meta && it.node.meta.offline ? 0.6 : 1);
      /* coordinator ruling 2026-10-04: Proxmox guests wear the CATEGORY palette
         (the HUD legend), everything else the class tint - same on both screens */
      var rgb = (it.cls === 'guest_lxc' || it.cls === 'guest_vm')
        ? LAY.colourRGB(b, { tint: GUEST_CAT[b.cat] || GUEST_CAT.infra })
        : LAY.colourRGB(b, mc);
      /* photo look: a star-class body (switch hub, AP, small gear) is a point of
         light whose colour is its temperature (a switch star is warm, an AP a red dwarf) */
      if (G.b3d && G.b3d.photo && G.b3d.celInfo) { var ci = G.b3d.celInfo(it.cls); if (ci && ci.star && ci.rgb) rgb = [ci.rgb[0], ci.rgb[1], ci.rgb[2]]; }
      G.col[i * 3] = rgb[0]; G.col[i * 3 + 1] = rgb[1]; G.col[i * 3 + 2] = rgb[2];
      /* 3D body: hue from the UP colour (bodies3d does the down dim + desat,
         eased, so a body that dies fades instead of popping grey) */
      var down = b.status === 'down';
      var hue = down ? ((it.cls === 'guest_lxc' || it.cls === 'guest_vm')
        ? LAY.colourRGB({ 'class': b['class'], seed: b.seed, status: 'up' }, { tint: GUEST_CAT[b.cat] || GUEST_CAT.infra })
        : LAY.colourRGB({ 'class': b['class'], seed: b.seed, status: 'up' }, mc)) : rgb;
      var sw = down ? 0 : M.spinOmega(SPIN3D[it.cls] != null ? SPIN3D[it.cls] : 0.06, Math.max(0, u)) * ((b.seed & 1) ? 1 : -1);
      if (sw !== st.sw) { st.sph = (st.sph + (st.sw - sw) * tNow) % TAU; st.sw = sw; }   // continuous spin angle
      var d3 = { tint: [hue[0], hue[1], hue[2]], orbitW: omega, orbitPh: st.ph % TAU, spinW: sw, spinPh: st.sph,
                 bright: G.aB[i * 4 + 3], desat: down ? 0.78 : (b.status === 'unknown' ? 0.35 : 0), pulse: G.aB[i * 4 + 2] };
      if (bl && bl[i]) { for (var dk in d3) bl[i][dk] = d3[dk]; }
      else if (G.b3d) G.b3d.setDynamics(i, d3);
      /* a body that was up on the last poll and is down now collapses once
         (death flipbook), keyed to the moment this screen saw it go */
      if (st.lastStatus && st.lastStatus !== 'down' && b.status === 'down') st.diedAt = nowS;
      st.lastStatus = b.status;
      var fresh = b['new'] && b.first_seen && nowS - b.first_seen < M.BIRTH_S;
      G.aC[i * 4 + 1] = fresh ? (b.first_seen - G.epoch) : -1e6;
    }
    if (!bl) buildOverlay();
  }

  /* ---------------- Blender flipbooks: ONE overlay draw ----------------
     birth (nova, replays every 12 s while a body is new), death (collapse,
     once, when a body goes down) and pulse (looping core breath for the
     classes the manifest marks anim:"pulse", its period from latency) share
     one Points draw with three samplers. Each overlay instance copies its
     body's slot + epicycle so it rides the body exactly. */
  var OVL_VS = [
    'attribute vec3 oOrb; attribute vec4 oAnim; attribute vec3 oCol; attribute float oFoc;',
    'uniform float uTime; uniform float uNow; uniform float uPx; uniform float uOrbitR;',
    'varying vec3 vCol; varying float vType; varying float vFrame; varying float vFog;',
    'void main(){',
    '  float phi = oOrb.y + oOrb.x * uTime;',
    '  vec3 p = position + uOrbitR * vec3(cos(phi), 0.28 * sin(phi + oOrb.z), sin(phi));',
    '  vec4 mv = modelViewMatrix * vec4(p, 1.0);',
    '  float age = uNow - oAnim.y, fr = -1.0;',
    '  if (oAnim.x < 0.5) { float a = mod(age, 12.0); fr = a >= 0.0 ? floor(a * 16.0) : -1.0; if (fr > 31.0) fr = -1.0; }',
    '  else if (oAnim.x < 1.5) { fr = age >= 0.0 ? floor(age * 10.0) : -1.0; if (fr > 15.0) fr = -1.0; }',
    '  else { fr = floor(fract((uNow + oAnim.y) / max(0.5, oAnim.w)) * 16.0); }',
    '  vFrame = fr; vType = oAnim.x; vCol = oCol * oFoc * oFoc; vFog = -mv.z;',
    '  gl_PointSize = fr < 0.0 ? 0.0 : clamp(oAnim.z * uPx / max(1.0, -mv.z), 0.0, 1024.0);',
    '  gl_Position = fr < 0.0 ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * mv;',
    '}'].join('\n');
  var OVL_FS = [
    'uniform sampler2D tBirth; uniform sampler2D tDeath; uniform sampler2D tPulse; uniform float fogDensity;',
    'varying vec3 vCol; varying float vType; varying float vFrame; varying float vFog;',
    'vec4 cellOf(sampler2D t, float cols, float rows, float f, vec2 pc){',
    '  float c = mod(f, cols), r = floor(f / cols);',
    '  return texture2D(t, vec2((c + pc.x) / cols, 1.0 - (r + pc.y) / rows));',
    '}',
    'void main(){',
    '  vec2 pc = vec2(gl_PointCoord.x, gl_PointCoord.y);',
    '  vec4 t = vType < 0.5 ? cellOf(tBirth, 8.0, 4.0, vFrame, pc) : vType < 1.5 ? cellOf(tDeath, 4.0, 4.0, vFrame, pc) : cellOf(tPulse, 4.0, 4.0, vFrame, pc);',
    '  vec3 rgb = t.rgb * vCol * t.a * (vType > 1.5 ? 0.55 : 1.0);',
    '  float f = 1.0 - exp(-fogDensity * fogDensity * vFog * vFog);',
    '  rgb *= 1.0 - clamp(f, 0.0, 0.85);',
    '  if (rgb.r + rgb.g + rgb.b < 0.004) discard;',
    '  gl_FragColor = vec4(rgb, 1.0);',
    '}'].join('\n');
  var ANIM = { tex: null, ready: false };
  function loadAnims(man) {
    var A = man && man.anims; if (!A || !A.birth) return;
    var t = new THREE.TextureLoader().load('/static/assets/universe/' + A.birth.file, function () {
      ANIM.tex = { birth: t, death: t, pulse: t }; ANIM.ready = true; G.ovlKey = ''; buildOverlay(); queueWarm();
    });
    t.generateMipmaps = false; t.minFilter = THREE.LinearFilter;
    ANIM.scale = { birth: A.birth.scale || 3 };
  }
  function buildOverlay() {
    if (!ANIM.ready || !G.pts) return;
    var list = [], nowS = Date.now() / 1000;
    for (var i = 0; i < G.n; i++) {
      var it = U.insts[i], b = it.b, st = it.st || {}, mc = mcls(it.cls);
      if (b['new'] && b.first_seen && nowS - b.first_seen < M.BIRTH_S) list.push([i, 0, b.first_seen - G.epoch, ANIM.scale.birth]);
      /* death collapse + pulse flipbooks retired with the sprites: a 3D body
         dims / desaturates in place (bodies3d) and breathes its own glow */
      void mc; void st;
    }
    var key = list.map(function (q) { return q.join(','); }).join('|');
    if (key === G.ovlKey && G.ovl) return;
    G.ovlKey = key; G.ovlList = list;
    if (!G.ovl) {
      var fog = NS.scene.fog;
      G.ovl = new THREE.Points(new THREE.BufferGeometry(), new THREE.ShaderMaterial({
        uniforms: { tBirth: { value: ANIM.tex.birth }, tDeath: { value: ANIM.tex.death }, tPulse: { value: ANIM.tex.pulse },
                    uTime: G.mat.uniforms.uTime, uNow: G.mat.uniforms.uNow, uPx: G.mat.uniforms.uPx, uOrbitR: G.mat.uniforms.uOrbitR,
                    fogDensity: { value: fog && fog.density !== undefined ? fog.density : 0.0006 } },
        vertexShader: OVL_VS, fragmentShader: OVL_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      G.ovl.frustumCulled = false; G.ovl.renderOrder = 3; G.ovl.userData.universe = true;
      NS.scene.add(G.ovl);
    }
    var n = Math.max(1, list.length), g = G.ovl.geometry;
    var P = new Float32Array(n * 3), O = new Float32Array(n * 3), A = new Float32Array(n * 4), C = new Float32Array(n * 3);
    for (var j = 0; j < list.length; j++) {
      var q = list[j], k = q[0], sz = G.aA[k * 4 + 1] * 0.5;   // sized to the 3D body, not the old sprite quad
      O[j * 3] = G.aB[k * 4]; O[j * 3 + 1] = G.aB[k * 4 + 1]; O[j * 3 + 2] = G.aA[k * 4 + 3];
      A[j * 4] = q[1]; A[j * 4 + 1] = q[2]; A[j * 4 + 2] = sz * q[3]; A[j * 4 + 3] = q[4] || 0;
      /* tint: class accent (manifest), birth a cool green-white, death the body colour */
      C[j * 3] = G.col[k * 3]; C[j * 3 + 1] = G.col[k * 3 + 1]; C[j * 3 + 2] = G.col[k * 3 + 2];
      if (q[1] === 0) { C[j * 3] = 0.6; C[j * 3 + 1] = 1.0; C[j * 3 + 2] = 0.82; }
    }
    g.setAttribute('position', new THREE.BufferAttribute(P, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('oOrb', new THREE.BufferAttribute(O, 3));
    g.setAttribute('oAnim', new THREE.BufferAttribute(A, 4));
    g.setAttribute('oCol', new THREE.BufferAttribute(C, 3));
    g.setAttribute('oFoc', new THREE.BufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, list.length);
    syncOverlayPos();
  }
  function syncOverlayPos() {
    if (!G.ovl || !G.ovlList) return;
    var P = G.ovl.geometry.attributes.position.array, F = G.ovl.geometry.attributes.oFoc.array;
    for (var j = 0; j < G.ovlList.length; j++) {
      var k = G.ovlList[j][0];
      P[j * 3] = G.pos[k * 3]; P[j * 3 + 1] = G.pos[k * 3 + 1]; P[j * 3 + 2] = G.pos[k * 3 + 2];
      F[j] = G.foc[k];               // a flare dims with its body's tour focus
    }
    G.ovl.geometry.attributes.position.needsUpdate = true;
    G.ovl.geometry.attributes.oFoc.needsUpdate = true;
  }

  function focusTarget(it) {
    /* netscene's crossfade (same leg, same progress, same floor) */
    if (NS.focusOf) return it.node ? NS.focusOf(it.node.id, 'u:' + it.b.id) : NS.focusOf('u:' + it.b.id);
    if (NS.focusAll !== false || !NS.focusIds) return 1;
    var ids = NS.focusIds;
    if (it.node && ids[it.node.id]) return 1;
    if (ids['u:' + it.b.id]) return 1;
    return FOC_FLOOR;
  }

  var _wp = { x: 0, y: 0, z: 0 };
  function targetPos(it) {
    if (it.node) { _wp.x = it.node._cx; _wp.y = it.node._cy; _wp.z = it.node._cz; return _wp; }
    var o = U.offs[it.b.id] || ZERO, h = it.hub;
    _wp.x = h._cx + o.x; _wp.y = h._cy + o.y; _wp.z = h._cz + o.z; return _wp;
  }
  function writePositions(alpha) {
    var P = G.pos, mv = 0;
    for (var i = 0; i < G.n; i++) {
      var p = targetPos(U.insts[i]), o = i * 3;
      if (alpha >= 1) { P[o] = p.x; P[o + 1] = p.y; P[o + 2] = p.z; continue; }
      var dx = p.x - P[o], dy = p.y - P[o + 1], dz = p.z - P[o + 2];
      if (dx * dx + dy * dy + dz * dz > 0.0004) mv++;
      P[o] += dx * alpha; P[o + 1] += dy * alpha; P[o + 2] += dz * alpha;
    }
    if (G.b3d && G.b3d.positions.length >= G.n * 3) { G.b3d.positions.set(P.subarray(0, G.n * 3)); G.b3d.markPositions(); }
    writeLights();                     // the stars move with their hubs
    return mv;
  }

  /* orbit rings + system glow discs (positions follow the hub) */
  function buildRings() {
    var info = [], dinfo = [], SEG = 96;
    (U.active ? U.systems : []).forEach(function (s) {
      var hub = NS.byId[s.anchor]; if (!hub) return;
      var g = U.geom[s.id] || {};
      var acc = new THREE.Color(s.accent || '#5ad7ff');
      Object.keys(g).forEach(function (k) {
        if (+k === 0) return;
        var r = (g[k].r0 + g[k].r1) / 2 * (s._k || SCALE);
        info.push({ hub: hub, r: r, c: acc, sys: s });
      });
      dinfo.push({ hub: hub, R: s.R, c: acc, sys: s });
    });
    G.ringInfo = info; G.discInfo = dinfo;
    buildDiscMeshes(dinfo);
    if (bakeOn()) { buildGalaxies(dinfo); buildStarfields(dinfo); }
    else buildArms(dinfo);
    var nv = info.length * SEG * 2;
    var rg = G.rings.geometry;
    rg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(Math.max(6, nv * 3)), 3).setUsage(THREE.DynamicDrawUsage));
    rg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(Math.max(6, nv * 3)), 3).setUsage(THREE.DynamicDrawUsage));
    rg.setDrawRange(0, nv);
    G.ringSeg = SEG;
    var dg = G.discs.geometry, nd = dinfo.length;
    dg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(Math.max(3, nd * 4 * 3)), 3).setUsage(THREE.DynamicDrawUsage));
    dg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(Math.max(3, nd * 4 * 3)), 3).setUsage(THREE.DynamicDrawUsage));
    var uv = new Float32Array(Math.max(2, nd * 8)), ix = [];
    for (var d = 0; d < nd; d++) {
      uv.set([0, 0, 1, 0, 1, 1, 0, 1], d * 8);
      ix.push(d * 4, d * 4 + 1, d * 4 + 2, d * 4, d * 4 + 2, d * 4 + 3);
    }
    dg.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    dg.setIndex(ix);
    updateRings(true);
  }
  /* ---------------- photographic galaxies (2026-10-08, contracts 8) ----------------
     Every system is a real-looking galaxy: one GPU-baked plate per system
     (static/galaxy_bake.js: bulge + nucleus, spiral arms wound to the sectors'
     own twist, dust lanes, HII knots, young clusters, outer haze), coloured by
     the categories of the guests that sit in each part of the disc (a Proxmox
     host) or by the system accent (core, home, sites). It reaches past the
     bodies' orbits (HAZE x R) into the space between galaxies, so the overview
     reads full. Plus a resolved starfield along the same arms (one Points draw
     per system, a photographic PSF) for depth and sparkle. Re-baked only when a
     system's spec changes (cached), drawn as one additive quad per system. */
  var HAZE = { pvehost: 1.9, k8s: 1.9, network: 1.55, clients: 1.65, site: 1.7 };
  var GAL_RGB = { ai: [1.0, 0.36, 0.66], media: [0.30, 0.86, 1.0], network: [0.32, 1.0, 0.66], monitor: [1.0, 0.70, 0.30],
                  web: [0.62, 0.55, 1.0], infra: [0.56, 0.74, 0.98] };
  var GAL_K = 1.0, GAL_STARS_K = 0.9;   // plate / starfield gain (HDR, before the page's exposure)
  var G2_K = 1.0;                       // asset plates: opacity 1.0 = the owner's calibration (raw values)
  function bakeOn() { return !!(window.NB_GALAXY && window.NB_HDR && Q.gal !== 'off'); }
  function galSpec(D) {
    var s = D.sys, grp = (U.groups && U.groups[s.id]) || [];
    var sec = grp.filter(function (q) { return q.kind === 'sector'; }), rings = grp.filter(function (q) { return q.kind === 'ring'; });
    var Rh = D.R * (HAZE[s.kind] || 1.7);
    var acc = new THREE.Color(s.accent || '#8fb0d0');
    var spec = { size: (s.kind === 'pvehost' || s.kind === 'k8s') && D.R > 150 ? 2048 : 1024, seed: (s.seed >>> 0) || 7, accent: [acc.r, acc.g, acc.b],
                 bright: 1, core: 7, hii: 1, dust: 0.85, haze: 1, tilt: ((((s.seed >>> 0) || 7) % 628) / 100) };
    if (sec.length) {
      spec.kind = 'spiral';
      spec.rIn = sec[0].rIn / Rh; spec.rOut = sec[0].rOut / Rh; spec.twist = sec[0].twist || 1.35;
      spec.arms = sec.length >= 4 ? 2 : 3; spec.armW = 0.42; spec.bulge = 0.075;
      spec.sectors = sec.map(function (q) { return { a0: q.a0, a1: q.a1, col: GAL_RGB[q.key] || GAL_RGB.infra }; });
    } else {
      var r0 = 1e9, r1 = 0;
      rings.forEach(function (q) { r0 = Math.min(r0, q.rIn); r1 = Math.max(r1, q.rOut); });
      if (!rings.length) { r0 = D.R * 0.25; r1 = D.R; }
      spec.kind = s.kind === 'site' ? 'dwarf' : 'ringed';
      spec.rIn = Math.max(0.06, r0 / Rh); spec.rOut = Math.min(0.95, r1 / Rh); spec.twist = s.kind === 'site' ? 2.6 : 2.1;
      spec.arms = 2; spec.armW = s.kind === 'site' ? 0.55 : 0.40; spec.bulge = s.kind === 'site' ? 0.06 : 0.07;
      spec.core = s.kind === 'site' ? 4 : 5.5; spec.hii = s.kind === 'site' ? 0.8 : 0.9;
      spec.rings = rings.slice(0, 6).map(function (q) { return Math.round(((q.rIn + q.rOut) / 2 / Rh) * 1000) / 1000; });
      /* a few faint rings only: the class orbits as stellar rings, not a bullseye */
      if (spec.rings.length > 3) spec.rings = [spec.rings[0], spec.rings[Math.floor(spec.rings.length / 2)], spec.rings[spec.rings.length - 1]];
    }
    spec.rIn = Math.round(spec.rIn * 1000) / 1000; spec.rOut = Math.round(spec.rOut * 1000) / 1000;
    return { spec: spec, Rh: Rh };
  }
  /* ---------------- the asset plates (galaxy2, 2026-10-08) ----------------
     Hubble-like Blender plates (static/assets/galaxy2/manifest.json): a golden-bulge
     spiral with teal-green arms, a blue-white spiral, the core
     (violet barred), and a pool of two for NEW Proxmox nodes (by system seed % 2). They
     replace the bake wherever the manifest has one; the other systems (home, the sites)
     keep their baked plate. The asset owner's rules: RAW sampling (no sRGB decode), WHITE
     tint, straight alpha (rgb * a = the light), additive, spin counter-clockwise as the
     image is viewed, galaxy radius 0.94 of the half-width; the golden plate's edge-on
     variant cross-fades in when its disc is within ~20 deg of edge-on. */
  var G2 = { base: '/static/assets/galaxy2/', man: null, tex: {}, ok: {}, done: false, pending: 0 };
  var G2_SPIN = 0.0035;                 // rad/s: one turn in ~30 min, alive but calm
  var G2_FS = [
    'uniform sampler2D map; uniform float uK; uniform vec2 uNear;',
    'varying vec2 vUv; varying float vDepth;',
    'void main(){ vec4 t = texture2D(map, vUv);',
    '  vec3 c = t.rgb * t.a * uK * smoothstep(uNear.x, uNear.y, vDepth);',
    '  if (c.r + c.g + c.b < 0.0004) discard; gl_FragColor = vec4(c, 1.0); }'].join('\n');
  var G2_VS = 'varying vec2 vUv; varying float vDepth; void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vDepth = -mv.z; gl_Position = projectionMatrix * mv; }';
  function g2Load() {
    fetch(G2.base + 'manifest.json', { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error('no galaxy2'); return r.json(); })
      .then(function (m) { G2.man = m; G2.done = true; if (NS && NS.graph && U.active) rebuildInstances(); })
      ['catch'](function () { G2.done = true; });
  }
  function g2Tex(file) {
    if (G2.tex[file]) return G2.tex[file];
    G2.pending++;
    /* a plate drawn before its 2 MB texture arrives is black (2026-10-09 rehearsal:
       a host stop went near-black ~1 min after load): buildGalaxies draws the
       baked plate until G2.ok[file], then this swaps the asset in (crossfade) */
    var t = new THREE.TextureLoader().load(G2.base + file, function onG2() {
      if (+Q.g2delay > 0 && !G2['dl' + file]) { G2['dl' + file] = 1; setTimeout(onG2, +Q.g2delay); return; }   // QA: a slow texture
      G2.pending--; G2.ok[file] = true; queueWarm();
      if (G.discInfo && NS && NS.graph && U.active && !G2.swapQ) {
        G2.swapQ = setTimeout(function () { G2.swapQ = null; try { buildGalaxies(G.discInfo); buildStarfields(G.discInfo); updateRings(true); } catch (e) { console.warn("galaxy swap failed", e); } }, 50);
      }
    }, undefined, function () { G2.pending--; G2.failed = (G2.failed || 0) + 1; });
    t.encoding = THREE.LinearEncoding;                        // raw: the plates are display-referred for this pipeline
    t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
    t.anisotropy = NS.rndr.capabilities.getMaxAnisotropy ? Math.min(4, NS.rndr.capabilities.getMaxAnisotropy()) : 1;
    G2.tex[file] = t;
    return t;
  }
  function g2File(sys) {
    var d = G2.man && G2.man.discs;
    if (!d || Q.g2 === 'off') return null;
    if (d[sys.id] && d[sys.id].file) return d[sys.id].file;
    /* then by role: node:<index in CONFIG.nodes> / site:<index in CONFIG.sites> */
    var Cf = window.CONFIG || {}, k = null;
    if (sys.kind === 'pvehost' && Cf.nodeFromSys && Cf.nodeIndex) { var nid = Cf.nodeFromSys(sys.id); if (nid) k = 'node:' + Cf.nodeIndex(nid); }
    else if (sys.kind === 'site' && Cf.siteIndex && Cf.siteIndex(sys.id) >= 0) k = 'site:' + Cf.siteIndex(sys.id);
    if (k && d[k] && d[k].file) return d[k].file;
    if ((sys.kind === 'pvehost' || sys.kind === 'k8s') && d.pve_pool && d.pve_pool.length) return d.pve_pool[((sys.seed >>> 0) || 0) % d.pve_pool.length];
    return null;
  }
  function g2Material(tex) {
    return new THREE.ShaderMaterial({
      uniforms: { map: { value: tex }, uK: { value: 1 }, uNear: { value: new THREE.Vector2(40, 220) } },
      vertexShader: G2_VS, fragmentShader: G2_FS, transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor
    });
  }
  /* the visible disc of an asset plate reaches 1.6 R (the bodies' orbits fill R), i.e.
     a quad 2 * 1.6 R / 0.94 wide; a baked plate keeps its own haze radius */
  var G2_REACH = 1.6;
  function buildGalaxies(dinfo) {
    var old = G.gals || [], bySys = {};
    old.forEach(function (g) { bySys[g.D.sys.id] = g; });
    G.gals = []; G.galsOld = G.galsOld || [];
    dinfo.forEach(function (D) {
      var file = g2File(D.sys), tex, m, Rh, edge = null;
      if (file && !G2.ok[file]) { g2Tex(file); file = null; }      // still loading: the bake stands in
      if (file) {
        var rad = (G2.man.galaxies && Object.keys(G2.man.galaxies).map(function (k) { return G2.man.galaxies[k]; })
                   .filter(function (g) { return g.file === file; })[0] || {}).radius || 0.94;
        tex = g2Tex(file); Rh = D.R * G2_REACH / rad;
        m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), g2Material(tex));
        /* the edge-on variant of the same galaxy (whichever system wears that plate) */
        var V = G2.man.variants || {};
        Object.keys(V).forEach(function (k) {
          var v = V[k]; if (!v || !v.file) return;
          var of = G2.man.galaxies && G2.man.galaxies[v.of];
          if (of ? of.file !== file : v.file.replace('_edgeon', '') !== file) return;
          if (!G2.ok[v.file]) { g2Tex(v.file); return; }            // joins on its own load
          var em = new THREE.Mesh(new THREE.PlaneGeometry(1, 1 / (v.aspect || 4)), g2Material(g2Tex(v.file)));
          em.renderOrder = -4; em.frustumCulled = false; em.userData.universe = true; em.userData.bg = true; em.visible = false;
          em.scale.set(2 * Rh, 2 * Rh, 1);
          NS.scene.add(em); edge = em;
        });
      } else {
        var gs = galSpec(D);
        try { tex = window.NB_GALAXY.bake(NS.rndr, gs.spec); } catch (e) { console.warn('galaxy bake failed', e); return; }
        m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), window.NB_GALAXY.discMaterial(tex));
        Rh = gs.Rh;
      }
      m.rotation.x = -Math.PI / 2; m.renderOrder = -4; m.frustumCulled = false; m.userData.universe = true; m.userData.bg = true;
      m.scale.set(2 * Rh, 2 * Rh, 1);
      NS.scene.add(m);
      D.gal = m; D.arms = true; D.asset = !!file;
      /* the same plate as before (cached spec / same asset): it carries straight on; a
         changed plate (a category crossed a size step) or a new galaxy (growth) fades in
         over ~1.5 s while the old one fades out - never a pop */
      var prev = bySys[D.sys.id], same = prev && prev.tex === tex;
      G.gals.push({ mesh: m, edge: edge, D: D, tex: tex, Rh: Rh, asset: !!file, ph: ((D.sys.seed >>> 0) % 628) / 100,
                    fade: same ? (prev.fade != null ? prev.fade : 1) : (U.galsSeen ? 0 : 1) });
    });
    old.forEach(function (g) {
      var still = G.gals.some(function (n) { return n.D.sys.id === g.D.sys.id && n.tex === g.tex; });
      if (still || !U.galsSeen) { disposeGal(g); return; }
      g.out = true; G.galsOld.push(g);                 // fades out in tick(), then goes
    });
    U.galsSeen = true;
  }
  function disposeGal(g) {
    NS.scene.remove(g.mesh); g.mesh.geometry.dispose(); g.mesh.material.dispose();
    if (g.edge) { NS.scene.remove(g.edge); g.edge.geometry.dispose(); g.edge.material.dispose(); }
    if (!g.asset) window.NB_GALAXY.release(g.tex);       // asset textures stay cached
  }
  /* per frame: the asset plates spin (counter-clockwise as the image is viewed), and a
     plate seen within ~20 deg of edge-on hands over to its edge-on variant */
  var _gv = new THREE.Vector3();
  function galSpin(t) {
    var cam = NS.cam.position, GL = G.gals || [];
    for (var i = 0; i < GL.length; i++) {
      var g = GL[i]; if (!g.asset) continue;
      g.mesh.rotation.z = g.ph + G2_SPIN * t;
      g.ewPrev = g.edgeW || 0; g.edgeW = 0;
      if (g.edge) {
        _gv.set(cam.x - g.mesh.position.x, cam.y - g.mesh.position.y, cam.z - g.mesh.position.z);
        var L = _gv.length() || 1, el = Math.asin(Math.min(1, Math.abs(_gv.y) / L));
        var w = 1 - Math.min(1, Math.max(0, (el - 0.17) / (0.35 - 0.17)));     // 10 deg .. 20 deg
        w = w * w * (3 - 2 * w); g.edgeW = w;
        g.edge.visible = w > 0.002;
        if (g.edge.visible) {
          g.edge.position.copy(g.mesh.position);
          g.edge.rotation.set(0, Math.atan2(_gv.x, _gv.z), 0);                  // a cylindrical billboard: the major axis stays in the disc plane
        }
      }
    }
  }
  /* per frame, only while a plate is fading */
  function galFade(dt) {
    var k = dt / 1.5, busy = false, i;
    for (i = 0; i < (G.gals || []).length; i++) { var g = G.gals[i]; if (g.fade < 1) { g.fade = Math.min(1, g.fade + k); busy = true; } }
    for (i = (G.galsOld || []).length - 1; i >= 0; i--) {
      var o = G.galsOld[i]; o.fade = (o.fade != null ? o.fade : 1) - k; busy = true;
      if (o.fade <= 0) { disposeGal(o); G.galsOld.splice(i, 1); }
    }
    return busy;
  }
  /* a photographic point-spread for resolved stars: tight core, soft wing */
  var PSF = null;
  function psfTex() {
    if (PSF) return PSF;
    var s = 64, cv = document.createElement('canvas'); cv.width = cv.height = s;
    var x = cv.getContext('2d'), im = x.createImageData(s, s), d = im.data;
    for (var j = 0; j < s; j++) for (var i = 0; i < s; i++) {
      var u = (i + 0.5) / s * 2 - 1, v = (j + 0.5) / s * 2 - 1, q = u * u + v * v, o = (j * s + i) * 4;
      var a = q >= 1 ? 0 : Math.min(1, Math.exp(-q * 18) + 0.16 * Math.exp(-q * 4.2) + 0.03 * Math.exp(-Math.sqrt(q) * 3)) * (1 - q);
      d[o] = d[o + 1] = d[o + 2] = 255; d[o + 3] = Math.round(a * 255);
    }
    x.putImageData(im, 0, 0);
    PSF = new THREE.CanvasTexture(cv);
    return PSF;
  }
  function buildStarfields(dinfo) {
    (G.arms || []).forEach(function (A) { NS.scene.remove(A.pts); A.pts.geometry.dispose(); A.pts.material.dispose(); });
    G.arms = [];
    dinfo.forEach(function (D) {
      var gs = galSpec(D), sp = gs.spec, Rh = gs.Rh, rnd = mulberry(((D.sys.seed >>> 0) || 7) ^ 0x2f6b);
      /* star counts follow the disc's AREA (a small galaxy is not a dense knot) */
      var aK = Math.max(0.18, Math.min(1, (D.R * D.R) / (228 * 228)));
      var NA = Math.round(1500 * aK), NB = Math.round(520 * aK), n = NA + NB;
      /* an asset plate already carries its arms and their stars: only a sparse, unaligned
         sprinkle of 3D stars above and below it, for depth when the camera moves */
      if (D.asset) { NA = Math.round(260 * aK); NB = Math.round(160 * aK); n = NA + NB; }
      var P = new Float32Array(n * 3), C = new Float32Array(n * 3), Z = new Float32Array(n), c = new THREE.Color(), o = 0;
      var accT = new THREE.Color().fromArray(sp.accent);
      var rIn = sp.rIn * Rh, rOut = sp.rOut * Rh, m = sp.arms;
      function tintAt(th, r) {
        if (!sp.sectors) return accT;
        var t = (r - rIn) / Math.max(1, rOut - rIn), thu = th - sp.twist * Math.max(-0.3, Math.min(1.6, t)), best = null, bd = 1e9;
        sp.sectors.forEach(function (q) { var cc = (q.a0 + q.a1) / 2, d = Math.abs(((thu - cc) % TAU + TAU * 1.5) % TAU - Math.PI); if (d < bd) { bd = d; best = q; } });
        return best ? c.fromArray(best.col) : accT;
      }
      for (var i = 0; i < NA; i++) {
        /* along the plate's arm crests (same twist, same phase), gaussian across them */
        var u = Math.pow(rnd(), 0.85), r = rIn * 0.5 + (Math.min(Rh * 0.92, rOut * 1.55) - rIn * 0.5) * u;
        var t = (r - rIn) / Math.max(1, rOut - rIn), tw = sp.twist * (t < 0 ? t * 0.7 : t < 1 ? t : 1 + (t - 1) * 0.8);
        var arm = Math.floor(rnd() * m), g = (rnd() + rnd() + rnd() - 1.5) / 1.5;
        var th = D.asset ? rnd() * TAU : tw + sp.tilt + arm * TAU / m + g * 0.42 + (rnd() < 0.18 ? (rnd() - 0.5) * 2.4 : 0);
        P[o] = r * Math.cos(th); P[o + 1] = (rnd() - 0.5) * (D.asset ? 22 : 7) * (1 - 0.5 * u); P[o + 2] = r * Math.sin(th);
        var tc = tintAt(th, r), young = rnd() < 0.72;
        var cr = young ? 0.62 + (tc.r * 0.9 - 0.62) * 0.55 : 1.0, cg = young ? 0.78 + (tc.g * 0.9 - 0.78) * 0.55 : 0.86, cb = young ? 1.0 + (tc.b * 0.9 - 1.0) * 0.55 : 0.70;
        var k = (0.35 + 0.9 * Math.pow(rnd(), 3)) * (1 - 0.45 * Math.abs(g)) * (0.55 + 0.45 * (1 - u));
        C[o] = cr * k; C[o + 1] = cg * k; C[o + 2] = cb * k; Z[i] = 2.2 + 3.6 * Math.pow(rnd(), 2.5);
        o += 3;
      }
      for (var b = 0; b < NB; b++) {                                     // the bulge and the old disc
        var rb = Rh * (b < NB * 0.6 ? 0.16 * Math.pow(rnd(), 1.6) : 0.55 * Math.pow(rnd(), 1.2)), tb = rnd() * TAU;
        P[o] = rb * Math.cos(tb); P[o + 1] = (rnd() - 0.5) * 16 * Math.exp(-rb / (Rh * 0.12)); P[o + 2] = rb * Math.sin(tb);
        var kb = (0.45 + 0.7 * Math.pow(rnd(), 2)) * (b < NB * 0.6 ? 1.0 : 0.6);
        C[o] = 1.0 * kb; C[o + 1] = 0.84 * kb; C[o + 2] = 0.62 * kb; Z[NA + b] = 2.0 + 3.0 * Math.pow(rnd(), 2.5);
        o += 3;
      }
      var geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(P, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(C, 3));
      geo.setAttribute('aSize', new THREE.BufferAttribute(Z, 1));
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Rh);
      var mat = new THREE.ShaderMaterial({ uniforms: { uTex: { value: psfTex() }, uPx: G.mat.uniforms.uPx, uK: { value: 1 } },
        vertexShader: ARM_VS, fragmentShader: ARM_FS, transparent: true, depthWrite: false,
        blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
        blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor });
      var pts = new THREE.Points(geo, mat);
      pts.frustumCulled = false; pts.renderOrder = -3; pts.userData.universe = true;
      NS.scene.add(pts);
      G.arms.push({ pts: pts, D: D });
      D.arms = true;
    });
  }

  /* Galaxy structure for a PVE host (2026-10-07): the category arms made
     visible. Star dust follows the same arm curve the guests sit on, tinted a
     restrained version of the arm's category colour, plus a warm central bulge
     and a soft core glow - the galaxy reads as a galaxy, and its arms ARE the
     categories. Deterministic (seeded by the system), one Points draw per
     system, rebuilt only with the layout. Replaces the Blender disc art there:
     generic spiral art could never line up with the category arms. */
  var ARM_GREY = new THREE.Color('#8b9bb5');
  function mulberry(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  /* dust fades out within ~200 units of the lens and is capped at 28 px, so a
     camera passing through a galaxy never fills the frame with overdraw */
  var ARM_VS = [
    'attribute float aSize; attribute vec3 color; varying vec3 vCol; uniform float uPx; uniform float uK;',
    'void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); float z = max(1.0, -mv.z); vCol = color * uK * smoothstep(50.0, 210.0, z);',
    '  gl_PointSize = vCol.r + vCol.g + vCol.b < 0.002 ? 0.0 : clamp(aSize * uPx / z, 0.0, 28.0); gl_Position = projectionMatrix * mv; }'].join('\n');
  var ARM_FS = [
    'uniform sampler2D uTex; varying vec3 vCol;',
    'void main(){ float a = texture2D(uTex, gl_PointCoord).a; vec3 c = vCol * a; if (c.r + c.g + c.b < 0.003) discard; gl_FragColor = vec4(c, 1.0); }'].join('\n');
  function buildArms(dinfo) {
    (G.arms || []).forEach(function (A) { NS.scene.remove(A.pts); A.pts.geometry.dispose(); A.pts.material.dispose(); });
    G.arms = [];
    dinfo.forEach(function (D) {
      var grp = (U.groups && U.groups[D.sys.id]) || [], sec = grp.filter(function (q) { return q.kind === 'sector'; });
      if (!sec.length) { buildBands(D, grp.filter(function (q) { return q.kind === 'ring'; })); return; }
      var rnd = mulberry(D.sys.seed || 7), rIn = sec[0].rIn, rOut = sec[0].rOut, TW = sec[0].twist || 0;
      var NA = 1500, NB = 420, n = NA + NB, P = new Float32Array(n * 3), C = new Float32Array(n * 3), Z = new Float32Array(n);
      var tot = 0; sec.forEach(function (q) { tot += q.a1 - q.a0; });
      var c = new THREE.Color(), o = 0;
      for (var i = 0; i < NA; i++) {
        var pick = rnd() * tot, q = sec[0];
        for (var j = 0; j < sec.length; j++) { var w = sec[j].a1 - sec[j].a0; if (pick < w) { q = sec[j]; break; } pick -= w; }
        var u = rnd(), r = rIn * 0.45 + (rOut * 1.12 - rIn * 0.45) * Math.pow(u, 0.8);
        var mid = (q.a0 + q.a1) / 2, half = (q.a1 - q.a0) / 2;
        var g = (rnd() + rnd() + rnd() - 1.5) / 1.5;                   // ~gaussian across the arm
        var th = mid + g * half * 1.05 + TW * (r - rIn) / Math.max(1, rOut - rIn);
        P[o] = r * Math.cos(th); P[o + 1] = (rnd() - 0.5) * 6 * (1 - u * 0.5); P[o + 2] = r * Math.sin(th);
        c.set(GUEST_CAT[q.key] || GUEST_CAT.infra).lerp(ARM_GREY, 0.5);
        var k = (0.38 + 0.55 * rnd()) * (1 - 0.55 * Math.abs(g)) * (0.6 + 0.4 * (1 - u));
        C[o] = c.r * k; C[o + 1] = c.g * k; C[o + 2] = c.b * k; Z[i] = 3 + 5 * rnd() * rnd();
        o += 3;
      }
      for (var b = 0; b < NB; b++) {                                     // the warm bulge
        var rb = rIn * 0.95 * Math.pow(rnd(), 1.7), tb = rnd() * TAU;
        P[o] = rb * Math.cos(tb); P[o + 1] = (rnd() - 0.5) * 10 * (1 - rb / rIn); P[o + 2] = rb * Math.sin(tb);
        var kb = 0.35 + 0.5 * (1 - rb / rIn);
        C[o] = 1.0 * kb; C[o + 1] = 0.88 * kb; C[o + 2] = 0.70 * kb; Z[NA + b] = 3 + 4 * rnd();
        o += 3;
      }
      var geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(P, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(C, 3));
      geo.setAttribute('aSize', new THREE.BufferAttribute(Z, 1));
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), rOut * 1.3);
      var mat = new THREE.ShaderMaterial({ uniforms: { uTex: { value: G.glow }, uPx: G.mat.uniforms.uPx, uK: { value: 1 } },
        vertexShader: ARM_VS, fragmentShader: ARM_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
      var pts = new THREE.Points(geo, mat);
      pts.frustumCulled = false; pts.renderOrder = -3; pts.userData.universe = true;
      NS.scene.add(pts);
      G.arms.push({ pts: pts, D: D });
      D.arms = true;
    });
  }
  /* a star system (home, core, sites): faint dust lanes along each class
     orbit, in the system's accent pulled most of the way to neutral - the
     orbits read as a system's structure, not as a spiral that isn't there */
  function buildBands(D, rings) {
    if (!rings.length) return;
    var rnd = mulberry((D.sys.seed || 11) ^ 0x5bd1), tot = 0;
    rings.forEach(function (q) { tot += q.rOut * q.rOut - q.rIn * q.rIn; });
    var N = Math.min(900, Math.max(240, Math.round(tot / 60))), P = new Float32Array(N * 3), C = new Float32Array(N * 3), Z = new Float32Array(N);
    var col = new THREE.Color(D.sys.accent || '#8fb0d0').lerp(ARM_GREY, 0.72);
    for (var i = 0; i < N; i++) {
      var pick = rnd() * tot, q = rings[0];
      for (var j = 0; j < rings.length; j++) { var w = rings[j].rOut * rings[j].rOut - rings[j].rIn * rings[j].rIn; if (pick < w) { q = rings[j]; break; } pick -= w; }
      var mid = (q.rIn + q.rOut) / 2, half = Math.max(4, (q.rOut - q.rIn) / 2);
      var g = (rnd() + rnd() + rnd() - 1.5) / 1.5, r = mid + g * half, th = rnd() * TAU;
      P[i * 3] = r * Math.cos(th); P[i * 3 + 1] = (rnd() - 0.5) * 3; P[i * 3 + 2] = r * Math.sin(th);
      var k = (0.16 + 0.26 * rnd()) * (1 - 0.6 * Math.abs(g)) * (D.sys.kind === 'site' ? 1.35 : 1);
      C[i * 3] = col.r * k; C[i * 3 + 1] = col.g * k; C[i * 3 + 2] = col.b * k; Z[i] = 2.5 + 3.5 * rnd() * rnd();
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(P, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(C, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(Z, 1));
    var mat = new THREE.ShaderMaterial({ uniforms: { uTex: { value: G.glow }, uPx: G.mat.uniforms.uPx, uK: { value: 1 } },
      vertexShader: ARM_VS, fragmentShader: ARM_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    var pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false; pts.renderOrder = -3; pts.userData.universe = true;
    NS.scene.add(pts);
    G.arms.push({ pts: pts, D: D });
    D.arms = true;
  }
  /* Blender's per-system disc art (manifest.discs), one additive plane per
     system under its bodies; systems without art keep the procedural glow */
  var _discTex = {};
  function buildDiscMeshes(dinfo) {
    (G.discMeshes || []).forEach(function (m) { NS.scene.remove(m); m.geometry.dispose(); m.material.dispose(); });
    G.discMeshes = [];
    var man = U.manifest && U.manifest.discs;
    if (!man) return;
    dinfo.forEach(function (D) {
      var spec = man[D.sys.id];
      if (!spec) {          /* by role: node:<index> / site:<index>, from CONFIG */
        var Cf = window.CONFIG || {}, nid = Cf.nodeFromSys ? Cf.nodeFromSys(D.sys.id) : null;
        if (D.sys.kind === 'pvehost' && nid && Cf.nodeIndex) spec = man['node:' + Cf.nodeIndex(nid)];
        else if (D.sys.kind === 'site' && Cf.siteIndex && Cf.siteIndex(D.sys.id) >= 0) spec = man['site:' + Cf.siteIndex(D.sys.id)];
      }
      if (!spec || !spec.file) { D.mesh = null; return; }
      var url = '/static/assets/universe/' + spec.file;
      var tex = _discTex[url] || (_discTex[url] = new THREE.TextureLoader().load(url));
      var m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
        map: tex, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
        color: new THREE.Color(D.sys.accent || spec.accent || '#ffffff').lerp(new THREE.Color('#7d8aa0'), 0.55), side: THREE.DoubleSide }));
      m.rotation.x = -Math.PI / 2; m.renderOrder = -4; m.frustumCulled = false; m.userData.universe = true;
      m.userData.size = (spec.size || 2) * 0.62;
      D.mesh = m; G.discMeshes.push(m); NS.scene.add(m);
    });
  }
  function hubFoc(h) { return h && h._foc !== undefined ? h._foc : 1; }
  /* 1 at the overview, 0 at a close-up, crossfaded across a leg */
  function overK() { return NS.overK !== undefined ? NS.overK : (NS.focusAll !== false ? 1 : 0); }
  function updateRings() {
    var SEG = G.ringSeg || 96, P = G.rings.geometry.attributes.position.array, C = G.rings.geometry.attributes.color.array, o = 0;
    var ringK = bakeOn() ? 0.035 : 0.10;      // photo look: orbit paths very faint (contracts 8)
    for (var i = 0; i < G.ringInfo.length; i++) {
      var R = G.ringInfo[i], h = R.hub, f = ringK * Math.max(0.25, hubFoc(h));
      for (var s = 0; s < SEG; s++) {
        var a0 = s / SEG * TAU, a1 = (s + 1) / SEG * TAU;
        P[o] = h._cx + R.r * Math.cos(a0); P[o + 1] = h._cy - 2; P[o + 2] = h._cz + R.r * Math.sin(a0);
        P[o + 3] = h._cx + R.r * Math.cos(a1); P[o + 4] = h._cy - 2; P[o + 5] = h._cz + R.r * Math.sin(a1);
        C[o] = C[o + 3] = R.c.r * f; C[o + 1] = C[o + 4] = R.c.g * f; C[o + 2] = C[o + 5] = R.c.b * f;
        o += 6;
      }
    }
    G.rings.geometry.attributes.position.needsUpdate = true; G.rings.geometry.attributes.color.needsUpdate = true;
    var DP = G.discs.geometry.attributes.position.array, DC = G.discs.geometry.attributes.color.array;
    for (var d = 0; d < G.discInfo.length; d++) {
      var D = G.discInfo[d], hd = D.hub, r = D.R * 1.18, k = d * 12, fd = 0.16 * Math.max(0.3, hubFoc(hd)), y = hd._cy - 4;
      if (D.mesh) {                       // art disc: place it, and zero the procedural quad
        var sz = D.R * 2 * D.mesh.userData.size;
        if (D.arms) { D.mesh.visible = false; }
        D.mesh.position.set(hd._cx, y - 1, hd._cz); D.mesh.scale.set(sz, sz, 1);
        /* muted (2026-10-07): the disc art is a backdrop, not a subject - it was a
           saturated yellow-green wash behind every host stop */
        D.mesh.material.opacity = (0.13 + 0.09 * overK()) * Math.max(0.3, hubFoc(hd));
        fd = 0;
      }
      if (D.arms) {                                  // soft core glow: a galaxy's bulge, or a star's zodiacal light
        var pv = (D.sys.kind === 'pvehost' || D.sys.kind === 'k8s');
        r = D.R * (pv ? 0.62 : 0.30); fd = (pv ? 0.20 : D.sys.kind === 'site' ? 0.2 : 0.12) * Math.max(0.3, hubFoc(hd));
      }
      if (D.gal) fd = 0;                             // the baked plate carries the bulge glow
      DP[k] = hd._cx - r; DP[k + 1] = y; DP[k + 2] = hd._cz - r;
      DP[k + 3] = hd._cx + r; DP[k + 4] = y; DP[k + 5] = hd._cz - r;
      DP[k + 6] = hd._cx + r; DP[k + 7] = y; DP[k + 8] = hd._cz + r;
      DP[k + 9] = hd._cx - r; DP[k + 10] = y; DP[k + 11] = hd._cz + r;
      for (var v = 0; v < 4; v++) { DC[k + v * 3] = D.c.r * fd; DC[k + v * 3 + 1] = D.c.g * fd; DC[k + v * 3 + 2] = D.c.b * fd; }
    }
    G.discs.geometry.attributes.position.needsUpdate = true; G.discs.geometry.attributes.color.needsUpdate = true;
    for (var ai = 0; ai < (G.arms || []).length; ai++) {
      var A = G.arms[ai], ha = A.D.hub;
      A.pts.position.set(ha._cx, ha._cy - 3, ha._cz);
      A.pts.material.uniforms.uK.value = (0.88 + 0.12 * overK()) * Math.max(0.35, hubFoc(ha)) * (A.D.gal ? GAL_STARS_K : 1);
    }
    /* the baked plates: the galaxies stay the hero even off-subject (a dimmed
       galaxy is still a galaxy); the subject's plate comes up a little */
    var GL = (G.gals || []).concat(G.galsOld || []);
    for (var gi = 0; gi < GL.length; gi++) {
      var GG = GL[gi], hg = GG.D.hub, fg = hubFoc(hg), ff = GG.fade != null ? GG.fade : 1;
      GG.mesh.position.set(hg._cx, hg._cy - 3.5, hg._cz);
      /* asset plates: opacity 1.0 in focus, ~0.6 behind the subject (the asset owner's
         exposure); baked plates as before */
      var kf = GG.asset ? (0.58 + 0.42 * Math.max(0, Math.min(1, fg))) : (0.62 + 0.38 * Math.max(0, Math.min(1, fg))) * (1 + 0.08 * (1 - overK()) * fg);
      var kk = (GG.asset ? G2_K : GAL_K) * kf * ff * ff * (3 - 2 * ff), ew = GG.edgeW || 0;
      GG.mesh.material.uniforms.uK.value = kk * (1 - ew);
      if (GG.edge) { GG.edge.material.uniforms.uK.value = kk * ew; GG.edge.position.copy(GG.mesh.position); }
    }
  }

  /* labels for bodies with no topology node: an atlas of names + stubs that
     netscene's labelPass judges exactly like its own sprites */
  function buildLabels() {
    /* names for bodies with no topology node, as stubs in netscene's single
       collision pass; netscene paints them with every other label (2D text,
       section 7: short names, one line, no IPs) */
    if (G.labels.length) {
      NS.labels = NS.labels.filter(function (l) { return !l.userData.uStub; });
    }
    G.labels = [];
    var IP_ONLY = /^\d{1,3}(\.\d{1,3}){3}$/;
    var items = U.insts.filter(function (it) {
      if (it.node) return false;
      var b = it.b, lb = String(b.label || '');
      /* named devices, new ones and down ones get a name; IP-only / unknown
         class bodies only while new */
      if (!lb || IP_ONLY.test(lb) || b['class'] === 'unknown') return !!b['new'] && !!(NS.shortName ? NS.shortName(lb, b) : lb);
      return true;
    });
    if (G.lbl) { NS.scene.remove(G.lbl); G.lbl.geometry.dispose(); G.lbl.material.dispose(); G.lbl = null; }
    var INK = NS.STATUS_INK || {};
    for (var i = 0; i < items.length; i++) {
      var it = items[i], b = it.b;
      var txt = NS.shortName ? NS.shortName(b.label || b.id, b) : String(b.label || b.id);
      if (!txt) continue;
      var pseudo = { id: 'u:' + b.id, kind: 'client', _foc: 1 };
      var stub = {
        isStub: true, uuid: 'ulbl:' + b.id, visible: false,
        position: new THREE.Vector3(), scale: new THREE.Vector3(1, 1, 1),
        material: { opacity: 0 },
        userData: { uStub: true, l2d: 'leaf', fade: LABEL_FADE, focN: pseudo, txt: txt, idx: i, inst: it, badge: b.lab ? 'LAB' : null,
                    col: b.status === 'down' ? (b.down_why === 'stopped' || b.down_why === 'gone' ? '#7d8693' : INK.down) : b['new'] ? INK.fresh : null },
        getWorldPosition: function (v) { return v.copy(this.position); }
      };
      G.labels.push(stub);
      NS.labels.push(stub);
    }
    syncLabelStubs();
  }
  function syncLabelStubs() {
    for (var i = 0; i < G.labels.length; i++) {
      var s = G.labels[i], k = s.userData.inst.k;
      var o = k * 3;
      s.position.set(G.pos[o], G.pos[o + 1] + 17, G.pos[o + 2]);
      s.userData.focN._foc = k >= 0 ? G.foc[k] : 1;
    }
  }
  function afterLabels() { }          // the stubs are painted by netscene directly

  /* glows for the instanced bodies, from the celestial manifest (one Points
     draw per glow texture, sized and tinted per the manifest's notes):
       corona/halo  soft light around the instanced stars (switch hubs, APs,
                    the edge) - 2r/limb wide, the star's glow_tint
       pulsar       slow twin beams on every switch hub (third-party, SNMP,
                    inferred) - ~9r wide, each turning at its own phase
       beacon       a slow-blinking point light just off a camera's limb,
                    never under 24 px (the cameras are small bodies)
     They ride the slot centre (the epicycle is a few units). Down -> faint. */
  var GLOW_VS = [
    'attribute float aSize; attribute vec3 color; attribute vec3 aMot;',   // aMot: rot phase, spin rad/s, blink (0/1)
    'uniform float uPx; uniform float uTime; uniform float uMinPx; uniform vec3 uLodF;',
    'varying vec3 vCol; varying float vRot;',
    'void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); float z = max(1.0, -mv.z);',
    '  float s = aSize * uPx / z; if (aMot.z > 0.5) s = max(s, uMinPx);',
    '  float bl = aMot.z > 0.5 ? 0.55 + 0.45 * sin(uTime * 1.2 + aMot.x * 7.0) : 1.0;',
    '  vCol = color * bl * smoothstep(40.0, 160.0, z); vRot = aMot.x + aMot.y * uTime;',
    /* photo look: a glow belongs to a RESOLVED star (body radius in px = s * uLodF.x);
       far away the body is a point of light from bodies3d's star layer instead */
    '  if (uLodF.x > 0.0) vCol *= smoothstep(uLodF.y, uLodF.z, s * uLodF.x);',
    '  gl_PointSize = clamp(s, 0.0, 240.0); gl_Position = projectionMatrix * mv; }'].join('\n');
  var GLOW_FS = [
    'uniform sampler2D uTex; varying vec3 vCol; varying float vRot;',
    'void main(){ vec2 p = gl_PointCoord - 0.5; float c = cos(vRot), s = sin(vRot);',
    '  vec2 q = vec2(c * p.x - s * p.y, s * p.x + c * p.y) + 0.5;',
    '  if (q.x < 0.0 || q.y < 0.0 || q.x > 1.0 || q.y > 1.0) discard;',
    '  vec3 col = vCol * texture2D(uTex, q).a; if (col.r + col.g + col.b < 0.003) discard; gl_FragColor = vec4(col, 1.0); }'].join('\n');
  var SG = { layers: {} };
  function buildStarGlows() {
    if (!G.b3d.celInfo) return;
    Object.keys(SG.layers).forEach(function (k) { var L = SG.layers[k]; NS.scene.remove(L.pts); L.pts.geometry.dispose(); L.pts.material.dispose(); });
    SG.layers = {};
    var want = { corona: [], pulsar: [], beacon: [] };
    var photo = !!G.b3d.photo;
    for (var i = 0; i < G.n; i++) {
      var it = U.insts[i], inf = G.b3d.celInfo(it.cls), r = it.size * R3D;
      if (!inf.glow) continue;
      var down = it.b.status === 'down', a = down ? 0.05 : 1, ph = ((it.b.seed >>> 5) % 628) / 100;
      if (photo) {
        /* photo look: a star is a photosphere + corona (bright at the limb, HDR,
           so its inner part blooms); far away it is the LOD star with spikes.
           No pulsar beams. A camera keeps a faint, slow beacon. */
        if (inf.glow === 'beacon') want.beacon.push({ i: i, size: 3.2 * r * PHOTO_R, rgb: inf.rgb, a: 0.5 * a, mot: [ph, 0, 1], dy: 1.35 * r * PHOTO_R });
        continue;                       // a small star's light is its PSF (bodies3d star layer), at every distance
      }
      if (inf.glow === 'pulsar' || (it.b.hub && inf.star)) {
        want.pulsar.push({ i: i, size: 9 * r, rgb: inf.rgb, a: 0.22 * a, mot: [ph, 0.16 * ((it.b.seed & 1) ? 1 : -1), 0], dy: 0 });
        want.corona.push({ i: i, size: 2 * r / 0.25 * 0.4, rgb: inf.rgb, a: 0.30 * a, mot: [0, 0, 0], dy: 0 });
      } else if (inf.glow === 'beacon') {
        want.beacon.push({ i: i, size: 4 * r, rgb: inf.rgb, a: 0.8 * a, mot: [ph, 0, 1], dy: 1.35 * r });
      } else if (inf.star) {
        var lb = inf.limb || 0.4;
        want.corona.push({ i: i, size: 2 * r / lb * 0.8, rgb: inf.rgb, a: 0.32 * a, mot: [0, 0, 0], dy: 0 });
      }
    }
    Object.keys(want).forEach(function (kind) {
      var W = want[kind]; if (!W.length) return;
      var n = W.length, g = new THREE.BufferGeometry(), C = new Float32Array(n * 3), Z = new Float32Array(n), M = new Float32Array(n * 3);
      W.forEach(function (w, k) {
        C[k * 3] = w.rgb[0] * w.a; C[k * 3 + 1] = w.rgb[1] * w.a; C[k * 3 + 2] = w.rgb[2] * w.a;
        Z[k] = w.size; M[k * 3] = w.mot[0]; M[k * 3 + 1] = w.mot[1]; M[k * 3 + 2] = w.mot[2];
      });
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('color', new THREE.BufferAttribute(C.slice(), 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('aSize', new THREE.BufferAttribute(Z, 1));
      g.setAttribute('aMot', new THREE.BufferAttribute(M, 3));
      var tex = G.b3d.glowTexture(kind === 'corona' ? 'corona' : kind);
      var pts = new THREE.Points(g, new THREE.ShaderMaterial({
        uniforms: { uTex: { value: tex }, uPx: G.mat.uniforms.uPx, uTime: G.mat.uniforms.uTime, uMinPx: { value: kind === 'beacon' && !photo ? 24 * (window.devicePixelRatio || 1) : 0 },
                    /* corona: body radius = size * limb / (2 * 0.62); beacon: size / 3.2 */
                    uLodF: { value: photo ? new THREE.Vector3(kind === 'beacon' ? 1 / 3.2 : 0.25 / 1.24, kind === 'beacon' ? 4 : 5, kind === 'beacon' ? 9 : 14) : new THREE.Vector3(0, 0, 1) } },
        vertexShader: GLOW_VS, fragmentShader: GLOW_FS, transparent: true, depthWrite: false, depthTest: kind !== 'beacon',
        blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
        blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor }));
      pts.frustumCulled = false; pts.renderOrder = kind === 'pulsar' ? 2 : 3; pts.userData.universe = true;
      NS.scene.add(pts);
      SG.layers[kind] = { pts: pts, W: W, base: C, kind: kind };
    });
    syncStarGlows();
  }
  function syncStarGlows() {
    Object.keys(SG.layers).forEach(function (kind) {
      var L = SG.layers[kind], P = L.pts.geometry.attributes.position.array, C = L.pts.geometry.attributes.color.array;
      for (var k = 0; k < L.W.length; k++) {
        var w = L.W[k], i = w.i, f = 0.2 + 0.8 * G.foc[i] * G.foc[i];
        P[k * 3] = G.pos[i * 3]; P[k * 3 + 1] = G.pos[i * 3 + 1] + w.dy; P[k * 3 + 2] = G.pos[i * 3 + 2];
        C[k * 3] = L.base[k * 3] * f; C[k * 3 + 1] = L.base[k * 3 + 1] * f; C[k * 3 + 2] = L.base[k * 3 + 2] * f;
      }
      L.pts.geometry.attributes.position.needsUpdate = true; L.pts.geometry.attributes.color.needsUpdate = true;
      var t = G.b3d.glowTexture(kind); if (L.pts.material.uniforms.uTex.value !== t) L.pts.material.uniforms.uTex.value = t;
    });
  }

  /* ---------------- switch hubs (2026-10-07, registry: hub:true) ----------------
     A hub body (a UniFi switch, a third-party or SNMP switch, an inferred unmanaged
     switch) is drawn as a small star (bodies3d 'switch' = star) a little larger
     than its devices, and the registry's `uplink` edges that the topology does
     not already draw (any edge touching a body with no topology node) become
     thin quiet lines: hub -> child, and the hub's own uplink. Long edges fade
     with length like the spokes; the subject's edges come up in focus. A
     switch appearing later just adds its own edges: nothing else moves. */
  var HL = { segs: [], mesh: null };
  function bodyPos(id, out) {
    var b = U.byId[id];
    if (b && b.topo && NS.byId[b.topo]) { var n = NS.byId[b.topo]; out.x = n._cx; out.y = n._cy; out.z = n._cz; return n; }
    for (var i = 0; i < G.n; i++) if (U.insts[i].b.id === id) { out.x = G.pos[i * 3]; out.y = G.pos[i * 3 + 1]; out.z = G.pos[i * 3 + 2]; return U.insts[i]; }
    if (NS.byId[id]) { var m = NS.byId[id]; out.x = m._cx; out.y = m._cy; out.z = m._cz; return m; }
    return null;
  }
  function buildHubLinks() {
    HL.segs = [];
    var links = (U.active && U.data && U.data.links) || [];
    links.forEach(function (l) {
      if (l.kind !== 'uplink') return;
      var A = U.byId[l.a], B = U.byId[l.b];
      if (!A || !B || !(A.hub || B.hub)) return;
      var aTopo = A.topo && NS.byId[A.topo], bTopo = B.topo && NS.byId[B.topo];
      if (aTopo && bTopo) return;                     // the topology already draws this edge
      HL.segs.push({ a: l.a, b: l.b, foc: 'u:' + l.b, focA: aTopo ? A.topo : 'u:' + l.a, focB: bTopo ? B.topo : 'u:' + l.b });
    });
    if (!HL.mesh) {
      HL.mesh = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
      HL.mesh.frustumCulled = false; HL.mesh.renderOrder = -2; HL.mesh.userData.universe = true;
      NS.scene.add(HL.mesh);
    }
    var n = Math.max(1, HL.segs.length) * 2;
    HL.mesh.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
    HL.mesh.geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
    HL.mesh.geometry.setDrawRange(0, HL.segs.length * 2);
    updateHubLinks();
  }
  var _pa = { x: 0, y: 0, z: 0 }, _pb = { x: 0, y: 0, z: 0 }, HL_COL = new THREE.Color('#9fb8d8');
  function updateHubLinks() {
    if (!HL.mesh || !HL.segs.length) return;
    var P = HL.mesh.geometry.attributes.position.array, C = HL.mesh.geometry.attributes.color.array, oK = overK();
    var trOn = !!(NS.T && NS.T.active && NS.T.active());
    for (var i = 0; i < HL.segs.length; i++) {
      var S = HL.segs[i], o = i * 6;
      if (!bodyPos(S.a, _pa) || !bodyPos(S.b, _pb)) { for (var z = 0; z < 6; z++) C[o + z] = 0; continue; }
      P[o] = _pa.x; P[o + 1] = _pa.y; P[o + 2] = _pa.z; P[o + 3] = _pb.x; P[o + 4] = _pb.y; P[o + 5] = _pb.z;
      var len = Math.hypot(_pb.x - _pa.x, _pb.y - _pa.y, _pb.z - _pa.z);
      var base = Math.max(0.04, Math.min(0.14, 50 / Math.max(1, len)));
      /* a hub edge that crosses into another galaxy (a home client on a core AP):
         at the overview the measured streams carry the traffic story (2026-10-09) */
      if (len > 260 && trOn) base *= 1 - 0.8 * oK;
      var fa = NS.focusOf ? NS.focusOf(S.focA) : 1, fb = NS.focusOf ? NS.focusOf(S.focB) : 1, f = Math.min(fa, fb);
      var k = base + (0.38 - base) * Math.max(0, (f - 0.5) * 2) * (1 - oK);
      k *= Math.max(0.25, Math.max(fa, fb));
      C[o] = C[o + 3] = HL_COL.r * k; C[o + 1] = C[o + 4] = HL_COL.g * k; C[o + 2] = C[o + 5] = HL_COL.b * k;
    }
    HL.mesh.geometry.attributes.position.needsUpdate = true; HL.mesh.geometry.attributes.color.needsUpdate = true;
  }

  /* ---------------- tour accents (2026-10-07) ----------------
     ARRIVAL: one thin shockwave ring in the destination system's plane, in the
     stop's room colour (the same hue the lights take at that instant: it fires
     on the arrival frame, which is the light beat), plus a gentle bloom
     breath through cinema.js. Soft attack, no step, ~1.8 s - and only on
     arrival: departures change nothing globally.
     TRAIL: a small mote leads the camera from the subject it leaves to the one
     it is flying to (NS.legHead), dragging a short fading tail. */
  var FX = { ring: null, ring2: null, t: 9, R: 160, trail: null, tp: null, tn: 0, tCol: new THREE.Color(), tA: 0 };
  var TRAIL_N = 48, TRAIL_PTS = 7;     // line samples; the first few also draw as a glowing comet head
  var _ah = new THREE.Vector3(), _hd = new THREE.Vector3();
  function fxEnsure() {
    if (FX.ring) return;
    function mk(w) {
      var m = new THREE.Mesh(new THREE.RingGeometry(1 - w, 1, 160, 1), new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide }));
      m.rotation.x = -Math.PI / 2; m.visible = false; m.frustumCulled = false; m.renderOrder = 4; m.userData.universe = true;
      NS.scene.add(m); return m;
    }
    FX.ring = mk(0.035); FX.ring2 = mk(0.018);
    var g = new THREE.BufferGeometry();
    FX.tp = new Float32Array(TRAIL_N * 3); FX.tc = new Float32Array(TRAIL_N * 3); FX.ts = new Float32Array(TRAIL_N);
    g.setAttribute('position', new THREE.BufferAttribute(FX.tp, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(FX.tc, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(FX.ts, 1).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, TRAIL_PTS);
    FX.trail = new THREE.Points(g, new THREE.ShaderMaterial({ uniforms: { uTex: { value: G.glow }, uPx: G.mat.uniforms.uPx, uK: { value: 1 } },
      vertexShader: ARM_VS, fragmentShader: ARM_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    FX.trail.frustumCulled = false; FX.trail.renderOrder = 4; FX.trail.visible = false; FX.trail.userData.universe = true;
    NS.scene.add(FX.trail);
    /* the tail itself: one fading line through every sample (shares the buffers) */
    var lg = new THREE.BufferGeometry();
    lg.setAttribute('position', g.attributes.position); lg.setAttribute('color', g.attributes.color);
    FX.line = new THREE.Line(lg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    FX.line.frustumCulled = false; FX.line.renderOrder = 4; FX.line.visible = false; FX.line.userData.universe = true;
    NS.scene.add(FX.line);
  }
  function stopRGB(TR) {
    var f = window.LIGHTSYNC_STOP_RGB, c = f ? f(TR.idx) : null;
    return c ? FX.tCol.setRGB(c[0] / 255, c[1] / 255, c[2] / 255).lerp(new THREE.Color(1, 1, 1), 0.45) : FX.tCol.set('#bfe4ff');
  }
  function onArrive(st, TR) {
    fxEnsure();
    var hub = NS.stopHubPos ? NS.stopHubPos(st, _ah) : null;
    var sy = hub && hub._uSys;
    FX.R = st.list ? (sy && sy.R ? sy.R * 1.05 : 150) : 0;
    if (!FX.R) return;                                        // the overview needs no ring: the whole estate is the subject
    FX.t = 0; FX.c = _ah.clone();
    var col = stopRGB(TR);
    FX.ring.material.color.copy(col); FX.ring2.material.color.copy(col);
    if (window.CINEMA && window.CINEMA.beat) window.CINEMA.beat(0);
  }
  function fxTick(dt) {
    if (!FX.ring) { if (NS.tour && NS.tour.phase === 'travel') fxEnsure(); else return; }
    if (FX.t < 2.2) {
      FX.t += dt;
      [[FX.ring, 0, 0.30], [FX.ring2, 0.18, 0.20]].forEach(function (q) {
        var m = q[0], tt = (FX.t - q[1]) / 1.8;
        if (tt <= 0 || tt >= 1) { m.visible = false; return; }
        var e = 1 - Math.pow(1 - tt, 3), r = FX.R * (0.22 + 0.95 * e);
        m.visible = true; m.position.set(FX.c.x, FX.c.y - 2, FX.c.z); m.scale.set(r, r, r);
        m.material.opacity = q[2] * Math.min(1, tt * 7) * Math.pow(1 - tt, 1.6);
      });
    }
    /* trail */
    var on = NS.legHead && NS.legHead(_hd);
    FX.tA += ((on ? 1 : 0) - FX.tA) * (1 - Math.exp(-dt * (on ? 6 : 3)));
    if (FX.tA < 0.01) { FX.trail.visible = false; FX.line.visible = false; FX.tn = 0; return; }
    if (on) {
      if (!FX.tn) { for (var i = 0; i < TRAIL_N; i++) { FX.tp[i * 3] = _hd.x; FX.tp[i * 3 + 1] = _hd.y; FX.tp[i * 3 + 2] = _hd.z; } FX.tn = 1; stopRGB(NS.tour); }
      /* the tail eases toward the head, each sample toward the one in front
         (dt-based, so it is the same length at any frame rate) */
      var k = 1 - Math.exp(-dt * 30);
      FX.tp[0] = _hd.x; FX.tp[1] = _hd.y; FX.tp[2] = _hd.z;
      for (var j = TRAIL_N - 1; j > 0; j--) {
        var o = j * 3, p = o - 3;
        FX.tp[o] += (FX.tp[p] - FX.tp[o]) * k; FX.tp[o + 1] += (FX.tp[p + 1] - FX.tp[o + 1]) * k; FX.tp[o + 2] += (FX.tp[p + 2] - FX.tp[o + 2]) * k;
      }
    }
    var c = FX.tCol;
    for (var q = 0; q < TRAIL_N; q++) {
      var f = 1 - q / TRAIL_N, a = f * f * 0.85 * FX.tA;
      FX.tc[q * 3] = c.r * a; FX.tc[q * 3 + 1] = c.g * a; FX.tc[q * 3 + 2] = c.b * a;
      FX.ts[q] = q === 0 ? 14 : Math.max(1.5, 7 * (1 - q / TRAIL_PTS));
    }
    var gg = FX.trail.geometry;
    gg.attributes.position.needsUpdate = true; gg.attributes.color.needsUpdate = true; gg.attributes.aSize.needsUpdate = true;
    FX.trail.visible = true; FX.line.visible = true;
  }

  /* ---------------- per frame (allocation-free) ---------------- */
  function tick(t, dt) {
    if (!G.pts) return;
    /* shader clock: scene time re-based hourly so float32 never loses the
       sub-degree precision the epicycle needs; phases absorb the rebase */
    if (t - G.tBase > 3600) {
      var d = t - G.tBase;
      for (var i = 0; i < G.n; i++) {
        var st = U.insts[i].st; if (!st) continue;
        st.ph = (st.ph + st.omega * d) % TAU; G.aB[i * 4 + 1] = st.ph;
        st.sph = ((st.sph || 0) + (st.sw || 0) * d) % TAU;
        G.b3d.setDynamics(i, { orbitPh: st.ph, spinPh: st.sph });
      }
      G.tBase = t;
    }
    G.tNow = t - G.tBase;
    var Un = G.mat.uniforms, oK = overK();
    /* px floor on body size (CSS px diameter): at the overview the
       constellation must read as bodies, not dust */
    var minT = 18 - 7 * oK;          // subject bodies >= ~18 px at a close-up, 11 at the overview
    G.minPx = (G.minPx || minT) + (minT - (G.minPx || minT)) * (1 - Math.exp(-dt * 3));
    Un.uTime.value = G.tNow;
    Un.uNow.value = Date.now() / 1000 - G.epoch;
    /* overlay point scale: NB_RS.ptH (index.html) is the drawingBufferHeight
       the flipbook sizes were tuned against. Read every frame: cinema.js can
       change the scale between two frames. */
    var h = window.NB_RS ? NB_RS.ptH : NS.rndr.getContext().drawingBufferHeight;
    if (h !== G._h || NS.cam.fov !== G._fov) {
      Un.uPx.value = h / (2 * Math.tan(NS.cam.fov * Math.PI / 360));
      G._h = h; G._fov = NS.cam.fov;
    }
    /* focus: during a leg the targets move every frame (crossfade) */
    var live = NS.focusLive ? NS.focusLive() : false, focMoving = false, j;
    if (live || G.focSeq !== NS.focusSeq) {
      G.focSeq = NS.focusSeq;
      for (j = 0; j < G.n; j++) G.focT[j] = focusTarget(U.insts[j]);
      focMoving = true;
    }
    var a = 1 - Math.exp(-dt * (live ? 14.0 : 4.0)), C = G.aC, FB = G.b3d.focus;
    for (var k = 0; k < G.n; k++) {
      var f0 = G.foc[k], ft = G.focT[k];
      if (f0 !== ft) {
        var f = f0 + (ft - f0) * a; if (Math.abs(f - ft) < 0.004) f = ft;
        G.foc[k] = f; focMoving = true;
      }
      C[k * 4] = G.foc[k];
    }
    if (focMoving && FB.length >= G.n) { FB.set(G.foc.subarray(0, G.n)); G.b3d.markFocus(); }
    /* positions: only while something on the spine is still moving */
    var tween = NS.t < NS.tweenUntil || NS.focusAnim || G.moving;
    if (tween) {
      var mv = writePositions(1 - Math.exp(-dt * 4.5));
      G.moving = mv > 0;
    }
    var fading = galFade(dt);
    galSpin(t);
    /* while a plate hands over to (or back from) its edge-on view, its brightness
       follows every frame - and once more after, so it settles exactly */
    var edgeOn = false;
    for (var eg = 0; eg < (G.gals || []).length; eg++) { var GE = G.gals[eg]; if (GE.edge && (GE.edgeW > 0 || GE.ewPrev > 0)) { edgeOn = true; break; } }
    if (tween || focMoving || fading || edgeOn) { updateRings(); syncLabelStubs(); syncOverlayPos(); updateHubLinks(); syncStarGlows(); }
    /* a birth flare finishes after 10 min: drop it from the overlay set */
    if (G.ovlList && (G.ovlCheckAt || 0) < t) { G.ovlCheckAt = t + 1; buildOverlay(); }
    try { fxTick(dt); } catch (e) { }
    G.b3d.tick(G.tNow, { now: t, orbitR: Un.uOrbitR.value, minPx: G.minPx,
                         pxPerUnit: innerHeight / (2 * Math.tan(NS.cam.fov * Math.PI / 360)) });

    /* bloom vs density: count bodies in focus (cheap, n ~ 150) */
    var nIn = 0;
    for (var q = 0; q < G.n; q++) if (G.focT[q] >= 0.99) nIn++;
    var bkC = Math.max(0.55, Math.min(1, 1 - (nIn - 12) / 120));
    var bkT = bkC + (0.80 - bkC) * oK;
    NS.bloomK = (NS.bloomK || 1) + (bkT - (NS.bloomK || 1)) * (1 - Math.exp(-dt * 2.0));

    /* pre-warm label textures a few per frame: a close-up used to make ~90
       canvases visible at once, uploading + mipmapping them all in one frame
       (a 633 ms hitch measured at a busy host stop) */
    if (G.warm && G.warm.length && NS.rndr.initTexture) {
      for (var w = 0; w < 6 && G.warm.length; w++) { try { NS.rndr.initTexture(G.warm.pop()); } catch (e) { G.warm.length = 0; } }
    }
  }
  function queueWarm() {
    var q = [];
    (NS.labels || []).concat(NS.rateLabels || [], NS.hotLabels || []).forEach(function (l) {
      if (l && l.material && l.material.map) q.push(l.material.map);
    });
    if (G.lbl) q.push(G.lbl.material.uniforms.uTex.value);
    if (ANIM.tex) { q.push(ANIM.tex.birth); }
    G.warm = q;
  }

  /* ---------------- manifest (Blender agent) ---------------- */
  function loadManifest() {
    fetch('/static/assets/universe/manifest.json', { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('no manifest');
      return r.json();
    }).then(function (man) {
      if (!man || !man.classes) { G.manDone = true; return; }
      /* the atlas / turntables are no longer drawn (3D bodies); the manifest
         still gives class tints + sizes, disc art and the birth flare */
      U.manifest = man; G.manDone = true; G.wantAnim = !!(man.anims && man.anims.birth);
      if (NS && NS.graph) rebuildInstances();
      loadAnims(man);
      if (man.anims && man.anims.flow && NS.setFlowTex) {
        new THREE.TextureLoader().load('/static/assets/universe/' + man.anims.flow.file, function (ft) {
          ft.wrapS = THREE.ClampToEdgeWrapping; ft.minFilter = THREE.LinearFilter; ft.generateMipmaps = false;
          NS.setFlowTex(ft);
        });
      }
    })['catch'](function () { G.manDone = true; /* procedural atlas stays */ });
  }

  /* ---------------- boot ---------------- */
  function boot() {
    NS = window.NETSCENE; M = window.NB_MOTION; LAY = window.UNIVERSE_LAYOUT;
    if (!NS || !NS.scene || !M || !LAY || !window.THREE || !window.BODIES3D) { setTimeout(boot, 250); return; }
    G.epoch = Math.floor(Date.now() / 1000 / 86400) * 86400;   // keeps uNow small in float32
    G.tBase = 0;
    NS.U = U;
    NS.uniWaitUntil = Date.now() + 5000;
    NS.onRebuild = function () { rebuildInstances(); };
    NS.uTick = tick;
    NS.uAfterLabels = afterLabels;
    NS.onArrive = onArrive;
    window.NETUNI = {
      U: U, G: G, poll: poll, rebuild: rebuildInstances,
      /* QA: screen position of a body by id, through the live camera */
      screenOf: function (id) {
        for (var i = 0; i < G.n; i++) {
          if (U.insts[i].b.id !== id) continue;
          var v = new THREE.Vector3(G.pos[i * 3], G.pos[i * 3 + 1], G.pos[i * 3 + 2]).project(NS.cam);
          return [(v.x * 0.5 + 0.5) * innerWidth, (-v.y * 0.5 + 0.5) * innerHeight];
        }
        return null;
      },
      /* index.html's boot veil: true once the opening shot is fully dressed
         (first universe poll placed, Blender atlas + flipbooks + turntables in) */
      assetsReady: function () {
        if (!U.active && !U.err) return false;
        if (U.active && !G.n) return false;
        if (!G.manDone) return false;
        if (!G2.done || G2.pending > 0) return false;
        if (G.wantAnim && !ANIM.ready) return false;
        return true;
      },
      worldOf: function (id) { for (var i = 0; i < G.n; i++) if (U.insts[i].b.id === id) return [G.pos[i * 3], G.pos[i * 3 + 1], G.pos[i * 3 + 2]]; return null; },
      debug: function () {
        var by = {}, ex = 0, ps = 0, dn = 0, nw = 0;
        (U.insts || []).forEach(function (it) { by[it.cls] = (by[it.cls] || 0) + 1; if (!it.node) ex++; if (it.b.pseudo) ps++; if (it.b.status === 'down') dn++; if (G.aC && it.b['new']) nw++; });
        return { active: U.active, err: U.err, bodies: (U.bodies || []).length, drawn: G.n, extras: ex, topoOnly: ps, down: dn, newish: nw,
                 systems: (U.systems || []).map(function (s) { return [s.id, s.anchor, !!NS.byId[s.anchor], Math.round(s.R || 0), s.count]; }),
                 byClass: by, labels: G.labels.length, bodies: G.b3d ? G.b3d.stats() : null, sig: U.sig,
                 gals: (G.gals || []).map(function (g) { var m = g.mesh, u = m.material.uniforms; return [g.D.sys.id, g.asset, +(g.fade || 0).toFixed(2), m.visible, u && u.uK ? +u.uK.value.toFixed(3) : (m.material.opacity !== undefined ? +(+m.material.opacity).toFixed(3) : null), Math.round(m.scale.x), m.position.toArray().map(Math.round), !!m.parent]; }),
                 galsOld: (G.galsOld || []).length };
      }
    };
    loadManifest();
    if (bakeOn()) g2Load(); else G2.done = true;
    poll();
    setInterval(poll, POLL_MS);
  }
  boot();
})();
