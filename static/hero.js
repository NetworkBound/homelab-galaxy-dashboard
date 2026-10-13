/* hero.js - the wall's chrome: header, status bar and panels, around the 3D scene.
   ---------------------------------------------------------------------------
   v11: a production monitoring product, not a broadcast (docs/contracts.md,
   clean UI): one typeface (Inter, tabular numerals), sizes 11 / 12 / 13 / 15 px, no
   letter-spacing or all-caps, neutral dark panels with hairline borders, colour
   only for status. Fewer simultaneous numbers: the header carries five KPIs,
   the status bar five vitals; the operational detail that only the dense
   F-layout used to show rotates through ONE operations panel (compute,
   storage + backups, services, cameras, network: a page every 10 s); the
   alerts panel never rotates and collapses to "No active alerts"; a legend
   appears while the tour holds at an overview. Keys: F dense layout, P
   recording-safe (blurred camera feeds, no addresses, unnamed cameras).
   Earlier: v8 audience panel (edge.audience, real unique visitors), v7
   audience + threats cells, the daylight palette and the hero layout.

   Loads LAST, after cinema.js and doom.js. Self-contained: injects its own CSS
   and DOM, mirrors values out of the existing HUD rather than adding a second
   poll (plus /api/gpu every 15 s for the compute page), and restyles
   showtime.js's AI and media panels with CSS only (their markup is shared
   with the TV page).
   Reads:   window.CONFIG  brand (header wordmark), domain (visitor hosts are
                           shown relative to it), features.cameras / .audience
   --------------------------------------------------------------------------- */
