// Fetching and parsing. No dependencies: Node's fetch plus a small XML reader
// that handles the three feed dialects the sources actually serve
// (RSS 2.0, RDF, Atom).

const UA = 'personal-dashboard/1.0 (local; single user)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Yahoo rejects a share of requests when several fire at once, so anything
// flaky gets a couple of spaced retries before it counts as down.
export async function get(url, { retries = 0, ...opts } = {}) {
  let last;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt) await sleep(500 * attempt + 250);
    try {
      return await getOnce(url, opts);
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

async function getOnce(url, { timeout = 15000, json = false } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { 'user-agent': UA, accept: json ? 'application/json' : 'application/rss+xml, application/xml, text/xml, */*' },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return json ? await res.json() : await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// ---- XML ------------------------------------------------------------------

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  mdash: '—', ndash: '–', hellip: '…', middot: '·',
};

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X'
        ? parseInt(e.slice(2), 16)
        : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 ? String.fromCodePoint(cp) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

// Feed text arrives wrapped in CDATA, containing escaped HTML, or both.
//
// Order matters. Decoding first looks simpler, but WordPress feeds carry
// attributes whose values are themselves escaped HTML — data-image-caption="&lt;p&gt;…".
// Decoding those first turns them into real tags *inside* an attribute, so
// <[^>]*> ends at the wrong '>' and the rest of the tag survives as text:
// every image-led item leaked ' data-large-file="https://…' into its summary.
//
// So: strip the real markup first, then decode, then strip again for feeds
// that escaped their HTML rather than embedding it.
function clean(raw) {
  if (!raw) return '';
  let s = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  s = s.replace(/<[^>]*>/g, ' ');       // real markup, attributes and all
  s = decodeEntities(s);
  s = s.replace(/<[^>]*>/g, ' ');       // markup the decode revealed
  s = decodeEntities(s);                // entities can survive one pass
  return s.replace(/\s+/g, ' ').trim();
}

function firstTag(block, ...names) {
  for (const name of names) {
    const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
    if (m && m[1].trim()) return m[1];
  }
  return '';
}

// RSS puts the URL in the element body; Atom puts it in a href attribute and
// may list several, of which we want the human-readable one.
function firstLink(block) {
  const body = block.match(/<link(?:\s[^>]*)?>([\s\S]*?)<\/link>/i);
  if (body && body[1].trim() && !body[1].includes('<')) return clean(body[1]);

  const hrefs = [...block.matchAll(/<link\b([^>]*)\/?>/gi)]
    .map((m) => m[1])
    .filter((attrs) => /href\s*=/.test(attrs))
    .map((attrs) => ({
      href: decodeEntities(attrs.match(/href\s*=\s*["']([^"']+)["']/i)?.[1] ?? ''),
      rel: attrs.match(/rel\s*=\s*["']([^"']+)["']/i)?.[1] ?? 'alternate',
    }))
    .filter((l) => l.href);

  return (hrefs.find((l) => l.rel === 'alternate') ?? hrefs[0])?.href ?? '';
}

function toTime(raw) {
  const s = clean(raw);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

export function parseFeed(xml) {
  const blocks = [...xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)];
  return blocks.map(([, , block]) => {
    const summary = clean(firstTag(block, 'description', 'summary', 'content:encoded', 'content'));
    return {
      title: clean(firstTag(block, 'title')),
      link: firstLink(block),
      time: toTime(firstTag(block, 'pubDate', 'dc:date', 'published', 'updated')),
      summary: summary.length > 260 ? `${summary.slice(0, 257)}…` : summary,
    };
  }).filter((i) => i.title && i.link);
}

// ---- JSON sources ---------------------------------------------------------

function parseFederalRegister(data) {
  return (data.results ?? []).map((d) => ({
    title: d.title,
    // The Register is a daily digest with no per-item time. Stamping it at the
    // start of its day keeps it in the right day without letting twenty
    // identically-timed notices sit on top of the hour's actual news.
    time: d.publication_date ? Date.parse(`${d.publication_date}T00:00:00Z`) : null,
    link: d.html_url,
    summary: [d.type, (d.agencies ?? []).map((a) => a.name).join(', ')]
      .filter(Boolean).join(' · '),
  }));
}

function parseUsgs(data) {
  return (data.features ?? []).map((f) => ({
    title: `M ${f.properties.mag?.toFixed(1) ?? '?'} — ${f.properties.place ?? 'unknown location'}`,
    link: f.properties.url,
    time: f.properties.time ?? null,
    summary: '',
    magnitude: f.properties.mag ?? null,
  }));
}

// NWS issues one alert per affected zone, so a single storm arrives as dozens
// of identical events. Collapse by event type and list the areas once.
function parseNws(data) {
  const byEvent = new Map();

  for (const f of data.features ?? []) {
    const event = f.properties.event ?? 'Alert';
    const time = Date.parse(f.properties.effective ?? f.properties.sent ?? '') || null;
    const entry = byEvent.get(event) ?? {
      title: event,
      link: f.properties.id?.startsWith('http') ? f.properties.id : 'https://alerts.weather.gov/',
      time,
      areas: new Set(),
      severity: f.properties.severity ?? null,
    };
    for (const area of (f.properties.areaDesc ?? '').split(';')) {
      const name = area.trim();
      if (name) entry.areas.add(name);
    }
    if (time && (!entry.time || time > entry.time)) entry.time = time;
    byEvent.set(event, entry);
  }

  return [...byEvent.values()].map(({ areas, ...rest }) => {
    const list = [...areas];
    const shown = list.slice(0, 4).join(' · ');
    return {
      ...rest,
      summary: list.length > 4 ? `${shown} +${list.length - 4} more areas` : shown,
      areaCount: list.length,
    };
  });
}

// IEDC publishes no feed of any kind — no RSS, no Atom, no sitemap — so its
// news list is read from the page itself. The listing is server-rendered, and
// each article is linked twice: once from a date/region label, once from the
// headline. Keeping the longest text for a given URL picks the headline.
//
// This is scraped markup, not a published feed. If IEDC redesigns, the shape
// changes and this returns nothing — which surfaces as a source error rather
// than quietly going stale.
const IEDC_ARTICLE = /<a[^>]+href="(https:\/\/iedc\.in\.gov\/events\/news\/details\/(\d{4})\/(\d{2})\/(\d{2})\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;

// "September 2, 2026  |  INDIANA" — the label, not a headline.
const IEDC_DATE_LABEL = /^[A-Z][a-z]+ \d{1,2}, \d{4}\s*\|/;

function parseIedc(html) {
  const best = new Map();
  for (const m of html.matchAll(IEDC_ARTICLE)) {
    const link = decodeEntities(m[1]);
    const title = clean(m[5]);
    const day = Date.parse(`${m[2]}-${m[3]}-${m[4]}T00:00:00Z`);
    const prev = best.get(link);
    if (!prev || title.length > prev.title.length) {
      best.set(link, { title, link, time: Number.isFinite(day) ? day : null, summary: '' });
    }
  }
  return [...best.values()].filter((i) => i.title && !IEDC_DATE_LABEL.test(i.title));
}

const PARSERS = {
  'federal-register': parseFederalRegister,
  usgs: parseUsgs,
  nws: parseNws,
  iedc: parseIedc,
};

// Parsers that read markup rather than JSON.
const HTML_PARSERS = new Set(['iedc']);

export async function loadSource(source) {
  let items;
  if (source.kind === 'rss') {
    items = parseFeed(await get(source.url));
  } else {
    const parse = PARSERS[source.kind];
    if (!parse) throw new Error(`no parser for kind "${source.kind}"`);
    items = parse(await get(source.url, { json: !HTML_PARSERS.has(source.kind) }));
  }

  // Some feeds publish a hundred items where the rest publish twenty. Left
  // alone that outlet owns the lane, for the same reason roundRobin exists on
  // the official rail. Newest first, then capped.
  if (source.limit) {
    items = [...items].sort((a, b) => (b.time ?? 0) - (a.time ?? 0)).slice(0, source.limit);
  }

  if (source.stripSummary) {
    items = items.map((i) => ({ ...i, summary: i.summary.replace(source.stripSummary, '').trim() }));
  }
  // Some publishers put standing boilerplate in the title element itself.
  if (source.stripTitle) {
    items = items
      .map((i) => ({ ...i, title: i.title.replace(source.stripTitle, '').trim() }))
      .filter((i) => i.title);
  }

  // A description that only repeats the headline is a wasted line on every row
  // that carries it. Checked last, because the strip rules above can be what
  // makes the two converge.
  items = items.map((i) => (i.summary && i.summary === i.title ? { ...i, summary: '' } : i));

  return items;
}
