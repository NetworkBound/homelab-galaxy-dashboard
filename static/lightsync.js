/* lightsync.js (v9) — publish the galaxy's on-screen colour and tour state so
 * smart lights (and the nexus screen) can track the REAL dashboard, 1:1 with
 * what is on the monitor.
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
  var T_HOLD = 3.8;         // netscene.js T_HOLD / T_HOLD_OVER: not exported,
  var T_HOLD_OVER = 5.3;    // mirrored here per the sync protocol v2 contract
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

  function sample() {
    var src = document.querySelector("canvas");
    if (!src || !src.width) return null;
    try {
      sctx.drawImage(src, 0, 0, W, H);
    } catch (e) { return null; }

    var d;
    try { d = sctx.getImageData(0, 0, W, H).data; } catch (e) { return null; }

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
  var beat = 0, lastStopKey = null;
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

  /* Colour by SUBJECT, not by histogram.
     The pixel histogram picks whichever hue is most over-represented against
     its own baseline, which reliably lands on the rare bright accents - so the
     room sat in magenta for minutes while the camera toured green switches and
     cyan hosts. When the tour is parked on something specific, light the room
     in that subsystem's own colour instead; fall back to the histogram at the
     overview, where the galaxy really is the subject. */
  function catRgb(cat) {
    var P = CFG().palette || {};
    return hexRgb(P[cat] || P.infra || '#8fb0d0');
  }
  /* A per-host stop lights the room in THAT node's configured accent, by node
     index, so with three nodes configured the room visibly changes colour as
     the tour walks from one to the next. Everything else keys off the
     category palette — both come from /api/config, never a literal. */
  function stopColor(key) {
    if (!key) return null;
    var C = CFG();
    if (key.indexOf('wan') === 0)     return catRgb('monitor');    // the edge
    if (key.indexOf('fabric') === 0)  return catRgb('network');    // switching
    if (key.indexOf('wired:') === 0)  return catRgb('media');      // wired
    if (key.indexOf('ap:') === 0)     return catRgb('web');        // wireless
    if (key.indexOf('blk:') === 0) {
      var segs = key.split(':'), cat = segs[segs.length - 1] || 'infra';   // blk:pve:<node>:<cat> -> <cat>
      return catRgb(cat);
    }
    if (key.indexOf('host:') === 0) {
      var node = C.nodeFromKey ? C.nodeFromKey(key) : null;        // host:pve:<node>
      if (node && C.nodeAccent) return hexRgb(C.nodeAccent(node));
      return catRgb('media');
    }
    return null;                                                   // overview
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
      if (o.phase === 'travel') {
        var e = (NS.t != null && TR.t0 != null) ? (NS.t - TR.t0) : 0;
        o.prog = TR.travelT ? Math.max(0, Math.min(1, e / TR.travelT)) : 1;
        o.hold_s = (nxt && nxt.list) ? T_HOLD : T_HOLD_OVER;   // dwell awaiting at the destination
      } else {
        o.prog = 1;
        o.hold_s = (cur && cur.list) ? T_HOLD : T_HOLD_OVER;
      }

      // "stop" (and colour) hand over at the travel midpoint, matching the
      // camera's own focus handover (setFocus in tourTick) -- from/to/idx
      // above track the raw leg instead, so the TV can plan ahead of that.
      var st = TR.stops[(TR.phase === 'travel' && TR.switched) ? TR.next : TR.idx];
      var k = st ? (st.key + '|' + TR.idx) : null;
      // one beat per ARRIVAL, so the room punches when the camera lands
      if (k && k !== lastStopKey) { lastStopKey = k; beat++; }
      if (st) { o.rgb = stopColor(st.key); o.stop = st.key; o.stop_name = st.name || st.key; }

      if (TR.stops !== stopsCacheRef) {       // only remap on a topology rebuild
        stopsCacheRef = TR.stops;
        stopsCacheList = TR.stops.slice(0, 64).map(function (s) { return { key: s.key, name: s.name }; });
      }
      o.stops = stopsCacheList;
    }
    o.beat = beat;
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
      }).catch(function () {});
    } catch (e) { /* never let this break the dashboard */ }
  }

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
    var trigKey = s.stop + '|' + it.phase + '|' + it.beat + '|' + it.idx + '|' + it.to + '|' + it.manual + '|' + it.mode;
    var since = now - lastPost;
    var triggered = trigKey !== lastSent;
    if (since < POST_MIN_MS) return;                         // hard ~8/s ceiling, always
    if (!triggered) {
      var minGap = (it.phase === 'travel') ? POST_TRAVEL_MS : POST_HOLD_MS;
      if (since < minGap) return;
    }
    lastPost = now; lastSent = trigKey;
    try {
      fetch("/api/lightstate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(s),
        keepalive: true,
      }).catch(function () {});
    } catch (e) { /* never let this break the dashboard */ }
  }

  var lastSample = null, fallbackSample = null;
  function loop() {
    requestAnimationFrame(loop);
    frame++;
    try {
      if (frame % SAMPLE_EVERY === 0) { var s = sample(); if (s) lastSample = s; }
      /* the HUD chip is tour-driven and cheap, so it never waits for a sample */
      if (TOUR && frame % 10 === 0) paintChip();
      /* TOUR STATE PUBLISHES UNCONDITIONALLY. The nexus screen follows
         /api/lightstate for its own director, so it must not depend on a
         successful canvas readback: a renderer without preserveDrawingBuffer
         (or a headless/remote capture) reads back blank and used to silence
         the whole feed. Colour is the only part that needs real pixels. */
      if (TOUR) publish(lastSample || (fallbackSample = fallbackSample || {}));
      if (lastSample) postColor(lastSample);   // both screens: per-screen colour
    } catch (e) { /* swallow: the dashboard must keep rendering */ }
  }

  if (document.readyState === "complete") setTimeout(loop, 4000);
  else addEventListener("load", function () { setTimeout(loop, 4000); });
})();
