const SVG = 'http://www.w3.org/2000/svg';
const REFRESH_MS = 5 * 60 * 1000;

let state = null;
let lastGood = null;
let redraw = null;              // chart repaint hook for the mounted view
let sort = { key: 'activity', dir: -1 };

// ---- primitives -----------------------------------------------------------

const $ = (id) => document.getElementById(id);

const el = (tag, props = {}, children = []) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of [].concat(children)) if (c != null && c !== false) node.append(c.nodeType ? c : document.createTextNode(c));
  return node;
};
const svgEl = (tag, attrs = {}) => {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};
const ext = (href, text, className) => el('a', { href, className, target: '_blank', rel: 'noopener noreferrer' }, text);

const globeIcon = () => {
  const n = svgEl('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': '1.6', 'stroke-linecap': 'round', 'aria-hidden': 'true' });
  n.innerHTML = '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/>';
  return n;
};

const money = (n, currency = 'USD', digits = 2) => n.toLocaleString('en-US', {
  style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits,
});
const num = (n, digits = 2) => n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const pct = (n, digits = 1) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(digits)}%`;
const dirClass = (n) => (n == null ? '' : n >= 0 ? 'up' : 'down');

const asDate = (iso) => new Date(`${iso}T12:00:00Z`);
const fmtDate = (iso, opts = { month: 'short', day: 'numeric', year: 'numeric' }) =>
  asDate(iso).toLocaleDateString('en-US', { ...opts, timeZone: 'UTC' });
const clockFmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

function ago(ms) {
  if (!ms) return '';
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

const TREND_GLYPH = { up: '↑', down: '↓', flat: '→', unknown: '·' };
const trendEl = (t) => el('span', {
  className: `trend trend-${t}`,
  title: t === 'unknown' ? 'No baseline yet — needs more history' : `Activity ${t}`,
}, TREND_GLYPH[t] ?? '·');

// ten segments, filled proportionally — comparable across rows at a glance
function activityBar(score, level, max) {
  // A silent subject gets an empty bar — one lit segment would read as activity.
  const filled = score > 0 ? Math.max(1, Math.round((score / (max || 1)) * 10)) : 0;
  const bar = el('span', { className: `bar ${level}`, title: `Activity score ${score}` });
  for (let i = 0; i < 10; i += 1) bar.append(el('i', { className: i < filled ? 'on' : '' }));
  return bar;
}

function sparkline(market, w = 76, h = 16) {
  const hist = (market.history ?? []).slice(-30);
  const node = svgEl('svg', { width: w, height: h, viewBox: `0 0 ${w} ${h}`, 'aria-hidden': 'true' });
  if (hist.length < 2) return node;
  const lo = Math.min(...hist), hi = Math.max(...hist), span = hi - lo || 1;
  const pts = hist.map((v, i) => `${(i / (hist.length - 1) * w).toFixed(1)},${(h - 1 - ((v - lo) / span) * (h - 2)).toFixed(1)}`);
  node.append(svgEl('polyline', {
    points: pts.join(' '), fill: 'none', 'stroke-width': 1.2,
    stroke: (market.changePct ?? 0) >= 0 ? 'var(--up)' : 'var(--down)',
  }));
  return node;
}

const subjectHref = (s) => (s.id ? `#/situation/${s.id}` : `#/world/${s.slug}`);
const allSubjects = () => [...(state.situations ?? []), ...(state.watchlist ?? [])];

function duration(startIso) {
  const start = asDate(startIso), now = new Date();
  let months = (now.getUTCFullYear() - start.getUTCFullYear()) * 12 + (now.getUTCMonth() - start.getUTCMonth());
  const anchorAt = (m) => Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + m, start.getUTCDate(), 12);
  if (anchorAt(months) > now.getTime()) months -= 1;
  const days = Math.round((now.getTime() - anchorAt(months)) / 86400000);
  const part = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (months >= 12) {
    const y = Math.floor(months / 12), r = months % 12;
    return r ? `${part(y, 'year')}, ${part(r, 'month')}` : part(y, 'year');
  }
  return months >= 1 ? `${part(months, 'month')}, ${part(days, 'day')}` : part(days, 'day');
}

const sinceStart = (market, from) => {
  const seg = (market?.series ?? []).filter((p) => p.d >= from);
  if (seg.length < 2) return null;
  return { pct: ((seg.at(-1).c / seg[0].c) - 1) * 100, now: seg.at(-1).c };
};

const KIND = { strike: 'k-strike', diplomacy: 'k-diplomacy', economic: 'k-economic' };
const kindColor = (k) => ({ strike: 'var(--high)', diplomacy: 'var(--up)', economic: 'var(--medium)' }[k] ?? 'var(--mid)');

// ---- section helpers ------------------------------------------------------

const sectionLabel = (title, note, right) => el('div', { className: 'section-label' }, [
  el('h2', {}, title),
  note ? el('span', { className: 'note' }, note) : null,
  right ? el('span', { className: 'right' }, right) : null,
]);
const subLabel = (title, right) => el('div', { className: 'sub-label' }, [
  title, right ? el('span', { className: 'right' }, right) : null,
]);
// used only by the market board, so the treatment cannot leak to other views
const groupLabel = (title) => el('div', { className: 'sub-label is-group' }, title);

// ---- chart ----------------------------------------------------------------

function niceTicks(min, max, target = 4) {
  const rough = ((max - min) || 1) / target;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) ticks.push(Number(v.toFixed(10)));
  return { ticks, step };
}

