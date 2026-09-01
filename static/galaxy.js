/* galaxy.js — deep-space backdrop for the wall view.  v2 "massive"
   ---------------------------------------------------------------------------
   Loads AFTER netscene.js / netscene_flows.js and owns EVERYTHING decorative
   behind the topology. It carries no data. The graph is the subject; this is
   the room it sits in — a big room now, but the lights stay on the stage.

   Composition (all positions derived from the tour's camera geometry:
   camera orbits at elevation 0.6 rad, azimuth -0.5..1.15 rad, so the visible
   sky is a below-horizon wedge on the -z side; overview frame-centre looks
   along (0,-0.56,-0.83)):
   * hero spiral galaxy — oblique disc, warm core anchored at the upper-left
     frame edge (HUD territory), arms sweeping diagonally. Brightness falls
     exponentially with disc radius, so the part of the disc that reaches
     toward frame centre is intrinsically faint. Spin about its own normal
     keeps that invariant true forever.
   * three volumetric nebula clusters (many jittered puffs + embedded stars)
     placed off-centre in the wedge.
   * three star shells (near/mid/far) for parallax + a soft far dome.
   * hero stars with diffraction flares, distant background galaxies,
     and a sparse under-plane dust field that gives transits depth.

   NON-NEGOTIABLES (each has already broken this scene once):
   * scene fog (FogExp2) — every material here sets fog:false.
   * bloom threshold 0.78 — broad sky stays well under it; only the galactic
     nucleus and nebula hearts may kiss it.
   * every object carries userData.bg = true (framing probes skip bg).
   * video: no twinkle, no 1px hard stars — soft textures >=1.6px, all motion
     slow and driven by absolute wall-clock t.
   --------------------------------------------------------------------------- */
