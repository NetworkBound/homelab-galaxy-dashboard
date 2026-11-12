/* lightsync.js (v10) — publish the galaxy's on-screen colour and tour state so
 * smart lights (and the nexus screen) can track the REAL dashboard, 1:1 with
 * what is on the monitor.
 *
 * v10: one beat per ARRIVAL (travel -> hold), not per stop-key change - the
 * key hands over at the travel midpoint and the index changes again on
 * landing, so every leg used to beat twice (measured 1.86 beats/stop; the
 * strip's median brightness sat at the punch level). Colour is now by TOUR
 * POSITION on a hue ring ordered for maximum separation between consecutive
 * stops, and the publisher runs from a timer as well as the frame sink, so a
 * stalled rAF chain cannot silence the feed the second screen follows.
 *
 * Runs inside the browser that is actually displaying the dashboard, so the
 * lights follow the true camera tour rather than a separate headless render.
 *
 * Why a hue histogram and not an average: the scene is ~80% blue, so the mean
 * colour is always the same blue and the lights never change. We instead track
 * each hue bucket against its own rolling baseline and publish whichever is most
 * over-represented right now, so the gold core winning 3% of pixels beats the
 * blue arms holding 80%.
 *
 * The WebGL canvas is drawn into a tiny 2D canvas from inside requestAnimationFrame,
 * while the drawing buffer is still valid - a later read would come back blank
 * unless the renderer was created with preserveDrawingBuffer.
 *
 * Reads:   window.CONFIG              palette{} (per-category light colour),
 *                                     nodes[].accent (per-host light colour),
 *                                     features.lights (chip + /api/lightcolor)
 *          NETSCENE.tour              stop key/name, phase, progress, manual
 * Writes:  POST /api/lightstate       full tour state (ALWAYS, even with
 *                                     features.lights off - the nexus screen
 *                                     follows this feed)
 *          POST /api/lightcolor       per-screen colour (only with lights on)
 *          #chip-light                the wall HUD chip (hidden with lights off)
 */