function drawChart(wrap, market, events, fromDate, height = 240) {
  const series = (market?.series ?? []).filter((p) => !fromDate || p.d >= fromDate);
  wrap.replaceChildren();
  if (series.length < 2) { wrap.append(el('p', { className: 'muted' }, 'No price history.')); return; }

  const width = Math.max(wrap.clientWidth || 860, 320);
  const m = { t: 14, r: 12, b: 26, l: 58 };
  const plotW = width - m.l - m.r, plotH = height - m.t - m.b;
  const closes = series.map((p) => p.c);
  const lo = Math.min(...closes), hi = Math.max(...closes);
  const padY = (hi - lo) * 0.1 || 1;
  const yMin = lo - padY, yMax = hi + padY;
  const x = (i) => m.l + (i / (series.length - 1)) * plotW;
  const y = (v) => m.t + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'img',
    'aria-label': `${market.label} price history` });

  const { ticks, step } = niceTicks(lo - padY * 0.3, hi + padY * 0.3, 4);
  // Trillions spelled out in full make an unreadable axis; abbreviate the big ones.
  const axisLabel = (t) => {
    const a = Math.abs(t);
    if (a >= 1e12) return `$${(t / 1e12).toFixed(1)}T`;
    if (a >= 1e9) return `$${(t / 1e9).toFixed(0)}B`;
    if (a >= 1e6) return `$${(t / 1e6).toFixed(0)}M`;
    return money(t, market.currency ?? 'USD', step >= 1 ? 0 : 2);
  };
  for (const t of ticks) {
    svg.append(svgEl('line', { class: 'grid-line', x1: m.l, x2: m.l + plotW, y1: y(t), y2: y(t) }));
    const label = svgEl('text', { class: 'axis-text y', x: m.l - 10, y: y(t) + 3.5 });
    label.textContent = axisLabel(t);
    svg.append(label);
  }

  const spanDays = (asDate(series.at(-1).d) - asDate(series[0].d)) / 86400000;
  const grain = spanDays > 900 ? 'year' : spanDays > 260 ? 'quarter' : 'month';
  let lastKey = null;
  series.forEach((p, i) => {
    const date = asDate(p.d), month = date.getUTCMonth();
    if (grain === 'quarter' && month % 3 !== 0) return;
    const key = grain === 'year' ? p.d.slice(0, 4) : p.d.slice(0, 7);
    if (key === lastKey) return;
    lastKey = key;
    if (i === 0 && series.length > 20) return;
    const label = svgEl('text', { class: 'axis-text', x: x(i), y: height - 8, 'text-anchor': 'middle' });
    label.textContent = grain === 'year' ? p.d.slice(0, 4)
      : date.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })
        + (grain === 'quarter' && month === 0 ? ` ’${p.d.slice(2, 4)}` : '');
    svg.append(label);
  });

  svg.append(svgEl('path', { class: 'price-line', d: series.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.c).toFixed(1)}`).join(' ') }));

  const marks = [];
  for (const ev of events ?? []) {
    let idx = -1;
    for (let i = 0; i < series.length; i += 1) if (series[i].d <= ev.date) idx = i;
    if (idx < 0) idx = 0;
    marks.push({ ev, idx });
  }
  for (const { ev, idx } of marks) {
    const g = svgEl('g', { class: 'event-marker', tabindex: '0', role: 'button', 'aria-label': `${fmtDate(ev.date)}: ${ev.action}` });
    g.append(svgEl('circle', { class: 'hit', cx: x(idx), cy: y(series[idx].c), r: 6, fill: 'transparent' }));
    g.append(svgEl('circle', { cx: x(idx), cy: y(series[idx].c), r: 3.5, fill: 'var(--bg)', stroke: kindColor(ev.kind), 'stroke-width': 1.75 }));
    const open = () => {
      const node = $(`ev-${ev.id}`);
      if (node) { node.open = true; node.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    };
    g.addEventListener('click', open);
    g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    svg.append(g);
  }

  const crosshair = svgEl('line', { class: 'crosshair', y1: m.t, y2: m.t + plotH, opacity: 0 });
  const focus = svgEl('circle', { class: 'focus-dot', r: 4, opacity: 0 });
  svg.append(crosshair, focus, svgEl('rect', { x: m.l, y: m.t, width: plotW, height: plotH, fill: 'transparent' }));

  const tip = el('div', { className: 'tooltip' });
  const tipPrice = el('div', { className: 'tt-price' });
  const tipDate = el('div', { className: 'tt-date' });
  tip.append(tipPrice, tipDate);
  const byIdx = new Map(marks.map(({ ev, idx }) => [idx, ev]));

  const show = (clientX) => {
    const rect = svg.getBoundingClientRect(), scale = width / rect.width;
    let i = Math.round((((clientX - rect.left) * scale - m.l) / plotW) * (series.length - 1));
    i = Math.max(0, Math.min(series.length - 1, i));
    const p = series[i];
    crosshair.setAttribute('x1', x(i)); crosshair.setAttribute('x2', x(i)); crosshair.setAttribute('opacity', 1);
    focus.setAttribute('cx', x(i)); focus.setAttribute('cy', y(p.c)); focus.setAttribute('opacity', 1);
    tipPrice.textContent = Math.abs(p.c) >= 1e9
      ? `$${(p.c / 1e12).toFixed(3)}T`
      : money(p.c, market.currency ?? 'USD');
    tipDate.textContent = fmtDate(p.d);
    tip.querySelector('.tt-event')?.remove();
    const near = byIdx.get(i) ?? byIdx.get(i - 1) ?? byIdx.get(i + 1);
    if (near) tip.append(el('div', { className: 'tt-event' }, [
      el('b', {}, `${near.actor} · ${fmtDate(near.date, { month: 'short', day: 'numeric' })}`),
      near.action.split(/(?<=\.)\s/)[0],
    ]));
    tip.classList.add('is-visible');
    const tw = tip.offsetWidth || 150;
    tip.style.left = `${Math.max(0, Math.min(rect.width - tw, (x(i) / scale) - tw / 2))}px`;
    tip.style.top = `${Math.max(0, (y(p.c) / scale) - tip.offsetHeight - 12)}px`;
  };
  const hide = () => {
    crosshair.setAttribute('opacity', 0); focus.setAttribute('opacity', 0);
    tip.classList.remove('is-visible');
  };
  svg.addEventListener('mousemove', (e) => show(e.clientX));
  svg.addEventListener('mouseleave', hide);
  svg.addEventListener('touchmove', (e) => { if (e.touches[0]) show(e.touches[0].clientX); }, { passive: true });
  svg.addEventListener('touchend', hide);
  wrap.append(svg, tip);
}



// ---- info tips ------------------------------------------------------------
// Provenance and methodology belong with the thing they describe, but not as
// body copy competing with it. A tip keeps the note one click away.

let openTip = null;

function closeTip() {
  openTip?.classList.remove('is-open');
  openTip = null;
}

document.addEventListener('click', (e) => { if (openTip && !openTip.contains(e.target)) closeTip(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeTip(); });

function infoTip(...content) {
  const wrap = el('span', { className: 'tip' });
  const btn = el('button', { className: 'tip-btn', type: 'button', 'aria-label': 'Source and method' }, 'i');
  const pop = el('span', { className: 'tip-pop', role: 'note' }, content.flat());
  wrap.append(btn, pop);

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const wasOpen = wrap.classList.contains('is-open');
    closeTip();
    if (wasOpen) return;
    wrap.classList.add('is-open');
    openTip = wrap;
    // flip to the left of the button when it would run off the right edge
    const box = pop.getBoundingClientRect();
    pop.classList.toggle('align-right', box.right > window.innerWidth - 12);
  });
  return wrap;
}

// ---- pull-out drawer ------------------------------------------------------

let drawerEls = null;

function closeDrawer() {
  if (!drawerEls) return;
  drawerEls.panel.classList.remove('is-open');
  drawerEls.veil.classList.remove('is-open');
  document.body.style.overflow = '';
  setTimeout(() => { drawerEls?.root.remove(); drawerEls = null; }, 220);
}

function openDrawer(title, subtitle, build, note) {
  closeDrawer();
  const veil = el('div', { className: 'veil' });
  const close = el('button', { className: 'ghost drawer-close', type: 'button', 'aria-label': 'Close' }, '✕');
  const panel = el('aside', {
    className: 'drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': title,
  }, [
    el('header', { className: 'drawer-head' }, [
      el('div', {}, [
        el('h2', {}, [title, note ?? null]),
        subtitle ? el('p', { className: 'drawer-sub' }, subtitle) : null,
      ]),
      close,
    ]),
    el('div', { className: 'drawer-body' }, build()),
  ]);
  const root = el('div', { className: 'drawer-root' }, [veil, panel]);
  document.body.append(root);
  document.body.style.overflow = 'hidden';
  drawerEls = { root, panel, veil };

  veil.addEventListener('click', closeDrawer);
  close.addEventListener('click', closeDrawer);
  requestAnimationFrame(() => { panel.classList.add('is-open'); veil.classList.add('is-open'); });
  // rAF does not fire in a background tab, so make sure it opens regardless
  setTimeout(() => { panel.classList.add('is-open'); veil.classList.add('is-open'); }, 30);
  close.focus();
}

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

function aidDrawerBody() {
  const aid = state.aid;
  if (!aid) {
    return el('p', { className: 'footnote' },
      `Unavailable. ${state.aidError ?? ''} Nothing is shown in its place.`);
  }

  const span = (p) => `${fmtDate(p.start, { month: 'short', day: 'numeric' })} – ${fmtDate(p.end, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  const yoy = aid.priorTotal ? ((aid.total - aid.priorTotal) / aid.priorTotal) * 100 : null;
  const compact = (n) => bigMoney(n).replace(' billion', 'B').replace(' million', 'M');

  const max = Math.max(...aid.countries.map((c) => Math.max(c.amount, c.lastFullAmount)), 1);
  const list = el('div', { className: 'aid-list' });
  const search = el('input', { className: 'drawer-search', type: 'search', placeholder: 'Filter countries' });

  const paint = () => {
    const q = search.value.trim().toLowerCase();
    const rows = aid.countries.filter((c) => !q || c.name.toLowerCase().includes(q));
    list.replaceChildren(...(rows.length ? rows.map((c, i) => el('div', { className: 'aid-row' }, [
      el('span', { className: 'aid-rank' }, String(i + 1)),
      el('span', { className: 'aid-name' }, c.name),
      el('span', { className: 'aid-amt' }, c.amount ? compact(c.amount) : '—'),
      el('span', { className: 'aid-amt prior' }, c.lastFullAmount ? compact(c.lastFullAmount) : '—'),
      el('span', { className: 'aid-bar' }, [
        el('i', { style: `width:${Math.max(c.amount ? 1 : 0, (c.amount / max) * 100)}%` }),
        el('u', { style: `width:${Math.max(c.lastFullAmount ? 1 : 0, (c.lastFullAmount / max) * 100)}%` }),
      ]),
    ])) : [el('p', { className: 'footnote' }, 'No country matches.')]));
  };
  search.addEventListener('input', paint);
  paint();

  return [
    el('div', { className: 'aid-summary' }, [
      el('div', {}, [
        el('span', { className: 'figure-k' }, `FY${aid.fiscalYear} to date`),
        el('span', { className: 'figure-v' }, bigMoney(aid.total)),
        el('span', { className: 'figure-note' }, span(aid.period)),
      ]),
      el('div', {}, [
        el('span', { className: 'figure-k' }, 'Same window last year'),
        el('span', { className: 'figure-v' }, [
          compact(aid.priorTotal),
          yoy != null ? el('span', { className: `aid-yoy ${yoy >= 0 ? 'up' : 'down'}` },
            ` ${yoy >= 0 ? '+' : '−'}${Math.abs(yoy).toFixed(0)}%`) : null,
        ]),
        el('span', { className: 'figure-note' }, span(aid.priorPeriod)),
      ]),
      el('div', {}, [
        el('span', { className: 'figure-k' }, `FY${aid.lastFullYear.fiscalYear} full year`),
        el('span', { className: 'figure-v' }, compact(aid.lastFullYear.total)),
        el('span', { className: 'figure-note' }, `${aid.lastFullYear.countries} countries`),
      ]),
    ]),
    el('div', { className: 'aid-head' }, [
      el('span', {}, `${aid.countries.length} countries`),
      el('span', { className: 'aid-head-cols' }, [
        el('span', {}, `FY${aid.fiscalYear} to date`),
        el('span', { className: 'prior' }, `FY${aid.lastFullYear.fiscalYear} full`),
      ]),
    ]),
    search,
    list,
  ];
}

// ---- level 1: pulse -------------------------------------------------------

function attentionRows() {
  const subjects = allSubjects().filter((s) => s.activity.score > 0);
  const max = Math.max(...subjects.map((s) => s.activity.score), 1);
  const ranked = subjects.sort((a, b) => b.activity.score - a.activity.score).slice(0, 6);

  return ranked.map((s) => {
    const a = s.activity;
    const evidence = [];
    if (a.events7) evidence.push(`${a.events7} developments this week`);
    if (a.mentions24) evidence.push(`${a.mentions24} on the wire today`);

    // The latest thing said about this subject, so Attention carries the news
    // itself rather than pointing at a separate list of it.
    const latestStory = a.topStories[0];
    const latestEvent = s.timeline
      ? [...s.timeline].sort((x, y) => y.date.localeCompare(x.date))[0] : null;
    const line = latestStory
      ? { text: latestStory.title, meta: `${latestStory.outlets.join(' · ')} · ${ago(latestStory.time)}` }
      : latestEvent
        ? { text: latestEvent.action.split(/(?<=\.)\s/)[0], meta: `${latestEvent.actor} · ${fmtDate(latestEvent.date)}` }
        : null;

    return el('a', { className: 'row row-attention', href: subjectHref(s) }, [
      el('span', { className: 'subject' }, [s.name.replace(/\s*War$/, ''),
        s.region ? el('span', { className: 'subject-region' }, s.region) : null]),
      activityBar(a.score, a.level, max),
      trendEl(a.trend),
      el('span', { className: `level level-${a.level}` }, a.level),
      el('span', { className: 'detail' }, evidence.join(' · ') || 'quiet'),
      line ? el('span', { className: 'row-latest' }, [
        line.text, el('span', { className: 'row-latest-meta' }, line.meta),
      ]) : null,
    ]);
  });
}

// Stories the tracked and watched subjects do not account for — the rest of the
// world, so this section says something Attention does not.
function elsewhereStories(limit = 8) {
  const subjects = allSubjects();
  const norm = (t) => t.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
  const claimed = (title) => subjects.some((x) =>
    (x.keywords ?? []).some((k) => norm(title).includes(k.toLowerCase())));
  return (state.wire ?? []).filter((w) => !claimed(w.title)).slice(0, limit);
}

function renderPulse(host) {
  const domains = state.domains ?? [];
  const markets = state.markets ?? [];
  const movers = markets.filter((m) => m.changePct != null)
    .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));
  const bodies = [...new Set((state.official ?? []).map((o) => o.outlet))];
  const quakes = (state.hazard ?? []).filter((h) => h.outlet === 'USGS');
  const alerts = (state.hazard ?? []).filter((h) => h.outlet === 'NWS');

  const verse = state.scripture;
  const greeting = el('div', { className: 'greeting' }, [
    el('h1', {}, 'Hello, Degen'),
    verse?.text ? el('figure', { className: 'scripture' }, [
      el('blockquote', {}, verse.text),
      el('figcaption', {}, [
        verse.reference,
        verse.translation ? el('span', { className: 'scripture-tr' }, verse.translation) : null,
        verse.note ? el('span', { className: 'scripture-tr', title: verse.note }, 'offline copy') : null,
      ]),
    ]) : null,
  ]);

  const attention = el('section', { className: 'section' }, [
    sectionLabel('Front lines', 'ranked by activity — recency, significance and change',
      domains.every((d) => d.trend === 'unknown') ? 'trend baselines still building' : null),
    ...attentionRows(),
  ]);

  const elsewhere = elsewhereStories();
  const rest = el('section', { className: 'section' }, [
    sectionLabel('The wire', 'stories the front lines do not account for'),
    ...(elsewhere.length
      ? elsewhere.map((w) => el('a', {
        className: 'change', href: w.outlets[0].link, target: '_blank', rel: 'noopener noreferrer',
      }, [
        el('span', { className: 'change-title' }, w.title),
        el('span', { className: 'change-meta' },
          `${w.outlets.map((o) => o.outlet).join(' · ')} · ${ago(w.time)}`),
      ]))
      : [el('p', { className: 'muted' }, 'Everything on the wire maps to a subject you follow.')]),
  ]);

  const overview = el('section', { className: 'section' }, [
    sectionLabel('The board'),
    el('div', { className: 'triad' }, [
      el('div', {}, [
        subLabel('Markets', el('a', { href: '#/markets' }, 'All →')),
        ...movers.slice(0, 6).map((m) => el('a', { className: 'mini', href: '#/markets' }, [
          el('span', { className: 'mini-name' }, m.label),
          el('span', { className: 'spark-cell' }, sparkline(m, 60, 14)),
          el('span', { className: `mini-val ${dirClass(m.changePct)}` }, pct(m.changePct, 2)),
        ])),
      ]),
      el('div', {}, [
        subLabel('Government', el('a', { href: '#/government' }, 'All →')),
        ...bodies.slice(0, 6).map((b) => {
          const items = (state.official ?? []).filter((o) => o.outlet === b);
          return el('a', { className: 'mini', href: '#/government' }, [
            el('span', { className: 'mini-name' }, b),
            el('span', { className: 'muted', style: 'font-size:12px' }, ago(items[0]?.time)),
            el('span', { className: 'mini-val' }, String(items.length)),
          ]);
        }),
      ]),
      el('div', {}, [
        subLabel('Climate & hazard', el('a', { href: '#/climate' }, 'All →')),
        el('a', { className: 'mini', href: '#/climate' }, [
          el('span', { className: 'mini-name' }, 'Extreme weather alerts'),
          el('span', {}), el('span', { className: 'mini-val' }, String(alerts.length)),
        ]),
        el('a', { className: 'mini', href: '#/climate' }, [
          el('span', { className: 'mini-name' }, 'Earthquakes M4.5+ (24h)'),
          el('span', {}), el('span', { className: 'mini-val' }, String(quakes.length)),
        ]),
        el('a', { className: 'mini', href: '#/climate' }, [
          el('span', { className: 'mini-name' }, 'Largest magnitude'),
          el('span', {}),
          el('span', { className: 'mini-val' }, quakes.length ? `M ${Math.max(...quakes.map((q) => q.magnitude ?? 0)).toFixed(1)}` : '—'),
        ]),
      ]),
    ]),
  ]);

  host.replaceChildren(greeting, attention, rest, overview);
}

