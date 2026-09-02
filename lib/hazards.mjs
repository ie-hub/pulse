// Active natural hazards, and the historical context that says whether the
// current level is normal.
//
// An event is a thing that happened somewhere: it has a place, a time, a
// severity and a source. That is kept separate from the observations in
// climate.mjs, which are measurements of the planet's state. Mixing the two
// would make an earthquake look like a climate signal, which it is not.
//
// Sources are the responsible agency in each case, all keyless:
//   USGS  earthquakes, and US volcano alert levels
//   NHC   Atlantic and eastern Pacific tropical cyclones
//   NWS   tsunami messages
//
// Wildfire is not covered. NASA FIRMS is the right source and needs a MAP_KEY,
// and nothing weaker is substituted for it.

import { get } from './feeds.mjs';

const USGS_FEED = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary';
const USGS_COUNT = 'https://earthquake.usgs.gov/fdsnws/event/1/count';
const iso = (t) => new Date(t).toISOString().slice(0, 10);

// ---- events ---------------------------------------------------------------

/** Significant earthquakes in the last day, newest first. */
async function earthquakes() {
  const data = await get(`${USGS_FEED}/4.5_day.geojson`, { json: true, retries: 1 });
  return (data.features ?? []).map((f) => {
    const p = f.properties ?? {};
    const [lon, lat, depth] = f.geometry?.coordinates ?? [];
    return {
      event_id: `usgs:${f.id}`,
      event_type: 'earthquake',
      subtype: null,
      source: 'USGS',
      source_url: p.url ?? null,
      start_time: p.time ?? null,
      status: p.status ?? null,
      latitude: lat ?? null,
      longitude: lon ?? null,
      region: p.place ?? null,
      magnitude: p.mag ?? null,
      severity_unit: 'moment magnitude',
      depth_km: depth ?? null,
      tsunami: p.tsunami === 1,
      // USGS assigns a felt/impact significance score; used as given rather
      // than a severity invented here.
      significance: p.sig ?? null,
      last_updated: p.updated ?? p.time ?? null,
    };
  }).sort((a, b) => (b.magnitude ?? 0) - (a.magnitude ?? 0));
}

/** Active tropical cyclones in the NHC basins. */
async function cyclones() {
  const data = await get('https://www.nhc.noaa.gov/CurrentStorms.json', { json: true, retries: 1 });
  return (data.activeStorms ?? []).map((s) => ({
    event_id: `nhc:${s.id}`,
    event_type: 'cyclone',
    subtype: CLASSIFICATION[s.classification] ?? s.classification ?? null,
    source: 'NOAA NHC',
    source_url: s.publicAdvisory?.url ?? 'https://www.nhc.noaa.gov/',
    start_time: s.lastUpdate ? Date.parse(s.lastUpdate) : null,
    status: s.classification ?? null,
    latitude: s.latitudeNumeric ?? null,
    longitude: s.longitudeNumeric ?? null,
    region: BASIN[s.binNumber?.slice(0, 2)] ?? null,
    name: s.name ?? null,
    // Wind is the headline intensity; pressure is carried because it is the
    // measurement that does not depend on an estimation method.
    magnitude: Number(s.intensity) || null,
    severity_unit: 'kt sustained wind',
    pressure_mb: Number(s.pressure) || null,
    movement: s.movementDir != null ? { dir: s.movementDir, speed: s.movementSpeed } : null,
    last_updated: s.lastUpdate ? Date.parse(s.lastUpdate) : null,
  })).sort((a, b) => (b.magnitude ?? 0) - (a.magnitude ?? 0));
}

const CLASSIFICATION = {
  TD: 'Tropical depression', TS: 'Tropical storm', HU: 'Hurricane',
  PTC: 'Potential tropical cyclone', STD: 'Subtropical depression', STS: 'Subtropical storm',
};
const BASIN = { AT: 'Atlantic', EP: 'Eastern Pacific', CP: 'Central Pacific' };

/** US volcanoes currently above normal alert level. */
async function volcanoes() {
  const data = await get('https://volcanoes.usgs.gov/hans-public/api/volcano/getElevatedVolcanoes', { json: true, retries: 1 });
  return (Array.isArray(data) ? data : []).map((v) => ({
    event_id: `usgs-volcano:${v.vnum}`,
    event_type: 'volcano',
    subtype: v.alert_level ?? null,
    source: v.obs_fullname ?? 'USGS',
    source_url: v.notice_url ?? 'https://volcanoes.usgs.gov/',
    start_time: v.sent_unixtime ? v.sent_unixtime * 1000 : null,
    status: v.alert_level ?? null,
    latitude: null, longitude: null,          // the alert feed carries no position
    region: v.volcano_name ?? null,
    name: v.volcano_name ?? null,
    // USGS aviation colour code, used as published.
    colour_code: v.color_code ?? null,
    magnitude: null,
    severity_unit: null,
    last_updated: v.sent_unixtime ? v.sent_unixtime * 1000 : null,
  }));
}

