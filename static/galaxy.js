/* galaxy.js — deep-space backdrop for the wall dashboard.  v3 "universe"
   ---------------------------------------------------------------------------
   The same universe as the nexus screen. sky.jpg (baked equirect nebula sky,
   luminance < 0.35) becomes scene.background via a cube render target (r128
   draws an equirect Texture background as a flat quad, so it is converted once
   with WebGLCubeRenderTarget.fromEquirectangularTexture); the FogExp2 is
   untouched (a background is never fogged). The procedural hero galaxy keeps
   its point arms for parallax but its flat core-glow plane is replaced by the
   BAKED discs: one amber disc under the arms for the FIRST configured Proxmox
   node, a smaller cyan one elsewhere in the wedge for the SECOND, and a small
   violet "edge" disc on the WAN side. Each disc is one additive,
   depthWrite:false draw that spins about its own normal; the tour stop key
   (host:/blk: on node 0 -> amber, on node 1 -> cyan, wan* -> violet) eases the
   focused disc to 1.5x and the others to 0.6x over ~1.5 s. Nothing snaps; no
   per-frame allocation; textures load once.

   Reads:   window.CONFIG.nodes[]   to decide which disc a tour stop lights up
            NETSCENE.tour           the current stop key
            /static/assets/*.png|jpg the baked sky + discs (no API at all)
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

  /* ---- baked Blender assets (loaded once; a disc draws nothing until its
     texture arrives, so a slow fetch just delays the disc, never the scene) ---- */
  var ASSETS = '/static/assets/';
  var LOADER = null;
  var PENDING = 0;     // baked textures still in flight (boot veil waits for 0)
  function loadTex(name, cb) {
    LOADER = LOADER || new THREE.TextureLoader();
    PENDING++;
    LOADER.load(ASSETS + name, function (tex) {
      PENDING--;
      tex.encoding = THREE.sRGBEncoding;
      tex.minFilter = THREE.LinearMipmapLinearFilter; tex.generateMipmaps = true;
      var r = window.rndr && window.rndr.capabilities;
      if (r && r.getMaxAnisotropy) tex.anisotropy = Math.min(8, r.getMaxAnisotropy());
      cb(tex);
    }, undefined, function () { PENDING--; });
  }
  /* one baked spiral disc: one draw call, additive, never writes depth,
     opacity tuned so only the nucleus approaches the bloom threshold */
  var DISCS = [];
  /* Two baked node discs exist (amber + cyan). With more than two Proxmox
     nodes configured the extras alternate between them by node index — a
     backdrop cue, not an inventory, so two colours stay readable at N nodes. */
  var NODE_DISC = ['n0', 'n1'];
  function discKeyForNode(id) {
    var C = window.CONFIG;
    var i = (C && C.nodeIndex) ? C.nodeIndex(id) : -1;
    if (i < 0) return '';
    return NODE_DISC[i % NODE_DISC.length];
  }
  /* clean pass (2026-10-07) made the background galaxies quieter and cooler
     (0.55, a grey-blue tint). The look pass (2026-10-08, contracts 8: "graphics
     to pop ... like a real galaxy", the 10-04/05 frames) restores them: full
     strength, natural colour */
  var BG_K = 1.0;
  function mkDisc(spec) {
    var mat = new THREE.MeshBasicMaterial({
      map: null, transparent: true, opacity: 0, depthWrite: false, fog: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, color: 0xffffff
    });
    mat.visible = false;
    var m = new THREE.Mesh(new THREE.PlaneGeometry(spec.size, spec.size), mat);
    m.renderOrder = -20; m.userData.bg = true; m.frustumCulled = false;
    var d = { key: spec.key, mesh: m, op: spec.op, spin: spec.spin, phase: spec.phase || 0,
              f: 1, fT: 1, appear: 1, baseQ: new THREE.Quaternion(), inGroup: !!spec.inGroup };
    if (!spec.inGroup) {
      m.position.copy(spec.pos);
      /* billboard toward the mean camera, then a fixed tilt so it reads as a
         disc in space rather than a decal; the tilt is baked into baseQ */
      var toCam = CAMP.clone().sub(spec.pos).normalize();
      var n = toCam.multiplyScalar(Math.cos(spec.tilt || 0))
        .add(new THREE.Vector3(0, 1, 0).multiplyScalar(Math.sin(spec.tilt || 0) * 0.8))
        .add(new THREE.Vector3(1, 0, 0).multiplyScalar(Math.sin(spec.tilt || 0) * 0.6)).normalize();
      d.baseQ.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
      m.quaternion.copy(d.baseQ);
    }
    /* a late texture fades in (appear 0 -> 1) instead of popping at full strength */
    loadTex(spec.tex, function (tex) { mat.map = tex; d.appear = 0; mat.opacity = 0; mat.visible = true; mat.needsUpdate = true; });
    DISCS.push(d);
    return d;
  }

  /* clean pass (2026-10-07): the baked sky's nebulae (a saturated red one sits
     under every close-up that looks down past the estate) are backdrop, not
     subject. Once, at load: pull saturation most of the way down - hardest on
     the reds and magentas - and trim a little exposure, on a half-size copy. */
  function restrainSky(tex) {
    var img = tex.image; if (!img || !img.width) return tex;
    var w = Math.min(4096, img.width), h = Math.round(w * img.height / img.width);
    var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    var x = cv.getContext('2d'); x.drawImage(img, 0, 0, w, h);
    var im = x.getImageData(0, 0, w, h), d = im.data;
    for (var i = 0; i < d.length; i += 4) {
      var r = d[i], g = d[i + 1], b = d[i + 2], l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      var warm = r > b && r > g ? Math.min(1, (r - Math.max(g, b)) / 60) : 0;   // red / magenta / amber
      var k = 0.42 + 0.33 * warm;                                               // share of saturation removed
      d[i] = (r + (l - r) * k) * 1.02; d[i + 1] = (g + (l - g) * k) * 1.02; d[i + 2] = (b + (l - b) * k) * 1.02;   // 2026-10-08: the chrome lost its bright plates; the backdrop carries a touch more of the frame
    }
    x.putImageData(im, 0, 0);
    var t = new THREE.CanvasTexture(cv);
    t.encoding = tex.encoding; t.minFilter = THREE.LinearFilter; t.generateMipmaps = false;
    tex.dispose();
    return t;
  }

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

  /* Nebula puffs, batched (2026-10-04). Each puff used to be its own
     THREE.Sprite - 122 sprites, i.e. up to 122 draw calls a frame for pure
     decoration, more than the whole topology graph. They are now ONE
     instanced, camera-facing quad draw per nebula (5 total) that reproduces
     SpriteMaterial exactly: screen-space rotation, colour x texel, opacity,
     additive, no depth test, tone-mapped like the built-in material, and it
     inherits the group's breathing scale the way a child sprite did. */
  var PUFF_VS = [
    'attribute vec3 iPos; attribute vec3 iSRot; attribute vec4 iCol; attribute float iTex;',
    'varying vec2 vUv; varying vec4 vCol; varying float vTex;',
    'void main(){',
    '  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);',
    '  float sc = length(modelMatrix[0].xyz);',
    '  vec2 c = position.xy * iSRot.xy * sc;',
    '  float cs = cos(iSRot.z), sn = sin(iSRot.z);',
    '  mv.xy += vec2(cs * c.x - sn * c.y, sn * c.x + cs * c.y);',
    '  vUv = uv; vCol = iCol; vTex = iTex;',
    '  gl_Position = projectionMatrix * mv;',
    '}'].join('\n');
  var PUFF_FS = [
    'uniform sampler2D t0; uniform sampler2D t1;',
    'varying vec2 vUv; varying vec4 vCol; varying float vTex;',
    'void main(){',
    '  vec4 tx = vTex < 0.5 ? texture2D(t0, vUv) : texture2D(t1, vUv);',
    '  gl_FragColor = vec4(vCol.rgb * tx.rgb, vCol.a * tx.a);',
    '  #include <tonemapping_fragment>',
    '}'].join('\n');
  function puffBatch(list) {
    var base = new THREE.PlaneGeometry(1, 1), g = new THREE.InstancedBufferGeometry();
    g.index = base.index; g.setAttribute('position', base.attributes.position); g.setAttribute('uv', base.attributes.uv);
    var n = list.length, P = new Float32Array(n * 3), S = new Float32Array(n * 3), C = new Float32Array(n * 4), T = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var q = list[i];
      P[i * 3] = q[0]; P[i * 3 + 1] = q[1]; P[i * 3 + 2] = q[2];
      S[i * 3] = q[3]; S[i * 3 + 1] = q[4]; S[i * 3 + 2] = q[5];
      C[i * 4] = q[6]; C[i * 4 + 1] = q[7]; C[i * 4 + 2] = q[8]; C[i * 4 + 3] = q[9];
      T[i] = q[10];
    }
    g.setAttribute('iPos', new THREE.InstancedBufferAttribute(P, 3));
    g.setAttribute('iSRot', new THREE.InstancedBufferAttribute(S, 3));
    g.setAttribute('iCol', new THREE.InstancedBufferAttribute(C, 4));
    g.setAttribute('iTex', new THREE.InstancedBufferAttribute(T, 1));
    g.instanceCount = n;
    var m = new THREE.Mesh(g, new THREE.ShaderMaterial({
      uniforms: { t0: { value: TEX.lump1 }, t1: { value: TEX.lump2 } },
      vertexShader: PUFF_VS, fragmentShader: PUFF_FS,
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending
    }));
    m.frustumCulled = false; m.renderOrder = -15; m.userData.bg = true;
    return m;
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
      var b = 0.50 + rnd() * 0.58;
      col.push(c.r * b, c.g * b, c.b * b);
    }
    return mkPoints(pos, col, size, opacity, TEX.soft, false);
  }

  /* ---------------- hero spiral galaxy ---------------- */
  function buildGalaxy(rnd) {
    var grp = new THREE.Group(); grp.userData.bg = true;
    var Rd = 5400;                                    // disc radius
    /* v3 r2: nucleus at pitch -17 / yaw 37 so it sits BELOW the top bar and
       inside the left edge at the overview (at -11/44 the HUD cropped it) */
    var pos = skyPos(-17.0, 37, 8600);                // core further out, clear of the subject
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
      /* r2: capped - the inner arms stacked enough points to saturate white
         (measured >200/255 in a 1080p shot); the bake carries the core now */
      var fall = Math.min(0.42, Math.exp(-r / (0.36 * Rd))) * (major ? 1 : 0.62);
      var u = rnd();
      if (r < 0.30 * Rd) c.setHSL(0.075 + rnd() * 0.035, 0.42, 0.62);      // warm inner
      else if (u > 0.965) c.setHSL(0.93, 0.42, 0.60);                      // HII pink knots
      else if (u > 0.60) c.setHSL(0.585 + rnd() * 0.03, 0.45, 0.68);       // young blue
      else c.setHSL(0.56, 0.12, 0.70);                                     // field white
      var rq = Math.min(1, Math.max(0, (r / Rd - 0.24) / 0.14));
      var damp = 1 - 0.48 * rq * rq * (3 - 2 * rq);          // -48% beyond ~0.30 Rd (r2: arms under bloom)
      var b = (0.13 + 0.87 * fall) * (0.55 + rnd() * 0.45) * damp;
      cols.push(c.r * b, c.g * b, c.b * b);
    }
    grp.add(mkPoints(pts, cols, 2.5, 0.18, TEX.soft, false));   // v3 r2: 0.60 -> 0.18, the bake underneath carries the rest

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
    grp.add(mkPoints(bp, bc, 2.3, 0.16, TEX.soft, false));

    // luminous underlay: the BAKED amber disc on the disc plane itself, under
    // the point arms, standing in for the FIRST configured Proxmox node. It
    // rides the group's spin, so it turns with the arms about the same normal.
    var nb = mkDisc({ key: 'n0', tex: 'galaxy_nb.png', size: 2.05 * Rd, op: 0.12, inGroup: true });
    nb.mesh.rotation.z = 0.9;                         // arms of the bake vs the point arms
    grp.add(nb.mesh);
    G.n0Disc = nb;

    // nucleus: small and hot — the one place allowed to kiss the bloom pass
    var nuc = sprite(TEX.soft, 0xffe7c2, 0.10, 210, 210, new THREE.Vector3(0, 0, 0));
    nuc.renderOrder = -14;
    grp.add(nuc);
    G.nuc = nuc;

    G.gal = grp;
    return grp;
  }

  /* ---------------- volumetric nebula clusters ---------------- */
  function buildNebula(rnd, opts) {
    var grp = new THREE.Group(); grp.userData.bg = true;
    var C = skyPos(opts.pitch, opts.yaw, opts.R);
    grp.position.copy(C);
    var hues = opts.hues;                     // [core hue, fringe hue]
    var puffs = [];
    var np = [], nc = [], col = new THREE.Color();
    for (var i = 0; i < opts.puffs; i++) {
      /* r2 (2026-09-19): measured on the wall - at 7-9k units a 600 u puff is a
         45-110 px grey disc, and the five clusters put ~120 of them across the
         lower half of the overview. Puffs are now 0.36x on 0.7x extents: a
         compact tinted knot of soft motes, no disc bigger than a node. The
         big nebulosity is the baked sky now. */
      var p = new THREE.Vector3(
        (rnd() * 2 - 1) * opts.ex * 0.7, (rnd() * 2 - 1) * opts.ey * 0.7, (rnd() * 2 - 1) * opts.ez * 0.7);
      var core = p.length() < Math.max(opts.ex, opts.ez) * 0.45;
      col.setHSL(core ? hues[0] : hues[1], 0.55 + rnd() * 0.2, 0.52 + rnd() * 0.12);   // 2026-10-08: back to the 10-04 saturation (0.30-0.42 muted it)
      var s = opts.size * 0.36 * (0.5 + rnd() * 0.9) * (core ? 1 : 1.35);
      var ti = rnd() > 0.5 ? 0 : 1;
      var sy = s * (0.7 + rnd() * 0.5), rot = rnd() * 6.28;   // same rnd() order as the old sprite() call
      puffs.push([p.x, p.y, p.z, s, sy, rot, col.r, col.g, col.b, opts.op * (window.NB_HDR ? 0.55 : 1.15) * (core ? 1.25 : 0.7), ti]);
    }
    grp.add(puffBatch(puffs));
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
    /* r2 (2026-09-19): 340 x 58 u at y -300..-860 sat right under the overview
       camera path and resolved as grey discs bigger than a node. Half the count
       and size, pushed down and out so they read as soft motes. */
    for (var i = 0; i < 170; i++) {
      var r = 900 + rnd() * 2000, th = rnd() * 6.283;
      pos.push(r * Math.cos(th), -650 - rnd() * 650, r * Math.sin(th));
      c.setHSL(0.56 + rnd() * 0.05, 0.30, 0.55);
      var b = 0.25 + rnd() * 0.45;
      col.push(c.r * b, c.g * b, c.b * b);
    }
    var p = mkPoints(pos, col, 26, 0.09, TEX.soft, true);
    G.dust = p;
    return p;
  }


  /* ---------------- shooting stars ----------------
     Points, not a Line: gl line width is 1 px on every desktop driver, and a
     hard 1 px streak is exactly the aliasing artefact the video rules forbid.
     A tapered run of soft sprites reads as a glowing trail at any resolution
     and costs one draw call per meteor. Two in the pool; they overlap rarely. */
  var MET = { list: [], next: 8, rnd: mulberry32(0x5EED) };
  var MCOL = [0xfff3d8, 0xbfe6ff, 0xffd08a, 0xa9ffd8, 0xffc6e8];
  var MET_N = 26;

  function makeMeteor() {
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(MET_N * 3), 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(MET_N * 3), 3));
    var pts = new THREE.Points(g, new THREE.PointsMaterial({
      size: 9, sizeAttenuation: false, vertexColors: true, map: TEX.soft,
      transparent: true, opacity: 0, depthWrite: false, depthTest: false,
      fog: false, blending: THREE.AdditiveBlending
    }));
    pts.frustumCulled = false; pts.userData.bg = true; pts.renderOrder = -10;
    pts.visible = false;
    return { o: pts, alive: false, t0: 0, dur: 0, spd: 0, len: 0,
             P: new THREE.Vector3(), D: new THREE.Vector3(), col: new THREE.Color() };
  }

  var _out = new THREE.Vector3(), _t1 = new THREE.Vector3(), _t2 = new THREE.Vector3();
  function spawnMeteor(m, t) {
    var rnd = MET.rnd;
    /* upper sky only: the lower wedge is where the graph lives, and a streak
       crossing the subject reads as a glitch rather than a shooting star */
    var pitch = -6 - rnd() * 34, yaw = (rnd() * 2 - 1) * 68, R = 5200 + rnd() * 2400;
    m.P.copy(skyPos(pitch, yaw, R));

    // travel along the sky sphere at P, never toward or away from the camera
    _out.copy(m.P).sub(CAMP).normalize();
    _t1.set(0, 1, 0).cross(_out);
    if (_t1.lengthSq() < 1e-6) _t1.set(1, 0, 0);
    _t1.normalize();
    _t2.copy(_out).cross(_t1).normalize();
    var a = rnd() * 6.283;
    m.D.copy(_t1).multiplyScalar(Math.cos(a)).addScaledVector(_t2, Math.sin(a)).normalize();
    if (m.D.y > 0) m.D.negate();                 // they fall, always

    m.spd = (820 + rnd() * 780) * (R / 6000);
    m.len = 360 + rnd() * 420;
    m.dur = 1.15 + rnd() * 0.85;
    m.col.setHex(MCOL[(rnd() * MCOL.length) | 0]);
    m.t0 = t; m.alive = true; m.o.visible = true;
  }

  function meteorTick(t) {
    if (t > MET.next) {
      for (var k = 0; k < MET.list.length; k++)
        if (!MET.list[k].alive) { spawnMeteor(MET.list[k], t); break; }
      MET.next = t + 9 + MET.rnd() * 14;         // one every ~9-23 s
    }
    for (var i = 0; i < MET.list.length; i++) {
      var m = MET.list[i];
      if (!m.alive) continue;
      var e = t - m.t0;
      if (e > m.dur) { m.alive = false; m.o.visible = false; m.o.material.opacity = 0; continue; }
      var u = e / m.dur;
      // fast strike, long decay - the shape of a real meteor, and it never pops
      var env = Math.min(1, u / 0.10) * (1 - Math.min(1, Math.max(0, (u - 0.45) / 0.55)));
      var pa = m.o.geometry.attributes.position, ca = m.o.geometry.attributes.color;
      for (var j = 0; j < MET_N; j++) {
        var f = j / (MET_N - 1);                 // 0 = head, 1 = tail
        var d = e * m.spd - f * m.len;
        pa.setXYZ(j, m.P.x + m.D.x * d, m.P.y + m.D.y * d, m.P.z + m.D.z * d);
        var b = (1 - f) * (1 - f);               // tapered trail
        ca.setXYZ(j, m.col.r * b, m.col.g * b, m.col.b * b);
      }
      pa.needsUpdate = true; ca.needsUpdate = true;
      m.o.material.opacity = 0.9 * env;
    }
  }

  /* ---------------- build the whole sky ---------------- */
  function build() {
    var sky = new THREE.Group(); sky.userData.bg = true;
    var rnd = mulberry32(20260823);
    TEX.soft = softTex(); TEX.flare = flareTex();
    TEX.lump1 = lumpyTex(11); TEX.lump2 = lumpyTex(47);
    TEX.dgal = distGalTex();

    // rotating shells (isotropic — safe to spin)
    var shells = new THREE.Group(); shells.userData.bg = true;
    shells.add(shellPts(2000, 2400, 4600, 3.4, 0.80, rnd));
    shells.add(shellPts(3400, 5000, 9000, 2.6, 0.76, rnd));
    shells.add(shellPts(4200, 9500, 15500, 2.0, 0.66, rnd));
    G.shells = shells;
    sky.add(shells);

    sky.add(buildGalaxy(rnd));

    /* the two satellite discs. The SECOND node's disc (cyan): just past the
       overview frame's left edge (the sway brings it in beyond the exosphere
       ring) and in the lower-right quadrant of that node's tour stop (camera az
       1.15), where it is the sky behind the subject. THE EDGE (violet):
       top-right corner at the overview (sway brings it in and out), upper-right
       at the WAN stop (az -0.5), i.e. the sky beyond the edge as the camera
       looks at it. Both sit in the top / bottom bands the graph never reaches. */
    var gpu = mkDisc({ key: 'n1', tex: 'galaxy_gpu.png', size: 3400, op: 0.28, spin: 0.0052, phase: 1.3,
                       pos: skyPos(-44, 40, 9200), tilt: 0.42 });
    sky.add(gpu.mesh); G.n1Disc = gpu;
    var edge = mkDisc({ key: 'edge', tex: 'galaxy_edge.png', size: 2600, op: 0.27, spin: -0.0044, phase: 2.6,
                        pos: skyPos(-13, -50, 9600), tilt: 0.5 });
    sky.add(edge.mesh); G.edgeDisc = edge;

    /* the baked sky: equirect -> cube once, then it is the scene background
       (drawn by the renderer before everything, never fogged, never bloomed:
       the bake is deliberately dim, luminance < 0.35) */
    loadTex('sky.jpg', function (tex) {
      try {
        if (!window.NB_HDR) tex = restrainSky(tex);   // 2026-10-08: the photographic pipeline keeps the sky's own colour
        tex.mapping = THREE.EquirectangularReflectionMapping;
        var rt = new THREE.WebGLCubeRenderTarget(1024, { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
        rt.fromEquirectangularTexture(window.rndr, tex);
        G.skyTex = rt.texture; G.skyRT = rt;
        tex.dispose();
      } catch (e) { G.skyTex = null; }
    });

    G.nebs = [];
    var nebs = [
      { pitch: -50, yaw: -34, R: 7200, ex: 2100, ey: 1000, ez: 1200, size: 620, op: 0.165,
        puffs: 30, stars: 120, hues: [0.50, 0.58] },                      // teal → blue
      { pitch: -15, yaw: -48, R: 7600, ex: 1800, ey: 1250, ez: 1100, size: 580, op: 0.150,
        puffs: 26, stars: 90, hues: [0.72, 0.62] },                       // violet → blue
      { pitch: -47, yaw: 47, R: 7400, ex: 1900, ey: 1050, ez: 1200, size: 600, op: 0.145,
        puffs: 26, stars: 90, hues: [0.02, 0.90] },                       // amber-rose
      { pitch: -62, yaw: 6, R: 9000, ex: 2400, ey: 950, ez: 1400, size: 680, op: 0.130,
        puffs: 20, stars: 55, hues: [0.55, 0.60] },                       // deep cyan, low
      { pitch: -30, yaw: 62, R: 8200, ex: 1700, ey: 1050, ez: 1300, size: 600, op: 0.130,
        puffs: 20, stars: 60, hues: [0.42, 0.52] }                        // jade, far left
    ];
    nebs.forEach(function (o) { var n = buildNebula(rnd, o); G.nebs.push(n); sky.add(n); });

    // distant background galaxies — depth storytelling, very faint
    G.dgals = [];
    [[-24, -18, 11500, 0.5], [-56, 10, 12500, 1.1], [-11, 14, 12000, 2.2], [-38, 55, 11000, 0.3]]
      .forEach(function (d) {
        var s = 340 + rnd() * 320;
        var sp = sprite(TEX.dgal, 0xc4d2ee, 0.46, s, s, skyPos(d[0], d[1], d[2]), d[3]);
        G.dgals.push(sp); sky.add(sp);
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
        var b = (0.27 + rnd() * 0.42) * gdamp;
        col.push(c.r * b, c.g * b, c.b * b);
      }
      G.milky = mkPoints(pos, col, 2.2, 0.52, TEX.soft, false);
      sky.add(G.milky);
    })();

    sky.add(buildFlares(rnd));
    sky.add(buildDust(rnd));

    MET.list = [makeMeteor(), makeMeteor()];
    MET.list.forEach(function (m) { sky.add(m.o); });

    G.sky = sky;
    return sky;
  }

  /* ---------------- the asset world (galaxy2, 2026-10-08) ----------------
     The Blender renders (static/assets/galaxy2/manifest.json): a seamless
     4096x2048 deep sky (a Milky Way band, faint nebulae, cirrus, ~9000 tiny galaxies)
     as a sky sphere at infinity, and photographic fillers for the wide shots (inclined,
     edge-on, lenticular, irregular and elliptical galaxies, three kinds of cluster, an
     Halpha and an OIII veil). The owner's rules: RAW sampling, white tint, straight alpha
     (rgb * a = light), additive; sky tint ~0.3 at close-ups, a little more at wide shots;
     background galaxies 0.3-0.6, clusters 0.5-0.9, nebulae 0.4-1.0. They retire the old
     procedural backdrop pieces that would double up (the old disc art, the puffs, the
     drawn Milky Way, the four tiny sprites); the star shells, flares, dust and meteors
     stay for parallax and life. No manifest (or no HDR): everything as before. */
  var GA = { base: '/static/assets/galaxy2/', man: null, done: false, applied: false, tex: {}, sky: null, pending: 0 };
  (function () {
    if (!window.NB_HDR || /[?&]g2=off/.test(location.search)) { GA.done = true; return; }
    fetch(GA.base + 'manifest.json', { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error('no galaxy2'); return r.json(); })
      .then(function (m) { GA.man = m; GA.done = true; })['catch'](function () { GA.done = true; });
  })();
  function gaTex(file, mip) {
    if (GA.tex[file]) return GA.tex[file];
    GA.pending++;
    var t = new THREE.TextureLoader().load(GA.base + file, function () { GA.pending--; }, undefined, function () { GA.pending--; });
    t.encoding = THREE.LinearEncoding;
    if (mip) { t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; } else { t.generateMipmaps = false; t.minFilter = THREE.LinearFilter; }
    GA.tex[file] = t;
    return t;
  }
  var SKY_VS = 'varying vec3 vDir; void main(){ vDir = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }';
  var SKY_FS = [
    'uniform sampler2D map; uniform float uTint; uniform float uU0; varying vec3 vDir;',
    'void main(){',
    '  vec3 d = normalize(vDir);',
    '  float u1 = fract(atan(d.x, -d.z) / 6.2831853 + uU0), u2 = fract(u1 + 0.5) - 0.5;',
    '  float u = fwidth(u1) <= fwidth(u2) + 1e-5 ? u1 : u2;',            // no seam where longitude wraps
    '  float v = 0.5 + asin(clamp(d.y, -1.0, 1.0)) / 3.14159265;',
    '  gl_FragColor = vec4(texture2D(map, vec2(u, v)).rgb * uTint, 1.0);',
    '}'].join('\n');
  function applyAssets() {
    GA.applied = true;
    var m = GA.man;
    if (m.sky && m.sky.file) {
      var mesh = new THREE.Mesh(new THREE.SphereGeometry(1000, 64, 32), new THREE.ShaderMaterial({
        uniforms: { map: { value: gaTex(m.sky.file, false) }, uTint: { value: 0.32 }, uU0: { value: 0.64 } },
        vertexShader: SKY_VS, fragmentShader: SKY_FS, side: THREE.BackSide, depthWrite: false, depthTest: false
      }));
      mesh.renderOrder = -100; mesh.frustumCulled = false; mesh.userData.bg = true;
      G.grp.add(mesh); GA.sky = mesh; G.assetSky = true;
      if (window.scene) window.scene.background = new THREE.Color(0x000000);
    }
    /* retire what the asset world replaces */
    if (G.gal) G.gal.visible = false;
    [G.n1Disc, G.edgeDisc].forEach(function (d) { if (d) { d.mesh.visible = false; d.retired = true; } });
    (G.nebs || []).forEach(function (n) { n.visible = false; });
    (G.dgals || []).forEach(function (sp) { sp.visible = false; });
    if (G.milky) G.milky.visible = false;
    if (G.nuc) G.nuc.visible = false;
  }
  /* the fillers, through the same wide-shot frames as the procedural deep field */
  var DFA_FS = [
    'uniform sampler2D map; uniform float uK; varying vec2 vUv; varying vec3 vCol;',
    'void main(){ vec4 t = texture2D(map, vUv); vec3 c = t.rgb * t.a * vCol * uK; if (c.r + c.g + c.b < 0.0004) discard; gl_FragColor = vec4(c, 1.0); }'].join('\n');
  function assetField(frames, rnd) {
    var ds = GA.man.deep_sky || {}, gal = ds.galaxies || {}, clu = ds.clusters || {}, neb = ds.nebulae || {};
    var gfiles = Object.keys(gal).map(function (k) { return gal[k].file; }).filter(Boolean);
    var cfiles = Object.keys(clu).map(function (k) { return clu[k].file; }).filter(Boolean);
    var nfiles = Object.keys(neb).filter(function (k) { return !neb[k].tileable; }).map(function (k) { return neb[k].file; }).filter(Boolean);
    var by = {};                                     // file -> instances
    function put(file, P, q, size, b) { (by[file] = by[file] || []).push({ p: P, q: q, size: size, cell: 0, b: b }); }
    var gi = 0, ci = 0, ni = 0;
    frames.forEach(function (fr) {
      var F = fr.F;
      fr.gal.forEach(function (sp, k) {
        var dir = rayOf(F, sp[0] + (rnd() - 0.5) * 0.10, sp[1] + (rnd() - 0.5) * 0.08);
        var D = 6500 + rnd() * 2500, P = F.cam.clone().addScaledVector(dir, D);
        var q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.clone().negate());
        q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), rnd() * 6.28));
        var cluster = cfiles.length && (k % 5 === 3);
        var file = cluster ? cfiles[ci++ % cfiles.length] : gfiles[gi++ % gfiles.length];
        if (!file) return;
        /* galaxies at 1/4-1/2 of a system galaxy, 0.3-0.6; clusters a little smaller, 0.5-0.9 */
        var px = Math.min(fr.cap || 170, sp[2]) * (fr.k || 1) * (cluster ? 0.75 : 1) * (0.8 + rnd() * 0.4);
        var b = cluster ? 0.5 + 0.35 * rnd() : 0.32 + 0.26 * rnd();
        if (Math.abs(sp[0]) < 0.45 && sp[1] < -0.6) b *= 0.7;          // behind the caption: quieter
        put(file, P, q, px * D / F.pxU * 0.5, b);
      });
      fr.neb.forEach(function (sp) {
        if (!nfiles.length) return;
        var dir = rayOf(F, sp[0], sp[1]), D = 7600 + rnd() * 800, P = F.cam.clone().addScaledVector(dir, D);
        var q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.clone().negate());
        q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), rnd() * 6.28));
        /* subordinate: the Halpha veil at the bottom of the owner's range (a crimson
           cloud competes with the galaxies and red is a status colour in the UI) */
        var nf = nfiles[ni++ % nfiles.length], hb = /_ha\b|neb_ha/.test(nf);
        put(nf, P, q, sp[2] * 1.15 * D / F.pxU * 0.5, (hb ? 0.40 + 0.10 * rnd() : 0.65 + 0.30 * rnd()) * (fr.nk || 1));
      });
    });
    /* a sprinkle of small galaxies elsewhere below the horizon, for every other camera */
    for (var j = 0; j < 20 && gfiles.length; j++) {
      var ph = -0.12 - rnd() * 1.3, yw = rnd() * 6.283, dir2 = new THREE.Vector3(Math.cos(ph) * Math.sin(yw), Math.sin(ph), Math.cos(ph) * Math.cos(yw));
      var D2 = 7000 + rnd() * 2500;
      var q2 = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir2.clone().negate());
      q2.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), rnd() * 6.28));
      put(gfiles[j % gfiles.length], dir2.clone().multiplyScalar(D2), q2, (50 + rnd() * 90) * D2 / (innerHeight / (2 * Math.tan(29 * Math.PI / 180))) * 0.5, 0.28 + 0.25 * rnd());
    }
    DF.assetMeshes = [];
    Object.keys(by).forEach(function (file) {
      var isNeb = nfiles.indexOf(file) >= 0;
      var mm = atlasBatch(gaTex(file, true), 1, by[file], isNeb ? -20 : -19, DFA_FS);
      G.sky.add(mm); DF.assetMeshes.push(mm);
    });
  }

  /* ---------------- the deep field (2026-10-08, contracts 8a) ----------------
     A zoomed-out shot should fill the frame, never look empty in parts. The negative space around the estate fills with REAL deep-sky content,
     never UI: distant galaxies of every type (grand-design and flocculent spirals,
     ellipticals, dwarfs) at random inclinations, a few star clusters, all far
     behind the estate. Placed through the OVERVIEW camera the tour actually flies
     (NETSCENE.ovFit), aimed at the frame's empty bands (the top, the bottom, the
     corners and round the side panels) so the wide shot reads full; fixed in the
     world after that (a later re-fit moves nothing). ONE baked atlas texture
     (galaxy_bake.js, 16 cells) and ONE instanced draw for every galaxy; one
     Points draw for the clusters. Additive, unfogged, faint: subordinate to the
     estate. Builds once the overview fit exists (a few seconds after load). */
  var DF = { built: false, mesh: null, tries: 0 };
  var DF_VS = [
    'attribute vec3 iPos; attribute vec4 iQ; attribute vec3 iSz; attribute vec3 iCol;',
    'uniform float uCells; varying vec2 vUv; varying vec3 vCol;',
    'vec3 qrot(vec4 q, vec3 v){ return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }',
    'void main(){',
    '  vec3 p = iPos + qrot(iQ, vec3(position.xy * iSz.x, 0.0));',
    '  vUv = (iSz.yz + uv) / uCells; vCol = iCol;',
    '  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);',
    '}'].join('\n');
  /* the atlases are log-encoded RGBA8 (galaxy_bake.js NB_GALAXY.DEC_GLSL decodes) */
  function dfFS() {
    return ['uniform sampler2D map; uniform float uK; varying vec2 vUv; varying vec3 vCol;',
      (window.NB_GALAXY && window.NB_GALAXY.DEC_GLSL) || 'vec3 nbDec(vec3 v){ return v; }',
      'void main(){ vec3 c = nbDec(texture2D(map, vUv).rgb) * vCol * uK; if (c.r + c.g + c.b < 0.0005) discard; gl_FragColor = vec4(c, 1.0); }'].join('\n');
  }
  /* a wide shot's camera, as netscene's tourPose flies it at the start of a hold */
  function shotFrame(c, el, az, d) {
    var cam = new THREE.Vector3(c.x + d * Math.cos(el) * Math.sin(az), c.y + d * Math.sin(el), c.z + d * Math.cos(el) * Math.cos(az));
    var fwd = c.clone().sub(cam).normalize(), right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
    var up = new THREE.Vector3().crossVectors(right, fwd).normalize();
    var tv = Math.tan(29 * Math.PI / 180);
    return { cam: cam, fwd: fwd, right: right, up: up, tv: tv, th: tv * (innerWidth / innerHeight), pxU: innerHeight / (2 * tv) };
  }
  function rayOf(F, nx, ny) { return F.fwd.clone().addScaledVector(F.right, nx * F.th).addScaledVector(F.up, ny * F.tv).normalize(); }
  /* an instanced, oriented, textured-quad batch reading an atlas (cols x cols) */
  function atlasBatch(tex, cols, inst, order, fs) {
    var base = new THREE.PlaneGeometry(2, 2), g = new THREE.InstancedBufferGeometry();
    g.index = base.index; g.setAttribute('position', base.attributes.position); g.setAttribute('uv', base.attributes.uv);
    var N = inst.length, IP = new Float32Array(N * 3), IQ = new Float32Array(N * 4), IS = new Float32Array(N * 3), IC = new Float32Array(N * 3);
    inst.forEach(function (it, k) {
      IP[k * 3] = it.p.x; IP[k * 3 + 1] = it.p.y; IP[k * 3 + 2] = it.p.z;
      IQ[k * 4] = it.q.x; IQ[k * 4 + 1] = it.q.y; IQ[k * 4 + 2] = it.q.z; IQ[k * 4 + 3] = it.q.w;
      IS[k * 3] = it.size; IS[k * 3 + 1] = it.cell % cols; IS[k * 3 + 2] = Math.floor(it.cell / cols);
      IC[k * 3] = it.b; IC[k * 3 + 1] = it.b; IC[k * 3 + 2] = it.b;
    });
    g.setAttribute('iPos', new THREE.InstancedBufferAttribute(IP, 3));
    g.setAttribute('iQ', new THREE.InstancedBufferAttribute(IQ, 4));
    g.setAttribute('iSz', new THREE.InstancedBufferAttribute(IS, 3));
    g.setAttribute('iCol', new THREE.InstancedBufferAttribute(IC, 3));
    g.instanceCount = N;
    var m = new THREE.Mesh(g, new THREE.ShaderMaterial({
      uniforms: { map: { value: tex }, uK: { value: 1 }, uCells: { value: cols } },
      vertexShader: DF_VS, fragmentShader: fs || dfFS(), transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor
    }));
    m.frustumCulled = false; m.renderOrder = order; m.userData.bg = true;
    return m;
  }
  function deepField() {
    if (DF.built || !window.NB_GALAXY || !window.NB_HDR || !window.rndr) return;
    if (!GA.done) return;                                  // the asset world, or the procedural one
    var NS = window.NETSCENE, fit = NS && NS.ovFit;
    if (!fit || !fit.c) { if (++DF.tries < 1800) return; fit = { c: [0, 0, 300], el: 1.0, az: 0, d: 1300 }; }   // ~30 s: give up waiting, use a typical fit
    DF.built = true;
    var rnd = mulberry32(0x0DEE9F1E);
    /* 16 galaxy types for the atlas */
    var HUES = [[0.60, 0.76, 1.00], [1.00, 0.78, 0.50], [0.78, 0.62, 1.00], [0.50, 0.95, 0.80], [1.00, 0.55, 0.72],
                [0.62, 0.92, 1.00], [1.00, 0.90, 0.62], [0.70, 0.70, 1.00]];
    var specs = [];
    for (var i = 0; i < 16; i++) {
      var kind = i < 9 ? 'spiral' : i < 12 ? 'elliptical' : i < 14 ? 'dwarf' : 'grand';
      specs.push({ size: 512, seed: 1000 + i * 7919, kind: kind, rIn: 0.10 + rnd() * 0.12, rOut: 0.42 + rnd() * 0.18,
                   twist: 1.6 + rnd() * 2.4, arms: rnd() < 0.7 ? 2 : 3, armW: 0.30 + rnd() * 0.25, bulge: 0.06 + rnd() * 0.07,
                   core: 3 + rnd() * 4, bright: 1, hii: 0.6 + rnd() * 0.6, dust: 0.6 + rnd() * 0.4, haze: 1, tilt: rnd() * 6.28,
                   accent: HUES[(rnd() * HUES.length) | 0], sectors: null });
    }
    /* Halpha pink-magenta rather than pure red (red is a status colour in the UI), OIII teal hearts */
    var nspecs = [{ seed: 11, a: [0.95, 0.34, 0.58], b: [0.25, 0.85, 0.90] }, { seed: 222, a: [0.95, 0.48, 0.42], b: [0.95, 0.78, 0.45] },
                  { seed: 3333, a: [0.80, 0.34, 0.75], b: [0.35, 0.65, 1.00] }, { seed: 44444, a: [0.92, 0.36, 0.62], b: [0.30, 0.92, 0.82] }];
    var gtex, ntex, assets = !!(GA.man && GA.man.deep_sky);
    if (!assets) {
      try { gtex = window.NB_GALAXY.bakeAtlas(window.rndr, specs, 4, 2048); ntex = window.NB_GALAXY.bakeNebulaAtlas(window.rndr, nspecs, 2, 2048); }
      catch (e) { return; }
    }
    /* the wide shots: the overview (netscene's fit) and the Internet edge stop */
    var frames = [{ F: shotFrame(new THREE.Vector3().fromArray(fit.c), fit.el, fit.az, fit.d * 1.03),
      gal: [[-0.62, 0.80, 210], [-0.20, 0.90, 120], [0.18, 0.86, 140], [0.50, 0.80, 175], [0.92, 0.62, 150], [-0.95, 0.60, 160],
            [-0.70, -0.92, 190], [-0.30, -0.95, 120], [0.32, -0.93, 135], [0.72, -0.90, 185], [0.96, -0.55, 150], [-0.97, -0.50, 140],
            [-0.42, 0.55, 80], [0.70, 0.40, 90], [-0.75, -0.20, 70], [0.88, 0.05, 85], [0.10, -0.75, 70], [-0.05, 0.72, 75],
            [-0.76, -0.93, 170], [-0.47, -0.77, 120], [0.22, -0.97, 110], [0.86, -0.86, 150], [0.55, -0.62, 120]],
      /* nebulae keep clear of the status bar / caption band (red is a status colour there) */
      neb: [[0.02, 0.86, 480, 0], [-0.66, -0.66, 460, 1], [0.70, -0.64, 440, 3], [0.86, 0.70, 440, 2], [-0.86, 0.78, 440, 1]] }];
    /* growth (contracts 8a): a new Proxmox galaxy joins the compute rows on the right and
       the overview re-frames wider; fillers on the edges of that wider frame keep its
       corners full too (off-screen, so free, until the estate grows) */
    var gc = new THREE.Vector3().fromArray(fit.c).add(new THREE.Vector3(0.10 * fit.d, 0, -0.03 * fit.d));
    frames.push({ F: shotFrame(gc, Math.min(1.25, fit.el + 0.10), fit.az, fit.d * 1.3), k: 1.0,
      gal: [[-0.92, 0.86, 170], [-0.30, 0.94, 140], [0.35, 0.92, 150], [0.92, 0.84, 170], [-0.96, 0.10, 150], [0.96, 0.05, 160],
            [-0.90, -0.88, 170], [-0.35, -0.95, 130], [0.30, -0.95, 140], [0.88, -0.90, 180], [0.62, -0.80, 120], [0.50, -0.62, 120]],
      neb: [[0.80, -0.78, 420, 3], [-0.80, 0.80, 400, 2]] });
    var wst = null;
    (NS.tour && NS.tour.stops || []).forEach(function (st) { if (st.key === 'wan' && st.c) wst = st; });
    /* the Internet edge looks out past the estate toward the horizon: its upper half and
       the band under the Internet star are the voids (bigger, brighter fill than the overview) */
    if (wst) frames.push({ F: shotFrame(wst.c, wst.el || 0.46, wst.az || -0.5, (wst.dist || 900) * 1.02), k: 1.35, nk: 1.3, cap: 220,
      gal: [[-0.78, 0.74, 200], [-0.40, 0.86, 150], [0.02, 0.90, 130], [-0.95, 0.22, 150], [-0.55, 0.38, 110], [-0.86, -0.86, 160],
            [-0.30, -0.92, 120], [0.35, 0.80, 110], [-0.50, -0.80, 150], [-0.12, -0.94, 120], [0.30, 0.93, 140], [-0.95, 0.62, 160],
            [0.66, 0.93, 120], [-0.20, 0.62, 90], [-0.10, 0.55, 150], [0.18, 0.70, 170], [-0.62, 0.92, 140]],
      neb: [[-0.62, 0.58, 520, 2], [-0.12, 0.84, 460, 0], [-0.74, -0.62, 420, 3], [-0.40, -0.80, 420, 1]] });
    if (assets) { assetField(frames, rnd); return; }      // the asset set carries its own clusters
    var ginst = [], ninst = [];
    frames.forEach(function (fr) {
      var F = fr.F;
      fr.gal.forEach(function (sp, k) {
        var dir = rayOf(F, sp[0] + (rnd() - 0.5) * 0.10, sp[1] + (rnd() - 0.5) * 0.08);
        var D = 6500 + rnd() * 2500, P = F.cam.clone().addScaledVector(dir, D);
        var n = dir.clone().negate(), ax = new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).cross(n).normalize();
        var q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
        q.premultiply(new THREE.Quaternion().setFromAxisAngle(ax, Math.acos(0.15 + 0.85 * rnd())));
        q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), rnd() * 6.28));
        var b = (0.28 + 0.42 * rnd()) * (sp[2] > 130 ? 1.0 : 0.75);
        if (Math.abs(sp[0]) < 0.45 && sp[1] < -0.6) b *= 0.6;          // behind the caption: quieter
        ginst.push({ p: P, q: q, size: sp[2] * (fr.k || 1) * (0.8 + rnd() * 0.45) * D / F.pxU * 0.5, cell: (ginst.length * 7) % 16, b: b });
      });
      fr.neb.forEach(function (sp) {
        var dir = rayOf(F, sp[0], sp[1]), D = 7600 + rnd() * 800, P = F.cam.clone().addScaledVector(dir, D);
        var q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.clone().negate());
        q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), rnd() * 6.28));
        ninst.push({ p: P, q: q, size: sp[2] * D / F.pxU * 0.5, cell: sp[3], b: (0.40 + 0.18 * rnd()) * (fr.nk || 1) });
      });
    });
    /* a sprinkle elsewhere below the horizon, for every other camera of the tour */
    for (var j = 0; j < 22; j++) {
      var ph = -0.12 - rnd() * 1.3, yw = rnd() * 6.283, dir2 = new THREE.Vector3(Math.cos(ph) * Math.sin(yw), Math.sin(ph), Math.cos(ph) * Math.cos(yw));
      var D2 = 7000 + rnd() * 2500, P2 = dir2.clone().multiplyScalar(D2);
      var n2 = dir2.clone().negate(), ax2 = new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).cross(n2).normalize();
      var q2 = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n2);
      q2.premultiply(new THREE.Quaternion().setFromAxisAngle(ax2, Math.acos(0.15 + 0.85 * rnd())));
      ginst.push({ p: P2, q: q2, size: (60 + rnd() * 120) * D2 / (innerHeight / (2 * Math.tan(29 * Math.PI / 180))) * 0.5, cell: (rnd() * 16) | 0, b: 0.22 + 0.4 * rnd() });
    }
    var gm = atlasBatch(gtex, 4, ginst, -19), nm = atlasBatch(ntex, 2, ninst, -20);
    G.sky.add(nm); G.sky.add(gm);
    DF.mesh = gm; DF.nebulae = nm; G.deepField = gm;
    addClusters(frames, rnd);
  }
  /* globular / open clusters as points (3D, a little parallax): dense knots of stars in the overview's bands */
  function addClusters(frames, rnd) {
    var F0 = frames[0].F, cp = [], cc = [], col = new THREE.Color();
    for (var k2 = 0; k2 < 7; k2++) {
      var s2 = frames[0].gal[(k2 * 5 + 3) % frames[0].gal.length];
      var dirc = rayOf(F0, s2[0] + (rnd() - 0.5) * 0.5, s2[1] + (rnd() - 0.5) * 0.3);
      var Dc = 5200 + rnd() * 1500, C0 = F0.cam.clone().addScaledVector(dirc, Dc), rc = (14 + rnd() * 16) * Dc / F0.pxU, glob = k2 % 2 === 0;
      col.setHSL(glob ? 0.10 : 0.60, glob ? 0.45 : 0.55, 0.72);
      for (var m2 = 0; m2 < (glob ? 260 : 60); m2++) {
        var rr = rc * (glob ? Math.pow(rnd(), 2.2) : 0.3 + 0.7 * rnd()), t1 = rnd() * 6.283, t2 = Math.acos(2 * rnd() - 1);
        cp.push(C0.x + rr * Math.sin(t2) * Math.cos(t1), C0.y + rr * Math.cos(t2), C0.z + rr * Math.sin(t2) * Math.sin(t1));
        var bb = (glob ? 0.35 : 0.6) + 0.6 * Math.pow(rnd(), 3);
        cc.push(col.r * bb, col.g * bb, col.b * bb);
      }
    }
    var cl = mkPoints(cp, cc, 2.2, 0.85, TEX.soft, false);
    cl.renderOrder = -18; G.sky.add(cl); DF.clusters = cl;
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
  /* tour focus -> which disc brightens. Same key parsing as publishTour() in
     netscene_exo.js; only the target changes here, the ease is in tick(). */
  var FOC = { key: '', hot: '' };
  function focusTargets() {
    var NS = window.NETSCENE, TR = NS && NS.tour, key = '';
    if (TR && TR.stops && TR.stops.length) {
      var st = TR.stops[(TR.phase === 'travel' && TR.switched) ? TR.next : TR.idx];
      key = st ? (st.key || '') : '';
    }
    if (key === FOC.key) return;
    FOC.key = key;
    var hot = '';
    if (/^wan/.test(key)) hot = 'edge';
    else if (/^asp:/.test(key) && st) {
      /* an aspect stop lights the galaxy its subject lives in */
      var stA = TR.stops[(TR.phase === 'travel' && TR.switched) ? TR.next : TR.idx];
      var Cf = window.CONFIG, aNode = stA && stA.sysId && Cf && Cf.nodeFromSys ? Cf.nodeFromSys(stA.sysId) : null;
      hot = stA && stA.edge ? 'edge' : aNode ? discKeyForNode(aNode) : '';
    }
    else {
      var C = window.CONFIG;
      var node = (C && C.nodeFromKey) ? C.nodeFromKey(key) : null;   // host:pve:<id> / blk:pve:<id>:<cat>
      if (node) hot = discKeyForNode(node);
    }
    FOC.hot = hot;
    for (var i = 0; i < DISCS.length; i++) DISCS[i].fT = hot ? (DISCS[i].key === hot ? 1.5 : 0.6) : 1;
  }
  var _lastT = -1;
  function tick(t) {
    if (!ensure() || !G.sky) return;
    if (t === _lastT) return;                        // once per scene frame (see netscene_exo tick)
    var dt = _lastT < 0 ? 0.016 : Math.min(0.1, Math.max(0, t - _lastT));
    _lastT = t;
    G.t = t;
    /* the baked sky becomes the background once it exists (and stays it: a
       scene re-init would put netscene's flat colour back) */
    if (GA.done && GA.man && !GA.applied && G.grp) applyAssets();
    if (GA.sky) {
      var cmr = window.cam || (window.NETSCENE && window.NETSCENE.cam);
      if (cmr) GA.sky.position.copy(cmr.position);
      /* the owner's exposure: 0.30-0.35 at close-ups, 0.40-0.45 at the wide shots
         (the overviews and the Internet edge); eased with the camera's moves */
      var wide = /^(over|wan)/.test(FOC.key || 'over') ? 1 : 0;
      GA.tintW = (GA.tintW == null ? wide : GA.tintW) + (wide - (GA.tintW == null ? wide : GA.tintW)) * (1 - Math.exp(-dt / 0.8));
      GA.sky.material.uniforms.uTint.value = 0.31 + 0.10 * GA.tintW;
    } else if (G.skyTex && window.scene.background !== G.skyTex) window.scene.background = G.skyTex;
    focusTargets();
    var ease = 1 - Math.exp(-dt / 0.5);              // ~1.5 s to settle (3 tau)
    for (var di = 0; di < DISCS.length; di++) {
      var D = DISCS[di];
      D.f += (D.fT - D.f) * ease;
      var mat = D.mesh.material;
      if (mat.map) { if (D.appear < 1) D.appear = Math.min(1, D.appear + dt / 1.2); mat.opacity = D.op * D.f * D.appear * BG_K; }
      if (D.retired) D.mesh.visible = false;
      if (!D.inGroup) {                               // spin about its own normal
        D.mesh.quaternion.copy(D.baseQ);
        D.mesh.rotateZ(D.phase + t * D.spin);
      }
    }
    if (G.nuc && G.n0Disc) G.nuc.material.opacity = 0.10 * G.n0Disc.f;
    if (G.shells) {
      G.shells.rotation.y = t * 0.0021;                 // ~50 min / rev
      G.shells.rotation.x = Math.sin(t * 0.0009) * 0.03;
    }
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
    if (!DF.built) deepField();
    meteorTick(t);
  }

  /* boot veil: the sky and the baked discs are in (or failed) */
  /* the deep field is built before the reveal too (its bake + shader compile is a
     one-time cost the veil should hide); NB_BOOT's 7 s cap still applies */
  G.ready = function () { return !!G.sky && PENDING === 0 && GA.done && GA.pending === 0 && (DF.built || !window.NB_GALAXY || !window.NB_HDR); };
  G.ga = GA;
  G.df = DF;                    // QA: the deep field's parts (galaxies, nebulae, clusters)
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
