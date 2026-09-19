/* showtime.js — live "ops-center" overlays + display modes for the kiosk wall.
   Self-contained like cinema.js: injects its own DOM + CSS, hooks the tick chain
   for exactly one per-frame textContent write (the timecode), and never throws
   out of the render loop. Data comes from /api/showtime (5 s) and the two SSE
   streams (/api/pulse/stream beat, /api/mode/stream mode switches).

   MODES (POST /api/mode {"mode":..} or keys 1-5 on the kiosk)
     1 wall      the everyday look
     2 showcase  recording: corner brackets, richer grade, LIVE pill front and centre
     3 ops       dense: alert list + detection feed + AI fabric all up
     4 night     dim + calm
     5 alert     red accents (auto-entered by the backend on new sev>=3 problems)

   Video-safe: nothing strobes; the only per-frame change is digits. All motion
   is CSS transform/opacity (compositor-only). DOM writes otherwise ≤ every 5 s.

   Reads:   /api/showtime  mode, ai{}, detections[], emby{}, alerts[]
            /api/gpu       gpus[] (VRAM totals for the AI fabric bars)
            /api/mode/stream, /api/pulse/stream (two of the page's five SSEs) */
(function () {
  'use strict';
  var LITE = location.pathname.indexOf('/nexus') === 0;   // big screen: pill + modes only
  var POLL_MS = 5000, CARD_TTL_S = 6 * 3600, CARDS_MAX = 3;

  /* ---------- grade presets per mode (fed to cinema.js via window.cinemaSet) ---------- */
  var GRADES = {
    wall:     { ca: 0.0016, vig: 0.42, grain: 0.018, sat: 1.16, con: 1.055, lift: 0.55, strength: 0.68, radius: 0.58, threshold: 0.70 },
    showcase: { ca: 0.0024, vig: 0.50, grain: 0.014, sat: 1.26, con: 1.09,  lift: 0.75, strength: 0.82, radius: 0.62, threshold: 0.66 },
    ops:      { ca: 0.0010, vig: 0.34, grain: 0.012, sat: 1.10, con: 1.04,  lift: 0.40, strength: 0.60, radius: 0.55, threshold: 0.74 },
    night:    { ca: 0.0010, vig: 0.62, grain: 0.010, sat: 0.92, con: 1.00,  lift: 0.30, strength: 0.48, radius: 0.60, threshold: 0.78 },
    alert:    { ca: 0.0030, vig: 0.58, grain: 0.020, sat: 1.22, con: 1.10,  lift: 0.90, strength: 0.76, radius: 0.60, threshold: 0.68 }
  };
  var MODES = ['wall', 'showcase', 'ops', 'night', 'alert'];

  /* ------------------------------ CSS ------------------------------ */
  var CSS = [
    ':root{--st-ink:#dcefff;--st-dim:#7e93ab;--st-mute:#516681;--st-line:rgba(125,160,200,.18);',
    '  --st-bg:rgba(6,11,22,.62);--st-acc:#5ad7ff;--st-ok:#3ecf8e;--st-warn:#ffb347;--st-bad:#ff5a6a;--st-pink:#ff4fa3}',
    '.st{position:fixed;z-index:8;pointer-events:none;font:11px/1.4 ui-monospace,Menlo,Consolas,monospace;',
    '  color:var(--st-ink);font-variant-numeric:tabular-nums;letter-spacing:.2px;',
    '  transition:opacity .6s ease,transform .6s ease}',
    '.st .h{font-size:8.5px;letter-spacing:1.6px;text-transform:uppercase;color:var(--st-dim);margin-bottom:5px;',
    '  display:flex;align-items:center;gap:8px}',
    '.st .h:after{content:"";flex:1;height:1px;background:linear-gradient(90deg,var(--st-line),transparent)}',
    '.st .box{background:var(--st-bg);border:1px solid var(--st-line);border-radius:5px;padding:7px 10px;',
    '  box-shadow:0 8px 28px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.04)}',

    /* LIVE pill — top centre */
    '#st-live{top:calc(var(--sy,64px) - 4px);left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:10px;',
    '  padding:4px 12px 4px 9px;border-radius:999px;background:rgba(4,9,20,.72);border:1px solid rgba(255,90,106,.35);',
    '  box-shadow:0 0 0 1px rgba(255,90,106,.08),0 6px 22px rgba(0,0,0,.5)}',
    '#st-live .dot{width:7px;height:7px;border-radius:50%;background:var(--st-bad);box-shadow:0 0 8px var(--st-bad);',
    '  animation:st-breathe 2.4s ease-in-out infinite}',
    '#st-live .live{font-size:10px;font-weight:700;letter-spacing:2px;color:#ff8b96}',
    '#st-live .tc{font-size:12.5px;font-weight:600;color:#fff;letter-spacing:1px;min-width:118px}',
    '#st-live .tc i{font-style:normal;color:var(--st-acc)}',
    '#st-live .fps{font-size:9px;letter-spacing:1.2px;color:var(--st-dim)}',
    '#st-live .fps b{color:var(--st-ok);font-weight:600}',
    '#st-live .mode{font-size:8.5px;letter-spacing:1.6px;text-transform:uppercase;color:var(--st-dim);',
    '  border-left:1px solid var(--st-line);padding-left:10px}',
    '#st-live .mode b{color:var(--st-ink)}',
    '#st-live:after{content:"";position:absolute;inset:-1px;border-radius:999px;pointer-events:none;',
    '  background:linear-gradient(100deg,transparent 30%,rgba(255,255,255,.14) 50%,transparent 70%);',
    '  transform:translateX(-120%);opacity:0}',
    '#st-live.beat:after{animation:st-glint .9s ease-out 1}',
    '@keyframes st-glint{0%{transform:translateX(-120%);opacity:1}100%{transform:translateX(120%);opacity:0}}',
    '@keyframes st-breathe{0%,100%{opacity:1}50%{opacity:.45}}',

    /* AI fabric — left, mid */
    '#st-ai{left:calc(var(--sx,112px) - 4px);top:31%;width:262px}',
    '#st-ai .inst{margin:5px 0 7px}',
    '#st-ai .row{display:flex;align-items:baseline;gap:8px;white-space:nowrap}',
    '#st-ai .row b{color:#fff;font-weight:600}',
    '#st-ai .row .g{color:var(--st-pink);font-size:9.5px;letter-spacing:.8px}',
    '#st-ai .row .r{margin-left:auto;color:var(--st-dim);font-size:9.5px}',
    '#st-ai .bar{height:4px;border-radius:2px;background:rgba(255,255,255,.06);margin:4px 0 3px;overflow:hidden}',
    '#st-ai .bar i{display:block;height:100%;width:0;border-radius:2px;',
    '  background:linear-gradient(90deg,var(--st-pink),var(--st-acc));transition:width 1.2s ease}',
    '#st-ai .m{display:flex;gap:8px;font-size:10px;color:var(--st-ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '#st-ai .m em{font-style:normal;color:var(--st-mute)}',
    '#st-ai .m.busy b{background:linear-gradient(90deg,#fff,var(--st-acc),#fff);background-size:200% 100%;',
    '  -webkit-background-clip:text;color:transparent;animation:st-shimmer 1.6s linear infinite}',
    '#st-ai .m.idle{color:var(--st-mute)}',
    '@keyframes st-shimmer{to{background-position:-200% 0}}',
    '#st-ai .tpu{display:flex;align-items:center;gap:8px;margin-top:6px;padding-top:6px;border-top:1px solid var(--st-line);font-size:10px}',
    '#st-ai .tpu .chip{font-size:8px;letter-spacing:1.4px;padding:1px 6px;border-radius:3px;border:1px solid rgba(62,207,142,.45);color:var(--st-ok)}',
    '#st-ai .tpu b{color:#fff}',
    '#st-ai .tpu span{color:var(--st-dim)}',

    /* detections — right, mid */
    '#st-det{right:calc(var(--sx,112px) - 4px);top:31%;width:272px}',
    '#st-det .card{display:flex;gap:9px;align-items:center;margin-top:6px;padding:5px 7px 5px 5px;border-radius:5px;',
    '  background:rgba(6,11,22,.66);border:1px solid var(--st-line);transform:translateX(0);opacity:1;',
    '  transition:opacity .6s ease,transform .6s cubic-bezier(.2,.8,.2,1)}',
    '#st-det .card.in{transform:translateX(40px);opacity:0}',
    '#st-det .card.out{opacity:0;transform:translateX(0) scale(.96)}',
    '#st-det .card img{width:88px;height:50px;object-fit:cover;border-radius:3px;background:#0a1220;flex:0 0 auto}',
    '#st-det .card .t{min-width:0}',
    '#st-det .card .l{font-size:11.5px;font-weight:700;color:#fff;text-transform:uppercase;letter-spacing:1px}',
    '#st-det .card .l.person{color:var(--st-warn)} #st-det .card .l.car{color:var(--st-acc)}',
    '#st-det .card .c{font-size:9.5px;color:var(--st-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '#st-det .card .s{font-size:9px;color:var(--st-mute);letter-spacing:.8px}',
    '#st-det .card .s b{color:var(--st-ok);font-weight:600}',
    '#st-det .card.live .l:after{content:"LIVE";font-size:7.5px;letter-spacing:1.5px;color:var(--st-bad);margin-left:7px;vertical-align:middle}',
    '#st-det .none{font-size:10px;color:var(--st-mute);padding:6px 2px}',
    '#st-det .cams{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;font-size:9px;color:var(--st-dim)}',
    '#st-det .cams span{border:1px solid var(--st-line);border-radius:3px;padding:1px 6px}',
    '#st-det .cams span b{color:var(--st-ink);font-weight:600}',

    /* emby — left, below AI */
    '#st-emby{left:calc(var(--sx,112px) - 4px);bottom:calc(var(--sy,64px) + 44px);width:262px}',
    '#st-emby .np{display:flex;flex-direction:column;gap:2px;margin-top:4px;padding:5px 8px;border-radius:4px;',
    '  background:rgba(56,225,255,.06);border:1px solid rgba(56,225,255,.22)}',
    '#st-emby .np b{color:#fff;font-weight:600;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '#st-emby .np span{font-size:9.5px;color:var(--st-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '#st-emby .np span i{font-style:normal;color:#38e1ff}',
    '#st-emby .np .tag{display:inline-block;font-size:7.5px;letter-spacing:1.3px;border:1px solid var(--st-line);',
    '  border-radius:3px;padding:0 5px;margin-left:6px;color:var(--st-dim);vertical-align:middle}',
    '#st-emby .np .tag.tx{color:var(--st-warn);border-color:rgba(255,179,71,.45)}',
    '#st-emby .idle{font-size:10px;color:var(--st-mute);margin-top:3px}',
    '#st-emby .idle b{color:var(--st-dim);font-weight:600}',

    /* alert banner + list (ops/alert) */
    '#st-alert{top:calc(var(--sy,64px) + 40px);left:50%;transform:translateX(-50%) translateY(-8px);opacity:0;',
    '  padding:6px 16px;border-radius:5px;background:rgba(255,43,43,.10);border:1px solid rgba(255,90,106,.55);',
    '  color:#ffb0b7;font-size:11px;letter-spacing:1.2px;text-transform:uppercase;white-space:nowrap;',
    '  box-shadow:0 0 30px rgba(255,60,80,.18)}',
    '#st-alert b{color:#fff;font-weight:700;margin-right:10px}',
    'body.st-alert #st-alert{opacity:1;transform:translateX(-50%) translateY(0)}',
    '#st-alist{right:calc(var(--sx,112px) - 4px);top:31%;width:272px;transform:translateY(calc(100% + 10px));opacity:0}',
    'body.st-ops #st-alist,body.st-alert #st-alist{opacity:1;transform:none}',
    'body.st-ops #st-det,body.st-alert #st-det{top:auto;bottom:calc(var(--sy,64px) + 44px)}',
    '#st-alist .a{display:flex;gap:7px;align-items:baseline;padding:3px 0;border-bottom:1px solid var(--st-line);font-size:10px}',
    '#st-alist .a:last-child{border-bottom:0}',
    '#st-alist .a .sv{width:6px;height:6px;border-radius:50%;flex:0 0 auto;box-shadow:0 0 6px currentColor;background:currentColor;transform:translateY(-1px)}',
    '#st-alist .a .n{color:#fff;font-weight:600;white-space:nowrap}',
    '#st-alist .a .m{color:var(--st-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '#st-alist .ok{font-size:10px;color:var(--st-ok);padding:4px 2px}',

    /* corner brackets (showcase) */
    '#st-frame{inset:calc(var(--sy,64px) - 18px) calc(var(--sx,112px) - 22px);opacity:0;transition:opacity .8s ease}',
    /* The rail-side overlays (#st-ai, #st-det, #st-alist, #st-emby) live in the
       margins hero.js's HERO layout frees up. In the FULL instrument HUD those
       margins are the rails, so they would sit on top of the panels — park them
       for that layout only. The centre LIVE pill and the alert banner stay:
       they never overlap a rail. */
    'body:not(.hero) #st-ai,body:not(.hero) #st-det,',
    'body:not(.hero) #st-alist,body:not(.hero) #st-emby{display:none}',
    'body.st-showcase #st-frame{opacity:1}',
    '#st-frame i{position:absolute;width:34px;height:34px;border:2px solid rgba(90,215,255,.55);',
    '  filter:drop-shadow(0 0 6px rgba(90,215,255,.35))}',
    '#st-frame i:nth-child(1){left:0;top:0;border-right:0;border-bottom:0}',
    '#st-frame i:nth-child(2){right:0;top:0;border-left:0;border-bottom:0}',
    '#st-frame i:nth-child(3){left:0;bottom:0;border-right:0;border-top:0}',
    '#st-frame i:nth-child(4){right:0;bottom:0;border-left:0;border-top:0}',
    '#st-frame .rec{position:absolute;right:0;top:44px;font-size:9px;letter-spacing:2px;color:#ff8b96}',
    '#st-frame .rec:before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--st-bad);',
    '  margin-right:6px;animation:st-breathe 1.8s ease-in-out infinite}',

    /* mode-level looks */
    'body.st-night .st,body.st-night #herotop,body.st-night #herobot,body.st-night #cin{opacity:.55}',
    'body.st-night #st-live{opacity:.8}',
    'body.st-alert{--accent:#ff5a6a;--edge:rgba(255,90,106,.35)}',
    'body.st-alert #st-live{border-color:rgba(255,90,106,.7);box-shadow:0 0 0 1px rgba(255,90,106,.25),0 0 28px rgba(255,60,80,.25)}',
    'body.st-alert #st-live .live{color:#fff}',
    'body.st-alert #hbrand .wm i,body.st-alert #title b span{color:#ff8b96!important;text-shadow:0 0 14px rgba(255,90,106,.5)!important}',
    'body.st-showcase #st-ai,body.st-showcase #st-emby{opacity:.92}',
    /* wall: keep the plate clean — feeds are quieter */
    'body.st-wall #st-ai,body.st-wall #st-det,body.st-wall #st-emby{opacity:.85}',
    /* hide feeds while DOOM has the screen */
    'body[data-doom]:not([data-doom^="phase=off"]) .st{opacity:0!important}'
  ].join('\n');

  /* ------------------------------ DOM ------------------------------ */
  var el = {};
  function h(tag, id, cls, html) {
    var e = document.createElement(tag);
    if (id) e.id = id;
    if (cls) e.className = cls;
    if (html) e.innerHTML = html;
    return e;
  }
  function mount() {
    if (el.live) return;
    var s = document.createElement('style'); s.id = 'st-css'; s.textContent = CSS;
    document.head.appendChild(s);
    var b = document.body;
    el.live = h('div', 'st-live', 'st',
      '<span class="dot"></span><span class="live">LIVE</span>' +
      '<span class="tc"><span class="hms">00:00:00</span><i>:00</i></span>' +
      '<span class="fps"><b>60</b> FPS · <span class="fr">0</span></span>' +
      '<span class="mode">mode <b>wall</b></span>');
    b.appendChild(el.live);
    el.hms = el.live.querySelector('.hms'); el.ff = el.live.querySelector('i');
    el.fr = el.live.querySelector('.fr'); el.fpsb = el.live.querySelector('.fps b');
    el.modeb = el.live.querySelector('.mode b');
    el.frame = h('div', 'st-frame', 'st', '<i></i><i></i><i></i><i></i><span class="rec">REC</span>');
    b.appendChild(el.frame);
    el.alert = h('div', 'st-alert', 'st', '<b>ALERT</b><span class="why">—</span>');
    b.appendChild(el.alert);
    if (LITE) return;
    el.ai = h('div', 'st-ai', 'st', '<div class="h">AI fabric</div><div class="body"></div>');
    el.det = h('div', 'st-det', 'st', '<div class="h">Detections · Frigate</div><div class="cards"></div><div class="cams"></div>');
    el.emby = h('div', 'st-emby', 'st', '<div class="h">Now playing · Emby</div><div class="body"></div>');
    el.alist = h('div', 'st-alist', 'st', '<div class="h">Open problems</div><div class="body"><div class="ok">all clear</div></div>');
    b.appendChild(el.ai); b.appendChild(el.emby); b.appendChild(el.alist);  // el.det (Detections/Frigate) intentionally not shown on the physical screens
  }

  /* ------------------------ per-frame: timecode ------------------------ */
  var frames = 0, lastSec = -1, fpsN = 0, fpsT = 0;
  function frameTick(dt) {
    frames++;
    var d = new Date(), ms = d.getTime() % 1000;
    var ff = (ms / (1000 / 60)) | 0; if (ff > 59) ff = 59;
    el.ff.textContent = ':' + (ff < 10 ? '0' : '') + ff;
    var sec = (d.getTime() / 1000) | 0;
    if (sec !== lastSec) {
      lastSec = sec;
      var p = function (n) { return (n < 10 ? '0' : '') + n; };
      el.hms.textContent = p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
      el.fr.textContent = frames;
    }
    fpsN++; fpsT += dt;
    if (fpsT >= 1) { el.fpsb.textContent = Math.min(60, Math.round(fpsN / fpsT)); fpsN = 0; fpsT = 0; }   // panel is 60 Hz; :0.1 rAF over-fires at 120
  }

  /* ------------------------------ feeds ------------------------------ */
  function fmtGB(mb) { return (mb / 1024).toFixed(1) + ' GB'; }
  function ago(s) { s = Math.max(0, s | 0); return s < 60 ? s + 's' : s < 3600 ? ((s / 60) | 0) + 'm' : ((s / 3600) | 0) + 'h'; }
  /* VRAM totals per GPU index, learned from /api/gpu. Empty until the first
     poll answers; the bars fall back to "used only" rather than inventing a
     card size (nothing here assumes a particular GPU). */
  var VRAM = {};
  var lastAI = '', lastEmby = '', lastCams = '', lastAlist = '';

  function renderAI(d) {
    var out = '';
    (d.ollama || []).forEach(function (o) {
      var tot = (o.gpus || []).reduce(function (a, g) { return a + (VRAM[g] || 0); }, 0);
      var used = o.vram_used_mb || 0, pct = tot ? Math.min(100, used / tot * 100) : 0;
      out += '<div class="inst"><div class="row"><b>' + o.name + '</b><span class="g">' + (o.gpu_label || '') + '</span>' +
        '<span class="r">' + (o.up ? (fmtGB(used) + (tot ? ' / ' + fmtGB(tot) : '')) : 'offline') + '</span></div>' +
        '<div class="bar"><i style="width:' + pct.toFixed(1) + '%"></i></div>';
      if (o.loaded && o.loaded.length) {
        o.loaded.forEach(function (m) {
          out += '<div class="m' + (m.busy ? ' busy' : '') + '"><b>' + m.name + '</b><em>' + (m.params || '') + ' ' + (m.quant || '') +
            (m.busy ? ' · thinking' : '') + '</em></div>';
        });
      } else out += '<div class="m idle">' + (o.up ? (o.available || 0) + ' models · idle' : 'unreachable') + '</div>';
      out += '</div>';
    });
    var c = d.coral || {}, f = d.frigate || {};
    out += '<div class="tpu"><span class="chip">' + (String(c.detector || '').indexOf('edgetpu') >= 0 ? 'CORAL TPU' : 'DETECTOR') + '</span>' +
      '<b>' + (c.model || c.detector || '—') + '</b><span>' + (c.inference_ms != null ? c.inference_ms.toFixed(1) + ' ms' : '') +
      (f.detection_fps != null ? ' · ' + f.detection_fps.toFixed(0) + ' det/s' : '') + '</span></div>';
    if (out !== lastAI) { lastAI = out; el.ai.querySelector('.body').innerHTML = out; }
  }

  var seen = {}, cardsInit = false;
  function renderDet(d) {
    return;   // detections are deliberately not displayed on the wall/TV
    /* eslint-disable no-unreachable */
    var f = d.frigate || {}, ev = f.events || [], wrap = el.det.querySelector('.cards');
    var now = Date.now() / 1000;
    var evs = ev.slice().sort(function (a, b) { return b.start - a.start; });
    var fresh = evs.filter(function (e) { return !seen[e.id]; });
    evs.forEach(function (e) { seen[e.id] = true; });          // everything in this response is now known
    // boot: show the latest few quietly; afterwards only genuinely new events slide in
    (cardsInit ? fresh : fresh.slice(0, CARDS_MAX)).reverse().forEach(function (e) {
      var isNew = cardsInit && (now - e.start) < 600;
      var c = h('div', null, 'card' + (isNew ? ' in' : '') + (e.ongoing ? ' live' : ''),
        '<img src="' + e.thumb + '" alt=""><div class="t"><div class="l ' + e.label + '">' + e.label + '</div>' +
        '<div class="c">' + e.camera.replace(/_/g, ' ') + (e.zones && e.zones.length ? ' · ' + e.zones.join(', ') : '') + '</div>' +
        '<div class="s"><b>' + e.score + '%</b> · <span class="age" data-t="' + e.start + '">' + ago(now - e.start) + ' ago</span></div></div>');
      c.dataset.t = e.start;
      wrap.insertBefore(c, wrap.firstChild);
      if (isNew) requestAnimationFrame(function () { requestAnimationFrame(function () { c.classList.remove('in'); }); });
    });
    cardsInit = true;
    // expire + cap
    var cards = wrap.querySelectorAll('.card');
    for (var i = 0; i < cards.length; i++) {
      var cc = cards[i], age = now - parseFloat(cc.dataset.t || 0);
      var a = cc.querySelector('.age'); if (a) a.textContent = ago(age) + ' ago';
      if (i >= CARDS_MAX || age > CARD_TTL_S) {
        if (!cc.classList.contains('out')) { cc.classList.add('out'); setTimeout(function (n) { n.remove(); }, 700, cc); }
      }
    }
    if (!wrap.querySelector('.card') && !wrap.querySelector('.none')) wrap.appendChild(h('div', null, 'none', 'no recent detections'));
    if (wrap.querySelector('.card')) { var n = wrap.querySelector('.none'); if (n) n.remove(); }
    var cams = (f.cameras || []).map(function (c) {
      return '<span>' + c.name.replace(/_/g, ' ') + ' <b>' + (c.det_fps != null ? c.det_fps.toFixed(0) : '–') + '</b></span>';
    }).join('');
    if (cams !== lastCams) { lastCams = cams; el.det.querySelector('.cams').innerHTML = cams; }
  }

  function renderEmby(d) {
    var e = d.emby || {}, out = '';
    if (!e.up) out = '<div class="idle">emby <b>offline</b></div>';
    else {
      (e.playing || []).slice(0, 3).forEach(function (p) {
        out += '<div class="np"><b>' + (p.title || p.item || '—') + (p.channel ? ' <i>· ' + p.channel + '</i>' : '') + '</b>' +
          '<span><i>' + (p.user || '—') + '</i> · ' + (p.device || p.client || '') +
          (p.transcoding ? '<span class="tag tx">transcode</span>' : '<span class="tag">direct</span>') +
          (p.remote ? '<span class="tag">remote</span>' : '') +
          (p.bitrate_mbps ? '<span class="tag">' + p.bitrate_mbps + ' Mb/s</span>' : '') + '</span></div>';
      });
      var idle = (e.sessions || []).filter(function (s) { return s.client !== 'channel-priority-watcher'; }).length;
      out += '<div class="idle">' + ((e.playing || []).length ? '' : 'nothing playing · ') + '<b>' + idle + '</b> sessions connected</div>';
    }
    if (out !== lastEmby) { lastEmby = out; el.emby.querySelector('.body').innerHTML = out; }
  }

  var SEVC = { 5: '#ff2b2b', 4: '#ff5a6a', 3: '#ffa033', 2: '#ffd24a', 1: '#8fb0d0' };
  function renderAlerts() {
    var A = window.ALERTS || {}, ent = Object.keys(A).map(function (k) { return [k, A[k]]; })
      .sort(function (a, b) { return (b[1].sev || 0) - (a[1].sev || 0); }).slice(0, 8);
    var out = ent.length ? ent.map(function (kv) {
      var v = kv[1];
      return '<div class="a"><span class="sv" style="color:' + (SEVC[v.sev] || SEVC[2]) + '"></span><span class="n">' + kv[0] + '</span>' +
        '<span class="m">' + ((v.names && v.names[0]) || '') + (v.n > 1 ? ' +' + (v.n - 1) : '') + '</span></div>';
    }).join('') : '<div class="ok">all clear</div>';
    if (out !== lastAlist) { lastAlist = out; el.alist.querySelector('.body').innerHTML = out; }
  }

  function poll() {
    fetch('/api/showtime', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (!d) return;
      try { if (d.mode) applyMode(d.mode); } catch (e) { }
      if (LITE) return;
      try { renderAI(d); } catch (e) { }
      try { renderDet(d); } catch (e) { }
      try { renderEmby(d); } catch (e) { }
      try { renderAlerts(); } catch (e) { }
    }).catch(function () { });
  }
  function pollGpuTotals() {
    fetch('/api/gpu').then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
      /* VRAM totals keyed by GPU index — the same index /api/showtime's
         ollama[].gpus carries. No host name is assumed. */
      (j && j.gpus || []).forEach(function (g, i) {
        if (g.mem_total) VRAM[g.index != null ? g.index : i] = Number(g.mem_total);
      });
    }).catch(function () { });
  }

  /* ------------------------------ modes ------------------------------ */
  var cur = null;
  function applyMode(m) {
    var name = typeof m === 'string' ? m : (m && m.mode) || 'wall';
    if (MODES.indexOf(name) < 0) name = 'wall';
    if (name === cur) return;
    cur = name;
    MODES.forEach(function (x) { document.body.classList.toggle('st-' + x, x === name); });
    el.modeb.textContent = name;
    if (name === 'alert' && m && typeof m === 'object') {
      var why = m.reason && m.reason.length ? m.reason.map(function (r) { return String(r).replace(/^zbx:/, '').replace(/^net_down:\d+$/, 'device down'); }).join(' · ') : 'new problem';
      el.alert.querySelector('.why').textContent = why;
    }
    try { if (window.cinemaSet) window.cinemaSet(GRADES[name]); } catch (e) { }
    try { if (window.CINEMA && name === 'showcase' && !window.CINEMA.cinema) { /* keep letterbox off: bars would cover the feeds */ } } catch (e) { }
  }
  function postMode(name) {
    fetch('/api/mode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: name }) }).catch(function () { });
  }
  document.addEventListener('keydown', function (e) {
    var t = e.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    var i = ['1', '2', '3', '4', '5'].indexOf(e.key);
    if (i >= 0) { postMode(MODES[i]); e.preventDefault(); }
  });

  /* ------------------------------ streams ------------------------------ */
  function streams() {
    if (typeof EventSource !== 'function') return;
    try {
      var ms = new EventSource('/api/mode/stream');
      ms.onmessage = function (ev) { try { applyMode(JSON.parse(ev.data)); } catch (e) { } };
    } catch (e) { }
    try {
      var ps = new EventSource('/api/pulse/stream');
      ps.onmessage = function () {
        el.live.classList.remove('beat'); void el.live.offsetWidth; el.live.classList.add('beat');
      };
    } catch (e) { }
  }

  /* ------------------------------ boot ------------------------------ */
  function boot() {
    mount();
    applyMode('wall');
    poll(); pollGpuTotals();
    setInterval(poll, POLL_MS); setInterval(pollGpuTotals, 60000);
    streams();
    /* per-frame hook: wrap the tick chain like cinema.js; fall back to rAF on
       pages without a scene tick (nexus) */
    var last = -1, hooked = false;
    (function wrap() {
      var prev = window.netSceneTick;
      if (typeof prev !== 'function') {
        if (!hooked && LITE) { hooked = true; (function loop(now) { requestAnimationFrame(loop); var d = last < 0 ? 0.016 : Math.min(0.5, (now - last) / 1000); last = now; try { frameTick(d); } catch (e) { } })(performance.now()); return; }
        setTimeout(wrap, 300); return;
      }
      hooked = true;
      window.netSceneTick = function (t, dt) {
        try { prev(t, dt); }
        finally { try { frameTick(dt || 0.016); } catch (e) { } }
      };
    })();
  }
  window.SHOWTIME = { mode: function (n) { postMode(n); }, modes: MODES, applyMode: applyMode };
  if (document.readyState === 'complete' || document.readyState === 'interactive') boot();
  else addEventListener('DOMContentLoaded', boot);
})();