(function () {
  "use strict";

  var SAMPLE_EVERY = 30;    // pixel readback every Nth frame (2 Hz at 60): each
                            // getImageData stalls the GL pipeline, and colour
                            // only needs to move at lamp speed anyway
  // intent()/publish() are evaluated every rAF (no readback, just reading a few
  // NETSCENE.tour fields) so the >=5 Hz travel gate below lands accurately;
  // checking only every few frames would round the true cadence down to
  // whatever multiple of the check period exceeds it, undershooting 5 Hz.
  // Sync protocol v2 publish cadence: a trigger-field change (stop/phase/beat/
  // idx/to/manual/mode) goes out immediately; absent that, travel POSTs at
  // >=5 Hz (TV needs prog to look smooth) and holds POST at <=1 Hz. POST_MIN_MS
  // is a hard ceiling above both so a burst of trigger changes can't flood it.
  var POST_MIN_MS = 125;    // ~8/s ceiling, applies even to trigger changes
  var POST_TRAVEL_MS = 180; // steady-state cadence while travelling (~5.5 Hz)
  var POST_HOLD_MS = 1000;  // steady-state cadence while holding (1 Hz)
  var T_HOLD = 5.0;         // netscene.js T_HOLD / T_HOLD_OVER: not exported,
  var T_HOLD_OVER = 6.5;    // mirrored here per the sync protocol v2 contract
  var W = 128, H = 72;      // finer grid -> small bright features survive
  var BUCKET = 15;          // degrees per hue bucket
  var ALPHA = 0.008;        // slower baseline -> passing colours spike harder
  var MIN_SHARE = 0.008;
  var MIN_SPIKE = 1.35;     // lower bar -> catches more of the tour's colours


  /* The cluster/host objects in netscene.js use this palette. The nebula is ~80%
     blue and swamps them by pixel count, so the raw pick is nearly always some
     blue. Snapping the chosen hue to the nearest actual host colour makes the
     lights show colours that are really on the dashboard, and gives the variety
     the blue-dominated average could never produce. */
  function CFG() { return window.CONFIG || {}; }
  function hexRgb(h) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(h || ''));
    if (!m) return [0x8f, 0xb0, 0xd0];
    var v = parseInt(m[1], 16);
    return [v >> 16 & 255, v >> 8 & 255, v & 255];
  }
  /* The snap palette is the configured category palette plus one entry per
     configured node accent, so the lamps can only ever show a colour that is
     really on this dashboard — and a three-node estate gets three host hues. */
  function nodePalette() {
    var C = CFG(), out = [], seen = {};
    function push(h) { var k = String(h).toLowerCase(); if (k && !seen[k]) { seen[k] = 1; out.push(hexRgb(h)); } }
    (C.nodes || []).forEach(function (n) { push(n.accent); });
    Object.keys(C.palette || {}).forEach(function (k) { push(C.palette[k]); });
    if (!out.length) out = [[0x8f, 0xb0, 0xd0], [0x5a, 0xd7, 0xff], [0x37, 0xf5, 0xa0], [0xff, 0xb3, 0x47]];
    return out;
  }

  /* recomputed after /api/config lands, so the first frames are not stuck on
     the fallback palette */
  function paletteHues() {
    var pal = nodePalette(), out = [];
    for (var i = 0; i < pal.length; i++) {
      var c = pal[i];
      out.push({ h: rgbToHue(c[0], c[1], c[2])[0], rgb: c });
    }
    return out;
  }
  var PAL_H = null;
  window.addEventListener('galaxy:config', function () { PAL_H = null; });

  function snapToNode(hue) {
    if (!PAL_H) PAL_H = paletteHues();
    var best = null, bd = 1e9;
    for (var i = 0; i < PAL_H.length; i++) {
      var d = Math.abs(hue - PAL_H[i].h);
      if (d > 180) d = 360 - d;
      if (d < bd) { bd = d; best = PAL_H[i]; }
    }
    return best;
  }

  var small = document.createElement("canvas");
  small.width = W; small.height = H;
  var sctx = small.getContext("2d", { willReadFrequently: true });

  var baseline = {};
  var frame = 0;
  var lastPost = 0;
  var lastSent = null;

  function rgbToHue(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    var l = (mx + mn) / 2;
    if (d === 0) return [0, 0, l];
    var s = d / (1 - Math.abs(2 * l - 1));
    var h;
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
    return [h, s, l];
  }

  function hslToRgb(h, s, l) {
    h /= 360;
    function f(p, q, t) {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    }
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    return [Math.round(f(p, q, h + 1 / 3) * 255),
            Math.round(f(p, q, h) * 255),
            Math.round(f(p, q, h - 1 / 3) * 255)];
  }

  /* a readback may only be asked for while a PBO slot is free.
     Asking while the previous one was still fenced re-wrote the buffer before it had
     been read back - 256 "READ-usage buffer was written, then fenced, but written again
     before being read back" warnings per page. An index.html without the accessor
     (one slot, the old behaviour) is asked as before. */
  function pixelsReady() {
    var P = window.NB_PIXELS;
    if (!P || typeof P.ready !== "function") return true;
    try { return !!P.ready(); } catch (e) { return true; }
  }

  function sample() {
    var d;
    /* The wall (index.html) offers an asynchronous GPU readback: it hands back
       the previous request's W x H frame without ever stalling the pipeline.
       Pages without it (the nexus) keep the drawImage path below. */
    if (window.NB_PIXELS && typeof window.NB_PIXELS.request === "function") {
      if (!pixelsReady()) return null;        // every PBO slot still in flight: ask again next frame
      d = window.NB_PIXELS.request(W, H);
      if (!d) return null;
    } else {
      var src = document.querySelector("canvas");
      if (!src || !src.width) return null;
      try {
        sctx.drawImage(src, 0, 0, W, H);
      } catch (e) { return null; }
      try { d = sctx.getImageData(0, 0, W, H).data; } catch (e) { return null; }
    }

    var hist = {}, lit = 0;
    for (var i = 0; i < d.length; i += 4) {
      var hsl = rgbToHue(d[i], d[i + 1], d[i + 2]);
      if (hsl[2] < 0.08 || hsl[1] < 0.25) continue;
      lit++;
      var k = Math.floor(hsl[0] / BUCKET) * BUCKET;
      hist[k] = (hist[k] || 0) + 1;
    }
    if (!lit) return null;

    var shares = {}, k2;
    for (k2 in hist) shares[k2] = hist[k2] / lit;
    for (k2 in shares) {
      baseline[k2] = baseline[k2] === undefined
        ? shares[k2]
        : baseline[k2] * (1 - ALPHA) + shares[k2] * ALPHA;
    }

    var best = null, bestScore = 0, domin = null, domShare = 0;
    for (k2 in shares) {
      if (shares[k2] > domShare) { domShare = shares[k2]; domin = k2; }
      if (shares[k2] < MIN_SHARE) continue;
      var ratio = shares[k2] / Math.max(baseline[k2], 1e-4);
      var score = ratio * Math.pow(shares[k2], 0.35);
      if (ratio >= MIN_SPIKE && score > bestScore) { best = k2; bestScore = score; }
    }
    if (best === null) best = domin;
    if (best === null) return null;

    var hue = (parseFloat(best) + BUCKET / 2) % 360;
    var snapped = snapToNode(hue);        // publish a real host colour
    var rgb = hslToRgb(snapped.h, 0.95, 0.52);
    return { rgb: rgb, hue: Math.round(snapped.h), raw_hue: Math.round(hue),
             lit: lit, share: +domShare.toFixed(3) };
  }

  /* ---- what the dashboard is DOING, not just what colour it is ----------
     The hue histogram alone can only ever make the lamps drift. Timing them to
     the camera needs intent: which stop the tour is on, whether it is flying or
     parked, and whether the takeover has the screen. A light driver subscribing
     to /api/lightstate turns that into brightness moves a fast local lamp can
     actually perform (local UDP, ~20 ms) while a slower cloud bulb keeps doing
     the colour wash it is limited to. */
  var beat = 0, lastPhase = null;
  /* v9: a new intrusion (netscene_exo.js dispatches 'galaxy:threat' once per
     new /api/threats seq) puts the room in mode 'threat' for 2.5 s — the back
     end accepts it and a light driver can pulse red at 2 Hz — then the tour
     mode resumes. Nothing else about the protocol changes. */
  var THREAT_MS = 2500, threatUntil = 0;
  window.addEventListener('galaxy:threat', function () { threatUntil = Date.now() + THREAT_MS; });
  var stopsCacheRef = null, stopsCacheList = [];   // TR.stops only changes on a
                                                    // topology rebuild -- reuse
                                                    // the trimmed key/name list
                                                    // by reference instead of
                                                    // remapping it every call

  /* the palette tone the publisher falls back to when there is no tour at all */
  function catRgb(cat) {
    var P = CFG().palette || {};
    return hexRgb(P[cat] || P.infra || '#8fb0d0');
  }
  /* Colour by TOUR POSITION, not by subject category.
     Colouring by category (and by node accent for host stops) was the right
     instinct but it cannot deliver a visible change at every stop, because the
     tour visits same-family stops back to back. Measured on a 14-stop lap, only
     7 distinct hues reached the room and 4 of the 14 transitions moved the hue
     by less than 25 deg - one of them 0.0 deg (two wired blocks in a row: below
     a typical driver's send gate, so literally no write went out). Those runs
     are contiguous, so the room sat in the same cyan for ~4 dwells (~20 s).
     That is what "the lights don't change with the screens" looked like.

     Only HUE reliably survives to a fixture - most LED drivers rebuild every
     colour at full saturation and a fixed lightness - so this is a hue ring
     ordered for maximum separation between CONSECUTIVE stops: min 101 deg,
     mean 145 deg, zero invisible transitions, and it alternates cool -> warm
     -> cool so every move reads on camera. The ring is indexed by stop
     position, so it works for any number of nodes and any stop list.

     Three bands are deliberately avoided, all of which render badly on an LED
     strip at full saturation: 60-88 (chartreuse, reads as dirty yellow),
     95-138 (acid green, reads as a fault light), 222-258 (deep blue, the blue
     die dominates and the output looks dim and muddy on video). */
  var TOUR_HUES = [158, 297, 143, 312, 173, 342, 188, 8, 267, 38, 282, 23, 204, 327];

  /* v13: the ring follows the SHOT on screen, so the room takes
     the colour of the frame: warm for a host's core, cyan for the stream ride,
     white-blue for the internet edge, violet for the wide shots; the planet stops
     (aspects, guest categories) keep the old alternating cool/warm ring. Still hue
     only, still outside the three bad bands above, and consecutive stops still move
     the hue by >= MIN_SEP deg: inside a run of one family the stops step through the
     family's own hues (edge: 214 <-> 188), and a stop next to a single-hue family
     (the stream) picks the hue that keeps its distance from it.
     `shot` is also published (lightstate v13) so the TV flies the same kind of shot. */
  var SHOTS = { wide: 1, core: 1, planet: 1, stream: 1, edge: 1 };
  var FAM_HUES = {
    wide:   [268, 290],
    edge:   [214, 188],
    core:   [30, 6, 46],
    planet: [158, 312, 143, 338, 172, 297],
    stream: [182]
  };
  var MIN_SEP = 25;
  function shotOf(st) {
    if (!st) return '';
    if (typeof st.shot === 'string' && SHOTS[st.shot]) return st.shot;      // the scene may name its own shot
    var k = String(st.key || '');
    if (k.indexOf('over:') === 0) return 'wide';
    if (k.indexOf('stream:') === 0) return 'stream';
    if (k === 'wan' || k === 'asp:internet' || k === 'asp:security' || st.edge) return 'edge';
    if (k.indexOf('asp:') === 0 || k.indexOf('blk:') === 0) return 'planet';
    return 'core';                                                          // host: / fabric / wired: / ap: / sys:
  }
  function hueGap(a, b) { var d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }
  var ringRef = null, ring = [];
  function hueRing(stops) {
    if (stops === ringRef) return ring;
    var n = stops.length, fam = [], out = [], used = {}, i, j;
    for (i = 0; i < n; i++) fam.push(shotOf(stops[i]) || 'core');
    for (i = 0; i < n; i++) {
      var c = FAM_HUES[fam[i]], prev = i ? out[i - 1] : null;
      // the next stop's hue when it has no choice (or, closing the lap, the first stop's)
      var nf = i + 1 < n ? fam[i + 1] : null, next = i + 1 === n && n > 1 ? out[0] : (nf && FAM_HUES[nf].length === 1 ? FAM_HUES[nf][0] : null);
      var start = (used[fam[i]] || 0) % c.length, best = c[start], bestGap = -1;
      for (j = 0; j < c.length; j++) {
        var h = c[(start + j) % c.length];
        var g = Math.min(prev == null ? 360 : hueGap(h, prev), next == null ? 360 : hueGap(h, next));
        if (g >= MIN_SEP) { best = h; bestGap = g; break; }
        if (g > bestGap) { best = h; bestGap = g; }
      }
      used[fam[i]] = (used[fam[i]] || 0) + 1;
      out.push(best);
    }
    ringRef = stops; ring = out;
    return ring;
  }
  function stopColor(idx) {
    if (idx == null || idx < 0) return null;
    var NS = window.NETSCENE, TR = NS && NS.tour, hue = null;
    if (TR && TR.stops && TR.stops.length) { try { hue = hueRing(TR.stops)[idx]; } catch (e) { hue = null; } }
    if (hue == null) hue = TOUR_HUES[idx % TOUR_HUES.length];
    return hslToRgb(hue, 1.0, 0.5);
  }

  /* v13: the story line. story.js owns the text (one measured line per stop, changed on
     the arrival beat); asking it HERE, in the same pass that counts the beat, puts the
     new line in the arrival's own post, so the TV swaps its line on the same beat. */
  function storyNow() {
    var S = window.NB_STORY;
    if (!S || typeof S.tick !== 'function') return '';
    try { var t = S.tick(); return typeof t === 'string' ? t.slice(0, 64) : ''; } catch (e) { return ''; }
  }

  function intent() {
    var o = { mode: 'tour', phase: 'hold', bri: 100,
              stop: '', stop_name: '', from: '', to: '', to_name: '',
              idx: 0, n: 0, prog: 1, travel_s: 0, hold_s: T_HOLD_OVER,
              manual: false, stops: stopsCacheList };

    // DOOM owns the room while it is on screen
    var dm = (document.body.dataset.doom || '');
    if (dm && dm.indexOf('phase=off') !== 0) o.mode = 'doom';
    else if (Date.now() < threatUntil) o.mode = 'threat';

    var NS = window.NETSCENE, TR = NS && NS.tour;
    if (TR && TR.stops && TR.stops.length) {
      o.phase = (TR.phase === 'travel') ? 'travel' : 'hold';
      o.idx = TR.idx || 0; o.n = TR.stops.length; o.manual = !!TR.manual;

      var cur = TR.stops[TR.idx], nxt = TR.stops[TR.next];
      o.from = cur ? cur.key : '';
      o.to = nxt ? nxt.key : o.from;          // idx===next during hold, so to==from there
      o.to_name = nxt ? nxt.name : (cur ? cur.name : '');
      o.travel_s = TR.travelT || 0;
      /* v11 (2026-10-07): the leg's cinematic move, so the TV can fly its own
         version of it. OPTIONAL fields; an old TV ignores them. */
      if (NS.bpm) o.bpm = NS.bpm;              // v12: the beat grid; lights pulse the kick from the arrival
      if (TR.move) { o.move = TR.move; o.move_dir = TR.moveDir === -1 ? -1 : 1; }
      if (o.phase === 'travel') {
        var e = (NS.t != null && TR.t0 != null) ? (NS.t - TR.t0) : 0;
        o.prog = TR.travelT ? Math.max(0, Math.min(1, e / TR.travelT)) : 1;
        o.hold_s = NS.holdFor ? NS.holdFor(nxt) : ((nxt && nxt.hold) || ((nxt && nxt.list) ? T_HOLD : T_HOLD_OVER));   // dwell awaiting at the destination (a stop may set its own: the stream ride)
      } else {
        o.prog = 1;
        o.hold_s = NS.holdFor ? NS.holdFor(cur) : ((cur && cur.hold) || ((cur && cur.list) ? T_HOLD : T_HOLD_OVER));
      }

      // "stop" (and colour) hand over at the travel midpoint, matching the
      // camera's own focus handover (setFocus in tourTick) -- from/to/idx
      // above track the raw leg instead, so the TV can plan ahead of that.
      var si = (TR.phase === 'travel' && TR.switched) ? TR.next : TR.idx;
      var st = TR.stops[si];
      if (st) { o.rgb = stopColor(si); o.stop = st.key; o.stop_name = st.name || st.key; o.shot = shotOf(st); }
      // v10: one beat per ARRIVAL, at the moment the camera LANDS.
      // It used to key off the stop key changing, but the key hands over at the
      // travel midpoint (TR.switched) and TR.idx changes again on arrival, so
      // every leg beat twice - once mid-flight, in the part of the envelope
      // that is meant to be the dip (measured: 1.86 beats/stop on the wall,
      // 1.54 in a 2-4 fps headless run; the strip's median brightness sat at
      // the punch level). The stop / to / prog fields above still hand over
      // early; only the beat moved. The travel -> hold transition is the one
      // and only landing, so this cannot fire twice per leg.
      if (o.phase === 'hold' && lastPhase === 'travel') beat++;
      lastPhase = o.phase;

      if (TR.stops !== stopsCacheRef) {       // only remap on a topology rebuild
        stopsCacheRef = TR.stops;
        stopsCacheList = TR.stops.slice(0, 64).map(function (s) { return { key: s.key, name: s.name }; });
      }
      o.stops = stopsCacheList;
    }
    o.beat = beat;
    o.story = (o.mode === 'tour' && !o.manual) ? storyNow() : '';   // after the beat was counted: same post as the arrival
    // ease the room down while the camera is in transit so the arrival reads
    o.bri = (o.mode === 'doom') ? 100 : (o.phase === 'travel' ? 70 : 100);
    return o;
  }

  // Which screen is this, and does it own the tour protocol?
  // index.html leaves these unset (wall, tour owner); nexus.html sets them.
  var SRC = (window.LIGHTSYNC_SRC === "nexus") ? "nexus" : "wall";
  var TOUR = (window.LIGHTSYNC_TOUR !== false);
  var COLOR_MIN_MS = 250;            // ~4 Hz is well beyond what a lamp can show
  var lastColorPost = 0, lastColorKey = "";

  /* The wall HUD chip: a dot in the tour's current colour plus the stop name.
     features.lights off -> the chip stays hidden and no colour is POSTed, but
     publish() below still runs: the nexus screen follows /api/lightstate. */
  var chipEl = null, chipLooked = false;
  var chipLast = '';
  function paintChip() {
    if (!chipLooked) { chipLooked = true; chipEl = document.getElementById('chip-light'); }
    if (!chipEl) return;
    if (!(CFG().features || {}).lights) { if (chipEl.style.display !== 'none') chipEl.style.display = 'none'; return; }
    /* the chip follows the TOUR, not the pixel histogram: intent() always has a
       stop, while a canvas readback can come back empty (no preserveDrawingBuffer)
       and would otherwise leave the chip blank forever */
    var it = intent();
    var rgb = it.rgb || (lastSample && lastSample.rgb) || [0x8f, 0xb0, 0xd0];
    var name = it.stop_name || 'overview';
    var html = '<i style="background:rgb(' + rgb.join(',') + ')"></i>LIGHTS \u00b7 ' +
      String(name).replace(/[&<>"]/g, '').slice(0, 22).toUpperCase();
    if (html === chipLast) return;
    chipLast = html;
    chipEl.style.display = '';
    chipEl.innerHTML = html;
  }
  /* Read every reply to the end. A keepalive fetch whose response body
     is never read stays charged against Chrome's 64 KiB in-flight keepalive quota
     until garbage collection frees it, so ~52 lightstate POSTs (~1.25 KB each) in
     one GC-quiet stretch made every later POST fail with "Failed to fetch"; the
     TV saw the wall go silent and dropped to free roam. Measured in a headless
     Chromium 149: 52 accepted then 100% rejected; with the body drained, 86/86. */
  function drain(r) { return r && r.arrayBuffer ? r.arrayBuffer() : null; }

  function postColor(s) {
    if (!s || !s.rgb) return;
    if (!(CFG().features || {}).lights) return;   // no bridge configured
    var now = Date.now();
    var key = s.rgb.join(",") + "|" + (s.bri | 0);
    if (key === lastColorKey && now - lastColorPost < 2000) return;   // still heartbeat
    if (now - lastColorPost < COLOR_MIN_MS) return;
    lastColorPost = now; lastColorKey = key;
    try {
      fetch("/api/lightcolor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ src: SRC, rgb: s.rgb, bri: (s.bri == null ? 100 : s.bri) }),
        keepalive: true,
      }).then(drain).catch(function () {});
    } catch (e) { /* never let this break the dashboard */ }
  }

  var QA_POSTS = { sent: 0, ok: 0, bad: 0, story: 0, shot: 0 };   // QA: posts ok must equal sent
  function publish(s) {
    var now = Date.now();
    var it = intent();
    s.mode = it.mode; s.phase = it.phase; s.beat = it.beat; s.bri = it.bri;
    s.stop = it.stop || ''; s.stop_name = it.stop_name || '';   // the TV (nexus) follows this
    s.from = it.from || ''; s.to = it.to || ''; s.to_name = it.to_name || '';
    s.idx = it.idx | 0; s.n = it.n | 0;
    s.prog = Math.round(it.prog * 1000) / 1000;
    s.travel_s = Math.round(it.travel_s * 100) / 100;
    s.hold_s = Math.round(it.hold_s * 100) / 100;
    s.manual = !!it.manual;
    if (it.move) { s.move = it.move; s.move_dir = it.move_dir; } else { delete s.move; delete s.move_dir; }
    if (it.bpm) s.bpm = it.bpm; else delete s.bpm;   // v12: the tour's beat grid (lights pulse the kick)
    if (it.story) s.story = it.story; else delete s.story;   // v13: the wall's story line, verbatim (the TV shows the same string)
    if (it.shot) s.shot = it.shot; else delete s.shot;       // v13: wide|core|planet|stream|edge
    s.stops = it.stops;
    if (it.rgb) { s.rgb = it.rgb; s.hue = Math.round(rgbToHue(it.rgb[0], it.rgb[1], it.rgb[2])[0]); }
    /* /api/lightstate requires an rgb triple. At the OVERVIEW stop there is no
       subject colour, and without a readable canvas there is no histogram
       either, so fall back to the infra tone rather than posting a payload the
       server has to reject (which would also mute the tour feed the TV reads). */
    if (!s.rgb) { s.rgb = catRgb('infra'); s.hue = Math.round(rgbToHue(s.rgb[0], s.rgb[1], s.rgb[2])[0]); }

    // colour alone used to gate the POST, so a phase/beat/idx change could sit
    // unpublished for 5 s - long enough to miss the arrival it was meant to mark.
    // Any of these flipping bypasses the steady-state cadence below entirely.
    var trigKey = s.stop + '|' + it.phase + '|' + it.beat + '|' + it.idx + '|' + it.to + '|' + it.manual + '|' + it.mode + '|' + (it.story || '');
    var since = now - lastPost;
    var triggered = trigKey !== lastSent;
    if (since < POST_MIN_MS) return;                         // hard ~8/s ceiling, always
    if (!triggered) {
      var minGap = (it.phase === 'travel') ? POST_TRAVEL_MS : POST_HOLD_MS;
      if (since < minGap) return;
    }
    lastPost = now; lastSent = trigKey;
    QA_POSTS.sent++;
    if (s.story) QA_POSTS.story++;
    if (s.shot) QA_POSTS.shot++;
    try {
      fetch("/api/lightstate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(s),
        keepalive: true,
      }).then(function (r) { if (r && r.ok) QA_POSTS.ok++; else QA_POSTS.bad++; return drain(r); })
        .catch(function () { QA_POSTS.bad++; });
    } catch (e) { QA_POSTS.bad++; /* never let this break the dashboard */ }
  }

  var lastSample = null, lastFrameAt = 0, lastSampleAt = 0;
  var SAMPLE_MS = 500;      // = SAMPLE_EVERY frames at 60 fps, now fps-independent

  /* The tour protocol is NOT a function of the pixels: stop/idx/phase/prog/beat
     all come from NETSCENE.tour, and the colour for a stop comes from
     stopColor(). Gating the whole publish on `lastSample` meant one failed pixel
     read took the TV's sync and the room's lights down with it - and sample()
     returns null for a legitimate reason every time the wall is not painting
     (lit === 0 on a black canvas, or a renderer without preserveDrawingBuffer).
     Publish on whatever we have; colour is the only part that needs real pixels. */
  function pump() {
    var base = lastSample || {};
    if (TOUR) publish(base);             // wall only: owns the tour protocol
    if (base.rgb) postColor(base);       // publish() fills base.rgb from stopColor()
  }

  function loop() {
    requestAnimationFrame(loop);
    lastFrameAt = Date.now();
    frame++;
    try {
      /* sample on TIME, not frame count (2026-10-04): every 30th frame made the
         ALPHA baseline's time constant 62 s at 60 fps, 125 s at 30, 26 s at 144 */
      /* ... and only when a readback slot is free: a busy frame is not a spent sample, it is retried on the next one */
      if (lastFrameAt - lastSampleAt >= SAMPLE_MS && pixelsReady()) { lastSampleAt = lastFrameAt; var s = sample(); if (s) lastSample = s; }
      /* the HUD chip is tour-driven and cheap, so it never waits for a sample */
      if (TOUR && frame % 10 === 0) paintChip();
      pump();
    } catch (e) { /* swallow: the dashboard must keep rendering */ }
  }

  /* Watchdog. Observed on a wall: a live scene and a live rAF for 25 min while
     this file published NOTHING, and a reload fixed it instantly with no code
     change - the rAF chain did not survive the idle period after the page's
     animate() stopped rescheduling on an empty room. A timer is not tied to
     the frame sink, and publishing needs no drawing buffer, so the sync and
     the per-stop colour survive even if rAF never comes back. Only the hue
     histogram needs a real frame. publish() keeps its own rate limits, so this
     is a floor (~2.5 Hz), never an extra load. */
  var started = false;
  function start() {
    if (started) return; started = true;
    loop();
    setInterval(function () { try { pump(); } catch (e) { } }, 400);
  }

  /* QA (read-only, additive): beat counter, so 'one beat per stop' is measurable */
  /* QA (read-only): plain enumerable getters so JSON.stringify(LIGHTSYNC_QA)
     shows numbers (an object of functions serialises as {}). Populated from
     page load; beats counts tour arrivals seen by intent(), arrivals is the
     scene's own count (NETSCENE.qaArrivals); beats/arrivals must be 1.00. */
  /* the per-stop room colour, for the wall's arrival accent (same hue the
     lights take at that stop) */
  window.LIGHTSYNC_STOP_RGB = stopColor;
  window.LIGHTSYNC_SHOT = shotOf;            // the shot family of a stop (story.js, QA)
  window.LIGHTSYNC_QA = {
    beat: function () { return beat; },        // not intent(): that advances the beat
    loadedAt: Date.now()
  };
  Object.defineProperty(window.LIGHTSYNC_QA, 'beats', { enumerable: true, get: function () { return beat; } });
  Object.defineProperty(window.LIGHTSYNC_QA, 'arrivals', { enumerable: true, get: function () { var NS = window.NETSCENE; return NS && NS.qaArrivals || 0; } });
  Object.defineProperty(window.LIGHTSYNC_QA, 'ring', { enumerable: true, get: function () { var NS = window.NETSCENE, TR = NS && NS.tour; return TR && TR.stops ? hueRing(TR.stops).slice() : []; } });
  Object.defineProperty(window.LIGHTSYNC_QA, 'posts', { enumerable: true, get: function () { return QA_POSTS; } });
  Object.defineProperty(window.LIGHTSYNC_QA, 'src', { enumerable: true, get: function () { return SRC; } });

  if (document.readyState === "complete") setTimeout(start, 4000);
  else addEventListener("load", function () { setTimeout(start, 4000); });
})();
