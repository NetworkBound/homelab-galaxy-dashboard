/* hero.js — daylight-legible palette + a HERO layout that gives the 3D scene
   the whole wall back.  v7: audience + threats strip cells.
   ---------------------------------------------------------------------------
   Reads:   window.CONFIG  brand (top-bar wordmark), features.cameras
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
    '#hbrand{display:flex;align-items:baseline;gap:12px;white-space:nowrap}',
    '#hbrand .wm{font-size:21px;font-weight:700;letter-spacing:.6px;color:#fff;',
    '  text-shadow:0 0 22px rgba(90,215,255,.45)}',
    '#hbrand .wm i{font-style:normal;color:var(--accent)}',
    '#hbrand .clk{font-size:13px;color:var(--ink2);letter-spacing:1px}',
    '#hbrand .chip{font-size:9px;letter-spacing:1.1px;color:var(--ink3);',
    '  border:1px solid var(--edge);border-radius:3px;padding:2px 7px;text-transform:uppercase}',
    '#hbrand .chip.ok{color:var(--ok);border-color:rgba(62,207,142,.4)}',
    '#hbrand .chip.bad{color:var(--down);border-color:rgba(255,90,106,.45)}',
    '#hbrand .chip.cf{color:#ffb073;border-color:rgba(246,130,31,.45)}',

    /* headline numbers */
    '#hstats{display:flex;gap:26px;align-items:flex-end}',
    '#hstats div{text-align:center}',
    '#hstats b{display:block;font-size:21px;font-weight:600;color:var(--ink1);line-height:1.05}',
    '#hstats span{font-size:8px;letter-spacing:1.5px;color:var(--ink3);text-transform:uppercase}',
    '#hstats b.warn{color:var(--warn)} #hstats b.bad{color:var(--down)}',

    /* bottom vitals */
    '#herobot div{display:flex;align-items:baseline;gap:7px;white-space:nowrap}',
    '#herobot span{font-size:8.5px;letter-spacing:1.5px;color:var(--ink3);text-transform:uppercase}',
    '#herobot b{font-size:13px;font-weight:600;color:var(--ink1)}',
    '#herobot b.ok{color:var(--ok)} #herobot b.warn{color:var(--warn)} #herobot b.bad{color:var(--down)}',
    '#herobot i{font-style:normal;color:var(--ink4);font-size:11px}',

    /* the tour caption sits above the bottom strip once #data is gone */
    'body.hero #cin{bottom:calc(var(--sy) + 34px)!important}',

    /* record-safe: the camera thumbnails are far more identifying than any IP
       on this screen - they are the outside of the house. Hero mode hides them
       already; this covers the full HUD. */
    'body.privacy #cams img,body.privacy .cam img{filter:blur(16px) saturate(.5)}',
    'body.privacy #cams .cam:after{content:"REDACTED";position:absolute;inset:0;',
    '  display:flex;align-items:center;justify-content:center;font-size:9px;',
    '  letter-spacing:2px;color:var(--ink2)}',
    'body.privacy #hbrand:after{content:"REC-SAFE";font-size:8px;letter-spacing:1.6px;',
    '  color:var(--warn);border:1px solid rgba(255,179,71,.5);border-radius:3px;padding:2px 6px}',

    '@media (max-width:1599px){',
    '  #hbrand .wm{font-size:17px} #hstats b{font-size:17px} #hstats{gap:18px}',
    '  #herobot{gap:20px} #herobot b{font-size:12px}',
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
    h += cell('packet loss', lossy, lossy ? 'warn' : 'ok', lossy ? 'hosts' : '');
    h += cell('nodes', nodes.length, '', down ? down + ' down' : 'all up');
    if (disc) h += cell('discovered', disc, 'warn', 'unlisted');
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
      /* REAL unique viewers (Cloudflare zone analytics) */
      var ccs = (au.by_country || []).slice(0, 3).map(function (c) { return c.cc; }).filter(Boolean).join(' ');
      h += cell('audience', (au.viewers_5m || 0) + ' viewer' + ((au.viewers_5m || 0) === 1 ? '' : 's'), (au.viewers_5m || 0) > 0 ? 'ok' : '', '5 min' + (ccs ? ' · ' + ccs : ''));
    } else if (cf.up) {
      /* honest fallback: cloudflared tunnel counters are requests, never "viewers" */
      h += cell('audience', (cf.active_streams || 0) + ' in-flight', (cf.err_per_min || 0) > 0 ? 'warn' : '', Math.round(cf.req_per_min || 0) + ' req/min · ' + (cf.locations || []).join(' '));
    }
    var th = e.threats || {};
    if (th.up) {
      var tc = th.counts || {}, lvl = Math.max(0, Math.min(3, +th.level || 0));
      var ev = (th.events || [])[0], li2 = '';
      if (ev && ev.ts) {
        var ag2 = Math.max(0, Date.now() / 1000 - ev.ts);
        var agS2 = ag2 < 3600 ? Math.round(ag2 / 60) + 'm' : ag2 < 86400 ? Math.round(ag2 / 3600) + 'h' : Math.round(ag2 / 86400) + 'd';
        var ttl = String(ev.title || '').replace(/^(crowdsecurity|LePresidente|[A-Za-z0-9]+)\//, '').replace(/_/g, ' ');
        if (ttl.length > 14) ttl = ttl.slice(0, 13) + '…';
        li2 = ' · ' + agS2 + (ev.cc ? ' ' + ev.cc : '') + ' ' + ttl;
      }
      h += cell('threats', th.name || ['GREEN', 'YELLOW', 'RED', 'BLACK'][lvl], lvl >= 2 ? 'bad' : lvl === 1 ? 'warn' : 'ok',
                (tc.secmon_critical || 0) + ' crit · ' + (tc.secmon_high || 0) + ' high · ' + (tc.banned || 0) + ' banned' + li2);
    } else if (cs.up) {
      /* the unified feed is down: fall back to the round-2 crowdsec cell */
      var la = null; (cs.top_attackers || []).forEach(function (a) { if (a && a.ts && (!la || a.ts > la.ts)) la = a; });
      var li = '';
      if (la) {
        var ag = Math.max(0, Date.now() / 1000 - la.ts);
        var agS = ag < 3600 ? Math.round(ag / 60) + 'm' : ag < 86400 ? Math.round(ag / 3600) + 'h' : Math.round(ag / 86400) + 'd';
        li = ' · last ' + agS + ' · ' + (la.cn || '??') + ' · ' + String(la.scenario || '').replace(/^crowdsecurity\//, '');
      }
      h += cell('crowdsec', (cs.alerts_24h || 0) + ' atk/24h', (cs.alerts_1h || 0) > 0 ? 'warn' : '', (cs.banned || 0) + ' banned' + li);
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

  /* zero-touch: wrap the panel renderer to get /api/all for free, exactly the
     way galaxy.js and cinema.js wrap netSceneTick */
  (function wrap() {
    var prev = window.renderNewPanels;
    if (typeof prev !== 'function') { setTimeout(wrap, 300); return; }
    window.renderNewPanels = function (d) {
      if (H.privacy) { try { redact(d, 0); } catch (e) {} }
      try { prev(d); } finally { try { vitals(d); } catch (e) {} }
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
