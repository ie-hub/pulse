// Activity scoring — the spine of the whole interface.
//
//   Activity = recency × significance × change
//
// Two independent signals feed it, and they are kept distinct because they are
// not equally trustworthy:
//
//   1. Curated timeline events (tracked conflicts only). Hand-written, sourced,
//      and deep enough in history that a 7-day window can be compared with the
//      one before it — so *change* here is measured, not guessed.
//   2. Live wire mentions. Feeds only reach back ~24-30 hours, so this measures
//      current volume. It cannot produce a trend on its own.
//
// Anything we cannot measure is reported as unknown rather than filled in.

const DAY = 86400000;

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');

function matches(text, keywords) {
  const hay = norm(text);
  return keywords.some((k) => hay.includes(k.toLowerCase()));
}

/** Wire stories mentioning a subject, newest first. Outlet breadth = significance. */
// Titles only. Matching summaries too pulled in any story that merely mentioned
// a country in passing, which made the tags untrustworthy.
export function mentionsOf(wire, keywords, windowMs = DAY) {
  const cutoff = Date.now() - windowMs;
  return wire
    .filter((s) => (s.time ?? 0) >= cutoff && matches(s.title, keywords))
    .sort((a, b) => (b.time ?? 0) - (a.time ?? 0));
}

/** Significance-weighted volume: a story carried by five outlets counts for more. */
const weigh = (stories) => stories.reduce((n, s) => n + 1 + Math.min(3, (s.outlets?.length ?? 1) - 1) * 0.5, 0);

function timelineWindows(timeline, now) {
  const days = (d) => (now - Date.parse(`${d}T12:00:00Z`)) / DAY;
  let last7 = 0, prev7 = 0, last30 = 0;
  for (const ev of timeline ?? []) {
    const age = days(ev.date);
    const weight = ev.major ? 2 : 1;
    if (age < 0) continue;
    if (age <= 7) last7 += weight;
    else if (age <= 14) prev7 += weight;
    if (age <= 30) last30 += weight;
  }
  return { last7, prev7, last30 };
}

function levelOf(score) {
  if (score >= 9) return 'high';
  if (score >= 4) return 'medium';
  if (score > 0) return 'low';
  return 'quiet';
}

/**
 * Score one subject. `timeline` may be empty (watchlist entries), in which case
 * the trend is reported as unknown rather than inferred from a single snapshot.
 */
export function scoreSubject({ timeline = [], keywords = [], wire = [] }, now = Date.now()) {
  const win = timelineWindows(timeline, now);
  const recent = mentionsOf(wire, keywords, DAY);
  const wireWeight = weigh(recent);

  const score = wireWeight * 2 + win.last7 * 2.5 + win.last30 * 0.4;

  let trend = 'unknown';
  let delta = null;
  if (timeline.length) {
    delta = win.last7 - win.prev7;
    trend = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
  }

  return {
    score: Math.round(score * 10) / 10,
    level: levelOf(score),
    trend,
    delta,
    events7: win.last7,
    events30: win.last30,
    mentions24: recent.length,
    topStories: recent.slice(0, 4).map((s) => ({
      title: s.title, link: s.outlets?.[0]?.link ?? s.link,
      outlets: (s.outlets ?? []).map((o) => o.outlet), time: s.time,
    })),
  };
}

/**
 * Domain-level pulse. Where a domain has no measurable baseline, `trend` stays
 * 'unknown' until the history file has enough samples (see history.mjs).
 */
export function domainPulse({ situations, watchlist, wire, official, hazard, markets }, history) {
  const now = Date.now();
  const since = (items, ms) => items.filter((i) => (i.time ?? 0) >= now - ms).length;

  const conflictScore = [...situations, ...watchlist]
    .reduce((n, s) => n + (s.activity?.score ?? 0), 0);

  const movers = markets
    .filter((m) => m.changePct != null)
    .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));
  const marketEnergy = movers.reduce((n, m) => n + Math.abs(m.changePct ?? 0), 0);

  const domains = [
    { id: 'world',      label: 'Conflicts',  value: conflictScore,        unit: 'activity' },
    { id: 'markets',    label: 'Markets',    value: Math.round(marketEnergy * 10) / 10, unit: 'total move %' },
    { id: 'government', label: 'Government', value: since(official, DAY), unit: 'postings 24h' },
    { id: 'climate',    label: 'Climate',    value: since(hazard, DAY),   unit: 'events 24h' },
  ];

  // Trend comes from the persisted history, never from the current snapshot.
  for (const d of domains) {
    const past = history?.[d.id];
    if (past?.length >= 2) {
      const prev = past.at(-2).value;
      d.delta = Math.round((d.value - prev) * 10) / 10;
      d.trend = d.delta > 0 ? 'up' : d.delta < 0 ? 'down' : 'flat';
    } else {
      d.trend = 'unknown';
      d.delta = null;
    }
  }
  return domains;
}
