// U.S. money going abroad, by country.
//
// Source: USAspending.gov — official, keyless. ForeignAssistance.gov is the
// authoritative foreign-assistance publisher, but its host is unreachable from
// this network, so this is built from federal award data instead and labelled
// for exactly what it is.
//
// The measure is: grant and cooperative-agreement obligations whose WORK IS
// PERFORMED in a given country.
//
// Why place of performance and not recipient location: most USAID and State
// grant money is awarded to organisations registered in the United States, so
// grouping by recipient location puts $2.9bn under "United States" and lists
// Norway and Austria above Ethiopia. Place of performance answers the question
// actually being asked.
//
// What this is NOT: the official foreign aid total. It excludes contracts,
// loans and credit guarantees, and military assistance delivered by other
// mechanisms. Treat it as the grant-shaped share of what the U.S. sends abroad.

const ENDPOINT = 'https://api.usaspending.gov/api/v2/search/spending_by_geography/';
const iso = (d) => d.toISOString().slice(0, 10);

/** Federal fiscal years run Oct–Sep. Returns the FY that `now` falls inside. */
export function currentFiscalYear(now = new Date()) {
  return now.getMonth() >= 9 ? now.getFullYear() + 1 : now.getFullYear();
}

async function byCountry(startDate, endDate) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'personal-dashboard/1.0 (local; single user)' },
    body: JSON.stringify({
      scope: 'place_of_performance',
      geo_layer: 'country',
      filters: {
        time_period: [{ start_date: startDate, end_date: endDate }],
        award_type_codes: ['02', '03', '04', '05'],   // grants and cooperative agreements
      },
    }),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error(`USAspending HTTP ${res.status}`);
  const data = await res.json();

  const map = new Map();
  for (const r of data?.results ?? []) {
    if (r.shape_code === 'USA') continue;             // spending performed at home is not aid abroad
    const amount = Number(r.aggregated_amount);
    if (!(amount > 0)) continue;
    map.set(r.shape_code, { code: r.shape_code, name: r.display_name, amount });
  }
  return map;
}

export async function foreignAid(now = new Date()) {
  const fy = currentFiscalYear(now);                  // e.g. 2026
  const fyStart = new Date(Date.UTC(fy - 1, 9, 1));   // 1 Oct of the prior calendar year
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  // The same window one year earlier, so year-on-year compares like with like
  // rather than a part-year against a full one.
  const priorStart = new Date(Date.UTC(fy - 2, 9, 1));
  const priorEnd = new Date(Date.UTC(today.getUTCFullYear() - 1, today.getUTCMonth(), today.getUTCDate()));

  // The last fully closed fiscal year, for context.
  const lastFullStart = new Date(Date.UTC(fy - 2, 9, 1));
  const lastFullEnd = new Date(Date.UTC(fy - 1, 8, 30));

  const [ytd, prior, lastFull] = await Promise.all([
    byCountry(iso(fyStart), iso(today)),
    byCountry(iso(priorStart), iso(priorEnd)),
    byCountry(iso(lastFullStart), iso(lastFullEnd)),
  ]);

  // Union of both years: a country that received money last year but nothing so
  // far this year still belongs in the list, at zero.
  const codes = new Set([...ytd.keys(), ...lastFull.keys()]);
  const countries = [...codes].map((code) => {
    const cur = ytd.get(code);
    const full = lastFull.get(code);
    const was = prior.get(code)?.amount ?? null;
    const amount = cur?.amount ?? 0;
    return {
      code,
      name: cur?.name ?? full?.name ?? code,
      amount,                                   // this fiscal year to date
      lastFullAmount: full?.amount ?? 0,        // last complete fiscal year
      priorAmount: was,                         // same window one year earlier
      delta: was == null ? null : amount - was,
      deltaPct: was ? ((amount - was) / was) * 100 : null,
    };
  }).sort((a, b) => b.amount - a.amount || b.lastFullAmount - a.lastFullAmount);

  if (!countries.length) throw new Error('no country rows returned');

  const sum = (m) => [...m.values()].reduce((s, c) => s + c.amount, 0);

  return {
    fiscalYear: fy,
    period: { start: iso(fyStart), end: iso(today) },
    priorPeriod: { start: iso(priorStart), end: iso(priorEnd) },
    lastFullYear: { fiscalYear: fy - 1, total: sum(lastFull), countries: lastFull.size },
    total: sum(ytd),
    priorTotal: sum(prior),
    countries,
    measure: 'Grant and cooperative-agreement obligations, by place of performance',
    caveat: 'Not the official foreign assistance total. Excludes contracts, loans and military '
      + 'assistance delivered through other mechanisms, and excludes spending performed inside the U.S.',
    source: {
      name: 'USAspending.gov',
      type: 'Federal award data',
      url: 'https://www.usaspending.gov/search',
    },
  };
}
