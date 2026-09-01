/* new_panels.js — HUD renderers for the extra telemetry DATA keys
 * (nodes2, zfs, backups, frigate, top, certs, zbx2, latency).
 *
 * Usage:  window.renderNewPanels(d)   // d = full /api/all payload
 * If nothing calls it, a built-in 10s auto-poll of /api/all kicks in
 * (disable with window.NP_NO_AUTOPOLL = true before this script loads).
 *
 * Renders into an existing element with id "np" if the page provides one;
 * otherwise it self-mounts a scrollable HUD column (left edge, below the
 * fleet panel). Tuned for 1200x900: 10-11px monospace, 2-line max per row.
 */
(function () {
  "use strict";
  var OK = "#37f5a0", WARN = "#ffb347", BAD = "#ff5a6a", DIM = "#8fb0d0", FG = "#d6ecff", AC = "#5ad7ff";

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function col(v, warn, bad) { return v >= bad ? BAD : v >= warn ? WARN : OK; }
  function kv(k, v, c) { return '<div class="np-kv"><span>' + esc(k) + '</span><b style="color:' + (c || FG) + '">' + v + "</b></div>"; }
  function sec(title, body, hot) {
    return '<div class="np-sec' + (hot ? " np-hot" : "") + '"><h4>' + esc(title) + "</h4>" + (body || '<div class="np-dim">no data</div>') + "</div>";
  }
  function age(s) {
    if (s == null) return "?";
    if (s < 90) return s + "s"; if (s < 5400) return Math.round(s / 60) + "m";
    if (s < 172800) return Math.round(s / 3600) + "h"; return Math.round(s / 86400) + "d";
  }
  function up(sec) { return sec >= 86400 ? Math.floor(sec / 86400) + "d" : Math.floor(sec / 3600) + "h"; }
  var BLK = "▁▂▃▄▅▆▇█";
  function spark(a) {
    if (!a || !a.length) return "";
    var mx = Math.max.apply(null, a.concat([1]));
    return a.map(function (v) { return BLK[Math.min(7, Math.floor(v / mx * 7.99))]; }).join("");
  }
  var SEVC = { 5: "#ff2b2b", 4: BAD, 3: "#ffa033", 2: "#ffd24a", 1: "#7fa3c8" };

  /* ---- one renderer per DATA key; each returns an HTML string ---- */
  function rNodes2(a) {
    if (!a || !a.length) return "";
    return a.map(function (n) {
      var t = n.temp != null ? '<span style="color:' + col(n.temp, 65, 78) + '">' + n.temp + "°C</span>" : "";
      return '<div class="np-row"><b style="color:' + AC + '">' + esc(n.node) + "</b>" +
        ' <span style="color:' + col(n.cpu, 60, 85) + '">cpu ' + n.cpu + "%</span>" +
        ' <span style="color:' + col(n.mem_pct, 80, 92) + '">ram ' + n.mem_pct + "%</span> " + t + "</div>" +
        '<div class="np-row np-dim">ld ' + n.load[0] + " · rootfs " +
        '<span style="color:' + col(n.rootfs_pct, 75, 90) + '">' + n.rootfs_pct + "%</span>" +
        " · up " + up(n.uptime) + " · " + esc(n.kernel) + "</div>";
    }).join("");
  }

  function rZfs(a) {
    if (!a || !a.length) return "";
    return a.map(function (p) {
      var e = p.errs || {}, errsum = (e.r || 0) + (e.w || 0) + (e.c || 0);
      var sc = p.bad ? BAD : OK;
      return '<div class="np-row"' + (p.bad ? ' style="background:rgba(255,90,106,.12)"' : "") + ">" +
        '<b style="color:' + sc + '">' + esc(p.state) + "</b> " + esc(p.node) + "/" + esc(p.name) +
        ' <span style="color:' + col(p.cap, 80, 90) + '">' + p.cap + "%</span>" +
        ' <span class="np-dim">frag ' + (p.frag || 0) + "%</span>" +
        (errsum ? ' <span style="color:' + BAD + '">e:' + e.r + "/" + e.w + "/" + e.c + "</span>" : "") +
        ' <span class="np-dim">scrub ' + esc(p.scrub || "?") + (p.scrub_age_d != null ? " " + Math.round(p.scrub_age_d) + "d" : "") + "</span></div>";
    }).join("");
  }

  function rBackups(b) {
    if (!b || b.guests == null) return b && b.storages ? kv("stores", esc(b.storages.join(", ")), DIM) : "";
    var probs = (b.stale7 || 0) + (b.missing || 0);
    var h = kv("backed / guests", b.backed + " / " + b.guests, probs ? WARN : OK) +
      kv("stale >7d / never", (b.stale7 || 0) + " / " + (b.missing || 0), probs ? BAD : OK) +
      kv("newest backup", b.newest_age_h != null ? b.newest_age_h + "h ago" : "?", b.newest_age_h > 30 ? WARN : OK);
    h += (b.worst || []).map(function (w) {
      return '<div class="np-row"><span style="color:' + (w.age_d == null ? BAD : WARN) + '">' +
        (w.age_d == null ? "NEVER" : Math.round(w.age_d) + "d") + "</span> " + esc(w.name) + ' <span class="np-dim">#' + w.id + "</span></div>";
    }).join("");
    return h;
  }

  function rFrigate(f) {
    if (!f) return "";
    if (!f.up) return kv("frigate", "DOWN " + esc(f.err || ""), BAD);
    var r = f.rec || {}, det = Object.entries(f.det_ms || {}).map(function (kvp) {
      return esc(kvp[0]) + " " + '<span style="color:' + col(kvp[1], 30, 80) + '">' + kvp[1] + "ms</span>";
    }).join(" · ");
    var h = kv("detector", det || "?", FG) +
      kv("recordings", r.used_gb + "/" + r.total_gb + "G (" + r.pct + "%)", col(r.pct, 80, 92)) +
      (r.est_days != null ? kv("est retention", "~" + r.est_days + "d", r.est_days < 3 ? WARN : OK) : "");
    h += (f.cams || []).map(function (c) {
      var bad = c.fps < 1 || c.skip > 1;
      return '<div class="np-row"><b style="color:' + (bad ? BAD : FG) + '">' + esc(c.name) + "</b>" +
        ' <span class="np-dim">fps</span> ' + c.fps + ' <span class="np-dim">det</span> ' + c.dfps +
        (c.skip ? ' <span style="color:' + WARN + '">skip ' + c.skip + "</span>" : "") + "</div>";
    }).join("");
    return h;
  }

  function rTop(t) {
    if (!t) return "";
    function list(arr, fmt) { return (arr || []).map(fmt).join(""); }
    var h = '<div class="np-sub">cpu</div>' + list(t.cpu, function (g) {
      return '<div class="np-row">' + esc(g.name) + ' <b style="color:' + col(g.v, 60, 85) + '">' + g.v + "%</b></div>";
    });
    h += '<div class="np-sub">ram</div>' + list(t.mem, function (g) {
      return '<div class="np-row">' + esc(g.name) + " <b>" + g.gb + 'G</b> <span class="np-dim">' + g.pct + "%</span></div>";
    });
    if (t.full && t.full.length) h += '<div class="np-sub" style="color:' + WARN + '">nearing full</div>' + list(t.full, function (s) {
      return '<div class="np-row">' + esc(s.node) + "/" + esc(s.name) + ' <b style="color:' + col(s.pct, 80, 90) + '">' + s.pct + "%</b></div>";
    });
    return h;
  }

  function rCerts(c) {
    if (!c || !c.hosts) return "";
    return (c.hosts || []).map(function (h) {
      var cc = h.state === "ok" ? OK : h.state === "warn" ? WARN : BAD;
      return '<div class="np-row"><b style="color:' + cc + '">' +
        (h.days == null ? "ERR" : Math.floor(h.days) + "d") + "</b> " + esc(h.host) +
        (h.err ? ' <span class="np-dim">' + esc(h.err) + "</span>" : "") + "</div>";
    }).join("");
  }

  function rZbx2(z, zbx) {
    if (!z) return "";
    var sev = (zbx && zbx.sev) || {};
    var chips = Object.keys(sev).sort(function (a, b) { return b - a; }).map(function (s) {
      return '<span style="color:' + (SEVC[s] || DIM) + '">●' + sev[s] + "</span>";
    }).join(" ");
    var h = kv("zabbix " + esc(z.version || ""), chips || (z.error ? esc(z.error) : "0 problems"), chips ? FG : OK);
    h += (z.recent || []).map(function (p) {
      return '<div class="np-row"><span style="color:' + (SEVC[p.sev] || DIM) + '">●</span> ' +
        '<b>' + esc(p.host) + '</b> <span class="np-dim">' + age(p.age) + "</span> " + esc(p.name) + "</div>";
    }).join("");
    return h;
  }

  function rLatency(a) {
    if (!a || !a.length) return "";
    return a.map(function (s) {
      var c = !s.up ? BAD : col(s.last, 400, 1500);
      return '<div class="np-row"><b style="color:' + c + '">' + esc(s.name) + "</b> " +
        s.last + 'ms <span class="np-spark">' + spark(s.spark) + "</span>" +
        '<span class="np-dim"> ~' + s.avg + " ^" + s.max + "</span></div>";
    }).join("");
  }

  /* ---- mount + compose ---- */
  var CSS = ".np-wrap{position:fixed;left:16px;top:500px;bottom:16px;width:282px;overflow-y:auto;z-index:6;" +
    "background:linear-gradient(165deg,rgba(11,24,48,.88),rgba(3,8,18,.82));border:1px solid rgba(90,215,255,.28);" +
    "border-radius:10px;padding:8px 10px;font:10px/1.5 ui-monospace,Menlo,monospace;color:" + FG + ";scrollbar-width:thin}" +
    ".np-sec{margin-bottom:8px;border-bottom:1px solid rgba(90,215,255,.10);padding-bottom:5px}" +
    ".np-sec h4{color:#8fe6ff;font-size:9px;letter-spacing:2px;text-transform:uppercase;margin:0 0 3px}" +
    ".np-hot{border:1px solid rgba(255,90,106,.5);border-radius:6px;padding:4px 6px 5px;background:rgba(255,90,106,.06)}" +
    ".np-hot h4{color:#ff9aa4}" +
    ".np-kv{display:flex;justify-content:space-between;gap:6px;padding:1px 0}.np-kv span{color:" + DIM + "}" +
    ".np-kv b{text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:64%}" +
    ".np-row{padding:1px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:10px}" +
    ".np-dim{color:" + DIM + ";opacity:.85}.np-sub{color:#6f8bb0;font-size:8.5px;letter-spacing:1.5px;text-transform:uppercase;margin-top:3px}" +
    ".np-spark{color:" + AC + ";letter-spacing:-1px;font-size:9px}";

  function host() {
    var el = document.getElementById("np");
    if (el) return el;
    if (!document.getElementById("np-css")) {
      var st = document.createElement("style"); st.id = "np-css"; st.textContent = CSS;
      document.head.appendChild(st);
    }
    el = document.createElement("div"); el.id = "np"; el.className = "np-wrap";
    document.body.appendChild(el);
    return el;
  }

  window.renderNewPanels = function (d) {
    d = d || {};
    var zfsBad = (d.zfs || []).some(function (p) { return p.bad; });
    var bk = d.backups || {};
    var bkBad = (bk.stale7 || 0) + (bk.missing || 0) > 0;
    var certBad = (d.certs && d.certs.warn) > 0;
    host().innerHTML =
      sec("PVE Nodes", rNodes2(d.nodes2)) +
      sec("ZFS Pools", rZfs(d.zfs), zfsBad) +
      sec("Backups", rBackups(d.backups), bkBad) +
      sec("Frigate", rFrigate(d.frigate), d.frigate && d.frigate.up === false) +
      sec("Top Talkers", rTop(d.top)) +
      sec("TLS Certs", rCerts(d.certs && d.certs.hosts ? d.certs : null), certBad) +
      sec("Zabbix Recent", rZbx2(d.zbx2, d.zabbix), !!(d.zbx2 && d.zbx2.recent && d.zbx2.recent.length)) +
      sec("Latency", rLatency(d.latency));
  };

  /* built-in 10s auto-poll so the panel works in both scene and fallback modes */
  if (!window.NP_NO_AUTOPOLL) {
    var tick = function () {
      if (document.hidden) return;
      fetch("/api/all").then(function (r) { return r.json(); })
        .then(window.renderNewPanels).catch(function () { });
    };
    tick(); setInterval(tick, 10000);
  }
})();
