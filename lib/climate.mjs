// The state of the planet, as observations rather than events.
//
// An observation is a measurement: what the value is, what it is measured
// against, and how unusual it is. Every one carries its own baseline, because
// these datasets do not share one — GISTEMP is against 1951–1980, NCEI against
// 1901–2000, NSIDC against 1981–2010. Presenting them as one number would be
// the sort of quiet mixing this dashboard exists to avoid, so the baseline
// travels with the value and the UI prints it.
//
// Nothing here is real-time. Sea ice is a day behind, CO2 a day or two,
// GISTEMP monthly, NCEI monthly. Each says so in `cadence`.
//
// Every source below was reachable without credentials when this was written.
// A failure returns an `unavailable` observation carrying the reason rather
// than a gap or a substituted figure.

import { get } from './feeds.mjs';

const num = (s) => {
  const v = Number.parseFloat(s);
  return Number.isFinite(v) ? v : null;
};

/** An observation that could not be made, and why. */
const unavailable = (metric, label, source, reason) => ({
  metric, label, value: null, unavailable: true, reason, source,
});

// ---- classification -------------------------------------------------------

// Bands are derived from the dataset's own distribution, never from a threshold
// invented here. Where a source publishes percentiles (NSIDC does), those are
// used directly; otherwise the value is ranked against the historical series
// supplied with it.
export function bandFromPercentile(p) {
  if (p == null) return null;
  if (p >= 98 || p <= 2) return 'extreme';
  if (p >= 90 || p <= 10) return 'high';
  if (p >= 75 || p <= 25) return 'elevated';
  return 'normal';
}

/** Percentile of `value` within `history`, as a whole number 0–100. */
export function percentileOf(value, history) {
  const xs = history.filter(Number.isFinite).sort((a, b) => a - b);
  if (xs.length < 20 || !Number.isFinite(value)) return null;
  let below = 0;
  for (const x of xs) { if (x < value) below += 1; else break; }
  return Math.round((below / xs.length) * 100);
}

// ---- global surface temperature -------------------------------------------

const GISTEMP = 'https://data.giss.nasa.gov/gistemp/tabledata_v4/GLB.Ts+dSST.csv';

// GISTEMP publishes monthly land-ocean anomalies against its own 1951–1980
// baseline. Values are printed to two decimals with *** for months not yet
// published, so the newest complete month is the last parseable cell.
export async function globalTemperature() {
  const source = {
    name: 'NASA GISTEMP v4', url: GISTEMP, type: 'analysis',
    note: 'Land–ocean surface temperature index, monthly.',
  };
  try {
    const rows = (await get(GISTEMP, { retries: 1 })).trim().split('\n');
    const start = rows.findIndex((r) => r.startsWith('Year'));
    const monthly = [];        // [{ year, month, anomaly }]
    for (const row of rows.slice(start + 1)) {
      const cells = row.split(',');
      const year = num(cells[0]);
      if (!year) continue;
      for (let m = 1; m <= 12; m += 1) {
        const v = num(cells[m]);
        if (v != null) monthly.push({ year, month: m, anomaly: v });
      }
    }
    if (!monthly.length) throw new Error('no parseable months');

    const latest = monthly[monthly.length - 1];
    // Rank against the same calendar month across the record, so a warm August
    // is judged against other Augusts rather than against Januaries.
    const sameMonth = monthly.filter((p) => p.month === latest.month).map((p) => p.anomaly);
    const percentile = percentileOf(latest.anomaly, sameMonth);

    return {
      metric: 'temp_anomaly',
      label: 'Global temperature',
      value: latest.anomaly,
      // The value is itself a departure, so it carries a sign. Sea ice and CO2
      // below are absolute quantities and must not be rendered the same way.
      valueIsAnomaly: true,
      unit: '°C',
      baseline: '1951–1980',
      anomaly: latest.anomaly,
      percentile,
      band: bandFromPercentile(percentile),
      timestamp: Date.UTC(latest.year, latest.month - 1, 1),
      cadence: 'monthly',
      series: monthly.slice(-360).map((p) => ({ d: `${p.year}-${String(p.month).padStart(2, '0')}-01`, c: p.anomaly })),
      compare: `warmest ${percentile != null ? `${100 - percentile}%` : '—'} of ${monthName(latest.month)}s on record`,
      source,
    };
  } catch (err) {
    return unavailable('temp_anomaly', 'Global temperature', source, err.message);
  }
}

const monthName = (m) => ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'][m - 1] ?? '';

