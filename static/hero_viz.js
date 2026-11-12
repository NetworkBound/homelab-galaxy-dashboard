/* hero_viz.js - the wall's chrome, visual first (v12).
   ---------------------------------------------------------------------------
   Show all of the estate's data visually, with as little text as possible.
   hero.js (v11) still owns the data plumbing (NB_PROBLEMS, the rotating
   operations panel, privacy, layout); this file replaces the text-row panels
   with visual ones and retires what colour and motion already say:
     * header: ONE slim strip. Left: brand, clock and the estate vitals that used
       to be a second bottom bar (problems pill, WAN arrows, latency, threat pips).
       Right: ring gauges (guests running, network devices up, GPU) + two numbers.
     * bottom: only the tour caption remains (the two bottom bars become one).
     * left: Compute - a CPU/RAM meter pair per Proxmox node, a VRAM ring per GPU
       with its utilisation inside, one dot per loaded model (lit while it is
       generating), the detector's inference time.
     * left, under it: hero.js's operations pages, percentages drawn as meters.
     * right: Visitors - the 5-minute number, the hour's sparkline, country chips.
     * right: Problems - a severity strip (one segment per host, red / amber),
       the worst problem in one line.
     * the legend is retired (stream colour and width speak for themselves).
   Nothing is dropped: a click (or tap) on a panel opens its full detail in
   place for 15 s (every row the v11 panel had, plus more), and the tour stops
   and body cards keep all the rest. Same type rules: Inter, 11/12/13/15 px,
   tabular numerals, colour only for status.
   Wall only (index.html); the TV page has its own chrome.
   --------------------------------------------------------------------------- */