// ---- level 2: domains -----------------------------------------------------

function renderWorld(host) {
  const subjects = allSubjects();
  const max = Math.max(...subjects.map((s) => s.activity.score), 1);
  const active = subjects.filter((s) => s.activity.score > 0).length;

  const sorters = {
    activity: (a, b) => a.activity.score - b.activity.score,
    subject: (a, b) => a.name.localeCompare(b.name),
    region: (a, b) => (a.region ?? '').localeCompare(b.region ?? ''),
  };
  const rows = [...subjects].sort((a, b) => sorters[sort.key](a, b) * sort.dir);

  const th = (key, label) => el('button', {
    className: sort.key === key ? 'is-sorted' : '', type: 'button',
    onclick: () => {
      sort = sort.key === key ? { key, dir: -sort.dir } : { key, dir: key === 'activity' ? -1 : 1 };
      renderWorld(host);
    },
  }, sort.key === key ? `${label} ${sort.dir < 0 ? '↓' : '↑'}` : label);

  host.replaceChildren(
    el('section', { className: 'section' }, [
      (() => {
        const l = sectionLabel('Conflicts & geopolitics', `${active} active of ${subjects.length} followed`);
        l.append(infoTip(
          'Subjects with a curated timeline carry measured week-on-week trends. The rest are followed by '
          + 'wire coverage only — their level reflects today’s reporting volume, and they show no trend '
          + 'because a day of feeds gives no baseline.',
        ));
        return l;
      })(),
      el('div', { className: 'matrix-head' }, [
        th('subject', 'Subject'), th('region', 'Region'), el('span', {}, 'Activity'),
        el('span', {}, ''), th('activity', 'Level'), el('span', {}, 'Latest'),
      ]),
      ...rows.map((s) => {
        const a = s.activity;
        const latest = s.timeline
          ? [...s.timeline].sort((x, y) => y.date.localeCompare(x.date))[0]
          : null;
        const detail = a.topStories[0]?.title ?? latest?.action.split(/(?<=\.)\s/)[0] ?? '—';
        return el('a', {
          className: `matrix-row${a.level === 'quiet' ? ' is-quiet' : ''}`, href: subjectHref(s),
        }, [
          el('span', { className: 'subject' }, s.name.replace(/\s*War$/, '')),
          el('span', { className: 'region' }, s.region ?? ''),
          activityBar(a.score, a.level, max),
          trendEl(a.trend),
          el('span', { className: `level level-${a.level}` }, a.level),
          el('span', { className: 'detail' }, detail.length > 78 ? `${detail.slice(0, 78)}…` : detail),
        ]);
      }),
    ]),
  );
}

