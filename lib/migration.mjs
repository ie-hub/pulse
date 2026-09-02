// Immigration, as three kinds of number that must not be added together.
//
//   STOCK       how many foreign-born people are present at a moment.
//   FLOW        how many arrived or left over a period.
//   PROTECTION  how many hold, or are seeking, a protection status.
//
// A migrant stock of 52 million, net migration of 1.2 million and 3.2 million
// pending asylum seekers describe three different things. They are kept in
// separate shapes here so the UI cannot casually present one as another.
//
// Every figure carries its period, whether that period is a calendar year, a
// fiscal year or a point-in-time estimate, its definition in the publisher's
// own words, and where it came from.
//
// SOURCES USED — both keyless, both verified reachable from this network:
//   World Bank  migrant stock, share of population, net migration.
//   UNHCR       refugees and asylum-seekers, by country of asylum and origin.
//
// SOURCES NOT USED, and why. The US administrative series — CBP encounters,
// DHS green cards and naturalisations, USCIS asylum, EOIR courts, State
// Department visas — are published as PDF and spreadsheet behind rendered
// pages, with no public machine-readable endpoint found. The Census ACS has
// one, but now requires a key. None of them are approximated with something
// weaker: a metric that cannot be sourced is absent rather than invented.

import { get } from './feeds.mjs';

const WB = 'https://api.worldbank.org/v2';
const UNHCR = 'https://api.unhcr.org/population/v1';

/** World Bank series for one country, oldest first, nulls dropped. */
async function wbSeries(country, indicator) {
  const url = `${WB}/country/${country}/indicator/${indicator}?format=json&per_page=400`;
  const body = await get(url, { json: true, retries: 1 });
  const rows = (body?.[1] ?? []).filter((r) => r.value != null);
  return {
    name: rows[0]?.indicator?.value ?? indicator,
    updated: body?.[0]?.lastupdated ?? null,
    points: rows.map((r) => ({ year: Number(r.date), value: Number(r.value) }))
      .sort((a, b) => a.year - b.year),
  };
}

/** Where `value` sits in its own history, as a whole percentile. */
function rankIn(value, points) {
  const xs = points.map((p) => p.value).sort((a, b) => a - b);
  if (xs.length < 8) return null;
  const below = xs.filter((x) => x < value).length;
  return Math.round((below / xs.length) * 100);
}

// Neutral by design. An increase in migration is neither good nor bad, so the
// wording describes position in the record and nothing more.
function standing(value, points) {
  if (points.length < 8) return null;
  const xs = points.map((p) => p.value);
  const max = Math.max(...xs);
  const min = Math.min(...xs);
  if (value === max) return 'highest on record';
  if (value === min) return 'lowest on record';
  const pct = rankIn(value, points);
  if (pct == null) return null;
  if (pct >= 90) return 'near the top of its record';
  if (pct <= 10) return 'near the bottom of its record';
  return 'within its historical range';
}

function measure({ metric, label, series, unit, periodType, definition, source, decimals = 0 }) {
  const points = series.points;
  if (!points.length) throw new Error(`${metric}: no observations`);
  const latest = points[points.length - 1];
  const prior = points[points.length - 2] ?? null;
  // Migrant stock is published every five years, so an exact year-minus-ten
  // rarely exists. Take the newest observation at or before that point and
  // report the span actually used, rather than silently comparing the wrong
  // interval or dropping the comparison.
  const target = latest.year - 10;
  const older = points.filter((p) => p.year <= target);
  const tenBack = older.length ? older[older.length - 1] : null;

  return {
    metric,
    label,
    value: latest.value,
    unit,
    decimals,
    period: String(latest.year),
    // Explicit, because US immigration data mixes fiscal and calendar years and
    // these two are calendar-year estimates, not FY.
    period_type: periodType,
    changePriorPct: prior ? ((latest.value - prior.value) / prior.value) * 100 : null,
    change10yPct: tenBack ? ((latest.value - tenBack.value) / tenBack.value) * 100 : null,
    change10ySpan: tenBack ? latest.year - tenBack.year : null,
    percentile: rankIn(latest.value, points),
    standing: standing(latest.value, points),
    series: points.map((p) => ({ d: `${p.year}-01-01`, c: p.value })),
    definition,
    source: { ...source, updated: series.updated },
  };
}

const WB_SOURCE = {
  name: 'World Bank', url: 'https://data.worldbank.org/', type: 'estimate',
  cadence: 'annual, revised periodically',
};

// ---- United States --------------------------------------------------------