(function () {
  'use strict';

  var KEY = 'galaxy.layout';           // 'hero' | 'full'
  var PKEY = 'galaxy.privacy';         // '1' | '0'
  var MIRROR_MS = 1000;

  /* Framing handed to netscene per layout. FULL matches the values the dense
     HUD was measured against; HERO is the whole viewport minus the two bars. */
  var FRAME = {
    full: { fracX: 0.649, fracY: 0.589, voffX: 0.0052, voffY: 0.0676,
            ecoWide: 1.22, centerDx: -14 },
    /* pushed hard: with the rails gone the only things reserved are the two
       slim bars, and the label dedup now guarantees text will not pile up when
       the scene is closer */
    hero: { fracX: 0.92, fracY: 0.80, voffX: 0, voffY: 0.020,
            ecoWide: 1.04, centerDx: 0 }
  };

  /* Where netscene_flows may put its arc labels, as viewport fractions. Same
     story as the framing: hardcoded to the dense HUD's centre box, so in hero
     mode the labels crowded into 58% of the width the graph no longer used. */
  var SAFE = {
    full: { x0: 388 / 1920, x1: 1513 / 1920, y0: 129 / 1080, y1: 807 / 1080 },
    hero: { x0: 0.025, x1: 0.975, y0: 0.095, y1: 0.865 }
  };

  var H = { mode: 'hero', privacy: false, top: null, bot: null, last: null };

  /* ---------------- privacy / record-safe redaction ----------------
     What is exposed on this wall is NOT your own addressing - every internal
     address is RFC1918 and identifies nothing about you, and the WAN node often
     carries a private address of its own because the estate sits behind the ISP
     router. What IS real is the REMOTE side of live flows: peer addresses
     you connect to, which say who and where you talk to. Those get masked to
     their first two octets. Private space is left completely alone - masking it
     would destroy the dashboard's usefulness for nothing. */
  var RE_IP = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

  function isPrivate(ip) {
    var p = ip.split('.').map(Number);
    if (p.length !== 4 || p.some(function (n) { return isNaN(n) || n > 255; })) return true;
    if (p[0] === 10 || p[0] === 127) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;   // CGNAT
    return false;
  }
  function maskStr(v) {
    if (typeof v !== 'string' || v.indexOf('.') < 0) return v;
    return v.replace(RE_IP, function (m) {
      if (isPrivate(m)) return m;
      var p = m.split('.');
      return p[0] + '.' + p[1] + '.x.x';
    });
  }
  /* mutate in place: netscene, the flows layer and the panels all receive the
     same object from one fetch, so redacting once covers every consumer */
  var MASK_KEYS = ['ip', 'label', 'src_ip', 'dst_ip', 'src_label', 'dst_label',
                   'name', 'note', 'host', 'remote'];
  function redact(o, depth) {
    if (!o || depth > 6) return o;
    if (Array.isArray(o)) { for (var i = 0; i < o.length; i++) redact(o[i], depth + 1); return o; }
    if (typeof o !== 'object') return o;
    for (var k in o) {
      if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
      var v = o[k];
      if (typeof v === 'string') { if (MASK_KEYS.indexOf(k) >= 0) o[k] = maskStr(v); }
      else if (v && typeof v === 'object') redact(v, depth + 1);
    }
    return o;
  }

  /* ======================================================================
     PRODUCT CHROME (docs/contracts.md, clean UI). The 3D scene and its
     moves are untouched; what changed is everything around them:
       one typeface (Inter, tabular numerals), four sizes (11 meta, 12 rows,
       13 titles / values, 15 KPIs), letter-spacing 0, sentence case;
       neutral dark panels with hairline borders, a title + 3-5 rows each;
       colour only for status (ok / warning / critical / unknown);
       fewer simultaneous numbers: the operational detail that only the dense
       F-layout used to show (PVE nodes, storage, backups, certificates,
       checks, cameras, network) now rotates through ONE operations panel,
       a page every 10 s; the alerts panel never rotates and collapses to one
       quiet line when nothing is wrong.
     ====================================================================== */
  var CSS = [
    /* ---------- 1. tokens (both layouts) ---------- */
    ':root{--ui-font:Inter,"Inter Variable",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;',
    '  --t1:#e6e9ee;--t2:#9aa4b1;--t3:#6b7584;--ok:#3fb950;--warn:#d29922;--crit:#f85149;--unk:#6e7681;--info:#58a6ff;',
    '  --pbg:rgba(13,16,21,.78);--pline:rgba(255,255,255,.08);',
    '  --ink1:#e6e9ee; --ink2:#9aa4b1; --ink3:#8a94a1; --ink4:#6b7584;',
    '  --edge:rgba(255,255,255,.10); --line:rgba(255,255,255,.07); --tile-line:rgba(255,255,255,.08); --tile-bg:rgba(255,255,255,.03);',
    '  --accent:#8ab4d8}',
    '.panel{background:var(--pbg)!important;box-shadow:none!important;border-color:var(--pline)!important}',
    '.panel:after,.panel:before{display:none!important}',
    /* the dense F-layout follows the same type rules: sentence case, no tracking, 11 px floor */
    'h3,#np .np-sec h4,.op span,#stat .l,.hosttitle,#flowhd,.np-sub{letter-spacing:0!important;text-transform:none!important}',
    'h3{font-size:12px!important;font-weight:600!important;color:var(--t2)!important}',
    '#clockbar .chip{letter-spacing:0!important;text-transform:none!important;font-size:11px!important}',
    '#title b{font-size:15px!important;letter-spacing:0!important} #title b span{color:inherit!important;text-shadow:none!important}',
    '#stat .l,.op span,#np .np-sec h4,#legend .r,.gpuchip,.np-row,.np-kv,.kv{font-size:11px!important}',

    /* ---------- 2. hero layout ---------- */
    'body.hero #railL,body.hero #railR,body.hero #data,body.hero #chat{display:none!important}',
    'body.hero #stat{display:none!important}',
    'body.hero #st-live{display:none!important}',     /* a broadcast LIVE pill: the header carries time + a stale marker instead */
    '#herotop,#herobot{position:fixed;z-index:7;left:var(--sx);right:var(--sx);display:none;align-items:center;',
    '  pointer-events:none;font:400 12px/20px var(--ui-font);color:var(--t1);letter-spacing:0;font-variant-numeric:tabular-nums}',
    'body.hero #herotop,body.hero #herobot{display:flex}',
    '#herotop{top:calc(var(--sy) - 4px);justify-content:space-between;gap:24px}',
    '#herobot{bottom:calc(var(--sy) - 2px);justify-content:center;gap:22px}',
    /* identity + status */
    '#hbrand{display:flex;align-items:center;gap:14px;white-space:nowrap}',
    '#hbrand .wm{font-size:15px;font-weight:600;color:var(--t1)}',
    '#hbrand .clk{font-size:13px;color:var(--t2)}',
    '#hbrand .si{font-size:12px;color:var(--t2);display:flex;align-items:center;gap:6px}',
    '#hbrand .si b{font-weight:400;color:var(--t1)}',
    '.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--unk);flex:0 0 auto}',
    '.dot.ok{background:var(--ok)} .dot.warn{background:var(--warn)} .dot.bad{background:var(--crit)} .dot.info{background:var(--info)}',
    /* KPIs: label over value, right aligned */
    '#hstats{display:flex;gap:28px;align-items:flex-end}',
    '#hstats div{text-align:right}',
    '#hstats span{display:block;font-size:11px;line-height:14px;color:var(--t3)}',
    '#hstats b{display:block;font-size:15px;line-height:20px;font-weight:500;color:var(--t1)}',
    '#hstats b u{text-decoration:none;font-size:12px;color:var(--t2);font-weight:400}',
    '#hstats b.warn{color:var(--warn)} #hstats b.bad{color:var(--crit)}',
    /* status bar */
    '#herobot div{display:flex;align-items:center;gap:6px;white-space:nowrap;color:var(--t2)}',
    '#herobot b{font-weight:500;color:var(--t1);font-size:13px}',
    '#herobot b.ok{color:var(--t1)} #herobot b.warn{color:var(--warn)} #herobot b.bad{color:var(--crit)}',
    '#herobot i{font-style:normal;color:var(--t3)}',
    'body.hero #cin{bottom:calc(var(--sy) + 40px)!important}',
    /* 2026-10-08 (contracts 8): the scene behind the chrome is bright now (real
       galaxies, not a dark void): the type gets the same backing the scene labels
       have - a tight dark halo, not a glow, not a plate - so it stays legible
       without dimming the scene */
    '#herotop,#herobot,#cin{text-shadow:0 0 2px rgba(2,4,8,.95),0 0 6px rgba(2,4,8,.85),0 0 14px rgba(2,4,8,.55)}',

    /* ---------- 3. panels ---------- */
    '.nbp,body.hero #st-ai,body.hero #st-emby,#h-aud{position:fixed;z-index:8;pointer-events:none;width:280px;box-sizing:border-box;',
    '  font:400 12px/20px var(--ui-font);color:var(--t1);letter-spacing:0;font-variant-numeric:tabular-nums;',
    '  background:var(--pbg);border:1px solid var(--pline);border-radius:6px;padding:8px 12px 6px;transition:opacity .5s ease}',
    '.nbp{display:none} body.hero .nbp{display:block}',
    '.nbp .pt,body.hero #st-ai .h,body.hero #st-emby .h,#h-aud .h{display:flex;justify-content:space-between;align-items:baseline;gap:8px;',
    '  font-size:13px;line-height:20px;font-weight:500;color:var(--t1);letter-spacing:0;text-transform:none;margin:0 0 2px}',
    'body.hero #st-ai .h:after,body.hero #st-emby .h:after,#h-aud .h:after{display:none}',
    'body.hero #st-ai .box,body.hero #st-emby .box{background:none;border:0;box-shadow:none;padding:0}',
    '.nbp .pt span,#h-aud .h i{font-size:11px;font-weight:400;font-style:normal;color:var(--t3)}',
    '.nbp .r{display:flex;justify-content:space-between;gap:12px}',
    '.nbp .r span{color:var(--t2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}',
    '.nbp .r b{font-weight:400;color:var(--t1);white-space:nowrap;text-align:right}',
    '.nbp .r b u{text-decoration:none;color:var(--t2)}',
    '.nbp .r b.bad,.nbp .r span.bad{color:var(--crit)} .nbp .r b.warn,.nbp .r span.warn{color:var(--warn)} .nbp .r b.unk{color:var(--unk)}',
    '.nbp .more{font-size:11px;color:var(--t3)}',
    '.nbp .quiet{color:var(--t2);display:flex;align-items:center;gap:6px}',
    '.nbp .pg{display:flex;gap:4px;justify-content:flex-end;margin-top:2px}',
    '.nbp .pg i{width:4px;height:4px;border-radius:50%;background:rgba(255,255,255,.16)} .nbp .pg i.on{background:var(--t2)}',
    /* showtime's AI and media panels, in the same grammar (their markup is shared with the TV page, so CSS only) */
    'body.hero #st-ai{left:var(--sx);top:31%}',
    'body.hero #st-ai .inst{margin:2px 0 4px}',
    'body.hero #st-ai .row{display:flex;align-items:baseline;gap:8px;white-space:nowrap}',
    'body.hero #st-ai .row b{color:var(--t1);font-weight:500}',
    'body.hero #st-ai .row .g{color:var(--t2);font-size:12px;letter-spacing:0}',
    'body.hero #st-ai .row .r{margin-left:auto;color:var(--t1);font-size:12px}',
    'body.hero #st-ai .bar{height:2px;border-radius:1px;background:rgba(255,255,255,.08);margin:2px 0 3px}',
    'body.hero #st-ai .bar i{background:var(--t2)!important}',
    'body.hero #st-ai .m{font-size:12px;color:var(--t2)} #st-ai .m b{color:var(--t1);font-weight:400}',
    'body.hero #st-ai .m em{color:var(--t3)} #st-ai .m.busy b{background:none;-webkit-background-clip:border-box;color:var(--t1);animation:none}',
    'body.hero #st-ai .m.idle{color:var(--t3)}',
    'body.hero #st-ai .tpu{display:flex;align-items:baseline;gap:8px;margin-top:4px;padding-top:4px;border-top:1px solid var(--pline);font-size:12px}',
    'body.hero #st-ai .tpu{white-space:nowrap;overflow:hidden}',
    'body.hero #st-ai .tpu .chip{font-size:0;letter-spacing:0;padding:0;border:0;color:var(--t2);text-transform:none}',
    'body.hero #st-ai .tpu .chip:after{content:"Detector";font-size:12px}',
    'body.hero #st-ai .tpu span{overflow:hidden;text-overflow:ellipsis}',
    'body.hero #st-ai .tpu b{color:var(--t1);font-weight:400} #st-ai .tpu span{color:var(--t2)}',
    'body.hero #st-emby{left:var(--sx);bottom:calc(var(--sy) + 40px)}',
    'body.hero #st-emby .np{margin-top:2px;padding:0;background:none;border:0;border-radius:0}',
    'body.hero #st-emby .np b{color:var(--t1);font-weight:400;font-size:12px} #st-emby .np span{font-size:12px;color:var(--t2)}',
    'body.hero #st-emby .np span i{color:var(--t1);font-style:normal} #st-emby .np .tag{font-size:11px;letter-spacing:0;border:0;padding:0 0 0 6px;color:var(--t3)}',
    'body.hero #st-emby .idle{font-size:12px;color:var(--t2);margin-top:0} #st-emby .idle b{color:var(--t1);font-weight:400}',
    'body.st-wall #st-ai,body.st-wall #st-emby{opacity:1}',
    /* the operations, alerts and legend panels (this file) */
    '#nbops{left:var(--sx);top:calc(31% + 168px)}',
    '#nbalerts{right:var(--sx);top:calc(29% + 168px)}',
    '#nbalerts .pr span{color:var(--t2);display:flex;align-items:center;min-width:0}',
    '#nbalerts .pr .dot{margin-right:8px;width:6px;height:6px}',
    '#nbalerts .pr em{font-style:normal} #nbalerts .pr .ph{color:var(--t1)} #nbalerts .pr .ps{color:var(--t3);white-space:pre}',
    '#nbalerts .pr b.pn{color:var(--t3);font-size:11px}',
    '#nbalerts .lab{display:inline-block;margin-left:5px;padding:0 3px;font-size:9px;line-height:11px;font-weight:600;letter-spacing:.05em;color:var(--t2);border:1px solid rgba(154,164,177,.5);border-radius:2px;font-style:normal;vertical-align:1px}',
    '#nbkey{right:var(--sx);top:calc(29% + 300px);opacity:0}',
    '#nbkey.on{opacity:1}',
    '#nbkey .k{display:flex;align-items:center;gap:8px;color:var(--t2)}',
    '#nbkey .k em{display:inline-block;width:14px;text-align:center;font-style:normal}',
    '#nbkey .sw{display:inline-block;width:10px;height:10px;border-radius:50%}',
    '#nbkey .ln{display:inline-block;width:14px;height:3px;border-radius:2px}',
    '#nbkey .kinds{display:flex;flex-wrap:wrap;gap:2px 10px;color:var(--t2);font-size:11px;margin-top:2px}',
    '#nbkey .kinds span{display:inline-flex;align-items:center;gap:4px}',
    /* visitors */
    '#h-aud{right:var(--sx);top:29%;display:none}',
    'body.hero #h-aud{display:block}',
    'body.cin-nohud #h-aud,body.cin-nohud .nbp{opacity:0}',
    /* showtime's ops / alert modes: the alerts panel here already lists the
       problems, so its own list stays hidden and nothing moves; the banner
       becomes one quiet red line (alerts are the loudest thing, never loud copy) */
    'body.hero #st-alist{display:none!important}',
    'body.hero #st-alert{font:500 13px/20px var(--ui-font);letter-spacing:0;text-transform:none;color:var(--t1);',
    '  background:var(--pbg);border:1px solid var(--pline);border-radius:6px;padding:4px 12px;box-shadow:none;',
    '  display:flex;align-items:center;gap:8px}',
    'body.hero #st-alert b{font-size:0;margin:0;width:8px;height:8px;border-radius:50%;background:var(--crit);display:inline-block}',
    'body.hero #st-alert .why:first-letter{text-transform:uppercase}',
    /* contracts 9.4: during a travel leg the side panels step back to ~35 % so the
       move reads; they are back before the camera lands (nb-travel drops at 75 % of the leg) */
    'body.hero .nbp,body.hero #h-aud{transition:opacity .6s ease,top .45s ease}',
    'body.hero #st-ai,body.hero #st-emby{transition:opacity .6s ease}',
    'body.hero.nb-travel .nbp,body.hero.nb-travel #h-aud,body.hero.nb-travel #st-ai,body.hero.nb-travel #st-emby{opacity:.35!important}',
    'body.hero.nb-travel #nbkey:not(.on){opacity:0!important}',
    'body[data-doom]:not([data-doom^="phase=off"]) #h-aud,body[data-doom]:not([data-doom^="phase=off"]) .nbp{opacity:0!important}',
    '#h-aud .sp{margin:2px 0 4px}',
    '#h-aud .sp svg{display:block;width:100%;height:22px;overflow:visible}',
    '#h-aud .r{display:flex;justify-content:space-between;gap:12px;border-radius:3px;transition:background .6s ease}',
    '#h-aud .r span{color:var(--t2);white-space:nowrap}',
    '#h-aud .r b{font-weight:400;color:var(--t1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:right;min-width:0}',
    '#h-aud .r b u{text-decoration:none;color:var(--t2)}',
    '#h-aud .r.hit{background:rgba(255,255,255,.06)}',
    '#h-aud .x{font-size:11px;color:var(--t3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    'body.st-night .nbp,body.st-night #h-aud{opacity:.6}',

    /* record-safe (P): the camera thumbnails are the outside of the house */
    'body.privacy #cams img,body.privacy .cam img{filter:blur(16px) saturate(.5)}',
    'body.privacy #cams .cam:after{content:"Hidden";position:absolute;inset:0;',
    '  display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--t2)}',
    'body.privacy #hbrand:after{content:"Recording-safe";font-size:11px;color:var(--warn);border:1px solid rgba(210,153,34,.5);border-radius:3px;padding:0 6px}',
    '@media (max-width:1599px){ #hstats{gap:18px} #herobot{gap:16px} }'
  ].join('\n');

  function el(id) { return document.getElementById(id); }
  function txt(id) { var e = el(id); return e ? (e.textContent || '').trim() : ''; }
  function esc(x) { return String(x == null ? '' : x).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function n3(v) { v = +v; return !isFinite(v) ? '–' : Math.abs(v) >= 100 ? Math.round(v) + '' : Math.abs(v) >= 10 ? v.toFixed(1).replace(/\.0$/, '') : v.toFixed(2).replace(/\.?0+$/, ''); }
  function row(label, value, cls, lcls) {
    return '<div class="r"><span' + (lcls ? ' class="' + lcls + '"' : '') + '>' + label + '</span><b' + (cls ? ' class="' + cls + '"' : '') + '>' + value + '</b></div>';
  }
  function ago(s) { s = Math.max(0, +s || 0); return s < 90 ? Math.round(s) + ' s' : s < 5400 ? Math.round(s / 60) + ' min' : s < 172800 ? Math.round(s / 3600) + ' h' : Math.round(s / 86400) + ' d'; }

  function mount() {
    if (H.top) return;
    var st = document.createElement('style');
    st.id = 'hero-css'; st.textContent = CSS;
    document.head.appendChild(st);

    H.top = document.createElement('div');
    H.top.id = 'herotop';
    H.top.innerHTML =
      '<div id="hbrand"><span class="wm" id="h-wm"></span><span class="clk" id="h-clk">--:--:--</span>' +
      '<span class="si" id="h-wan"></span><span class="si" id="h-cam"></span><span class="si" id="h-cf"></span>' +
      '<span class="si" id="h-age"></span></div><div id="hstats"></div>';
    document.body.appendChild(H.top);

    H.bot = document.createElement('div');
    H.bot.id = 'herobot';
    document.body.appendChild(H.bot);
    brandMark();
    audMount();
    OPS.el = document.createElement('div'); OPS.el.id = 'nbops'; OPS.el.className = 'nbp'; document.body.appendChild(OPS.el);
    ALR.el = document.createElement('div'); ALR.el.id = 'nbalerts'; ALR.el.className = 'nbp'; document.body.appendChild(ALR.el);
    KEY.el = document.createElement('div'); KEY.el.id = 'nbkey'; KEY.el.className = 'nbp'; document.body.appendChild(KEY.el);
    keyRender();
  }

  /* The headline numbers already exist and are kept current by the page's own
     pollers (index.html #stat); mirroring their text is cheaper and far less
     brittle than re-deriving them. Fewer of them: guests running / total,
     clients, network devices up, GPU, add-on panels. */
  /* the wordmark is CONFIG.brand, plain (sentence case is the product look) */
  function brandMark() {
    var e = el('h-wm'); if (!e) return;
    var C = window.CONFIG;
    e.textContent = (C && C.brand) ? String(C.brand) : 'Galaxy';
  }
  window.addEventListener('galaxy:config', brandMark);
  /* a public host relative to the configured domain: 'media.example.com' -> 'media' */
  function siteHost(h) {
    h = String(h || ''); var dom = String(((window.CONFIG || {}).domain) || '').toLowerCase();
    if (dom && h.toLowerCase() === dom) return h;
    if (dom && h.toLowerCase().slice(-(dom.length + 1)) === '.' + dom) return h.slice(0, -(dom.length + 1));
    return h;
  }
  function kpi(label, value, cls) { return '<div><span>' + label + '</span><b' + (cls ? ' class="' + cls + '"' : '') + '>' + value + '</b></div>'; }
  function clsOf(id) { var e = el(id); return !e ? '' : e.className.indexOf('bad') >= 0 ? 'bad' : e.className.indexOf('warn') >= 0 ? 'warn' : ''; }
  function mirror() {
    if (!H.top) return;
    var c = el('h-clk'); if (c) c.textContent = txt('clk') || '--:--:--';
    var d = window.NB_ALL || {}, u = d.unifi || {};
    var w = el('h-wan');
    if (w) {
      var ok = u.wan_up === 'ok';
      w.innerHTML = u.wan_up ? '<i class="dot ' + (ok ? 'ok' : 'bad') + '"></i>WAN ' + (ok ? 'up' : esc(u.wan_up)) + (u.latency != null ? ' <b>' + esc(u.latency) + ' ms</b>' : '') : '';
    }
    var cm = el('h-cam');
    if (cm) { var nc = (d.cameras || []).length; cm.innerHTML = d.cameras && (((window.CONFIG || {}).features) || {}).cameras ? '<i class="dot ' + (nc ? 'ok' : 'bad') + '"></i><b>' + nc + '</b> cameras' : ''; }
    var cf = el('h-cf'), e = d.edge || {}, cfd = e.cloudflare || {};
    if (cf) cf.innerHTML = cfd.up ? 'Cloudflare <b>' + (cfd.ha_connections != null ? cfd.ha_connections : '?') + '</b> conn · <b>' + Math.round(cfd.req_per_min || 0) + '</b> req/min' : '';
    /* stale marker instead of a LIVE pill: only when the data really is old */
    var ag = el('h-age');
    if (ag) { var a = d.ts_age; ag.innerHTML = a != null && a > 30 ? '<i class="dot ' + (a > 120 ? 'bad' : 'warn') + '"></i>Data ' + ago(a) + ' old' : ''; }

    var host = el('hstats'); if (!host) return;
    var run = txt('s-run'), tot = txt('s-tot');
    var html = kpi('Guests running', esc(run) + ' <u>/ ' + esc(tot) + '</u>') + kpi('Clients', esc(txt('s-cli'))) +
               kpi('Network devices up', esc(txt('s-net')).replace('/', ' <u>/</u> '), clsOf('s-net')) +
               kpi('GPU', esc(txt('s-gpu')).replace('%', ' <u>%</u>')) + kpi('Add-ons', esc(txt('s-addons')));
    if (html !== H.last) { host.innerHTML = html; H.last = html; }
  }

  /* Status bar: the estate-wide vitals, from the payload the page already
     fetched. Wrapping renderNewPanels means zero extra requests. */
  // poll_pve runs every 6 s, so this is several consecutive failures, not a blip
  var STALE_S = 30, STALE_BAD_S = 120;
  var ZSEV = function (s) { return s >= 4 ? 'bad' : s >= 2 ? 'warn' : ''; };
  function vitals(d) {
    if (!H.bot || !d) return;
    var z = d.zabbix || {}, u = d.unifi || {};
    var nodes = ((d.topology || {}).nodes) || [];
    var rtts = [], lossy = 0, down = 0, disc = 0, stp = 0;
    for (var i = 0; i < nodes.length; i++) {
      var m = nodes[i].meta || {};
      if (m.rtt != null) rtts.push(m.rtt);
      if (m.loss) lossy++;
      if (m.discovered) disc++;
      if (nodes[i].status === 'down') {
        /* a powered-off guest or a device gone for days is not an outage (registry
           down_why, 2026-10-09); without the field every down node counts */
        var ub = window.NETSCENE && NETSCENE.U && NETSCENE.U.byTopo ? NETSCENE.U.byTopo[nodes[i].id] : null, why = ub && ub.down_why;
        if (why === 'stopped') stp++; else if (why !== 'gone') down++;
      }
    }
    rtts.sort(function (a, b) { return a - b; });
    var med = rtts.length ? rtts[(rtts.length - 1) >> 1] : null;
    function cell(label, value, cls, sub) {
      return '<div>' + (label ? label + ' ' : '') + '<b' + (cls ? ' class="' + cls + '"' : '') + '>' + value + '</b>' + (sub ? ' <i>' + sub + '</i>' : '') + '</div>';
    }
    /* the same problem vocabulary as the panel (contracts 9.3): hosts with a
       problem, red only when one is a real outage, calm when there are none */
    var P = problems(), nreal = P.crit + P.warn, h = '';
    h += nreal ? '<div><i class="dot ' + (P.crit ? 'bad' : 'warn') + '"></i><b class="' + (P.crit ? 'bad' : 'warn') + '">' + nreal + '</b> ' + (nreal === 1 ? 'problem' : 'problems') + (P.crit ? ' <i>' + P.crit + ' critical</i>' : '') + '</div>'
               : '<div><i class="dot ok"></i>All systems normal</div>';
    h += cell('WAN', (u.rx != null ? u.rx : '–') + ' / ' + (u.tx != null ? u.tx : '–'), '', 'Mb/s');
    if (med != null) h += cell('Latency', n3(med), med > 60 ? 'bad' : med > 15 ? 'warn' : '', 'ms' + (lossy ? ' · loss on ' + lossy + ' hosts' : ''));
    h += cell('Devices', nodes.length, '', (down ? down + ' down' : 'all up') + (stp ? ' · ' + stp + ' stopped' : '') + (disc ? ' · ' + disc + ' new' : ''));
    var e = d.edge || {}, th = e.threats || {}, cs = e.crowdsec || {};
    if (th.up) {
      var tc = th.counts || {}, lvl = Math.max(0, Math.min(3, +th.level || 0));
      var lname = ['low', 'elevated', 'high', 'critical'][lvl];
      /* a threat level is not an outage: amber at most (contracts 9.3), one short fact */
      var secA = window.NETSCENE && NETSCENE.aspectOf ? NETSCENE.aspectOf('asp:security') : null, bnd = null;
      ((secA && secA.facts) || []).forEach(function (f) { if (f && /^banned/i.test(String(f.k))) bnd = f.v; });
      h += '<div>Threat level <b class="' + (lvl >= 1 ? 'warn' : '') + '">' + lname + '</b> <i>' + esc(bnd != null ? bnd : (tc.banned || 0)) + ' banned</i></div>';
    } else if (cs.up) h += cell('CrowdSec', (cs.alerts_24h || 0), (cs.alerts_1h || 0) > 0 ? 'warn' : '', 'attacks / 24 h · ' + (cs.banned || 0) + ' banned');
    var age = d.ts_age;
    if (age != null && age > STALE_S) h += cell('Data', ago(age), age > STALE_BAD_S ? 'bad' : 'warn', d.ts_err || 'old');
    H.bot.innerHTML = h;
    opsData(d);
    alertsRender();
  }

  /* ---------------- operations: one panel, rotating pages ----------------
     Everything the dense F-layout's rails show, one subject at a time, 3-5 rows
     a page, a page every 10 s. A source that errored reads "unknown", never a
     red zero (the backups block reports 0 archives / 96 missing while PBS has
     102 guests: that is a broken feed, not a disaster). */
  var OPS = { el: null, d: null, page: 0, at: 0, gpu: null, html: '' };
  function opsData(d) { OPS.d = d; opsRender(); }
  function fetchGpu() {
    fetch('/api/gpu', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j) OPS.gpu = j.gpus || []; }).catch(function () { });
  }
  /* backups (2026-10-08 backend: pbs_exporter). Three honest states, all calm:
     {unknown:true} -> "unknown"; {stale:true, age_s} -> the last good numbers,
     marked with their age; otherwise backed / guests, missing, older than 7 d,
     and storage errors as a separate quiet row. */
  function backupsRows(d) {
    var b = d.backups || {}, out = [];
    if (b.unknown || b.error || (b.guests == null && b.backed == null)) { out.push(row('Backups', 'unknown', 'unk')); return out; }
    var miss = +b.missing || 0, st7 = +b.stale7 || 0, sub = [];
    if (miss) sub.push(miss + ' <u>missing</u>');
    if (st7) sub.push(st7 + ' <u>&gt; 7 d old</u>');
    out.push(row('Backups', (b.backed != null ? b.backed : '–') + ' <u>/ ' + (b.guests != null ? b.guests : '–') + ' guests</u>', miss ? 'warn' : ''));
    if (sub.length) out.push(row('Needs attention', sub.join(' · '), 'warn'));
    /* the most recent backup job (backups.runs[], 2026-10-09): "05:00 · 17/17 ok";
       a running job shows its progress, a partial one is amber, a failed one red */
    var runs = (b.runs || []).filter(function (r) { return r && r.start; });
    if (runs.length) {
      var lr = runs.slice().sort(function (x, y) { return (+y.start || 0) - (+x.start || 0); })[0];
      var dt = new Date(+lr.start * 1000), hm = ('0' + dt.getHours()).slice(-2) + ':' + ('0' + dt.getMinutes()).slice(-2);
      var stt = String(lr.state || ''), gn = lr.guests != null ? +lr.guests : null, okN = lr.ok != null ? +lr.ok : null;
      var frac = okN != null && gn != null ? okN + '/' + gn : '';
      var txtR = stt === 'running' ? 'running' + (frac ? ' · ' + frac + ' <u>done</u>' : '')
               : stt === 'failed' ? (frac ? frac + ' <u>ok</u> · ' : '') + 'failed'
               : (frac ? frac + ' <u>' + (stt === 'partial' ? 'ok · partial' : 'ok') + '</u>' : esc(stt || 'done'));
      out.push(row('Last backup', hm + ' · ' + txtR, stt === 'failed' ? 'bad' : stt === 'partial' ? 'warn' : ''));
    }
    var se = (b.storage_errors || []).length;
    if (se) out.push(row('Backup storage', se + ' <u>error' + (se === 1 ? '' : 's') + '</u>', 'warn'));
    if (b.stale) out.push(row('Backup data', 'as of ' + ago(b.age_s) + ' ago', 'unk'));
    return out;
  }
  function opsPages(d) {
    var P = [];
    /* compute */
    var c = [];
    (d.nodes2 || []).forEach(function (n) {
      var cls = n.cpu >= 85 || n.mem_pct >= 92 ? 'bad' : n.cpu >= 60 || n.mem_pct >= 80 ? 'warn' : '';
      c.push(row(esc(n.node), 'CPU ' + n3(n.cpu) + ' <u>%</u> · RAM ' + n3(n.mem_pct) + ' <u>%</u>', cls));
    });
    (OPS.gpu || []).slice(0, 3).forEach(function (g) {
      var nm = String(g.name || 'GPU').replace(/^NVIDIA GeForce /, '').replace(/^NVIDIA /, '');
      c.push(row(esc(nm), n3(g.util) + ' <u>%</u> · ' + n3(g.temp) + ' <u>°C</u>', g.temp >= 83 ? 'bad' : g.temp >= 75 ? 'warn' : ''));
    });
    if (c.length) P.push({ t: 'Compute', rows: c.slice(0, 5) });
    /* storage + backups */
    var s = [];
    (d.zfs || []).slice(0, 3).forEach(function (p) {
      s.push(row(esc(p.name), esc(String(p.state || '').toLowerCase()) + ' · ' + n3(p.cap) + ' <u>% used</u>', p.bad ? 'bad' : p.cap >= 90 ? 'bad' : p.cap >= 80 ? 'warn' : ''));
    });
    backupsRows(d).forEach(function (r) { s.push(r); });
    if (d.telemetry && d.telemetry.pbs_used_pct != null && s.length < 5) s.push(row('Backup store', n3(d.telemetry.pbs_used_pct) + ' <u>% used</u>'));
    if (s.length) P.push({ t: 'Storage', rows: s.slice(0, 5) });
    /* services: checks, certificates, latency */
    var v = [], hl = d.health || [], up = hl.filter(function (x) { return x.up; }).length;
    if (hl.length) v.push(row('Service checks', up + ' <u>/ ' + hl.length + ' up</u>', up < hl.length ? 'bad' : ''));
    var hs = (d.certs && d.certs.hosts) || [];
    if (hs.length) {
      var near = hs.filter(function (x) { return x.days != null; }).sort(function (a, b) { return a.days - b.days; })[0];
      var bad = hs.filter(function (x) { return x.state !== 'ok'; }).length;
      v.push(row('TLS certificates', hs.length + ' <u>ok</u>' + (near ? ' · next ' + Math.floor(near.days) + ' <u>d</u>' : ''), bad ? 'warn' : ''));
    }
    var lat = (d.latency || []).filter(function (x) { return x; });
    if (lat.length) {
      var dn = lat.filter(function (x) { return !x.up; }).length, worst = lat.slice().sort(function (a, b) { return (b.last || 0) - (a.last || 0); })[0];
      v.push(row('Synthetic checks', (lat.length - dn) + ' <u>/ ' + lat.length + ' up</u>', dn ? 'bad' : ''));
      if (worst) v.push(row('Slowest', esc(worst.name) + ' · ' + n3(worst.last) + ' <u>ms</u>', worst.last > 1500 ? 'bad' : worst.last > 400 ? 'warn' : ''));
    }
    if (v.length) P.push({ t: 'Services', rows: v.slice(0, 5) });
    /* cameras */
    var f = d.frigate || {}, k = [];
    if (f.up !== undefined) {
      k.push(row('Frigate', f.up ? 'up' : 'down', f.up ? '' : 'bad'));
      var cams = f.cams || [], slow = cams.filter(function (x) { return x.fps < 1 || x.skip > 1; }).length;
      if (cams.length) k.push(row('Cameras', cams.length + ' <u>recording</u>' + (slow ? ' · ' + slow + ' <u>degraded</u>' : ''), slow ? 'warn' : ''));
      var dm = f.det_ms ? Object.keys(f.det_ms).map(function (x) { return f.det_ms[x]; })[0] : null;
      if (dm != null) k.push(row('Detection', n3(dm) + ' <u>ms</u>'));
      if (f.rec) k.push(row('Recordings', n3(f.rec.pct) + ' <u>% used</u>' + (f.rec.est_days != null ? ' · ~' + Math.round(f.rec.est_days) + ' <u>d</u>' : ''), f.rec.pct >= 92 ? 'bad' : f.rec.pct >= 80 ? 'warn' : ''));
      P.push({ t: 'Cameras', rows: k.slice(0, 5) });
    }
    /* network */
    var u = d.unifi || {}, nm = d.netmap || {}, nr = [];
    if (u.clients != null) nr.push(row('Clients', u.clients + (u.wifi != null ? ' <u>· ' + u.wifi + ' Wi-Fi</u>' : '')));
    if (nm.total) nr.push(row('SNMP devices', nm.up + ' <u>/ ' + nm.total + ' up</u>', nm.up / Math.max(1, nm.total) < 0.7 ? 'bad' : nm.up < nm.total ? 'warn' : ''));
    var cs = (d.edge || {}).crowdsec || {};
    /* /api/tour's security aspect carries the true counts (Prometheus); CrowdSec's
       own export (edge.crowdsec) can read a false 0, so it is only the fallback */
    var sec = window.NETSCENE && NETSCENE.aspectOf ? NETSCENE.aspectOf('asp:security') : null, sf = {};
    ((sec && sec.facts) || []).forEach(function (f) { if (f && f.k) sf[String(f.k).toLowerCase()] = f; });
    var fa = sf['attacks 24h'], fb = sf['banned ips'];
    if (fa || fb) nr.push(row('Attacks blocked', (fa ? esc(fa.v) : '–') + ' <u>/ 24 h · ' + (fb ? esc(fb.v) : '–') + ' banned</u>'));
    else if (cs.up) nr.push(row('Attacks blocked', (cs.alerts_24h || 0) + ' <u>/ 24 h · ' + (cs.banned || 0) + ' banned</u>'));
    if (nr.length) P.push({ t: 'Network', rows: nr.slice(0, 5) });
    return P;
  }
  function opsRender() {
    if (!OPS.el || !OPS.d) return;
    var P = opsPages(OPS.d); if (!P.length) { OPS.el.style.display = 'none'; return; }
    OPS.el.style.display = '';
    var now = Date.now();
    if (now - OPS.at > 10000) { OPS.at = now; OPS.page = (OPS.page + 1) % P.length; }
    var p = P[OPS.page % P.length], dots = '';
    for (var i = 0; i < P.length; i++) dots += '<i' + (i === OPS.page % P.length ? ' class="on"' : '') + '></i>';
    var h = '<div class="pt">' + p.t + '<span>Operations</span></div>' + p.rows.join('') + '<div class="pg">' + dots + '</div>';
    if (h !== OPS.html) { OPS.html = h; fadeSwap(OPS.el, h, p.t + '#' + p.rows.length); }
  }

  /* the panels of a column sit one under the other with a 12 px gap,
     measured (their heights follow their content) */
  function stack() {
    if (H.mode !== 'hero') return;
    function under(id, prevId) {
      var a = el(prevId), b = el(id); if (!a || !b) return;
      var r = a.getBoundingClientRect(); if (!r.height) return;
      var top = Math.round(r.bottom + 12) + 'px'; if (b.style.top !== top) b.style.top = top;
    }
    under('nbops', 'st-ai'); under('nbalerts', 'h-aud'); under('nbkey', 'nbalerts');
  }
  /* ---------------- problems: one vocabulary (contracts 9.3) ----------------
     "<short host> · <short problem>", grouped by host (worst kept), red only for
     a real outage (Zabbix sev >= 4 or a body down_why=offline, never on lab gear,
     never for a stopped or retired guest), amber for warnings, grey for
     informational and lab items. /api/tour's `problems` (already normalised by
     the backend) wins when present; otherwise window.ALERTS is normalised here
     with the same rules. window.NB_PROBLEMS() is the one source for the panel,
     the status bar and the alert-mode banner. */
  function normKey(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, ''); }
  function bodyIndex() {
    var U = window.NETSCENE && NETSCENE.U, bs = (U && U.bodies) || [];
    if (PRB.bsRef === bs && PRB.bidx) return PRB.bidx;
    var o = {};
    bs.forEach(function (b) {
      [b.label, b.short, String(b.id || '').split(':').pop()].forEach(function (x) { var k = normKey(x); if (k && !o[k]) o[k] = b; });
    });
    PRB.bsRef = bs; PRB.bidx = o;
    return o;
  }
  var HOST_ALIAS = {};   // operator overrides belong in the registry (universe_names.json), not here
  function shortHost(h, b) {
    if (b && b.short) return String(b.short);
    var s = String(h || '').trim(), k = s.toLowerCase();
    if (HOST_ALIAS[k]) return HOST_ALIAS[k];
    if (window.NETSCENE && NETSCENE.shortName) { var t = NETSCENE.shortName(s.replace(/[-_]+/g, ' ')); if (t && t !== s.replace(/[-_]+/g, ' ')) return t; }
    s = s.replace(/^lab[-_]/i, '');
    if (s.length > 15) s = s.slice(0, 14) + '…';
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  /* Zabbix template names -> a few plain words. Order matters: specific first. */
  var PRB_RULES = [
    [/unreachable|unavailable by icmp|not available|no data/i, 'unreachable'],
    [/high icmp ping response|ping response time/i, 'slow ping'],
    [/icmp.*loss|packet loss/i, 'packet loss'],
    [/port (\d+) not responding/i, 'port $1 down'],
    [/(smtp|imap|ldap|dns|http|https|ssh|radius)\b.*(down|not responding|failed)/i, '$1 down'],
    [/service down \(0\)/i, 'no response'],
    [/service down \((\d+)\)/i, 'HTTP $1'],
    [/system status is in critical/i, 'status critical'],
    [/system status is in warning/i, 'status warning'],
    [/high cpu|cpu utili[sz]ation/i, 'high CPU'],
    [/high memory|memory utili[sz]ation|lack of available memory/i, 'high memory'],
    [/swap/i, 'high swap'],
    [/disk space|free (disk )?space|filesystem.*(full|space)/i, 'low disk space'],
    [/too many processes/i, 'too many processes'],
    [/link down/i, 'link down'],
    [/crc errors/i, 'CRC errors'],
    [/optical rx low|rx power/i, 'optical power low'],
    [/certificate|ssl|tls/i, 'certificate expiring'],
    [/has been restarted|uptime/i, 'restarted'],
    [/not running/i, 'guest stopped'],
    [/temperature|overheat/i, 'temperature high']
  ];
  function shortProblem(name, host) {
    var s = String(name || '').trim();
    for (var i = 0; i < PRB_RULES.length; i++) {
      var m = PRB_RULES[i][0].exec(s);
      if (m) return PRB_RULES[i][1].replace('$1', m[1] || '').replace(/^(smtp|imap|ldap|dns|http|https|ssh|radius)/i, function (x) { return x.toUpperCase(); });
    }
    s = s.replace(/\s*\((CT|VM|LXC|lxc|qemu)[\s/]*\d+\)/g, '').replace(/\s*\([^)]*\)\s*$/, '').replace(/\[[^\]]*\]/g, '')
         .replace(/^(DEMO|Linux|Proxmox|ICMP|Interface [^:]*|[A-Za-z][\w .-]{0,24}):\s*/, '');
    if (host) s = s.replace(new RegExp('\\s+on\\s+' + String(host).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b.*$', 'i'), '');
    s = s.replace(/\s+/g, ' ').trim();
    if (s.length > 26) s = s.slice(0, 25).replace(/\s+\S*$/, '') + '…';
    return s ? s.charAt(0).toLowerCase() + s.slice(1) : 'problem';
  }
  var PRB = { bsRef: null, bidx: null };
  /* a problem about a stopped guest ("not running") is not a fault to show */
  function ignorable(name) { return /not running/i.test(name); }
  function sevCls(v) {
    if (typeof v === 'number') return v >= 4 ? 'crit' : v >= 2 ? 'warn' : 'info';
    v = String(v || '').toLowerCase();
    return v.indexOf('crit') === 0 || v === 'bad' || v === 'high' || v === 'disaster' ? 'crit' : v.indexOf('warn') === 0 || v === 'average' ? 'warn' : 'info';
  }
  function problems() {
    var rows = [];
    var TD = window.NETSCENE && NETSCENE.tourData, tp = TD && Array.isArray(TD.problems) ? TD.problems : null;
    if (tp) {
      tp.forEach(function (p) {
        if (!p || !p.host) return;
        var lab = !!p.lab, s = sevCls(p.sev);
        if (lab) s = 'info';
        var hn = String(p.host);
        rows.push({ host: hn.charAt(0).toUpperCase() + hn.slice(1), text: String(p.text || ''), sev: s, lab: lab, n: +p.n || 1 });
      });
    } else {
      var A = window.ALERTS || {}, BI = bodyIndex(), LAB = labNames();
      Object.keys(A).forEach(function (h) {
        var v = A[h] || {}, b = BI[normKey(h)] || null, names = (v.names || []).map(String);
        var lab = !!v.lab || !!(b && b.lab) || !!LAB[String(h).toLowerCase()] || /^(lab|demo)[-_]/i.test(h) || names.some(function (x) { return /\(synthetic\)|^DEMO:/i.test(x); });
        var real = names.filter(function (x) { return !ignorable(x); });
        var s = sevCls(+v.sev || 0);
        var gone = b && b.status === 'down' && (b.down_why === 'stopped' || b.down_why === 'gone');
        /* only "not running" items for stopped guests: informational */
        if (!real.length && names.length) s = 'info';
        if (lab || gone) s = s === 'crit' ? 'warn' : s;
        if (lab) s = 'info';
        if (b && b.status === 'down' && b.down_why === 'offline' && !lab) s = 'crit';
        var pick = real[0] || names[0] || '';
        rows.push({ host: shortHost(h, b), text: shortProblem(pick, h), sev: s, lab: lab, n: +v.n || names.length || 1 });
      });
    }
    /* group by host, keep the worst */
    var RK = { crit: 0, warn: 1, info: 2 }, by = {};
    rows.forEach(function (r) {
      var k = r.host.toLowerCase(), o = by[k];
      if (!o || RK[r.sev] < RK[o.sev]) { if (o) r.n += o.n; by[k] = r; } else o.n += r.n;
    });
    var out = Object.keys(by).map(function (k) { return by[k]; });
    out.sort(function (a, b) { return (RK[a.sev] - RK[b.sev]) || (a.lab - b.lab) || (b.n - a.n) || (a.host < b.host ? -1 : 1); });
    var c = { crit: 0, warn: 0, info: 0 };
    out.forEach(function (r) { c[r.sev]++; });
    return { rows: out, crit: c.crit, warn: c.warn, info: c.info, src: tp ? 'tour' : 'zabbix' };
  }
  window.NB_PROBLEMS = problems;

  /* a content change fades out, swaps, fades back in (contracts 9.4: nothing pops) */
  function fadeSwap(node, html, sk) {
    if (!node) return;
    if (node._fs === html) return;
    var first = node._fs === undefined, same = sk !== undefined && sk === node._fsk;
    node._fs = html; node._fsk = sk;
    /* same structure (a number moved): in place, no fade; a fade already
       running picks the new html up when it swaps */
    if (first || (same && !node._fsT)) { node.innerHTML = html; return; }
    if (node._fsT) return;
    node.style.transition = 'opacity .26s ease,top .45s ease';
    node.style.opacity = '0';
    node._fsT = setTimeout(function () { node._fsT = 0; node.innerHTML = node._fs; node.style.opacity = ''; }, 270);
  }

  /* ---------------- alerts: never rotates; quiet when clear ---------------- */
  var ALR = { el: null, html: '' };
  function alertsRender() {
    if (!ALR.el) return;
    var P = problems(), real = P.rows.filter(function (r) { return r.sev !== 'info'; });
    var h = '<div class="pt">Problems<span>' + (real.length ? real.length + (real.length === 1 ? ' host' : ' hosts') : (P.src === 'tour' ? 'Estate' : 'Zabbix')) + '</span></div>';
    if (!real.length) {
      h += '<div class="quiet"><i class="dot ok"></i>All systems normal</div>';
      if (P.info) h += '<div class="more">' + P.info + (P.info === 1 ? ' informational item' : ' informational items') + '</div>';
    } else {
      real.slice(0, 3).forEach(function (r) {
        var c = r.sev === 'crit' ? 'bad' : 'warn';
        h += '<div class="r pr"><span><i class="dot ' + c + '"></i><em class="ph">' + esc(r.host) + '</em><em class="ps"> · </em>' + esc(r.text) + '</span>' +
             (r.n > 1 ? '<b class="pn">+' + (r.n - 1) + '</b>' : '') + '</div>';
      });
      var more = real.length - Math.min(3, real.length);
      if (more > 0) h += '<div class="more">+' + more + ' more</div>';
    }
    fadeSwap(ALR.el, h, real.slice(0, 3).map(function (r) { return r.host + r.text + r.sev; }).join('|') + '#' + (real.length ? 1 : 0));
  }

  function labNames() {
    var U = window.NETSCENE && NETSCENE.U, o = {};
    ((U && U.bodies) || []).forEach(function (b) { if (b.lab) { [b.label, b.short].forEach(function (x) { if (x) o[String(x).toLowerCase()] = 1; }); } });
    return o;
  }
  /* ---------------- legend: at the overview, quietly ---------------- */
  var KEY = { el: null, on: false };
  function keyRender() {
    if (!KEY.el) return;
    var T = window.NETTRAFFIC, K = T && T.kinds ? T.kinds : { lan: '#7fb4d8', storage: '#6fc7a5', backup: '#a99ad6', wan: '#d9a866', vpn: '#d98f96', media: '#cf8fbf' };
    var kinds = ['lan', 'storage', 'backup', 'wan', 'vpn', 'media'].map(function (k) {
      return '<span><i class="ln" style="background:' + K[k] + '"></i>' + ({ lan: 'LAN', storage: 'Storage', backup: 'Backup', wan: 'Internet', vpn: 'VPN', media: 'Media' }[k]) + '</span>';
    }).join('');
    KEY.el.innerHTML = '<div class="pt">Legend</div>' +
      '<div class="k"><em><i class="sw" style="background:#f2d27a;box-shadow:0 0 6px rgba(242,210,122,.6)"></i></em>Star · gateway, switch or host</div>' +
      '<div class="k"><em><i class="sw" style="background:#7d9fc2"></i></em>Planet · virtual machine</div>' +
      '<div class="k"><em><i class="sw" style="background:#7fb9a8;width:7px;height:7px"></i></em>Moon · container or device</div>' +
      '<div class="k"><em><i class="ln" style="background:#c9d1dc"></i></em>Traffic · width follows the rate</div>' +
      '<div class="kinds">' + kinds + '</div>';
  }
  function keyTick() {
    if (!KEY.el) return;
    var NS = window.NETSCENE, TR = NS && NS.tour, on = false;
    if (TR && TR.stops && TR.stops.length && !TR.manual) {
      var st = TR.stops[TR.idx];
      on = TR.phase === 'hold' && st && !st.list && (NS.t - TR.tHold) > 0.8;
    }
    if (on !== KEY.on) { KEY.on = on; KEY.el.classList.toggle('on', on); if (on) keyRender(); }
  }

  /* ---------------- visitors (v8 data, product layout) ----------------
     Who is on the public sites right now. Every number is a real unique human
     visitor from edge.audience (origin log: real client IP + country; monitors
     and bots excluded upstream and reported as excluded).
     Nothing from the tunnel's request counters is ever called a visitor. */
  var AUD = { el: null, hist: [], last5: null, newAt: 0, newTxt: '', html: '' };
  var HIST_KEY = 'galaxy.aud.hist', HIST_MIN = 60;   // one bucket per minute, an hour deep

  function audMount() {
    if (AUD.el) return;
    if (!(((window.CONFIG || {}).features) || {}).audience) return;
    AUD.el = document.createElement('div'); AUD.el.id = 'h-aud';
    AUD.el.innerHTML = '<div class="h">Website visitors<i>live</i></div><div class="box"></div>';
    document.body.appendChild(AUD.el);
    try {
      var raw = JSON.parse(localStorage.getItem(HIST_KEY) || '[]');
      if (Array.isArray(raw)) AUD.hist = raw.filter(function (p) { return Array.isArray(p) && p.length === 2 && isFinite(p[0]) && isFinite(p[1]); });
    } catch (e) { AUD.hist = []; }
    window.addEventListener('galaxy:viewer', function (ev) {
      var d = (ev && ev.detail) || {};
      AUD.newAt = Date.now();
      AUD.newTxt = (d.n > 1 ? d.n + ' new visitors' : 'New visitor') + (d.cc ? ' · ' + esc(d.cc) : '')
                 + (d.host ? ' · ' + esc(siteHost(d.host)) : '');
      audRender(true); audPop();
    });
  }
  /* an arrival: the "active now" row lights up briefly (no glow, no scale) */
  function audPop() {
    var r = AUD.el && AUD.el.querySelector('.r.now'); if (!r) return;
    r.classList.remove('hit'); void r.offsetWidth; r.classList.add('hit');
    setTimeout(function () { r.classList.remove('hit'); }, 1600);
  }
  function audTick() { }
  function audSpark(H, mNow, w, h) {
    if (H.length < 2) return '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none"><line x1="0" y1="' + (h - 1) + '" x2="' + w + '" y2="' + (h - 1) + '" stroke="rgba(255,255,255,.14)" stroke-width="1"/></svg>';
    var mx = 1, i; for (i = 0; i < H.length; i++) if (H[i][1] > mx) mx = H[i][1];
    var m0 = mNow - HIST_MIN, pts = '', first = '', lx = 0, ly = 0;
    for (i = 0; i < H.length; i++) {
      var x = Math.max(0, Math.min(w, (H[i][0] - m0) / HIST_MIN * w)), y = (h - 2) - (H[i][1] / mx) * (h - 4);
      x = +x.toFixed(1); y = +y.toFixed(1);
      pts += (pts ? ' ' : '') + x + ',' + y; if (!first) first = x; lx = x; ly = y;
    }
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none">'
      + '<polygon points="' + first + ',' + h + ' ' + pts + ' ' + lx + ',' + h + '" fill="rgba(154,164,177,.10)"/>'
      + '<polyline points="' + pts + '" fill="none" stroke="#9aa4b1" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>'
      + '<circle cx="' + lx + '" cy="' + ly + '" r="2" fill="#e6e9ee" vector-effect="non-scaling-stroke"/></svg>';
  }
  function audience(d) {
    if (!AUD.el || !d) return;
    var e = d.edge || {}; AUD.au = e.audience || {}; AUD.cf = e.cloudflare || {};
    var au = AUD.au;
    if (au.up) {
      var v5 = +au.viewers_5m || 0;
      var ts = +au.ts || (Date.now() / 1000), m = Math.floor(ts / 60), H2 = AUD.hist, L = H2[H2.length - 1];
      if (L && L[0] === m) { if (v5 > L[1]) L[1] = v5; }
      else if (!L || m > L[0]) H2.push([m, v5]);
      while (H2.length && H2[0][0] < m - HIST_MIN) H2.shift();
      try { localStorage.setItem(HIST_KEY, JSON.stringify(H2)); } catch (x) {}
      AUD.up = AUD.last5 !== null && v5 > AUD.last5; AUD.from = AUD.last5;
      AUD.last5 = v5; AUD.m = m;
    } else { AUD.last5 = null; AUD.up = false; }
    audRender(false);
  }
  function audRender(fromEvent) {
    var el2 = AUD.el, au = AUD.au || {}, cf = AUD.cf || {}, h = '', i;
    if (!el2) return;
    var box = el2.querySelector('.box'), hd = el2.querySelector('.h');
    var showNew = AUD.newAt && (Date.now() - AUD.newAt) < 90000;
    if (au.up) {
      var v5 = +au.viewers_5m || 0, v1 = +au.viewers_1h || 0;
      var cs = (au.by_country || []).filter(function (c) { return c && c.cc; }).slice()
        .sort(function (a, b) { return (+b.uniques || 0) - (+a.uniques || 0) || (+b.requests || 0) - (+a.requests || 0); });
      var cc = cs.slice(0, 4).map(function (c) { return esc(c.cc) + ' ' + (+c.uniques || 0); }).join(' · ') + (cs.length > 4 ? ' · +' + (cs.length - 4) : '');
      var hs = (au.by_host || []).filter(function (x) { return x && x.host; }).slice()
        .sort(function (a, b) { return (+b.uniques || 0) - (+a.uniques || 0); }).slice(0, 2)
        .map(function (x) { return esc(siteHost(x.host)) + ' ' + (+x.uniques || 0); }).join(' · ');
      var mon = +au.monitors_1h || 0, bots = +au.bots_1h || 0;
      hd.innerHTML = 'Website visitors<i>' + (showNew ? esc(AUD.newTxt) : 'live') + '</i>';
      if (AUD.hist.length >= 3) h += '<div class="sp">' + audSpark(AUD.hist, AUD.m || Math.floor(Date.now() / 60000), 256, 20) + '</div>';
      h += '<div class="r now"><span>Active now</span><b>' + v5 + ' <u>· 5 min</u></b></div>';
      h += '<div class="r"><span>This hour</span><b>' + v1 + '</b></div>';
      h += '<div class="r"><span>Countries</span><b>' + (cc || '<u>none this hour</u>') + '</b></div>';
      if (hs) h += '<div class="r"><span>Top sites</span><b>' + hs + '</b></div>';
      h += '<div class="x">' + (+au.requests_1h || 0) + ' requests / h · excluded ' + mon + (mon === 1 ? ' monitor' : ' monitors') + ', ' + bots + (bots === 1 ? ' bot' : ' bots') + '</div>';
    } else if (cf.up) {
      hd.innerHTML = 'Website traffic<i>visitor count unavailable</i>';
      h += '<div class="r"><span>Requests</span><b>' + Math.round(+cf.req_per_min || 0) + ' <u>/ min</u></b></div>';
      h += '<div class="r"><span>In flight</span><b>' + (+cf.active_streams || 0) + '</b></div>';
      if ((cf.locations || []).length) h += '<div class="r"><span>Edge</span><b>' + (cf.locations || []).map(function (l) { return esc(String(l).toUpperCase()); }).join(' · ') + '</b></div>';
      h += '<div class="x">Cloudflare tunnel counts requests, not people</div>';
    } else {
      hd.innerHTML = 'Website visitors<i>offline</i>';
      h += '<div class="x">edge telemetry unavailable</div>';
    }
    if (h !== AUD.html) { AUD.html = h; box.innerHTML = h; }
    if (AUD.up && !fromEvent) { AUD.up = false; audPop(); }
  }

  /* ---------------- mode ---------------- */

  function apply(mode, save) {
    H.mode = (mode === 'full') ? 'full' : 'hero';
    document.body.classList.toggle('hero', H.mode === 'hero');
    if (save) { try { localStorage.setItem(KEY, H.mode); } catch (e) {} }
    var f = FRAME[H.mode];
    // netscene may not have booted yet on the first call; it re-reads on rebuild
    if (window.NETSCENE && window.NETSCENE.setFrame) {
      try { window.NETSCENE.setFrame(f); } catch (e) {}
    }
    if (window.NETFLOWS && window.NETFLOWS.setSafe) {
      try { window.NETFLOWS.setSafe(SAFE[H.mode]); } catch (e) {}
    }
    document.body.dataset.layout = H.mode;
  }

  function keys(e) {
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var k = (e.key || '').toLowerCase();
    if (k === 'p') {
      e.preventDefault();
      H.privacy = !H.privacy;
      document.body.classList.toggle('privacy', H.privacy);
      try { localStorage.setItem(PKEY, H.privacy ? '1' : '0'); } catch (er) {}
      document.body.dataset.privacy = H.privacy ? 'on' : 'off';
      return;
    }
    if (k !== 'f') return;
    e.preventDefault();
    apply(H.mode === 'hero' ? 'full' : 'hero', true);
  }

  /* ---------------- boot ---------------- */

  mount();
  var saved = 'hero';
  try { saved = localStorage.getItem(KEY) || 'hero'; } catch (e) {}
  apply(saved, false);
  document.addEventListener('keydown', keys);
  setInterval(mirror, MIRROR_MS);
  mirror();
  setInterval(function () { if (AUD.newAt) { try { audRender(true); } catch (e) {} } }, 5000);
  /* operations pages turn every 10 s; the legend follows the tour; GPU telemetry
     for the compute page (2 small requests a minute) */
  setInterval(function () { try { opsRender(); stack(); } catch (e) {} }, 1000);
  setInterval(function () { try { keyTick(); } catch (e) {} }, 250);
  /* alert mode (showtime.js): its banner speaks the shared problem vocabulary,
     the worst real problem as "<host> · <problem>" (+N more) */
  setInterval(function () {
    try {
      if (!document.body.classList.contains('st-alert')) return;
      var w = document.querySelector('#st-alert .why'); if (!w) return;
      var P = problems(), R = P.rows.filter(function (r) { return r.sev !== 'info'; });
      var t = R.length ? R[0].host + ' · ' + R[0].text + (R.length > 1 ? '  +' + (R.length - 1) + ' more' : '') : 'All systems normal';
      if (w.textContent !== t) w.textContent = t;
      var dot = document.querySelector('#st-alert b'); if (dot) dot.style.background = R.length && R[0].sev === 'crit' ? '' : 'var(--warn)';
    } catch (e) {}
  }, 1000);
  /* travel dimming: on for the first 75 % of a leg, so the panels are fully
     back by the time the camera lands and nothing changes at the arrival */
  var TRV = { on: false };
  setInterval(function () {
    try {
      var NS = window.NETSCENE, TR = NS && NS.tour, on = false;
      if (TR && TR.stops && TR.stops.length && !TR.manual && TR.phase === 'travel' && TR.travelT)
        on = (NS.t - TR.t0) / TR.travelT < 0.75;
      if (on !== TRV.on) { TRV.on = on; document.body.classList.toggle('nb-travel', on); }
    } catch (e) {}
  }, 50);
  fetchGpu(); setInterval(fetchGpu, 15000);
  /* showtime.js's AI panel (markup shared with the TV page): product title */
  (function aiTitle(n) {
    var h = document.querySelector('#st-ai .h');
    if (h) { h.innerHTML = 'AI inference<span style="font-size:11px;font-weight:400;color:var(--t3)">Ollama</span>'; return; }
    if ((n || 0) < 40) setTimeout(function () { aiTitle((n || 0) + 1); }, 500);
  })(0);
  (function mediaTitle(n) {
    var h = document.querySelector('#st-emby .h');
    if (h) { h.innerHTML = 'Media<span style="font-size:11px;font-weight:400;color:var(--t3)">Emby</span>'; return; }
    if ((n || 0) < 40) setTimeout(function () { mediaTitle((n || 0) + 1); }, 500);
  })(0);

  /* zero-touch: wrap the panel renderer to get /api/all for free, exactly the
     way galaxy.js and cinema.js wrap netSceneTick */
  (function wrap() {
    var prev = window.renderNewPanels;
    if (typeof prev !== 'function') { setTimeout(wrap, 300); return; }
    window.renderNewPanels = function (d) {
      if (H.privacy) { try { redact(d, 0); } catch (e) {} }
      try { prev(d); } finally { try { vitals(d); } catch (e) {} try { audience(d); } catch (e) {} }
    };
    /* the first /api/all usually lands before this wrap exists, which left the
       audience panel empty until the NEXT poll, 6 s after the wall was shown */
    if (window.NB_ALL) { try { vitals(window.NB_ALL); } catch (e) {} try { audience(window.NB_ALL); } catch (e) {} }
  })();

  /* netscene boots asynchronously; restate the framing once it exists */
  (function frameWhenReady(n) {
    if (window.NETSCENE && window.NETSCENE.setFrame
        && window.NETFLOWS && window.NETFLOWS.setSafe) { apply(H.mode, false); return; }
    if ((n || 0) > 60) return;
    setTimeout(function () { frameWhenReady((n || 0) + 1); }, 500);
  })(0);

  /* netSceneUpdate is the FIRST consumer of each poll, so redacting there
     covers the 3D scene, the flow arcs and the panels from one place. */
  (function wrapNS() {
    var prev = window.netSceneUpdate;
    if (typeof prev !== 'function') { setTimeout(wrapNS, 300); return; }
    window.netSceneUpdate = function (topo) {
      if (H.privacy) { try { redact(topo, 0); } catch (e) {} }
      return prev(topo);
    };
  })();

  try { H.privacy = localStorage.getItem(PKEY) === '1'; } catch (e) {}
  document.body.classList.toggle('privacy', H.privacy);
  document.body.dataset.privacy = H.privacy ? 'on' : 'off';

  window.HERO = { state: H, set: apply,
                  privacy: function (on) {
                    H.privacy = !!on;
                    document.body.classList.toggle('privacy', H.privacy);
                    document.body.dataset.privacy = H.privacy ? 'on' : 'off';
                  } };
})();
