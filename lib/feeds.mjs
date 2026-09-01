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
function clean(raw) {
  if (!raw) return '';
  let s = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  s = decodeEntities(s);
  s = s.replace(/<[^>]*>/g, ' ');       // strip markup left inside descriptions
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

const PARSERS = {
  'federal-register': parseFederalRegister,
  usgs: parseUsgs,
  nws: parseNws,
};

export async function loadSource(source) {
  let items;
  if (source.kind === 'rss') {
    items = parseFeed(await get(source.url));
  } else {
    const parse = PARSERS[source.kind];
    if (!parse) throw new Error(`no parser for kind "${source.kind}"`);
    items = parse(await get(source.url, { json: true }));
  }

  if (source.stripSummary) {
    items = items.map((i) => ({ ...i, summary: i.summary.replace(source.stripSummary, '').trim() }));
  }
  return items;
}
