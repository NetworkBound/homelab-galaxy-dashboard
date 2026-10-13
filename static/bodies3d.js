/* ============================================================================
   bodies3d.js - every device as a small real 3D model (2026-10-05)

   Shared by the wall (netscene_universe.js + the hub meshes in netscene.js)
   and, later, the nexus. Page-agnostic: needs only window.THREE (r128). No
   reference to NETSCENE, the tour or the DOM beyond one manifest fetch.

   WHY: the 2D atlas stills / 128 px turntable flipbooks read as small, blurry
   stickers next to the crisp 3D hub boxes, and unknown devices as grey
   smudges. A mesh is crisp at any size, lit consistently with the hubs and
   costs one draw per class.

   MODELS (docs/contracts.md section 4)
     manifest.models[<class>] = {file, tris, radius:1, matcap, spin_axis}
     model JSON = assets/rocket.json schema: pos[] nrm[] col[] (xyz / rgb 0..1),
                  glow[] (0..1 per vertex), idx[]; unit radius, +Y up, centred
     manifest.matcaps[<name>] = {file, size}   (sRGB, Cycles-rendered)
   Until a class has a Blender model, a clean placeholder built here from a few
   primitives (styled per class) stands in behind the same API, with a
   procedural matcap. The manifest is re-read every POLL_MS; a class switches
   to its Blender model (and matcap) the moment the file shows up, in place:
   the shared BufferGeometry gets new attributes, so every mesh that uses it
   (instanced bodies, hub bodies, hub rims) follows with no rebuild.

   SHADING (one ShaderMaterial family, no scene lights)
     base   = vertex colour x tint          (tint: category colour for Proxmox
                                             guests, class tint otherwise -
                                             the caller decides)
     lit    = base x matcap(view normal) + a thin fresnel rim in the tint
     glow   = tint x per-vertex glow x gain  (the ONLY part bright enough to
                                             cross the bloom threshold)
     status = desaturate + dim (down), eased; focus scales brightness + size
     fog    = the wall's exp2 fog, applied by hand
   A px floor keeps a body at least uMinPx wide on screen, so the overview
   constellation still reads as bodies, not dust (same rule the sprites had).

   MOTION (curves come from the caller, i.e. static/motion.js)
     epicycle about the slot: phi = phase + orbitW * t, radius uOrbitR
     self spin about the model's spin_axis: spinPhase + spinW * t
     both evaluated in the vertex shader from one clock: zero per-frame JS.
     down: the caller passes orbitW = spinW = 0 -> stops in place.
     birth: scale 0 -> 1 + brightness fade over BIRTH_S; removal: the reverse
     (a ghost instance lingers DEATH_S), both timed in the shader.

   API
     var B = BODIES3D.create({ scene, fogDensity?, manifestUrl?, assetBase?,
                               pollMs?, renderOrder? })
     B.setBodies(list)      list[i] = { key, cls, tint:[r,g,b], radius,
                              orbitW, orbitPh, spinW, spinPh, bright,
                              desat (0..1), pulse (s, 0 = none), focus? }
                            index i is the caller's index from now on.
                            New keys (after the first call) are born; keys
                            that vanished die. Cheap: call on every rebuild.
     B.setDynamics(i, o)    update bright / desat / tint / orbitW / spinW /
                            pulse of one index (status changes ease over 1.2 s)
     B.positions            Float32Array(3 * n): slot centres, caller writes,
                            then B.markPositions()
     B.focus                Float32Array(n) 0..1, caller writes, B.markFocus()
     B.tick(t, o)           o = { orbitR, pxPerUnit (CSS px at 1 unit, depth 1),
                              minPx (CSS px diameter floor), now (s) }
     B.hubMesh(kind, opts)  a non-instanced Mesh for a hub (gateway, switch,
                            ap, pve_host, storage) in the same material family;
                            opts = { tint:[r,g,b] or hex, tintMix 0..1 }.
                            Unit radius: the caller scales it.
     B.hubGeometry(kind)    the (live, swappable) unit geometry of a hub kind
     B.setHubStatus(mesh, { tint, desat, bright })
     B.stats()              { draws, instances, tris, classes: {cls: 'blender' |
                              'placeholder'}, models: n, matcaps: [...] }
     B.onChange(fn)         called after any model / matcap swap
     B.visible(bool)

   ADDITIONS 2026-10-07 (nexus; all optional, defaults leave the wall's
   pixels and behaviour unchanged)
     create({ gain: { body, glow, rim, glowWhite, tintMix } })
                            per-page shading gains for every bucket and hub
                            material (defaults 1.35 / 1.45 / 0.30 / 0.3 / 0.85
                            for bodies, 1.3 / 1.35 / 0.30 / 0.3 for hubs). The
                            nexus grades hotter (exposure 1.45, bloom 0.7 at
                            strength 1.0) and needs lower gains to match.
     B.vis                  Float32Array(n) 0..1, default 1, caller writes,
                            then B.markVis(): a per-body fade (level x vis,
                            size x mix(0.6, 1, vis), gone at 0) for screens
                            that hide a whole system (the nexus close-ups).
                            Carried in the spare iSt.w lane as (1 - vis); the
                            shader skips it entirely while it is 0.
     B.setHubStatus(mesh, { lvl })   same fade for a hub mesh (uLvl, default 1)
     B.loaded()             true once the first manifest read settled (models
                            applied, or no manifest / no models): a page can
                            hold its reveal for the real models

   ADDITIONS 2026-10-08 (wall look pass, contracts 8; all opt-in - without
   `photo` every pixel and behaviour of the nexus is unchanged)
     create({ photo: true | { lod: [3.2, 7], starPx: 6, starGain: 1.6, sun: 1.3,
              amb: [r,g,b], haze: [r,g,b], hazeK: 0.55, hubStarGain: 3.2,
              bodyStarGain: 2.4, coronaGain: 2.4, spikes: 0.55, lodFocus: 0,
              starLodK: 99 } })
                            lodFocus > 0: an off-focus body (B.focus < 1) needs
                            (1 + lodFocus * (1 - focus)) x the px to resolve (the
                            wall: 1.6, context stays starlight)
                            star-lit bodies + far-LOD stars + photographic hub
                            stars, for a page that renders LINEAR HDR and
                            tone-maps once (the wall: index.html NB_HDR)
     list[i].light = [x, y, z, code]   world position of the star that lights
                            body i, colour code 1 host core, 2 gateway, 3 switch,
                            4 red dwarf, 5 blue-white edge, 6 white, 7 warm white;
                            0 = unknown (a soft view-space key light)
     list[i].spikes, list[i].mag       far-LOD star: diffraction spikes 0..1,
                            magnitude multiplier (defaults: stars 0.8 / 1.6)
     B.lights               Float32Array(4n), caller writes, then B.markLights()
     B.setHubLight(mesh, [x, y, z], code)   the star lighting a non-star hub
     B.tune({ sun, starPx, starGain, lod, hazeK, amb })   runtime look tuning
     B.photo                true when the photo look is on
     BODIES3D.version       3
   ========================================================================== */
