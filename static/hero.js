/* hero.js — daylight-legible palette + a HERO layout that gives the 3D scene
   the whole wall back.  v7: audience + threats strip cells.
   v8: AUDIENCE panel (#h-aud, right rail of the hero layout) - real unique
   visitors on the public sites from edge.audience (origin log, monitors + bots
   excluded and shown as excluded), with a 60-minute sparkline accumulated from
   the polls the page already makes, per-country chips and the per-host split.
   netscene_exo.js dispatches 'galaxy:viewer' for each real arrival; the panel
   shows it for 90 s. Tunnel request counters are NEVER called viewers: with
   edge.audience down the panel says "requests only" in so many words.
   ---------------------------------------------------------------------------
   Reads:   window.CONFIG  brand (top-bar wordmark), domain (host chips are
                           shown relative to it), features.cameras / .audience
            /api/all       via renderNewPanels: zabbix, unifi, topology.nodes,
                           edge.cloudflare / .crowdsec / .audience / .threats,
                           cameras, ts_age
            the six headline HUD numbers (#s-run …) are MIRRORED, not re-fetched
   ---------------------------------------------------------------------------
   Loads LAST, after cinema.js and doom.js. Self-contained: injects its own CSS
   and DOM, mirrors values out of the existing HUD rather than adding a second
   poll, and touches no other file's logic.

   TWO THINGS, INDEPENDENT

   1 DAYLIGHT PALETTE (always on, both layouts)
     The HUD was tuned against a dark room. In a sunlit room, and worse through
     a phone camera with its own auto-exposure, the translucent panels wash out
     and --ink2/--ink3 body text muddies into the starfield behind them. The
     token overrides here raise panel opacity and push the ink ramp up without
     touching hue, so nothing about the night look changes except that it is
     readable. The 3D scene is deliberately NOT touched: black space is what
     makes the galaxy and the bloom read at all.

   2 HERO LAYOUT (default; press F for the full instrument HUD)
     The dense HUD is genuinely useful at the desk and completely wrong on
     video: it pins the 3D scene into a ~65% x 59% box in the middle of the
     screen, which is why the graph always looked small. Hero mode hides the
     rails and the bottom panels, puts identity + the six headline numbers in
     one slim top bar and the live vitals in one slim bottom strip, and hands
     the rest of the viewport to the scene via NETSCENE.setFrame().

   The layouts are a body class and a setFrame() call, so switching is instant
   and nothing is destroyed. The choice persists in localStorage so the kiosk
   comes back up the way you left it.
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
     router. What IS real is the REMOTE side of live flows: peer addresses you
     connect to, which say who and where you talk to. Those get masked to their
     first two octets. Private space is left completely alone - masking it would
     destroy the dashboard's usefulness for nothing. */
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

  var CSS = [
    /* ---------- 1. daylight palette (applies in BOTH layouts) ---------- */
    ':root{',
    '  --ink1:#f4f9ff; --ink2:#c3d8ee; --ink3:#a2bad2; --ink4:#8ba4bf;',
    '  --edge:rgba(135,175,220,.34);',
    '  --line:rgba(160,190,225,.16);',
    '  --tile-line:rgba(135,175,220,.26);',
    '  --tile-bg:rgba(9,16,30,.72);',
    '}',
    /* more opaque ground: the starfield behind a translucent panel is what
       destroyed contrast in daylight */
    '.panel{background:linear-gradient(180deg,rgba(11,19,34,.94),rgba(7,13,25,.90))!important;',
    '  box-shadow:0 6px 26px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.07)!important}',
    'h3{color:var(--ink2)}',
    '.kv span{color:var(--ink3)}',
    '.kv b{color:var(--ink1)}',

    /* ---------- 2. hero layout ---------- */
    'body.hero #railL,body.hero #railR,body.hero #data,body.hero #chat{display:none!important}',
    'body.hero #stat{display:none!important}',

    '#herotop,#herobot{position:fixed;z-index:7;left:var(--sx);right:var(--sx);',
    '  display:none;align-items:center;pointer-events:none;',
    '  font-variant-numeric:tabular-nums}',
    'body.hero #herotop,body.hero #herobot{display:flex}',
    '#herotop{top:calc(var(--sy) - 6px);justify-content:space-between;gap:24px}',
    '#herobot{bottom:calc(var(--sy) - 4px);justify-content:center;gap:18px}',

    /* identity */
    '#hbrand{display:flex;align-items:baseline;gap:9px;white-space:nowrap}',
    '#hbrand .wm{font-size:22px;font-weight:700;letter-spacing:.6px;color:#fff;',
    '  text-shadow:0 0 22px rgba(90,215,255,.45)}',
    '#hbrand .wm i{font-style:normal;color:var(--accent)}',
    '#hbrand .clk{font-size:15px;color:var(--ink2);letter-spacing:1px}',
    '#hbrand .chip{font-size:10px;letter-spacing:1.1px;color:var(--ink3);',
    '  border:1px solid var(--edge);border-radius:3px;padding:2px 7px;text-transform:uppercase}',
    '#hbrand .chip.ok{color:var(--ok);border-color:rgba(62,207,142,.4)}',
    '#hbrand .chip.bad{color:var(--down);border-color:rgba(255,90,106,.45)}',
    '#hbrand .chip.cf{color:#ffb073;border-color:rgba(246,130,31,.45)}',

    /* headline numbers */
    '#hstats{display:flex;gap:26px;align-items:flex-end}',
    '#hstats div{text-align:center}',
    /* v8: sized for a wall read from across a room (measured at 1920x1080:
       the six headline numbers + the strip still fit on one line each) */
    '#hstats b{display:block;font-size:32px;font-weight:600;color:var(--ink1);line-height:1.05}',
    '#hstats span{font-size:11px;letter-spacing:1.5px;color:var(--ink3);text-transform:uppercase}',
    '#hstats b.warn{color:var(--warn)} #hstats b.bad{color:var(--down)}',

    /* bottom vitals */
    '#herobot div{display:flex;align-items:baseline;gap:7px;white-space:nowrap}',
    '#herobot span{font-size:11px;letter-spacing:1.5px;color:var(--ink3);text-transform:uppercase}',
    '#herobot b{font-size:18px;font-weight:600;color:var(--ink1)}',
    '#herobot b.ok{color:var(--ok)} #herobot b.warn{color:var(--warn)} #herobot b.bad{color:var(--down)}',
    '#herobot i{font-style:normal;color:var(--ink4);font-size:13.5px}',

    /* the tour caption sits above the bottom strip once #data is gone */
    'body.hero #cin{bottom:calc(var(--sy) + 44px)!important}',

    /* record-safe: the camera thumbnails are far more identifying than any IP
       on this screen - they are the outside of the house. Hero mode hides them
       already; this covers the full HUD. */
    'body.privacy #cams img,body.privacy .cam img{filter:blur(16px) saturate(.5)}',
    'body.privacy #cams .cam:after{content:"REDACTED";position:absolute;inset:0;',
    '  display:flex;align-items:center;justify-content:center;font-size:9px;',
    '  letter-spacing:2px;color:var(--ink2)}',
    'body.privacy #hbrand:after{content:"REC-SAFE";font-size:8px;letter-spacing:1.6px;',
    '  color:var(--warn);border:1px solid rgba(255,179,71,.5);border-radius:3px;padding:2px 6px}',

    /* ---------- 3. audience panel (v8) ----------
       Right-rail twin of showtime's AI FABRIC box (same .st grammar: a small
       overline with a hairline, a .62 plate, mono numerals). Gold is the one
       colour reserved for "a real person" here and in the 3D scene. */
    '#h-aud{position:fixed;z-index:8;pointer-events:none;right:calc(var(--sx,112px) - 4px);top:29%;width:360px;display:none;',
    '  font:13px/1.4 ui-monospace,Menlo,Consolas,monospace;color:#dcefff;font-variant-numeric:tabular-nums;letter-spacing:.2px;',
    '  transition:opacity .6s ease}',
    'body.hero #h-aud{display:block}',
    'body.st-ops #h-aud,body.st-alert #h-aud{top:auto;bottom:calc(var(--sy,64px) + 44px)}',
    'body.st-night #h-aud{opacity:.55}',
    'body[data-doom]:not([data-doom^="phase=off"]) #h-aud{opacity:0!important}',
    'body.cin-nohud #h-aud{opacity:0}',
    '#h-aud .h{font-size:10.5px;letter-spacing:1.8px;text-transform:uppercase;color:var(--ink3);margin-bottom:5px;display:flex;align-items:center;gap:8px}',
    '#h-aud .h:after{content:"";flex:1;height:1px;background:linear-gradient(90deg,rgba(125,160,200,.18),transparent)}',
    '#h-aud .h i{font-style:normal;color:#ffd166}',
    '#h-aud.fallback .h i{color:var(--warn)}',
    '#h-aud .box{background:rgba(6,11,22,.62);border:1px solid rgba(125,160,200,.18);border-radius:5px;padding:8px 10px 7px;',
    '  box-shadow:0 8px 28px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.04)}',
    '#h-aud .top{display:flex;align-items:flex-end;gap:10px}',
    '#h-aud .n{font-size:54px;line-height:.95;font-weight:700;color:#ffd166;text-shadow:0 0 26px rgba(255,209,102,.45);min-width:44px;',
    '  transform-origin:left bottom}',
    '#h-aud .n.zero,#h-aud.fallback .n{color:var(--ink2);text-shadow:none}',
    '#h-aud .n.up{animation:h-audpop 1.1s ease-out 1}',
    '@keyframes h-audpop{0%{transform:scale(1);text-shadow:0 0 18px rgba(255,209,102,.35)}',
    '  28%{transform:scale(1.22);text-shadow:0 0 34px rgba(255,209,102,.95),0 0 10px rgba(255,255,255,.7)}',
    '  100%{transform:scale(1);text-shadow:0 0 18px rgba(255,209,102,.35)}}',
    '#h-aud.hit .box{animation:h-audhit 1.6s ease-out 1}',
    '@keyframes h-audhit{0%{border-color:rgba(255,209,102,.75);box-shadow:0 8px 28px rgba(0,0,0,.45),0 0 26px rgba(255,209,102,.28),inset 0 0 18px rgba(255,209,102,.10)}',
    '  100%{border-color:rgba(125,160,200,.18);box-shadow:0 8px 28px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.04)}}',
    '#h-aud .t{flex:1;min-width:0;padding-bottom:1px}',
    '#h-aud .t b{display:block;font-size:14px;letter-spacing:1.5px;text-transform:uppercase;color:#fff;font-weight:700}',
    '#h-aud .t span{display:block;font-size:11px;color:var(--ink3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '#h-aud .hr{text-align:right;padding-bottom:1px;white-space:nowrap}',
    '#h-aud .hr b{display:block;font-size:20px;line-height:1.1;color:var(--ink1);font-weight:600}',
    '#h-aud .hr span{font-size:10px;letter-spacing:1.2px;text-transform:uppercase;color:var(--ink3)}',
    '#h-aud .sp{margin:7px 0 2px}',
    '#h-aud .sp svg{display:block;width:100%;height:30px;overflow:visible}',
    '#h-aud .sp .cap{display:flex;justify-content:space-between;font-size:10px;letter-spacing:1.1px;text-transform:uppercase;color:var(--ink4);margin-top:2px}',
    '#h-aud .sp .cap b{color:var(--ink3);font-weight:600}',
    '#h-aud .cc{display:flex;flex-wrap:wrap;gap:4px 5px;margin-top:6px}',
    '#h-aud .cc span{display:inline-flex;align-items:baseline;gap:5px;font-size:12px;letter-spacing:.8px;color:var(--ink2);',
    '  border:1px solid rgba(125,160,200,.24);border-radius:3px;padding:1px 6px;line-height:1.5;white-space:nowrap}',
    '#h-aud .cc span b{color:#fff;font-weight:600}',
    '#h-aud .cc span.top{border-color:rgba(255,209,102,.55);color:#ffe3a3} #h-aud .cc span.top b{color:#ffd166}',
    '#h-aud .cc span.more{border-style:dashed;color:var(--ink3)}',
    '#h-aud .row{display:flex;gap:12px;font-size:11.5px;color:var(--ink3);margin-top:6px;white-space:nowrap}',
    '#h-aud .row span{overflow:hidden;text-overflow:ellipsis;min-width:0}',
    '#h-aud .row b{color:var(--ink1);font-weight:600}',
    '#h-aud .ex{font-size:10.5px;letter-spacing:.8px;color:var(--ink4);margin-top:5px;padding-top:4px;border-top:1px solid rgba(125,160,200,.14);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '#h-aud .new{font-size:11.5px;color:#ffd166;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;',
    '  max-height:0;opacity:0;transition:opacity .5s ease,max-height .4s ease}',
    '#h-aud .new.on{max-height:22px;opacity:1}',

    '@media (max-width:1599px){',
    '  #hbrand .wm{font-size:20px} #hstats b{font-size:24px} #hstats{gap:16px}',
    '  #herobot{gap:20px} #herobot b{font-size:16px}',
    '  #h-aud{width:300px}',
    '}'
  ].join('\n');

  function el(id) { return document.getElementById(id); }
  function txt(id) { var e = el(id); return e ? (e.textContent || '').trim() : ''; }

  function mount() {
    if (H.top) return;
    var st = document.createElement('style');
    st.id = 'hero-css'; st.textContent = CSS;
    document.head.appendChild(st);

    H.top = document.createElement('div');
    H.top.id = 'herotop';
    H.top.innerHTML =
      '<div id="hbrand">' +
      '<span class="wm" id="h-wm"></span>' +
      '<span class="clk" id="h-clk">--:--:--</span>' +
      '<span class="chip" id="h-wan">WAN</span>' +
      '<span class="chip" id="h-cam">CAMS</span>' +
      '<span class="chip cf" id="h-cf" style="display:none">CF EDGE</span>' +
      '</div><div id="hstats"></div>';
    document.body.appendChild(H.top);

    H.bot = document.createElement('div');
    H.bot.id = 'herobot';
    document.body.appendChild(H.bot);
    brandMark();
    audMount();
  }

  /* The six headline numbers already exist and are already kept current by the
     page's own pollers. Mirroring their text is cheaper and far less brittle
     than re-deriving them from a second copy of the payload. */
  var TILES = [
    ['s-run', 'online'], ['s-tot', 'guests'], ['s-cli', 'clients'],
    ['s-gpu', 'gpu'], ['s-net', 'snmp net'], ['s-addons', 'add-ons']
  ];

  /* The wordmark is CONFIG.brand, split the same way the HUD splits it
     (first word plain, remainder in the accent) so the two agree. */
  function brandMark() {
    var e = el('h-wm'); if (!e) return;
    var C = window.CONFIG;
    if (C && C.brandHtml) { e.innerHTML = C.brandHtml().replace(/<span>/g, '<i>').replace(/<\/span>/g, '</i>'); }
    else e.textContent = 'GALAXY';
  }
  window.addEventListener('galaxy:config', brandMark);

  function mirror() {
    if (!H.top) return;
    var c = el('h-clk'); if (c) c.textContent = txt('clk') || '--:--:--';

    var w = el('h-wan'), src = el('chip-wan');
    if (w && src) {
      w.textContent = (src.textContent || 'WAN').trim();
      w.className = 'chip ' + (/down|off|fail/i.test(w.textContent) ? 'bad' : 'ok');
    }
    var cm = el('h-cam'), csrc = el('chip-cam');
    if (cm && csrc) { cm.textContent = (csrc.textContent || 'CAMS').trim(); cm.className = 'chip'; }
    /* Cloudflare edge chip: mirrored from #chip-cf (index.html fills it from edge.cloudflare) */
    var cf = el('h-cf'), cfsrc = el('chip-cf');
    if (cf && cfsrc) {
      /* the top bar shares its row with the LIVE pill: keep this to the two numbers,
         the bottom strip carries the full line with the PoP locations */
      var tcf = (cfsrc.textContent || '').trim(), mm = /(\d+) conns · (\d+) req\/min/.exec(tcf);
      if (mm) tcf = 'CF ' + mm[1] + 'c · ' + mm[2] + ' req/min';
      cf.style.display = tcf ? '' : 'none'; cf.textContent = tcf;
      cf.className = 'chip cf' + (cfsrc.className.indexOf('bad') >= 0 ? ' bad' : '');
    }

    var host = el('hstats'); if (!host) return;
    var html = '';
    for (var i = 0; i < TILES.length; i++) {
      var srcEl = el(TILES[i][0]);
      if (!srcEl) continue;
      var cls = srcEl.className.indexOf('bad') >= 0 ? ' class="bad"'
              : srcEl.className.indexOf('warn') >= 0 ? ' class="warn"' : '';
      html += '<div><b' + cls + '>' + (srcEl.textContent || '–').trim() + '</b><span>'
            + TILES[i][1] + '</span></div>';
    }
    if (html !== H.last) { host.innerHTML = html; H.last = html; }
  }

  /* Bottom strip: the estate-wide vitals, from the payload the page already
     fetched. Wrapping renderNewPanels means zero extra requests. */
  // poll_pve runs every 6 s, so this is several consecutive failures, not a blip
  var STALE_S = 30, STALE_BAD_S = 120;

  function vitals(d) {
    if (!H.bot || !d) return;
    var z = d.zabbix || {}, u = d.unifi || {}, p = d.probe || {};
    var nodes = ((d.topology || {}).nodes) || [];

    var rtts = [], lossy = 0, down = 0, disc = 0;
    for (var i = 0; i < nodes.length; i++) {
      var m = nodes[i].meta || {};
      if (m.rtt != null) rtts.push(m.rtt);
      if (m.loss) lossy++;
      if (m.discovered) disc++;
      if (nodes[i].status === 'down') down++;
    }
    rtts.sort(function (a, b) { return a - b; });
    var med = rtts.length ? rtts[(rtts.length - 1) >> 1] : null;

    function cell(label, value, cls, sub) {
      return '<div><span>' + label + '</span><b' + (cls ? ' class="' + cls + '"' : '')
           + '>' + value + '</b>' + (sub ? '<i>' + sub + '</i>' : '') + '</div>';
    }
    var pr = z.problems || 0;
    var h = '';
    h += cell('alerts', pr, pr ? 'bad' : 'ok');
    h += cell('wan', (u.rx != null ? u.rx : '–') + ' / ' + (u.tx != null ? u.tx : '–'), '', 'Mbps');
    if (med != null) h += cell('latency', med.toFixed(1), med > 60 ? 'bad' : med > 15 ? 'warn' : 'ok', 'ms');
    /* v8: shorter cells - the strip's type grew for the wall and ten cells
       have to fit one 1920 px line (measured: the long form ran 1812 px in a
       1696 px row). Everything that moved out of a cell lives in the panel. */
    h += cell('loss', lossy, lossy ? 'warn' : 'ok', lossy ? 'hosts' : '');
    h += cell('nodes', nodes.length, '', (down ? down + ' down' : 'all up') + (disc ? ' \u00b7 ' + disc + ' new' : ''));
    /* the edge, from the new pollers (2026-09-14): Cloudflare tunnel + CrowdSec.
       Absent blocks stay absent; nothing here is invented. */
    var e = d.edge || {}, cf = e.cloudflare || {}, cs = e.crowdsec || {};
    /* v7: the tunnel cell keeps only the HA count + error rate;
       req/min and the PoPs moved into the audience cell below (or the audience
       cell shows real viewers when Cloudflare zone analytics is up), and the
       crowdsec cell is merged into a threats cell fed by the unified
       /api/threats feed. One line at 1920 px: 10 cells measured to fit. */
    /* the old `cf edge` cell is gone from the strip: its HA count lives on
       the top-bar CF chip, its req/min + PoPs in the audience fallback below
       (measured: with both, the strip ran 1812 px in a 1696 px row) */
    var au = e.audience || {};
    if (au.up) {
      /* REAL unique visitors (edge.audience); the countries + hosts are in the panel */
      h += cell('audience', (au.viewers_5m || 0), (au.viewers_5m || 0) > 0 ? 'ok' : '', '5 min');
    } else if (cf.up) {
      /* honest fallback: tunnel counters are requests, never "viewers" */
      h += cell('audience', Math.round(cf.req_per_min || 0), (cf.err_per_min || 0) > 0 ? 'warn' : '', 'req/min');
    }
    var th = e.threats || {};
    if (th.up) {
      var tc = th.counts || {}, lvl = Math.max(0, Math.min(3, +th.level || 0));
      h += cell('threats', th.name || ['GREEN', 'YELLOW', 'RED', 'BLACK'][lvl], lvl >= 2 ? 'bad' : lvl === 1 ? 'warn' : 'ok',
                (tc.secmon_critical || 0) + ' crit · ' + (tc.secmon_high || 0) + ' high · ' + (tc.banned || 0) + ' banned');
    } else if (cs.up) {
      /* the unified feed is down: fall back to the round-2 crowdsec cell */
      h += cell('crowdsec', (cs.alerts_24h || 0) + ' atk/24h', (cs.alerts_1h || 0) > 0 ? 'warn' : '', (cs.banned || 0) + ' banned');
    }
    if (((window.CONFIG || {}).features || {}).cameras) h += cell('cams', (d.cameras || []).length, '', 'live');
    /* Staleness, and only when there is some. ts now advances only on a poll
       that actually returned data, so this is the difference between "the
       estate is quiet" and "nothing has answered for a minute" -- which used
       to look identical because ts was bumped every cycle regardless.
       Server-computed age; the browser's clock is not involved. */
    var age = d.ts_age;
    if (age != null && age > STALE_S) {
      h += cell('data', age < 90 ? Math.round(age) + 's' : Math.round(age / 60) + 'm',
                age > STALE_BAD_S ? 'bad' : 'warn', d.ts_err || 'stale');
    }
    H.bot.innerHTML = h;
  }

  /* ---------------- audience panel (v8) ----------------
     Who is on the public sites right now. Every number is a real unique
     human visitor from edge.audience (origin log: real client IP + country;
     monitors and bots excluded upstream and reported here as excluded).
     Nothing from the tunnel's request counters is ever called a viewer: when
     audience is down the panel switches to a clearly labelled req/min fallback
     and says the visitor count is unavailable. Hidden entirely when the back
     end reports features.audience = false (no audience source configured). */
  var AUD = { el: null, hist: [], last5: null, newAt: 0, newTxt: '', html: '' };
  var HIST_KEY = 'galaxy.aud.hist', HIST_MIN = 60;   // one bucket per minute, an hour deep

  function esc(x) { return String(x == null ? '' : x).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  /* a public host relative to the configured domain: 'media.example.com' -> 'media' */
  function shortHost(h) {
    h = String(h || ''); var dom = String(((window.CONFIG || {}).domain) || '').toLowerCase();
    if (dom && h.toLowerCase() === dom) return h;
    if (dom && h.toLowerCase().slice(-(dom.length + 1)) === '.' + dom) return h.slice(0, -(dom.length + 1));
    return h;
  }

  function audMount() {
    if (AUD.el) return;
    if (!(((window.CONFIG || {}).features) || {}).audience) return;
    AUD.el = document.createElement('div'); AUD.el.id = 'h-aud';
    AUD.el.innerHTML = '<div class="h">Audience \u00b7 <i>live visitors</i></div><div class="box"></div>';
    document.body.appendChild(AUD.el);
    /* the sparkline survives a kiosk reload: the page is the only sampler */
    try {
      var raw = JSON.parse(localStorage.getItem(HIST_KEY) || '[]');
      if (Array.isArray(raw)) AUD.hist = raw.filter(function (p) { return Array.isArray(p) && p.length === 2 && isFinite(p[0]) && isFinite(p[1]); });
    } catch (e) { AUD.hist = []; }
    /* netscene_exo.js fires this once per poll that saw real arrivals */
    window.addEventListener('galaxy:viewer', function (ev) {
      var d = (ev && ev.detail) || {};
      AUD.newAt = Date.now();
      AUD.newTxt = '\u25B2 ' + (d.n > 1 ? d.n + ' new visitors' : 'new visitor') + (d.cc ? ' \u00b7 ' + esc(d.cc) : '')
                 + (d.host ? ' \u00b7 ' + esc(shortHost(d.host)) : '');
      audRender(true); audPop();
    });
  }
  /* the arrival beat on the panel: the number scales + glows and the plate's
     rim flashes gold, once, restarted per event (compositor-only motion) */
  function audPop() {
    var el = AUD.el, n = el && el.querySelector('.n'); if (!n) return;
    n.classList.remove('up'); el.classList.remove('hit');
    void n.offsetWidth;
    n.classList.add('up'); el.classList.add('hit');
  }
  /* a real rise counts up through the intermediate values instead of snapping */
  function audTick(from, to) {
    var el = AUD.el; if (!el || !(to > from)) return;
    var steps = Math.min(12, to - from), i = 0;
    (function step() {
      i++; var n = el.querySelector('.n'); if (!n) return;
      n.textContent = i >= steps ? to : from + Math.round((to - from) * i / steps);
      if (i < steps) setTimeout(step, 70);
    })();
  }

  /* one series, 2 px line, soft fill, a dot on the live end; time runs left
     to right over the last HIST_MIN minutes on a fixed x scale so a gap in
     the record reads as a gap, not a compressed axis */
  function audSpark(H, mNow, w, h) {
    if (H.length < 2) return '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none"><line x1="0" y1="' + (h - 1) + '" x2="' + w + '" y2="' + (h - 1) + '" stroke="rgba(125,160,200,.25)" stroke-width="1"/></svg>';
    var mx = 1, i; for (i = 0; i < H.length; i++) if (H[i][1] > mx) mx = H[i][1];
    var m0 = mNow - HIST_MIN, pts = '', first = '', lx = 0, ly = 0;
    for (i = 0; i < H.length; i++) {
      var x = Math.max(0, Math.min(w, (H[i][0] - m0) / HIST_MIN * w)), y = (h - 2) - (H[i][1] / mx) * (h - 4);
      x = +x.toFixed(1); y = +y.toFixed(1);
      pts += (pts ? ' ' : '') + x + ',' + y; if (!first) first = x; lx = x; ly = y;
    }
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none">'
      + '<polygon points="' + first + ',' + h + ' ' + pts + ' ' + lx + ',' + h + '" fill="rgba(255,209,102,.13)"/>'
      + '<polyline points="' + pts + '" fill="none" stroke="#ffd166" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>'
      + '<circle cx="' + lx + '" cy="' + ly + '" r="2.4" fill="#fff" stroke="#ffd166" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>';
  }

  function audience(d) {
    if (!AUD.el || !d) return;
    var e = d.edge || {}; AUD.au = e.audience || {}; AUD.cf = e.cloudflare || {};
    var au = AUD.au;
    if (au.up) {
      var v5 = +au.viewers_5m || 0;
      var ts = +au.ts || (Date.now() / 1000), m = Math.floor(ts / 60), H = AUD.hist, L = H[H.length - 1];
      if (L && L[0] === m) { if (v5 > L[1]) L[1] = v5; }
      else if (!L || m > L[0]) H.push([m, v5]);
      while (H.length && H[0][0] < m - HIST_MIN) H.shift();
      try { localStorage.setItem(HIST_KEY, JSON.stringify(H)); } catch (x) {}
      AUD.up = AUD.last5 !== null && v5 > AUD.last5; AUD.from = AUD.last5;
      AUD.last5 = v5; AUD.m = m;
    } else { AUD.last5 = null; AUD.up = false; }
    audRender(false);
  }

  function audRender(fromEvent) {
    var el = AUD.el, au = AUD.au || {}, cf = AUD.cf || {}, h = '', i;
    if (!el) return;
    var box = el.querySelector('.box'), hd = el.querySelector('.h');
    var showNew = AUD.newAt && (Date.now() - AUD.newAt) < 90000;
    var ageS = showNew ? Math.round((Date.now() - AUD.newAt) / 1000) : 0;
    if (au.up) {
      var v5 = +au.viewers_5m || 0, v1 = +au.viewers_1h || 0;
      var cs = (au.by_country || []).filter(function (c) { return c && c.cc; }).slice()
        .sort(function (a, b) { return (+b.uniques || 0) - (+a.uniques || 0) || (+b.requests || 0) - (+a.requests || 0); });
      var SHOW = 8, chips = '';
      for (i = 0; i < cs.length && i < SHOW; i++) chips += '<span' + (i === 0 ? ' class="top"' : '') + '>' + esc(cs[i].cc) + ' <b>' + (+cs[i].uniques || 0) + '</b></span>';
      if (cs.length > SHOW) chips += '<span class="more">+' + (cs.length - SHOW) + '</span>';
      var hs = (au.by_host || []).filter(function (x) { return x && x.host; }).slice()
        .sort(function (a, b) { return (+b.uniques || 0) - (+a.uniques || 0); }).slice(0, 2);
      var hosts = hs.map(function (x) { return '<span>' + esc(shortHost(x.host)) + ' <b>' + (+x.uniques || 0) + '</b></span>'; }).join('');
      var mon = +au.monitors_1h || 0, bots = +au.bots_1h || 0;
      hd.innerHTML = 'Audience \u00b7 <i>' + (v5 > 0 ? 'live now' : 'live') + '</i>';
      el.className = '';
      h += '<div class="top"><b class="n' + (v5 === 0 ? ' zero' : '') + '">' + v5 + '</b>'
         + '<div class="t"><b>' + (v5 === 1 ? 'person on site' : 'people on site') + '</b><span>' + (v5 > 0 ? 'unique people \u00b7 5 min' : 'quiet \u00b7 none in 5 min') + '</span></div>'
         + '<div class="hr"><b>' + v1 + '</b><span>this hour</span></div></div>';
      h += '<div class="sp">' + audSpark(AUD.hist, AUD.m || Math.floor(Date.now() / 60000), 250, 22)
         + '<div class="cap"><span>5-min visitors \u00b7 60 min</span><b>' + (AUD.hist.length < 2 ? 'collecting\u2026' : cs.length + (cs.length === 1 ? ' country' : ' countries')) + '</b></div></div>';
      h += '<div class="cc">' + (chips || '<span class="more">no visitors this hour</span>') + '</div>';
      if (hosts) h += '<div class="row">' + hosts + '</div>';
      h += '<div class="ex">' + (+au.requests_1h || 0) + ' req/h \u00b7 excluded: ' + mon + (mon === 1 ? ' monitor' : ' monitors') + ' \u00b7 ' + bots + (bots === 1 ? ' bot' : ' bots') + '</div>';
      h += '<div class="new' + (showNew ? ' on' : '') + '">' + (showNew ? AUD.newTxt + ' \u00b7 ' + ageS + 's ago' : '') + '</div>';
    } else if (cf.up) {
      /* honest fallback: tunnel counters are requests, never people */
      hd.innerHTML = 'Audience \u00b7 <i>requests only</i>';
      el.className = 'fallback';
      h += '<div class="top"><b class="n">' + Math.round(+cf.req_per_min || 0) + '</b>'
         + '<div class="t"><b>req / min</b><span>tunnel \u00b7 requests, not people</span></div>'
         + '<div class="hr"><b>' + (+cf.active_streams || 0) + '</b><span>in-flight</span></div></div>';
      h += '<div class="cc">' + (cf.locations || []).map(function (l) { return '<span>' + esc(String(l).toUpperCase()) + '</span>'; }).join('') + '</div>';
      h += '<div class="ex">visitor count unavailable \u00b7 audience feed down</div>';
    } else {
      hd.innerHTML = 'Audience \u00b7 <i>offline</i>';
      el.className = 'fallback';
      h += '<div class="ex">edge telemetry unavailable</div>';
    }
    if (h !== AUD.html) { AUD.html = h; box.innerHTML = h; }
    if (AUD.up && !fromEvent) { AUD.up = false; audPop(); audTick(AUD.from || 0, AUD.last5 || 0); }
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
  /* the "new visitor \u00b7 Ns ago" line ages on its own clock */
  setInterval(function () { if (AUD.newAt) { try { audRender(true); } catch (e) {} } }, 5000);

  /* zero-touch: wrap the panel renderer to get /api/all for free, exactly the
     way galaxy.js and cinema.js wrap netSceneTick */
  (function wrap() {
    var prev = window.renderNewPanels;
    if (typeof prev !== 'function') { setTimeout(wrap, 300); return; }
    window.renderNewPanels = function (d) {
      if (H.privacy) { try { redact(d, 0); } catch (e) {} }
      try { prev(d); } finally { try { vitals(d); } catch (e) {} try { audience(d); } catch (e) {} }
    };
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