// ---- atmospheric CO2 ------------------------------------------------------

const CO2 = 'https://gml.noaa.gov/webdata/ccgg/trends/co2/co2_trend_gl.txt';

// Columns: year month day smoothed trend. The trend column is de-seasonalised,
// which is the one worth showing — the smoothed series swings several ppm a
// year on the seasonal cycle alone and would read as change that is not there.
export async function atmosphericCo2() {
  const source = {
    name: 'NOAA GML', url: 'https://gml.noaa.gov/ccgg/trends/gl_trend.html', type: 'observation',
    note: 'Global mean from four baseline observatories, de-seasonalised.',
  };
  try {
    const rows = (await get(CO2, { retries: 1 })).split('\n')
      .filter((r) => r.trim() && !r.startsWith('#'))
      .map((r) => r.trim().split(/\s+/))
      .filter((c) => c.length >= 5);
    if (!rows.length) throw new Error('no parseable rows');

    const at = (c) => ({
      t: Date.UTC(num(c[0]), num(c[1]) - 1, num(c[2])),
      trend: num(c[4]),
    });
    const latest = at(rows[rows.length - 1]);
    const yearAgo = rows.map(at).filter((p) => p.t <= latest.t - 365 * 86400000).pop();

    return {
      metric: 'co2',
      label: 'Atmospheric CO₂',
      value: latest.trend,
      valueIsAnomaly: false,
      unit: 'ppm',
      // Not an anomaly against a climatology — it is an absolute concentration.
      baseline: null,
      change1y: yearAgo ? Number((latest.trend - yearAgo.trend).toFixed(2)) : null,
      timestamp: latest.t,
      cadence: 'daily',
      series: rows.map(at).filter((_, i, a) => i % 7 === 0 || i === a.length - 1)
        .map((p) => ({ d: new Date(p.t).toISOString().slice(0, 10), c: p.trend })),
      compare: yearAgo ? `+${(latest.trend - yearAgo.trend).toFixed(2)} ppm over the past year` : null,
      source,
    };
  } catch (err) {
    return unavailable('co2', 'Atmospheric CO₂', source, err.message);
  }
}

// ---- sea ice --------------------------------------------------------------

const ICE_BASE = 'https://noaadata.apps.nsidc.org/NOAA/G02135';

// NSIDC publishes the daily extent and, separately, a 1981–2010 climatology
// giving the mean and the 10th/25th/50th/75th/90th percentiles for each day of
// the year. That is what makes the "unusual" judgement here a measured one:
// today's extent is placed in the source's own published distribution for
// today's date, not against a threshold chosen by this dashboard.
async function seaIce(pole) {
  const P = pole === 'north' ? 'N' : 'S';
  const label = pole === 'north' ? 'Arctic sea ice' : 'Antarctic sea ice';
  const source = {
    name: 'NSIDC Sea Ice Index v4', url: `https://nsidc.org/data/g02135`, type: 'observation',
    note: 'Daily extent from passive microwave satellite, one day behind.',
  };
  try {
    const [dailyCsv, climCsv] = await Promise.all([
      get(`${ICE_BASE}/${pole}/daily/data/${P}_seaice_extent_daily_v4.0.csv`, { retries: 1, timeout: 30000 }),
      get(`${ICE_BASE}/${pole}/daily/data/${P}_seaice_extent_climatology_1981-2010_v4.0.csv`, { retries: 1 }),
    ]);

    const daily = dailyCsv.split('\n').slice(2)
      .map((r) => r.split(',').map((c) => c.trim()))
      .filter((c) => c.length >= 4 && num(c[0]) && num(c[3]) != null)
      .map((c) => ({ y: num(c[0]), m: num(c[1]), d: num(c[2]), extent: num(c[3]) }));
    if (!daily.length) throw new Error('no parseable daily extent');

    const latest = daily[daily.length - 1];
    const t = Date.UTC(latest.y, latest.m - 1, latest.d);
    const doy = Math.floor((t - Date.UTC(latest.y, 0, 0)) / 86400000);

    // climatology: DOY, mean, sd, p10, p25, p50, p75, p90
    const clim = climCsv.split('\n').slice(1)
      .map((r) => r.split(',').map((c) => c.trim()))
      .filter((c) => c.length >= 8 && num(c[0]))
      .find((c) => num(c[0]) === doy);

    let percentile = null;
    let band = null;
    let anomaly = null;
    if (clim) {
      const [mean, , p10, p25, p50, p75, p90] = clim.slice(1).map(num);
      anomaly = Number((latest.extent - mean).toFixed(3));
      // Placed in the published bands rather than interpolated into a false
      // precision the source does not offer.
      if (latest.extent <= p10) { percentile = 10; band = 'extreme'; }
      else if (latest.extent <= p25) { percentile = 25; band = 'high'; }
      else if (latest.extent <= p50) { percentile = 50; band = 'elevated'; }
      else if (latest.extent <= p75) { percentile = 75; band = 'normal'; }
      else if (latest.extent <= p90) { percentile = 90; band = 'elevated'; }
      else { percentile = 95; band = 'high'; }
    }

    return {
      metric: `sea_ice_${pole}`,
      label,
      // Absolute extent. The departure from the baseline is `anomaly`.
      value: latest.extent,
      valueIsAnomaly: false,
      unit: 'M km²',
      baseline: '1981–2010',
      anomaly,
      percentile,
      band,
      timestamp: t,
      cadence: 'daily',
      // One point per week keeps the payload sane; the full record is 17k days.
      series: daily.filter((_, i, a) => i % 7 === 0 || i === a.length - 1)
        .slice(-520)
        .map((p) => ({ d: `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`, c: p.extent })),
      compare: anomaly != null
        ? `${anomaly >= 0 ? '+' : '−'}${Math.abs(anomaly).toFixed(2)} M km² vs the 1981–2010 average for this day`
        : null,
      source,
    };
  } catch (err) {
    return unavailable(`sea_ice_${pole}`, label, source, err.message);
  }
}

