// U.S. public debt, from Treasury's Fiscal Data service — the official record,
// published daily to the penny. Free and keyless, like the yield curve.

import { get } from './feeds.mjs';

const BASE = 'https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/debt_to_penny';
const DAY = 86400000;

/** Last observation on or before `daysBack` from the newest point. */
function before(series, daysBack) {
  const end = Date.parse(`${series.at(-1).d}T12:00:00Z`);
  let found = null;
  for (const p of series) {
    if (Date.parse(`${p.d}T12:00:00Z`) <= end - daysBack * DAY) found = p; else break;
  }
  return found;
}

export async function usDebt() {
  const url = `${BASE}?sort=-record_date&page%5Bsize%5D=400`
            + '&fields=record_date,tot_pub_debt_out_amt,debt_held_public_amt,intragov_hold_amt';
  const data = await get(url, { json: true, retries: 1 });
  const rows = (data?.data ?? []).filter((r) => Number.isFinite(Number(r.tot_pub_debt_out_amt)));
  if (!rows.length) throw new Error('no rows returned');

  // API returns newest first; series runs oldest → newest like every other one.
  const series = rows.map((r) => ({ d: r.record_date, c: Number(r.tot_pub_debt_out_amt) })).reverse();
  const latest = rows[0];
  const now = series.at(-1);

  const year = now.d.slice(0, 4);
  const startOfYear = series.filter((p) => p.d < `${year}-01-01`).at(-1)
    ?? series.find((p) => p.d >= `${year}-01-01`);

  const delta = (from) => (from ? { abs: now.c - from.c, pct: ((now.c - from.c) / from.c) * 100, from: from.d } : null);

  return {
    total: now.c,
    heldByPublic: Number(latest.debt_held_public_amt) || null,
    intragovernmental: Number(latest.intragov_hold_amt) || null,
    observedOn: now.d,
    series,
    changes: {
      d1: delta(series.at(-2)),
      m1: delta(before(series, 30)),
      ytd: delta(startOfYear),
      y1: delta(before(series, 365)),
    },
    source: {
      name: 'U.S. Treasury — Fiscal Data',
      type: 'Debt to the Penny, official daily',
      freshness: 'daily official',
      url: 'https://fiscaldata.treasury.gov/datasets/debt-to-the-penny/debt-to-the-penny',
    },
  };
}
