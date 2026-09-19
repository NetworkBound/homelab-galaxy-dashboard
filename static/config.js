/* config.js — the one place the screens learn who they are.
   ---------------------------------------------------------------------------
   Loads FIRST on every page. Fetches GET /api/config exactly once (the shape
   is documented in docs/contracts.md), fills in defaults for anything the
   server left out, and publishes the result as window.CONFIG before any scene
   is built. If /api/config is unreachable the page still comes up: the brand
   falls back to "GALAXY" and the node list is derived from /api/all
   (nodes[].node), so an older back end draws the same picture.

   Reads:   /api/config          brand, domain, tagline, nodes[], wan_label,
                                 categories[], palette{}, features{}, addons[]
            /api/all (fallback)  nodes[].node
   Exposes: window.CONFIG        the normalised config object (+ helpers)
            window.loadConfig()  -> Promise<CONFIG>   (cached)
            window.loadScripts() sequential <script> loader, order preserved
   --------------------------------------------------------------------------- */
(function () {
  'use strict';

  /* accents by node index when the server does not configure one:
     cyan, amber, violet, green, rose, gold */
  var NODE_ACCENTS = ['#5ad7ff', '#ffb347', '#9b8cff', '#37f5a0', '#ff4fa3', '#ffd166'];
  var DEFAULT_PALETTE = { ai: '#ff4fa3', media: '#38e1ff', network: '#37f5a0', monitor: '#ffb347',
                          web: '#9b8cff', infra: '#8fb0d0', stopped: '#ff5a6a' };
  var DEFAULT_CATS = ['ai', 'media', 'network', 'monitor', 'web', 'infra'];
  var CAT_NAMES = { ai: 'AI / inference', media: 'Media', network: 'Network', monitor: 'Monitoring',
                    web: 'Web / apps', infra: 'Infra' };
  var DEFAULT_FEATURES = { nexus: true, cameras: false, threats: true, audience: true,
                           lights: false, doom: false, setup: true, chat: false };

  function hexInt(s, fallback) {
    if (typeof s === 'number') return s;
    var m = /^#?([0-9a-f]{6})$/i.exec(String(s || ''));
    return m ? parseInt(m[1], 16) : (fallback === undefined ? 0x8fb0d0 : fallback);
  }
  function hexStr(v) {
    if (typeof v === 'string') return v.charAt(0) === '#' ? v : '#' + v;
    return '#' + ('00000' + ((v >>> 0) & 0xffffff).toString(16)).slice(-6);
  }
  function titleCase(s) {
    return String(s || '').replace(/[-_]+/g, ' ').replace(/\b([a-z])/g, function (m) { return m.toUpperCase(); });
  }

  function normalise(raw) {
    raw = raw || {};
    var cfg = {
      version: raw.version || '',
      demo: !!raw.demo,
      brand: String(raw.brand || 'GALAXY'),
      domain: String(raw.domain || ''),
      tagline: String(raw.tagline || 'live topology · flows · telemetry'),
      wan_label: String(raw.wan_label || 'ISP'),
      categories: Array.isArray(raw.categories) && raw.categories.length ? raw.categories.slice() : DEFAULT_CATS.slice(),
      palette: {}, features: {}, addons: Array.isArray(raw.addons) ? raw.addons.slice() : [],
      nodes: []
    };
    var pal = raw.palette || {};
    Object.keys(DEFAULT_PALETTE).forEach(function (k) { cfg.palette[k] = hexStr(pal[k] || DEFAULT_PALETTE[k]); });
    cfg.categories.forEach(function (c, i) {
      if (!cfg.palette[c]) cfg.palette[c] = hexStr(pal[c] || NODE_ACCENTS[i % NODE_ACCENTS.length]);
    });
    Object.keys(DEFAULT_FEATURES).forEach(function (k) {
      cfg.features[k] = (raw.features && raw.features[k] !== undefined) ? !!raw.features[k] : DEFAULT_FEATURES[k];
    });
    (Array.isArray(raw.nodes) ? raw.nodes : []).forEach(function (n, i) {
      if (!n) return;
      var id = typeof n === 'string' ? n : n.id;
      if (!id) return;
      cfg.nodes.push({
        id: String(id),
        label: String((typeof n === 'object' && n.label) || id).toUpperCase(),
        accent: hexStr((typeof n === 'object' && n.accent) || NODE_ACCENTS[i % NODE_ACCENTS.length]),
        index: i
      });
    });

    /* ---- helpers the modules share ---- */
    cfg.hex = hexInt;                       // '#5ad7ff' -> 0x5ad7ff
    cfg.hexStr = hexStr;                    // 0x5ad7ff -> '#5ad7ff'
    cfg.catName = function (c) { return CAT_NAMES[c] || titleCase(c); };
    cfg.catHex = function (c) { return hexInt(cfg.palette[c] || cfg.palette.infra); };
    cfg.catRgb = function (c) { var v = cfg.catHex(c); return [v >> 16 & 255, v >> 8 & 255, v & 255]; };
    cfg.nodeById = function (id) {
      id = String(id || '').replace(/^(host:)?pve:/, '');
      for (var i = 0; i < cfg.nodes.length; i++) if (cfg.nodes[i].id === id) return cfg.nodes[i];
      return null;
    };
    cfg.nodeIndex = function (id) { var n = cfg.nodeById(id); return n ? n.index : -1; };
    cfg.nodeLabel = function (id) { var n = cfg.nodeById(id); return n ? n.label : String(id || '').replace(/^(host:)?pve:/, '').toUpperCase(); };
    cfg.nodeAccent = function (id) {          // '#rrggbb', palette-by-index when unknown
      var n = cfg.nodeById(id); if (n) return n.accent;
      return NODE_ACCENTS[Math.abs(hashStr(String(id))) % NODE_ACCENTS.length];
    };
    cfg.accentByIndex = function (i) { return NODE_ACCENTS[((i % NODE_ACCENTS.length) + NODE_ACCENTS.length) % NODE_ACCENTS.length]; };
    /* the node a tour stop key belongs to: 'host:pve:<id>' / 'blk:pve:<id>:<cat>' -> '<id>' */
    cfg.nodeFromKey = function (key) {
      var m = /^(?:host|blk):pve:([^:]+)/.exec(String(key || ''));
      return m ? m[1] : null;
    };
    cfg.brandHtml = function () {
      var b = cfg.brand, m = /^(\S+)[\s_-]+(.+)$/.exec(b);
      if (m) return esc(m[1]) + ' <span>' + esc(m[2]) + '</span>';
      var k = Math.ceil(b.length / 2);
      return esc(b.slice(0, k)) + '<span>' + esc(b.slice(k)) + '</span>';
    };
    return cfg;
  }
  function hashStr(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function fetchJson(url, ms) {
    return new Promise(function (resolve, reject) {
      var done = false, t = setTimeout(function () { if (!done) { done = true; reject(new Error('timeout')); } }, ms || 4000);
      fetch(url, { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : Promise.reject(new Error(r.status)); })
        .then(function (j) { if (!done) { done = true; clearTimeout(t); resolve(j); } })
        .catch(function (e) { if (!done) { done = true; clearTimeout(t); reject(e); } });
    });
  }

  var pending = null;
  window.CONFIG = normalise(window.CONFIG_PRELOAD || null);   // usable synchronously, refined below
  window.loadConfig = function () {
    if (pending) return pending;
    pending = fetchJson('/api/config', 5000).then(function (raw) {
      window.CONFIG = normalise(raw);
      return window.CONFIG;
    }).catch(function () {
      /* older back end / server down: brand GALAXY, nodes from /api/all */
      return fetchJson('/api/all', 5000).then(function (d) {
        var ids = [];
        ((d && d.nodes) || []).forEach(function (n) { if (n && n.node && ids.indexOf(n.node) < 0) ids.push(n.node); });
        window.CONFIG = normalise({ nodes: ids });
        console.warn('config: /api/config unavailable, derived ' + ids.length + ' node(s) from /api/all');
        return window.CONFIG;
      }).catch(function () {
        window.CONFIG = normalise(null);
        console.warn('config: no API reachable, running with defaults');
        return window.CONFIG;
      });
    }).then(function (cfg) {
      try { document.documentElement.dataset.brand = cfg.brand; } catch (e) { }
      try { window.dispatchEvent(new CustomEvent('galaxy:config', { detail: cfg })); } catch (e) { }
      return cfg;
    });
    return pending;
  };

  /* sequential loader: each file is appended only after the previous one ran,
     so the load-order contracts in the module headers hold exactly as with
     static <script> tags */
  window.loadScripts = function (urls, done) {
    var i = 0;
    (function next() {
      if (i >= urls.length) { if (done) done(); return; }
      var s = document.createElement('script');
      s.src = urls[i++]; s.async = false;
      s.onload = next; s.onerror = function () { console.error('failed to load ' + s.src); next(); };
      document.body.appendChild(s);
    })();
  };
})();
