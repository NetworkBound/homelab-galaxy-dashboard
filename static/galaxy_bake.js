/* galaxy_bake.js - photographic galaxies, baked on the GPU once per layout (2026-10-08)
   ---------------------------------------------------------------------------
   Galaxies are the hero: astrophotography rather than CG - luminous bulge,
   blue-white arms, dark dust lanes, pink HII knots, star clusters, soft
   natural glow.

   One fragment shader renders a face-on galaxy into a half-float texture
   (linear HDR radiance, mipmapped): an exponential disc, a Sersic-like bulge
   with a hot nucleus, m-armed spiral density waves wound to the SAME twist the
   bodies' category sectors use (netscene_universe presentGroups), flocculent
   fbm structure, dust lanes on the inner edge of every arm plus filaments, pink
   HII knots and blue-white young clusters strung along the arms, unresolved
   star grain, and a wide faint outer haze. Colour is a field: each category
   sector tints the arms and disc it covers (the guests of that category sit in
   it), blended softly across the sector boundaries; a system with no sectors
   (home, core, sites) takes its accent. Deterministic from the spec (seeded).

   Cost: one fullscreen draw per bake (~1 ms on a mid-range GPU at 1024^2), done
   only when a system's spec changes (cached by spec signature). Drawing it is
   one additive textured quad per galaxy.

   API (window.NB_GALAXY)
     bake(renderer, spec) -> THREE.Texture   (owned by the cache; same spec =
                                              same texture, no second bake)
       spec = { size: 1024, seed, kind: 'spiral'|'ringed'|'dwarf'|'grand',
                rIn, rOut (body annulus, fraction of the texture radius),
                twist (rad wound from rIn to rOut), arms (2..4), armW (0.2..0.5),
                sectors: [{a0, a1, col:[r,g,b]}] | null, accent: [r,g,b],
                rings: [fraction...], bulge (fraction), core (HDR peak),
                bright (overall gain), hii (0..1), dust (0..1), tilt (rad: the
                arm phase offset), haze (0..1) }
     discMaterial(tex) -> THREE.ShaderMaterial  additive (One/One), linear HDR,
                                              uniforms uK (gain), uNear (vec2 fade by view depth)
     release(tex)      drop a texture from the cache when no galaxy uses it
   --------------------------------------------------------------------------- */
