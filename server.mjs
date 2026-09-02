import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SOURCES, TTL } from './lib/sources.mjs';
import { loadSource } from './lib/feeds.mjs';
import { loadMarkets } from './lib/markets.mjs';
import { whatMatters, marketSignals } from './lib/macro.mjs';
import { usDebt } from './lib/fiscal.mjs';
import { foreignAid } from './lib/aid.mjs';
import { defenseSpending } from './lib/defense.mjs';
import { clusterStories } from './lib/cluster.mjs';
import { scoreSubject, domainPulse } from './lib/activity.mjs';
import { recordHistory } from './lib/history.mjs';
import { dailyScripture } from './lib/scripture.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const SITUATIONS = path.join(ROOT, 'data', 'situations.json');
const HISTORY = path.join(ROOT, 'data', 'pulse-history.json');
const SCRIPTURE = path.join(ROOT, 'data', 'scripture.json');
const PORT = Number(process.env.PORT) || 4173;

// One cache entry per source. A failed refresh keeps serving the last good
// payload and reports the error alongside it, so one dead feed never blanks
// the board.
const cache = new Map();

async function cached(key, ttl, load) {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit?.data && now - hit.at < ttl) return hit;
  if (hit?.inflight) return hit.inflight;

  const inflight = (async () => {
    try {
      const data = await load();
      const entry = { data, at: Date.now(), error: null };
      cache.set(key, entry);
      return entry;
    } catch (err) {
      const entry = {
        data: hit?.data ?? null,
        at: hit?.at ?? null,
        error: err.message || String(err),
        erroredAt: Date.now(),
      };
      cache.set(key, entry);
      return entry;
    }
  })();

  cache.set(key, { ...hit, inflight });
  return inflight;
}

// Read from disk each time rather than caching: editing situations.json should
// show up on the next reload, with a bad edit reported instead of crashing.
async function loadSituations() {
  try {
    const raw = await fs.readFile(SITUATIONS, 'utf8');
    const parsed = JSON.parse(raw);
    return { situations: parsed.situations ?? [], watchlist: parsed.watchlist ?? [], error: null };
  } catch (err) {
    return { situations: [], watchlist: [], error: `situations.json: ${err.message}` };
  }
}

async function buildState() {
  const [feedEntries, marketsEntry, situations, scripture, debtEntry, aidEntry, defenseEntry] = await Promise.all([
    Promise.all(SOURCES.map(async (s) => [s, await cached(s.id, TTL.feed, () => loadSource(s))])),
    cached('markets', TTL.market, loadMarkets),
    loadSituations(),
    dailyScripture(SCRIPTURE),
    cached('debt', TTL.feed, usDebt),
    cached('aid', 6 * 60 * 60 * 1000, foreignAid),   // annual data; refetch rarely
    cached('defense', 6 * 60 * 60 * 1000, defenseSpending),
  ]);

  const status = [];
  const lanes = { wire: [], official: [], hazard: [] };

  for (const [source, entry] of feedEntries) {
    status.push({
      id: source.id,
      outlet: source.outlet,
      lane: source.lane,
      ok: !entry.error,
      error: entry.error,
      fetchedAt: entry.at,
      count: entry.data?.length ?? 0,
    });
    for (const item of entry.data ?? []) {
      lanes[source.lane].push({ ...item, outlet: source.outlet, sourceId: source.id });
    }
  }

  const byTime = (a, b) => (b.time ?? 0) - (a.time ?? 0);

  // Straight reverse-chronological order lets one prolific source own the lane:
  // the Federal Register posts twenty notices sharing a single timestamp, which
  // buries every other government voice. Take each outlet's newest in turn
  // instead, so the top of the rail is one item from each body, and only then
  // the second from each.
  function roundRobin(items, maxPerOutlet) {
    const queues = new Map();
    for (const item of [...items].sort(byTime)) {
      if (!queues.has(item.outlet)) queues.set(item.outlet, []);
      const q = queues.get(item.outlet);
      if (q.length < maxPerOutlet) q.push(item);
    }
    const out = [];
    const lists = [...queues.values()];
    for (let round = 0; round < maxPerOutlet; round += 1) {
      for (const q of lists) if (q[round]) out.push(q[round]);
    }
    return out;
  }

  const wire = clusterStories(lanes.wire).slice(0, 40);
  const official = roundRobin(lanes.official, 6).slice(0, 40);
  const hazard = lanes.hazard.sort(byTime).slice(0, 20);
  const marketList = marketsEntry.data ?? [];
  const marketsError = marketsEntry.error;

  // Score every subject against the live wire, then rank.
  const scored = situations.situations.map((s) => ({
    ...s, activity: scoreSubject({ timeline: s.timeline, keywords: s.keywords ?? [], wire }),
  }));
  const watched = situations.watchlist.map((w) => ({
    ...w, tracked: false,
    activity: scoreSubject({ timeline: [], keywords: w.keywords ?? [], wire }),
  }));

  const domains = domainPulse(
    { situations: scored, watchlist: watched, wire, official, hazard, markets: marketList },
    await recordHistory(HISTORY, [
      { id: 'world', value: [...scored, ...watched].reduce((n, s) => n + s.activity.score, 0) },
      { id: 'markets', value: marketList.filter((m) => m.changePct != null).reduce((n, m) => n + Math.abs(m.changePct), 0) },
      { id: 'government', value: official.filter((o) => (o.time ?? 0) >= Date.now() - 86400000).length },
      { id: 'climate', value: hazard.filter((h) => (h.time ?? 0) >= Date.now() - 86400000).length },
    ]),
  );

  return {
    generatedAt: Date.now(),
    scripture,
    marketsError,
    debt: debtEntry.data ?? null,
    debtError: debtEntry.error ?? null,
    aid: aidEntry.data ?? null,
    aidError: aidEntry.error ?? null,
    defense: defenseEntry.data ?? null,
    defenseError: defenseEntry.error ?? null,
    whatMatters: whatMatters(marketList),
    signals: marketSignals(marketList),
    situations: scored,
    watchlist: watched,
    domains,
    situationsError: situations.error,
    markets: marketList,
    wire,
    official,
    hazard,
    status,
  };
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

async function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403).end('forbidden'); return; }
  try {
    const body = await fs.readFile(file);
    // 'no-cache' without a validator lets browsers keep serving a stale bundle;
    // this is a local dev server, so never cache the app shell.
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store, must-revalidate',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/state') {
    try {
      const state = await buildState();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(state));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  await serveStatic(res, url.pathname);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`dashboard → http://localhost:${PORT}`);
});