export async function usMigration() {
  const out = { stock: [], flow: [], protection: [], errors: [] };

  const add = async (bucket, fn) => {
    try { bucket.push(await fn()); } catch (err) { out.errors.push(err.message); }
  };

  await Promise.all([
    add(out.stock, async () => measure({
      metric: 'migrant_stock', label: 'Foreign-born population',
      series: await wbSeries('USA', 'SM.POP.TOTL'), unit: 'people', periodType: 'calendar year',
      definition: 'International migrant stock: people living in a country other than the one they '
        + 'were born in, counted at a point in time. It is a population, not an annual arrival figure.',
      source: { ...WB_SOURCE, url: 'https://data.worldbank.org/indicator/SM.POP.TOTL' },
    })),
    add(out.stock, async () => measure({
      metric: 'migrant_share', label: 'Share of US population',
      series: await wbSeries('USA', 'SM.POP.TOTL.ZS'), unit: '%', periodType: 'calendar year', decimals: 1,
      definition: 'Migrant stock as a percentage of total population.',
      source: { ...WB_SOURCE, url: 'https://data.worldbank.org/indicator/SM.POP.TOTL.ZS' },
    })),
    add(out.flow, async () => measure({
      metric: 'net_migration', label: 'Net migration',
      series: await wbSeries('USA', 'SM.POP.NETM'), unit: 'people', periodType: 'calendar year',
      definition: 'Arrivals minus departures over the period, all nationalities. A net figure: it '
        + 'is not a count of immigrants admitted, and it cannot be compared with an admissions total.',
      source: { ...WB_SOURCE, url: 'https://data.worldbank.org/indicator/SM.POP.NETM' },
    })),
  ]);

  try {
    out.protection = await usProtection();
  } catch (err) {
    out.errors.push(`protection: ${err.message}`);
  }

  return out;
}

/** Refugees and asylum-seekers whose country of asylum is the United States. */
async function usProtection() {
  const year = new Date().getUTCFullYear();
  const body = await get(`${UNHCR}/population/?yearFrom=${year - 12}&yearTo=${year}&coa=USA&limit=100`,
    { json: true, retries: 1 });
  const items = (body?.items ?? [])
    .map((r) => ({ year: Number(r.year), refugees: Number(r.refugees) || 0, seekers: Number(r.asylum_seekers) || 0 }))
    .filter((r) => Number.isFinite(r.year))
    .sort((a, b) => a.year - b.year);
  if (!items.length) throw new Error('no UNHCR observations');

  const src = {
    name: 'UNHCR Refugee Data Finder', url: 'https://www.unhcr.org/refugee-statistics/',
    type: 'compiled from government returns', cadence: 'annual', updated: null,
  };

  const build = (key, label, definition) => {
    const points = items.map((r) => ({ year: r.year, value: r[key] }));
    return measure({
      metric: `us_${key}`, label, series: { points, updated: null }, unit: 'people',
      periodType: 'calendar year, end of period', definition, source: src,
    });
  };

  return [
    build('refugees', 'Refugees hosted',
      'People recognised as refugees and present in the United States at the end of the year. A '
      + 'stock, not the number admitted that year, and distinct from asylum grants.'),
    build('seekers', 'Asylum-seekers pending',
      'People whose asylum claim was pending at the end of the year. A pending caseload, not '
      + 'applications filed and not decisions made.'),
  ];
}

// ---- international comparison ---------------------------------------------

const PEERS = ['USA', 'CAN', 'MEX', 'GBR', 'DEU', 'FRA', 'AUS', 'JPN', 'KOR', 'ITA', 'ESP'];

/**
 * The same indicator across peers, most recent year each. Comparable because
 * every figure is the World Bank's own migrant-stock estimate on one
 * definition — which national statistics are not: some count foreign-born,
 * others foreign citizens, and those are different populations.
 */
export async function internationalComparison() {
  const one = async (indicator) => {
    const url = `${WB}/country/${PEERS.join(';')}/indicator/${indicator}?format=json&per_page=400&mrnev=1`;
    const body = await get(url, { json: true, retries: 1 });
    return new Map((body?.[1] ?? []).filter((r) => r.value != null)
      .map((r) => [r.countryiso3code || r.country?.id, { value: Number(r.value), year: Number(r.date), name: r.country?.value }]));
  };

  const [stock, share] = await Promise.all([one('SM.POP.TOTL'), one('SM.POP.TOTL.ZS')]);

  return {
    countries: PEERS.map((iso) => {
      const s = stock.get(iso);
      const p = share.get(iso);
      return s ? { iso, name: s.name, stock: s.value, year: s.year, share: p?.value ?? null } : null;
    }).filter(Boolean).sort((a, b) => b.stock - a.stock),
    definition: 'International migrant stock — people living in a country other than their country '
      + 'of birth — on the World Bank’s single definition, so the countries are comparable. National '
      + 'statistics are not: some count the foreign-born, others foreign citizens.',
    source: { ...WB_SOURCE, url: 'https://data.worldbank.org/indicator/SM.POP.TOTL' },
  };
}