(function () {
  'use strict';
  if (window.HERO_VIZ) return;
  var Q = (location.search.match(/[?&]viz=(\w+)/) || [])[1] || '';
  if (Q === 'off') return;

  var CSS = [
    /* retire / replace the v11 text panels (hero mode only; F layout untouched) */
    'body.hero #herobot,body.hero #nbkey,body.hero #nbalerts,body.hero #h-aud,body.hero #st-ai,body.hero #hstats{display:none!important}',
    'body.hero #cin{bottom:calc(var(--sy) - 2px)!important}',
    '.vz{position:fixed;z-index:8;display:none;width:280px;box-sizing:border-box;pointer-events:auto;cursor:default;',
    '  font:400 12px/18px var(--ui-font);color:var(--t1);letter-spacing:0;font-variant-numeric:tabular-nums;',
    '  background:var(--pbg);border:1px solid var(--pline);border-radius:6px;padding:8px 12px 8px;transition:opacity var(--nb-bar,1.6s) ease}',
    'body.hero .vz{display:block}',
    '.vz .pt{display:flex;justify-content:space-between;align-items:baseline;font-size:13px;line-height:20px;font-weight:500;margin:0 0 6px}',
    '.vz .pt span{font-size:11px;font-weight:400;color:var(--t3)}',
    '.vz .det{display:none;margin-top:6px;padding-top:6px;border-top:1px solid var(--pline)}',
    '.vz.open .det{display:block}',
    '.vz .r{display:flex;justify-content:space-between;gap:12px;color:var(--t2)} .vz .r b{font-weight:400;color:var(--t1);white-space:nowrap}',
    '.vz .r b.bad{color:var(--crit)} .vz .r b.warn{color:var(--warn)}',
    '.vz .x{font-size:11px;color:var(--t3)}',
    /* 25 % for the whole leg, back over one bar; #nbops rides on #vzcomp's edge, so its top never eases */
    'body.hero.nb-travel .vz{opacity:.25;transition:opacity .3s ease}',
    'body.hero #nbops{transition:opacity var(--nb-bar,1.6s) ease} body.hero.nb-travel #nbops{transition:opacity .3s ease}',
    'body.hero #nbops.fs-out{transition:opacity .28s ease}',
    'body[data-doom]:not([data-doom^="phase=off"]) .vz{opacity:0!important}',
    'body.st-night .vz{opacity:.6}',
    /* meters */
    '.vz .mt{display:grid;grid-template-columns:86px 1fr 1fr;gap:4px 8px;align-items:center;font-size:11px;color:var(--t2)}',
    '.vz .mt .nm{color:var(--t1);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.mb{position:relative;height:6px;border-radius:3px;background:rgba(255,255,255,.08);overflow:hidden}',
    '.mb i{position:absolute;left:0;top:0;bottom:0;border-radius:3px;background:#9aa4b1;transition:width .8s ease}',
    '.mb i.warn{background:var(--warn)} .mb i.bad{background:var(--crit)}',
    '.vz .mh{display:grid;grid-template-columns:86px 1fr 1fr;gap:8px;font-size:10px;line-height:12px;color:var(--t3);margin-bottom:2px}',
    /* rings */
    '.rg{display:flex;gap:14px;margin-top:8px}',
    '.rg .g{display:flex;flex-direction:column;align-items:center;gap:2px;font-size:11px;color:var(--t2)}',
    '.rg svg{display:block}',
    '.rg .vst{margin-left:auto;display:flex;flex-direction:column;gap:4px;align-items:flex-end}',
    '.rg .vst b{font-size:15px;line-height:16px;font-weight:500;color:var(--t1)} .rg .vst u{text-decoration:none;font-size:11px;color:var(--t2)}',
    '.rg .vst span{display:block;text-align:right;font-size:10px;line-height:12px;color:var(--t3)}',
    '.dots{display:flex;gap:5px;align-items:center;margin-top:8px;font-size:11px;color:var(--t2)}',
    '.dots i{width:7px;height:7px;border-radius:50%;background:rgba(255,255,255,.18)} .dots i.on{background:var(--t1)}',
    '.dots i.busy{background:var(--info);animation:vzp 1.2s ease-in-out infinite}',
    '@keyframes vzp{50%{opacity:.35}}',
    /* header */
    '#vzkpi{display:flex;gap:22px;align-items:center;pointer-events:none}',
    '#vzkpi .k{display:flex;align-items:center;gap:7px}',
    '#vzkpi .k b{display:block;font-size:15px;line-height:18px;font-weight:500;color:var(--t1)}',
    '#vzkpi .k b u{text-decoration:none;font-size:11px;color:var(--t2);font-weight:400}',
    '#vzkpi .k span{display:block;font-size:11px;line-height:13px;color:var(--t3)}',
    '#vzkpi .k b.warn{color:var(--warn)} #vzkpi .k b.bad{color:var(--crit)}',
    '#vzvit{display:flex;gap:12px;align-items:center}',
    '#vzvit .c{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--t2);white-space:nowrap}',
    '#vzvit .c b{font-weight:500;color:var(--t1)} #vzvit .c b.warn{color:var(--warn)} #vzvit .c b.bad{color:var(--crit)}',
    '#vzvit .pill{padding:0 8px;border-radius:9px;border:1px solid var(--pline)}',
    '#vzvit .pip{display:inline-block;width:5px;height:10px;border-radius:1px;background:rgba(255,255,255,.14);margin-left:1px}',
    '#vzvit .pip.on{background:var(--t2)} #vzvit .pip.on.warn{background:var(--warn)}',
    'body.hero #h-wan,body.hero #h-cam,body.hero #h-cf{display:none!important}',
    /* visitors */
    '#vzaud .big{display:flex;align-items:baseline;gap:8px} #vzaud .big b{font-size:28px;line-height:32px;font-weight:500}',
    '#vzaud .big span{font-size:11px;color:var(--t3)} #vzaud .big em{margin-left:auto;font-style:normal;font-size:12px;color:var(--t2)}',
    '#vzaud svg{display:block;width:100%;height:30px;margin:4px 0 6px}',
    '.chips{display:flex;flex-wrap:wrap;gap:4px}',
    '.chips span{display:inline-flex;align-items:center;gap:4px;padding:0 6px;border-radius:9px;background:rgba(255,255,255,.06);font-size:11px;color:var(--t2)}',
    '.chips span b{font-weight:500;color:var(--t1)}',
    '#vzaud.hit{box-shadow:0 0 0 1px rgba(255,255,255,.18) inset}',
    /* problems */
    '#vzprob .strip{display:flex;gap:2px;height:8px;margin:2px 0 6px}',
    '#vzprob .strip i{flex:1 1 0;border-radius:2px;background:var(--warn)} #vzprob .strip i.bad{background:var(--crit)} #vzprob .strip i.info{background:var(--unk)}',
    '#vzprob .cnt{display:flex;gap:12px;font-size:11px;color:var(--t3)} #vzprob .cnt b{font-weight:500;font-size:13px;margin-right:3px}',
    '#vzprob .cnt b.bad{color:var(--crit)} #vzprob .cnt b.warn{color:var(--warn)}',
    /* the worst problem is never cut: it wraps to two 12 px lines; a text that would need a third gives way to the host and "+N" */
    '#vzprob .w{display:flex;align-items:flex-start;gap:6px;margin-top:4px;color:var(--t2);font-size:12px;line-height:16px}',
    '#vzprob .w .dot{margin-top:4px} #vzprob .w span{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}',
    '#vzprob .w em{font-style:normal;color:var(--t1)} #vzprob .w b{flex:0 0 auto;font-weight:400;font-size:11px;color:var(--t3)}',
    '#vzprob .ok{display:flex;align-items:center;gap:6px;color:var(--t2)}',
    /* placement: left column under the header, right column likewise */
    '#vzcomp{left:var(--sx);top:31%}',
    '#vzaud{right:var(--sx);top:29%}',
    '#vzprob{right:var(--sx);top:calc(29% + 140px)}',
    /* hero.js operations panel: percentages as meters */
    '#nbops .r{flex-wrap:wrap} #nbops .r span{flex:1 1 0;min-width:0} #nbops .r .mb{flex:1 0 100%;height:3px;margin:1px 0 3px}'
  ].join('\n');

  function el(id) { return document.getElementById(id); }
  function esc(x) { return String(x == null ? '' : x).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function txt(id) { var e = el(id); return e ? (e.textContent || '').trim() : ''; }
  function n3(v) { v = +v; return !isFinite(v) ? '–' : Math.abs(v) >= 100 ? Math.round(v) + '' : Math.abs(v) >= 10 ? v.toFixed(1).replace(/\.0$/, '') : v.toFixed(2).replace(/\.?0+$/, ''); }
  function sev(p, w, b) { return p >= b ? 'bad' : p >= w ? 'warn' : ''; }
  function meter(p, cls) { p = Math.max(0, Math.min(100, +p || 0)); return '<div class="mb"><i class="' + (cls || '') + '" style="width:' + p.toFixed(1) + '%"></i></div>'; }
  /* a ring: track + arc (fraction f), optional inner arc (g), centre text */
  function ring(f, size, txt1, cls, g) {
    var s = size, r = s / 2 - 3, c = 2 * Math.PI * r, col = cls === 'bad' ? 'var(--crit)' : cls === 'warn' ? 'var(--warn)' : '#c9d1dc';
    f = Math.max(0, Math.min(1, +f || 0));
    var h = '<svg width="' + s + '" height="' + s + '" viewBox="0 0 ' + s + ' ' + s + '">' +
      '<circle cx="' + s / 2 + '" cy="' + s / 2 + '" r="' + r + '" fill="none" stroke="rgba(255,255,255,.10)" stroke-width="3"/>' +
      '<circle cx="' + s / 2 + '" cy="' + s / 2 + '" r="' + r + '" fill="none" stroke="' + col + '" stroke-width="3" stroke-linecap="round"' +
      ' stroke-dasharray="' + (c * f).toFixed(1) + ' ' + c.toFixed(1) + '" transform="rotate(-90 ' + s / 2 + ' ' + s / 2 + ')"/>';
    if (g != null) {
      var r2 = r - 5, c2 = 2 * Math.PI * r2; g = Math.max(0, Math.min(1, +g || 0));
      h += '<circle cx="' + s / 2 + '" cy="' + s / 2 + '" r="' + r2 + '" fill="none" stroke="rgba(255,255,255,.06)" stroke-width="2"/>' +
           '<circle cx="' + s / 2 + '" cy="' + s / 2 + '" r="' + r2 + '" fill="none" stroke="#58a6ff" stroke-width="2" stroke-linecap="round"' +
           ' stroke-dasharray="' + (c2 * g).toFixed(1) + ' ' + c2.toFixed(1) + '" transform="rotate(-90 ' + s / 2 + ' ' + s / 2 + ')"/>';
    }
    if (txt1 != null) h += '<text x="50%" y="50%" dy=".35em" text-anchor="middle" fill="#e6e9ee" font-size="' + (s >= 40 ? 11 : 9) + '" font-family="Inter,system-ui,sans-serif">' + esc(txt1) + '</text>';
    return h + '</svg>';
  }
  function setHtml(node, h) { if (node && node._h !== h) { node._h = h; node.querySelector('.bd').innerHTML = h; } }
  function setDet(node, h) { if (node && node._d !== h) { node._d = h; node.querySelector('.det').innerHTML = h; } }

  var V = { comp: null, aud: null, prob: null, kpi: null, vit: null, gpu: [], show: null };

  function panel(id, title, sub) {
    var p = document.createElement('div'); p.id = id; p.className = 'vz';
    p.innerHTML = '<div class="pt">' + title + '<span>' + (sub || '') + '</span></div><div class="fw"><div class="bd"></div></div>' +
                  '<div class="hudm"><div class="in"></div></div><div class="det"></div>';
    /* details on click (contracts 7): in place, 15 s, never moves the camera */
    p.addEventListener('pointerup', function (e) {
      e.stopPropagation();
      p.classList.toggle('open');
      clearTimeout(p._t); if (p.classList.contains('open')) p._t = setTimeout(function () { p.classList.remove('open'); stack(); }, 15000);
      stack();
    });
    p.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    document.body.appendChild(p);
    return p;
  }

  function mount() {
    var st = document.createElement('style'); st.id = 'hero-viz-css'; st.textContent = CSS; document.head.appendChild(st);
    V.comp = panel('vzcomp', 'Compute', 'Proxmox · GPU');
    V.aud = panel('vzaud', 'Website visitors', 'live');
    V.prob = panel('vzprob', 'Problems', '');
    var top = el('herotop');
    if (top) {
      V.kpi = document.createElement('div'); V.kpi.id = 'vzkpi'; top.appendChild(V.kpi);
      var br = el('hbrand');
      V.vit = document.createElement('span'); V.vit.id = 'vzvit';
      if (br) br.insertBefore(V.vit, el('h-age')); else top.appendChild(V.vit);
    }
    var ops = el('nbops');
    if (ops && window.MutationObserver) new MutationObserver(opsMeters).observe(ops, { childList: true, subtree: true });
  }

  /* ---------------- header ---------------- */
  function frac(s) { var m = /(\d[\d,]*)\s*\/\s*(\d[\d,]*)/.exec(s || ''); return m ? [+m[1].replace(/,/g, ''), +m[2].replace(/,/g, '')] : null; }
  function kpis() {
    if (!V.kpi) return;
    var run = +txt('s-run').replace(/,/g, ''), tot = +txt('s-tot').replace(/,/g, ''), net = frac(txt('s-net')), gpu = parseFloat(txt('s-gpu'));
    var h = '';
    if (tot) { var f = run / tot; h += '<div class="k">' + ring(f, 30, null, f < 0.8 ? 'warn' : '') + '<div><b>' + run + ' <u>/ ' + tot + '</u></b><span>Guests running</span></div></div>'; }
    if (net) { var g = net[0] / Math.max(1, net[1]); h += '<div class="k">' + ring(g, 30, null, g < 0.7 ? 'bad' : g < 1 ? 'warn' : '') + '<div><b>' + net[0] + ' <u>/ ' + net[1] + '</u></b><span>Network devices</span></div></div>'; }
    if (isFinite(gpu)) h += '<div class="k">' + ring(gpu / 100, 30, null, sev(gpu, 85, 97)) + '<div><b>' + Math.round(gpu) + ' <u>%</u></b><span>GPU</span></div></div>';
    var cli = txt('s-cli'); if (cli) h += '<div class="k"><div><b>' + esc(cli) + '</b><span>Clients</span></div></div>';
    var ad = txt('s-addons'); if (ad && ad !== '\u2013') h += '<div class="k"><div><b>' + esc(ad) + '</b><span>Add-ons</span></div></div>';
    if (V.kpi._h !== h) { V.kpi._h = h; V.kpi.innerHTML = h; }
  }
  function vitals(d) {
    if (!V.vit || !d) return;
    var u = d.unifi || {}, h = '';
    var P = window.NB_PROBLEMS ? window.NB_PROBLEMS() : { crit: 0, warn: 0, rows: [] }, n = P.crit + P.warn;
    h += '<span class="c pill"><i class="dot ' + (P.crit ? 'bad' : n ? 'warn' : 'ok') + '"></i>' + (n ? '<b class="' + (P.crit ? 'bad' : 'warn') + '">' + n + '</b>' : '<b>0</b>') + '</span>';
    var wok = u.wan_up === 'ok';
    if (u.wan_up) h += '<span class="c"><i class="dot ' + (wok ? 'ok' : 'bad') + '"></i>↓<b>' + (u.rx != null ? esc(u.rx) : '–') + '</b> ↑<b>' + (u.tx != null ? esc(u.tx) : '–') + '</b> Mb/s</span>';
    if (u.latency != null) h += '<span class="c"><b>' + esc(u.latency) + '</b> ms</span>';
    var th = (d.edge || {}).threats || {};
    if (th.up) {
      var lvl = Math.max(0, Math.min(3, +th.level || 0)), pips = '';
      for (var i = 0; i < 4; i++) pips += '<i class="pip' + (i <= lvl ? ' on' + (lvl >= 1 ? ' warn' : '') : '') + '"></i>';
      h += '<span class="c">Threat' + pips + '</span>';
    }
    if (V.vit._h !== h) { V.vit._h = h; V.vit.innerHTML = h; }
  }

  /* ---------------- compute ---------------- */
  function fetchGpu() {
    fetch('/api/gpu', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j) V.gpu = j.gpus || []; compute(window.NB_ALL); }).catch(function () { });
  }
  function fetchShow() {
    fetch('/api/showtime', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j) V.show = j; compute(window.NB_ALL); }).catch(function () { });
  }
  function compute(d) {
    if (!V.comp) return;
    d = d || {};
    var h = '<div class="mh"><span></span><span>CPU</span><span>Memory</span></div><div class="mt">', det = '';
    (d.nodes2 || []).forEach(function (n) {
      h += '<span class="nm">' + esc(nodeName(n.node)) + '</span>' + meter(n.cpu, sev(n.cpu, 60, 85)) + meter(n.mem_pct, sev(n.mem_pct, 80, 92));
      det += row(esc(nodeName(n.node)), 'CPU ' + n3(n.cpu) + ' % · RAM ' + n3(n.mem_pct) + ' % · ' + (n.cores || '–') + ' cores');
    });
    h += '</div>';
    var gs = (V.gpu || []).slice(0, 3), S = V.show || {}, ol = S.ollama || [], cr = S.coral || {}, dots = '', nm2 = 0, avail = 0;
    ol.forEach(function (o) {
      (o.loaded || []).forEach(function (m) { nm2++; dots += '<i class="' + (m.busy ? 'busy' : 'on') + '"></i>'; det += row(esc(m.name), esc(o.name) + ' · ' + n3((m.vram_mb || 0) / 1024) + ' GB' + (m.busy ? ' · generating' : '')); });
      avail += +o.available || 0;
    });
    if (gs.length) {
      h += '<div class="rg">';
      gs.forEach(function (g) {
        var nm = String(g.name || 'GPU').replace(/^NVIDIA GeForce /, '').replace(/^NVIDIA /, '').replace(/^(RTX|GTX) /, '');
        var f = g.mem_total ? g.mem_used / g.mem_total : 0;
        h += '<div class="g">' + ring(f, 44, Math.round(g.util || 0) + '%', g.temp >= 83 ? 'bad' : g.temp >= 75 ? 'warn' : '', (g.util || 0) / 100) + '<span>' + esc(nm) + '</span></div>';
        det += row(esc(nm), n3(g.mem_used / 1024) + ' / ' + n3(g.mem_total / 1024) + ' GB · ' + n3(g.util) + ' % · ' + n3(g.temp) + ' °C · ' + n3(g.power) + ' W');
      });
      /* models + detector beside the rings: two small stats */
      h += '<div class="vst">' + (ol.length ? '<div><b>' + nm2 + '</b><u> / ' + avail + '</u><span>models loaded</span></div>' : '') +
           (cr.inference_ms != null ? '<div><b>' + n3(cr.inference_ms) + '</b><u> ms</u><span>detector</span></div>' : '') + '</div>';
      h += '</div>';
    }
    if (nm2) h += '<div class="dots">' + dots + '</div>';
    if (cr.model) det += row('Detector', esc(cr.model) + ' · ' + n3(cr.inference_ms) + ' ms');
    setHtml(V.comp, h); setDet(V.comp, det || '<div class="x">no detail</div>');
    /* the folded panel: the busiest GPU, or the busiest node when no GPU reports */
    var mini = '', top = null;
    gs.forEach(function (g) { if (g.util != null && (!top || +g.util > +top.util)) top = g; });
    if (top) mini = row('GPU load', Math.round(top.util) + ' %' + (gs.length > 1 ? ' <u>· busiest of ' + gs.length + '</u>' : ''), top.temp >= 83 ? 'bad' : top.temp >= 75 ? 'warn' : '');
    else {
      (d.nodes2 || []).forEach(function (n) { if (n.cpu != null && (!top || +n.cpu > +top.cpu)) top = n; });
      mini = top ? row('CPU load', n3(top.cpu) + ' % <u>· ' + esc(nodeName(top.node)) + '</u>', sev(top.cpu, 60, 85)) : row('GPU load', '\u2013');
    }
    if (V.comp._m !== mini) { V.comp._m = mini; V.comp.querySelector('.hudm .in').innerHTML = mini; }
  }
  function fold(w) { if (w && window.NB_HUD && NB_HUD.fold) NB_HUD.fold(w); }
  /* the node's system short name ("PVE1", "Compute"): the same words as its galaxy */
  function nodeName(n) {
    n = String(n || '');
    var U = window.NETSCENE && NETSCENE.U, s = U && U.sysById && U.sysById['sys:' + n], t = (s && s.short) || n;
    if (t.length > 3 && t === t.toUpperCase()) t = t.charAt(0) + t.slice(1).toLowerCase();
    else if (t.length <= 3) t = t.toUpperCase();
    else t = t.charAt(0).toUpperCase() + t.slice(1);
    return t;
  }
  function row(k, v, c) { return '<div class="r"><span>' + k + '</span><b' + (c ? ' class="' + c + '"' : '') + '>' + v + '</b></div>'; }

  /* hero.js's operations rows: a value carrying a percentage gets a meter */
  function opsMeters() {
    var ops = el('nbops'); if (!ops) return;
    ops.querySelectorAll('.r').forEach(function (r) {
      if (r.querySelector('.mb') || r.closest('.hudm')) return;     // the folded panel is a title and one plain row
      var b = r.querySelector('b'); if (!b) return;
      /* only real shares: "N %" or "a / b up|guests|ok" - never a rate like "701 / 24 h" */
      var t = b.textContent, m = /(\d+(?:\.\d+)?)\s*%/.exec(t), f = /\/\s*[\d,]+\s*(up|guests|ok)\b/.test(t) ? frac(t) : null;
      var p = m ? +m[1] : (f && f[1] ? 100 * f[0] / f[1] : null);
      if (p == null || !isFinite(p)) return;
      var bad = b.classList.contains('bad') ? 'bad' : b.classList.contains('warn') ? 'warn' : '';
      r.insertAdjacentHTML('beforeend', meter(p, bad));
    });
  }

  /* ---------------- visitors ---------------- */
  /* a visitor host relative to the configured domain ("www.example.net" -> "www"), as hero.js shows it */
  function siteName(h) {
    h = String(h || ''); var dom = String(((window.CONFIG || {}).domain) || '').toLowerCase();
    if (dom && h.toLowerCase() === dom) return h;
    if (dom && h.toLowerCase().slice(-dom.length - 1) === '.' + dom) return h.slice(0, h.length - dom.length - 1);
    return h;
  }
  function spark(H, w, h) {
    if (!H || H.length < 2) return '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none"><line x1="0" y1="' + (h - 1) + '" x2="' + w + '" y2="' + (h - 1) + '" stroke="rgba(255,255,255,.14)"/></svg>';
    var mx = 1, i, m1 = H[H.length - 1][0], m0 = m1 - 60, pts = '', fx = 0, lx = 0, ly = 0;
    for (i = 0; i < H.length; i++) if (H[i][1] > mx) mx = H[i][1];
    for (i = 0; i < H.length; i++) {
      var x = +Math.max(0, Math.min(w, (H[i][0] - m0) / 60 * w)).toFixed(1), y = +((h - 2) - (H[i][1] / mx) * (h - 4)).toFixed(1);
      if (!pts) fx = x; pts += (pts ? ' ' : '') + x + ',' + y; lx = x; ly = y;
    }
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none"><polygon points="' + fx + ',' + h + ' ' + pts + ' ' + lx + ',' + h + '" fill="rgba(154,164,177,.14)"/>' +
      '<polyline points="' + pts + '" fill="none" stroke="#c9d1dc" stroke-width="1.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>' +
      '<circle cx="' + lx + '" cy="' + ly + '" r="2.2" fill="#e6e9ee"/></svg>';
  }
  function audience(d) {
    if (!V.aud || !d) return;
    var e = d.edge || {}, au = e.audience || {}, cf = e.cloudflare || {}, h = '', det = '', H = [];
    try { H = JSON.parse(localStorage.getItem('galaxy.aud.hist') || '[]'); } catch (x) { }
    if (au.up) {
      var v5 = +au.viewers_5m || 0, v1 = +au.viewers_1h || 0;
      var cs = (au.by_country || []).filter(function (c) { return c && c.cc; }).sort(function (a, b) { return (+b.uniques || 0) - (+a.uniques || 0); });
      h += '<div class="big"><b>' + v5 + '</b><span>active · 5 min</span><em>' + v1 + ' this hour</em></div>' + spark(H, 256, 30);
      h += '<div class="chips">' + cs.slice(0, 5).map(function (c) { return '<span>' + esc(c.cc) + ' <b>' + (+c.uniques || 0) + '</b></span>'; }).join('') + (cs.length > 5 ? '<span>+' + (cs.length - 5) + '</span>' : '') + '</div>';
      (au.by_host || []).filter(function (x) { return x && x.host; }).sort(function (a, b) { return (+b.uniques || 0) - (+a.uniques || 0); }).slice(0, 5)
        .forEach(function (x) { det += row(esc(siteName(x.host)), (+x.uniques || 0) + ' visitors'); });
      det += row('Requests', (+au.requests_1h || 0) + ' / h');
      det += row('Excluded', (+au.monitors_1h || 0) + ' monitors · ' + (+au.bots_1h || 0) + ' bots');
      if (cf.up) det += row('Cloudflare', (cf.ha_connections != null ? cf.ha_connections : '?') + ' conn · ' + Math.round(cf.req_per_min || 0) + ' req/min');
    } else if (cf.up) {
      h += '<div class="big"><b>' + Math.round(+cf.req_per_min || 0) + '</b><span>requests / min</span></div><div class="x">visitor count unavailable</div>';
    } else h += '<div class="x">edge telemetry unavailable</div>';
    if (V.aud._last != null && au.up && +au.viewers_5m > V.aud._last) { V.aud.classList.add('hit'); setTimeout(function () { V.aud.classList.remove('hit'); }, 1600); }
    V.aud._last = au.up ? +au.viewers_5m : null;
    setHtml(V.aud, h); setDet(V.aud, det || '<div class="x">no detail</div>');
  }

  /* ---------------- problems ---------------- */
  function problems() {
    if (!V.prob || !window.NB_PROBLEMS) return;
    var P = window.NB_PROBLEMS(), real = P.rows.filter(function (r) { return r.sev !== 'info'; }), h = '', det = '';
    V.prob.querySelector('.pt span').textContent = real.length ? real.length + (real.length === 1 ? ' host' : ' hosts') : 'Estate';
    if (!real.length) h = '<div class="ok"><i class="dot ok"></i>All systems normal</div>';
    else {
      h += '<div class="strip">' + real.map(function (r) { return '<i class="' + (r.sev === 'crit' ? 'bad' : '') + '"></i>'; }).join('') + '</div>';
      h += '<div class="cnt">' + (P.crit ? '<span><b class="bad">' + P.crit + '</b>critical</span>' : '') + (P.warn ? '<span><b class="warn">' + P.warn + '</b>warning</span>' : '') +
           (P.info ? '<span><b>' + P.info + '</b>info</span>' : '') + '</div>';
      var w = real[0];
      h += '<div class="w"><i class="dot ' + (w.sev === 'crit' ? 'bad' : 'warn') + '"></i><span><em>' + esc(w.host) + '</em> ' + esc(w.text) + '</span>' +
           (w.n > 1 ? '<b>+' + (w.n - 1) + '</b>' : '') + '</div>';
      real.slice(0, 12).forEach(function (r) { det += '<div class="r"><span><i class="dot ' + (r.sev === 'crit' ? 'bad' : 'warn') + '" style="width:6px;height:6px;margin-right:6px"></i>' + esc(r.host) + '</span><b>' + esc(r.text) + (r.n > 1 ? ' +' + (r.n - 1) : '') + '</b></div>'; });
      if (real.length > 12) det += '<div class="x">+' + (real.length - 12) + ' more</div>';
    }
    setHtml(V.prob, h); setDet(V.prob, det || '<div class="x">nothing to list</div>');
    var ws = V.prob.querySelector('.w span');
    if (ws && ws.scrollHeight > 34) {                    // would need a third line: host and count instead, nothing cut
      var wb = V.prob.querySelector('.w b');
      ws.innerHTML = '<em>' + esc(real[0].host) + '</em>';
      if (!wb) { wb = document.createElement('b'); ws.parentNode.appendChild(wb); }
      wb.textContent = '+' + real[0].n;
    }
  }

  /* ---------------- layout: columns stack with a 12 px gap ---------------- */
  function stack() {
    function under(id, prevId) {
      var a = el(prevId), b = el(id); if (!a || !b) return;
      var r = a.getBoundingClientRect(); if (!r.height) return;
      var top = Math.round(r.bottom + 12) + 'px'; if (b.style.top !== top) { b.style.top = top; b.style.bottom = 'auto'; }
    }
    /* one left column: Compute, Operations, Media (it folds as a block) */
    under('nbops', 'vzcomp'); under('st-emby', 'nbops'); under('vzprob', 'vzaud');
  }
  /* a panel that changes height takes the one below it along in the same frame */
  function follow() {
    if (!window.ResizeObserver || V.ro) return;
    V.ro = new ResizeObserver(function () { try { stack(); } catch (e) { } });
    ['vzcomp', 'nbops', 'vzaud'].forEach(function (id) { var e = el(id); if (e) V.ro.observe(e); });
  }

  function tick() {
    var d = window.NB_ALL;
    try { kpis(); } catch (e) { }
    try { vitals(d); } catch (e) { }
    try { audience(d); } catch (e) { }
    try { problems(); } catch (e) { }
    try { compute(d); } catch (e) { }
    try { opsMeters(); } catch (e) { }
    try { stack(); } catch (e) { }
  }

  mount();
  [V.comp, V.aud, V.prob].forEach(function (p) { fold(p.querySelector('.fw')); });
  fold(V.comp.querySelector('.hudm'));
  follow();
  tick();
  setInterval(tick, 1000);
  fetchGpu(); setInterval(fetchGpu, 15000);
  fetchShow(); setInterval(fetchShow, 10000);
  window.HERO_VIZ = { v: 12, state: V, refresh: tick };
})();