/** Tsunami messages. Usually empty, which is itself the useful answer. */
async function tsunami() {
  const xml = await get('https://www.tsunami.gov/events/xml/PAAQAtom.xml', { retries: 1 });
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)];
  return entries.map(([, block], i) => {
    const tag = (n) => block.match(new RegExp(`<${n}[^>]*>([\\s\\S]*?)</${n}>`, 'i'))?.[1]?.trim() ?? null;
    const title = (tag('title') ?? '').replace(/<[^>]*>/g, '').trim();
    return {
      event_id: `tsunami:${tag('id') ?? i}`,
      event_type: 'tsunami',
      subtype: /warning/i.test(title) ? 'Warning' : /watch/i.test(title) ? 'Watch'
        : /advisory/i.test(title) ? 'Advisory' : 'Information',
      source: 'NOAA NWS Tsunami Warning Center',
      source_url: block.match(/<link[^>]*href="([^"]+)"/i)?.[1] ?? 'https://www.tsunami.gov/',
      start_time: Date.parse(tag('updated') ?? '') || null,
      status: null, latitude: null, longitude: null,
      region: title || null,
      magnitude: null, severity_unit: null,
      last_updated: Date.parse(tag('updated') ?? '') || null,
    };
  });
}

/**
 * Every active hazard, each fetched independently so one agency being down
 * costs only its own category. A failure is reported, not hidden.
 */
export async function activeHazards() {
  const kinds = [
    ['earthquake', earthquakes],
    ['cyclone', cyclones],
    ['volcano', volcanoes],
    ['tsunami', tsunami],
  ];
  const settled = await Promise.all(kinds.map(async ([kind, load]) => {
    try { return { kind, events: await load(), error: null }; } catch (err) { return { kind, events: [], error: err.message }; }
  }));

  return {
    events: settled.flatMap((s) => s.events),
    errors: settled.filter((s) => s.error).map((s) => ({ kind: s.kind, error: s.error })),
  };
}

// ---- earthquake history ---------------------------------------------------

async function countQuakes(minmagnitude, starttime, endtime) {
  const q = new URLSearchParams({ format: 'geojson', minmagnitude: String(minmagnitude), starttime });
  if (endtime) q.set('endtime', endtime);
  const data = await get(`${USGS_COUNT}?${q}`, { json: true, retries: 1 });
  return Number(data.count ?? 0);
}

const WINDOWS = [
  ['24 hours', 1], ['7 days', 7], ['30 days', 30], ['90 days', 90],
];
const THRESHOLDS = [4.5, 6];

/**
 * Counts for the recent windows, plus this year to date against the same
 * calendar window in each of the ten previous years. Comparing YTD with YTD
 * is the only honest form here: a full-year average would flatter a January
 * and damn a December.
 *
 * The catalogue is complete for these magnitudes over this period, so the
 * comparison is like for like. It would not be at M2.5, where detection has
 * improved enough that a rising count would mostly measure the network.
 */
export async function earthquakeHistory(now = new Date()) {
  const today = iso(now);
  const back = (days) => iso(now.getTime() - days * 86400000);

  const recent = {};
  await Promise.all(THRESHOLDS.flatMap((mag) => WINDOWS.map(async ([label, days]) => {
    recent[`${mag}|${label}`] = await countQuakes(mag, back(days));
  })));

  const year = now.getUTCFullYear();
  const monthDay = today.slice(5);
  const ytd = await countQuakes(6, `${year}-01-01`, today);

  const priorYears = [];
  await Promise.all(Array.from({ length: 10 }, (_, i) => year - 1 - i).map(async (y) => {
    priorYears.push({ year: y, count: await countQuakes(6, `${y}-01-01`, `${y}-${monthDay}`) });
  }));
  priorYears.sort((a, b) => b.year - a.year);

  const counts = priorYears.map((p) => p.count);
  const average = counts.length ? counts.reduce((n, c) => n + c, 0) / counts.length : null;

  return {
    windows: WINDOWS.map(([label]) => ({
      label,
      counts: THRESHOLDS.map((mag) => ({ magnitude: mag, count: recent[`${mag}|${label}`] ?? null })),
    })),
    ytd: {
      magnitude: 6,
      year,
      count: ytd,
      through: today,
      average: average != null ? Math.round(average * 10) / 10 : null,
      years: priorYears.length,
      deltaPct: average ? Math.round(((ytd - average) / average) * 100) : null,
      history: priorYears,
    },
    source: {
      name: 'USGS ANSS Comprehensive Catalog',
      url: 'https://earthquake.usgs.gov/fdsnws/event/1/',
      type: 'catalogue',
      note: 'Counts queried live. Magnitudes 4.5 and above, where the global catalogue is complete.',
    },
  };
}