const MKT_GROUPS = ['Energy', 'Metals', 'Currencies', 'Rates', 'Equities', 'Other'];

// Instruments worth glancing at when looking at this one.
const RELATED = {
  brent: ['crude', 'dxy', 'ust10y'], crude: ['brent', 'dxy', 'gas'], gas: ['crude', 'eugas'],
  eugas: ['gas', 'crude', 'wheat'],
  gold: ['ust10y', 'dxy', 'silver'], silver: ['gold', 'copper'], copper: ['sp500', 'usdcny'],
  dxy: ['eurusd', 'usdjpy', 'ust2y'], eurusd: ['dxy', 'ust10y'], usdjpy: ['dxy', 'ust10y'], usdcny: ['dxy', 'copper'],
  ust2y: ['ust10y', 'curve', 'dxy'], ust10y: ['ust2y', 'curve', 'gold'], ust30y: ['ust10y', 'curve'],
  curve: ['ust2y', 'ust10y'], sp500: ['nasdaq', 'russell', 'vix'], nasdaq: ['sp500', 'vix'],
  russell: ['sp500', 'vix'], vix: ['sp500', 'russell'], bitcoin: ['nasdaq', 'dxy'], wheat: ['gas', 'copper'],
};

const isRateFmt = (m) => m.format === 'rate' || m.format === 'spread';

function fmtValue(m) {
  if (m.value == null) return '—';
  if (m.format === 'rate') return `${m.value.toFixed(2)}%`;
  if (m.format === 'spread') return `${m.value >= 0 ? '+' : '−'}${Math.abs(Math.round(m.value * 100))} bp`;
  if (m.format === 'fx') return m.value.toFixed(4);
  if (m.format === 'index') return m.value.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return money(m.value, m.currency ?? 'USD', m.value >= 1000 ? 0 : 2);
}

function fmtChange(m, horizon) {
  const v = m.changes?.[horizon];
  if (v == null) return '—';
  return isRateFmt(m) ? `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v))} bp` : pct(v, horizon === 'd1' ? 2 : 1);
}

const changeClass = (m, horizon) => {
  const v = m.changes?.[horizon];
  if (v == null) return '';
  if (Math.abs(v) < (isRateFmt(m) ? 0.5 : 0.05)) return 'flat';
  return v > 0 ? 'up' : 'down';
};

const freshnessLabel = (m) => {
  const f = m.source?.freshness;
  if (f === 'delayed') return 'Delayed';
  if (f === 'daily official') return 'Official daily';
  if (f === 'daily benchmark') return 'Daily benchmark';
  if (f === 'unavailable') return 'Unavailable';
  return f ?? '';
};

const HORIZONS = [['d1', '1D'], ['d5', '5D'], ['m1', '1M'], ['m3', '3M'], ['ytd', 'YTD']];
const RANGES = [['1M', 31], ['3M', 92], ['1Y', 366], ['5Y', 1830]];

