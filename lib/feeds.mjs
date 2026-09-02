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

async function getOnce(url, { timeout = 15000, json = false, form = null } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      method: form ? 'POST' : 'GET',
      headers: {
        'user-agent': UA,
        accept: json ? 'application/json' : 'application/rss+xml, application/xml, text/xml, */*',
        ...(form ? {
          'content-type': 'application/x-www-form-urlencoded',
          'x-requested-with': 'XMLHttpRequest',
        } : {}),
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
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
// news is read from the page. Not the visible listing, which is only the ten
// most recent: the pager behind it posts to /events/news/Paging/ and returns
// the same markup a page at a time, 38 pages deep at the time of writing.
//
// Each story carries its own date, title and excerpt, so nothing is inferred
// from the URL slug. This is scraped markup, not a published feed: if IEDC
// redesigns, a page parses to nothing, the loader stops and the source
// reports empty rather than going quietly stale.
const IEDC_TAG = '00000000-0000-0000-0000-000000000000';   // "all tags"

const IEDC_STORY = /<div class="story">([\s\S]*?)<\/div>\s*<\/a>\s*<\/div>/gi;
const IEDC_HREF = /href="(\/events\/news\/details\/[^"]+)"/i;
const IEDC_DATE = /<div class="copy date">\s*([^<]+?)\s*<\/div>/i;
const IEDC_TITLE = /<h2 class="copy title">\s*<a[^>]*>([\s\S]*?)<\/a>/i;
// The story-block pattern ends on this div's own closing tag, so the excerpt
// may run to the end of the captured block with no </div> of its own.
const IEDC_BODY = /<div class="copy body">([\s\S]*?)(?:<\/div>|$)/i;

function parseIedcPage(html) {
  const out = [];
  for (const [, block] of html.matchAll(IEDC_STORY)) {
    const href = block.match(IEDC_HREF)?.[1];
    const title = clean(block.match(IEDC_TITLE)?.[1] ?? '');
    if (!href || !title) continue;
    const date = clean(block.match(IEDC_DATE)?.[1] ?? '');
    const time = date ? Date.parse(`${date} 00:00:00Z`) : NaN;
    out.push({
      title,
      link: new URL(decodeEntities(href), 'https://iedc.in.gov').href,
      time: Number.isFinite(time) ? time : null,
      summary: clean(block.match(IEDC_BODY)?.[1] ?? ''),
    });
  }
  return out;
}

async function loadIedc(source) {
  const items = [];
  for (let page = 0; page < (source.pages ?? 1); page += 1) {
    const html = await get(source.url, { form: { page, tag: IEDC_TAG }, retries: 1 });
    const batch = parseIedcPage(html);
    if (!batch.length) break;         // past the last page, or the shape changed
    items.push(...batch);
  }
  return items;
}

// Sources that do their own fetching, because one request is not enough.
const LOADERS = { iedc: loadIedc };

const PARSERS = {
  'federal-register': parseFederalRegister,
  usgs: parseUsgs,
  nws: parseNws,
};

export async function loadSource(source) {
  let items;
  if (LOADERS[source.kind]) {
    items = await LOADERS[source.kind](source);
  } else if (source.kind === 'rss') {
    items = parseFeed(await get(source.url));
  } else {
    const parse = PARSERS[source.kind];
    if (!parse) throw new Error(`no parser for kind "${source.kind}"`);
    items = parse(await get(source.url, { json: true }));
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
