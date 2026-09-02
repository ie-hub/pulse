// Defense spending, from USAspending.gov — official, keyless.
//
// The agency is toptier code 097. USAspending still publishes it under its
// legal name, "Department of Defense"; the press and its own newsroom now say
// "Department of War". The UI uses the current name and the tip cites the
// source's, so the number can always be traced back.
//
// Two different measures, both reported rather than blended:
//   obligated — money legally committed
//   outlayed  — money actually paid out
// Neither is "the budget": budgetary resources is the authority available.

import { get } from './feeds.mjs';

const AGENCY = '097';
const ENDPOINT = `https://api.usaspending.gov/api/v2/agency/${AGENCY}/budgetary_resources/`;

// Federal periods are months of the fiscal year: 1 = October … 12 = September.
function periodEnd(fiscalYear, period) {
  const month = (period + 8) % 12;                       // period 1 -> Oct (9)
  const year = period <= 3 ? fiscalYear - 1 : fiscalYear;
  return new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10);   // last day of month
}

export async function defenseSpending() {
  const data = await get(ENDPOINT, { json: true, retries: 1 });
  const years = (data?.agency_data_by_year ?? [])
    .filter((y) => Number.isFinite(y.agency_total_obligated))
    .sort((a, b) => b.fiscal_year - a.fiscal_year);
  if (!years.length) throw new Error('no agency year data');

  const cur = years[0];
  const prior = years[1] ?? null;

  // Cumulative obligations through the year, as a dated series for the chart.
  const series = (cur.agency_obligation_by_period ?? [])
    .filter((p) => Number.isFinite(p.obligated) && p.obligated > 0)
    .sort((a, b) => a.period - b.period)
    .map((p) => ({ d: periodEnd(cur.fiscal_year, p.period), c: p.obligated, period: p.period }));

  const share = cur.agency_budgetary_resources
    ? (cur.agency_total_obligated / cur.agency_budgetary_resources) * 100 : null;

  return {
    fiscalYear: cur.fiscal_year,
    obligated: cur.agency_total_obligated,
    outlayed: cur.agency_total_outlayed,
    budgetaryResources: cur.agency_budgetary_resources,
    shareObligated: share,
    throughPeriod: series.at(-1)?.period ?? null,
    series,
    history: years.slice(0, 6).map((y) => ({
      fiscalYear: y.fiscal_year,
      obligated: y.agency_total_obligated,
      outlayed: y.agency_total_outlayed,
      authority: y.agency_budgetary_resources,
    })),
    prior: prior ? { fiscalYear: prior.fiscal_year, obligated: prior.agency_total_obligated } : null,
    source: {
      name: 'USAspending.gov',
      publishedAs: 'Department of Defense (toptier agency 097)',
      type: 'Agency budgetary resources, official',
      url: `https://www.usaspending.gov/agency/${AGENCY}`,
    },
  };
}
