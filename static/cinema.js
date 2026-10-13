/* cinema.js — cinematic grade, camera banking and the on-screen "now showing"
   caption for the wall dashboard.
   ---------------------------------------------------------------------------
   Reads:   NETSCENE.tour   stop key/name/list, phase, progress (no API of its
                            own — every number in the caption is a number the
                            topology scene already holds)
   ---------------------------------------------------------------------------
   Loads LAST (after netscene.js / netscene_flows.js / galaxy.js). It owns three
   things nothing else does, and touches no data and no scene geometry:

     1 GRADE   a single fullscreen ShaderPass appended after the bloom pass:
               radial chromatic aberration, speed-keyed radial blur, filmic
               contrast/saturation, cool-shadow split tone, vignette, grain,
               optional letterbox. One pass, ~4 taps worst case.
     2 BANK    the auto-tour camera rolls into its own lateral motion. The roll
               is applied through cam.up, which OrbitControls consumes in its
               lookAt() — position is untouched, so framing is unchanged.
     3 CAPTION a broadcast lower-third above #data naming the stop the tour is
               currently flying, what it is, and its live numbers, plus a
               segmented progress bar. netscene's setTourText() has written to
               #tour since August, but #tour is display:none — the tour has been
               narrating to nobody. This is that narration, made legible.
     4 MOVES   OPT-IN cinematic camera moves (CONFIG.features.cinematics):
               after every N tour laps (CONFIG.cinematics.laps, default 3) one
               of four moves plays - a barrel roll through the topology, an
               exploded view of the tiers, a close-up on one node with its
               real numbers, a flight along the strongest measured link - and
               the camera is handed back to the tour exactly where it was.

   All DOM and CSS is injected from here, so index.html needs exactly one
   <script> line and no template edits (index.html is Jinja — braces are
   hazardous there, and none of this needs to live in it).

   TOGGLES (kiosk keyboard, ignored while typing in the chat box)
     c   cinema mode  — letterbox + heavier grade, for recording
     h   HUD          — hide the rails/panels for a clean plate
     g   grade        — bypass the whole pass (A/B check)
     m   move         — play the next cinematic move now (features.cinematics)

   NON-NEGOTIABLES (inherited from galaxy.js / netscene.js, do not break)
   * video-safe: no strobing. Grain is the only per-frame term and it is
     capped well below the point where h.264 starts chewing bitrate on it.
   * perf: the pass self-disables if the frame rate sits under 24 fps for 3 s,
     so the SwiftShader fallback path degrades instead of crawling.
   * the graph is the subject. The grade darkens corners and lifts midtones;
     it must never pull the eye off the centre.
   --------------------------------------------------------------------------- */