// ---- ocean ----------------------------------------------------------------

// NOAA's Climate at a Glance publishes annual ocean temperature departures
// against a 1901–2000 base period. Monthly resolution, and the current month is
// not final, so this is the most recent complete series rather than a live read.
async function oceanTemperature() {
  const year = new Date().getUTCFullYear();
  const cag = (m) => 'https://www.ncei.noaa.gov/access/monitoring/climate-at-a-glance'
    + `/global/time-series/globe/ocean/1/${m}/1850-${year}/data.json`;
  const source = {
    name: 'NOAA NCEI Climate at a Glance', url: cag(new Date().getUTCMonth() + 1), type: 'analysis',
    note: 'Global ocean surface temperature departure, monthly.',
  };
  try {
    // NCEI publishes a month some weeks after it ends, so asking for the
    // current month returns last year's value for that month — a figure a year
    // out of date presented as current. Walk back to the newest month that has
    // actually been published for this year.
    let data = null;
    let month = null;
    for (let back = 0; back < 5 && !data; back += 1) {
      const m = ((new Date().getUTCMonth() - back) + 12) % 12 + 1;
      const candidate = await get(cag(m), { json: true, retries: 1 });
      const years = Object.keys(candidate.data ?? {}).map(Number);
      if (years.length && Math.max(...years) === year) { data = candidate; month = m; }
    }
    if (!data) throw new Error(`no month published for ${year} yet`);
    source.url = cag(month);

    const entries = Object.entries(data.data ?? {})
      .map(([year, v]) => ({ year: Number(year), departure: num(v.departure) }))
      .filter((p) => Number.isFinite(p.year) && p.departure != null);
    if (!entries.length) throw new Error('no parseable years');

    const latest = entries[entries.length - 1];
    const percentile = percentileOf(latest.departure, entries.map((p) => p.departure));

    return {
      metric: 'ocean_temp',
      label: 'Ocean surface temperature',
      value: latest.departure,
      valueIsAnomaly: true,
      unit: '°C',
      baseline: data.description?.base_period ?? '1901–2000',
      anomaly: latest.departure,
      percentile,
      band: bandFromPercentile(percentile),
      timestamp: Date.UTC(latest.year, month - 1, 1),
      cadence: 'monthly',
      series: entries.slice(-120).map((p) => ({ d: `${p.year}-01-01`, c: p.departure })),
      compare: `${data.description?.title ?? 'ocean departure'}`,
      source,
    };
  } catch (err) {
    return unavailable('ocean_temp', 'Ocean surface temperature', source, err.message);
  }
}

// ---- assembly -------------------------------------------------------------

export async function climateState() {
  const [temp, co2, arctic, antarctic, ocean] = await Promise.all([
    globalTemperature(), atmosphericCo2(), seaIce('north'), seaIce('south'), oceanTemperature(),
  ]);
  return [temp, ocean, arctic, antarctic, co2];
}
