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

   All DOM and CSS is injected from here, so index.html needs exactly one
   <script> line and no template edits (index.html is Jinja — braces are
   hazardous there, and none of this needs to live in it).

   TOGGLES (kiosk keyboard, ignored while typing in the chat box)
     c   cinema mode  — letterbox + heavier grade, for recording
     h   HUD          — hide the rails/panels for a clean plate
     g   grade        — bypass the whole pass (A/B check)

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
    grain:  0.018,    // film grain amplitude
    sat:    1.16,     // saturation
    con:    1.055,    // contrast about mid grey
    lift:   0.55,     // cool-shadow / warm-highlight split tone
    bar:    0.0       // letterbox fraction per edge
  };
  var CINEMA = {       // deltas applied on top in cinema mode
    ca: 0.0030, vig: 0.55, grain: 0.030, sat: 1.24, con: 1.09, lift: 0.85,
    bar: 0.055
  };
  var BLOOM = { strength: 0.68, radius: 0.58, threshold: 0.70 };

  var BANK_MAX   = 0.075;   // rad of roll at full lateral speed (~4.3 deg)
  var BANK_GAIN  = 0.00042; // rad per world-unit/s of lateral camera velocity
  var BANK_EASE  = 1.9;     // roll smoothing (higher = snappier)
  var BLUR_GAIN  = 2.4e-5;  // radial blur per normalised unit/s of dolly speed
  var BLUR_MAX   = 0.0045;  // ~18 px of smear at the corners at 1920 wide

  /* ?grade=force pins the grade on and disables the perf guard (the headless
     QA browser has no GPU and would always trip it); ?grade=off starts bypassed */
  var Q = (location.search.match(/[?&]grade=(\w+)/) || [])[1] || '';

  /* SUPERSAMPLING.
     The scene renders through an EffectComposer, which means the renderer's
     antialias:true flag does nothing at all - the composer's render targets
     have no MSAA, so every line, edge and text sprite was being resolved with
     zero antialiasing. Measured on the weakest GPU in the house (Intel Iris Xe)
     the whole scene holds a locked 59.9 fps at pixelRatio 2.0, i.e. 3840x2160
     downsampled to the kiosk's 1080p panel, with p95 frame time unchanged at
     16.7 ms. So we spend that headroom on resolution: supersampling cleans up
     shading and textures, not just geometry edges the way MSAA would.
     The ladder steps down on its own if a machine cannot hold the frame rate. */
  var SS_LADDER = [1.0, 1.25, 1.5, 1.75, 2.0];
  var SS_TARGET = 2.0;
  var SS_PIXCAP = 9.0e6;      // internal framebuffer ceiling, ~4K worth

  var C = {
    on: Q !== 'off', cinema: false, hud: true, force: Q === 'force',
    ss: 0, ssIdx: SS_LADDER.length - 1, slowSS: 0, fastSS: 0,
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
      uGlitch:  { value: 0 }
    },
    vertexShader: [
      'varying vec2 vUv;',
      'void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }'
    ].join('\n'),
    fragmentShader: [
      'varying vec2 vUv;',
      'uniform sampler2D tDiffuse;',
      'uniform vec2  uRes;',
      'uniform float uTime, uCA, uVig, uGrain, uSat, uCon, uLift, uSpeed, uBar, uGlitch;',

      /* radial split: red pushed out, blue pulled in. Strength rises with r^2 so
         the centre — where the graph lives — stays perfectly registered. */
      'vec3 tap(vec2 uv, float ca){',
      '  vec2 d = uv - 0.5;',
      '  return vec3(texture2D(tDiffuse, uv + d*ca).r,',
      '              texture2D(tDiffuse, uv).g,',
      '              texture2D(tDiffuse, uv - d*ca).b);',
      '}',

      'float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }',

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
      '  if (uSpeed > 0.0005) {',
      '    col = vec3(0.0); float w = 0.0;',
      '    for (int i = 0; i < 4; i++) {',
      '      float f = 1.0 - float(i) * uSpeed;',
      '      float wi = 1.0 - float(i) * 0.18;',
      '      col += tap(0.5 + d * f, ca) * wi; w += wi;',
      '    }',
      '    col /= w;',
      '  } else {',
      '    col = tap(uv, ca);',
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
    ssApply(SS_LADDER[C.ssIdx]);
    window.addEventListener('resize', function () {
      setTimeout(function () { var r = C.ss; C.ss = 0; ssApply(r); }, 60);
    });
  }
  function sizePass() {
    if (!C.u) return;
    C.u.uRes.value.set(window.innerWidth * (C.ss || 1), window.innerHeight * (C.ss || 1));
  }

  /* Apply a supersample factor, clamped so a HiDPI panel cannot multiply itself
     into an 8K framebuffer. Everything downstream of the renderer has to be
     resized together or the composer and bloom keep stale buffer sizes. */
  function ssApply(r) {
    if (!window.rndr || !window.composer) return;
    var w = window.innerWidth, h = window.innerHeight;
    var cap = Math.sqrt(SS_PIXCAP / Math.max(1, w * h));
    r = Math.max(1, Math.min(r, SS_TARGET, cap));
    if (Math.abs(r - C.ss) < 0.01) return;
    C.ss = r;
    window.rndr.setPixelRatio(r);
    window.rndr.setSize(w, h);
    window.composer.setSize(w, h);
    if (window.bloom) window.bloom.setSize(w, h);
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
    var target = manual ? 0 : clamp(-lateral * BANK_GAIN, -BANK_MAX, BANK_MAX);

    C.roll = lerp(C.roll, target, 1 - Math.exp(-dt * BANK_EASE));
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
    '#cin{position:fixed;z-index:6;bottom:calc(212px + var(--sy));',
    '  left:calc(var(--cL) + var(--sx));right:calc(var(--cR) + var(--sx));',
    '  pointer-events:none;opacity:0;transition:opacity .45s ease;',
    '  display:flex;flex-direction:column;align-items:center;gap:5px}',
    '#cin.on{opacity:1}',
    '#cin .cbar{display:flex;gap:3px;width:min(420px,60%)}',
    '#cin .cbar i{flex:1;height:2px;border-radius:1px;background:rgba(125,160,200,.20);',
    '  transition:background .35s ease,box-shadow .35s ease}',
    '#cin .cbar i.done{background:rgba(125,160,200,.42)}',
    '#cin .cbar i.now{background:var(--accent);box-shadow:0 0 6px rgba(90,215,255,.85)}',
    '#cin .cwrap{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;',
    '  justify-content:center;max-width:100%}',
    '#cin .ceyebrow{font-size:8px;letter-spacing:2.2px;color:var(--ink3);',
    '  text-transform:uppercase;white-space:nowrap}',
    '#cin .cname{font-size:15px;font-weight:700;letter-spacing:.6px;color:var(--ink1);',
    '  text-shadow:0 0 14px rgba(90,215,255,.30);overflow-wrap:anywhere;text-align:center}',
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
    '  pointer-events:none}',
    '@media (max-width:1599px){ #cin .cname{font-size:13px} }'
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
    el.innerHTML =
      '<div class="cwrap"><span class="ceyebrow" id="cin-eye"></span>' +
      '<span class="cname" id="cin-name"></span></div>' +
      '<div class="csub" id="cin-sub"></div>' +
      '<div class="cstats" id="cin-stats"></div>' +
      '<div class="cbar" id="cin-bar"></div>';
    document.body.appendChild(el);

    var bars = document.createElement('div');
    bars.id = 'cinbars';
    bars.innerHTML = '<b class="t"></b><b class="b"></b>';
    document.body.appendChild(bars);

    C.el = el;
    place();
    window.addEventListener('resize', function () { setTimeout(place, 60); });
    setInterval(place, 4000);        // #data reflows when alerts appear/clear
    C.eye = document.getElementById('cin-eye');
    C.name = document.getElementById('cin-name');
    C.sub = document.getElementById('cin-sub');
    C.stats = document.getElementById('cin-stats');
    C.bar = document.getElementById('cin-bar');
  }

  /* what a stop IS, in plain words, keyed off the stop key netscene assigns */
  function describe(st, nodes) {
    var k = st.key || '';
    if (k.indexOf('over') === 0)
      return 'the whole estate · wan → gateway → fabric → hosts → guests';
    if (k === 'wan')    return 'internet edge · isp handoff into the gateway';
    if (k === 'fabric') return 'switching fabric · every trunk between gateway, switches and hosts';
    if (k.indexOf('wired:') === 0)  return 'wired clients · one block per switch, sorted by port';
    if (k.indexOf('ap:') === 0)     return 'wireless clients associated to this access point';
    if (k.indexOf('host:') === 0)   return 'proxmox host and every vm / container on it';
    if (k.indexOf('blk:') === 0) {
      var segs = k.split(':'), cat = segs[segs.length - 1] || '';   // blk:<node id>:<cat>
      return 'proxmox guests · ' + cat + ' workloads on this host';
    }
    return nodes.length + ' nodes';
  }

  function fmtRate(bytesPerSec) {
    var b = Math.max(0, (+bytesPerSec || 0)) * 8;
    if (b < 1e3) return b.toFixed(0) + ' b/s';
    if (b < 1e6) return (b / 1e3).toFixed(0) + ' kb/s';
    if (b < 1e9) return (b / 1e6).toFixed(1) + ' Mb/s';
    return (b / 1e9).toFixed(2) + ' Gb/s';
  }

  /* live numbers for whatever is on screen right now. For the overview that is
     the whole graph; for a focused stop it is only that stop's nodes — so the
     caption always describes exactly what the viewer can see. */
  function statsFor(st, NS) {
    var list = st.list || NS.nodes || [];
    var rx = 0, tx = 0, down = 0, up = 0, n = 0, lossy = 0, fresh = 0;
    var rtts = [];
    for (var i = 0; i < list.length; i++) {
      var nd = list[i]; if (!nd) continue;
      n++;
      if (nd.measured) { rx += (+nd.rx || 0); tx += (+nd.tx || 0); }
      if (nd.status === 'down') down++; else if (nd.status === 'up') up++;
      var m = nd.meta || {};
      if (m.rtt != null) rtts.push(m.rtt);
      if (m.loss) lossy++;
      if (m.new || m.discovered) fresh++;
    }
    // median, not mean: one sleepy wifi client at 100 ms should not make the
    // whole stop look slow
    var med = null;
    if (rtts.length) {
      rtts.sort(function (a, b) { return a - b; });
      med = rtts[(rtts.length - 1) >> 1];
    }
    return { n: n, rx: rx, tx: tx, down: down, up: up,
             rtt: med, lossy: lossy, fresh: fresh };
  }

  function renderCaption() {
    var NS = window.NETSCENE;
    if (!C.el || !NS || !NS.tour || !NS.tour.stops || !NS.tour.stops.length) return;
    var TR = NS.tour;

    if (TR.manual) {
      if (C.lastKey !== '~manual') {
        C.lastKey = '~manual';
        C.eye.textContent = 'manual';
        C.name.textContent = 'YOU HAVE THE CAMERA';
        C.sub.textContent = 'drag to orbit · scroll to zoom · hover any node for its live card';
        C.stats.innerHTML = '';
        C.bar.innerHTML = '';
      }
      C.el.classList.add('on');
      return;
    }

    /* mid-flight the frame belongs to whichever stop is materialised — netscene
       hands that over at the halfway mark, so the caption changes with it and
       never names something that is no longer on screen */
    var showIdx = (TR.phase === 'travel' && TR.switched) ? TR.next : TR.idx;
    var st = TR.stops[showIdx];
    if (!st) return;

    var key = st.key + '|' + showIdx + '|' + TR.stops.length;
    if (key !== C.lastKey) {
      C.lastKey = key;
      var nodes = st.list || NS.nodes || [];
      C.eye.textContent = (TR.phase === 'travel' ? 'approaching' : 'now showing');
      C.name.textContent = st.name;
      C.sub.textContent = describe(st, nodes);

      var bar = '';
      for (var i = 0; i < TR.stops.length; i++)
        bar += '<i class="' + (i === showIdx ? 'now' : (i < showIdx ? 'done' : '')) + '"></i>';
      C.bar.innerHTML = bar;
      C.lastStats = '';
    } else if (C.eye.textContent === 'approaching' && TR.phase === 'hold') {
      C.eye.textContent = 'now showing';
    }

    /* stats refresh on their own cadence — the data behind them moves every 5 s */
    var s = statsFor(st, NS);
    var sig = s.n + '/' + s.down + '/' + Math.round(s.rx) + '/' + Math.round(s.tx)
            + '/' + s.rtt + '/' + s.lossy + '/' + s.fresh;
    if (sig !== C.lastStats) {
      C.lastStats = sig;
      var h = '<div>nodes<b>' + s.n + '</b></div>';
      if (s.rx || s.tx) {
        h += '<div>down<b class="rx">' + fmtRate(s.rx) + '</b></div>';
        h += '<div>up<b class="tx">' + fmtRate(s.tx) + '</b></div>';
      }
      if (s.rtt != null) {
        var rc = s.rtt > 60 ? ' bad' : s.rtt > 15 ? ' warn' : '';
        h += '<div>latency<b class="' + rc.trim() + '">' + s.rtt.toFixed(1) + ' ms</b></div>';
      }
      if (s.lossy) h += '<div>packet loss<b class="bad">' + s.lossy + ' host' + (s.lossy > 1 ? 's' : '') + '</b></div>';
      if (s.fresh) h += '<div>new<b class="fresh">' + s.fresh + '</b></div>';
      h += s.down
        ? '<div>state<b class="bad">' + s.down + ' down</b></div>'
        : '<div>state<b>all up</b></div>';
      C.stats.innerHTML = h;
    }
    C.el.classList.add('on');
  }

  /* ======================= modes & keys ======================= */

  function applyMode() {
    if (!C.u) return;
    var G = C.cinema ? CINEMA : GRADE;
    C.u.uCA.value    = C.on ? G.ca    : 0;
    C.u.uVig.value   = C.on ? G.vig   : 0;
    C.u.uGrain.value = C.on ? G.grain : 0;
    C.u.uSat.value   = C.on ? G.sat   : 1;
    C.u.uCon.value   = C.on ? G.con   : 1;
    C.u.uLift.value  = C.on ? G.lift  : 0;
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
    else return;
    e.preventDefault();
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
      window.bloom.strength = BLOOM.strength + C.beatV * (C.beatSev >= 3 ? 0.75 : 0.45);
      window.bloom.radius = BLOOM.radius;
      window.bloom.threshold = BLOOM.threshold;
    }

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
      if (!C.force && t > WARMUP) {
        if (fps < 55) { C.slowSS++; C.fastSS = 0; } else { C.fastSS++; C.slowSS = 0; }
        if (C.slowSS >= 3 && C.ssIdx > 0) {
          C.ssIdx--; C.slowSS = 0; ssApply(SS_LADDER[C.ssIdx]);
          console.info('cinema: supersample -> ' + SS_LADDER[C.ssIdx]);
        } else if (C.fastSS >= 12 && C.ssIdx < SS_LADDER.length - 1) {
          C.ssIdx++; C.fastSS = 0; ssApply(SS_LADDER[C.ssIdx]);
          console.info('cinema: supersample -> ' + SS_LADDER[C.ssIdx]);
        }
      }

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
        ' ss=' + C.ss.toFixed(2) +
        ' roll=' + C.roll.toFixed(4) +
        ' blur=' + C.u.uSpeed.value.toFixed(4) +
        ' mode=' + (C.cinema ? 'cinema' : 'wall') +
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