(function () {
  'use strict';

  var THREE = window.THREE;
  if (!THREE) return;

  /* ---------------- tunables ---------------- */
  var GRADE = {
    ca:     0.0016,   // ~2 px of fringing at the corners, 0 at centre
    vig:    0.42,     // vignette depth at the corners
    grain:  0.014,    // film grain amplitude
    sat:    1.02,     // saturation (was 1.12: the clean pass wants a restrained palette, 2026-10-07)
    con:    1.05,     // contrast about mid grey
    lift:   0.55,     // cool-shadow / warm-highlight split tone
    bar:    0.0,      // letterbox fraction per edge
    /* HDR tone (2026-10-08, NB_HDR): exposure into the filmic curve, a trim
       after it, a display lift for the faint haze and a black point */
    pre:    1.9,
    expo:   0.94,
    gam:    1.0,
    black:  0.0
  };
  var CINEMA = {       // deltas applied on top in cinema mode
    ca: 0.0030, vig: 0.55, grain: 0.030, sat: 1.24, con: 1.09, lift: 0.85,
    bar: 0.055, pre: 1.9, expo: 0.94, gam: 1.0, black: 0.0
  };
  /* eye comfort (2026-10-05): a touch less bloom and a higher threshold, so
     only true cores glow and halos stop washing over labels; the grade's
     highlight shoulder (uKnee) rolls the rest off instead of clipping */
  var BLOOM = { strength: 0.56, radius: 0.55, threshold: 0.74 };
  /* HDR (2026-10-08): the threshold is in linear scene radiance now, above the
     brightest diffuse light, so only star cores, hub stars and galaxy nuclei
     bloom; the knee (index.html smoothWidth) keeps the onset soft */
  var HDR = !!window.NB_HDR;
  /* hue-preserving highlight blend (0 = plain per-channel ACES); ?hue=<k> for A/B */
  var HUE_K = (function () { var m = location.search.match(/[?&]hue=([\d.]+)/); return m ? parseFloat(m[1]) : 0.5; })();
  if (HDR) BLOOM = { strength: 0.62, radius: 0.5, threshold: 1.25 };

  var BANK_MAX   = 0.075;   // rad of roll at full lateral speed (~4.3 deg)
  var BANK_GAIN  = 0.00042; // rad per world-unit/s of lateral camera velocity
  var BANK_EASE  = 1.9;     // roll smoothing (higher = snappier)
  var BLUR_GAIN  = 2.4e-5;  // radial blur per normalised unit/s of dolly speed
  var BLUR_MAX   = 0.0045;  // ~18 px of smear at the corners at 1920 wide

  /* ?grade=force pins the grade on and disables the perf guard (the headless
     QA browser has no GPU and would always trip it); ?grade=off starts bypassed */
  var Q = (location.search.match(/[?&]grade=(\w+)/) || [])[1] || '';
  /* ?aa=on|off: A/B of the 4-tap quarter-texel resolve (QA) */
  var AA_Q = (location.search.match(/[?&]aa=(\w+)/) || [])[1] || '';
  /* default: FXAA (crisp interiors, smooth edges, ~free); 'on' = the old
     4-tap box; 'off' = raw. A multisampled scene target (?msaa=4) needs none. */
  var AA_MODE = AA_Q || (window.NB_MSAA ? 'off' : 'fxaa');
  var AA_SOFT = AA_MODE === 'on';

  /* RENDER SCALE (2026-10-05, replaces the supersample ladder).
     The old ladder set rndr.setPixelRatio(2), but the composer had captured
     pixelRatio 1 at construction, so the scene was always drawn at 1x and the
     grade pass only upscaled it into a 3840x2160 MSAA canvas that the compositor
     then shrank again: 4x the pixels for nothing. Now the canvas is native
     (index.html) and only the composer's targets scale, via NB_RS.S:
       1.0 = what was approved (scene at CSS resolution); under GPU contention
       it steps down to 0.6 and back, one rung at a time, with hysteresis.
     Driven by measured GPU frame time (NB_PERF, timer queries around the whole
     frame), because rAF intervals stay at 16.7 ms while frames are dropped.
     Text never scales: it is drawn after the grade, straight to the canvas.
     ?rs=<S> pins a scale (QA). */
  var RS_LADDER = [0.6, 0.7, 0.8, 0.9, 1.0];
  var RS_PIN = parseFloat((location.search.match(/[?&]rs=([\d.]+)/) || [])[1]) || 0;
  var RS_DOWN_MS = 12.5;     // sustained p75 GPU time above this: step down
  var RS_UP_MS = 7.0;        // predicted p75 at the next rung below this: step up
  /* grain was hashed per 4K pixel and averaged 2x2 by the compositor, which
     halves its amplitude; at native resolution the same look needs half */
  var GRAIN_K = Math.min(1, ((window.NB_RS && NB_RS.cpr) || 1) / 2);

  var C = {
    on: Q !== 'off', cinema: false, hud: true, force: Q === 'force',
    ss: 1, rsIdx: RS_LADDER.length - 1, slowRS: 0, fastRS: 0, rsHoldUntil: 0, gpuMs: -1,
    pass: null, u: null, t: 0,
    roll: 0, prevPos: null, prevTgt: new THREE.Vector3(), speed: 0,
    fpsAcc: 0, fpsN: 0, slowFor: 0, fastFor: 0, degraded: false,
    el: null, lastKey: '', lastStats: ''
  };
  var WARMUP = 10;          // s of scene build / texture upload to ignore

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }

  /* ======================= 1. the grade pass ======================= */

  var GradeShader = {
    uniforms: {
      tDiffuse: { value: null },
      uRes:     { value: new THREE.Vector2(1, 1) },
      uTime:    { value: 0 },
      uCA:      { value: GRADE.ca },
      uVig:     { value: GRADE.vig },
      uGrain:   { value: GRADE.grain },
      uSat:     { value: GRADE.sat },
      uCon:     { value: GRADE.con },
      uLift:    { value: GRADE.lift },
      uSpeed:   { value: 0 },
      uBar:     { value: 0 },
      uGlitch:  { value: 0 },
      uKnee:    { value: 0.62 },
      uExpo:    { value: 0.94 },
      uHdr:     { value: 0 },
      uPre:     { value: 1.9 },
      uGam:     { value: 1.0 },
      uBlack:   { value: 0.0 },
      uHue:     { value: HUE_K },
      uTexel:   { value: new THREE.Vector2(0, 0) },
      uFxaa:    { value: 0 },
      uPx:      { value: new THREE.Vector2(0, 0) }
    },
    vertexShader: [
      'varying vec2 vUv;',
      'void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }'
    ].join('\n'),
    fragmentShader: [
      'varying vec2 vUv;',
      'uniform sampler2D tDiffuse;',
      'uniform vec2  uRes;',
      'uniform float uTime, uCA, uVig, uGrain, uSat, uCon, uLift, uSpeed, uBar, uGlitch, uKnee, uExpo;',
      'uniform float uHdr, uPre, uGam, uBlack, uHue;',
      'uniform vec2  uTexel; uniform float uFxaa; uniform vec2 uPx;',
      /* ACES filmic (Hill's RRT+ODT fit, the same curve three applied per material
         before 2026-10-08), now applied ONCE to the whole HDR frame */
      'vec3 rrtOdt(vec3 v){ vec3 a = v * (v + 0.0245786) - 0.000090537; vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081; return a / b; }',
      'vec3 acesFilm(vec3 c){',
      '  const mat3 IN = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);',
      '  const mat3 OUT = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);',
      '  return clamp(OUT * rrtOdt(IN * c), 0.0, 1.0);',
      '}',

      /* radial split: red pushed out, blue pulled in. Strength rises with r^2 so
         the centre — where the graph lives — stays perfectly registered. */
      'vec3 tap(vec2 uv, float ca){',
      '  vec2 d = uv - 0.5;',
      '  return vec3(texture2D(tDiffuse, uv + d*ca).r,',
      '              texture2D(tDiffuse, uv).g,',
      '              texture2D(tDiffuse, uv - d*ca).b);',
      '}',

      'float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }',
      /* FXAA (2026-10-05, round 4): edge-directed AA on the scene texel grid.
         Replaces the 4-tap quarter-texel box (a uniform half-pixel blur that
         softened every body, star and 1 px link). Flat areas - most of the
         frame - early-out on the local contrast test and stay pixel-sharp. */
      'vec3 fxaa(vec2 uv){',
      '  vec3 rgbM = texture2D(tDiffuse, uv).rgb;',
      '  vec3 L = vec3(0.299, 0.587, 0.114);',
      '  float lNW = dot(texture2D(tDiffuse, uv + vec2(-1.0, -1.0) * uPx).rgb, L);',
      '  float lNE = dot(texture2D(tDiffuse, uv + vec2( 1.0, -1.0) * uPx).rgb, L);',
      '  float lSW = dot(texture2D(tDiffuse, uv + vec2(-1.0,  1.0) * uPx).rgb, L);',
      '  float lSE = dot(texture2D(tDiffuse, uv + vec2( 1.0,  1.0) * uPx).rgb, L);',
      '  float lM = dot(rgbM, L);',
      /* HDR (2026-10-08): judge edges on a compressed luma, and leave a local PEAK
         alone - a star is a point, not an edge; blending it along a "direction"
         printed small x / H shapes on every star of the wall */
      '  if (uHdr > 0.5) { lNW /= 1.0 + lNW; lNE /= 1.0 + lNE; lSW /= 1.0 + lSW; lSE /= 1.0 + lSE; lM /= 1.0 + lM; }',
      '  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));',
      '  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));',
      '  if (lMax - lMin < max(0.03, lMax * 0.12)) return rgbM;',
      /* (after the cheap early-out, so flat sky never pays the 4 extra taps) */
      '  if (uHdr > 0.5) {',
      '    float lN = dot(texture2D(tDiffuse, uv + vec2(0.0, -1.0) * uPx).rgb, L), lS = dot(texture2D(tDiffuse, uv + vec2(0.0, 1.0) * uPx).rgb, L);',
      '    float lW = dot(texture2D(tDiffuse, uv + vec2(-1.0, 0.0) * uPx).rgb, L), lE = dot(texture2D(tDiffuse, uv + vec2(1.0, 0.0) * uPx).rgb, L);',
      '    lN /= 1.0 + lN; lS /= 1.0 + lS; lW /= 1.0 + lW; lE /= 1.0 + lE;',
      '    float lMx = max(max(max(lNW, lNE), max(lSW, lSE)), max(max(lN, lS), max(lW, lE)));',
      '    if (lM >= lMx * 0.98) return rgbM;',
      /* the flank of a point (a star): at most two bright neighbours and a much brighter
         one among them. FXAA would read the point as a diagonal edge and smear it into an
         x; a real edge (a planet limb, a line) has three or more bright neighbours */
      '    float hb = 0.5 * lMx;',
      '    float nb = step(hb, lNW) + step(hb, lNE) + step(hb, lSW) + step(hb, lSE) + step(hb, lN) + step(hb, lS) + step(hb, lW) + step(hb, lE);',
      '    if (nb <= 2.0 && lMx > 2.0 * lM) return rgbM;',
      '  }',
      '  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));',
      '  float red = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);',
      '  float rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + red);',
      '  dir = clamp(dir * rcp, vec2(-8.0), vec2(8.0)) * uPx;',
      '  vec3 a = 0.5 * (texture2D(tDiffuse, uv + dir * (1.0 / 3.0 - 0.5)).rgb + texture2D(tDiffuse, uv + dir * (2.0 / 3.0 - 0.5)).rgb);',
      '  vec3 b = a * 0.5 + 0.25 * (texture2D(tDiffuse, uv - dir * 0.5).rgb + texture2D(tDiffuse, uv + dir * 0.5).rgb);',
      '  float lB = dot(b, L); if (uHdr > 0.5) lB /= 1.0 + lB;',
      '  return (lB < lMin || lB > lMax) ? a : b;',
      '}',

      'void main(){',
      '  vec2 uv = vUv;',
      '  vec2 d  = uv - 0.5;',
      '  float r2 = dot(d, d);',
      '  float ca = uCA * r2 * 2.0;',   // 0 at centre, uCA at the corners

      /* ---- glitch: driven by doom.js during the takeover transitions ----
         Horizontal bands get shoved sideways in hard steps, the colour split
         goes wide, and a few scanlines blow out white. Sampling clamps at the
         edges, which smears the outermost column - exactly the artefact a
         torn video signal produces, so we lean on it rather than hide it. */
      '  float tear = 0.0;',
      '  if (uGlitch > 0.001) {',
      '    float band = floor(uv.y * 26.0);',
      '    float n = hash(vec2(band, floor(uTime * 18.0)));',
      '    d.x += step(0.72 - uGlitch * 0.45, n) * (n - 0.5) * 0.20 * uGlitch;',
      '    uv = d + 0.5;',
      '    ca += uGlitch * 0.014;',
      '    float n2 = hash(vec2(floor(uv.y * 140.0), floor(uTime * 24.0)));',
      '    tear = step(0.992 - uGlitch * 0.020, n2) * uGlitch;',
      '  }',

      /* speed-keyed radial blur: only ever non-zero mid-flight between tour
         stops, so the still frames a viewer actually reads stay sharp. */
      '  vec3 col;',
      /* AA resolve (2026-10-05): the approved image was the scene upscaled 2x
         by this pass and box-filtered back down by the compositor, i.e. four
         bilinear taps a quarter texel off centre. Doing exactly that here, at
         native resolution, keeps the same softness on 1 px lines for a quarter
         of the pixels. uTexel = 0 (scaled-down scene: the upscale already
         softens) collapses it to one tap. */
      '  if (uSpeed > 0.0005) {',
      '    col = vec3(0.0); float w = 0.0;',
      '    for (int i = 0; i < 4; i++) {',
      '      float f = 1.0 - float(i) * uSpeed;',
      '      float wi = 1.0 - float(i) * 0.18;',
      '      col += tap(0.5 + d * f, ca) * wi; w += wi;',
      '    }',
      '    col /= w;',
      '  } else if (uFxaa > 0.5) {',
      /* AA on the centre, the corner colour split re-applied on r/b only
         where it is visible (it is 0 at the centre, where the graph lives) */
      '    col = fxaa(uv);',
      '    if (ca > 0.0002) { col.r = texture2D(tDiffuse, uv + d * ca).r; col.b = texture2D(tDiffuse, uv - d * ca).b; }',
      '  } else if (uTexel.x > 0.0) {',
      '    col = 0.25 * (tap(uv + uTexel * vec2(0.25, 0.25), ca) + tap(uv + uTexel * vec2(-0.25, 0.25), ca)',
      '              + tap(uv + uTexel * vec2(0.25, -0.25), ca) + tap(uv + uTexel * vec2(-0.25, -0.25), ca));',
      '  } else {',
      '    col = tap(uv, ca);',
      '  }',

      /* TONE (2026-10-05): the scene arrives clipped at 1.0 (8-bit composer
         targets), so emissive peaks hit pure white on the wall. A small
         exposure trim, then a soft shoulder above uKnee on the brightest
         channel, hue-preserving: peaks land at ~0.86 instead of 1.0 and keep
         their colour, while everything below the knee (the starfield, the
         discs, most of the image) is untouched apart from the trim. */
      /* HDR (2026-10-08): the frame arrives as linear radiance (half float, no
         clipping): exposure, the one filmic curve, an optional display lift
         (uGam > 1 opens the faint haze without lifting black), a black point */
      '  if (uHdr > 0.5) {',
      /* a non-finite pixel stays ONE black pixel, never a smear (see index.html bloom) */
      '    if (any(isnan(col)) || any(isinf(col))) col = vec3(0.0);',
      /* hue-preserving shoulder (2026-10-09): per-channel ACES drives every bright
         core to the same neutral white (a golden bulge read as a flat white disc).
         Past the knee, blend toward a max-RGB tonemap that keeps the core's own
         colour (same curve on the peak channel, ratios kept); neutral stars stay
         white, everything below the knee is untouched. */
      '    vec3 xs = clamp(col, 0.0, 64.0) * uPre, pcA = acesFilm(xs);',
      '    float mxs = max(xs.r, max(xs.g, xs.b));',
      '    vec3 hpA = clamp(xs * (acesFilm(vec3(mxs)).g / max(mxs, 1e-4)), 0.0, 1.0);',
      '    float kh = uHue * smoothstep(0.45, 0.92, dot(pcA, vec3(0.2126, 0.7152, 0.0722)));',
      '    col = mix(pcA, hpA, kh) * uExpo;',
      '    col = pow(col, vec3(1.0 / uGam));',
      '    col = max(col - uBlack, vec3(0.0)) / (1.0 - uBlack);',
      '  } else {',
      '  col *= uExpo;',
      '  float pk = max(col.r, max(col.g, col.b));',
      '  if (pk > uKnee) {',
      '    float w = 1.0 - uKnee;',
      '    float pc = uKnee + w * (1.0 - exp(-(pk - uKnee) / w));',
      '    col *= pc / pk;',
      '  }',
      '  }',
      '  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));',
      '  col = mix(vec3(l), col, uSat);',                      // saturation
      /* contrast pivoted at 0.10, not mid grey: this scene is ~90% near-black,
         and a mid-grey pivot crushed the entire starfield to zero */
      '  col = (col - 0.10) * uCon + 0.10;',
      /* split tone: shadows toward deep space blue, highlights left warm */
      '  col += uLift * vec3(-0.006, 0.002, 0.020) * (1.0 - l);',

      '  float vig = smoothstep(1.15, 0.30, r2 * 2.0);',
      '  col *= mix(1.0, vig, uVig);',

      /* grain rides mostly in the shadows, where film grain actually lives —
         keeps it off the bright HUD-adjacent areas and off the bitrate */
      '  float g = hash(uv * uRes + fract(uTime) * 91.7);',
      '  col += (g - 0.5) * uGrain * (1.0 - l * 0.7);',

      '  col += tear * vec3(0.55, 0.72, 0.95);',
      '  if (uBar > 0.0 && (uv.y < uBar || uv.y > 1.0 - uBar)) col = vec3(0.0);',
      '  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);',
      '}'
    ].join('\n')
  };

  function installPass() {
    if (C.pass || !window.composer || !THREE.ShaderPass) return;
    C.pass = new THREE.ShaderPass(GradeShader);
    C.u = C.pass.uniforms;
    window.composer.addPass(C.pass);
    window.CINEMA_PASS = C.pass;
    if (RS_PIN) { var pi = 0; for (var i = 0; i < RS_LADDER.length; i++) if (Math.abs(RS_LADDER[i] - RS_PIN) < Math.abs(RS_LADDER[pi] - RS_PIN)) pi = i; C.rsIdx = pi; }
    rsApply(RS_PIN || RS_LADDER[C.rsIdx], true);
    window.addEventListener('resize', function () { setTimeout(function () { rsApply(C.ss, true); }, 60); });
  }
  function sizePass() {
    if (!C.u || !window.rndr) return;
    var c = window.rndr.domElement, rt = window.composer && window.composer.renderTarget1;
    C.u.uRes.value.set(c.width, c.height);      // the grade draws to the native canvas
    /* the soft 4-tap resolve only where the scene is at least canvas size */
    if (AA_SOFT && rt && rt.width >= c.width - 1) C.u.uTexel.value.set(1 / rt.width, 1 / rt.height); else C.u.uTexel.value.set(0, 0);
    C.u.uFxaa.value = AA_MODE === 'fxaa' ? 1 : 0;
    if (rt) C.u.uPx.value.set(1 / rt.width, 1 / rt.height);
  }

  /* Scene scale: resize only the composer targets (bloom keeps its own fixed
     screen-relative size, see index.html). Point sizes follow NB_RS.K/ptH in
     the same frame, so nothing on screen changes size, only sharpness. */
  function rsApply(r, force) {
    if (!window.rndr || !window.composer) return;
    if (!force && Math.abs(r - C.ss) < 0.01) return;
    C.ss = r;
    if (window.NB_RS) NB_RS.set(r);
    window.composer.setPixelRatio(r);
    sizePass();
  }

  /* ======================= 2. camera banking ======================= */

  var _f = new THREE.Vector3(), _r = new THREE.Vector3(), _v = new THREE.Vector3(),
      _up = new THREE.Vector3(), _WORLD_UP = new THREE.Vector3(0, 1, 0);

  function bankTick(dt) {
    var NS = window.NETSCENE, cam = window.cam;
    if (!cam || !NS || !NS.ctrl) return;

    if (!C.prevPos) { C.prevPos = cam.position.clone(); C.prevTgt.copy(NS.ctrl.target); return; }

    _v.subVectors(cam.position, C.prevPos).divideScalar(Math.max(dt, 1e-3));
    C.prevPos.copy(cam.position);

    _f.subVectors(NS.ctrl.target, cam.position);
    var dist = _f.length() || 1;
    _f.divideScalar(dist);
    _r.crossVectors(_f, _WORLD_UP);
    if (_r.lengthSq() < 1e-8) _r.set(1, 0, 0); else _r.normalize();

    /* Bank into the turn: lateral velocity leans the horizon the opposite way,
       exactly as a camera ship would. Normalised by distance so a fast wide
       swing and a slow close one read the same. */
    var scale = 320 / Math.max(dist, 120);      // same swing reads the same close or wide
    var lateral = _v.dot(_r) * scale;
    var manual = !!(NS.tour && NS.tour.manual);
    /* + the leg's own authored roll (netscene legPath: dolly / swoop / reveal,
       a few degrees, zero at both ends of the leg) */
    var legRoll = (!manual && NS.legRoll) ? NS.legRoll : 0;
    var target = manual ? 0 : clamp(-lateral * BANK_GAIN + legRoll, -BANK_MAX, BANK_MAX);

    /* a cinematic move may own the roll outright (the barrel roll writes a
       full 2*pi); it hands back at exactly 0, so the lerp below resumes cleanly */
    if (MV.roll != null) C.roll = MV.roll;
    else C.roll = lerp(C.roll, target, 1 - Math.exp(-dt * BANK_EASE));
    if (Math.abs(C.roll) < 1e-4) C.roll = 0;

    /* roll = rotate the up vector about the view axis. OrbitControls rebuilds
       position from (target, offset) through a quat/quatInverse round trip, so
       a tilted up changes orientation only — never the framing we measured. */
    _up.copy(_WORLD_UP).applyAxisAngle(_f, C.roll);
    cam.up.copy(_up);

    /* the same normalised speed drives the radial blur */
    var spd = Math.abs(_v.dot(_f)) * scale + Math.abs(lateral);
    C.speed = lerp(C.speed, spd, 1 - Math.exp(-dt * 6));
  }

  /* ======================= 3. the caption ======================= */

  var CSS = [
    /* 2026-10-08 (contracts 7 / 7a): a product caption, not a broadcast
       headline. One title line (18 px / 500), one line of facts (13 px) with
       units, status colour only where something is wrong, and a hairline
       progress track. No "now showing", no flavour copy, no tracking. */
    '#cin{position:fixed;z-index:6;bottom:calc(212px + var(--sy));',
    '  left:calc(var(--cL) + var(--sx));right:calc(var(--cR) + var(--sx));',
    '  pointer-events:none;opacity:0;transition:opacity .45s ease;',
    '  display:flex;flex-direction:column;align-items:center;gap:4px;',
    '  font-family:var(--ui-font,Inter,system-ui,sans-serif);letter-spacing:0;font-variant-numeric:tabular-nums}',
    '#cin.on{opacity:1}',
    '#cin .cname{font-size:18px;line-height:24px;font-weight:500;color:var(--t1,#e6e9ee);text-align:center;',
    '  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}',
    '#cin .cfacts{font-size:13px;line-height:18px;color:var(--t2,#9aa4b1);text-align:center;white-space:nowrap;',
    '  overflow:hidden;text-overflow:ellipsis;max-width:100%}',
    '#cin .cfacts b{font-weight:500;color:var(--t1,#e6e9ee)}',
    '#cin .cfacts i.mute{font-style:normal;color:var(--t3,#7d8590)} #cin .cfacts b.bad{color:var(--crit,#f85149)} #cin .cfacts b.warn{color:var(--warn,#d29922)} #cin .cfacts b.ok{color:var(--ok,#3fb950)}',
    '#cin .cfacts i{font-style:normal;color:var(--t3,#6b7584);padding:0 6px}',
    /* aspect card (contracts 9.2): one row of up to four facts, k small grey, v tabular, unit small */
    '#cin .cfacts .af{display:inline-flex;align-items:baseline;gap:5px;padding:0 10px}',
    '#cin .cfacts .af em{font-style:normal;font-size:12px;color:var(--t3,#7d8590)}',
    '#cin .cfacts .af b{font-size:14px} #cin .cfacts .af u{text-decoration:none;font-size:12px;color:var(--t2,#9aa4b1)}',
    '#cin .cfacts .af+.af{border-left:1px solid rgba(255,255,255,.12)}',
    /* legibility over bright galaxy cores (aspect stops park the camera near one): a dark halo, not a glow */
    '#cin .cname,#cin .cfacts{text-shadow:0 1px 2px rgba(0,0,0,.95),0 0 6px rgba(0,0,0,.75)}',
    '#cin .cfacts .af em,#cin .cfacts i.mute{color:#a3acb8}',
    /* text changes cross-fade (contracts 9.4: nothing pops) */
    '#cin .cname,#cin .cfacts{transition:opacity .26s ease}',
    '#cin.swap .cname,#cin.swap .cfacts{opacity:0}',
    '#cin .cbar{display:flex;gap:2px;width:min(360px,50%);margin-top:4px}',
    '#cin .cbar i{flex:1;height:2px;border-radius:1px;background:rgba(255,255,255,.10);transition:background .35s ease}',
    '#cin .cbar i.done{background:rgba(255,255,255,.22)}',
    '#cin .cbar i.now{background:rgba(230,233,238,.85)}',
    '#cin .cwrap{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;',
    '  justify-content:center;max-width:100%}',
    '#cin .ceyebrow{font-size:8px;letter-spacing:2.2px;color:var(--ink3);',
    '  text-transform:uppercase;white-space:nowrap}',
    '#cin .csub{font-size:9.5px;letter-spacing:.5px;color:var(--ink3);text-align:center}',
    '#cin .cstats{display:flex;gap:14px;justify-content:center;flex-wrap:wrap;margin-top:1px}',
    '#cin .cstats div{font-size:8px;letter-spacing:1.3px;color:var(--ink3);text-align:center;',
    '  text-transform:uppercase}',
    '#cin .cstats b{display:block;font-size:11.5px;letter-spacing:.3px;color:var(--ink1);',
    '  font-variant-numeric:tabular-nums;text-transform:none}',
    '#cin .cstats b.rx{color:var(--accent)}',
    '#cin .cstats b.tx{color:#ff4fa3}',
    '#cin .cstats b.bad{color:var(--down)}',
    '#cin .cstats b.warn{color:var(--warn)}',
    '#cin .cstats b.fresh{color:var(--ok)}',
    /* letterbox bars sit above everything, including the HUD */
    '#cinbars{position:fixed;inset:0;z-index:20;pointer-events:none;opacity:0;',
    '  transition:opacity .5s ease}',
    'body.cin-rec #cinbars{opacity:1}',
    '#cinbars b{position:absolute;left:0;right:0;height:5.5vh;background:#000;display:block}',
    '#cinbars b.t{top:0} #cinbars b.b{bottom:0}',
    /* clean-plate mode */
    'body.cin-nohud #railL,body.cin-nohud #railR,body.cin-nohud #stat,',
    'body.cin-nohud #data,body.cin-nohud #chat{opacity:0;transition:opacity .4s ease;',
    '  pointer-events:none}'
  ].join('\n');

  /* sit the caption directly above #data, measured — #data's height changes
     with the breakpoints and with how many rows the alert panel is showing */
  function place() {
    if (!C.el) return;
    var d = document.getElementById('data');
    if (!d) return;
    var top = d.getBoundingClientRect().top;
    if (top > 0) C.el.style.bottom = Math.round(window.innerHeight - top + 16) + 'px';
  }

  function mountDom() {
    if (C.el) return;
    var st = document.createElement('style');
    st.id = 'cin-css'; st.textContent = CSS;
    document.head.appendChild(st);

    var el = document.createElement('div');
    el.id = 'cin';
    el.innerHTML = '<div class="cname" id="cin-name"></div><div class="cfacts" id="cin-facts"></div><div class="cbar" id="cin-bar"></div>';
    document.body.appendChild(el);

    var bars = document.createElement('div');
    bars.id = 'cinbars';
    bars.innerHTML = '<b class="t"></b><b class="b"></b>';
    document.body.appendChild(bars);

    C.el = el;
    place();
    window.addEventListener('resize', function () { setTimeout(place, 60); });
    setInterval(place, 4000);        // #data reflows when alerts appear/clear
    C.name = document.getElementById('cin-name');
    C.facts = document.getElementById('cin-facts');
    C.bar = document.getElementById('cin-bar');
  }

  function fmtRate(bytesPerSec) { return fmtBits((+bytesPerSec || 0) * 8); }
  function fmtBits(b) {
    b = Math.max(0, +b || 0);
    if (b < 1e3) return b.toFixed(0) + ' b/s';
    if (b < 1e6) return (b / 1e3).toPrecision(3).replace(/\.0+$|(\.\d*?)0+$/, '$1') + ' kb/s';
    if (b < 1e9) return (b / 1e6).toPrecision(3).replace(/\.0+$|(\.\d*?)0+$/, '$1') + ' Mb/s';
    return (b / 1e9).toPrecision(3) + ' Gb/s';
  }
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }

  /* the bodies of the system(s) a stop shows, from the registry */
  function stopBodies(st, NS) {
    var U = NS.U, out = [];
    if (!U || !U.active) return out;
    var sid = st.sysId || null, k = st.key || '';
    if (!sid && (k.indexOf('host:') === 0 || k.indexOf('blk:') === 0)) {
      var hid = k.indexOf('host:') === 0 ? k.slice(5) : k.split(':').slice(1, 3).join(':');
      var sy = U.sysOfAnchor ? U.sysOfAnchor(hid) : null; sid = sy ? sy.id : null;
    }
    if (!sid) return out;
    var cat = k.indexOf('blk:') === 0 ? k.split(':').pop() : null;
    for (var i = 0; i < U.bodies.length; i++) {
      var b = U.bodies[i];
      if (b.system !== sid) continue;
      if (cat && !((b['class'] === 'guest_vm' || b['class'] === 'guest_lxc') && (b.cat || 'infra') === cat)) continue;
      out.push(b);
    }
    return out;
  }

  /* live numbers for whatever is on screen, as one line of plain facts */
  function factsFor(st, NS) {
    var k = st.key || '', U = NS.U, d = window.NB_ALL || {}, u = d.unifi || {}, f = [];
    function issue(list) {
      /* only a real outage is red (2026-10-09): the registry tells a powered-off guest
         ("stopped") and a device not seen for days ("gone") apart from an offline one
         (bodies[].down_why). Without the field every down body counts as offline. */
      var down = 0, lossy = 0, fresh = 0, stopped = 0, gone = 0;
      list.forEach(function (b) {
        if (b.status === 'down') {
          if (b.down_why === 'stopped') stopped++;
          else if (b.lab) gone++;                         // lab gear is never an outage (contracts 9.3)
          else if (b.down_why === 'gone') gone++;
          else down++;
        }
        var m = b.m || (b.meta || {});
        if (m.loss && m.loss < 100) lossy++;
        if (b['new']) fresh++;
      });
      if (down) f.push('<b class="bad">' + down + ' down</b>');
      if (lossy) f.push('<b class="warn">packet loss on ' + plural(lossy, 'host') + '</b>');
      if (!down && !lossy) f.push(stopped || gone ? 'no outages' : 'all up');
      if (fresh) f.push('<b class="ok">' + fresh + ' new</b>');
      if (stopped) f.push('<i class="mute">' + stopped + ' stopped</i>');
      if (gone) f.push('<i class="mute">' + gone + ' not seen</i>');
    }
    function rates(list) {
      var rx = 0, tx = 0, any = false;
      list.forEach(function (b) { var m = b.m || {}; if (m.rx_bps != null) { rx += +m.rx_bps; any = true; } if (m.tx_bps != null) { tx += +m.tx_bps; any = true; } });
      if (any) f.push('<b>' + fmtBits(rx) + '</b> in · <b>' + fmtBits(tx) + '</b> out');
    }
    if (st.stream) {
      var s = st.stream, T = NS.T;
      f.push('<b>' + (s.lb ? '≥ ' : s.sampled ? '≈ ' : '') + fmtBits(s.bps) + '</b>');
      f.push(T && T.kindName ? T.kindName(s.kind) : s.kind);
      if (s.lb) f.push('lower bound, from flows');
      else f.push(s.dir ? 'both directions measured' : 'direction not measured');
      return f;
    }
    if (k.indexOf('over') === 0) {
      var n = U && U.active ? U.bodies.length : (NS.nodes || []).length, ns = U && U.active ? U.systems.length : 0;
      f.push('<b>' + n + '</b> devices');
      if (ns) f.push('<b>' + ns + '</b> groups');
      if (u.rx != null) f.push('internet <b>' + u.rx + '</b> / <b>' + u.tx + '</b> Mb/s');
      if (U && U.active) issue(U.bodies);
      return f;
    }
    if (k === 'wan') {
      if (u.rx != null) f.push('<b>' + u.rx + ' Mb/s</b> in · <b>' + u.tx + ' Mb/s</b> out');
      if (u.latency != null) f.push('latency <b>' + u.latency + ' ms</b>');
      if (u.isp) f.push(u.isp);
      if (u.wan_up && u.wan_up !== 'ok') f.push('<b class="bad">WAN ' + u.wan_up + '</b>');
      return f;
    }
    var list = stopBodies(st, NS);
    if (!list.length) {
      var nn = (st.list || []).length; if (nn) f.push(plural(nn, 'device'));
      return f;
    }
    var guests = list.filter(function (b) { return b['class'] === 'guest_vm' || b['class'] === 'guest_lxc'; });
    if (k.indexOf('host:') === 0) { f.push('Proxmox host'); f.push('<b>' + guests.length + '</b> guests'); rates(guests); issue(guests); }
    else if (k.indexOf('blk:') === 0) { f.push('<b>' + guests.length + '</b> guests'); rates(guests); issue(guests); }
    else if (k === 'fabric') {
      var sw = list.filter(function (b) { return b.hub || b['class'] === 'switch'; }).length;
      f.push('<b>' + list.length + '</b> devices'); if (sw) f.push('<b>' + sw + '</b> switches'); issue(list);
    } else { f.push('<b>' + list.length + '</b> devices'); issue(list); }
    return f;
  }

  /* the aspect card's one row (contracts 9.1 facts: k, v, optional u, s for
     status colour only); no facts -> the aspect's plain sentence */
  function escH(x) { return String(x == null ? '' : x).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function aspectFacts(st, NS) {
    var a = NS.aspectOf ? NS.aspectOf(st.aspect) : null;
    if (!a) return '';
    var F = (Array.isArray(a.facts) ? a.facts : []).filter(function (f) { return f && f.k != null && f.v != null; }).slice(0, 4);
    if (!F.length) return escH(a.line || '');
    return F.map(function (f) {
      var c = f.s === 'crit' ? ' class="bad"' : f.s === 'warn' ? ' class="warn"' : '';
      return '<span class="af"><em>' + escH(f.k) + '</em><b' + c + '>' + escH(f.v) + '</b>' + (f.u ? '<u>' + escH(f.u) + '</u>' : '') + '</span>';
    }).join('');
  }

  function renderCaption() {
    var NS = window.NETSCENE;
    if (!C.el || !NS || !NS.tour || !NS.tour.stops || !NS.tour.stops.length) return;
    var TR = NS.tour;

    if (MV.on) { renderMoveCaption(); C.el.classList.add('on'); return; }

    if (TR.manual) {
      if (C.lastKey !== '~manual') {
        C.lastKey = '~manual'; C.lastName = 'Manual camera'; C.swapUntil = 0; C.el.classList.remove('swap');
        C.name.textContent = 'Manual camera';
        C.facts.innerHTML = 'drag to orbit <i>·</i> scroll to zoom <i>·</i> click a device for details';
        C.bar.innerHTML = '';
      }
      if (!C.onSet) { C.el.classList.add('on'); C.onSet = true; }
      return;
    }

    /* mid-flight the frame belongs to whichever stop is materialised: netscene
       hands that over at the halfway mark, so the caption changes with it */
    var showIdx = (TR.phase === 'travel' && TR.switched) ? TR.next : TR.idx;
    var st = TR.stops[showIdx];
    if (!st) return;

    var key = st.key + '|' + showIdx + '|' + TR.stops.length;
    if (key !== C.lastKey) {
      var nameChanged = C.lastName !== st.name;
      C.lastKey = key;
      var bar = '';
      for (var i = 0; i < TR.stops.length; i++)
        bar += '<i class="' + (i === showIdx ? 'now' : (i < showIdx ? 'done' : '')) + '"></i>';
      if (bar !== C.lastBar) {
        /* the segment count changes only on a re-plan: keep the nodes, move the classes, so the track never blinks */
        var kids = C.bar.children;
        if (kids.length === TR.stops.length) for (var q = 0; q < kids.length; q++) kids[q].className = q === showIdx ? 'now' : (q < showIdx ? 'done' : '');
        else C.bar.innerHTML = bar;
        C.lastBar = bar;
      }
      C.lastStats = '';
      /* the title and its facts fade out, swap, fade back in (~0.5 s), never a cut */
      if (nameChanged && C.onSet) {
        C.swapUntil = C.t + 0.27; C.el.classList.add('swap'); C.pendName = st.name;
      } else C.name.textContent = st.name;
      C.lastName = st.name;
    }
    if (C.swapUntil) {
      if (C.t < C.swapUntil) return;
      C.swapUntil = 0; C.name.textContent = C.pendName; C.lastStats = ''; C.statsAt = -1;
      C.el.classList.remove('swap');
    }
    /* facts refresh at 4 Hz at most (the data behind them moves every 5-12 s) */
    if (!C.lastStats || C.t - (C.statsAt || 0) >= 0.25) C.statsAt = C.t; else { if (!C.onSet) { C.el.classList.add('on'); C.onSet = true; } return; }
    var html = st.aspect ? aspectFacts(st, NS) : factsFor(st, NS).join('<i>·</i>');
    if (html !== C.lastStats) { C.lastStats = html; C.facts.innerHTML = html; }
    if (!C.onSet) { C.el.classList.add('on'); C.onSet = true; }
  }

  /* ======================= 4. cinematic moves (opt-in) =======================
     IDEA CREDIT: a user running this dashboard for a homelab called Kosmos
     built his own camera work and described it in GitHub issue #1 - "Camera
     roll and in general a better camera now too. Every 3 laps it plays one of
     4 Animations (Barrel roll through the topology, Explosion view, zoom in on
     one node and showing statistics, zooming in on one strong arc) which looks
     amazing." This is that idea, implemented against the real scene state.

     RULES (all four moves)
     * driven by what is on screen: the orbit radius and elevation come from
       the tour's own overview pose, the exploded tiers are the real node
       kinds, the close-up picks the busiest infra node by measured bps and
       prints ITS numbers, the arc flight picks the highest measured-bps link
       in NETSCENE.links. A move whose subject does not exist (no measured
       link yet) is skipped, never faked.
     * eased in and out: every sub-phase is a smootherstep lerp, so velocity
       is zero at every boundary and the camera never snaps.
     * never a blank frame: every look target is either the graph centre (the
       overview target) or a node / link inside the graph, and the lerp
       between two such targets stays inside the graph's bounding box - the
       same content-anchoring argument nexus.js makes with needsHub(). The
       barrel roll orbits the centre at >= 0.58x the fit distance, so the
       whole estate stays in frame while the horizon turns.
     * hands back cleanly: the tour is PAUSED (netscene freezes its clocks),
       the camera pose at the start is saved, and every move's path ends on
       exactly that pose before the tour is unpaused - so the tour's own
       glide resumes from where it left off with no jump. The user grabbing
       the mouse (or the doom takeover) aborts the move at once.
     * gated: CONFIG.features.cinematics (default OFF). CONFIG.cinematics.laps
       (default 3) is how many complete tour laps run between moves; the
       rotation order is CONFIG.cinematics.moves. ?cinematics=on&laps=1 on the
       URL, or localStorage 'galaxy.cinematics' = 'on', switches it on for one
       kiosk without touching the server. CINEMA.play('roll'|'explode'|
       'closeup'|'arc') plays one on demand (QA); key m plays the next. */
  var MV = { on: false, name: '', t: 0, dur: 0, u: 0, laps: 0, prevIdx: 0, prevNext: 0, prevPhase: '', playedLap: -1, seq: 0,
             roll: null, pose: null, cap: null, sub: null, stats: null, lastStats: '', waitUntil: 0,
             P0: new THREE.Vector3(), T0: new THREE.Vector3(), c: new THREE.Vector3(),
             posV: new THREE.Vector3(), tgtV: new THREE.Vector3() };
  var _a = new THREE.Vector3(), _b = new THREE.Vector3(), _m = new THREE.Vector3(), _p = new THREE.Vector3();
  var MOVE_DUR = { roll: 16, explode: 14, closeup: 13, arc: 13 };
  var MOVE_EYE = { roll: 'cinematic · barrel roll', explode: 'cinematic · exploded view',
                   closeup: 'cinematic · close-up', arc: 'cinematic · strongest link' };

  function cfgC() { return window.CONFIG || {}; }
  function cinematicsOn() { return !!((cfgC().features || {}).cinematics); }
  function lapsPer() { var c = cfgC().cinematics; return Math.max(1, (c && c.laps) || 3); }
  function moveList() { var c = cfgC().cinematics; var l = (c && c.moves) || ['roll', 'explode', 'closeup', 'arc']; return l.filter(function (m) { return MOVE_DUR[m]; }); }
  function ss(x) { x = clamp(x, 0, 1); return x * x * x * (x * (x * 6 - 15) + 10); }
  function orbitPos(out, c, az, el, dist) {
    return out.set(c.x + dist * Math.cos(el) * Math.sin(az), c.y + dist * Math.sin(el), c.z + dist * Math.cos(el) * Math.cos(az));
  }
  function nodePos(out, n) { return out.set(n._cx !== undefined ? n._cx : n._x, n._cy !== undefined ? n._cy : n._y, n._cz !== undefined ? n._cz : n._z); }
  function fmtMs(v) { return v == null ? null : (+v).toFixed(v < 10 ? 2 : 1) + ' ms'; }

  /* the pose the move starts from and must end on, in orbit terms */
  function startFrame(NS) {
    MV.P0.copy(NS.cam.position); MV.T0.copy(NS.ctrl.target);
    _a.subVectors(MV.P0, MV.T0);
    MV.d0 = Math.max(150, _a.length());
    MV.az0 = Math.atan2(_a.x, _a.z);
    MV.el0 = Math.asin(clamp(_a.y / MV.d0, -0.99, 0.99));
  }

  /* ---- 4a. barrel roll: one full orbit of the graph centre, dipping toward
     the plane and in to 0.58x the distance at the midpoint ("through the
     topology"), with a full 2*pi roll across the middle 60% of the move ---- */
  function poseRoll(u) {
    var s = ss(u), dip = Math.sin(Math.PI * s);
    var az = MV.az0 + 2 * Math.PI * s;
    var dist = MV.d0 * (1 - 0.42 * dip);
    var el = MV.el0 - (MV.el0 - 0.12) * dip;
    orbitPos(MV.posV, MV.T0, az, el, dist); MV.tgtV.copy(MV.T0);
    MV.roll = 2 * Math.PI * ss((u - 0.2) / 0.6);
    if (u >= 1) MV.roll = 0;
  }
  function setupRoll(NS) {
    MV.cap = 'BARREL ROLL'; MV.sub = 'one orbit through the whole estate · the horizon turns once';
    var inf = 0, g = 0, cl = 0;
    NS.nodes.forEach(function (n) { if (n.kind === 'guest') g++; else if (n.kind === 'client') cl++; else if (n.kind !== 'external') inf++; });
    MV.stats = function () { return '<div>infra<b>' + inf + '</b></div><div>guests<b>' + g + '</b></div><div>clients<b>' + cl + '</b></div><div>links<b>' + NS.links.length + '</b></div>'; };
    return true;
  }

  /* ---- 4b. exploded view: guests rise, clients sink, infra stays (netscene
     applies NS.explode in its transform sync and re-stretches the links); the
     camera pulls back and up so the three tiers fit, then everything settles ---- */
  function poseExplode(u) {
    var s = ss(u), bell = Math.sin(Math.PI * s);
    var ex = u < 0.3 ? ss(u / 0.3) : u < 0.7 ? 1 : 1 - ss((u - 0.7) / 0.3);
    /* pull back AND up while the tiers are apart: verified in a 1280x720 run
       that +0.16 rad / 1.28x left the dropped client tier clipped at the
       bottom edge; the gap is ~2 x explodeY tall, so the distance grows with it */
    var NS = window.NETSCENE, gap = (NS && NS.explodeY) || 90;
    orbitPos(MV.posV, MV.T0, MV.az0 + 0.35 * Math.sin(2 * Math.PI * s), MV.el0 + 0.30 * bell, MV.d0 * (1 + 0.30 * bell) + 1.6 * gap * ex);
    MV.tgtV.copy(MV.T0); MV.tgtV.y -= 0.25 * gap * ex;      // look a little down into the gap
    MV.explode = u >= 1 ? 0 : ex;
  }
  function setupExplode(NS) {
    var inf = 0, g = 0, cl = 0, meas = 0;
    NS.nodes.forEach(function (n) { if (n.kind === 'guest') g++; else if (n.kind === 'client') cl++; else if (n.kind !== 'external') inf++; });
    NS.links.forEach(function (L) { if (L.measured) meas++; });
    if (!g && !cl) return false;                      // nothing to separate
    MV.cap = 'EXPLODED VIEW'; MV.sub = 'the three tiers pulled apart · guests up · fabric level · clients down';
    MV.stats = function () { return '<div>infra<b>' + inf + '</b></div><div>guests<b>' + g + '</b></div><div>clients<b>' + cl + '</b></div><div>measured links<b>' + meas + '</b></div>'; };
    return true;
  }

  /* ---- 4c. close-up: the infra node moving the most measured traffic (ties:
     the host with the most guests), framed from the tour's own azimuth, a slow
     40-degree orbit at 170 units, its real numbers in the caption ---- */
  function pickNode(NS) {
    var best = null, bestK = -1;
    NS.nodes.forEach(function (n) {
      if (n.kind === 'guest' || n.kind === 'client' || n.kind === 'external') return;
      if (n._foc !== undefined && n._foc < 0.5) return;
      var k = (n.measured ? (+n.rx || 0) + (+n.tx || 0) : 0) + ((n.meta && n.meta.guests) || 0) * 1e3 + (n.kind === 'pvehost' ? 1 : 0);
      if (k > bestK) { bestK = k; best = n; }
    });
    return best;
  }
  function poseHoldNode(v, out, tgt) {
    var R = MV.R * (1 - 0.12 * v);
    orbitPos(out, MV.c, MV.az0 + 0.7 * v, 0.34, R); tgt.copy(MV.c);
  }
  function poseCloseup(u) {
    if (u < 0.25) {
      var s1 = ss(u / 0.25); poseHoldNode(0, _a, _b);
      MV.posV.lerpVectors(MV.P0, _a, s1); MV.posV.y += 0.08 * MV.d0 * Math.sin(Math.PI * s1);
      MV.tgtV.lerpVectors(MV.T0, _b, s1);
    } else if (u < 0.8) {
      poseHoldNode(ss((u - 0.25) / 0.55), MV.posV, MV.tgtV);
    } else {
      var s3 = ss((u - 0.8) / 0.2); poseHoldNode(1, _a, _b);
      MV.posV.lerpVectors(_a, MV.P0, s3); MV.posV.y += 0.08 * MV.d0 * Math.sin(Math.PI * s3);
      MV.tgtV.lerpVectors(_b, MV.T0, s3);
    }
  }
  function setupCloseup(NS) {
    var n = pickNode(NS); if (!n) return false;
    nodePos(MV.c, n); MV.c.y += (n._h || 6) * 0.5;
    MV.R = Math.max(150, 120 + (n._h || 6) * 4);     // OrbitControls floors the distance at 120
    MV.node = n;
    var kids = 0; NS.nodes.forEach(function (k) { if (k.parent === n.id) kids++; });
    MV.cap = String(n.label || n.id).toUpperCase();
    MV.sub = n.kind + (n.ip ? ' · ' + n.ip : '') + (n.meta && n.meta.model ? ' · ' + n.meta.model : '') + ' · ' + kids + ' attached · close-up';
    MV.stats = function () {
      var m = n.meta || {}, h = '';
      h += '<div>state<b class="' + (n.status === 'down' ? 'bad' : '') + '">' + (n.status || '?') + '</b></div>';
      if (n.measured) { h += '<div>down<b class="rx">' + fmtRate(n.rx) + '</b></div><div>up<b class="tx">' + fmtRate(n.tx) + '</b></div>'; }
      if (m.rtt != null) h += '<div>latency<b class="' + (m.rtt > 60 ? 'bad' : m.rtt > 15 ? 'warn' : '') + '">' + fmtMs(m.rtt) + '</b></div>';
      if (m.jitter != null) h += '<div>jitter<b>' + fmtMs(m.jitter) + '</b></div>';
      if (m.loss != null) h += '<div>loss<b class="' + (m.loss ? 'bad' : '') + '">' + m.loss + '%</b></div>';
      if (m.guests != null) h += '<div>guests<b>' + (m.running != null ? m.running + ' / ' : '') + m.guests + '</b></div>';
      if (m.cpu != null) h += '<div>cpu<b>' + Math.round(m.cpu) + '%</b></div>';
      if (m.inet_ms != null) h += '<div>internet<b>' + fmtMs(m.inet_ms) + '</b></div>';
      return h;
    };
    return true;
  }

  /* ---- 4d. strongest arc: the highest measured-bps link in the scene; the
     camera flies along it, beside and above, looking a quarter-length ahead ---- */
  function pickLink(NS) {
    var best = null, bps = 0;
    NS.links.forEach(function (L) {
      if (!L.measured || !L.data) return;
      var a = NS.byId[L.aId], b = NS.byId[L.bId]; if (!a || !b) return;
      if ((a._foc !== undefined && a._foc < 0.5) || (b._foc !== undefined && b._foc < 0.5)) return;
      var v = +L.data.bps || 0; if (v > bps) { bps = v; best = L; }
    });
    return best;
  }
  function poseAlong(v, out, tgt) {
    _m.lerpVectors(MV.la, MV.lb, v);
    out.copy(_m).addScaledVector(MV.side, MV.W).addScaledVector(_p.set(0, 1, 0), MV.H);
    tgt.lerpVectors(MV.la, MV.lb, clamp(v + 0.25, 0, 1));
  }
  function poseArc(u) {
    if (u < 0.25) {
      var s1 = ss(u / 0.25); poseAlong(0, _a, _b);
      MV.posV.lerpVectors(MV.P0, _a, s1); MV.tgtV.lerpVectors(MV.T0, _b, s1);
    } else if (u < 0.8) {
      poseAlong(ss((u - 0.25) / 0.55), MV.posV, MV.tgtV);
    } else {
      var s3 = ss((u - 0.8) / 0.2); poseAlong(1, _a, _b);
      MV.posV.lerpVectors(_a, MV.P0, s3); MV.tgtV.lerpVectors(_b, MV.T0, s3);
    }
  }
  function setupArc(NS) {
    var L = pickLink(NS); if (!L) return false;
    var a = NS.byId[L.aId], b = NS.byId[L.bId];
    MV.la = nodePos(new THREE.Vector3(), a); MV.lb = nodePos(new THREE.Vector3(), b);
    _m.subVectors(MV.lb, MV.la); var len = Math.max(1, _m.length());
    /* the perpendicular on the camera's own side of the link, so the approach
       never crosses through the graph */
    MV.side = new THREE.Vector3(-_m.z, 0, _m.x); if (MV.side.lengthSq() < 1e-6) MV.side.set(1, 0, 0); MV.side.normalize();
    _p.lerpVectors(MV.la, MV.lb, 0.5); _a.subVectors(MV.P0, _p);
    if (_a.dot(MV.side) < 0) MV.side.negate();
    /* beside and above the link, far enough that BOTH endpoints and the beam
       between them read as a route (verified at 1280x720: 120/55 on a ~200-unit
       trunk framed the switch box alone, the link was a slab across the frame) */
    MV.W = Math.max(190, len * 0.75); MV.H = Math.max(100, len * 0.45);
    MV.link = L;
    var bps = +L.data.bps || 0, cap = +L.data.capacity_bps || 0;
    MV.cap = String(a.label || a.id).toUpperCase() + ' ⇄ ' + String(b.label || b.id).toUpperCase();
    MV.sub = 'strongest measured link in the scene · ' + (L.trunk ? 'trunk' : L.arc ? 'wireless' : 'leaf') + ' · flying along it';
    MV.stats = function () {
      var h = '<div>measured<b class="rx">' + fmtRate(bps / 8) + '</b></div>';
      if (cap) h += '<div>capacity<b>' + fmtRate(cap / 8) + '</b></div><div>utilisation<b class="' + (bps / cap > 0.8 ? 'warn' : '') + '">' + (100 * bps / cap).toFixed(1) + '%</b></div>';
      h += '<div>' + String(a.label || a.id) + '<b class="' + (a.status === 'down' ? 'bad' : '') + '">' + (a.status || '?') + '</b></div>';
      h += '<div>' + String(b.label || b.id) + '<b class="' + (b.status === 'down' ? 'bad' : '') + '">' + (b.status || '?') + '</b></div>';
      return h;
    };
    return true;
  }

  var SETUP = { roll: setupRoll, explode: setupExplode, closeup: setupCloseup, arc: setupArc };
  var POSE = { roll: poseRoll, explode: poseExplode, closeup: poseCloseup, arc: poseArc };

  /* start a move now (returns false when its subject is missing). The tour is
     parked at a hold; the move owns the camera until it has returned the pose. */
  function startMove(name) {
    var NS = window.NETSCENE;
    if (MV.on || !NS || !NS.tour || !NS.tour.stops.length || NS.tour.manual || !SETUP[name]) return false;
    /* only with the WHOLE estate materialised (the overview holds): at a
       focused stop everything outside the subject is shrunk away, and an orbit
       or an exploded view of one block is mostly empty sky */
    if (NS.focusAll === false) return false;
    startFrame(NS);
    MV.name = name; MV.cap = ''; MV.sub = ''; MV.stats = null; MV.explode = 0; MV.roll = null; MV.node = null; MV.link = null;
    if (!SETUP[name](NS)) return false;
    MV.on = true; MV.t = 0; MV.u = 0; MV.dur = MOVE_DUR[name]; MV.lastStats = '';
    NS.tour.paused = true;
    C.lastKey = '';
    return true;
  }
  function endMove(abort) {
    var NS = window.NETSCENE;
    MV.on = false; MV.roll = null; MV.explode = 0;
    if (NS) { NS.explode = 0; if (NS.tour) NS.tour.paused = false; }
    if (!abort && NS) { NS.cam.position.copy(MV.P0); NS.ctrl.target.copy(MV.T0); }
    C.lastKey = ''; MV.lastStats = '';
  }
  /* play the next move in the rotation, skipping any whose subject is missing */
  function playNext() {
    var list = moveList(); if (!list.length) return false;
    for (var i = 0; i < list.length; i++) {
      var name = list[(MV.seq + i) % list.length];
      if (startMove(name)) { MV.seq = (MV.seq + i + 1) % list.length; return true; }
    }
    return false;
  }

  function moveTick(t, dt) {
    var NS = window.NETSCENE, TR = NS && NS.tour;
    if (!TR || !TR.stops || !TR.stops.length) return;
    /* lap counter: a lap is an ARRIVAL at stop 0 - the previous frame was the
       travel leg INTO stop 0 from a non-zero stop. A tour rebuilt at stop 0, the
       boot frames that already sit there and the manual fly-home (which sets
       idx = 0 before it flies) are none of those, so none of them count. */
    if (TR.phase === 'hold' && TR.idx === 0 && MV.prevPhase === 'travel' && MV.prevNext === 0 && MV.prevIdx !== 0) { MV.laps++; MV.waitUntil = t + 1.4; }
    MV.prevIdx = TR.idx; MV.prevNext = TR.next; MV.prevPhase = TR.phase;

    if (MV.on) {
      var doom = document.body.dataset.doom || '';
      if (TR.manual || (doom && doom.indexOf('phase=off') !== 0)) { endMove(true); return; }
      /* re-asserted every frame: a topology rebuild mid-move replaces NS.tour
         (netscene carries the flag over, but belt and braces - a running tour
         under a move is exactly the "lands on the wrong stop" bug) */
      TR.paused = true;
      MV.t += dt; MV.u = Math.min(1, MV.t / MV.dur);
      POSE[MV.name](MV.u);
      NS.cam.position.copy(MV.posV); NS.ctrl.target.copy(MV.tgtV);
      if (MV.name === 'explode') NS.explode = MV.explode;
      if (MV.u >= 1) endMove(false);
      return;
    }
    /* automatic play: every N laps, once the arrival glide has settled, from
       the overview hold only (everything is materialised there) */
    if (!cinematicsOn()) return;
    if (TR.phase !== 'hold' || TR.idx !== 0 || TR.manual || t < MV.waitUntil) return;
    if (MV.laps <= 0 || MV.laps % lapsPer() !== 0 || MV.playedLap === MV.laps) return;
    var doom2 = document.body.dataset.doom || '';
    if (doom2 && doom2.indexOf('phase=off') !== 0) return;
    MV.playedLap = MV.laps;
    playNext();
  }

  function renderMoveCaption() {
    var key = '~move|' + MV.name;
    if (C.lastKey !== key) {
      C.lastKey = key;
      C.eye.textContent = MOVE_EYE[MV.name] || 'cinematic';
      C.name.textContent = MV.cap || MV.name.toUpperCase();
      C.sub.textContent = MV.sub || '';
      C.bar.innerHTML = '<i class="now"></i>';
      MV.lastStats = '';
    }
    var h = MV.stats ? MV.stats() : '';
    if (h !== MV.lastStats) { MV.lastStats = h; C.stats.innerHTML = h; }
    var bar = C.bar.firstChild;
    if (bar) { var w = Math.round(MV.u * 100) + '%'; if (bar.style.width !== w) { bar.style.flex = 'none'; bar.style.width = w; } }
  }

  /* ======================= modes & keys ======================= */

  function applyMode() {
    if (!C.u) return;
    var G = C.cinema ? CINEMA : GRADE;
    C.u.uCA.value    = C.on ? G.ca    : 0;
    C.u.uVig.value   = C.on ? G.vig   : 0;
    C.u.uGrain.value = C.on ? G.grain * GRAIN_K : 0;
    C.u.uSat.value   = C.on ? G.sat   : 1;
    C.u.uCon.value   = C.on ? G.con   : 1;
    C.u.uLift.value  = C.on ? G.lift  : 0;
    /* the tone stage is the pipeline, not an effect: it stays on with the grade bypassed */
    C.u.uHdr.value   = HDR ? 1 : 0;
    C.u.uPre.value   = G.pre;
    C.u.uExpo.value  = HDR ? G.expo : 0.94;
    C.u.uGam.value   = G.gam;
    C.u.uBlack.value = G.black;
    C.u.uBar.value   = 0;                    // bars are DOM, so they cover the HUD too
    document.body.classList.toggle('cin-rec', !!C.cinema);
    document.body.classList.toggle('cin-nohud', !C.hud);
  }

  function keys(e) {
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var k = (e.key || '').toLowerCase();
    if (k === 'c') { C.cinema = !C.cinema; applyMode(); }
    else if (k === 'h') { C.hud = !C.hud; applyMode(); }
    else if (k === 'g') { C.on = !C.on; C.degraded = false; applyMode(); }
    else if (k === 'm') { if (cinematicsOn()) playNext(); }
    else return;
    e.preventDefault();
  }

  /* once a second. GPU p75 over the last ~1 s of frames; without timer queries
     fall back to the frame rate (the old ladder's signal). One rung at a time,
     never more often than every 2.5 s down / 6 s up, so it cannot flicker. */
  function rsTick(fps, t) {
    /* a ring that has not been fed for 3 s is stale (stalled queries, see
       NB_PERF's watchdog): fall back to the frame rate rather than obey it */
    var P = window.NB_PERF, fresh = P && (P.lastAt === undefined || performance.now() - P.lastAt < 3000);
    var g = (P && P.ext && P.n > 30 && fresh) ? P.pct(0.75, 60) : -1;
    C.gpuMs = g;
    var slow, fast, cur = RS_LADDER[C.rsIdx], nxt = RS_LADDER[Math.min(C.rsIdx + 1, RS_LADDER.length - 1)];
    if (g >= 0) { slow = g > RS_DOWN_MS || fps < 50; fast = g * (nxt * nxt) / (cur * cur) < RS_UP_MS && fps > 57; }
    else { slow = fps < 55; fast = fps > 58.5; }
    if (slow) { C.slowRS++; C.fastRS = 0; } else if (fast) { C.fastRS++; C.slowRS = 0; } else { C.slowRS = 0; C.fastRS = 0; }
    if (t < C.rsHoldUntil) return;
    if (C.slowRS >= 2 && C.rsIdx > 0) {
      C.rsIdx--; C.slowRS = 0; C.rsHoldUntil = t + 2.5; rsApply(RS_LADDER[C.rsIdx]);
      console.info('cinema: render scale -> ' + RS_LADDER[C.rsIdx] + ' (gpu p75 ' + g.toFixed(1) + ' ms, ' + fps.toFixed(0) + ' fps)');
    } else if (C.fastRS >= 6 && C.rsIdx < RS_LADDER.length - 1) {
      C.rsIdx++; C.fastRS = 0; C.rsHoldUntil = t + 6; rsApply(RS_LADDER[C.rsIdx]);
      console.info('cinema: render scale -> ' + RS_LADDER[C.rsIdx]);
    }
  }

  /* ======================= the tick ======================= */

  function tick(t, dt) {
    C.t = t;
    installPass();
    mountDom();
    if (!C.u) return;

    /* bloom lives here now: netscene sets it once at init, and these values are
       measured against the graded output rather than the raw render */
    /* the heartbeat rides on top of whatever the mode wants: index.html used
       to write bloom.strength itself, which this overwrite silently undid */
    C.beatV = Math.max(0, C.beatV - dt * 0.9);
    if (window.bloom) {
      /* scene density (2026-10-04): netscene_universe.js publishes
         NETSCENE.bloomK (0.55..1, eased) - a stop framing ~90 additive bodies
         piles light into one white blob at the base strength, so dense stops
         get less bloom and a higher threshold. 1 when absent. */
      var bk = (window.NETSCENE && NETSCENE.bloomK > 0) ? NETSCENE.bloomK : 1;
      /* the beat breathes the bloom, it does not flash it: a smooth bump (no
         step on the attack) at a third of the old depth (was 0.45 / 0.75) */
      var bv = C.beatV * C.beatV * (3 - 2 * C.beatV);
      window.bloom.strength = (BLOOM.strength * bk + bv * (C.beatSev >= 3 ? 0.24 : 0.14) * bk) / (window.NB_BLOOM_PRE || 1);
      window.bloom.radius = BLOOM.radius;
      window.bloom.threshold = BLOOM.threshold + (1 - bk) * 0.35;
    }

    /* the cinematic moves run AFTER the tour has posed the camera for this
       frame (netSceneTick ran first) and BEFORE the bank, so the roll they ask
       for is applied through the same cam.up path as the banking */
    try { moveTick(t, dt); } catch (e) { endMove(true); }
    bankTick(dt);

    C.u.uTime.value = t;
    C.u.uGlitch.value = C.glitchV || 0;
    C.u.uSpeed.value = C.on && !C.degraded
      ? clamp(C.speed * BLUR_GAIN, 0, BLUR_MAX) : 0;

    renderCaption();

    /* perf guard: three seconds under 24 fps and the grade steps aside. The
       wall runs 24/7 on a 1080 Ti, but the WebGL fallback is SwiftShader and a
       four-tap fullscreen pass is exactly what would sink it. */
    C.fpsAcc += dt; C.fpsN++;
    if (C.fpsAcc >= 1) {
      var fps = C.fpsN / C.fpsAcc;
      C.fpsAcc = 0; C.fpsN = 0;

      /* Hysteresis, and nothing before the warm-up: the first seconds after a
         load are always sub-24 fps while the scene builds its textures, and a
         one-way latch meant a single stall killed the grade until someone
         reloaded the kiosk. Slow for 5 s drops it; fast for 5 s brings it back. */
      /* Resolution is the first thing to give, well before any effect is
         switched off: a slightly softer frame beats a stuttering one, and a
         stuttering one beats losing the grade entirely. */
      if (!C.force && !RS_PIN && t > WARMUP) rsTick(fps, t);

      if (!C.force && t > WARMUP) {
        if (fps < 24) { C.slowFor++; C.fastFor = 0; }
        else if (fps > 45) { C.fastFor++; C.slowFor = 0; }
        else { C.slowFor = 0; C.fastFor = 0; }

        if (C.slowFor >= 5 && !C.degraded) {
          C.degraded = true; C.on = false; applyMode();
          console.warn('cinema: sustained <24 fps, grade disabled');
        } else if (C.fastFor >= 5 && C.degraded) {
          C.degraded = false; C.on = true; applyMode();
          console.info('cinema: frame rate recovered, grade re-enabled');
        }
      }
      /* neither the grade nor the camera roll shows up in a still frame, so
         publish them where a headless --dump-dom check can read them */
      document.body.dataset.cinema =
        'grade=' + (C.on ? 'on' : 'off') +
        ' pass=' + (C.pass ? 'installed' : 'missing') +
        ' fps=' + fps.toFixed(0) +
        ' ss=' + C.ss.toFixed(2) + ' gpu=' + (C.gpuMs < 0 ? 'na' : C.gpuMs.toFixed(2)) +
        ' roll=' + C.roll.toFixed(4) +
        ' blur=' + C.u.uSpeed.value.toFixed(4) +
        ' mode=' + (C.cinema ? 'cinema' : 'wall') +
        ' cinematics=' + (cinematicsOn() ? 'on' : 'off') +
        ' laps=' + MV.laps +
        ' move=' + (MV.on ? MV.name + ':' + MV.u.toFixed(2) : 'none') +
        (C.force ? ' forced' : '') + (C.degraded ? ' degraded' : '');
    }
  }

  /* ---- public handles, for tuning from the console ---- */
  C.glitchV = 0;
  C.beatV = 0; C.beatSev = 0;
  /* one pulse per /api/pulse/stream beat; sev>=3 hits harder */
  C.beat = function (sev) { C.beatV = 1; C.beatSev = +sev || 0; };
  /* doom.js drives this 0..1 through the takeover transitions. Kept off
     applyMode()'s books so it still fires when the grade is bypassed. */
  C.glitch = function (v) { C.glitchV = clamp(+v || 0, 0, 1); };
  /* cinematic moves: play one now (QA / console), or the next in rotation */
  C.play = function (name) { return name ? startMove(name) : playNext(); };
  C.stopMove = function () { if (MV.on) endMove(false); };
  C.move = MV;
  window.CINEMA = C;
  window.cinemaSet = function (o) {
    Object.keys(o || {}).forEach(function (k) {
      if (k in GRADE) GRADE[k] = o[k];
      if (k in BLOOM) BLOOM[k] = o[k];
    });
    applyMode();
  };

  document.addEventListener('keydown', keys);

  /* zero-touch: wrap the tick chain the same way galaxy.js does, so load order
     is the only contract and no other file needs to know we exist */
  (function wrap() {
    var prev = window.netSceneTick;
    if (typeof prev !== 'function') { setTimeout(wrap, 300); return; }
    var last = -1;
    window.netSceneTick = function (t, dt) {
      try { prev(t, dt); }
      finally {
        var d = last < 0 ? 0.016 : Math.min(0.5, Math.max(0.001, t - last));
        last = t;
        try { tick(t, d); } catch (e) { /* never take the scene down */ }
      }
    };
    applyMode();
  })();
})();
