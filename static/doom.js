/* doom.js — DOOM takes over the wall, then leaks back out of it.
   ---------------------------------------------------------------------------
   Loads LAST, after cinema.js. Self-contained: injects its own CSS and DOM,
   boots js-dos on demand, and drives cinema.js's glitch uniform through the
   two transitions. Nothing else in the dashboard knows it exists.

   ASSETS ARE NOT IN THIS REPO. js-dos and the DOOM shareware bundle are ~14 MB
   and not ours to redistribute, so `static/doom/` is gitignored and this module
   HEAD-checks `/static/doom/js-dos.js` exactly once at start. Missing (or
   CONFIG.features.doom off) -> one console line and every trigger below stays
   unregistered: no SSE, no poll, no key handler, zero cost.
   Run `tools/fetch-doom.sh` to populate it.

   TRIGGERS  (all of them ARM a countdown rather than firing immediately -
              `delay` seconds, default 10, so there is time to get a camera up)
     type IDDQD    anywhere on the dashboard (not while typing in the chat box)
     remote        anything POSTs {"mode":"doom"} to /api/takeover (a chat bot,
                   a button, curl); pushed to every open dashboard over SSE,
                   with a 1.5 s poll as a fallback
     ?doom=1       on the URL, for a demo or a headless QA run
   EXITS  (any one of them, whichever lands first)
     ctrl+alt+X    the panic key
     15 s idle     ONLY after you have actually played - see below
     secs cap      hard ceiling from the trigger (default 120 s, max 900)
     remote        POST /api/takeover {"mode":"off"}

   Reads:   window.CONFIG.features.doom
            HEAD /static/doom/js-dos.js   (once, the asset gate)
            /api/takeover (+/stream)      the takeover state

   THE ESCAPE
     enter: tear -> leak -> swallow.  The 3D scene bands and tears, slabs of
     game pixels smear across the HUD panels, the panels themselves corrupt,
     and DOOM grows out of a small window until it has eaten the screen.
     exit:  unswallow -> unleak -> untear.  The exact mirror: the screen coughs
     DOOM back down into the small window while the HUD fades back in corrupted,
     holds at full bleed, then the glitch drains away and the dashboard is clean.
     Same three beats, same durations, reversed - so it reads as DOOM being
     forced back in, not as the page navigating away.

   The bleed slabs are sampled from the live DOOM canvas when that canvas can
   be read back, and fall back to procedural slabs in the DOOM palette when it
   cannot (a WebGL backing store without preserveDrawingBuffer reads blank from
   outside its own frame). Both paths are exercised; neither is a stub.

   SAFETY: this drives a 24/7 wall display. Every path out of 'play' is
   time-bounded, the caps are clamped server-side as well as here, and any
   failure to boot the emulator aborts straight back to the dashboard.
   --------------------------------------------------------------------------- */
