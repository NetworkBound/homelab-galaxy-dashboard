/* story.js - the wall's one large line. Loaded by hero.js.

   One measured fact per tour stop, centred inside the 9:16 centre crop so a phone
   filming the wall can read it. The text comes from the story candidates tour.py
   builds (/api/tour: aspects[].story, systems[].story + cats, links[].story,
   estate.story) and is published through lightsync (NB_STORY.tick), so the TV shows
   the identical string on the same beat.

   Rules kept here, whatever the server sends:
     - it changes on an arrival, and at most once more, on the 2-bar boundary of a
       3-bar hold (overviews, the stream ride); never in between
     - one line: <= 48 characters AND <= 560 px as really rendered (the glyphs are
       measured; 48 characters of 26 px Inter can be ~660 px wide)
     - no question, no slogan, no address; nothing when no fact was measured
   window.NB_SAFE.story = {x, y, w, h} (CSS px) while a line is up, else null. */
(function () {
  'use strict';
  if (window.NB_STORY) return;

  var MAXC = 48, MAXW = 560, FADE = 420, KEEP = 6, STALE = 600,
      BAD = /[?!]|did you know|orbit|galaxy|now showing|\d+\.\d+\.\d+\.\d+/i,
      RANK = { status: 0, rate: 1, count: 2, age: 3 },
      BITS = /\d\s*[kMG]?b\/s/;        // a bit rate ("85.1 Mb/s", "797 kb/s")

  var S = { el: null, m: null, front: 0, text: '', arr: -1, key: '', pool: '', list: [], swapped: true, wait: true,
            cur: {}, recent: [], changes: 0, log: [], clr: 0 };

  function css() {
    if (document.getElementById('story-css')) return;
    var f = 'font:500 26px/34px var(--ui-font,Inter,system-ui,sans-serif);letter-spacing:0;font-variant-numeric:tabular-nums;white-space:nowrap;';
    var s = document.createElement('style');
    s.id = 'story-css';
    s.textContent = [
      /* the caption (#cin) measures 68-69 px with its facts row and sits at --sy - 2px: 60 px clear above it */
      '#story{position:fixed;z-index:6;left:50%;bottom:calc(var(--sy,64px) + 127px);transform:translateX(-50%);',
      '  display:none;justify-items:center;max-width:' + MAXW + 'px;height:34px;pointer-events:none;',
      '  ' + f + 'color:#f1f4f8;text-align:center;transition:opacity .45s ease;',
      '  text-shadow:0 0 2px rgba(2,4,8,.95),0 0 6px rgba(2,4,8,.9),0 0 14px rgba(2,4,8,.7),0 0 26px rgba(2,4,8,.45)}',
      'body.hero #story{display:grid}',
      'body.nb-asleep #story{opacity:0}',
      '#story span{grid-area:1/1;opacity:0;transition:opacity ' + FADE + 'ms ease}',
      '#story span.on{opacity:1}',
      '#story-m{position:fixed;left:-9999px;top:0;visibility:hidden;pointer-events:none;' + f + '}'
    ].join('\n');
    document.head.appendChild(s);
  }

  function build() {
    if (S.el || !document.body) return;
    css();
    var e = document.createElement('div');
    e.id = 'story';
    e.innerHTML = '<span></span><span></span>';
    document.body.appendChild(e);
    var m = document.createElement('span');
    m.id = 'story-m';
    m.setAttribute('aria-hidden', 'true');
    document.body.appendChild(m);
    S.el = e; S.m = m;
  }

  /* the same checks tour.py applies, plus the real glyph width */
  function fits(t) {
    if (typeof t !== 'string' || !t || t.length > MAXC || BAD.test(t)) return false;
    S.m.textContent = t;
    return S.m.getBoundingClientRect().width <= MAXW;
  }

  function byId(list, id) {
    for (var i = 0; i < (list || []).length; i++) if (list[i] && list[i].id === id) return list[i];
    return null;
  }

  /* Where the caption prints a bit rate of its own for the same subject, the story says something
     else: the two are read at different instants (and at the edge from different counters), and two
     different rates on one screen read as a mistake. */
  function noBits(list) {
    return (list || []).filter(function (c) { return c && !BITS.test(String(c.text)); });
  }

  /* which candidates belong to this stop: {id, list}; null when there is nothing to say */
  function pool(st, NS) {
    var d = NS.tourData, k = String(st.key || ''), U = NS.U, i;
    if (!d || (d.ts && Date.now() / 1000 - d.ts > STALE)) return null;
    if (k.indexOf('over') === 0) return { id: 'estate', list: d.estate && d.estate.story };
    if (k === 'wan' || k.indexOf('asp:') === 0) {
      var ak = k === 'wan' ? 'asp:internet' : k, as = d.aspects || [];
      for (i = 0; i < as.length; i++) if (as[i] && as[i].key === ak) {
        if (k !== 'wan') return { id: ak, list: as[i].story };
        /* the caption at the edge prints the gateway's own rate reading and the aspect's rate comes
           from the WAN counters, so no rate here */
        return { id: 'wan', list: noBits(as[i].story) };
      }
      return null;
    }
    if (st.stream) {
      var a = st.stream.from, b = st.stream.to, ls = d.links || [];
      for (i = 0; i < ls.length; i++)
        if (ls[i] && ((ls[i].a === a && ls[i].b === b) || (ls[i].a === b && ls[i].b === a))) return { id: 'link:' + ls[i].a + '>' + ls[i].b, list: ls[i].story };
      return null;
    }
    var sid = st.sysId, cat = '';
    if (k.indexOf('blk:') === 0) {
      var cut = k.lastIndexOf(':'), hub = k.slice(4, cut), sy = U && U.sysByAnchor ? U.sysByAnchor[hub] : null;
      cat = k.slice(cut + 1);
      sid = sy ? sy.id : hub.replace(/^pve:/, 'sys:');
    } else if (!sid && k.indexOf('sys:') === 0) sid = k;
    var sys = sid ? byId(d.systems, sid) : null;
    if (!sys) return null;
    if (!cat) return { id: sid, list: sys.story };
    /* a category stop: the caption prints the live in/out of these guests, so the line is the
       category's count ("12 monitoring guests running on PVE2"), never its rate; a
       category with nothing else to say borrows the host's own line */
    var cl = noBits(sys.cats && sys.cats[cat]);
    return cl.length ? { id: sid + '/' + cat, list: cl } : { id: sid, list: noBits(sys.story) };
  }

  /* Will this stop have a line? The arrival's own answer once the tour is there; on the way in
     (the caption hands over at the half-way mark, before the arrival) the same pool and fit the
     arrival will use. cinema.js asks before it prints a rate of its own at the stream stop, so
     the answer must not flip during a hold: after the arrival it is S.list, fixed until the next. */
  function has(st, NS) {
    NS = NS || window.NETSCENE;
    var TR = NS && NS.tour, k = st ? String(st.key || '') : '';
    if (!S.el || !TR || !k || S.arr < 0) return false;
    if (k === S.key) return S.list.length > 0;
    /* the stop that was up when the layer woke gets no line: the first one waits for an arrival */
    if (S.wait && !(TR.phase === 'travel' && TR.stops && TR.stops[TR.next] === st)) return false;
    var p = pool(st, NS), L = (p && Array.isArray(p.list)) ? p.list : [];
    for (var i = 0; i < L.length; i++) if (L[i] && fits(L[i].text)) return true;
    return false;
  }

  /* round-robin through the stop's lines, so a second lap says something else; skip the
     line that is up and, while there is a choice, anything shown in the last few stops */
  function pick() {
    var L = S.list, n = L.length, c = S.cur[S.pool] || 0, pass, i, k, t;
    for (pass = 0; pass < 3; pass++)
      for (i = 0; i < n; i++) {
        k = (c + i) % n; t = L[k].text;
        if (pass < 2 && t === S.text) continue;
        if (!pass && S.recent.indexOf(t) >= 0) continue;
        S.cur[S.pool] = k + 1;
        return L[k];
      }
    return null;
  }

  function safe() {
    var r = S.el && S.text ? S.el.getBoundingClientRect() : null;
    (window.NB_SAFE = window.NB_SAFE || {}).story = (r && r.width > 0) ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
  }

  function show(t) {
    if (!S.el || t === S.text) return S.text;
    var sp = S.el.children, o = sp[S.front], n = sp[S.front ^= 1];
    S.text = t; S.changes++;
    n.textContent = t; n.className = t ? 'on' : ''; o.className = '';
    clearTimeout(S.clr);
    S.clr = setTimeout(function () { o.textContent = ''; safe(); }, FADE + 60);   // the box shrinks to the new line once the old one is gone
    if (t) { S.recent.push(t); if (S.recent.length > KEEP) S.recent.shift(); }
    S.log.push({ at: Date.now(), key: S.key, text: t });
    if (S.log.length > 120) S.log.shift();
    safe();
    return t;
  }

  function arrive(st, NS) {
    var p = st ? pool(st, NS) : null, L = [];
    ((p && Array.isArray(p.list)) ? p.list : []).forEach(function (c) { if (c && fits(c.text)) L.push(c); });
    /* status changes > rates > counts > ages, then the server's own order */
    L.sort(function (x, y) {
      return ((RANK[x.kind] == null ? 2 : RANK[x.kind]) - (RANK[y.kind] == null ? 2 : RANK[y.kind])) || ((+x.prio || 0) - (+y.prio || 0));
    });
    S.key = st ? String(st.key) : ''; S.pool = p ? p.id : ''; S.list = L; S.wait = false;
    var bar = 240 / (NS.bpm || 150), hold = NS.holdFor && st ? NS.holdFor(st) : 0;
    S.swapped = !(hold >= 3 * bar - 0.05 && L.length > 1);
    var c = (L[0] && L[0].kind === 'status' && L[0].text !== S.text) ? L[0] : pick();   // a status change is news on every lap
    show(c ? c.text : '');
  }

  /* Called by lightsync in the pass that counts the arrival beat (so the new line rides
     in the arrival's own post) and by the timer below. Returns the line that is up. */
  function tick() {
    var NS = window.NETSCENE, TR = NS && NS.tour, b = document.body;
    if (!S.el) return '';
    if (!TR || !TR.stops || !TR.stops.length || TR.manual || !b.classList.contains('hero') || b.classList.contains('nb-asleep') ||
        (b.dataset.doom && b.dataset.doom.indexOf('phase=off') !== 0)) {
      var off = show('');
      S.arr = -1; S.key = ''; S.list = []; S.wait = true;      // has(): nothing is promised while the layer is off
      return off;
    }
    var arr = NS.qaArrivals || 0, st = TR.stops[TR.idx];
    if (S.arr < 0) S.arr = arr;                          // the first line waits for an arrival, like every other
    else if (arr !== S.arr) { S.arr = arr; arrive(st, NS); }
    else if (!S.swapped && TR.phase === 'hold' && st && st.key === S.key &&
             NS.t - TR.tHold >= 2 * 240 / (NS.bpm || 150) - 0.02) {
      S.swapped = true;
      var c = pick();
      if (c) show(c.text);
    }
    return S.text;
  }

  function boot() {
    build();
    setInterval(tick, 100);
    window.addEventListener('resize', safe);
  }

  window.NB_STORY = { v: 2, tick: tick, state: S, fits: fits, has: has,
                      get text() { return S.text; } };
  if (document.body) boot(); else document.addEventListener('DOMContentLoaded', boot);
})();