(function () {
  'use strict';
  var THREE = window.THREE;
  if (!THREE) return;

  var G = { grp: null, sky: null, t: 0 };

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  /* ---- camera-frame placement: pitch deg (neg = below horizon), yaw deg
     (0 = frame centre azimuth in overview, positive = viewer's left) ---- */
  var CAMP = new THREE.Vector3(0, 540, 810);      // mean overview camera pos
  function skyPos(pitch, yaw, R) {
    var p = pitch * Math.PI / 180, a = yaw * Math.PI / 180;
    var d = new THREE.Vector3(-Math.sin(a) * Math.cos(p), Math.sin(p), -Math.cos(a) * Math.cos(p));
    return d.multiplyScalar(R).add(CAMP);
  }

  /* graph-cone damp: 1 inside the cone the graph occupies on screen
     (with margin for tour reframing), eased to 0 outside. Applied only to
     STATIC layers — never to the spinning disc (its damp is radius-based). */
  function graphCone(v) {
    var dx = v.x - CAMP.x, dy = v.y - CAMP.y, dz = v.z - CAMP.z;
    var L = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    var pitch = Math.asin(dy / L), yaw = Math.atan2(-dx, -dz);
    function edge(x, a, b) {           // 1 well inside [a,b], 0 outside, smooth
      var w = 0.14;
      var lo = Math.min(1, Math.max(0, (x - a) / w)), hi = Math.min(1, Math.max(0, (b - x) / w));
      return Math.min(lo, hi);
    }
    return edge(pitch, -1.12, -0.08) * edge(yaw, -0.72, 0.72);
  }

  /* ---------------- canvas textures (all soft-edged, video-safe) --------- */
  function canvasTex(s, draw) {
    var cv = document.createElement('canvas'); cv.width = cv.height = s;
    draw(cv.getContext('2d'), s);
    var t = new THREE.CanvasTexture(cv); t.minFilter = THREE.LinearFilter;
    return t;
  }
  function softTex() {                       // round soft star / puff
    return canvasTex(64, function (x, s) {
      var g = x.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.35, 'rgba(255,255,255,.45)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = g; x.fillRect(0, 0, s, s);
    });
  }
  function flareTex() {                      // 4-point diffraction star
    return canvasTex(128, function (x, s) {
      var c = s / 2;
      var g = x.createRadialGradient(c, c, 0, c, c, c * 0.32);
      g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.5, 'rgba(255,255,255,.35)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = g; x.fillRect(0, 0, s, s);
      x.globalCompositeOperation = 'lighter';
      [[1, 0], [0, 1]].forEach(function (ax) {
        var lg = x.createLinearGradient(c - ax[0] * c, c - ax[1] * c, c + ax[0] * c, c + ax[1] * c);
        lg.addColorStop(0, 'rgba(255,255,255,0)'); lg.addColorStop(0.5, 'rgba(255,255,255,.85)');
        lg.addColorStop(1, 'rgba(255,255,255,0)');
        x.fillStyle = lg;
        if (ax[0]) x.fillRect(0, c - 1.6, s, 3.2); else x.fillRect(c - 1.6, 0, 3.2, s);
      });
    });
  }
  function lumpyTex(seed) {                  // irregular nebula puff (grayscale)
    var r = mulberry32(seed);
    return canvasTex(128, function (x, s) {
      x.globalCompositeOperation = 'lighter';
      for (var i = 0; i < 7; i++) {
        var px = s * (0.30 + r() * 0.40), py = s * (0.30 + r() * 0.40), rr = s * (0.14 + r() * 0.22);
        var g = x.createRadialGradient(px, py, 0, px, py, rr);
        g.addColorStop(0, 'rgba(255,255,255,' + (0.28 + r() * 0.25).toFixed(2) + ')');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        x.fillStyle = g; x.fillRect(0, 0, s, s);
      }
      // soft envelope so edges never clip square
      x.globalCompositeOperation = 'destination-in';
      var e = x.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      e.addColorStop(0, 'rgba(255,255,255,1)'); e.addColorStop(0.75, 'rgba(255,255,255,.75)');
      e.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = e; x.fillRect(0, 0, s, s);
    });
  }
  function galaxyCoreTex() {                 // warm core + haze + dust lanes
    return canvasTex(512, function (x, s) {
      var c = s / 2;
      var g = x.createRadialGradient(c, c, 0, c, c, c * 0.96);
      g.addColorStop(0.00, 'rgba(255,224,178,0.95)');
      g.addColorStop(0.10, 'rgba(255,205,150,0.55)');
      g.addColorStop(0.30, 'rgba(200,170,160,0.15)');
      g.addColorStop(0.60, 'rgba(120,130,190,0.055)');
      g.addColorStop(1.00, 'rgba(80,100,180,0)');
      x.fillStyle = g; x.fillRect(0, 0, s, s);
      // dust lanes: erase two spiral arcs
      x.globalCompositeOperation = 'destination-out';
      x.lineCap = 'round';
      for (var arm = 0; arm < 2; arm++) {
        x.beginPath();
        for (var i = 0; i <= 60; i++) {
          var t = i / 60, th = t * 3.6 + arm * Math.PI + 0.5;
          var rr = c * (0.14 + t * 0.62);
          var px = c + rr * Math.cos(th), py = c + rr * Math.sin(th);
          if (i === 0) x.moveTo(px, py); else x.lineTo(px, py);
        }
        x.lineWidth = 20; x.strokeStyle = 'rgba(0,0,0,0.52)';
        x.filter = 'blur(6px)'; x.stroke(); x.filter = 'none';
      }
    });
  }
  function distGalTex() {                    // tiny distant galaxy (grayscale)
    return canvasTex(64, function (x, s) {
      x.translate(s / 2, s / 2); x.scale(1, 0.38);
      var g = x.createRadialGradient(0, 0, 0, 0, 0, s / 2);
      g.addColorStop(0, 'rgba(255,255,255,.9)'); g.addColorStop(0.3, 'rgba(255,255,255,.35)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = g; x.fillRect(-s / 2, -s / 2, s, s);
    });
  }

  var TEX = {};

  /* ---------------- points helper ---------------- */
  function mkPoints(pos, col, size, opacity, tex, attenuate) {
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    var pts = new THREE.Points(g, new THREE.PointsMaterial({
      size: size, sizeAttenuation: !!attenuate, vertexColors: true, map: tex || TEX.soft,
      transparent: true, opacity: opacity, depthWrite: false, fog: false,
      blending: THREE.AdditiveBlending
    }));
    pts.frustumCulled = false; pts.userData.bg = true; pts.renderOrder = -12;
    return pts;
  }
  function sprite(tex, color, opacity, sx, sy, p, rot) {
    var m = new THREE.SpriteMaterial({
      map: tex, transparent: true, opacity: opacity, depthWrite: false, depthTest: false,
      fog: false, blending: THREE.AdditiveBlending, rotation: rot || 0
    });
    if (color) m.color = new THREE.Color(color);
    var sp = new THREE.Sprite(m);
    sp.scale.set(sx, sy, 1); sp.position.copy(p);
    sp.renderOrder = -15; sp.userData.bg = true;
    return sp;
  }

  /* ---------------- star shells (parallax layers) ---------------- */
  function shellPts(count, rMin, rMax, size, opacity, rnd) {
    var pos = [], col = [], c = new THREE.Color();
    for (var i = 0; i < count; i++) {
      var r = rMin + rnd() * (rMax - rMin), th = rnd() * 6.283, ph = Math.acos(2 * rnd() - 1);
      pos.push(r * Math.sin(ph) * Math.cos(th), r * Math.cos(ph), r * Math.sin(ph) * Math.sin(th));
      var u = rnd();
      if (u > 0.95) c.setHSL(0.07 + rnd() * 0.04, 0.55, 0.66);       // warm giants
      else if (u > 0.78) c.setHSL(0.58 + rnd() * 0.04, 0.45, 0.74);  // blue-white
      else c.setHSL(0.55, 0.08, 0.72 + rnd() * 0.18);                // near white
      var b = 0.42 + rnd() * 0.52;
      col.push(c.r * b, c.g * b, c.b * b);
    }
    return mkPoints(pos, col, size, opacity, TEX.soft, false);
  }

  /* ---------------- hero spiral galaxy ---------------- */
  function buildGalaxy(rnd) {
    var grp = new THREE.Group(); grp.userData.bg = true;
    var Rd = 5400;                                    // disc radius
    var pos = skyPos(-13.5, 35, 6900);                // core in the upper-left quadrant
    grp.position.copy(pos);

    // orient: oblique disc, band sweeping toward lower-right of frame
    var toCam = CAMP.clone().sub(pos).normalize();
    var n = toCam.clone().multiplyScalar(0.85)
      .add(new THREE.Vector3(0, 1, 0).multiplyScalar(0.50))
      .add(new THREE.Vector3(1, 0, 0).multiplyScalar(-0.18)).normalize();
    grp.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    grp.rotateZ(0.35);                                 // roll: set band diagonal
    G.galNormal = n;

    function gauss() { return (rnd() + rnd() + rnd() - 1.5) * 0.66; }

    // arms: 2 major + 2 minor, log-ish winding, exponential radial falloff
    var pts = [], cols = [], c = new THREE.Color();
    var N = 15000;
    for (var i = 0; i < N; i++) {
      var arm = (rnd() * 4) | 0, major = arm < 2;
      var t = Math.pow(rnd(), 1.55);                   // density toward core
      var r = 0.08 * Rd + t * 0.92 * Rd;
      var wind = (r / Rd) * 5.2;
      var jit = gauss() * (0.08 + 0.16 * r / Rd);
      var th = wind + arm * Math.PI * 0.5 + jit + (major ? 0 : 0.35);
      var thick = gauss() * (55 + 190 * Math.exp(-r / (0.30 * Rd)));
      pts.push(r * Math.cos(th), r * Math.sin(th), thick);
      // brightness: exponential falloff keeps the outer disc (which reaches
      // toward frame centre) intrinsically faint. Invariant under disc spin.
      var fall = Math.exp(-r / (0.36 * Rd)) * (major ? 1 : 0.62);
      var u = rnd();
      if (r < 0.30 * Rd) c.setHSL(0.075 + rnd() * 0.035, 0.42, 0.62);      // warm inner
      else if (u > 0.965) c.setHSL(0.93, 0.42, 0.60);                      // HII pink knots
      else if (u > 0.60) c.setHSL(0.585 + rnd() * 0.03, 0.45, 0.68);       // young blue
      else c.setHSL(0.56, 0.12, 0.70);                                     // field white
      var rq = Math.min(1, Math.max(0, (r / Rd - 0.24) / 0.14));
      var damp = 1 - 0.36 * rq * rq * (3 - 2 * rq);          // -36% beyond ~0.30 Rd
      var b = (0.13 + 0.87 * fall) * (0.55 + rnd() * 0.45) * damp;
      cols.push(c.r * b, c.g * b, c.b * b);
    }
    grp.add(mkPoints(pts, cols, 2.3, 0.62, TEX.soft, false));

    // central bulge: flattened warm spheroid
    var bp = [], bc = [];
    for (i = 0; i < 3200; i++) {
      var rr = Math.pow(rnd(), 2.0) * 0.22 * Rd;
      var th2 = rnd() * 6.283, ph = Math.acos(2 * rnd() - 1);
      bp.push(rr * Math.sin(ph) * Math.cos(th2), rr * Math.sin(ph) * Math.sin(th2), rr * Math.cos(ph) * 0.55);
      c.setHSL(0.08 + rnd() * 0.03, 0.45, 0.60 + rnd() * 0.10);
      var b2 = 0.45 + rnd() * 0.45;
      bc.push(c.r * b2, c.g * b2, c.b * b2);
    }
    grp.add(mkPoints(bp, bc, 2.2, 0.58, TEX.soft, false));

    // luminous underlay: core glow + dust lanes on the disc plane itself
    var glow = new THREE.Mesh(
      new THREE.PlaneGeometry(2.4 * Rd, 2.4 * Rd),
      new THREE.MeshBasicMaterial({
        map: TEX.core, transparent: true, opacity: 0.44, depthWrite: false,
        fog: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide
      }));
    glow.renderOrder = -20; glow.userData.bg = true;
    grp.add(glow);

    // nucleus: small and hot — the one place allowed to kiss the bloom pass
    var nuc = sprite(TEX.soft, 0xffe7c2, 0.82, 380, 380, new THREE.Vector3(0, 0, 0));
    nuc.renderOrder = -14;
    grp.add(nuc);
    var nuc2 = sprite(TEX.soft, 0xffd9a0, 0.32, 1250, 950, new THREE.Vector3(0, 0, 0));
    grp.add(nuc2);

    G.gal = grp;
    return grp;
  }

  /* ---------------- volumetric nebula clusters ---------------- */
  function buildNebula(rnd, opts) {
    var grp = new THREE.Group(); grp.userData.bg = true;
    var C = skyPos(opts.pitch, opts.yaw, opts.R);
    grp.position.copy(C);
    var hues = opts.hues;                     // [core hue, fringe hue]
    var np = [], nc = [], col = new THREE.Color();
    for (var i = 0; i < opts.puffs; i++) {
      var p = new THREE.Vector3(
        (rnd() * 2 - 1) * opts.ex, (rnd() * 2 - 1) * opts.ey, (rnd() * 2 - 1) * opts.ez);
      var core = p.length() < Math.max(opts.ex, opts.ez) * 0.45;
      col.setHSL(core ? hues[0] : hues[1], 0.55 + rnd() * 0.2, 0.52 + rnd() * 0.12);
      var s = opts.size * (0.5 + rnd() * 0.9) * (core ? 1 : 1.35);
      var tex = rnd() > 0.5 ? TEX.lump1 : TEX.lump2;
      grp.add(sprite(tex, col.getHex(), opts.op * (core ? 1.25 : 0.7),
        s, s * (0.7 + rnd() * 0.5), p, rnd() * 6.28));
    }
    // embedded young stars
    for (i = 0; i < opts.stars; i++) {
      np.push((rnd() * 2 - 1) * opts.ex, (rnd() * 2 - 1) * opts.ey, (rnd() * 2 - 1) * opts.ez);
      col.setHSL(hues[0] + (rnd() - 0.5) * 0.06, 0.35, 0.78);
      var b = 0.5 + rnd() * 0.5;
      nc.push(col.r * b, col.g * b, col.b * b);
    }
    if (opts.stars) grp.add(mkPoints(np, nc, 2.4, 0.8, TEX.soft, false));
    return grp;
  }

  /* ---------------- hero flare stars ---------------- */
  function buildFlares(rnd) {
    var grp = new THREE.Group(); grp.userData.bg = true;
    var batches = { s: [[], []], m: [[], []], l: [[], []] };
    var c = new THREE.Color(), placed = 0, guard = 0;
    while (placed < 15 && guard++ < 300) {
      var pitch = -6 - rnd() * 56, yaw = (rnd() * 2 - 1) * 58;
      // keep clear of overview frame centre (pitch -34, yaw 0)
      var dp = (pitch + 34) / 31, dy = yaw / 41;
      var e2 = dp * dp + dy * dy;
      if (e2 < 1) continue;
      var P = skyPos(pitch, yaw, 8600 + rnd() * 2600);
      var u = rnd(), b;
      if (u > 0.7) { c.setHSL(0.08, 0.5, 0.68); } else if (u > 0.35) { c.setHSL(0.59, 0.42, 0.74); }
      else { c.setHSL(0.55, 0.06, 0.78); }
      b = 0.48 + rnd() * 0.22;
      var k = (u > 0.8 && e2 > 2.0) ? 'l' : (u > 0.4 ? 'm' : 's');
      batches[k][0].push(P.x, P.y, P.z);
      batches[k][1].push(c.r * b, c.g * b, c.b * b);
      placed++;
    }
    if (batches.s[0].length) grp.add(mkPoints(batches.s[0], batches.s[1], 26, 0.55, TEX.flare, false));
    if (batches.m[0].length) grp.add(mkPoints(batches.m[0], batches.m[1], 38, 0.50, TEX.flare, false));
    if (batches.l[0].length) grp.add(mkPoints(batches.l[0], batches.l[1], 46, 0.45, TEX.flare, false));
    return grp;
  }

  /* ---------------- under-plane dust (fly-through parallax) -------------- */
  function buildDust(rnd) {
    var pos = [], col = [], c = new THREE.Color();
    for (var i = 0; i < 260; i++) {
      var r = 500 + rnd() * 1900, th = rnd() * 6.283;
      pos.push(r * Math.cos(th), -300 - rnd() * 560, r * Math.sin(th));
      c.setHSL(0.56 + rnd() * 0.05, 0.30, 0.55);
      var b = 0.25 + rnd() * 0.45;
      col.push(c.r * b, c.g * b, c.b * b);
    }
    var p = mkPoints(pos, col, 95, 0.20, TEX.soft, true);
    G.dust = p;
    return p;
  }

  /* ---------------- build the whole sky ---------------- */
  function build() {
    var sky = new THREE.Group(); sky.userData.bg = true;
    var rnd = mulberry32(20260823);
    TEX.soft = softTex(); TEX.flare = flareTex();
    TEX.lump1 = lumpyTex(11); TEX.lump2 = lumpyTex(47);
    TEX.core = galaxyCoreTex(); TEX.dgal = distGalTex();

    // rotating shells (isotropic — safe to spin)
    var shells = new THREE.Group(); shells.userData.bg = true;
    shells.add(shellPts(1400, 2400, 4600, 3.0, 0.62, rnd));
    shells.add(shellPts(2600, 5000, 9000, 2.2, 0.60, rnd));
    shells.add(shellPts(3200, 9500, 15500, 1.7, 0.50, rnd));
    G.shells = shells;
    sky.add(shells);

    sky.add(buildGalaxy(rnd));

    G.nebs = [];
    var nebs = [
      { pitch: -50, yaw: -34, R: 5600, ex: 1900, ey: 950, ez: 1100, size: 830, op: 0.14,
        puffs: 16, stars: 70, hues: [0.50, 0.58] },                       // teal → blue
      { pitch: -15, yaw: -48, R: 6400, ex: 1600, ey: 1200, ez: 1000, size: 780, op: 0.125,
        puffs: 13, stars: 50, hues: [0.72, 0.62] },                       // violet → blue
      { pitch: -47, yaw: 47, R: 6000, ex: 1700, ey: 1000, ez: 1100, size: 800, op: 0.115,
        puffs: 13, stars: 50, hues: [0.02, 0.90] },                       // amber-rose
      { pitch: -60, yaw: 6, R: 7600, ex: 2200, ey: 900, ez: 1300, size: 900, op: 0.115,
        puffs: 10, stars: 30, hues: [0.55, 0.60] }                        // deep cyan, low
    ];
    nebs.forEach(function (o) { var n = buildNebula(rnd, o); G.nebs.push(n); sky.add(n); });

    // distant background galaxies — depth storytelling, very faint
    [[-24, -18, 11500, 0.5], [-56, 10, 12500, 1.1], [-11, 14, 12000, 2.2], [-38, 55, 11000, 0.3]]
      .forEach(function (d) {
        var s = 260 + rnd() * 260;
        sky.add(sprite(TEX.dgal, 0xc4d2ee, 0.30, s, s, skyPos(d[0], d[1], d[2]), d[3]));
      });

    // milky band: a faint stellar girdle crossing the lower frame diagonally
    (function () {
      var d1 = skyPos(-58, -42, 1).sub(CAMP).normalize();
      var d2 = skyPos(-20, 50, 1).sub(CAMP).normalize();
      var nB = d1.clone().cross(d2).normalize();
      var q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), nB);
      var pos = [], col = [], c = new THREE.Color();
      for (var i = 0; i < 5200; i++) {
        var th = rnd() * 6.283, r = 9200 + rnd() * 2600;
        var y = (rnd() + rnd() + rnd() - 1.5) * 900;
        var v = new THREE.Vector3(r * Math.cos(th), y, r * Math.sin(th)).applyQuaternion(q);
        pos.push(v.x, v.y, v.z);
        var gdamp = 1 - 0.5 * graphCone(v);
        var u = rnd();
        if (u > 0.93) c.setHSL(0.08, 0.5, 0.62);
        else if (u > 0.75) c.setHSL(0.59, 0.4, 0.7);
        else c.setHSL(0.56, 0.1, 0.68 + rnd() * 0.2);
        var b = (0.20 + rnd() * 0.34) * gdamp;
        col.push(c.r * b, c.g * b, c.b * b);
      }
      sky.add(mkPoints(pos, col, 1.9, 0.38, TEX.soft, false));
    })();

    sky.add(buildFlares(rnd));
    sky.add(buildDust(rnd));

    G.sky = sky;
    return sky;
  }

  function ensure() {
    if (!window.scene) return false;
    if (!G.grp) { G.grp = new THREE.Group(); G.grp.userData.bg = true; G.grp.add(build()); }
    if (G.grp.parent !== window.scene) window.scene.add(G.grp);   // survives a scene clear
    return true;
  }

  /* all motion driven by absolute t (seconds) — frame-rate independent,
     slow enough to never strobe on video */
  var AX = new THREE.Vector3(0, 0, 1);
  function tick(t) {
    if (!ensure() || !G.sky) return;
    G.t = t;
    if (G.shells) {
      G.shells.rotation.y = t * 0.0021;                 // ~50 min / rev
      G.shells.rotation.x = Math.sin(t * 0.0009) * 0.03;
    }
    if (G.gal) G.gal.rotation.z += 0;                   // static fallback
    if (G.gal) {
      // spin the disc about its own normal (position fixed): arms alive,
      // brightness placement invariant
      G.gal.rotation.set(0, 0, 0);
      G.gal.quaternion.setFromUnitVectors(AX, G.galNormal);
      G.gal.rotateZ(0.9 + t * 0.0038);                  // ~27 min / rev
    }
    if (G.nebs) for (var i = 0; i < G.nebs.length; i++) {
      // slow breathing, phase-offset per cluster; ±7% opacity, 50 s period
      var s = 1 + 0.07 * Math.sin(t * 0.1256 / 10 + i * 2.1);
      G.nebs[i].scale.set(s, s, s);
    }
    if (G.dust) G.dust.rotation.y = t * 0.004;
  }

  window.GALAXY = G;
  window.galaxyTick = tick;

  /* zero-touch: wrap netscene's tick so index.html needs no edit */
  (function wrap() {
    var prev = window.netSceneTick;
    if (typeof prev !== 'function') { setTimeout(wrap, 300); return; }
    window.netSceneTick = function (t, dt) {
      try { prev(t, dt); } finally { try { tick(t); } catch (e) { } }
    };
  })();
})();