(function () {
  'use strict';

  var CHEAT = 'IDDQD';
  var POLL_MS = 1500;
  var BOOT_TIMEOUT = 25000;      // js-dos wedged -> give up, never hang the wall

  /* The exit is an exact mirror of the entry, same phases in reverse and the
     same durations, so DOOM leaves the way it arrived instead of just fading
     out. The bleed and the glitch peak in the middle of BOTH transitions. */
  var PH = {
    tear: 0.85, leak: 0.60, swallow: 0.75,      // enter: glitch -> leak -> eat
    unswallow: 0.75, unleak: 0.60, untear: 0.85 // exit:  spit  -> leak -> settle
  };

  var D = {
    phase: 'off', t0: 0, typed: '',
    lastId: -1, secs: 120, idle: 15, delay: 10, lastInput: 0, startedAt: 0,
    booted: false, booting: false, bootFail: false,
    root: null, wrap: null, canvas: null, bleed: null, bctx: null,
    cap: null, cctx: null, capOk: null, raf: 0
  };

  function now() { return Date.now() / 1000; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function glitch(v) { if (window.CINEMA && window.CINEMA.glitch) window.CINEMA.glitch(v); }

  /* ======================= dom ======================= */

  var CSS = [
    '#doomroot{position:fixed;inset:0;z-index:24;display:none;pointer-events:none}',
    '#doomroot.live{display:block}',
    '#doomroot.play{pointer-events:auto}',
    '#doomwrap{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%) scale(.26);',
    '  transform-origin:50% 50%;opacity:0;width:100vw;height:100vh;',
    '  transition:transform .75s cubic-bezier(.2,.8,.25,1),opacity .35s ease;',
    '  box-shadow:0 0 0 2px rgba(255,60,40,.55),0 0 90px rgba(255,70,30,.35)}',
    '#doomroot.shown #doomwrap{opacity:1}',
    '#doomroot.full  #doomwrap{transform:translate(-50%,-50%) scale(1);box-shadow:none}',
    '#doomwrap canvas{width:100%!important;height:100%!important;display:block;',
    '  image-rendering:pixelated;background:#000}',
    /* the slab layer sits above the HUD - that is the whole point */
    '#doombleed{position:fixed;inset:0;z-index:26;pointer-events:none;display:none}',
    '#doombleed.live{display:block}',
    '#doomhint{position:fixed;z-index:27;left:50%;bottom:22px;transform:translateX(-50%);',
    '  font:600 11px/1.4 ui-monospace,monospace;letter-spacing:2px;color:#ff6a3d;',
    '  text-shadow:0 0 12px rgba(255,60,20,.8);opacity:0;transition:opacity .4s;',
    '  pointer-events:none;text-transform:uppercase}',
    '#doomhint.live{opacity:.85}',

    /* the armed countdown. Big enough to read from across the room, dim enough
       not to fight the dashboard, and it removes itself before the glitch so it
       is never in the shot it exists to let you set up. */
    '#doomarm{position:fixed;z-index:27;left:50%;top:31%;transform:translate(-50%,-50%);',
    '  text-align:center;pointer-events:none;opacity:0;transition:opacity .35s;',
    '  font-family:ui-monospace,monospace}',
    '#doomarm.live{opacity:1}',
    '#doomarm .n{font-size:92px;font-weight:700;color:#ff6a3d;line-height:1;',
    '  text-shadow:0 0 40px rgba(255,60,20,.75);font-variant-numeric:tabular-nums}',
    '#doomarm .t{margin-top:6px;font-size:11px;letter-spacing:5px;color:#ff9a72;',
    '  text-transform:uppercase}',

    /* HUD corruption. Short and deliberate - this is the only place in the
       dashboard allowed to strobe, and it lasts under two seconds. */
    '@keyframes dglitch{',
    '  0%{transform:translate(0,0) skewX(0deg);filter:none}',
    '  18%{transform:translate(-15px,2px) skewX(-3deg);filter:hue-rotate(-50deg) saturate(2.5)}',
    '  36%{transform:translate(10px,-3px) skewX(2deg);filter:hue-rotate(70deg) contrast(1.6)}',
    '  54%{transform:translate(-6px,1px) skewX(0deg);filter:invert(1) hue-rotate(20deg)}',
    '  72%{transform:translate(13px,2px) skewX(-2deg);filter:saturate(3) hue-rotate(-30deg)}',
    '  100%{transform:translate(0,0) skewX(0deg);filter:none}}',
    'body.doom-glitch .panel{animation:dglitch .38s steps(3,end) infinite}',
    'body.doom-glitch #railL{animation:dglitch .53s steps(2,end) infinite}',
    'body.doom-glitch #railR{animation:dglitch .61s steps(2,end) infinite reverse}',
    'body.doom-glitch #stat{animation:dglitch .29s steps(4,end) infinite}',
    'body.doom-glitch #cin{animation:dglitch .44s steps(3,end) infinite reverse}',
    'body.doom-hide #railL,body.doom-hide #railR,body.doom-hide #stat,',
    'body.doom-hide #data,body.doom-hide #chat,body.doom-hide #cin{',
    '  opacity:0;transition:opacity .3s ease}'
  ].join('\n');

  function mount() {
    if (D.root) return;
    var st = document.createElement('style');
    st.id = 'doom-css'; st.textContent = CSS;
    document.head.appendChild(st);

    D.root = document.createElement('div');
    D.root.id = 'doomroot';
    D.wrap = document.createElement('div');
    D.wrap.id = 'doomwrap';
    D.canvas = document.createElement('canvas');
    D.canvas.id = 'doomcanvas';
    D.canvas.width = 640; D.canvas.height = 400;
    D.wrap.appendChild(D.canvas);
    D.root.appendChild(D.wrap);
    document.body.appendChild(D.root);

    D.bleed = document.createElement('canvas');
    D.bleed.id = 'doombleed';
    document.body.appendChild(D.bleed);
    D.bctx = D.bleed.getContext('2d');
    sizeBleed();
    window.addEventListener('resize', sizeBleed);

    D.hint = document.createElement('div');
    D.hint.id = 'doomhint';
    document.body.appendChild(D.hint);

    D.arm = document.createElement('div');
    D.arm.id = 'doomarm';
    D.arm.innerHTML = '<div class="n" id="doomarm-n">10</div>'
                    + '<div class="t">incoming</div>';
    document.body.appendChild(D.arm);

    D.cap = document.createElement('canvas');
    D.cap.width = 320; D.cap.height = 200;
    D.cctx = D.cap.getContext('2d', { willReadFrequently: true });
  }
  function sizeBleed() {
    if (!D.bleed) return;
    D.bleed.width = Math.round(window.innerWidth / 2);    // half res: it is all
    D.bleed.height = Math.round(window.innerHeight / 2);  // smeared anyway
  }

  /* ======================= the bleed ======================= */

  var PAL = ['#8a1a10', '#c33a1a', '#e07020', '#5a2a12', '#a0a0a0',
             '#3a2018', '#d8b040', '#701008'];

  /* try to read the emulator's framebuffer; a WebGL canvas without a preserved
     drawing buffer comes back fully transparent, and we only find out by
     looking. Re-checked while the game runs, because the answer changes once
     dosbox has actually painted a frame. */
  function capture() {
    if (!D.canvas || !D.cctx) return false;
    try {
      D.cctx.drawImage(D.canvas, 0, 0, D.cap.width, D.cap.height);
    } catch (e) { D.capOk = false; return false; }
    if (D.capOk !== true && now() - (D._probed || 0) > 0.4) {
      D._probed = now();
      try {
        var px = D.cctx.getImageData(0, 0, D.cap.width, D.cap.height).data;
        var lit = 0;
        for (var i = 3; i < px.length; i += 4 * 97) if (px[i] > 8) { lit++; if (lit > 3) break; }
        D.capOk = lit > 3;
      } catch (e) { D.capOk = false; }
    }
    return D.capOk === true;
  }

  function bleedFrame(k) {
    var cv = D.bleed, x = D.bctx;
    if (!x) return;
    x.clearRect(0, 0, cv.width, cv.height);
    if (k <= 0.01) { D.bleed.classList.remove('live'); return; }
    D.bleed.classList.add('live');

    var live = capture();
    var n = Math.round(2 + k * 15);
    for (var i = 0; i < n; i++) {
      var dy = Math.random() * cv.height;
      var dh = (2 + Math.random() * 22) * (0.5 + k);
      var dx = (Math.random() - 0.5) * cv.width * 0.55;
      x.globalAlpha = (0.30 + Math.random() * 0.55) * k;
      if (live) {
        var sy = Math.random() * (D.cap.height - 6);
        var sh = 3 + Math.random() * 24;
        x.drawImage(D.cap, 0, sy, D.cap.width, Math.min(sh, D.cap.height - sy),
                    dx, dy, cv.width * 1.35, dh);
      } else {
        /* procedural fallback in the DOOM palette: banded slabs with a bright
           torn edge. Reads as the same artefact when the readback is blocked. */
        x.fillStyle = PAL[(Math.random() * PAL.length) | 0];
        x.fillRect(dx, dy, cv.width * 1.35, dh);
        x.globalAlpha *= 0.8;
        x.fillStyle = '#ffcf7a';
        x.fillRect(dx, dy, cv.width * 1.35, Math.max(1, dh * 0.12));
      }
    }
    x.globalAlpha = 1;
  }

  /* ======================= js-dos boot ======================= */

  function loadScript(src, cb, err) {
    var s = document.createElement('script');
    s.src = src; s.onload = cb; s.onerror = err;
    document.head.appendChild(s);
  }

  function boot(done) {
    if (D.booted) { done(true); return; }
    if (D.bootFail) { done(false); return; }
    if (D.booting) { D.bootWaiters.push(done); return; }
    D.booting = true; D.bootWaiters = [done];

    var settled = false;
    function finish(ok) {
      if (settled) return;
      settled = true;
      D.booting = false; D.booted = ok; D.bootFail = !ok;
      D.bootWaiters.forEach(function (f) { try { f(ok); } catch (e) {} });
      D.bootWaiters = [];
    }
    setTimeout(function () {
      if (!settled) { console.error('doom: boot timed out'); finish(false); }
    }, BOOT_TIMEOUT);

    loadScript('/static/doom/js-dos.js', function () {
      if (typeof window.Dos !== 'function') { finish(false); return; }
      try {
        window.Dos(D.canvas, {
          wdosboxUrl: '/static/doom/wdosbox.js',
          cycles: 'max',
          autolock: false
        }).ready(function (fs, main) {
          fs.extract('/static/doom/doom-sw.zip').then(function () {
            // -warp 1 1 drops straight into E1M1 and SKIPS THE MENU. That is
            // not just cosmetic: the bundled retail DOOM.EXE tries to draw the
            // Episode 4 menu graphic (M_EPI4), which does not exist in the
            // shareware WAD, so opening New Game crashes it back to DOS with
            // "W_GetNumForName: M_EPI4 not found!". Warping in avoids the menu
            // entirely and lands us in gameplay, which is what we want anyway.
            return main(['-c', 'cd DOOM', '-c', 'DOOM.EXE -warp 1 1 -skill 3']);
          }).then(function (ci) {
            D.ci = ci; finish(true);
          })['catch'](function (e) {
            // js-dos rejects with bare objects, which log as "[object Object]"
            console.error('doom: run failed:', (e && (e.message || e.reason)) || e,
                          JSON.stringify(e, Object.getOwnPropertyNames(e || {})));
            finish(false);
          });
        });
      } catch (e) { console.error('doom: Dos() threw:', e && e.message || e); finish(false); }
    }, function () { console.error('doom: js-dos.js failed to load'); finish(false); });
  }

  /* ======================= autoplay =======================
     "Make it look like someone is playing." DOOM's own attract demo would do
     that, but any keypress kicks it back to the menu - and this build's menu
     crashes (see the -warp note above). So we drive the marine ourselves:
     synthetic key events straight into the emulator, never DOM events, so they
     cannot be mistaken for a human at the keyboard.
     The instant a REAL key arrives, autoplay stops and hands over. */
  var K = { FWD: 38, BACK: 40, LEFT: 37, RIGHT: 39, FIRE: 17, USE: 32, RUN: 16 };

  function keyDown(c) {
    D.synth = true;
    try { D.ci.simulateKeyEvent(c, true); } catch (e) {}
    D.synth = false;
  }
  function keyUp(c) {
    D.synth = true;
    try { D.ci.simulateKeyEvent(c, false); } catch (e) {}
    D.synth = false;
  }

  function releaseAll() {
    Object.keys(K).forEach(function (k) { keyUp(K[k]); });
  }

  /* A short repertoire of moves, picked at random with a random duration.
     Deliberately unhurried - a marine sprinting into walls reads as a bot,
     while a bit of turning and the occasional shot reads as someone playing. */
  var MOVES = [
    { keys: [K.FWD], min: 900, max: 2200 },
    { keys: [K.FWD, K.RIGHT], min: 500, max: 1100 },
    { keys: [K.FWD, K.LEFT], min: 500, max: 1100 },
    { keys: [K.RIGHT], min: 350, max: 800 },
    { keys: [K.LEFT], min: 350, max: 800 },
    { keys: [K.FWD, K.FIRE], min: 400, max: 900 },
    { keys: [K.FIRE], min: 250, max: 550 },
    { keys: [K.USE], min: 200, max: 350 },
    { keys: [K.BACK], min: 300, max: 700 }
  ];

  function autoplayStep() {
    if (D.phase !== 'play' || D.lastInput || !D.ci) { autoplayStop(); return; }
    releaseAll();
    keyDown(K.RUN);                                   // always running: looks better
    var m = MOVES[(Math.random() * MOVES.length) | 0];
    m.keys.forEach(keyDown);
    var dur = m.min + Math.random() * (m.max - m.min);
    D.autoT = setTimeout(function () {
      m.keys.forEach(keyUp);
      if (D.phase === 'play' && !D.lastInput) D.autoT = setTimeout(autoplayStep, 60);
    }, dur);
  }

  function autoplayStart() {
    if (D.autoOn) return;
    D.autoOn = true;
    // let the level finish loading before the first input
    D.autoT = setTimeout(autoplayStep, 2500);
  }

  function autoplayStop() {
    D.autoOn = false;
    if (D.autoT) { clearTimeout(D.autoT); D.autoT = 0; }
    releaseAll();
  }

  /* ======================= phases ======================= */

  function setPhase(p) { D.phase = p; D.t0 = now(); }

  function start(secs, idle, delay) {
    if (D.phase !== 'off') return;
    mount();
    D.secs = clamp(secs || 120, 10, 900);
    D.idle = clamp(idle || 15, 5, 300);
    D.delay = clamp(delay === undefined ? 10 : delay, 0, 120);
    D.startedAt = now();
    D.lastInput = now();
    if (D.delay > 0) {
      // arm, don't fire. The emulator boots DURING the countdown, so when the
      // glitch does start it has nothing left to wait for.
      D.arm.classList.add('live');
      D.armN = -1;
      setPhase('armed');
      boot(function () {});
      if (!D.raf) D.raf = requestAnimationFrame(loop);
      return;
    }
    ignite();
  }

  function ignite() {
    D.startedAt = now();
    // 0 = nobody has touched it yet. The idle timer used to start here, which
    // meant an untouched takeover killed itself 15 s in - right while you were
    // still walking over with the camera. Now an untouched DOOM runs its attract
    // demo for the full `secs` budget, and the idle timer only starts once
    // someone has actually played.
    D.lastInput = 0;
    D.arm.classList.remove('live');
    D.root.classList.add('live');
    document.body.classList.add('doom-glitch');
    setPhase('tear');
    boot(function (ok) {
      if (!ok && D.phase !== 'off') {
        console.warn('doom: emulator unavailable, backing out');
        stopLocal();
      }
    });
    if (!D.raf) D.raf = requestAnimationFrame(loop);
  }

  var EXITING = { unswallow: 1, unleak: 1, untear: 1 };

  /* local teardown; does NOT post, so it can be called from the poll handler
     without bouncing a write back at the server */
  function stopLocal() {
    if (D.phase === 'off' || EXITING[D.phase]) return;
    if (D.phase === 'armed') { finished(); return; }   // cancelled before it fired
    autoplayStop();
    D.root.classList.remove('full', 'play');   // shrink back to the small window
    D.root.classList.add('shown');
    document.body.classList.remove('doom-hide');  // HUD fades back in...
    document.body.classList.add('doom-glitch');   // ...corrupted, as it went out
    D.hint.classList.remove('live');
    setPhase('unswallow');
  }

  function finished() {
    autoplayStop();
    D.phase = 'off';
    glitch(0);
    bleedFrame(0);
    D.root.classList.remove('live', 'shown', 'full', 'play');
    document.body.classList.remove('doom-glitch', 'doom-hide');
    D.hint.classList.remove('live');
    if (D.arm) D.arm.classList.remove('live');
    report(true);            // publish 'off' BEFORE killing the loop that publishes
    if (D.raf) { cancelAnimationFrame(D.raf); D.raf = 0; }
  }

  /* same trick cinema.js uses: the takeover is a moving target that a single
     headless screenshot keeps missing, so publish what it is doing */
  function report(force) {
    if (!force && now() - (D._rep || 0) < 0.25) return;
    D._rep = now();
    document.body.dataset.doom =
      'phase=' + D.phase +
      ' booted=' + D.booted + (D.booting ? ' booting' : '') + (D.bootFail ? ' BOOTFAIL' : '') +
      ' capture=' + (D.capOk === null ? 'unknown' : D.capOk ? 'live' : 'fallback') +
      ' idlefor=' + (D.phase === 'play' && D.lastInput
                     ? (now() - D.lastInput).toFixed(1) : 'untouched') +
      ' left=' + (D.phase === 'play'
                  ? Math.max(0, D.secs - (now() - D.startedAt)).toFixed(0) : '-') +
      (D.phase === 'armed' ? ' countdown=' + D.armN : '') +
      (D.autoOn ? ' autoplay=on' : '') +
      ' trigger=' + (D.streamUp ? 'stream' : 'poll');
  }

  function loop() {
    D.raf = requestAnimationFrame(loop);
    report();
    var e = now() - D.t0, p = D.phase;

    if (p === 'armed') {
      var left = D.delay - e;
      var n = Math.max(0, Math.ceil(left));
      if (D.armN !== n) {
        D.armN = n;
        var ael = document.getElementById('doomarm-n');
        if (ael) ael.textContent = n;
      }
      // clear the countdown just before it fires, so it is out of the frame
      if (left <= 0.5) D.arm.classList.remove('live');
      if (left <= 0) ignite();

    } else if (p === 'tear') {
      var k = clamp(e / PH.tear, 0, 1);
      glitch(0.35 + 0.65 * k);
      bleedFrame(k * 0.85);
      if (e >= PH.tear) { D.root.classList.add('shown'); setPhase('leak'); }

    } else if (p === 'leak') {
      glitch(1);
      bleedFrame(1);
      // hold here until the emulator is up; the glitch IS the loading screen
      if (e >= PH.leak && D.booted) setPhase('swallow');
      else if (D.bootFail) stopLocal();

    } else if (p === 'swallow') {
      var s = clamp(e / PH.swallow, 0, 1);
      D.root.classList.add('full');
      document.body.classList.add('doom-hide');
      glitch(1 - s);
      bleedFrame(1 - s);
      if (e >= PH.swallow) {
        document.body.classList.remove('doom-glitch');
        D.root.classList.add('play');
        D.hint.textContent = 'ctrl+alt+X to escape · runs ' + D.secs
                           + 's · once you play, ' + D.idle + 's idle returns';
        D.hint.classList.add('live');
        setTimeout(function () { D.hint.classList.remove('live'); }, 4000);
        try { D.canvas.focus(); } catch (e2) {}
        autoplayStart();
        setPhase('play');
      }

    } else if (p === 'play') {
      capture();                                   // keep the readback warm
      if (D.lastInput && D.autoOn) autoplayStop(); // a human took over
      var played = D.lastInput > 0;
      if ((played && now() - D.lastInput > D.idle) ||
          now() - D.startedAt > D.secs) stopLocal();

    } else if (p === 'unswallow') {
      // mirror of swallow: DOOM is coughed back down into the small window
      // while the HUD returns and the glitch climbs back to full
      var q = clamp(e / PH.unswallow, 0, 1);
      glitch(q);
      bleedFrame(q);
      if (e >= PH.unswallow) setPhase('unleak');

    } else if (p === 'unleak') {
      // mirror of leak: held at maximum bleed, DOOM small and still visible
      glitch(1);
      bleedFrame(1);
      if (e >= PH.unleak) { D.root.classList.remove('shown'); setPhase('untear'); }

    } else if (p === 'untear') {
      // mirror of tear: the glitch drains away and leaves a clean dashboard
      var r = clamp(e / PH.untear, 0, 1);
      glitch(1 - r);
      bleedFrame(1 - r);
      if (e >= PH.untear) finished();
    }
  }

  /* ======================= triggers ======================= */

  function post(mode) {
    try {
      fetch('/api/takeover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: mode })
      })['catch'](function () {});
    } catch (e) {}
  }

  function onKey(ev) {
    var t = ev.target;
    var typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);

    // panic key, always live
    if (ev.ctrlKey && ev.altKey && (ev.key === 'x' || ev.key === 'X')) {
      if (D.phase !== 'off') { ev.preventDefault(); post('off'); stopLocal(); }
      return;
    }

    if (D.phase !== 'off') {
      // Only a REAL person counts. The autoplay driver's keys reach the DOM as
      // untrusted events, and treating those as input made the takeover stop
      // autoplaying and then time out ~15 s in - which looked exactly like the
      // game crashing. isTrusted is the browser's own synthetic/real flag and
      // is not spoofable from script, so it is the right discriminator.
      if (ev.isTrusted === false || D.synth) return;
      D.lastInput = now();
      return;
    }
    if (typing || ev.ctrlKey || ev.metaKey || ev.altKey) return;

    var k = (ev.key || '').toUpperCase();
    if (k.length !== 1) return;
    D.typed = (D.typed + k).slice(-CHEAT.length);
    if (D.typed === CHEAT) {
      D.typed = '';
      ev.preventDefault();
      post('doom');               // so every other open dashboard follows
      start(120, 15, 10);         // ...but this one does not wait for the poll
    }
  }

  /* ======================= remote trigger ======================= */

  function pollTakeover() {
    if (D.streamUp) return;             // the stream has it covered
    fetch('/api/takeover', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(applyState)['catch'](function () {});
  }

  /* Push beats poll: the server streams the takeover state, so a remote
     trigger lands the instant it is written. The poll stays as a fallback -
     if the stream never opens or drops, the takeover still fires, just up to
     POLL_MS later. Both funnel through the same lastId check, so whichever
     sees a new id first wins and the other is a no-op. */
  function applyState(s) {
    if (!s || typeof s.id !== 'number') return;
    if (D.lastId < 0) { D.lastId = s.id; return; }   // ignore state at load
    if (s.id === D.lastId) return;
    D.lastId = s.id;
    if (s.mode === 'doom') start(s.secs, s.idle, s.delay);
    else stopLocal();
  }

  function openStream() {
    if (typeof window.EventSource !== 'function') return;
    var es;
    try { es = new EventSource('/api/takeover/stream'); }
    catch (e) { return; }
    es.onmessage = function (ev) {
      try { applyState(JSON.parse(ev.data)); } catch (e) {}
    };
    es.onerror = function () {
      // EventSource reconnects on its own; the poll covers the gap
      D.streamUp = false;
    };
    es.onopen = function () { D.streamUp = true; };
    D.es = es;
  }

  /* ======================= the asset gate =======================
     One HEAD request decides whether this module exists at all. Everything
     below only runs once /static/doom/js-dos.js is known to be there, so an
     install without the assets pays for one 404 and nothing else. */
  function armTriggers() {
    document.addEventListener('keydown', onKey, true);
    openStream();
    setInterval(pollTakeover, POLL_MS);

    /* ?doom=1 (or ?doom=<seconds>) fires the takeover on load. The poll
       deliberately ignores whatever state it finds at load time, so a stale
       trigger cannot ambush the wall on every refresh -- which also leaves no
       way to reach this from a headless QA browser. This is that way, and it
       doubles as a demo link you can just open. */
    var m = location.search.match(/[?&]doom=(\d+)/);
    if (!m) return;
    var secs = m[1] === '1' ? 120 : parseInt(m[1], 10);
    var dm = location.search.match(/[?&]delay=(\d+)/);
    var dly = dm ? parseInt(dm[1], 10) : 0;   // QA fires immediately by default
    setTimeout(function () { start(secs, 15, dly); }, 3000);   // let the scene settle
  }

  function disabled(why) {
    console.info('doom: disabled (' + why + ') — run tools/fetch-doom.sh to enable');
    window.DOOM = { state: D, available: false,
                    start: function () { console.info('doom: disabled (' + why + ')'); },
                    stop: function () {} };
  }

  (function gate() {
    var F = (window.CONFIG && window.CONFIG.features) || {};
    if (F.doom === false) { disabled('features.doom is off'); return; }
    var ok = false;
    try {
      fetch('/static/doom/js-dos.js', { method: 'HEAD', cache: 'no-store' })
        .then(function (r) { ok = r && r.ok; })
        ['catch'](function () { ok = false; })
        .then(function () {
          if (!ok) { disabled('/static/doom/js-dos.js not installed'); return; }
          armTriggers();
          window.DOOM = {
            state: D, available: true,
            start: function (secs, idle, delay) {
              post('doom'); start(secs || 120, idle || 15, delay === undefined ? 10 : delay);
            },
            stop: function () { post('off'); stopLocal(); }
          };
        });
    } catch (e) { disabled('fetch unavailable'); }
  })();
})();