function marketDetail(m, situations) {
  const wrap = el('div', { className: 'mkt-detail' });
  if (m.value == null) {
    wrap.append(el('p', { className: 'footnote' },
      `No value available. ${m.error ?? ''} Nothing is shown in its place.`));
    return wrap;
  }

  // horizons
  wrap.append(el('div', { className: 'horizons' }, HORIZONS.map(([key, label]) => el('div', { className: 'horizon' }, [
    el('span', { className: 'horizon-k' }, label),
    el('span', { className: `horizon-v ${changeClass(m, key)}` }, fmtChange(m, key)),
  ]))));

  // chart with range selector — daily closes only, so no intraday ranges
  const chartWrap = el('div', { className: 'chart-wrap' });
  let days = 366;
  const paint = () => {
    const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    drawChart(chartWrap, m, [], from, 200);
  };
  const ranges = el('div', { className: 'ranges' }, RANGES.map(([label, d]) => {
    const b = el('button', { type: 'button', className: d === days ? 'is-on' : '' }, label);
    b.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      days = d;
      ranges.querySelectorAll('button').forEach((x) => x.classList.remove('is-on'));
      b.classList.add('is-on');
      paint();
    });
    return b;
  }));
  wrap.append(el('div', { className: 'mkt-chart-head' }, [
    el('span', { className: 'muted' }, 'Daily closes'), ranges,
  ]), chartWrap);
  // drawChart measures its container, so it must run once this node is in the
  // DOM. Not via requestAnimationFrame: that never fires in a background tab,
  // which left the chart blank whenever the window wasn't focused.
  wrap.paintChart = paint;

  // provenance
  const src = m.source ?? {};
  wrap.append(el('div', { className: 'provenance' }, [
    el('div', {}, [el('span', { className: 'prov-k' }, 'Source'),
      src.url ? ext(src.url, src.name) : el('span', {}, src.name ?? 'unknown')]),
    el('div', {}, [el('span', { className: 'prov-k' }, 'Type'), el('span', {}, src.type ?? '—')]),
    el('div', {}, [el('span', { className: 'prov-k' }, 'Measured'),
      el('span', {}, m.observedOn ? `${fmtDate(m.observedOn)}${m.asOf ? ` · ${new Date(m.asOf).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : ''}` : '—')]),
    el('div', {}, [el('span', { className: 'prov-k' }, 'Freshness'), el('span', {}, freshnessLabel(m))]),
  ]));

  // related instruments
  const rel = (RELATED[m.id] ?? []).map((id) => state.markets.find((x) => x.id === id)).filter(Boolean);
  if (rel.length) {
    wrap.append(el('div', { className: 'related' }, [
      el('span', { className: 'prov-k' }, 'Related'),
      ...rel.map((r) => el('span', { className: 'related-item' }, [
        `${r.name} `, el('span', { className: changeClass(r, 'd1') }, fmtChange(r, 'd1')),
      ])),
    ]));
  }

  // conflicts that name this instrument as their indicator
  const linked = situations.filter((sit) => (sit.markets ?? []).includes(m.id));
  if (linked.length) {
    wrap.append(el('div', { className: 'related' }, [
      el('span', { className: 'prov-k' }, 'Tracked against'),
      ...linked.map((sit) => el('a', { className: 'related-item link', href: `#/situation/${sit.id}` }, sit.name)),
    ]));
  }
  return wrap;
}

function renderMarkets(host) {
  const markets = state.markets ?? [];
  const situations = state.situations ?? [];
  const notes = state.whatMatters ?? [];
  const signals = state.signals ?? [];

  const sections = [];

  if (notes.length) {
    sections.push(el('section', { className: 'section' }, [
      sectionLabel('What matters', 'read from today’s data — interpretation, not advice'),
      ...notes.map((n) => el('p', { className: 'matters' }, [
        n.text, el('span', { className: 'matters-src' }, n.evidence),
      ])),
    ]));
  }

  if (signals.length) {
    sections.push(el('section', { className: 'section' }, [
      sectionLabel('Signals', 'derived by this dashboard — not published indices'),
      el('div', { className: 'signals' }, signals.map((sig) => el('div', { className: 'signal', title: sig.basis }, [
        el('span', { className: 'signal-k' }, sig.label),
        el('span', { className: 'signal-v' }, [
          el('span', { className: `trend trend-${sig.trend}` }, TREND_GLYPH[sig.trend] ?? '·'),
          el('span', { className: 'signal-n' }, sig.value),
        ]),
        el('span', { className: 'signal-basis' }, sig.basis),
      ]))),
    ]));
  }

  const boardLabel = sectionLabel('The board',
    `${markets.filter((m) => m.value != null).length} of ${markets.length} instruments reporting`,
    'Click any row for horizons, chart and provenance');
  boardLabel.insertBefore(infoTip(
    el('b', {}, 'Sources by instrument. '),
    'U.S. Treasury (par yields, official daily) · Cboe (VIX, official close) · LBMA (gold and silver '
    + 'benchmark) · exchange-derived quotes via Yahoo Finance for the rest, which are delayed and labelled '
    + 'as such. Nothing here is real-time. ',
    el('b', {}, 'Fed funds. '),
    'No source on this machine — FRED is unreachable from this network — so it is shown as unavailable '
    + 'rather than filled in. ',
    el('b', {}, 'Unusual. '),
    'Compares an instrument’s move with its own 90-day range.',
  ), boardLabel.querySelector('.right'));
  const board = el('section', { className: 'section' }, [boardLabel]);

  for (const group of MKT_GROUPS) {
    const rows = markets.filter((m) => m.group === group);
    if (!rows.length) continue;
    board.append(groupLabel(group));
    for (const m of rows) {
      const row = el('div', { className: `mkt-row${m.value == null ? ' is-out' : ''}` }, [
        el('span', { className: 'mkt-name' }, m.name),
        el('span', { className: 'n mkt-val' }, fmtValue(m)),
        el('span', { className: `n ${changeClass(m, 'd1')}` }, fmtChange(m, 'd1')),
        el('span', { className: 'spark-cell' }, m.series?.length ? sparkline(m) : ''),
        el('span', { className: `regime regime-${m.regime?.label ?? 'unknown'}` },
          m.value == null ? 'unavailable' : m.regime?.label ?? ''),
        el('span', { className: 'mkt-fresh' }, freshnessLabel(m)),
      ]);
      const holder = el('div', { className: 'mkt-item' }, row);
      let open = false;
      row.addEventListener('click', () => {
        open = !open;
        holder.classList.toggle('is-open', open);
        if (open) {
          const detail = marketDetail(m, situations);
          holder.append(detail);
          detail.paintChart?.();
        } else {
          holder.querySelector('.mkt-detail')?.remove();
        }
      });
      board.append(holder);
    }
  }
  sections.push(board);

  host.replaceChildren(...sections);
  redraw = null;
}

const storyRow = (item, { showOutlet = true } = {}) => el('a', {
  className: 'story', href: item.outlets ? item.outlets[0].link : item.link,
  target: '_blank', rel: 'noopener noreferrer',
}, [
  el('div', { className: 'story-title' }, item.title),
  item.summary ? el('p', { className: 'story-sum' }, item.summary) : null,
  el('div', { className: 'story-meta' }, [
    showOutlet ? el('span', { className: 'outlets' },
      item.outlets ? item.outlets.map((o) => o.outlet).join(' · ') : item.outlet) : null,
    showOutlet ? ' · ' : '', ago(item.time),
    item.severity ? ` · ${item.severity}` : '',
  ]),
]);

const bigMoney = (n) => {
  const t = Math.abs(n);
  if (t >= 1e12) return `$${(n / 1e12).toFixed(3)} trillion`;
  if (t >= 1e9) return `$${(n / 1e9).toFixed(1)} billion`;
  if (t >= 1e6) return `$${(n / 1e6).toFixed(1)} million`;
  return money(n, 'USD', 0);
};
const shortMoney = (n) => {
  const t = Math.abs(n);
  const sign = n >= 0 ? '+' : '−';
  if (t >= 1e12) return `${sign}$${(t / 1e12).toFixed(2)}T`;
  if (t >= 1e9) return `${sign}$${(t / 1e9).toFixed(1)}B`;
  if (t >= 1e6) return `${sign}$${(t / 1e6).toFixed(0)}M`;
  return `${sign}$${Math.round(t).toLocaleString('en-US')}`;
};

const DEBT_HORIZONS = [['d1', 'Since prior day'], ['m1', 'One month'], ['ytd', 'Year to date'], ['y1', 'One year']];

function debtSection() {
  const d = state.debt;
  if (!d) {
    return el('section', { className: 'section' }, [
      sectionLabel('Public debt', 'unavailable'),
      el('p', { className: 'footnote', style: 'padding-top:14px' },
        `No figure available. ${state.debtError ?? ''} Nothing is shown in its place.`),
    ]);
  }

  const chartWrap = el('div', { className: 'chart-wrap' });

  const label = sectionLabel('Public debt', 'total outstanding');
  label.append(infoTip(
    el('b', {}, 'Source. '),
    ext(d.source.url, d.source.name), ` · ${d.source.type} · measured ${fmtDate(d.observedOn)}. `,
    el('b', {}, 'On the colour. '),
    'Rising debt is shown in red purely so direction reads at a glance. That is a '
    + 'presentational choice, not a judgement.',
  ));

  const section = el('section', { className: 'section' }, [
    label,
    el('div', { className: 'debt-headline' }, [
      el('span', { className: 'debt-total' }, bigMoney(d.total)),
      el('span', { className: 'debt-when' }, `as of ${fmtDate(d.observedOn)}`),
    ]),
    el('div', { className: 'debt-split' }, [
      d.heldByPublic ? el('div', {}, [
        el('span', { className: 'figure-k' }, 'Held by the public'),
        el('span', { className: 'figure-v' }, bigMoney(d.heldByPublic)),
      ]) : null,
      d.intragovernmental ? el('div', {}, [
        el('span', { className: 'figure-k' }, 'Intragovernmental holdings'),
        el('span', { className: 'figure-v' }, bigMoney(d.intragovernmental)),
      ]) : null,
    ]),
    el('div', { className: 'horizons' }, DEBT_HORIZONS.map(([key, label]) => {
      const c = d.changes?.[key];
      return el('div', { className: 'horizon' }, [
        el('span', { className: 'horizon-k' }, label),
        el('span', { className: `horizon-v ${c ? (c.abs >= 0 ? 'down' : 'up') : ''}` },
          c ? shortMoney(c.abs) : '—'),
        el('span', { className: 'horizon-sub' }, c ? pct(c.pct, 1) : ''),
      ]);
    })),
    chartWrap,
  ]);

  // paint once mounted — the chart measures its container
  section.paintChart = () => drawChart(chartWrap, {
    label: 'Total public debt', currency: 'USD', series: d.series,
  }, [], null, 190);
  return section;
}


function defenseSection() {
  const d = state.defense;
  if (!d) {
    const l = sectionLabel('Department of War', 'unavailable');
    return el('section', { className: 'section' }, [l,
      el('p', { className: 'footnote', style: 'padding-top:14px' },
        `No figure available. ${state.defenseError ?? ''} Nothing is shown in its place.`)]);
  }

  const compact = (n) => bigMoney(n).replace(' trillion', 'T').replace(' billion', 'B');
  const vsPrior = d.prior ? ((d.obligated - d.prior.obligated) / d.prior.obligated) * 100 : null;

  const label = sectionLabel('Department of War', `obligations · FY${d.fiscalYear}`);
  label.append(infoTip(
    el('b', {}, 'What this counts. '),
    'Obligated is money legally committed; outlayed is money actually paid. Neither is “the budget” — '
    + 'budgetary resources is the authority available to spend. ',
    el('b', {}, 'Part year. '),
    `Figures run through federal period ${d.throughPeriod} of 12, so they are not comparable with a full `
    + 'prior year without allowing for that. Cumulative obligations can also be revised down when awards '
    + 'are de-obligated, which is why the line can fall. ',
    el('b', {}, 'Source. '),
    ext(d.source.url, d.source.name), ` · ${d.source.type}, published as ${d.source.publishedAs}.`,
  ));

  const chartWrap = el('div', { className: 'chart-wrap' });
  const section = el('section', { className: 'section' }, [
    label,
    el('div', { className: 'debt-headline' }, [
      el('span', { className: 'debt-total' }, bigMoney(d.obligated)),
      el('span', { className: 'debt-when' }, `obligated · period ${d.throughPeriod} of 12`),
    ]),
    el('div', { className: 'debt-split' }, [
      el('div', {}, [
        el('span', { className: 'figure-k' }, 'Actually paid out'),
        el('span', { className: 'figure-v' }, compact(d.outlayed)),
      ]),
      el('div', {}, [
        el('span', { className: 'figure-k' }, 'Budget authority'),
        el('span', { className: 'figure-v' }, compact(d.budgetaryResources)),
      ]),
      el('div', {}, [
        el('span', { className: 'figure-k' }, 'Of authority obligated'),
        el('span', { className: 'figure-v' }, `${d.shareObligated.toFixed(1)}%`),
      ]),
    ]),
    el('div', { className: 'horizons' }, [
      d.prior ? el('div', { className: 'horizon' }, [
        el('span', { className: 'horizon-k' }, `vs FY${d.prior.fiscalYear} full year`),
        el('span', { className: `horizon-v ${vsPrior >= 0 ? 'up' : 'down'}` }, pct(vsPrior, 1)),
        el('span', { className: 'horizon-sub' }, compact(d.prior.obligated)),
      ]) : null,
      ...d.history.slice(1, 4).map((y) => el('div', { className: 'horizon' }, [
        el('span', { className: 'horizon-k' }, `FY${y.fiscalYear}`),
        el('span', { className: 'horizon-v' }, compact(y.obligated)),
        el('span', { className: 'horizon-sub' }, `${((y.obligated / y.authority) * 100).toFixed(0)}% of authority`),
      ])),
    ]),
    chartWrap,
  ]);

  section.paintChart = () => drawChart(chartWrap, {
    label: 'Cumulative obligations', currency: 'USD', series: d.series,
  }, [], null, 190);
  return section;
}


function openAidDrawer() {
  openDrawer(
    'What the U.S. sends abroad',
    state.aid ? `By country · fiscal year ${state.aid.fiscalYear} to date` : 'Unavailable',
    aidDrawerBody,
    state.aid ? infoTip(
      el('b', {}, 'What this counts. '),
      `${state.aid.measure}. `,
      el('b', {}, 'What it is not. '),
      `${state.aid.caveat} `,
      el('b', {}, 'Source. '),
      ext(state.aid.source.url, state.aid.source.name), ` · ${state.aid.source.type}. `,
      'Fiscal years run 1 October to 30 September; the comparison uses the same window one year earlier '
      + 'so a part-year is never set against a full one.',
    ) : null,
  );
}

function aidSection() {
  const aid = state.aid;
  if (!aid) {
    return el('section', { className: 'section' }, [
      sectionLabel('Foreign aid', 'unavailable'),
      el('p', { className: 'footnote', style: 'padding-top:14px' },
        `No figures available. ${state.aidError ?? ''} Nothing is shown in its place.`),
    ]);
  }

  const compact = (n) => bigMoney(n).replace(' trillion', 'T').replace(' billion', 'B').replace(' million', 'M');
  const yoy = aid.priorTotal ? ((aid.total - aid.priorTotal) / aid.priorTotal) * 100 : null;
  const receiving = aid.countries.filter((c) => c.amount > 0).length;

  const label = sectionLabel('Foreign aid', `grants abroad · FY${aid.fiscalYear}`);
  label.append(infoTip(
    el('b', {}, 'What this counts. '), `${aid.measure}. `,
    el('b', {}, 'What it is not. '), `${aid.caveat} `,
    el('b', {}, 'Source. '), ext(aid.source.url, aid.source.name), ` · ${aid.source.type}. `,
    'The year-on-year figure uses the same window one year earlier, so a part-year is never set '
    + 'against a full one.',
  ));

  const top = aid.countries.slice(0, 5);
  const max = top[0]?.amount ?? 1;

  const more = el('button', { className: 'icon-btn', type: 'button' });
  more.append(globeIcon(), el('span', {}, `All ${aid.countries.length} countries`));
  more.addEventListener('click', openAidDrawer);

  return el('section', { className: 'section' }, [
    label,
    el('div', { className: 'debt-headline' }, [
      el('span', { className: 'debt-total' }, bigMoney(aid.total)),
      el('span', { className: 'debt-when' }, `to date · ${receiving} countries`),
    ]),
    el('div', { className: 'debt-split' }, [
      el('div', {}, [
        el('span', { className: 'figure-k' }, 'Same window last year'),
        el('span', { className: 'figure-v' }, compact(aid.priorTotal)),
      ]),
      yoy != null ? el('div', {}, [
        el('span', { className: 'figure-k' }, 'Year on year'),
        el('span', { className: `figure-v ${yoy >= 0 ? 'up' : 'down'}` }, pct(yoy, 0)),
      ]) : null,
      el('div', {}, [
        el('span', { className: 'figure-k' }, `FY${aid.lastFullYear.fiscalYear} full year`),
        el('span', { className: 'figure-v' }, compact(aid.lastFullYear.total)),
      ]),
    ]),
    el('div', { className: 'aid-top' }, top.map((c) => el('div', { className: 'aid-top-row' }, [
      el('span', { className: 'aid-top-name' }, c.name),
      el('span', { className: 'aid-top-amt' }, compact(c.amount)),
      el('span', { className: 'aid-top-bar' }, el('i', { style: `width:${(c.amount / max) * 100}%` })),
    ]))),
    more,
  ]);
}

function renderGovernment(host) {
  const gov = state.official ?? [];
  const bodies = [...new Set(gov.map((o) => o.outlet))];
  const debt = debtSection();
  const defense = defenseSection();

  // Like every other domain view, this opens straight into its first section —
  // the top nav already says where you are.
  host.replaceChildren(
    el('div', { className: 'gov-split' }, [debt, defense, aidSection()]),
    el('section', { className: 'section' }, [
      sectionLabel('Postings', `${gov.length} items from ${bodies.length} bodies`),
      ...bodies.flatMap((b) => {
        const items = gov.filter((o) => o.outlet === b);
        return [subLabel(b, `${items.length} · latest ${ago(items[0]?.time)}`),
          ...items.map((i) => storyRow(i, { showOutlet: false }))];
      }),
    ]),
  );
  debt.paintChart?.();
  defense.paintChart?.();
}

// Indiana and Noblesville. These sources also feed the main wire and the
// government rail — this view gathers them so there is somewhere to look,
// rather than hunting them out of a stream ranked against world conflict.
//
// Outlets are read from the source status by their `place` tag, so adding a
// source in sources.mjs is still a one-line change.
function renderIndiana(host) {
  // The server builds this slice separately from the global lanes. Filtering
  // state.wire instead would show only the local stories that outranked the
  // world's — a fifth of them, with one outlet dropping out entirely.
  const place = state.places?.indiana ?? { wire: [], official: [] };
  const official = place.official;
  const wire = place.wire;
  const bodies = [...new Set(official.map((o) => o.outlet))];

  host.replaceChildren(
    el('section', { className: 'section' }, [
      (() => {
        const l = sectionLabel('Official', `${official.length} items from ${bodies.length} bodies`);
        l.append(infoTip(
          'Noblesville publishes its news and meeting agendas as CivicPlus feeds. The Indiana Economic '
          + 'Development Corporation publishes no feed of any kind, so its items are read from its news '
          + 'page — scraped markup, not a published feed, and only the articles currently featured there.',
        ));
        return l;
      })(),
      ...(bodies.length ? bodies.flatMap((b) => {
        const items = official.filter((o) => o.outlet === b);
        return [subLabel(b, `${items.length} · latest ${ago(items[0]?.time)}`),
          ...items.map((i) => storyRow(i, { showOutlet: false }))];
      }) : [el('p', { className: 'muted' }, 'No official postings in the current window.')]),
    ]),
    el('section', { className: 'section' }, [
      (() => {
        const l = sectionLabel('Regional wire', `${wire.length} stories`);
        l.append(infoTip(
          'Indiana Capital Chronicle covers the state, Mirror Indy the Indianapolis metro, and Current '
          + 'and the Hamilton County Reporter cover Noblesville and its neighbours. These stories also '
          + 'appear in the main wire, ranked against everything else.',
        ));
        return l;
      })(),
      ...(wire.length ? wire.map((s) => storyRow(s))
        : [el('p', { className: 'muted' }, 'No regional stories in the current window.')]),
    ]),
  );
}

function renderClimate(host) {
  const hazard = state.hazard ?? [];
  const quakes = hazard.filter((h) => h.outlet === 'USGS');
  const alerts = hazard.filter((h) => h.outlet === 'NWS');
  host.replaceChildren(
    el('section', { className: 'section' }, [
      (() => {
        const l = sectionLabel('Climate & hazard', `${hazard.length} events in the last 24 hours`);
        l.append(infoTip(
          'Sources are NWS extreme-severity alerts and USGS earthquakes above M4.5 — near-term hazard, '
          + 'not long-run climate trend. No temperature or emissions series is wired in yet.',
        ));
        return l;
      })(),
      subLabel('Severe weather', `${alerts.length} active`),
      ...(alerts.length ? alerts.map((a) => storyRow(a, { showOutlet: false })) : [el('p', { className: 'muted' }, 'No extreme alerts active.')]),
      subLabel('Seismic', `${quakes.length} at M4.5 or above`),
      ...quakes.map((q) => storyRow(q, { showOutlet: false })),
    ]),
  );
}

function renderWire(host) {
  const wire = state.wire ?? [];
  host.replaceChildren(
    el('section', { className: 'section' }, [
      sectionLabel('The wire', `${wire.length} stories, grouped across outlets`),
      ...wire.map((s) => storyRow(s)),
    ]),
  );
}

// ---- level 3: entity ------------------------------------------------------

function renderSituation(host, id) {
  const s = (state.situations ?? []).find((x) => x.id === id);
  if (!s) { host.replaceChildren(el('p', { className: 'pad muted' }, 'Unknown subject.')); return; }

  const a = s.activity;
  const market = state.markets.find((m) => m.id === s.markets?.[0]);
  const move = sinceStart(market, s.started);
  const ordered = [...s.timeline].sort((x, y) => x.date.localeCompare(y.date));
  const byId = new Map(ordered.map((e) => [e.id, e]));
  const latestEvent = ordered.at(-1);
  const latestStory = a.topStories[0];

  const head = el('div', { className: 'entity-head' }, [
    el('a', { className: 'back', href: '#/world' }, '← Conflicts'),
    el('h1', { className: 'entity-title' }, s.name),
    el('div', { className: 'entity-meta' }, [
      el('span', { className: `level level-${a.level}` }, `${a.level} activity`),
      trendEl(a.trend),
      el('span', {}, `${a.events7} developments in the last 7 days`),
      el('span', {}, `${a.mentions24} stories on the wire today`),
      el('span', {}, s.type),
      el('span', {}, `${duration(s.started)} · began ${fmtDate(s.started)}`),
    ]),
    el('p', { className: 'entity-dek' }, s.summary),
  ]);

  const figures = el('div', { className: 'figures' }, [
    el('div', {}, [el('span', { className: 'figure-k' }, 'Running'), el('span', { className: 'figure-v' }, duration(s.started))]),
    el('div', {}, [el('span', { className: 'figure-k' }, 'Developments tracked'), el('span', { className: 'figure-v' }, String(s.timeline.length))]),
    move ? el('div', {}, [
      el('span', { className: 'figure-k' }, `${market.label} since day one`),
      el('span', { className: `figure-v ${dirClass(move.pct)}` }, pct(move.pct)),
    ]) : null,
    move ? el('div', {}, [
      el('span', { className: 'figure-k' }, `${market.label} today`),
      el('span', { className: 'figure-v' }, money(move.now, market.currency ?? 'USD')),
    ]) : null,
  ]);

  const latest = el('section', { className: 'section' }, [
    sectionLabel('Latest'),
    el('div', { className: 'latest' }, [
      el('h3', { className: 'latest-title' }, latestStory ? latestStory.title : latestEvent.action.split(/(?<=\.)\s/)[0]),
      latestStory
        ? el('p', { className: 'latest-body' }, `Most recent curated development: ${latestEvent.action}`)
        : el('p', { className: 'latest-body' }, latestEvent.action),
      el('div', { className: 'latest-meta' }, latestStory
        ? `${ago(latestStory.time)} · ${latestStory.outlets.join(' · ')}`
        : `${fmtDate(latestEvent.date)} · ${latestEvent.actor}`),
    ]),
  ]);

  const chartWrap = el('div', { className: 'chart-wrap' });
  const noIndicator = !market && s.indicatorNote
    ? el('section', { className: 'section' }, [
      sectionLabel('Key indicator', 'none linked'),
      el('p', { className: 'footnote', style: 'padding-top:14px' }, s.indicatorNote),
    ])
    : null;
  const indicators = market ? el('section', { className: 'section' }, [
    sectionLabel('Key indicator', `${market.label}, daily close through the conflict`),
    chartWrap,
    el('div', { className: 'legend' }, [
      el('span', {}, [el('i', { style: 'color:var(--high)' }), 'Strike']),
      el('span', {}, [el('i', { style: 'color:var(--up)' }), 'Diplomacy']),
      el('span', {}, [el('i', { style: 'color:var(--medium)' }), 'Economic']),
      el('span', {}, 'Markers are major developments — click one to open it below'),
    ]),
  ]) : null;

  const timeline = el('section', { className: 'section' }, [
    sectionLabel('Timeline', `${ordered.length} developments, newest first`),
    el('div', { className: 'tl' }, [...ordered].reverse().flatMap((ev) => {
      const cause = ev.retaliationFor ? byId.get(ev.retaliationFor) : null;
      const headline = ev.action.split(/(?<=\.)\s/)[0];
      const rest = ev.action.startsWith(headline) ? ev.action.slice(headline.length).trim() : ev.action;
      return [
        el('div', { className: 'tl-time' }, fmtDate(ev.date)),
        el('details', { className: 'tl-item', id: `ev-${ev.id}` }, [
          el('summary', {}, [
            el('span', { className: `tl-actor ${KIND[ev.kind] ?? ''}` }, ev.actor),
            el('span', { className: 'tl-head' }, headline),
          ]),
          el('div', { className: 'tl-body' }, [
            rest || null,
            el('div', { className: 'tl-refs' }, [
              ev.where ? el('span', {}, ev.where) : null,
              el('span', {}, fmtDate(ev.date)),
              ev.approx ? el('span', { className: 'tag-approx', title: 'Sources give only the month, or disagree' }, 'approx.') : null,
              cause ? el('span', {}, `In response to ${cause.actor}, ${fmtDate(cause.date)}`) : null,
              ev.source ? ext(ev.source, 'Source') : null,
            ]),
          ]),
        ]),
      ];
    })),
  ]);

  const coverage = a.topStories.length ? el('section', { className: 'section' }, [
    sectionLabel('On the wire today', `${a.mentions24} matching stories`),
    ...a.topStories.map((t) => el('a', { className: 'story', href: t.link, target: '_blank', rel: 'noopener noreferrer' }, [
      el('div', { className: 'story-title' }, t.title),
      el('div', { className: 'story-meta' }, `${t.outlets.join(' · ')} · ${ago(t.time)}`),
    ])),
  ]) : null;

  const aside = el('section', { className: 'section' }, [
    sectionLabel('Context'),
    el('div', { className: 'two-col' }, [
      el('div', {}, [subLabel('What to watch'), el('ul', { className: 'list' }, (s.watch ?? []).map((w) => el('li', {}, w)))]),
      el('div', {}, [subLabel('Sources'), el('ul', { className: 'list' }, (s.sources ?? []).map((src) => el('li', {}, ext(src.url, src.label))))]),
    ]),
    el('p', { className: 'footnote' }, 'Timeline is hand-curated; every development links its source.'),
  ]);

  host.replaceChildren(...[head, figures, latest, indicators, noIndicator, timeline, coverage, aside].filter(Boolean));
  if (market) {
    redraw = () => drawChart(chartWrap, market, ordered.filter((e) => e.major), s.started, 240);
    redraw();
  }
}

function renderWatched(host, slug) {
  const s = (state.watchlist ?? []).find((x) => x.slug === slug);
  if (!s) { host.replaceChildren(el('p', { className: 'pad muted' }, 'Unknown subject.')); return; }
  const a = s.activity;

  host.replaceChildren(
    el('div', { className: 'entity-head' }, [
      el('a', { className: 'back', href: '#/world' }, '← Conflicts'),
      el('h1', { className: 'entity-title' }, s.name),
      el('div', { className: 'entity-meta' }, [
        el('span', { className: `level level-${a.level}` }, `${a.level} activity`),
        el('span', {}, `${a.mentions24} stories on the wire today`),
        el('span', {}, s.region),
      ]),
      el('p', { className: 'entity-dek' },
        'Followed by live coverage only. There is no curated timeline for this subject, so nothing here is '
        + 'asserted beyond what the wire is carrying — and no trend is shown, because a day of feeds gives no baseline.'),
    ]),
    el('section', { className: 'section' }, [
      sectionLabel('On the wire today', a.mentions24 ? `${a.mentions24} matching stories` : 'nothing matching in the last 24 hours'),
      ...(a.topStories.length
        ? a.topStories.map((t) => el('a', { className: 'story', href: t.link, target: '_blank', rel: 'noopener noreferrer' }, [
          el('div', { className: 'story-title' }, t.title),
          el('div', { className: 'story-meta' }, `${t.outlets.join(' · ')} · ${ago(t.time)}`),
        ]))
        : [el('p', { className: 'muted' }, 'Quiet across the five wire outlets in the last 24 hours.')]),
      el('p', { className: 'footnote' },
        `Matched on: ${s.keywords.join(', ')}. To promote this to a tracked subject, give it a timeline in `
        + 'data/situations.json — it then gains measured week-on-week trends and a linked market.'),
    ]),
  );
}

// ---- chrome & routing -----------------------------------------------------

const NAV = [
  { hash: '#/', label: 'Pulse' },
  { hash: '#/world', label: 'World' },
  { hash: '#/markets', label: 'Markets' },
  { hash: '#/government', label: 'Government' },
  { hash: '#/climate', label: 'Climate' },
  { hash: '#/indiana', label: 'Indiana' },
  { hash: '#/wire', label: 'Wire' },
];

function renderNav() {
  const h = location.hash || '#/';
  const active = NAV.reduce((best, n) => (h === n.hash || (n.hash !== '#/' && h.startsWith(n.hash)) ? n.hash : best), '#/');
  const deep = h.startsWith('#/situation/') || h.startsWith('#/world/') ? '#/world' : null;
  $('nav').replaceChildren(...NAV.map((n) => el('a', {
    href: n.hash, className: (deep ?? active) === n.hash ? 'is-active' : '',
  }, n.label)));
}

const ROUTES = {
  '#/': renderPulse, '#/world': renderWorld, '#/markets': renderMarkets,
  '#/government': renderGovernment, '#/climate': renderClimate,
  '#/indiana': renderIndiana, '#/wire': renderWire,
};

function route() {
  if (!state) return;
  const host = $('view');
  redraw = null;
  const hash = location.hash || '#/';

  const situation = hash.match(/^#\/situation\/(.+)$/);
  const watched = hash.match(/^#\/world\/(.+)$/);

  if (situation) renderSituation(host, situation[1]);
  else if (watched) renderWatched(host, watched[1]);
  else (ROUTES[hash] ?? renderPulse)(host);

  renderNav();
  window.scrollTo(0, 0);
}

const ICONS = {
  dark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
};

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const btn = $('themeToggle');
  btn.innerHTML = theme === 'dark' ? ICONS.dark : ICONS.light;
  btn.setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`);
  if (redraw) redraw();
}

function initChrome() {
  let saved = null;
  try { saved = localStorage.getItem('pulse-theme'); } catch { /* blocked */ }
  applyTheme(saved ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  $('themeToggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem('pulse-theme', next); } catch { /* blocked */ }
  });
}

// Two ways to get state, tried in this order. The local server builds it on
// demand at /api/state. GitHub Pages cannot run Node, so there it is a file the
// build workflow wrote — older, and labelled as such rather than passed off as
// the same thing.
async function loadState() {
  try {
    const res = await fetch('/api/state', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    const res = await fetch('./state.json', { cache: 'no-store' });
    // Report the server's failure, not the fallback's: on a machine running the
    // server, /api/state failing is the real problem worth surfacing.
    if (!res.ok) throw err;
    return await res.json();
  }
}

async function refresh() {
  let next;
  try {
    next = await loadState();
  } catch (err) {
    // A fetch problem is a data problem; say so and keep the last good view.
    $('health').textContent = lastGood ? 'stale' : `unreachable (${err.message})`;
    return;
  }

  state = next;
  lastGood = state.generatedAt;
  const live = state.status.filter((s) => s.ok).length;
  $('clock').textContent = `${dayFmt.format(new Date(state.generatedAt))} · ${clockFmt.format(new Date(state.generatedAt))}`;
  // A snapshot must not read as a live source count. Say what it is and how old.
  $('health').textContent = state.snapshot
    ? `${live}/${state.status.length} sources · snapshot, built ${ago(state.generatedAt)}`
    : `${live}/${state.status.length} sources`;

  // A rendering fault is this app's bug, not the sources'. Reporting it as
  // "stale" sent me hunting a data problem that did not exist.
  try {
    route();
  } catch (err) {
    console.error('[pulse] render failed:', err);
    $('view').replaceChildren(el('p', { className: 'pad muted' }, `Interface error: ${err.message}`));
  }
}

initChrome();
window.addEventListener('hashchange', route);
window.addEventListener('resize', () => { if (redraw) redraw(); });
refresh();
setInterval(refresh, REFRESH_MS);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && lastGood && Date.now() - lastGood > REFRESH_MS) refresh();
});