(function () {
  'use strict';
  var THREE = window.THREE;
  if (!THREE) return;

  var MAXS = 8;
  /* 8-bit storage (2026-10-08 perf pass): the plates are LOG-encoded into RGBA8
     (half the texture bandwidth of half float, which measured ~2x the GPU time of
     the whole plate layer when the GPU was shared with a memory-bound inference
     workload). c = E * (2^(v * K) - 1): ~3.6 % steps from the faintest haze
     (0.002) to the nucleus (16), decoded in the display shaders below. */
  var ENC_E = 0.002, ENC_K = Math.log(1 + 16 / 0.002) / Math.LN2;
  var ENC_GLSL = 'vec3 nbEnc(vec3 c){ return log2(1.0 + max(c, vec3(0.0)) / ' + ENC_E.toFixed(4) + ') / ' + ENC_K.toFixed(6) + '; }\n' +
                 'vec3 nbDec(vec3 v){ return ' + ENC_E.toFixed(4) + ' * (exp2(v * ' + ENC_K.toFixed(6) + ') - 1.0); }';

  var VS = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
  var FS = [
    'precision highp float;',
    'varying vec2 vUv;',
    ENC_GLSL,
    'uniform float uSeed, uRin, uRout, uTwist, uArms, uArmW, uBulge, uCore, uBright, uHii, uDust, uTilt, uHaze, uKind;',
    'uniform int uSecN; uniform float uSecA0[' + MAXS + ']; uniform float uSecA1[' + MAXS + ']; uniform vec3 uSecC[' + MAXS + '];',
    'uniform vec3 uAccent; uniform int uRingN; uniform float uRing[6];',
    'const float PI = 3.14159265, TAU = 6.2831853;',
    'float h12(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32 + uSeed); return fract(p.x * p.y); }',
    'vec2 h22(vec2 p){ float n = h12(p); return vec2(n, h12(p + n * 17.7)); }',
    'float vnoise(vec2 x){ vec2 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(h12(i), h12(i + vec2(1.0, 0.0)), f.x), mix(h12(i + vec2(0.0, 1.0)), h12(i + vec2(1.0, 1.0)), f.x), f.y); }',
    'float fbm(vec2 p){ float a = 0.5, s = 0.0; mat2 m = mat2(1.6, 1.2, -1.2, 1.6); for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = m * p + 7.3; a *= 0.5; } return s; }',
    'float ridge(vec2 p){ float a = 0.5, s = 0.0; mat2 m = mat2(1.6, 1.2, -1.2, 1.6); for (int i = 0; i < 4; i++) { float n = 1.0 - abs(vnoise(p) * 2.0 - 1.0); s += a * n * n; p = m * p + 3.1; a *= 0.5; } return s; }',
    /* nearest jittered point of a cell grid: x = distance, y = the cell's random id */
    'vec2 worley(vec2 p){ vec2 i = floor(p), f = fract(p); float d = 9.0, id = 0.0;',
    '  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) { vec2 g = vec2(float(x), float(y)); vec2 o = h22(i + g);',
    '    vec2 r = g + o - f; float dd = dot(r, r); if (dd < d) { d = dd; id = h12(i + g + 3.7); } }',
    '  return vec2(sqrt(d), id); }',
    'float angd(float a, float b){ float d = mod(a - b + PI, TAU); if (d < 0.0) d += TAU; return d - PI; }',
    'void main(){',
    '  vec2 p = vUv * 2.0 - 1.0;',
    '  float r = length(p);',
    '  if (r > 1.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }',
    '  float th = atan(-p.y, p.x);',                       // world angle: x = r cos, z = r sin (texture v runs toward -z)
    '  float t = (r - uRin) / max(0.05, uRout - uRin);',    // 0 at the inner edge of the body annulus, 1 at its outer edge
    /* domain warp: flocculent, not a drawn spiral */
    '  vec2 wq = p * 3.2 + uSeed * 0.37;',
    '  float warp = fbm(wq) - 0.5;',
    '  float thw = th + 0.55 * warp * smoothstep(0.02, 0.4, r);',
    /* spiral phase, wound like the sectors (linear in t inside the annulus), continued
       with a gentler pitch outside it and straightening into the bulge */
    '  float tw = uTwist * (t < 0.0 ? t * 0.7 : t < 1.0 ? t : 1.0 + (t - 1.0) * 0.8);',
    '  float ph = (thw - tw - uTilt) * uArms;',
    '  float wave = 0.5 + 0.5 * cos(ph);',                       // 1 on an arm crest
    '  float armW = clamp(uArmW, 0.12, 0.9);',
    /* a broad luminous arm plus a sharper crest: arms glow, they are not drawn */
    '  float armB = pow(wave, 1.6 / armW * 0.35);',
    '  float armC = pow(wave, 5.0 / armW * 0.35);',
    '  float arm = 0.55 * armB + 0.45 * armC;',
    '  float lanePh = cos(ph - 0.70);',                           // dust on the inner (concave) edge of each crest
    '  float lane = smoothstep(0.62, 0.97, lanePh) * smoothstep(0.08, 0.26, r) * (1.0 - smoothstep(0.70, 0.98, r));',
    /* radial envelopes */
    '  float envArm = smoothstep(uRin * 0.20, uRin * 0.85, r) * (1.0 - smoothstep(uRout * 1.05, min(1.0, uRout * 1.85), r));',
    '  float disc = exp(-r / 0.24);',
    '  float bulge = exp(-pow(r / max(0.01, uBulge), 0.8) * 2.4);',
    '  float nucleus = exp(-r * r / (2.0 * 0.010 * 0.010));',
    '  float halo = exp(-r / 0.50) * (1.0 - smoothstep(0.82, 1.0, r));',
    /* flocculent clumps, unresolved-star grain, a sparse dusting of resolved stars */
    '  float clump = fbm(p * 8.0 + vec2(uSeed, -uSeed));',
    '  float clump2 = fbm(p * 22.0 + vec2(-uSeed * 2.0, uSeed));',
    '  float grain = vnoise(p * 180.0 + uSeed * 3.1);',
    /* ---- the colour field: category sectors, else the accent ---- */
    '  vec3 tint = uAccent; float tsum = 0.0; vec3 tacc = vec3(0.0);',
    '  if (uSecN > 0) {',
    '    float thu = th - uTwist * clamp(t, -0.3, 1.6);',          // untwist back to the sector frame
    '    for (int k = 0; k < ' + MAXS + '; k++) {',
    '      if (k >= uSecN) break;',
    '      float c = 0.5 * (uSecA0[k] + uSecA1[k]), hw = 0.5 * (uSecA1[k] - uSecA0[k]);',
    '      float d = abs(angd(thu, c));',
    '      float w = 1.0 - smoothstep(hw - 0.05, hw + 0.30, d);',
    '      tacc += uSecC[k] * w; tsum += w;',
    '    }',
    '    if (tsum > 0.001) tint = tacc / tsum;',
    '  }',
    /* the bulge and inner disc are old, warm stars whatever the category */
    '  tint = mix(vec3(1.0, 0.82, 0.62), tint, smoothstep(uRin * 0.35, uRin * 1.05, r));',
    '  float tl = max(0.12, dot(tint, vec3(0.2126, 0.7152, 0.0722)));',
    '  vec3 tintN = tint / tl;',                                   // unit-luminance hue
    /* physical palette, pulled toward the system / category hue */
    '  vec3 young = mix(vec3(0.62, 0.78, 1.00), tintN * 0.80, 0.72);',
    '  vec3 old = mix(vec3(1.00, 0.86, 0.68), tintN * 0.75, 0.20);',
    '  vec3 bulgeC = vec3(1.00, 0.80, 0.55);',
    '  vec3 hazeC = mix(vec3(0.62, 0.70, 0.95), tintN * 0.65, 0.40);',
    /* ---- light (linear radiance; the page exposes x1.9 and tone-maps once) ---- */
    '  float dwarf = uKind > 1.5 && uKind < 2.5 ? 1.0 : 0.0;',
    '  float ell = uKind > 3.5 ? 1.0 : 0.0;',                    // an elliptical: old stars, no arms, no dust
    /* arms are chains of star clouds: strong mid and fine-scale clumping along them */
    '  float fine = fbm(p * 38.0 + warp * 2.0 + uSeed);',
    '  float armL = arm * envArm * (0.30 + 1.0 * clump) * (0.45 + 1.1 * clump2 * clump2) * (0.6 + 0.8 * fine) * mix(1.0, 0.6, dwarf);',
    '  vec3 col = vec3(0.0);',
    '  col += old * disc * 0.17 * (0.70 + 0.60 * clump);',
    '  col += young * armL * 1.25 * exp(-r / 0.70);',
    '  col += young * armL * (grain - 0.5) * 0.30 * exp(-r / 0.62);',
    '  col += bulgeC * bulge * mix(2.4, 1.5, dwarf);',
    '  col += bulgeC * exp(-r / max(0.02, uBulge * 2.0)) * mix(0.18, 0.10, dwarf);',
    '  col += vec3(1.0, 0.94, 0.84) * nucleus * uCore;',
    '  col += hazeC * halo * 0.085 * uHaze;',
    '  col += young * dwarf * 0.30 * exp(-r / 0.30) * (0.4 + 0.9 * clump) * (0.5 + clump2);',   // a dwarf is a patchy blob more than a spiral
    '  if (ell > 0.5) { col = mix(bulgeC, old, 0.45) * (exp(-pow(r / 0.22, 0.55) * 3.2) * 2.4 + exp(-r / 0.18) * 0.25) + vec3(1.0, 0.94, 0.84) * nucleus * uCore * 0.6; }',
    /* rings (home / core: the class orbits read as faint stellar rings) */
    '  for (int i = 0; i < 6; i++) {',
    '    if (i >= uRingN) break;',
    '    float d = (r - uRing[i]) / 0.016;',
    '    col += young * exp(-d * d) * 0.07 * (0.2 + 1.2 * clump2 * clump);',
    '  }',
    /* HII knots (pink, Halpha) and young blue clusters: sparse, soft, on the crests */
    '  vec2 wk = worley(p * 30.0 + vec2(uSeed * 1.7, 0.0));',
    '  float knot = exp(-wk.x * wk.x * 26.0) * smoothstep(0.86, 0.98, wk.y) * smoothstep(0.70, 0.99, wave) * envArm * smoothstep(0.42, 0.78, clump2);',
    '  col += vec3(1.00, 0.40, 0.62) * knot * 1.6 * uHii * (0.25 + 1.5 * fract(wk.y * 53.0)) * (1.0 - ell);',
    '  vec2 wc = worley(p * 52.0 + vec2(-uSeed * 2.3, 5.0));',
    '  float clus = exp(-wc.x * wc.x * 40.0) * smoothstep(0.93, 0.99, wc.y) * smoothstep(0.55, 0.98, wave) * envArm * smoothstep(0.35, 0.75, clump2);',
    '  col += vec3(0.74, 0.86, 1.00) * clus * 1.8 * (0.4 + 1.2 * fract(wc.y * 37.0)) * (1.0 - ell);',
    /* dust: lanes + filaments, reddening, strongest in the inner disc */
    '  float fil = ridge(p * 6.0 + warp * 1.8 + uSeed * 0.11);',
    '  float dust = clamp(lane * (0.45 + 0.75 * fil) + 0.32 * smoothstep(0.66, 0.95, fil) * (0.25 + 0.75 * armB) * smoothstep(0.08, 0.30, r) * (1.0 - smoothstep(0.55, 0.92, r)), 0.0, 1.0) * uDust;',
    '  dust *= (1.0 - 0.85 * exp(-r / max(0.02, uBulge * 0.6))) * (1.0 - ell);',  // the nucleus shines through
    '  col *= vec3(1.0) - dust * vec3(0.80, 0.86, 0.93);',
    '  col *= uBright;',
    '  col *= 1.0 - smoothstep(0.92, 1.0, r);',
    '  gl_FragColor = vec4(nbEnc(col), 1.0);',
    '}'].join('\n');

  /* emission nebulae for the deep field: domain-warped clouds, bright ionisation
     fronts (ridged noise), Halpha red-pink outside, OIII teal where the gas is
     hottest, dark dust globules, a few embedded young stars, an irregular edge */
  var NEB_FS = [
    'precision highp float;',
    'varying vec2 vUv;',
    ENC_GLSL,
    'uniform float uSeed; uniform vec3 uColA; uniform vec3 uColB; uniform float uBright; uniform float uStars;',
    'float h12(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32 + uSeed); return fract(p.x * p.y); }',
    'float vnoise(vec2 x){ vec2 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(h12(i), h12(i + vec2(1.0, 0.0)), f.x), mix(h12(i + vec2(0.0, 1.0)), h12(i + vec2(1.0, 1.0)), f.x), f.y); }',
    'float fbm(vec2 p){ float a = 0.5, s = 0.0; mat2 m = mat2(1.6, 1.2, -1.2, 1.6); for (int i = 0; i < 6; i++) { s += a * vnoise(p); p = m * p + 7.3; a *= 0.5; } return s; }',
    'float ridge(vec2 p){ float a = 0.5, s = 0.0; mat2 m = mat2(1.6, 1.2, -1.2, 1.6); for (int i = 0; i < 5; i++) { float n = 1.0 - abs(vnoise(p) * 2.0 - 1.0); s += a * n * n; p = m * p + 3.1; a *= 0.5; } return s; }',
    'void main(){',
    '  vec2 p = vUv * 2.0 - 1.0;',
    '  vec2 q = p * 2.2 + uSeed;',
    '  vec2 w1 = vec2(fbm(q), fbm(q + 5.2));',
    '  vec2 w2 = vec2(fbm(q + 3.0 * w1 + 1.7), fbm(q + 3.0 * w1 + 9.2));',
    '  float dens = fbm(q + 3.5 * w2);',
    '  float fil = ridge(q * 1.3 + 2.0 * w2);',
    /* an irregular envelope: never a disc or a square */
    '  float env = (1.0 - smoothstep(0.35, 1.0, length(p * vec2(1.0, 1.35)) + 0.45 * (fbm(p * 3.0 + uSeed * 2.0) - 0.5))) * (1.0 - smoothstep(0.78, 0.97, max(abs(p.x), abs(p.y))));',
    '  float gas = smoothstep(0.38, 0.85, dens) * env;',
    '  float front = pow(fil, 3.0) * gas;',
    '  float hot = smoothstep(0.45, 0.80, fbm(q * 0.8 + 11.0)) * (1.0 - smoothstep(0.2, 0.9, length(p)));',
    '  vec3 col = mix(uColA, uColB, hot) * (gas * 0.35 + front * 0.9);',
    '  float dust = smoothstep(0.55, 0.85, fbm(q * 1.7 + w1 * 2.0 + 21.0)) * env;',
    '  col *= 1.0 - 0.85 * dust;',
    /* a few embedded young stars, inside the gas */
    '  vec2 sc = floor(vUv * 64.0); vec2 sf = fract(vUv * 64.0) - 0.5;',
    '  float sr = h12(sc + 3.3);',
    '  float star = step(0.985, sr) * exp(-dot(sf, sf) * 60.0) * smoothstep(0.05, 0.4, gas) * uStars;',
    '  col += vec3(0.85, 0.92, 1.0) * star * 1.5;',
    '  gl_FragColor = vec4(nbEnc(col * uBright), 1.0);',
    '}'].join('\n');

  var DISC_VS = [
    'varying vec2 vUv; varying float vDepth;',
    'void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vDepth = -mv.z; gl_Position = projectionMatrix * mv; }'].join('\n');
  var DISC_FS = [
    'uniform sampler2D map; uniform float uK; uniform vec2 uNear;',
    'varying vec2 vUv; varying float vDepth;',
    ENC_GLSL,
    'void main(){',
    '  vec3 c = nbDec(texture2D(map, vUv).rgb) * uK * smoothstep(uNear.x, uNear.y, vDepth);',
    '  if (c.r + c.g + c.b < 0.0004) discard;',
    '  gl_FragColor = vec4(c, 1.0);',
    '}'].join('\n');

  var C = { scene: null, cam: null, mat: null, quad: null, cache: {} };
  function ensure() {
    if (C.mat) return;
    var u = {
      uSeed: { value: 0 }, uRin: { value: 0.2 }, uRout: { value: 0.6 }, uTwist: { value: 1.35 }, uArms: { value: 2 }, uArmW: { value: 0.35 },
      uBulge: { value: 0.08 }, uCore: { value: 6 }, uBright: { value: 1 }, uHii: { value: 1 }, uDust: { value: 0.8 }, uTilt: { value: 0 },
      uHaze: { value: 1 }, uKind: { value: 0 },
      uSecN: { value: 0 }, uSecA0: { value: new Array(MAXS).fill(0) }, uSecA1: { value: new Array(MAXS).fill(0) },
      uSecC: { value: [] }, uAccent: { value: new THREE.Vector3(0.6, 0.7, 1.0) },
      uRingN: { value: 0 }, uRing: { value: [0, 0, 0, 0, 0, 0] }
    };
    for (var i = 0; i < MAXS; i++) u.uSecC.value.push(new THREE.Vector3(1, 1, 1));
    C.mat = new THREE.ShaderMaterial({ uniforms: u, vertexShader: VS, fragmentShader: FS, depthTest: false, depthWrite: false });
    C.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), C.mat);
    C.quad.frustumCulled = false;
    C.scene = new THREE.Scene(); C.scene.add(C.quad);
    C.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }
  function sigOf(s) { return JSON.stringify(s); }
  function setUniforms(spec) {
    var u = C.mat.uniforms;
    u.uSeed.value = ((spec.seed >>> 0) % 9973) / 97.3;
    u.uRin.value = spec.rIn; u.uRout.value = spec.rOut; u.uTwist.value = spec.twist || 0;
    u.uArms.value = spec.arms || 2; u.uArmW.value = spec.armW || 0.35;
    u.uBulge.value = spec.bulge || 0.08; u.uCore.value = spec.core != null ? spec.core : 6;
    u.uBright.value = spec.bright != null ? spec.bright : 1; u.uHii.value = spec.hii != null ? spec.hii : 1;
    u.uDust.value = spec.dust != null ? spec.dust : 0.8; u.uTilt.value = spec.tilt || 0; u.uHaze.value = spec.haze != null ? spec.haze : 1;
    u.uKind.value = { spiral: 0, ringed: 1, dwarf: 2, grand: 3, elliptical: 4 }[spec.kind] || 0;
    var S = spec.sectors || [];
    u.uSecN.value = Math.min(MAXS, S.length);
    for (var i = 0; i < MAXS; i++) {
      var q = S[i];
      u.uSecA0.value[i] = q ? q.a0 : 0; u.uSecA1.value[i] = q ? q.a1 : 0;
      u.uSecC.value[i].fromArray(q ? q.col : [1, 1, 1]);
    }
    u.uAccent.value.fromArray(spec.accent || [0.6, 0.7, 1.0]);
    var R = spec.rings || [];
    u.uRingN.value = Math.min(6, R.length);
    for (var j = 0; j < 6; j++) u.uRing.value[j] = R[j] || 0;
  }

  function bake(renderer, spec) {
    var sig = sigOf(spec);
    var hit = C.cache[sig];
    if (hit) { hit.refs++; return hit.rt.texture; }
    ensure();
    var size = spec.size || 1024;
    var rt = new THREE.WebGLRenderTarget(size, size, {
      minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType, depthBuffer: false, stencilBuffer: false, generateMipmaps: true
    });
    rt.texture.generateMipmaps = true;
    var caps = renderer.capabilities;
    rt.texture.anisotropy = caps && caps.getMaxAnisotropy ? Math.min(4, caps.getMaxAnisotropy()) : 1;
    setUniforms(spec);
    var prev = renderer.getRenderTarget(), auto = renderer.autoClear;
    renderer.setRenderTarget(rt);
    renderer.autoClear = true;
    renderer.render(C.scene, C.cam);
    renderer.setRenderTarget(prev);
    renderer.autoClear = auto;
    rt.texture.nbGalaxySig = sig;          // r128 textures carry no userData
    C.cache[sig] = { rt: rt, refs: 1, sig: sig };
    return rt.texture;
  }
  /* many small galaxies in ONE texture (the deep field: one draw for all of
     them): specs[i] goes to cell i of a cols x cols grid, `size` px square */
  function bakeAtlas(renderer, specs, cols, size) {
    ensure();
    size = size || 2048; cols = cols || 4;
    var rt = new THREE.WebGLRenderTarget(size, size, {
      minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType, depthBuffer: false, stencilBuffer: false
    });
    var caps = renderer.capabilities;
    rt.texture.anisotropy = caps && caps.getMaxAnisotropy ? Math.min(4, caps.getMaxAnisotropy()) : 1;
    var cell = Math.floor(size / cols), prev = renderer.getRenderTarget(), auto = renderer.autoClear;
    var cc = renderer.getClearColor(new THREE.Color()), ca = renderer.getClearAlpha();
    renderer.setRenderTarget(rt); renderer.setClearColor(0x000000, 1); renderer.clear(); renderer.setRenderTarget(prev);
    renderer.setClearColor(cc, ca);
    for (var i = 0; i < specs.length && i < cols * cols; i++) {
      setUniforms(specs[i]);
      rt.texture.generateMipmaps = i === Math.min(specs.length, cols * cols) - 1;   // mip once, after the last cell
      rt.viewport.set((i % cols) * cell, Math.floor(i / cols) * cell, cell, cell);
      rt.scissor.set((i % cols) * cell, Math.floor(i / cols) * cell, cell, cell); rt.scissorTest = true;
      renderer.setRenderTarget(rt); renderer.autoClear = false;
      renderer.render(C.scene, C.cam);
    }
    rt.scissorTest = false;
    renderer.setRenderTarget(prev); renderer.autoClear = auto;
    return rt.texture;
  }
  var NC = { mat: null, scene: null };
  function bakeNebulaAtlas(renderer, specs, cols, size) {
    ensure();
    if (!NC.mat) {
      NC.mat = new THREE.ShaderMaterial({ uniforms: { uSeed: { value: 0 }, uColA: { value: new THREE.Vector3(1, 0.3, 0.4) }, uColB: { value: new THREE.Vector3(0.2, 0.8, 0.85) },
                                                       uBright: { value: 1 }, uStars: { value: 1 } },
                                          vertexShader: VS, fragmentShader: NEB_FS, depthTest: false, depthWrite: false });
      var qd = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), NC.mat); qd.frustumCulled = false;
      NC.scene = new THREE.Scene(); NC.scene.add(qd);
    }
    size = size || 2048; cols = cols || 2;
    var rt = new THREE.WebGLRenderTarget(size, size, {
      minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType, depthBuffer: false, stencilBuffer: false
    });
    var cell = Math.floor(size / cols), prev = renderer.getRenderTarget(), auto = renderer.autoClear;
    var cc = renderer.getClearColor(new THREE.Color()), ca = renderer.getClearAlpha();
    renderer.setRenderTarget(rt); renderer.setClearColor(0x000000, 1); renderer.clear(); renderer.setRenderTarget(prev);
    var n = Math.min(specs.length, cols * cols), u = NC.mat.uniforms;
    for (var i = 0; i < n; i++) {
      var sp = specs[i];
      u.uSeed.value = ((sp.seed >>> 0) % 9973) / 97.3; u.uColA.value.fromArray(sp.a); u.uColB.value.fromArray(sp.b);
      u.uBright.value = sp.bright != null ? sp.bright : 1; u.uStars.value = sp.stars != null ? sp.stars : 1;
      rt.texture.generateMipmaps = i === n - 1;
      rt.viewport.set((i % cols) * cell, Math.floor(i / cols) * cell, cell, cell);
      rt.scissor.set((i % cols) * cell, Math.floor(i / cols) * cell, cell, cell); rt.scissorTest = true;
      renderer.setRenderTarget(rt); renderer.autoClear = false;
      renderer.render(NC.scene, C.cam);
    }
    rt.scissorTest = false;
    renderer.setRenderTarget(prev); renderer.autoClear = auto; renderer.setClearColor(cc, ca);
    return rt.texture;
  }
  function release(tex) {
    var sig = tex && tex.nbGalaxySig, e = sig && C.cache[sig];
    if (!e) return;
    if (--e.refs <= 0) { e.rt.dispose(); delete C.cache[sig]; }
  }
  function discMaterial(tex) {
    return new THREE.ShaderMaterial({
      uniforms: { map: { value: tex }, uK: { value: 1 }, uNear: { value: new THREE.Vector2(40, 220) } },
      vertexShader: DISC_VS, fragmentShader: DISC_FS, transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor
    });
  }
  window.NB_GALAXY = { DEC_GLSL: ENC_GLSL, bake: bake, bakeAtlas: bakeAtlas, bakeNebulaAtlas: bakeNebulaAtlas, release: release, discMaterial: discMaterial, stats: function () { return Object.keys(C.cache).length; } };
})();