(function (root) {
  'use strict';
  var THREE = root.THREE;
  if (!THREE) return;

  var CLASSES = ['pve_host', 'guest_vm', 'guest_lxc', 'gateway', 'switch', 'ap', 'server', 'storage',
                 'computer', 'phone', 'tablet', 'tv_av', 'iot', 'appliance', 'camera', 'printer',
                 'game_console', 'network_device', 'edge', 'unknown'];
  var BIRTH_S = 0.9, DEATH_S = 0.8, STATUS_EASE = 2.5;
  var LUMA = [0.2126, 0.7152, 0.0722];

  /* ------------------------------------------------------------------ */
  /* placeholder geometry: a few primitives per class, vertex colour +   */
  /* glow, normalised to a unit sphere, +Y up                            */
  /* ------------------------------------------------------------------ */
  var DARK = [0.26, 0.28, 0.33], BODY = [0.92, 0.93, 0.95], MID = [0.58, 0.60, 0.66], WHITE = [1, 1, 1];
  var HUBB = [0.50, 0.54, 0.60];     // hub shells: gunmetal, the accent lights carry them

  function part(geo, col, glow, tx, ty, tz, rx, ry, rz) {
    var g = geo.index ? geo.toNonIndexed() : geo;
    if (rx || ry || rz) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx || 0, ry || 0, rz || 0)));
    g.translate(tx || 0, ty || 0, tz || 0);
    return { g: g, col: col, glow: glow || 0 };
  }
  function merge(parts) {
    var n = 0, i;
    for (i = 0; i < parts.length; i++) n += parts[i].g.attributes.position.count;
    var P = new Float32Array(n * 3), N = new Float32Array(n * 3), C = new Float32Array(n * 3), L = new Float32Array(n), o = 0;
    for (i = 0; i < parts.length; i++) {
      var p = parts[i], pa = p.g.attributes.position, na = p.g.attributes.normal, c = pa.count;
      P.set(pa.array.subarray(0, c * 3), o * 3); N.set(na.array.subarray(0, c * 3), o * 3);
      for (var v = 0; v < c; v++) { C[(o + v) * 3] = p.col[0]; C[(o + v) * 3 + 1] = p.col[1]; C[(o + v) * 3 + 2] = p.col[2]; L[o + v] = p.glow; }
      o += c;
    }
    /* centre on the bounding box, fit a unit sphere */
    var mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
    for (i = 0; i < n; i++) for (var k = 0; k < 3; k++) { var x = P[i * 3 + k]; if (x < mn[k]) mn[k] = x; if (x > mx[k]) mx[k] = x; }
    var cx = (mn[0] + mx[0]) / 2, cy = (mn[1] + mx[1]) / 2, cz = (mn[2] + mx[2]) / 2, r = 0;
    for (i = 0; i < n; i++) {
      P[i * 3] -= cx; P[i * 3 + 1] -= cy; P[i * 3 + 2] -= cz;
      r = Math.max(r, Math.hypot(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]));
    }
    for (i = 0; i < n * 3; i++) P[i] /= r;
    var idx = new (n > 65535 ? Uint32Array : Uint16Array)(n);
    for (i = 0; i < n; i++) idx[i] = i;
    return { pos: P, nrm: N, col: C, glow: L, idx: idx, tris: n / 3 };
  }
  function B_(w, h, d) { return new THREE.BoxGeometry(w, h, d); }
  function Cy(rt, rb, h, seg) { return new THREE.CylinderGeometry(rt, rb, h, seg || 20); }
  function To(r, t, seg) { return new THREE.TorusGeometry(r, t, 6, seg || 28); }

  var PH = {
    pve_host: function () {          // tower with glowing drive bays
      var a = [part(B_(0.72, 1.0, 0.72), HUBB), part(B_(0.76, 0.05, 0.76), DARK, 0, 0, 0.5, 0)];
      for (var i = 0; i < 4; i++) a.push(part(B_(0.5, 0.05, 0.03), WHITE, 1, 0, 0.28 - i * 0.16, 0.37));
      a.push(part(B_(0.04, 0.8, 0.04), WHITE, 0.8, 0.39, 0, 0.37));
      return a;
    },
    gateway: function () {           // wide desk router, light bar
      return [part(B_(1.0, 0.26, 0.5), HUBB), part(B_(0.9, 0.05, 0.02), WHITE, 1, 0, 0.02, 0.255),
              part(B_(0.18, 0.12, 0.02), DARK, 0, 0.32, -0.02, 0.255), part(B_(1.02, 0.03, 0.52), DARK, 0, 0, -0.13, 0)];
    },
    'switch': function () {          // 1U switch, port LEDs
      var a = [part(B_(1.0, 0.16, 0.46), HUBB), part(B_(0.96, 0.11, 0.01), DARK, 0, 0, 0, 0.232)];
      for (var i = 0; i < 12; i++) a.push(part(B_(0.045, 0.035, 0.02), WHITE, 1, -0.38 + i * 0.062, 0.02, 0.238));
      return a;
    },
    ap: function () {                // ceiling disc with a light ring
      return [part(Cy(0.5, 0.54, 0.12, 40), BODY), part(To(0.36, 0.035, 40), WHITE, 1, 0, 0.062, 0, Math.PI / 2),
              part(Cy(0.16, 0.16, 0.02, 24), DARK, 0, 0, 0.065, 0)];
    },
    storage: function () {           // stacked platters / NAS
      var a = [];
      for (var i = 0; i < 3; i++) {
        a.push(part(Cy(0.5, 0.5, 0.24, 32), HUBB, 0, 0, -0.3 + i * 0.3, 0));
        if (i < 2) a.push(part(Cy(0.505, 0.505, 0.05, 32), WHITE, 1, 0, -0.15 + i * 0.3, 0));
      }
      return a;
    },
    guest_vm: function () {          // cube with glowing edges
      var a = [part(B_(0.8, 0.8, 0.8), BODY)], e = 0.41;
      [[1, 1], [1, -1], [-1, 1], [-1, -1]].forEach(function (q) { a.push(part(B_(0.06, 0.84, 0.06), WHITE, 0.9, q[0] * e, 0, q[1] * e)); });
      return a;
    },
    guest_lxc: function () {         // hex container with a light band
      return [part(Cy(0.5, 0.5, 0.7, 6), BODY), part(Cy(0.515, 0.515, 0.11, 6), WHITE, 0.9, 0, 0.06, 0),
              part(Cy(0.3, 0.3, 0.06, 6), DARK, 0, 0, 0.37, 0)];
    },
    server: function () {            // slim rack server standing up
      var a = [part(B_(0.45, 1.0, 0.7), BODY)];
      for (var i = 0; i < 3; i++) a.push(part(B_(0.3, 0.04, 0.02), WHITE, 1, 0, 0.28 - i * 0.22, 0.355));
      return a;
    },
    computer: function () {          // monitor on a stand
      return [part(B_(1.0, 0.62, 0.06), BODY, 0, 0, 0.16, 0), part(B_(0.92, 0.54, 0.01), WHITE, 0.55, 0, 0.16, 0.035),
              part(Cy(0.04, 0.05, 0.3, 12), MID, 0, 0, -0.29, -0.02), part(B_(0.4, 0.04, 0.26), MID, 0, 0, -0.44, -0.02)];
    },
    phone: function () {
      return [part(B_(0.5, 1.0, 0.09), BODY), part(B_(0.44, 0.88, 0.01), WHITE, 0.6, 0, 0.02, 0.05),
              part(Cy(0.04, 0.04, 0.02, 12), DARK, 0, 0.12, 0.38, -0.05, Math.PI / 2)];
    },
    tablet: function () {
      return [part(B_(0.78, 1.0, 0.07), BODY), part(B_(0.7, 0.9, 0.01), WHITE, 0.55, 0, 0, 0.04)];
    },
    tv_av: function () {             // flat panel on a foot
      return [part(B_(1.0, 0.58, 0.05), BODY, 0, 0, 0.1, 0), part(B_(0.95, 0.53, 0.01), WHITE, 0.65, 0, 0.1, 0.03),
              part(B_(0.06, 0.18, 0.05), MID, 0, 0, -0.27, 0), part(B_(0.42, 0.03, 0.18), MID, 0, 0, -0.36, 0)];
    },
    iot: function () {               // smart puck, LED ring on top
      return [part(Cy(0.46, 0.5, 0.34, 28), BODY), part(To(0.3, 0.055, 28), WHITE, 1, 0, 0.175, 0, Math.PI / 2),
              part(Cy(0.36, 0.46, 0.04, 28), MID, 0, 0, 0.18, 0)];
    },
    appliance: function () {         // tall cylinder appliance with a light seam
      return [part(Cy(0.36, 0.4, 0.95, 24), BODY), part(Cy(0.37, 0.37, 0.05, 24), WHITE, 0.9, 0, 0.18, 0),
              part(Cy(0.2, 0.3, 0.08, 24), MID, 0, 0, 0.5, 0)];
    },
    camera: function () {            // bullet camera with a glowing lens
      return [part(Cy(0.21, 0.24, 0.8, 24), BODY, 0, 0, 0.08, 0, Math.PI / 2), part(Cy(0.25, 0.25, 0.14, 24), DARK, 0, 0, 0.08, 0.44, Math.PI / 2),
              part(Cy(0.16, 0.16, 0.03, 24), WHITE, 1, 0, 0.08, 0.52, Math.PI / 2), part(B_(0.56, 0.05, 0.9), MID, 0, 0, 0.33, 0.04),
              part(B_(0.09, 0.32, 0.09), MID, 0, 0, -0.24, -0.15), part(B_(0.3, 0.05, 0.3), MID, 0, 0, -0.41, -0.15)];
    },
    printer: function () {
      return [part(B_(0.9, 0.42, 0.7), BODY), part(B_(0.6, 0.04, 0.4), WHITE, 0.4, 0, 0.23, -0.05),
              part(B_(0.6, 0.06, 0.25), MID, 0, 0, -0.08, 0.45), part(B_(0.12, 0.05, 0.02), WHITE, 1, 0.3, 0.1, 0.355)];
    },
    game_console: function () {
      return [part(B_(0.9, 0.2, 0.7), BODY), part(B_(0.86, 0.025, 0.02), WHITE, 1, 0, 0.0, 0.355),
              part(B_(0.92, 0.04, 0.72), DARK, 0, 0, 0.12, 0)];
    },
    network_device: function () {    // small box with status LEDs
      var a = [part(B_(0.8, 0.22, 0.6), BODY), part(B_(0.82, 0.03, 0.62), DARK, 0, 0, 0.125, 0)];
      for (var i = 0; i < 4; i++) a.push(part(B_(0.09, 0.07, 0.03), WHITE, 1, -0.24 + i * 0.16, 0, 0.305));
      return a;
    },
    edge: function () {              // a globe with a lit equator
      return [part(new THREE.IcosahedronGeometry(0.5, 2), BODY), part(To(0.52, 0.04, 48), WHITE, 1, 0, 0, 0, Math.PI / 2)];
    },
    /* clean guest orbs (2026-10-07, wall): at host-stop distance the guest
       models read as confetti; a smooth sphere in the category colour with a
       thin lit equator (container) or a tilted lit ring (VM) reads as an
       ordered set. Not in the manifest, so always this placeholder. */
    orb_lxc: function () {
      return [part(new THREE.IcosahedronGeometry(0.62, 3), BODY), part(To(0.63, 0.025, 48), WHITE, 0.55, 0, 0, 0, Math.PI / 2)];
    },
    orb_vm: function () {
      return [part(new THREE.IcosahedronGeometry(0.56, 3), BODY), part(To(0.86, 0.03, 56), WHITE, 0.7, 0, 0, 0, Math.PI / 2 - 0.42, 0.25)];
    },
    unknown: function () {           // a faceted crystal with a lit girdle: an
                                     // honest "we do not know", not a smudge
      var g = new THREE.OctahedronGeometry(0.5, 0); g.scale(0.8, 1.15, 0.8);
      return [part(g, BODY), part(To(0.33, 0.05, 24), WHITE, 1, 0, 0, 0, Math.PI / 2)];
    }
  };
  var HUB_KIND = { gateway: 'gateway', 'switch': 'switch', ap: 'ap', pvehost: 'pve_host', pve_host: 'pve_host',
                   external: 'storage', nvr: 'storage', storage: 'storage' };

  function placeholderData(cls) { cls = String(cls).replace(/_hub$/, ''); return merge((PH[cls] || PH.unknown)()); }

  /* ------------------------------------------------------------------ */
  /* procedural matcap: soft key from the upper left, cool fill, a little */
  /* specular and a rim - a neutral studio sphere                        */
  /* ------------------------------------------------------------------ */
  function proceduralMatcap() {
    var S = 256, cv = document.createElement('canvas'); cv.width = cv.height = S;
    var x = cv.getContext('2d'), im = x.createImageData(S, S), d = im.data;
    var L = [-0.45, 0.62, 0.64], ll = Math.hypot(L[0], L[1], L[2]); L = [L[0] / ll, L[1] / ll, L[2] / ll];
    var F = [0.6, -0.3, 0.75], fl = Math.hypot(F[0], F[1], F[2]); F = [F[0] / fl, F[1] / fl, F[2] / fl];
    for (var j = 0; j < S; j++) for (var i = 0; i < S; i++) {
      var u = (i + 0.5) / S * 2 - 1, v = 1 - (j + 0.5) / S * 2, r2 = u * u + v * v, o = (j * S + i) * 4;
      if (r2 > 1) { r2 = 1; }
      var z = Math.sqrt(Math.max(0, 1 - r2));
      var nd = Math.max(0, u * L[0] + v * L[1] + z * L[2]);
      var fd = Math.max(0, u * F[0] + v * F[1] + z * F[2]);
      var hz = z + L[2], hx = u * 0 + L[0], hy = L[1];                 // half vector-ish towards the viewer
      var hv = (u * hx + v * hy + z * hz) / Math.hypot(hx, hy, hz);
      var sp = Math.pow(Math.max(0, hv), 60) * 0.55;
      var rim = Math.pow(1 - z, 2.5) * 0.35;
      var base = 0.16 + 0.62 * nd + 0.14 * fd;
      d[o] = Math.min(255, 255 * (base * 0.96 + sp + rim * 0.55));
      d[o + 1] = Math.min(255, 255 * (base * 0.99 + sp + rim * 0.75));
      d[o + 2] = Math.min(255, 255 * (base * 1.06 + sp + rim * 1.0));
      d[o + 3] = 255;
    }
    x.putImageData(im, 0, 0);
    var t = new THREE.CanvasTexture(cv);
    t.minFilter = THREE.LinearFilter; t.generateMipmaps = false;
    return t;
  }

  /* ------------------------------------------------------------------ */
  /* shaders                                                             */
  /* ------------------------------------------------------------------ */
  var COMMON_FS = [
    'uniform sampler2D uMatcap; uniform float uGlowGain; uniform float uRim; uniform float uBodyGain; uniform float uGlowWhite;',
    'uniform float fogDensity;',
    'varying vec3 vN; varying vec3 vV; varying vec3 vBase; varying vec3 vTint; varying float vGlow;',
    'varying float vAct; varying float vLvl; varying float vDesat; varying float vFog; varying float vPulse;',
    'void main(){',
    '  vec3 n = normalize(vN);',
    /* backfaces of thin parts: flip so they shade, not punch black holes */
    '  if (!gl_FrontFacing) n = -n;',
    /* three's MeshMatcapMaterial uv (the maths models/preview.html uses) */
    '  vec3 vd = normalize(vV);',
    '  vec3 xx = normalize(vec3(vd.z, 0.0, -vd.x));',
    '  vec3 yy = cross(vd, xx);',
    '  vec3 mc = texture2D(uMatcap, vec2(dot(xx, n), dot(yy, n)) * 0.495 + 0.5).rgb;',
    '  vec3 col = vBase * mc * uBodyGain;',
    '  float fr = pow(1.0 - clamp(dot(n, normalize(vV)), 0.0, 1.0), 3.0);',
    '  col += vTint * fr * uRim;',
    /* emissive keeps the part's own colour (an LED stays green), lifted
       toward white so it - and only it - crosses the bloom threshold */
    '  vec3 gc = mix(vBase, vec3(1.0), uGlowWhite) * (0.7 + 0.3 * vPulse) * uGlowGain;',
    /* activity (motion.js brightness) drives the emissive parts fully, the
       solid body only partly: a solid idle body must still read as an object */
    '  col *= 0.3 + 0.7 * vAct;',
    '  col = mix(col, gc * vAct, clamp(vGlow, 0.0, 1.0));',
    '  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));',
    '  col = mix(col, vec3(l) * 0.8, vDesat);',
    '  col *= vLvl;',
    '  float f = 1.0 - exp(-fogDensity * fogDensity * vFog * vFog);',
    '  col *= 1.0 - clamp(f, 0.0, 0.85);',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  var INST_VS = [
    'attribute vec3 aCol; attribute float aGlow;',
    'attribute vec4 iPos; attribute vec4 iTint; attribute vec4 iMot; attribute vec4 iSt; attribute vec2 iLife;',
    'uniform float uTime; uniform float uClock; uniform float uOrbitR; uniform float uPx; uniform float uMinPx;',
    'uniform vec3 uSpinAxis; uniform float uPulseDepth; uniform float uTintMix; uniform float uFace; uniform vec2 uNear;',
    'varying vec3 vN; varying vec3 vV; varying vec3 vBase; varying vec3 vTint; varying float vGlow;',
    'varying float vAct; varying float vLvl; varying float vDesat; varying float vFog; varying float vPulse;',
    'vec3 rot(vec3 v, vec3 k, float a){ float c = cos(a), s = sin(a); return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c); }',
    'void main(){',
    /* epicycle about the slot (motion.js orbitOmega), x/z circle + a small bob */
    '  float phi = iMot.y + iMot.x * uTime;',
    '  vec3 c = iPos.xyz + uOrbitR * vec3(cos(phi), 0.28 * sin(phi + iMot.w), sin(phi));',
    '  float foc = iSt.z;',
    '  float born = clamp((uClock - iLife.x) / ' + BIRTH_S.toFixed(2) + ', 0.0, 1.0);',
    '  float dead = clamp((uClock - iLife.y) / ' + DEATH_S.toFixed(2) + ', 0.0, 1.0);',
    '  float app = born * born * (3.0 - 2.0 * born) * (1.0 - dead * dead * (3.0 - 2.0 * dead));',
    '  float r = iPos.w * (0.55 + 0.45 * foc);',
    /* per-body fade (B.vis, nexus): iSt.w = 1 - vis, 0 for every wall body */
    '  float hid = iSt.w;',
    '  if (hid > 0.0) r *= hid > 0.996 ? 0.0 : mix(1.0, 0.6, hid);',
    '  vec4 mc = modelViewMatrix * vec4(c, 1.0);',
    '  float depth = max(1.0, -mc.z);',
    /* a body the camera flies past shrinks away instead of filling the frame */
    '  r *= smoothstep(uNear.x, uNear.y, depth);',
    /* px floor on the radius (CSS px), eased with focus like the sprites */
    '  float rpx = r * uPx / depth, minR = 0.5 * uMinPx * (0.5 + 0.5 * foc);',
    '  if (rpx < minR) r *= minR / max(rpx, 1e-4);',
    '  r *= app;',
    /* face_camera models (a front-facing glyph): wobble +-20 deg, never turn */
    '  float ang = uFace > 0.5 ? 0.35 * sin(iMot.w + 2.5 * iMot.z * uTime) : iMot.w + iMot.z * uTime;',
    '  vec3 p = rot(position, uSpinAxis, ang);',
    '  vec3 nn = rot(normal, uSpinAxis, ang);',
    '  vec4 mv = modelViewMatrix * vec4(c + p * r, 1.0);',
    '  vN = normalize(normalMatrix * nn);',
    '  vV = normalize(-mv.xyz);',
    '  float pul = iTint.w > 0.0 ? sin(6.2831853 * uTime / iTint.w + iMot.w) : 0.0;',
    '  vPulse = 0.5 + 0.5 * pul;',
    '  vBase = aCol * mix(vec3(1.0), iTint.rgb, uTintMix); vTint = iTint.rgb; vGlow = aGlow;',
    '  vAct = iSt.x * (1.0 + uPulseDepth * pul);',
    '  vLvl = (0.25 + 0.75 * foc) * (0.35 + 0.65 * app);',
    '  if (hid > 0.0) vLvl *= 1.0 - hid;',
    '  vDesat = iSt.y; vFog = -mv.z;',
    '  gl_Position = projectionMatrix * mv;',
    '}'
  ].join('\n');

  var HUB_VS = [
    'attribute vec3 aCol; attribute float aGlow;',
    'uniform vec3 uTint; uniform float uTintMix; uniform float uBright; uniform float uDesat; uniform float uTime; uniform float uPulse; uniform float uLvl;',
    'varying vec3 vN; varying vec3 vV; varying vec3 vBase; varying vec3 vTint; varying float vGlow;',
    'varying float vAct; varying float vLvl; varying float vDesat; varying float vFog; varying float vPulse;',
    'void main(){',
    '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
    '  vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz);',
    '  vBase = aCol * mix(vec3(1.0), uTint, uTintMix); vTint = uTint; vGlow = aGlow;',
    '  vPulse = uPulse > 0.0 ? 0.5 + 0.5 * sin(6.2831853 * uTime / uPulse) : 1.0;',
    '  vAct = uBright; vLvl = uLvl; vDesat = uDesat; vFog = -mv.z;',
    '  gl_Position = projectionMatrix * mv;',
    '}'
  ].join('\n');


  /* ==================================================================== */
  /* CELESTIAL LOOK. Class models read as toy icons at a distance, so     */
  /* every device is drawn as a plausible celestial body:                  */
  /* a planet, moon or small body; hubs are stars. Class is carried by      */
  /* restrained physical cues only - size (caller), surface type, colour    */
  /* temperature, a subtle ring, an atmosphere rim - and identity by the    */
  /* label. One shading model for both screens: a single view-space key     */
  /* light with a soft terminator, the same for every body, so the whole    */
  /* estate reads as one lit star system.                                   */
  /*                                                                        */
  /* Surfaces are procedural until static/assets/celestial/manifest.json    */
  /* (contracts section 5, Blender/Cycles) lands; then each class samples   */
  /* its equirect surface (and ring strip) instead, in place, polled.       */
  /* Instancing and the API are unchanged: one draw per class.              */
  /* ==================================================================== */
  var KIND_IDX = { rocky: 0, moon: 1, ice: 2, gas: 3, lava: 4, ocean: 5, metal: 6, star: 7 };
  /* procedural defaults; static/assets/celestial/manifest.json "classes"
     (surface / ring / glow / atmos / size / brightness) overrides them */
  var CEL = {
    pve_host:  { kind: 'star', temp: [1.00, 0.88, 0.70], glow: 'corona', glowK: 0.50, glowR: 5.2, size: 3.0 },   // a galaxy's core
    gateway:   { kind: 'star', temp: [1.00, 0.92, 0.80], glow: 'corona', glowK: 0.30, glowR: 3.8, size: 1.5 },   // the bright home star
    'switch':  { kind: 'star', temp: [1.00, 0.86, 0.62], glow: 'pulsar', glowK: 0.40, glowR: 5.0, size: 0.9 },   // a smaller sun with slow beams
    ap:        { kind: 'star', temp: [1.00, 0.62, 0.42], glow: 'halo',   glowK: 0.35, glowR: 3.0, size: 0.7 },   // red dwarf
    network_device: { kind: 'star', temp: [1.00, 0.60, 0.42], size: 0.55, starGain: 0.75 },
    storage:   { kind: 'gas',   ring: [1.25, 2.3], tintMix: 0.10, atmos: 0.30, size: 1.25 },
    server:    { kind: 'gas',   tintMix: 0.12, atmos: 0.32, size: 1.25 },
    guest_vm:  { kind: 'rocky', tintMix: 0.62, atmos: 0.30, size: 0.7, guest: true },     // rocky planets, category-tinted
    guest_lxc: { kind: 'moon',  tintMix: 0.60, atmos: 0.18, size: 0.45, guest: true },    // moons, category-tinted
    computer:  { kind: 'ocean', tintMix: 0.10, atmos: 0.42, size: 0.9 },
    game_console: { kind: 'lava', tintMix: 0.10, atmos: 0.20, size: 0.75 },
    phone:     { kind: 'ice',   tintMix: 0.12, atmos: 0.25, size: 0.42 },
    tablet:    { kind: 'ice',   tintMix: 0.12, atmos: 0.25, size: 0.5 },
    tv_av:     { kind: 'gas',   ring: [1.4, 2.6], tintMix: 0.10, atmos: 0.30, size: 1.0 },
    iot:       { kind: 'moon',  tintMix: 0.10, atmos: 0.10, size: 0.32 },
    appliance: { kind: 'rocky', tintMix: 0.10, atmos: 0.10, size: 0.36 },
    camera:    { kind: 'metal', tintMix: 0.10, atmos: 0.12, size: 0.45 },
    printer:   { kind: 'rocky', tintMix: 0.12, atmos: 0.18, size: 0.5 },
    edge:      { kind: 'star',  temp: [0.80, 0.86, 1.00], glow: 'halo', glowK: 0.30, glowR: 3.0, size: 0.8, dark: 0.7 },
    unknown:   { kind: 'moon',  tintMix: 0.05, atmos: 0.05, size: 0.4, dark: 0.6 }   // dim, cratered: honest, not a smudge
  };
  function celOf(cls) { cls = String(cls).replace(/_hub$/, ''); return CEL[cls] || CEL.unknown; }
  /* a unit body: a sphere (radius 0.9, or 1/outer when ringed so the ring's
     outer edge sits at 1) plus an optional flat ring annulus marked aGlow = -1 */
  function celestialData(cls, ringDims) {
    var c = celOf(cls), rd = ringDims || c.ring, parts = [];
    var pr = rd ? 1 / rd[1] : 0.9;
    parts.push(part(new THREE.SphereGeometry(pr, 40, 24), WHITE, 0));
    if (rd) {
      var rg = new THREE.RingGeometry(rd[0] / rd[1], 1.0, 96, 1);
      rg.rotateX(-Math.PI / 2);
      parts.push(part(rg, WHITE, -1));
    }
    var d = merge(parts); d.ringIn = rd ? rd[0] / rd[1] : 0; d.planetR = pr;
    return d;
  }
  var CEL_COMMON = [
    'float h3(vec3 p){ p = fract(p * vec3(0.1031, 0.1030, 0.0973)); p += dot(p, p.yxz + 33.33); return fract((p.x + p.y) * p.z); }',
    'float vn(vec3 x){ vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(mix(h3(i), h3(i + vec3(1,0,0)), f.x), mix(h3(i + vec3(0,1,0)), h3(i + vec3(1,1,0)), f.x), f.y),',
    '             mix(mix(h3(i + vec3(0,0,1)), h3(i + vec3(1,0,1)), f.x), mix(h3(i + vec3(0,1,1)), h3(i + vec3(1,1,1)), f.x), f.y), f.z); }',
    'float fbm(vec3 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 3; i++) { s += a * vn(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }'
  ].join('\n');
  var CEL_FS = [
    '#ifdef GL_OES_standard_derivatives',
    '#extension GL_OES_standard_derivatives : enable',
    '#endif',
    'uniform float uKind; uniform vec3 uTemp; uniform float uTintMix; uniform float uStarGain; uniform float uBodyGain;',
    'uniform float uHasTex; uniform sampler2D uSurf; uniform float uHasNrm; uniform sampler2D uNrm; uniform float uHasEmis; uniform sampler2D uEmis;',
    'uniform float uHasRingTex; uniform sampler2D uRingTex; uniform float uRingIn;',
    'uniform float uAtmosK; uniform vec3 uAtmosRGB; uniform float uAtmosUse; uniform float uDark; uniform float uTime; uniform float fogDensity;',
    'uniform float uExpo; uniform float uTintable;',
    'varying vec3 vN; varying vec3 vV; varying vec3 vBase; varying vec3 vTint; varying float vGlow;',
    'varying float vAct; varying float vLvl; varying float vDesat; varying float vFog; varying float vPulse;',
    'varying vec3 vObj; varying float vSeed; varying vec3 vT;',
    CEL_COMMON,
    'vec3 procSurf(vec3 d, vec3 q){',
    '  float k = uKind;',
    '  if (k < 0.5) { float f = fbm(q * 1.5); return vec3(0.50 + 0.50 * f) * vec3(1.0, 0.95, 0.88); }',
    '  if (k < 1.5) { float f = fbm(q * 2.2); float cr = smoothstep(0.66, 0.74, vn(q * 4.5)); return vec3(0.60 + 0.34 * f - 0.20 * cr); }',
    '  if (k < 2.5) { float f = fbm(q * 2.6); float pol = smoothstep(0.55, 0.88, abs(d.y)); return mix(vec3(0.76 + 0.16 * f), vec3(0.97), pol); }',
    '  if (k < 3.5) { float lat = d.y + 0.10 * (fbm(q * 1.6) - 0.5); float b = sin(lat * 10.0 + 1.6 * fbm(q * 0.9));',
    '                 return vec3(0.70 + 0.17 * b + 0.07 * sin(lat * 29.0)) * vec3(1.0, 0.95, 0.86); }',
    '  if (k < 4.5) { float f = fbm(q * 2.3); return vec3(0.26 + 0.20 * f) * vec3(1.0, 0.9, 0.85); }',
    '  if (k < 5.5) { float f = fbm(q * 1.3); float land = smoothstep(0.50, 0.55, f);',
    '                 return mix(vec3(0.42, 0.56, 0.74), vec3(0.70, 0.66, 0.55), land); }',
    '  if (k < 6.5) { float f = vn(q * 7.0); return vec3(0.62 + 0.16 * f); }',
    '  return vec3(1.0);',
    '}',
    'void main(){',
    '  vec3 n = normalize(vN); if (!gl_FrontFacing) n = -n;',
    '  vec3 v = normalize(vV);',
    '  vec3 L = normalize(vec3(-0.45, 0.50, 0.74));',
    '  vec3 tint = vTint; float tl = max(0.25, dot(tint, vec3(0.2126, 0.7152, 0.0722)));',
    '  vec3 col;',
    '  if (vGlow < -0.5) {',                                               // ring
    '    float r = length(vObj.xz), t = clamp((r - uRingIn) / max(0.05, 1.0 - uRingIn), 0.0, 1.0);',
    '    vec4 rt;',
    '    if (uHasRingTex > 0.5) rt = texture2D(uRingTex, vec2(t, 0.5));',
    '    else rt = vec4(vec3(0.80, 0.78, 0.72), (0.55 + 0.45 * sin(t * 37.0 + 2.0 * sin(t * 9.0))) * smoothstep(0.0, 0.10, t) * smoothstep(1.0, 0.80, t));',
    '    if (rt.a < 0.30) discard;',
    '    col = mix(rt.rgb, rt.rgb * tint / tl * 0.8, uTintMix) * rt.a * (0.40 + 0.45 * abs(dot(n, L))) * uBodyGain;',
    '  } else {',
    '    vec3 d = normalize(vObj);',
    '    vec3 q = d * 2.2 + vSeed * vec3(1.7, 9.2, 3.1);',
    '    vec2 uv = vec2(0.0);',
    '    if (uHasTex > 0.5) {',
    /* equirect lookup with Tarini's seam fix (pick the u whose derivative is continuous) */
    '      float u1 = fract(atan(d.z, d.x) / 6.2831853 + 0.5), u2 = fract(u1 + 0.5) - 0.5;',
    '      uv = vec2(fwidth(u1) <= fwidth(u2) + 1e-5 ? u1 : u2, asin(clamp(d.y, -1.0, 1.0)) / 3.14159265 + 0.5);',
    '      if (uHasNrm > 0.5) {',
    '        vec3 nm = texture2D(uNrm, uv).xyz * 2.0 - 1.0;',
    '        vec3 T = normalize(vT - n * dot(vT, n)), Bt = cross(T, n);',
    '        n = normalize(n * nm.z + (T * nm.x - Bt * nm.y) * 0.75);',
    '      }',
    '    }',
    '    float ndl = dot(n, L);',
    '    if (uKind > 6.5) {',                                               // star photosphere
    '      float mu = max(dot(normalize(vN), v), 0.0);',
    '      float limb = 0.40 + 0.60 * pow(mu, 0.45);',
    '      vec3 ph = uHasTex > 0.5 ? texture2D(uSurf, uv).rgb * 1.15 : uTemp * (0.84 + 0.16 * fbm(q * 5.0 + uTime * 0.04));',
    '      col = ph * limb * uStarGain;',
    '    } else {',
    '      vec3 alb;',
    '      if (uHasTex > 0.5) {',
    '        vec3 tx = texture2D(uSurf, uv).rgb;',
    /* tintable plates (guest moons / rocks) are neutral: MULTIPLY by the category colour;
       other plates keep their own colour, tinted lightly; exposure-matched by the plate's mean luma */
    '        alb = uTintable > 0.5 ? mix(tx, tx * tint / tl, uTintMix) : mix(tx, vec3(dot(tx, vec3(0.2126, 0.7152, 0.0722))) * tint / tl * 0.95, uTintMix);',
    '        alb *= uExpo;',
    '      } else {',
    '        alb = procSurf(d, q) * mix(vec3(1.0), tint / max(0.3, tl) * 0.62, uTintMix);',
    '      }',
    '      alb *= uDark;',
    '      float diff = smoothstep(-0.20, 0.95, ndl);',
    '      col = alb * (0.09 + 1.0 * diff) * uBodyGain;',
    '      if (uHasEmis > 0.5) col += texture2D(uEmis, uv).rgb * (0.55 + 0.45 * (1.0 - diff));',   // lava glows, most on the night side
    '      else if (uKind > 3.5 && uKind < 4.5 && uHasTex < 0.5) col += vec3(1.0, 0.42, 0.12) * smoothstep(0.56, 0.60, fbm(q * 2.3)) * (1.0 - smoothstep(0.60, 0.66, fbm(q * 2.3))) * 0.9;',
    '      if (uKind > 4.5) col += vec3(0.9) * pow(max(dot(reflect(-L, n), v), 0.0), 28.0) * (uKind > 5.5 ? 0.30 : 0.22);',
    '      float fr = pow(1.0 - max(dot(normalize(vN), v), 0.0), 2.6);',
    '      vec3 atm = mix(mix(vec3(0.55, 0.70, 1.0), tint, 0.65), uAtmosRGB, uAtmosUse);',
    '      col += atm * fr * uAtmosK * (0.20 + 0.80 * smoothstep(-0.35, 0.60, ndl));',
    '    }',
    '  }',
    '  col *= 0.42 + 0.58 * vAct;',
    '  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));',
    '  col = mix(col, vec3(l) * 0.8, vDesat);',
    '  col *= vLvl;',
    '  float f = 1.0 - exp(-fogDensity * fogDensity * vFog * vFog);',
    '  col *= 1.0 - clamp(f, 0.0, 0.85);',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');
  /* ==================================================================== */
  /* PHOTO LOOK (opt-in: create({ photo: true })). Goal: a real galaxy,    */
  /* not a 3D render, with planets that mesh with the background. Three     */
  /* changes, all in the                                                    */
  /* same instanced draws:                                                  */
  /*  - LIT BY THEIR STAR. Each body carries the world position of its      */
  /*    system's star (the host core, the switch star, the gateway: the     */
  /*    caller passes it per body, B.lights) and a colour code; the shader  */
  /*    lights it from there: a day side, a night side, a soft terminator,  */
  /*    an atmosphere that peaks at the LIT limb (and a thin forward-       */
  /*    scatter crescent when the star is behind it), no view-space key     */
  /*    light, no matcap, no rim outline on the dark side.                  */
  /*  - LEVEL OF DETAIL BY SCREEN SIZE. Below ~uLod.x px of radius a body   */
  /*    is a STAR: one extra instanced draw of camera-facing quads with a   */
  /*    photographic PSF (gaussian core + faint halo, diffraction spikes    */
  /*    only on the brightest), tinted by its colour, additive like the     */
  /*    galaxy's own stars. Between uLod.x and uLod.y the sphere grows in   */
  /*    as the star fades out (both continuous in px size: no popping).     */
  /*    There is no px floor in this mode: a far body is a point of light,  */
  /*    not an inflated sphere.                                             */
  /*  - ONE PIPELINE. Everything is linear HDR (the page tone-maps once);   */
  /*    stars and photospheres are the bright things, so they alone bloom;  */
  /*    distance haze fades toward the sky's own faint glow, not to black.  */
  /* ==================================================================== */
  var PHOTO_FS = [
    '#ifdef GL_OES_standard_derivatives',
    '#extension GL_OES_standard_derivatives : enable',
    '#endif',
    'uniform float uKind; uniform vec3 uTemp; uniform float uTintMix; uniform float uStarGain; uniform float uBodyGain;',
    'uniform float uHasTex; uniform sampler2D uSurf; uniform float uHasNrm; uniform sampler2D uNrm; uniform float uHasEmis; uniform sampler2D uEmis;',
    'uniform float uHasRingTex; uniform sampler2D uRingTex; uniform float uRingIn;',
    'uniform float uAtmosK; uniform vec3 uAtmosRGB; uniform float uAtmosUse; uniform float uDark; uniform float uTime; uniform float fogDensity;',
    'uniform float uExpo; uniform float uTintable; uniform float uSun; uniform vec3 uAmb; uniform vec3 uHaze; uniform float uHazeK;',
    'varying vec3 vN; varying vec3 vV; varying vec3 vBase; varying vec3 vTint; varying float vGlow;',
    'varying float vAct; varying float vLvl; varying float vDesat; varying float vFog; varying float vPulse;',
    'varying vec3 vObj; varying float vSeed; varying vec3 vT; varying vec3 vLv; varying vec3 vLc;',
    CEL_COMMON,
    'vec3 procSurf(vec3 d, vec3 q){',
    '  float k = uKind;',
    '  if (k < 0.5) { float f = fbm(q * 1.5); return vec3(0.50 + 0.50 * f) * vec3(1.0, 0.95, 0.88); }',
    '  if (k < 1.5) { float f = fbm(q * 2.2); float cr = smoothstep(0.66, 0.74, vn(q * 4.5)); return vec3(0.60 + 0.34 * f - 0.20 * cr); }',
    '  if (k < 2.5) { float f = fbm(q * 2.6); float pol = smoothstep(0.55, 0.88, abs(d.y)); return mix(vec3(0.76 + 0.16 * f), vec3(0.97), pol); }',
    '  if (k < 3.5) { float lat = d.y + 0.10 * (fbm(q * 1.6) - 0.5); float b = sin(lat * 10.0 + 1.6 * fbm(q * 0.9));',
    '                 return vec3(0.70 + 0.17 * b + 0.07 * sin(lat * 29.0)) * vec3(1.0, 0.95, 0.86); }',
    '  if (k < 4.5) { float f = fbm(q * 2.3); return vec3(0.26 + 0.20 * f) * vec3(1.0, 0.9, 0.85); }',
    '  if (k < 5.5) { float f = fbm(q * 1.3); float land = smoothstep(0.50, 0.55, f);',
    '                 return mix(vec3(0.42, 0.56, 0.74), vec3(0.70, 0.66, 0.55), land); }',
    '  if (k < 6.5) { float f = vn(q * 7.0); return vec3(0.62 + 0.16 * f); }',
    '  return vec3(1.0);',
    '}',
    'void main(){',
    '  vec3 n = normalize(vN); if (!gl_FrontFacing) n = -n;',
    '  vec3 v = normalize(vV);',
    '  vec3 L = dot(vLv, vLv) > 1e-8 ? normalize(vLv) : vec3(0.0, 0.0, 1.0);',
    '  vec3 tint = vTint; float tl = max(0.25, dot(tint, vec3(0.2126, 0.7152, 0.0722)));',
    '  vec3 col;',
    '  if (vGlow < -0.5) {',                                               // ring: lit from either face
    '    float r = length(vObj.xz), t = clamp((r - uRingIn) / max(0.05, 1.0 - uRingIn), 0.0, 1.0);',
    '    vec4 rt;',
    '    if (uHasRingTex > 0.5) rt = texture2D(uRingTex, vec2(t, 0.5));',
    '    else rt = vec4(vec3(0.80, 0.78, 0.72), (0.55 + 0.45 * sin(t * 37.0 + 2.0 * sin(t * 9.0))) * smoothstep(0.0, 0.10, t) * smoothstep(1.0, 0.80, t));',
    '    if (rt.a < 0.30) discard;',
    '    vec3 ra = mix(rt.rgb, rt.rgb * tint / tl * 0.8, uTintMix) * rt.a;',
    '    col = ra * (vLc * uSun * (0.18 + 0.62 * abs(dot(n, L))) + uAmb) * uBodyGain;',
    '  } else {',
    '    vec3 d = normalize(vObj);',
    '    vec3 q = d * 2.2 + vSeed * vec3(1.7, 9.2, 3.1);',
    '    vec2 uv = vec2(0.0);',
    '    if (uHasTex > 0.5) {',
    '      float u1 = fract(atan(d.z, d.x) / 6.2831853 + 0.5), u2 = fract(u1 + 0.5) - 0.5;',
    '      uv = vec2(fwidth(u1) <= fwidth(u2) + 1e-5 ? u1 : u2, asin(clamp(d.y, -1.0, 1.0)) / 3.14159265 + 0.5);',
    '      if (uHasNrm > 0.5) {',
    '        vec3 nm = texture2D(uNrm, uv).xyz * 2.0 - 1.0;',
    '        vec3 T = normalize(vT - n * dot(vT, n)), Bt = cross(T, n);',
    '        n = normalize(n * nm.z + (T * nm.x - Bt * nm.y) * 0.75);',
    '      }',
    '    }',
    '    float mu = max(dot(normalize(vN), v), 0.0);',
    '    if (uKind > 6.5) {',                                               // a star: limb-darkened photosphere, emissive
    '      float limb = 0.30 + 0.70 * pow(mu, 0.55);',
    '      vec3 ph = uHasTex > 0.5 ? texture2D(uSurf, uv).rgb * 1.15 : uTemp * (0.84 + 0.16 * fbm(q * 5.0 + uTime * 0.04));',
    '      col = ph * limb * uStarGain;',
    '    } else {',
    '      vec3 alb;',
    '      if (uHasTex > 0.5) {',
    '        vec3 tx = texture2D(uSurf, uv).rgb;',
    '        alb = uTintable > 0.5 ? mix(tx, tx * tint / tl, uTintMix) : mix(tx, vec3(dot(tx, vec3(0.2126, 0.7152, 0.0722))) * tint / tl * 0.95, uTintMix);',
    '        alb *= uExpo;',
    '      } else {',
    '        alb = procSurf(d, q) * mix(vec3(1.0), tint / max(0.3, tl) * 0.62, uTintMix);',
    '      }',
    '      alb *= uDark;',
    '      float ndl = dot(n, L), ndl0 = dot(normalize(vN), L);',
    /* soft terminator: Lambert carried a few degrees past 90, then a narrow penumbra */
    '      float diff = max(0.0, (ndl + 0.06) / 1.06) * smoothstep(-0.14, 0.10, ndl0);',
    '      col = alb * (vLc * uSun * diff + uAmb) * uBodyGain;',
    '      if (uHasEmis > 0.5) col += texture2D(uEmis, uv).rgb * (0.30 + 0.70 * (1.0 - smoothstep(-0.1, 0.3, ndl0)));',
    '      else if (uKind > 3.5 && uKind < 4.5 && uHasTex < 0.5) col += vec3(1.0, 0.42, 0.12) * smoothstep(0.56, 0.60, fbm(q * 2.3)) * (1.0 - smoothstep(0.60, 0.66, fbm(q * 2.3))) * 0.9;',
    /* a glint on oceans and ice, from the star, only on the day side */
    '      if (uKind > 4.5) { vec3 h = normalize(L + v); col += vLc * uSun * pow(max(dot(n, h), 0.0), 60.0) * (uKind > 5.5 ? 0.35 : 0.5) * step(0.0, ndl0); }',
    /* atmosphere: peaks AT the limb, on the lit side (with a short twilight band), plus
       a forward-scatter crescent when the star is behind the planet; nothing on the night limb */
    '      float limbK = pow(1.0 - mu, 3.0);',
    '      float litLimb = smoothstep(-0.25, 0.45, ndl0);',
    '      float fwd = pow(max(dot(-v, L), 0.0), 6.0) * pow(1.0 - mu, 5.0);',
    '      vec3 atm = mix(mix(vec3(0.55, 0.70, 1.0), tint, 0.45), uAtmosRGB, uAtmosUse);',
    '      col += atm * vLc * uSun * uAtmosK * (limbK * litLimb * 1.15 + fwd * 1.6);',
    '    }',
    '  }',
    /* a planet is lit by its star whatever its traffic: activity only nudges it; down dims */
    '  col *= uKind > 6.5 ? 0.42 + 0.58 * vAct : mix(0.45, 1.0, smoothstep(0.25, 0.62, vAct));',
    '  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));',
    '  col = mix(col, vec3(l) * 0.8, vDesat);',
    '  col *= vLvl;',
    /* depth haze toward the sky's own faint glow (not to black): distant bodies sit IN the scene */
    '  float f = clamp(1.0 - exp(-fogDensity * fogDensity * vFog * vFog), 0.0, 0.85) * uHazeK;',
    '  col = col * (1.0 - f) + uHaze * f * vLvl;',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');
  /* the instanced vertex shader, photo variant: the star's direction (view space,
     per body: a planet is tiny next to its orbit), its colour, the LOD shrink and
     no px floor */
  function photoVS(vs) {
    return celVS(vs)
      .replace('attribute vec2 iLife;', 'attribute vec2 iLife; attribute vec4 iLit; uniform vec3 uLitCol[8]; uniform vec2 uLod; uniform float uLodK; uniform float uLodFoc; uniform vec3 uFallL;')
      .replace('varying float vAct;', 'varying vec3 vLv; varying vec3 vLc;\nvarying float vAct;')
      .replace('  float rpx = r * uPx / depth, minR = 0.5 * uMinPx * (0.5 + 0.5 * foc);\n  if (rpx < minR) r *= minR / max(rpx, 1e-4);',
               '  float rpx = r * uPx / depth;\n' +
               /* the subject resolves into planets; the context (off-subject, dimmed by the tour's
                  focus) stays starlight until it is much closer - no dark rocks across a frame */
               '  float lodK = uLodK * (1.0 + uLodFoc * (1.0 - foc));\n' +
               '  r *= smoothstep(uLod.x * 0.55 * lodK, uLod.y * lodK, rpx);')
      .replace('  vN = normalize(normalMatrix * nn);',
               '  vN = normalize(normalMatrix * nn);\n' +
               '  int lc = int(iLit.w + 0.5);\n' +
               '  vLv = lc > 0 ? (viewMatrix * vec4(iLit.xyz, 1.0)).xyz - mc.xyz : uFallL;\n' +
               '  vLc = uLitCol[lc];');
  }
  function photoHubVS(vs) {
    return celHubVS(vs)
      .replace('uniform float uLvl;', 'uniform float uLvl; uniform vec4 uHubLit; uniform vec3 uLitCol[8]; uniform vec3 uFallL;')
      .replace('varying float vAct;', 'varying vec3 vLv; varying vec3 vLc;\nvarying float vAct;')
      .replace('  vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz);',
               '  vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz);\n' +
               '  int lc = int(uHubLit.w + 0.5);\n' +
               '  vec3 ctr = (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;\n' +
               '  vLv = lc > 0 ? (viewMatrix * vec4(uHubLit.xyz, 1.0)).xyz - ctr : uFallL;\n' +
               '  vLc = uLitCol[lc];');
  }
  /* the far LOD: one camera-facing quad per body, a photographic point spread */
  var STAR_VS = [
    'attribute vec4 iPos; attribute vec4 iTint; attribute vec4 iMot; attribute vec4 iSt; attribute vec2 iLife; attribute vec3 iStr;',
    'uniform float uTime; uniform float uClock; uniform float uOrbitR; uniform float uPx; uniform vec2 uLod; uniform float uStarPx;',
    'uniform float uStarGain; uniform vec2 uNear; uniform float fogDensity; uniform float uHazeK; uniform float uLodFoc;',
    'varying vec2 vQ; varying vec3 vCol; varying float vSpk; varying float vCore; varying float vPx;',
    'void main(){',
    '  float phi = iMot.y + iMot.x * uTime;',
    '  vec3 c = iPos.xyz + uOrbitR * vec3(cos(phi), 0.28 * sin(phi + iMot.w), sin(phi));',
    '  float foc = iSt.z;',
    '  float born = clamp((uClock - iLife.x) / ' + BIRTH_S.toFixed(2) + ', 0.0, 1.0);',
    '  float dead = clamp((uClock - iLife.y) / ' + DEATH_S.toFixed(2) + ', 0.0, 1.0);',
    '  float app = born * born * (3.0 - 2.0 * born) * (1.0 - dead * dead * (3.0 - 2.0 * dead));',
    '  float r = iPos.w * (0.55 + 0.45 * foc);',
    '  float hid = iSt.w; float vis = hid > 0.996 ? 0.0 : 1.0 - hid;',
    '  vec4 mc = viewMatrix * vec4(c, 1.0);',
    '  float depth = max(1.0, -mc.z);',
    '  float rpx = r * uPx / depth;',
    '  float always = iStr.z > 10.0 ? 1.0 : 0.0;',
    '  float lk = iStr.z * (1.0 + uLodFoc * (1.0 - foc));',
    '  float k = (always > 0.5 ? 1.0 : 1.0 - smoothstep(uLod.x * lk, uLod.y * lk, rpx)) * app * vis * smoothstep(uNear.x * 0.6, uNear.y * 0.6, depth);',
    '  float lvl = (0.25 + 0.75 * foc);',
    '  float act = iSt.x;',
    '  vec3 tint = iTint.rgb;',
    '  float lu = dot(tint, vec3(0.2126, 0.7152, 0.0722));',
    '  tint = mix(vec3(lu), tint, 1.0 - iSt.y);',                          // down: grey
    /* brightness: activity and focus; colour kept saturated in the halo, the core whitens */
    /* stars differ: a fixed per-body factor (its seed phase) on top of activity */
    '  float mag = (0.55 + 0.75 * act) * iStr.y * (0.62 + 0.76 * fract(iMot.w * 7.31 + 0.17));',
    '  float f = clamp(1.0 - exp(-fogDensity * fogDensity * mc.z * mc.z), 0.0, 0.85) * uHazeK * 0.35;',
    '  vCol = tint / max(0.35, lu) * 0.62 * mag * lvl * k * (1.0 - f) * uStarGain;',
    '  vCore = mag;',
    '  vSpk = iStr.x;',
    /* a star that comes close does not resolve into a coin: its PSF widens and brightens */
    '  float nearPx = always * max(0.0, rpx * 1.6 - uStarPx);',
    '  float px = (uStarPx * (0.70 + 0.30 * min(1.6, mag)) + nearPx) * (iStr.x > 0.01 ? 2.6 : 1.0);',
    '  vCol *= 1.0 + always * min(0.6, 0.5 * nearPx / max(1.0, uStarPx));',
    '  vQ = position.xy; vPx = px;',
    /* in front of its own (shrinking) sphere so the depth test never hides it */
    '  vec3 toCam = -mc.xyz / max(1e-3, length(mc.xyz));',
    '  mc.xyz += toCam * r * 1.25;',
    '  mc.xy += position.xy * px * depth / uPx;',
    '  gl_Position = k < 0.002 ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * mc;',
    '}'].join('\n');
  var STAR_FS = [
    'varying vec2 vQ; varying vec3 vCol; varying float vSpk; varying float vCore; varying float vPx;',
    'void main(){',
    '  float s = vSpk > 0.01 ? 2.6 : 1.0;',                                  // the quad is wider when it carries spikes
    '  float R = vPx / s;',                                                  // PSF radius in px
    '  float rp = length(vQ) * vPx;',                                        // this fragment's distance from the star, px
    /* PSF in pixels: a tight core (~1-2 px sigma, it barely grows: a brighter star
       saturates wider, it does not become a disc), a soft wing, an exponential halo */
    '  float sig = 0.95 + 0.045 * R;',
    '  float core = exp(-rp * rp / (2.0 * sig * sig));',
    '  float wing = 0.20 * exp(-rp * rp / (2.0 * 9.0 * sig * sig));',
    '  float halo = 0.05 * exp(-rp / max(1.0, 0.32 * R));',
    '  float spk = 0.0;',
    '  if (vSpk > 0.01) {',
    /* four thin spikes, ~1 px wide whatever the quad size (a sub-pixel line shimmers) */
    '    vec2 a = abs(vQ) * vPx;',
    '    float w = 0.75;',
    '    spk = (exp(-a.y * a.y / (2.0 * w * w)) * pow(max(0.0, 1.0 - abs(vQ.x)), 3.0) + exp(-a.x * a.x / (2.0 * w * w)) * pow(max(0.0, 1.0 - abs(vQ.y)), 3.0)) * 0.15 * vSpk;',
    '  }',
    '  float e = core + wing + halo + spk;',
    '  vec3 col = vCol * e;',
    /* the very centre runs toward white as a bright star saturates the sensor */
    '  col += vec3(dot(vCol, vec3(0.33))) * core * 0.55 * min(1.0, vCore);',
    '  col *= 1.0 - smoothstep(0.90, 1.0, length(vQ));',
    '  if (col.r + col.g + col.b < 0.0015) discard;',
    '  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);',
    '}'].join('\n');
  function celVS(vs) {
    return vs
      .replace('varying float vAct;', 'varying vec3 vObj; varying float vSeed; varying vec3 vT; uniform float uTilt;\nvarying float vAct;')
      .replace('  vec3 nn = rot(normal, uSpinAxis, ang);',
               '  vec3 nn = rot(normal, uSpinAxis, ang);\n' +
               '  vec3 tt = rot(normalize(vec3(-position.z, 0.0, position.x) + vec3(1e-5, 0.0, 0.0)), uSpinAxis, ang);\n' +
               '  float tilt = uTilt * (0.55 + 0.45 * sin(iMot.w * 3.7));\n' +
               '  p = rot(p, vec3(0.0, 0.0, 1.0), tilt); nn = rot(nn, vec3(0.0, 0.0, 1.0), tilt); tt = rot(tt, vec3(0.0, 0.0, 1.0), tilt);\n' +
               '  vObj = position; vSeed = fract(iMot.w * 0.1591) * 10.0; vT = normalize(normalMatrix * tt);');
  }
  function celHubVS(vs) {
    return vs
      .replace('varying float vAct;', 'varying vec3 vObj; varying float vSeed; varying vec3 vT;\nvarying float vAct;')
      .replace('  vec4 mv = modelViewMatrix * vec4(position, 1.0);', '  vec4 mv = modelViewMatrix * vec4(position, 1.0);\n' +
               '  vObj = position; vSeed = 3.3; vT = normalize(normalMatrix * normalize(vec3(-position.z, 0.0, position.x) + vec3(1e-5, 0.0, 0.0)));');
  }
  var _glowTex = {};
  function glowTexProc(kind) {
    if (_glowTex[kind]) return _glowTex[kind];
    var s = 256, cv = document.createElement('canvas'); cv.width = cv.height = s;
    var x = cv.getContext('2d'), im = x.createImageData(s, s), d = im.data;
    for (var j = 0; j < s; j++) for (var i = 0; i < s; i++) {
      var u = (i + 0.5) / s * 2 - 1, v = (j + 0.5) / s * 2 - 1, r = Math.sqrt(u * u + v * v), o = (j * s + i) * 4, a;
      if (kind === 'pulsar') {           // twin soft beams along +Y, fading out
        var bw = Math.exp(-Math.pow(u / (0.045 + 0.05 * Math.abs(v)), 2)) * Math.pow(Math.max(0, 1 - Math.abs(v)), 1.6);
        a = r >= 1 ? 0 : bw * 0.55 + Math.exp(-r * 9) * 0.5;
      } else if (kind === 'spikes') {    // photo glare: four thin diffraction spikes + a faint veiling halo
        var au = Math.abs(u), av = Math.abs(v), sw = 0.010;
        var sx = Math.exp(-av * av / (2 * sw * sw)) * Math.pow(Math.max(0, 1 - au), 2.6);
        var sy = Math.exp(-au * au / (2 * sw * sw)) * Math.pow(Math.max(0, 1 - av), 2.6);
        a = r >= 1 ? 0 : Math.min(1, (sx + sy) * 0.85 + Math.exp(-r * 14) * 0.35 + Math.exp(-r * 4.5) * 0.05 * (1 - r));
      } else {                            // corona / halo: steep inner glow + long faint tail
        a = r >= 1 ? 0 : (Math.exp(-r * (kind === 'halo' ? 5 : 7.5)) * 0.85 + Math.exp(-r * 2.6) * 0.22) * (1 - r * r);
      }
      d[o] = d[o + 1] = d[o + 2] = 255; d[o + 3] = Math.round(Math.min(1, a) * 255);
    }
    x.putImageData(im, 0, 0);
    _glowTex[kind] = new THREE.CanvasTexture(cv);
    return _glowTex[kind];
  }
  /* ------------------------------------------------------------------ */
  function hexRGB(h) {
    if (Array.isArray(h)) return h;
    if (typeof h === 'number') return [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];
    var s = String(h || '#ffffff').replace('#', '');
    return [parseInt(s.slice(0, 2), 16) / 255, parseInt(s.slice(2, 4), 16) / 255, parseInt(s.slice(4, 6), 16) / 255];
  }

  function create(opts) {
    opts = opts || {};
    var scene = opts.scene;
    var base = opts.assetBase || '/static/assets/universe/';
    var manUrl = opts.manifestUrl || (base + 'manifest.json');
    var POLL_MS = opts.pollMs || 30000;
    var GN = opts.gain || {};
    function gv(k, d) { return GN[k] != null ? +GN[k] : d; }
    var fogD = opts.fogDensity != null ? opts.fogDensity : (scene && scene.fog && scene.fog.density) || 0.0006;
    /* look: 'celestial' (default, 2026-10-07) or 'models' (the old class models) */
    var CELESTIAL = (opts.look || 'celestial') === 'celestial';
    var celBase = opts.celestialBase || '/static/assets/celestial/';
    var CT = { surf: {}, ring: {}, glow: {}, classes: {}, atmos: {}, sig: '' };   // celestial textures by class

    /* photo look (2026-10-08): star-lit bodies + star LOD, see PHOTO_FS. Opt-in;
       { photo: true } or { photo: { lod: [3, 6.5], starPx: 6, sun: 1.25, ... } } */
    var PHOTO = CELESTIAL && !!opts.photo;
    var PO = (opts.photo && typeof opts.photo === 'object') ? opts.photo : {};
    function pv(k, d) { return PO[k] != null ? PO[k] : d; }
    /* light colour codes (B.lights[i*4+3]): 0 = no known star (a soft view-space
       key light instead), 1 host core, 2 gateway, 3 switch star, 4 red dwarf
       (AP / small network gear), 5 distant blue-white (the Internet edge), 6 white */
    var LITCOL = [[0.86, 0.90, 1.00], [1.00, 0.86, 0.66], [0.96, 0.95, 1.00], [1.00, 0.84, 0.60],
                  [1.00, 0.66, 0.46], [0.78, 0.86, 1.00], [1.00, 1.00, 1.00], [1.00, 0.92, 0.80]];
    var B = { positions: new Float32Array(0), focus: new Float32Array(0), vis: new Float32Array(0), lights: new Float32Array(0) };
    B.look = CELESTIAL ? 'celestial' : 'models';
    B.photo = PHOTO;
    var S = {
      geo: {},           // class -> shared unit BufferGeometry (live, swappable)
      src: {},           // class -> 'placeholder' | 'blender'
      spinAxis: {},      // class -> THREE.Vector3
      matcapOf: {},      // class -> matcap name
      matcaps: {},       // name -> texture
      matcapUrl: {},     // name -> url it was loaded from
      face: {},          // class -> face_camera
      defMatcap: null,
      buckets: {},       // class -> bucket
      list: [], n: 0, keys: {}, first: true, ghosts: [],
      dyn: [],           // per index: {b, bT, d, dT}
      statusMoving: false, clock: 0, t: 0,
      hubMats: [], listeners: [], manSig: '', visible: true, glows: []
    };
    var U = {            // shared uniforms (one object, every material links it)
      uTime: { value: 0 }, uClock: { value: 0 }, uOrbitR: { value: 0 }, uPx: { value: 900 }, uMinPx: { value: 0 },
      uPulseDepth: { value: 0.12 }, fogDensity: { value: fogD }, uNear: { value: new THREE.Vector2(opts.nearFade ? opts.nearFade[0] : 70, opts.nearFade ? opts.nearFade[1] : 300) },
      /* photo look */
      uLod: { value: new THREE.Vector2((pv('lod', [3.2, 7.0]))[0], (pv('lod', [3.2, 7.0]))[1]) },
      uStarPx: { value: pv('starPx', 6.0) }, uStarGain: { value: pv('starGain', 1.6) }, uLodFoc: { value: pv('lodFocus', 0) },
      uSun: { value: pv('sun', 1.3) }, uAmb: { value: new THREE.Vector3().fromArray(pv('amb', [0.045, 0.050, 0.066])) },
      uHaze: { value: new THREE.Vector3().fromArray(pv('haze', [0.010, 0.013, 0.022])) }, uHazeK: { value: pv('hazeK', 0.55) },
      uLitCol: { value: LITCOL.map(function (c) { return new THREE.Vector3().fromArray(c); }) },
      uFallL: { value: new THREE.Vector3(-0.45, 0.50, 0.74).normalize().multiplyScalar(1000) }
    };
    B.uniforms = U;

    function matcapFor(cls) { var k = S.matcapOf[cls]; return (k && S.matcaps[k]) || S.defMatcap || (S.defMatcap = proceduralMatcap()); }

    function fillGeo(g, d) {
      g.setAttribute('position', new THREE.BufferAttribute(d.pos instanceof Float32Array ? d.pos : new Float32Array(d.pos), 3));
      g.setAttribute('normal', new THREE.BufferAttribute(d.nrm instanceof Float32Array ? d.nrm : new Float32Array(d.nrm), 3));
      g.setAttribute('aCol', new THREE.BufferAttribute(d.col instanceof Float32Array ? d.col : new Float32Array(d.col), 3));
      g.setAttribute('aGlow', new THREE.BufferAttribute(d.glow instanceof Float32Array ? d.glow : new Float32Array(d.glow), 1));
      var nv = g.attributes.position.count, I = d.idx;
      if (!(I instanceof Uint16Array || I instanceof Uint32Array)) I = new (nv > 65535 ? Uint32Array : Uint16Array)(I);
      g.setIndex(new THREE.BufferAttribute(I, 1));
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1.05);
      g.boundingBox = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
      g.userData.tris = I.length / 3;
      g.userData.shared = true;          // owners must not dispose it
    }
    function geoFor(cls) {
      if (!S.geo[cls]) {
        var g = new THREE.BufferGeometry();
        fillGeo(g, CELESTIAL ? celestialData(cls) : placeholderData(cls));
        S.geo[cls] = g; S.src[cls] = 'placeholder';
        S.spinAxis[cls] = new THREE.Vector3(0, 1, 0);
      }
      return S.geo[cls];
    }

    /* ---------------- instanced buckets (one draw per class) ---------------- */
    function bucket(cls) {
      var bk = S.buckets[cls];
      if (bk) return bk;
      var g = new THREE.InstancedBufferGeometry();
      var src = geoFor(cls);
      bk = { cls: cls, geo: g, cap: 0, n: 0, idx: [], mesh: null };
      linkBase(bk);
      var mat = CELESTIAL ? celMaterial(cls, false) : new THREE.ShaderMaterial({
        uniforms: {
          uMatcap: { value: matcapFor(cls) }, uSpinAxis: { value: S.spinAxis[cls] },
          uGlowGain: { value: gv('glow', 1.45) }, uRim: { value: gv('rim', 0.30) }, uBodyGain: { value: gv('body', 1.35) }, uGlowWhite: { value: gv('glowWhite', 0.3) },
          uTintMix: { value: gv('tintMix', 0.85) }, uFace: { value: S.face[cls] ? 1 : 0 },
          uTime: U.uTime, uClock: U.uClock, uOrbitR: U.uOrbitR, uPx: U.uPx, uMinPx: U.uMinPx,
          uPulseDepth: U.uPulseDepth, fogDensity: U.fogDensity, uNear: U.uNear
        },
        vertexShader: INST_VS, fragmentShader: COMMON_FS, side: THREE.DoubleSide
      });
      bk.mesh = new THREE.Mesh(g, mat);
      bk.mesh.frustumCulled = false;
      bk.mesh.renderOrder = opts.renderOrder || 2;
      bk.mesh.userData.universe = true; bk.mesh.userData.bodies3d = cls;
      bk.mesh.visible = S.visible;
      void src;
      S.buckets[cls] = bk;
      if (scene) scene.add(bk.mesh);
      return bk;
    }
    /* celestial material for a class: the instanced body or a hub mesh.
       CT.classes (the Blender manifest) picks surface / ring / glow / atmos;
       CEL holds the procedural fallback for every field. */
    function celSpec(cls) {
      var key = String(cls).replace(/_hub$/, ''), c = celOf(key), ct = CT.classes[key] || {};
      var surf = ct.surface && CT.surf[ct.surface], ring = ct.ring && CT.ring[ct.ring], at = ct.atmos && CT.atmos[ct.atmos];
      var kind = surf && KIND_IDX[surf.kind] != null ? KIND_IDX[surf.kind] : KIND_IDX[c.kind];
      if (key === 'guest_lxc' && kind === KIND_IDX.rocky) kind = KIND_IDX.moon;
      return { key: key, c: c, ct: ct, surf: surf, ring: ring, at: at, kind: kind, tintable: ct.tintable != null ? !!ct.tintable : !!c.guest,
               size: ct.size != null ? +ct.size : (c.size || 0.6), bright: ct.brightness != null ? +ct.brightness : (c.dark || 1),
               glow: ct.glow !== undefined ? ct.glow : (c.glow || null),
               ringDims: ring ? [ring.inner || 1.3, ring.outer || 2.2] : (ct.ring === null ? null : c.ring) };
    }
    function celUniforms(cls, hub) {
      var sp = celSpec(cls), c = sp.c, surf = sp.surf, ring = sp.ring, at = sp.at;
      var textured = !!(surf && surf.tex);
      return {
        uKind: { value: sp.kind }, uTemp: { value: new THREE.Vector3().fromArray(c.temp || [1, 1, 1]) },
        uTintMix: { value: sp.tintable ? (textured ? 0.88 : 0.62) : c.guest ? (c.tintMix != null ? c.tintMix : 0.6) : (textured ? 0.06 : (c.tintMix != null ? c.tintMix : 0.2)) },
        uStarGain: { value: gv(hub ? 'hubStar' : 'star', hub ? 1.25 : 0.92) * (c.starGain || 1) },
        uBodyGain: { value: gv('celBody', 1.05) }, uDark: { value: sp.bright },
        uHasTex: { value: textured ? 1 : 0 }, uSurf: { value: textured ? surf.tex : null },
        uHasNrm: { value: surf && surf.ntex ? 1 : 0 }, uNrm: { value: (surf && surf.ntex) || null },
        uHasEmis: { value: surf && surf.etex ? 1 : 0 }, uEmis: { value: (surf && surf.etex) || null },
        uHasRingTex: { value: ring && ring.tex ? 1 : 0 }, uRingTex: { value: (ring && ring.tex) || null },
        uRingIn: { value: sp.ringDims ? sp.ringDims[0] / sp.ringDims[1] : 0.6 },
        uAtmosK: { value: at && at.strength != null ? +at.strength * 0.8 : (c.atmos != null ? c.atmos : 0.2) },
        uAtmosRGB: { value: new THREE.Vector3().fromArray(at && at.rgb ? at.rgb : [1, 1, 1]) }, uAtmosUse: { value: at ? 0.75 : 0 },
        uTilt: { value: sp.ringDims ? 0.42 : 0.30 }, uSpinAxis: { value: new THREE.Vector3(0, 1, 0) },
        uTintable: { value: sp.tintable ? 1 : 0 },
        uExpo: { value: surf && surf.luma ? Math.pow(0.5 / Math.max(0.12, surf.luma), sp.tintable ? 0.8 : 0.45) : 1 },
        uTime: hub ? { value: 0 } : U.uTime, fogDensity: U.fogDensity
      };
    }
    function celMaterial(cls, hub) {
      var un = celUniforms(cls, hub);
      if (!hub) {
        un.uNear = U.uNear; un.uClock = U.uClock; un.uOrbitR = U.uOrbitR; un.uPx = U.uPx; un.uMinPx = U.uMinPx; un.uPulseDepth = U.uPulseDepth;
        un.uTintMix2 = { value: 0 }; un.uFace = { value: 0 };
      }
      if (PHOTO) {
        un.uSun = U.uSun; un.uAmb = U.uAmb; un.uHaze = U.uHaze; un.uHazeK = U.uHazeK; un.uLitCol = U.uLitCol; un.uFallL = U.uFallL;
        if (hub) un.uHubLit = { value: new THREE.Vector4(0, 0, 0, 0) };
        else { un.uLod = U.uLod; un.uLodFoc = U.uLodFoc; un.uLodK = { value: celSpec(cls).kind === KIND_IDX.star ? STAR_LODK : 1 }; }
        /* photospheres are the bright things of the scene now (HDR): they, and not
           the lit planets, cross the bloom threshold */
        un.uStarGain.value *= pv(hub ? 'hubStarGain' : 'bodyStarGain', hub ? 3.2 : 2.4);
      }
      var vs = hub ? (PHOTO ? photoHubVS(HUB_VS) : celHubVS(HUB_VS)) : (PHOTO ? photoVS(INST_VS) : celVS(INST_VS)).replace(/uTintMix/g, 'uTintMix2');
      var m = new THREE.ShaderMaterial({ uniforms: un, vertexShader: vs,
                                          fragmentShader: PHOTO ? PHOTO_FS : CEL_FS, side: THREE.DoubleSide });
      m.extensions = { derivatives: true };
      m.userData.cel = cls;
      return m;
    }
    /* textures arrived (or changed): refresh every live celestial material,
       and rebuild ringed geometry whose ring proportions changed */
    function celRefresh() {
      Object.keys(S.geo).forEach(function (c) {
        var sp = celSpec(c), sig = JSON.stringify(sp.ringDims || null);
        if (S.geo[c].userData.ringSig !== sig) { fillGeo(S.geo[c], celestialData(c, sp.ringDims)); S.geo[c].userData.ringSig = sig; if (S.buckets[c]) linkBase(S.buckets[c]); }
      });
      Object.keys(S.buckets).forEach(function (c) { var m = S.buckets[c].mesh.material; if (m.userData.cel) celApply(m, c, false); });
      S.hubMats.forEach(function (m) { if (m.userData.cel) celApply(m, m.userData.cel, true); });
      S.glows.forEach(function (g) {
        var t = celGlowTex(g.userData.glowKind); if (g.material.map !== t) { g.material.map = t; g.material.needsUpdate = true; }
        if (g.userData.sizeFor) { var z = g.userData.sizeFor(); g.scale.set(z, z, 1); }
      });
    }
    function celApply(m, cls, hub) {
      var nu = celUniforms(cls, hub), u = m.uniforms;
      ['uKind', 'uHasTex', 'uSurf', 'uHasNrm', 'uNrm', 'uHasEmis', 'uEmis', 'uHasRingTex', 'uRingTex', 'uRingIn', 'uAtmosK', 'uAtmosUse', 'uDark', 'uTilt', 'uTintable', 'uExpo']
        .forEach(function (k) { u[k].value = nu[k].value; });
      if (!hub) u.uTintMix.value = nu.uTintMix.value;
      u.uAtmosRGB.value.copy(nu.uAtmosRGB.value);
    }
    function celGlowTex(kind) { var g = CT.glow[kind]; return (g && g.tex) || glowTexProc(kind); }
    /* per-class facts a caller may want (sizes, glows), manifest first */
    B.celInfo = function (cls) {
      var sp = celSpec(cls), c = sp.c, at = sp.at;
      var rgb = sp.ct.glow_tint || (at && at.rgb ? at.rgb : (c.temp || [0.8, 0.85, 1.0]));
      var gl = sp.glow && CT.glow[sp.glow];
      return { size: sp.size, glow: sp.glow, glowK: c.glowK || 0.35, glowR: c.glowR || 3.2, rgb: rgb, star: sp.kind === KIND_IDX.star,
               limb: gl && gl.limb ? +gl.limb : null, tintable: sp.tintable };
    };
    B.glowTexture = function (kind) { return celGlowTex(kind || 'corona'); };
    function linkBase(bk) {
      var src = geoFor(bk.cls), g = bk.geo;
      ['position', 'normal', 'aCol', 'aGlow'].forEach(function (k) { g.setAttribute(k, src.attributes[k]); });
      g.setIndex(src.index);
    }
    function growBucket(bk, n) {
      if (n <= bk.cap) return;
      var cap = Math.max(16, Math.ceil(n * 1.5));
      bk.cap = cap;
      bk.iPos = new Float32Array(cap * 4); bk.iTint = new Float32Array(cap * 4);
      bk.iMot = new Float32Array(cap * 4); bk.iSt = new Float32Array(cap * 4); bk.iLife = new Float32Array(cap * 2);
      var g = bk.geo;
      g.setAttribute('iPos', new THREE.InstancedBufferAttribute(bk.iPos, 4).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('iTint', new THREE.InstancedBufferAttribute(bk.iTint, 4).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('iMot', new THREE.InstancedBufferAttribute(bk.iMot, 4).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('iSt', new THREE.InstancedBufferAttribute(bk.iSt, 4).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('iLife', new THREE.InstancedBufferAttribute(bk.iLife, 2).setUsage(THREE.DynamicDrawUsage));
      if (PHOTO) {
        bk.iLit = new Float32Array(cap * 4);
        g.setAttribute('iLit', new THREE.InstancedBufferAttribute(bk.iLit, 4).setUsage(THREE.DynamicDrawUsage));
        if (bk.isStar) { bk.iStr = new Float32Array(cap * 3); g.setAttribute('iStr', new THREE.InstancedBufferAttribute(bk.iStr, 3).setUsage(THREE.DynamicDrawUsage)); }
      }
    }
    function touch(bk, names) { for (var i = 0; i < names.length; i++) if (bk.geo.attributes[names[i]]) bk.geo.attributes[names[i]].needsUpdate = true; }

    /* ---------------- photo look: the far-LOD star layer ----------------
       one instanced quad per body (every class in ONE draw), same instance
       lanes as the buckets plus iStr (spikes, magnitude); indices follow the
       caller's list, then the dying ghosts */
    var STAR = null;
    /* a star-class body (switch hub, AP, small gear) stays a point of light until
       it is well resolved: its photosphere at 6 px reads as a flat coin */
    var STAR_LODK = pv('starLodK', 99);   // > 10 = never resolved (STAR_VS 'always')
    function starLayer() {
      if (STAR || !PHOTO) return STAR;
      var g = new THREE.InstancedBufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
      g.setIndex([0, 1, 2, 0, 2, 3]);
      STAR = { cls: '*star', geo: g, cap: 0, n: 0, idx: [], isStar: true };
      var mat = new THREE.ShaderMaterial({
        uniforms: { uTime: U.uTime, uClock: U.uClock, uOrbitR: U.uOrbitR, uPx: U.uPx, uLod: U.uLod, uStarPx: U.uStarPx,
                    uStarGain: U.uStarGain, uNear: U.uNear, fogDensity: U.fogDensity, uHazeK: U.uHazeK, uLodFoc: U.uLodFoc },
        vertexShader: STAR_VS, fragmentShader: STAR_FS, transparent: true, depthWrite: false, depthTest: true,
        blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
        blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor
      });
      STAR.mesh = new THREE.Mesh(g, mat);
      STAR.mesh.frustumCulled = false; STAR.mesh.renderOrder = (opts.renderOrder || 2) + 1;
      STAR.mesh.userData.universe = true; STAR.mesh.userData.bodies3d = '*star';
      STAR.mesh.visible = S.visible;
      if (scene) scene.add(STAR.mesh);
      return STAR;
    }
    /* spikes + magnitude per body: the caller's (it.spikes, it.mag), else stars
       (the switch hubs, APs, small gear) get faint spikes and a little more light */
    function starStr(it) {
      var sp = celSpec(it.cls), isStar = sp.kind === KIND_IDX.star;
      var spikes = it.spikes != null ? it.spikes : (isStar ? 0.35 : 0);
      var mag = it.mag != null ? it.mag : (isStar ? 1.3 : 1.0);
      return [spikes, mag, isStar ? STAR_LODK : 1];
    }

    /* rebuild bucket membership from the caller's list (+ ghosts) */
    function regroup() {
      var per = {}, i, cls;
      for (i = 0; i < S.n; i++) { cls = S.list[i].cls; (per[cls] = per[cls] || []).push(i); }
      for (i = 0; i < S.ghosts.length; i++) { cls = S.ghosts[i].cls; (per[cls] = per[cls] || []).push(-1 - i); }
      Object.keys(S.buckets).forEach(function (c) { if (!per[c]) { S.buckets[c].n = 0; S.buckets[c].idx = []; S.buckets[c].geo.instanceCount = 0; S.buckets[c].mesh.visible = false; } });
      Object.keys(per).forEach(function (c) {
        var bk = bucket(c), ids = per[c];
        growBucket(bk, ids.length);
        bk.idx = ids; bk.n = ids.length; bk.geo.instanceCount = ids.length;
        bk.mesh.visible = S.visible && ids.length > 0;
        for (var k = 0; k < ids.length; k++) writeAll(bk, k);
        touch(bk, ['iPos', 'iTint', 'iMot', 'iSt', 'iLife', 'iLit']);
      });
      if (PHOTO) {
        var SL = starLayer(), all = [];
        for (i = 0; i < S.n; i++) all.push(i);
        for (i = 0; i < S.ghosts.length; i++) all.push(-1 - i);
        growBucket(SL, all.length);
        SL.idx = all; SL.n = all.length; SL.geo.instanceCount = all.length;
        SL.mesh.visible = S.visible && all.length > 0;
        for (var k2 = 0; k2 < all.length; k2++) writeAll(SL, k2);
        touch(SL, ['iPos', 'iTint', 'iMot', 'iSt', 'iLife', 'iLit', 'iStr']);
      }
      S.slotOf = new Int32Array(S.n * 2 + 2);
      Object.keys(S.buckets).forEach(function (c) {
        var bk = S.buckets[c];
        for (var k = 0; k < bk.n; k++) { var j = bk.idx[k]; if (j >= 0) { S.slotOf[j * 2] = CLASSES.indexOf(c); S.slotOf[j * 2 + 1] = k; } }
      });
    }
    function writeAll(bk, k) {
      var j = bk.idx[k], o4 = k * 4, it, P, f, life, dy;
      var vs;
      if (j >= 0) { it = S.list[j]; P = B.positions; f = B.focus[j]; dy = S.dyn[j]; life = it._life; vs = B.vis[j]; }
      else { var gh = S.ghosts[-1 - j]; it = gh.it; P = null; f = gh.f; dy = gh.dyn; life = gh.life; vs = gh.v; }
      if (P) { bk.iPos[o4] = P[j * 3]; bk.iPos[o4 + 1] = P[j * 3 + 1]; bk.iPos[o4 + 2] = P[j * 3 + 2]; }
      else { bk.iPos[o4] = it._gx; bk.iPos[o4 + 1] = it._gy; bk.iPos[o4 + 2] = it._gz; }
      bk.iPos[o4 + 3] = it.radius || 8;
      var tn = it.tint || [0.6, 0.7, 0.8];
      bk.iTint[o4] = tn[0]; bk.iTint[o4 + 1] = tn[1]; bk.iTint[o4 + 2] = tn[2]; bk.iTint[o4 + 3] = it.pulse || 0;
      bk.iMot[o4] = it.orbitW || 0; bk.iMot[o4 + 1] = it.orbitPh || 0; bk.iMot[o4 + 2] = it.spinW || 0; bk.iMot[o4 + 3] = it.spinPh || 0;
      bk.iSt[o4] = dy.b; bk.iSt[o4 + 1] = dy.d; bk.iSt[o4 + 2] = f == null ? 1 : f; bk.iSt[o4 + 3] = vs == null ? 0 : 1 - vs;
      bk.iLife[k * 2] = life[0]; bk.iLife[k * 2 + 1] = life[1];
      if (bk.iLit) {
        var LT = j >= 0 ? B.lights : null;
        if (LT && LT.length >= j * 4 + 4) { bk.iLit[o4] = LT[j * 4]; bk.iLit[o4 + 1] = LT[j * 4 + 1]; bk.iLit[o4 + 2] = LT[j * 4 + 2]; bk.iLit[o4 + 3] = LT[j * 4 + 3]; }
        else if (j < 0 && it._lit) { bk.iLit[o4] = it._lit[0]; bk.iLit[o4 + 1] = it._lit[1]; bk.iLit[o4 + 2] = it._lit[2]; bk.iLit[o4 + 3] = it._lit[3]; }
        else { bk.iLit[o4] = bk.iLit[o4 + 1] = bk.iLit[o4 + 2] = bk.iLit[o4 + 3] = 0; }
      }
      if (bk.iStr) { var ss = starStr(it); bk.iStr[k * 3] = ss[0]; bk.iStr[k * 3 + 1] = ss[1]; bk.iStr[k * 3 + 2] = ss[2]; }
    }

    B.setBodies = function (list) {
      var old = S.keys, keys = {}, n = list.length, i, it;
      /* ghosts: bodies that vanished shrink away from where they were */
      if (!S.first) {
        var gone = {};
        for (i = 0; i < S.n; i++) gone[S.list[i].key] = i;
        for (i = 0; i < n; i++) delete gone[list[i].key];
        Object.keys(gone).forEach(function (k) {
          var j = gone[k], o = S.list[j];
          o._gx = B.positions[j * 3]; o._gy = B.positions[j * 3 + 1]; o._gz = B.positions[j * 3 + 2];
          if (B.lights.length >= j * 4 + 4) o._lit = [B.lights[j * 4], B.lights[j * 4 + 1], B.lights[j * 4 + 2], B.lights[j * 4 + 3]];
          S.ghosts.push({ cls: o.cls, it: o, f: B.focus[j], v: B.vis[j], dyn: S.dyn[j], life: [o._life[0], S.clock] });
        });
      }
      var pos = new Float32Array(n * 3), foc = new Float32Array(n), vis = new Float32Array(n), dyn = new Array(n);
      /* photo look: each body's star (world xyz + colour code), the caller's
         it.light when given, else the last one known for that key */
      var lit = new Float32Array(n * 4);
      for (i = 0; i < n; i++) {
        var li = list[i].light, pk = old[list[i].key];
        if (li && li.length >= 4) { lit[i * 4] = li[0]; lit[i * 4 + 1] = li[1]; lit[i * 4 + 2] = li[2]; lit[i * 4 + 3] = li[3]; }
        else if (pk && pk.lit) lit.set(pk.lit, i * 4);
      }
      for (i = 0; i < n; i++) {
        it = list[i];
        var prev = old[it.key];
        if (prev) {
          it._life = prev.it._life;
          pos[i * 3] = prev.x; pos[i * 3 + 1] = prev.y; pos[i * 3 + 2] = prev.z; foc[i] = prev.f; vis[i] = prev.v;
          dyn[i] = prev.dyn;
          dyn[i].bT = it.bright != null ? it.bright : 1; dyn[i].dT = it.desat || 0;
          if (dyn[i].b !== dyn[i].bT || dyn[i].d !== dyn[i].dT) S.statusMoving = true;
        } else {
          it._life = [S.first ? -1e4 : S.clock, 1e9];
          foc[i] = it.focus != null ? it.focus : 1;
          vis[i] = it.vis != null ? it.vis : 1;
          var b0 = it.bright != null ? it.bright : 1;
          dyn[i] = { b: b0, bT: b0, d: it.desat || 0, dT: it.desat || 0 };
        }
        if (it.focus != null) foc[i] = it.focus;
      }
      for (i = 0; i < n; i++) keys[list[i].key] = { it: list[i], i: i, x: pos[i * 3], y: pos[i * 3 + 1], z: pos[i * 3 + 2], f: foc[i], v: vis[i], dyn: dyn[i],
                                                    lit: [lit[i * 4], lit[i * 4 + 1], lit[i * 4 + 2], lit[i * 4 + 3]] };
      S.keys = keys; S.list = list; S.n = n; S.dyn = dyn;
      B.positions = pos; B.focus = foc; B.vis = vis; B.lights = lit;
      S.first = false;
      regroup();
      return B;
    };
    /* keep key -> last position map fresh, so a rebuild hands positions over */
    function rememberPositions() {
      for (var i = 0; i < S.n; i++) {
        var r = S.keys[S.list[i].key]; if (!r) continue;
        r.x = B.positions[i * 3]; r.y = B.positions[i * 3 + 1]; r.z = B.positions[i * 3 + 2]; r.f = B.focus[i]; r.v = B.vis[i];
        if (r.lit && B.lights.length >= i * 4 + 4) { r.lit[0] = B.lights[i * 4]; r.lit[1] = B.lights[i * 4 + 1]; r.lit[2] = B.lights[i * 4 + 2]; r.lit[3] = B.lights[i * 4 + 3]; }
      }
    }
    B.setDynamics = function (i, o) {
      if (i < 0 || i >= S.n) return;
      var it = S.list[i], dy = S.dyn[i];
      if (o.tint) it.tint = o.tint;
      if (o.orbitW != null) it.orbitW = o.orbitW;
      if (o.orbitPh != null) it.orbitPh = o.orbitPh;
      if (o.spinW != null) it.spinW = o.spinW;
      if (o.spinPh != null) it.spinPh = o.spinPh;
      if (o.pulse != null) it.pulse = o.pulse;
      if (o.radius != null) it.radius = o.radius;
      if (o.bright != null) dy.bT = o.bright;
      if (o.desat != null) dy.dT = o.desat;
      if (dy.b !== dy.bT || dy.d !== dy.dT) S.statusMoving = true;
      S.dynDirty = true;
    };
    B.markPositions = function () { S.posDirty = true; };
    B.markFocus = function () { S.focDirty = true; };
    B.markVis = function () { S.visDirty = true; };
    /* photo look: B.lights[i*4..] = star world x, y, z, colour code; write, then markLights */
    B.markLights = function () { S.litDirty = true; };

    function scatter(which) {
      var list = Object.keys(S.buckets).map(function (c) { return S.buckets[c]; });
      if (STAR) list.push(STAR);
      list.forEach(function (bk) {
        if (!bk.n) return;
        for (var k = 0; k < bk.n; k++) {
          var j = bk.idx[k]; if (j < 0) continue;
          var o4 = k * 4;
          if (which.pos) { bk.iPos[o4] = B.positions[j * 3]; bk.iPos[o4 + 1] = B.positions[j * 3 + 1]; bk.iPos[o4 + 2] = B.positions[j * 3 + 2]; }
          if (which.foc) bk.iSt[o4 + 2] = B.focus[j];
          if (which.vis) bk.iSt[o4 + 3] = 1 - B.vis[j];
          if (which.st) { bk.iSt[o4] = S.dyn[j].b; bk.iSt[o4 + 1] = S.dyn[j].d; }
          if (which.dyn) {
            var it = S.list[j], tn = it.tint;
            bk.iTint[o4] = tn[0]; bk.iTint[o4 + 1] = tn[1]; bk.iTint[o4 + 2] = tn[2]; bk.iTint[o4 + 3] = it.pulse || 0;
            bk.iMot[o4] = it.orbitW || 0; bk.iMot[o4 + 1] = it.orbitPh || 0; bk.iMot[o4 + 2] = it.spinW || 0; bk.iMot[o4 + 3] = it.spinPh || 0;
            bk.iPos[o4 + 3] = it.radius || 8;
            if (bk.iStr) { var ss = starStr(it); bk.iStr[k * 3] = ss[0]; bk.iStr[k * 3 + 1] = ss[1]; bk.iStr[k * 3 + 2] = ss[2]; }
          }
          if (which.lit && bk.iLit) { bk.iLit[o4] = B.lights[j * 4]; bk.iLit[o4 + 1] = B.lights[j * 4 + 1]; bk.iLit[o4 + 2] = B.lights[j * 4 + 2]; bk.iLit[o4 + 3] = B.lights[j * 4 + 3]; }
        }
        if (which.pos) bk.geo.attributes.iPos.needsUpdate = true;
        if (which.foc || which.st || which.vis) bk.geo.attributes.iSt.needsUpdate = true;
        if (which.dyn) { bk.geo.attributes.iTint.needsUpdate = true; bk.geo.attributes.iMot.needsUpdate = true; bk.geo.attributes.iPos.needsUpdate = true; if (bk.iStr) bk.geo.attributes.iStr.needsUpdate = true; }
        if (which.lit && bk.iLit) bk.geo.attributes.iLit.needsUpdate = true;
      });
    }

    B.tick = function (t, o) {
      o = o || {};
      var dt = Math.min(0.05, Math.max(0, t - (S.t || t))); S.t = t;
      S.clock = o.now != null ? o.now : t;
      U.uTime.value = t; U.uClock.value = S.clock;
      if (o.orbitR != null) U.uOrbitR.value = o.orbitR;
      if (o.pxPerUnit != null) U.uPx.value = o.pxPerUnit;
      if (o.minPx != null) U.uMinPx.value = o.minPx;
      var w = { pos: !!S.posDirty, foc: !!S.focDirty, st: false, dyn: !!S.dynDirty, vis: !!S.visDirty, lit: !!S.litDirty && PHOTO };
      if (S.statusMoving) {
        var a = 1 - Math.exp(-dt * STATUS_EASE), mv = false;
        for (var i = 0; i < S.n; i++) {
          var dy = S.dyn[i];
          if (dy.b !== dy.bT) { dy.b += (dy.bT - dy.b) * a; if (Math.abs(dy.b - dy.bT) < 0.003) dy.b = dy.bT; else mv = true; }
          if (dy.d !== dy.dT) { dy.d += (dy.dT - dy.d) * a; if (Math.abs(dy.d - dy.dT) < 0.003) dy.d = dy.dT; else mv = true; }
        }
        S.statusMoving = mv; w.st = true;
      }
      if (w.pos || w.foc || w.st || w.dyn || w.vis || w.lit) {
        scatter(w);
        if (w.pos || w.foc || w.vis || w.lit) rememberPositions();
        S.posDirty = S.focDirty = S.dynDirty = S.visDirty = S.litDirty = false;
      }
      /* ghosts done dying */
      if (S.ghosts.length) {
        var keep = S.ghosts.filter(function (g) { return S.clock - g.life[1] < DEATH_S + 0.1; });
        if (keep.length !== S.ghosts.length) { S.ghosts = keep; regroup(); }
      }
      for (var h = 0; h < S.hubMats.length; h++) S.hubMats[h].uniforms.uTime.value = t;
      for (var gi = 0; gi < S.glows.length; gi++) { var gsp = S.glows[gi]; if (gsp.userData.spin) gsp.material.rotation += gsp.userData.spin * dt; }
      if ((S.gcN = (S.gcN || 0) + 1) % 600 === 0) S.glows = S.glows.filter(function (g) { return g.parent && g.parent.parent; });   // hubs a caller dropped without releaseHubs
    };

    /* ---------------- hubs: single meshes, same look ---------------- */
    /* hubs: the manifest's '<class>_hub' model when present, else '<class>'
       (and the placeholder of <class> until either arrives) */
    function hubKey(kind) {
      var cls = HUB_KIND[kind] || kind;
      return (S.src[cls + '_hub'] === 'blender' || !S.modelSet || S.modelSet[cls + '_hub']) ? cls + '_hub' : cls;
    }
    B.hubGeometry = function (kind) { return geoFor(hubKey(kind)); };
    B.hubMesh = function (kind, o) {
      o = o || {};
      if (CELESTIAL) return celHub(kind, o);
      var cls = hubKey(kind);
      var mat = new THREE.ShaderMaterial({
        uniforms: {
          uMatcap: { value: matcapFor(cls) }, uTint: { value: new THREE.Vector3().fromArray(hexRGB(o.tint || '#9fc7e6')) },
          uTintMix: { value: o.tintMix != null ? o.tintMix : 0.35 }, uBright: { value: o.bright != null ? o.bright : 1 },
          uDesat: { value: 0 }, uTime: { value: 0 }, uPulse: { value: o.pulse || 0 }, uLvl: { value: 1 },
          uGlowGain: { value: gv('hubGlow', 1.35) }, uRim: { value: gv('rim', 0.30) }, uBodyGain: { value: gv('hubBody', 1.3) }, uGlowWhite: { value: gv('glowWhite', 0.3) }, fogDensity: U.fogDensity
        },
        vertexShader: HUB_VS, fragmentShader: COMMON_FS, side: THREE.DoubleSide
      });
      mat.userData.b3dClass = cls;
      S.hubMats.push(mat);
      mat.addEventListener('dispose', function () { var k = S.hubMats.indexOf(mat); if (k >= 0) S.hubMats.splice(k, 1); });
      var m = new THREE.Mesh(geoFor(cls), mat);
      m.userData.b3d = cls;
      return m;
    };
    /* a hub is a star (or, for storage, a ringed giant): the sphere in the
       celestial material plus, for stars, a soft additive corona sprite as a
       child, so it scales and moves with whatever the caller does to the mesh */
    function celHub(kind, o) {
      var cls = HUB_KIND[kind] || kind, c = celOf(cls), info = B.celInfo(cls);
      var mat = celMaterial(cls, true), u = mat.uniforms;
      u.uTint = { value: new THREE.Vector3().fromArray(hexRGB(o.tint || '#9fc7e6')) };
      u.uTintMix.value = info.star ? 0.0 : 0.06;
      u.uBright = { value: o.bright != null ? o.bright : 1 }; u.uDesat = { value: 0 }; u.uPulse = { value: o.pulse || 0 }; u.uLvl = { value: 1 };
      mat.userData.b3dClass = cls;
      S.hubMats.push(mat);
      mat.addEventListener('dispose', function () { var k = S.hubMats.indexOf(mat); if (k >= 0) S.hubMats.splice(k, 1); });
      var m = new THREE.Mesh(geoFor(cls + '_hub'), mat);
      m.userData.b3d = cls + '_hub';
      if (PHOTO && info.star) {
        /* photo look: a real star - the limb-darkened photosphere (PHOTO_FS), a
           corona that is bright at the limb and falls away (HDR: the part near the
           disc blooms), and a subtle camera glare: four thin diffraction spikes,
           screen-aligned like every star in a photograph. No pulsar beams. */
        var rgbP = new THREE.Color().fromArray(info.rgb), cg = pv('coronaGain', 2.4), gk = info.glowK || 0.35;
        /* the corona profile for every star (the 'halo' plate is a flat disc: a bokeh ball in a photo) */
        var smc = new THREE.SpriteMaterial({ map: celGlowTex('corona'), color: rgbP.clone().multiplyScalar(cg), transparent: true, opacity: gk,
                                             blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
        var csz = function () { var g = CT.glow.corona, lb = (g && g.limb) || 0.25;
                                return 2 * 0.9 / lb * (cls === 'pve_host' ? 0.95 : 0.7); };
        var spc = new THREE.Sprite(smc); spc.scale.setScalar(csz()); spc.renderOrder = 1; spc.userData.sizeFor = csz;
        spc.userData.b3dCorona = gk; spc.userData.glowKind = 'corona'; spc.raycast = function () { };
        m.add(spc); m.userData.corona = spc; S.glows.push(spc);
        var sk = pv('spikes', 0.55) * (cls === 'pve_host' ? 1.2 : 1);
        /* depth-tested (2026-10-08): a planet in front of the star hides its
           spikes, as it would in a photograph; the star's own disc covers their root */
        var sms = new THREE.SpriteMaterial({ map: glowTexProc('spikes'), color: rgbP.clone().lerp(new THREE.Color(1, 1, 1), 0.35).multiplyScalar(1.8), transparent: true, opacity: sk,
                                             blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, fog: false });
        var ssz = function () { return cls === 'pve_host' ? 9.5 : 8.0; };
        var sps = new THREE.Sprite(sms); sps.scale.setScalar(ssz()); sps.renderOrder = 4; sps.userData.sizeFor = ssz;
        sps.userData.b3dCorona = sk; sps.userData.glowKind = 'spikes'; sps.raycast = function () { };
        m.add(sps); m.userData.corona2 = sps;
        return m;
      }
      if (info.glow) {
        /* corona (gateway / host core), pulsar beams (switches), halo (AP):
           an additive sprite child, tinted with the star's colour. Pulsar
           beams are depth-tested so the star hides their root, and turn slowly */
        var pul = info.glow === 'pulsar';
        var sm = new THREE.SpriteMaterial({ map: celGlowTex(info.glow), color: new THREE.Color().fromArray(info.rgb), transparent: true, opacity: info.glowK,
                                            blending: THREE.AdditiveBlending, depthWrite: false, depthTest: pul, fog: false });
        /* sprite width from the manifest: corona/halo 2r/limb (the body's limb
           sits at `limb` of the sprite radius), pulsar ~9r; r = 0.9 (unit body) */
        function gsize() { var inf = B.celInfo(cls); return pul ? 9 * 0.9 * 0.85 : (inf.limb ? 2 * 0.9 / inf.limb * 0.85 : inf.glowR * (cls === 'pve_host' ? 1.2 : 1)); }
        var gs = gsize();
        var sp = new THREE.Sprite(sm); sp.scale.set(gs, gs, 1); sp.renderOrder = 1; sp.userData.sizeFor = gsize;
        sp.userData.b3dCorona = info.glowK; sp.userData.glowKind = info.glow; sp.raycast = function () { };
        if (pul) { sm.rotation = (o.seed || 0.7) * 2.3; sp.userData.spin = 0.16; }
        m.add(sp); m.userData.corona = sp;
        S.glows.push(sp);
        if (pul) {
          /* a pulsar also gets a soft corona so it still reads as a star end-on */
          var sm2 = new THREE.SpriteMaterial({ map: celGlowTex('corona'), color: new THREE.Color().fromArray(info.rgb), transparent: true, opacity: info.glowK * 0.8,
                                               blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
          var csize = function () { return CT.glow.corona && CT.glow.corona.limb ? 2 * 0.9 / CT.glow.corona.limb * 0.55 : 3.4; };
          var cl = csize();
          var sp2 = new THREE.Sprite(sm2); sp2.scale.set(cl, cl, 1); sp2.userData.sizeFor = csize; sp2.renderOrder = 1; sp2.userData.b3dCorona = info.glowK * 0.8; sp2.userData.glowKind = 'corona'; sp2.raycast = function () { };
          m.add(sp2); m.userData.corona2 = sp2; S.glows.push(sp2);
        }
      }
      return m;
    }
    B.setHubStatus = function (mesh, o) {
      if (!mesh || !mesh.material || !mesh.material.uniforms || !mesh.material.uniforms.uTint) return;
      var u = mesh.material.uniforms;
      if (o.tint != null) u.uTint.value.fromArray(hexRGB(o.tint));
      if (o.desat != null) u.uDesat.value = o.desat;
      if (o.bright != null) u.uBright.value = o.bright;
      if (o.pulse != null) u.uPulse.value = o.pulse;
      if (o.lvl != null) u.uLvl.value = o.lvl;
      [mesh.userData && mesh.userData.corona, mesh.userData && mesh.userData.corona2].forEach(function (co) {
        if (!co) return;
        var k = co.userData.b3dCorona * (u.uLvl.value) * (0.35 + 0.65 * Math.min(1, u.uBright.value)) * (1 - 0.8 * u.uDesat.value);
        co.material.opacity = k; co.visible = k > 0.01;
      });
    };
    /* photo look: the star that lights a NON-star hub (the SD-WAN NVR, a ringed
       giant): world xyz + colour code (0 = a soft view-space key light) */
    B.setHubLight = function (mesh, xyz, code) {
      var u = mesh && mesh.material && mesh.material.uniforms;
      if (!u || !u.uHubLit) return;
      u.uHubLit.value.set(xyz ? +xyz[0] : 0, xyz ? +xyz[1] : 0, xyz ? +xyz[2] : 0, code || 0);
    };
    B.releaseHubs = function () {     // the caller rebuilt its hub meshes
      S.hubMats.forEach(function (m) { m.dispose(); });
      S.hubMats = [];
      S.glows = [];
    };

    /* ---------------- Blender models (manifest.models) ---------------- */
    var loader = { pending: {} };
    function loadJSON(url) { return fetch(url, { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error(url + ' ' + r.status); return r.json(); }); }
    function validModel(d) {
      return d && d.pos && d.nrm && d.idx && d.pos.length >= 9 && d.pos.length === d.nrm.length && d.pos.length % 3 === 0;
    }
    function applyModel(cls, d, spec) {
      var nv = d.pos.length / 3;
      if (!d.col || d.col.length !== d.pos.length) { d.col = new Float32Array(nv * 3); d.col.fill(0.8); }
      if (!d.glow || d.glow.length !== nv) d.glow = new Float32Array(nv);
      fillGeo(geoFor(cls), d);
      S.src[cls] = 'blender';
      var ax = spec.spin_axis || [0, 1, 0], v = S.spinAxis[cls];
      v.set(+ax[0] || 0, +ax[1] || 0, +ax[2] || 0); if (v.lengthSq() < 1e-6) v.set(0, 1, 0); v.normalize();
      S.matcapOf[cls] = spec.matcap || null;
      S.face[cls] = !!spec.face_camera;
      relink(cls);
    }
    function relink(cls) {
      var bk = S.buckets[cls];
      if (bk) { linkBase(bk); bk.mesh.material.uniforms.uMatcap.value = matcapFor(cls); bk.mesh.material.uniforms.uFace.value = S.face[cls] ? 1 : 0; }
      S.hubMats.forEach(function (m) { if (m.userData.b3dClass === cls) m.uniforms.uMatcap.value = matcapFor(cls); });
    }
    function emit() { S.listeners.forEach(function (f) { try { f(B); } catch (e) { } }); }
    function readManifest() {
      if (CELESTIAL) { readCelestial(); return; }
      loadJSON(manUrl).then(function (man) {
        var models = man && man.models, mcs = man && man.matcaps;
        if (!models) { S.loaded = true; return; }
        var sig = JSON.stringify([models, mcs || {}]);
        if (sig === S.manSig) return;
        S.manSig = sig;
        S.modelSet = models;
        var jobs = [];
        Object.keys(mcs || {}).forEach(function (name) {
          var f = mcs[name] && mcs[name].file; if (!f) return;
          var url = base + f;
          if (S.matcaps[name] && S.matcapUrl[name] === url) return;
          jobs.push(new Promise(function (res) {
            new THREE.TextureLoader().load(url + '?v=' + encodeURIComponent(sig.length + ':' + f), function (tx) {
              tx.minFilter = THREE.LinearFilter; tx.generateMipmaps = false;
              S.matcaps[name] = tx; S.matcapUrl[name] = url; res();
            }, undefined, function () { res(); });
          }));
        });
        Promise.all(jobs).then(function () {
          var mj = [];
          Object.keys(models).forEach(function (cls) {
            var spec = models[cls]; if (!spec || !spec.file) return;
            var url = base + spec.file;
            mj.push(loadJSON(url).then(function (d) {
              if (!validModel(d)) throw new Error('bad model ' + url);
              applyModel(cls, d, spec);
            })['catch'](function (e) { if (root.console) console.warn('bodies3d:', e && e.message); }));
          });
          /* matcap-only changes */
          Object.keys(S.buckets).forEach(relink);
          return Promise.all(mj);
        }).then(function () {
          /* a hub kind with no '<class>_hub' model wears its device model */
          ['gateway', 'switch', 'ap', 'pve_host', 'storage'].forEach(function (c) {
            var hk = c + '_hub';
            if (models[hk] || S.src[c] !== 'blender' || !S.geo[hk]) return;
            var src = S.geo[c], dst = S.geo[hk];
            ['position', 'normal', 'aCol', 'aGlow'].forEach(function (k) { dst.setAttribute(k, src.attributes[k]); });
            dst.setIndex(src.index); dst.userData.tris = src.userData.tris;
            S.src[hk] = 'blender'; S.matcapOf[hk] = S.matcapOf[c]; S.spinAxis[hk] = S.spinAxis[c];
            relink(hk);
          });
          S.loaded = true;
          emit();
        });
      })['catch'](function () { S.loaded = true; /* no manifest: placeholders stay */ });
    }
    /* static/assets/celestial/manifest.json (contracts section 5) */
    function texLoad(url, cb, mip) {
      new THREE.TextureLoader().load(url, function (t) {
        if (mip) { t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.anisotropy = 4; }
        else { t.generateMipmaps = false; t.minFilter = THREE.LinearFilter; }
        t.wrapS = THREE.RepeatWrapping; cb(t);
      }, undefined, function () { cb(null); });
    }
    function readCelestial() {
      loadJSON(celBase + 'manifest.json').then(function (man) {
        var sig = JSON.stringify(man || {});
        if (sig === CT.sig) { S.loaded = true; return; }
        CT.sig = sig;
        var jobs = [];
        function want(table, dst, mip) {
          Object.keys(table || {}).forEach(function (k) {
            var e = table[k]; if (!e || !e.file) return;
            var old = dst[k] && dst[k].file === e.file ? dst[k] : null;
            dst[k] = { kind: e.kind, inner: e.inner, outer: e.outer, luma: e.luma, limb: e.limb, size: e.size, file: e.file, tex: old ? old.tex : null, ntex: old ? old.ntex : null, etex: old ? old.etex : null };
            var D0 = dst[k];
            if (!D0.tex) jobs.push(new Promise(function (res) { texLoad(celBase + e.file + '?v=' + sig.length, function (t) { D0.tex = t; res(); }, mip); }));
            if (e.normal && !D0.ntex) jobs.push(new Promise(function (res) { texLoad(celBase + e.normal + '?v=' + sig.length, function (t) { if (t) t.encoding = THREE.LinearEncoding; D0.ntex = t; res(); }, mip); }));
            if (e.emissive && !D0.etex) jobs.push(new Promise(function (res) { texLoad(celBase + e.emissive + '?v=' + sig.length, function (t) { D0.etex = t; res(); }, mip); }));
          });
        }
        want(man.surfaces, CT.surf, true); want(man.rings, CT.ring, false); want(man.glows, CT.glow, false);
        CT.atmos = man.atmos || {}; CT.classes = man.classes || {};
        Promise.all(jobs).then(function () {
          celRefresh();
          S.loaded = true; emit();
        });
      })['catch'](function () { S.loaded = true; /* not rendered yet: procedural surfaces stay */ });
    }
    B.onChange = function (fn) { S.listeners.push(fn); };
    B.loaded = function () { return !!S.loaded; };
    B.reloadModels = readManifest;
    if (opts.models !== false) { readManifest(); S.pollT = setInterval(readManifest, POLL_MS); }

    B.visible = function (v) {
      S.visible = !!v;
      Object.keys(S.buckets).forEach(function (c) { S.buckets[c].mesh.visible = S.visible && S.buckets[c].n > 0; });
      if (STAR) STAR.mesh.visible = S.visible && STAR.n > 0;
    };
    B.meshes = function () { return Object.keys(S.buckets).map(function (c) { return S.buckets[c].mesh; }); };
    /* photo look: tune at runtime (QA / console): B.tune({ sun, starPx, starGain, lod: [a, b], hazeK }) */
    B.tune = function (o) {
      o = o || {};
      if (o.sun != null) U.uSun.value = +o.sun;
      if (o.starPx != null) U.uStarPx.value = +o.starPx;
      if (o.starGain != null) U.uStarGain.value = +o.starGain;
      if (o.hazeK != null) U.uHazeK.value = +o.hazeK;
      if (o.lod) U.uLod.value.set(+o.lod[0], +o.lod[1]);
      if (o.amb) U.uAmb.value.fromArray(o.amb);
      return { sun: U.uSun.value, starPx: U.uStarPx.value, starGain: U.uStarGain.value, hazeK: U.uHazeK.value, lod: U.uLod.value.toArray() };
    };
    B.stats = function () {
      var draws = 0, inst = 0, tris = 0, cls = {};
      Object.keys(S.buckets).forEach(function (c) {
        var bk = S.buckets[c]; if (!bk.n) return;
        draws++; inst += bk.n; tris += bk.n * (geoFor(c).userData.tris || 0);
      });
      Object.keys(S.geo).forEach(function (c) { cls[c] = S.src[c]; });
      if (STAR && STAR.n) draws++;
      return { draws: draws, instances: inst, ghosts: S.ghosts.length, tris: Math.round(tris), classes: cls, photo: PHOTO,
               blender: Object.keys(S.src).filter(function (c) { return S.src[c] === 'blender'; }).length,
               matcaps: Object.keys(S.matcaps) };
    };
    B.dispose = function () {
      if (S.pollT) clearInterval(S.pollT);
      Object.keys(S.buckets).forEach(function (c) { var bk = S.buckets[c]; if (scene) scene.remove(bk.mesh); bk.geo.dispose(); bk.mesh.material.dispose(); });
      S.buckets = {};
    };
    return B;
  }

  root.BODIES3D = { create: create, CLASSES: CLASSES, placeholderData: placeholderData, HUB_KIND: HUB_KIND, version: 3 };
})(typeof window !== 'undefined' ? window : this);
