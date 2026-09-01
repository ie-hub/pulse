// Market data with provenance as a first-class property.
//
// Different instruments have different authoritative sources, so each one
// declares its provider rather than everything coming from one place:
//
//   treasury  U.S. Treasury par yield curve      official, daily
//   cboe      Cboe VIX history                   official, daily close
//   lbma      LBMA precious metal benchmark      benchmark, daily
//   yahoo     exchange-derived quotes            market data, delayed
//   fred      FRED series                        UNREACHABLE from this network
//
// Nothing is labelled live: none of these are. A number is always presented
// with what it is, when it was measured, and where it came from.

import { get } from './feeds.mjs';

const DAY = 86400000;

// ---- instrument registry --------------------------------------------------

export const INSTRUMENTS = [
  // energy
  { id: 'brent', name: 'Brent crude', group: 'Energy', provider: 'yahoo', symbol: 'BZ=F', unit: '/bbl', format: 'price' },
  { id: 'crude', name: 'WTI crude', group: 'Energy', provider: 'yahoo', symbol: 'CL=F', unit: '/bbl', format: 'price' },
  { id: 'gas', name: 'Natural gas', group: 'Energy', provider: 'yahoo', symbol: 'NG=F', unit: '/MMBtu', format: 'price' },

  // metals — LBMA is the benchmark of record for gold and silver
  { id: 'gold', name: 'Gold', group: 'Metals', provider: 'lbma', symbol: 'gold_pm', unit: '/oz', format: 'price' },
  { id: 'silver', name: 'Silver', group: 'Metals', provider: 'lbma', symbol: 'silver', unit: '/oz', format: 'price' },
  { id: 'copper', name: 'Copper', group: 'Metals', provider: 'yahoo', symbol: 'HG=F', unit: '/lb', format: 'price' },

  // currencies
  { id: 'dxy', name: 'Dollar index', group: 'Currencies', provider: 'yahoo', symbol: 'DX-Y.NYB', unit: '', format: 'index' },
  { id: 'eurusd', name: 'EUR / USD', group: 'Currencies', provider: 'yahoo', symbol: 'EURUSD=X', unit: '', format: 'fx' },
  { id: 'usdjpy', name: 'USD / JPY', group: 'Currencies', provider: 'yahoo', symbol: 'USDJPY=X', unit: '', format: 'fx' },
  { id: 'usdcny', name: 'USD / CNY', group: 'Currencies', provider: 'yahoo', symbol: 'USDCNY=X', unit: '', format: 'fx' },

  // rates — official par yields, changes quoted in basis points
  { id: 'ust2y', name: '2-year Treasury', group: 'Rates', provider: 'treasury', symbol: '2 Yr', unit: '', format: 'rate' },
  { id: 'ust10y', name: '10-year Treasury', group: 'Rates', provider: 'treasury', symbol: '10 Yr', unit: '', format: 'rate' },
  { id: 'ust30y', name: '30-year Treasury', group: 'Rates', provider: 'treasury', symbol: '30 Yr', unit: '', format: 'rate' },
  { id: 'curve', name: '10y – 2y spread', group: 'Rates', provider: 'derived', unit: '', format: 'spread' },
  { id: 'fedfunds', name: 'Fed funds rate', group: 'Rates', provider: 'fred', symbol: 'DFF', unit: '', format: 'rate' },

  // equities
  { id: 'sp500', name: 'S&P 500', group: 'Equities', provider: 'yahoo', symbol: '^GSPC', unit: '', format: 'index' },
  { id: 'nasdaq', name: 'Nasdaq 100', group: 'Equities', provider: 'yahoo', symbol: '^NDX', unit: '', format: 'index' },
  { id: 'russell', name: 'Russell 2000', group: 'Equities', provider: 'yahoo', symbol: '^RUT', unit: '', format: 'index' },
  { id: 'vix', name: 'VIX', group: 'Equities', provider: 'cboe', symbol: 'VIX', unit: '', format: 'index' },

  // other
  { id: 'bitcoin', name: 'Bitcoin', group: 'Other', provider: 'yahoo', symbol: 'BTC-USD', unit: '', format: 'price' },
  { id: 'wheat', name: 'Wheat', group: 'Other', provider: 'yahoo', symbol: 'ZW=F', unit: '/bu', format: 'price' },
];

export const GROUPS = ['Energy', 'Metals', 'Currencies', 'Rates', 'Equities', 'Other'];

// ---- shared fetch cache ---------------------------------------------------
// Treasury, Cboe and LBMA each serve several instruments from one file.

const shared = new Map();
const TTL = 20 * 60 * 1000;

async function once(key, load) {
  const hit = shared.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.promise;
  const promise = load().catch((err) => { shared.delete(key); throw err; });
  shared.set(key, { at: Date.now(), promise });
  return promise;
}

// ---- providers ------------------------------------------------------------

async function yahooSeries(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5y&interval=1d`;
  const data = await get(url, { json: true, retries: 2 });
  const r = data?.chart?.result?.[0];
  if (!r) throw new Error(data?.chart?.error?.description ?? 'no data');

  const cents = r.meta?.currency === 'USX';
  const scale = (n) => (typeof n === 'number' ? (cents ? n / 100 : n) : n);
  const stamps = r.timestamp ?? [];
  const closes = r.indicators?.quote?.[0]?.close ?? [];
  const series = [];
  closes.forEach((c, i) => {
    if (typeof c === 'number' && stamps[i]) series.push({ d: new Date(stamps[i] * 1000).toISOString().slice(0, 10), c: scale(c) });
  });
  if (!series.length) throw new Error('empty series');

  const live = scale(r.meta?.regularMarketPrice);
  if (typeof live === 'number' && series.at(-1)) series.at(-1).c = live;

  return {
    series,
    currency: cents ? 'USD' : (r.meta?.currency ?? 'USD'),
    asOf: r.meta?.regularMarketTime ? r.meta.regularMarketTime * 1000 : null,
    source: { name: r.meta?.fullExchangeName ? `${r.meta.fullExchangeName} via Yahoo Finance` : 'Yahoo Finance',
      type: 'Exchange-derived market data', freshness: 'delayed', isLive: false, isDelayed: true, isReference: false },
  };
}

const csvRows = (text) => text.trim().split('\n').map((l) => l.split(',').map((c) => c.replace(/^"|"$/g, '').trim()));

// U.S. Treasury par yield curve — the official source for Treasury yields.
async function treasuryCurve() {
  return once('treasury', async () => {
    const year = new Date().getFullYear();
    const url = 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/'
      + `daily-treasury-rates.csv/${year}/all?type=daily_treasury_yield_curve`
      + `&field_tdr_date_value=${year}&page&_format=csv`;
    const rows = csvRows(await get(url, { retries: 1 }));
    const head = rows[0];
    const byTenor = {};
    head.forEach((h, i) => { if (i) byTenor[h] = []; });

    for (const row of rows.slice(1).reverse()) {          // file is newest-first
      const [m, d, y] = row[0].split('/');
      const iso = `${y}-${m}-${d}`;
      head.forEach((h, i) => {
        if (!i) return;
        const v = Number.parseFloat(row[i]);
        if (Number.isFinite(v)) byTenor[h].push({ d: iso, c: v });
      });
    }
    return byTenor;
  });
}

// Cboe publishes the official daily VIX close.
async function cboeVix() {
  return once('cboe', async () => {
    const rows = csvRows(await get('https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv', { retries: 1 }));
    const series = [];
    for (const row of rows.slice(1)) {
      const [m, d, y] = row[0].split('/');
      const close = Number.parseFloat(row[4]);
      if (Number.isFinite(close)) series.push({ d: `${y}-${m}-${d}`, c: close });
    }
    return series.slice(-1300);
  });
}

// LBMA benchmark: the price of record for gold and silver, set daily.
async function lbmaSeries(file) {
  return once(`lbma:${file}`, async () => {
    const data = await get(`https://prices.lbma.org.uk/json/${file}.json`, { json: true, retries: 1 });
    const series = data
      .filter((row) => row?.d && Number.isFinite(row?.v?.[0]))
      .map((row) => ({ d: row.d, c: row.v[0] }));            // v = [USD, GBP, EUR]
    return series.slice(-1300);
  });
}

// ---- horizons, regime -----------------------------------------------------

/** Last observation on or before `daysBack` from the newest point. */
function valueBefore(series, daysBack) {
  const end = new Date(`${series.at(-1).d}T12:00:00Z`).getTime();
  const target = end - daysBack * DAY;
  let found = null;
  for (const p of series) {
    if (new Date(`${p.d}T12:00:00Z`).getTime() <= target) found = p; else break;
  }
  return found;
}

function horizons(series, isRate) {
  const last = series.at(-1);
  const prev = series.at(-2);
  const startOfYear = series.filter((p) => p.d < `${last.d.slice(0, 4)}-01-01`).at(-1)
    ?? series.find((p) => p.d >= `${last.d.slice(0, 4)}-01-01`);

  const delta = (from) => {
    if (!from || from.c == null) return null;
    // Rates move in basis points; everything else in percent.
    return isRate ? Math.round((last.c - from.c) * 100) : ((last.c - from.c) / from.c) * 100;
  };

  return {
    d1: delta(prev),
    d5: delta(valueBefore(series, 7)),
    m1: delta(valueBefore(series, 30)),
    m3: delta(valueBefore(series, 91)),
    ytd: delta(startOfYear),
  };
}

/**
 * Is today's move unusual for this instrument? Compares it with the spread of
 * its own daily moves over the past ~90 observations, so "unusual" means
 * unusual for gold, not unusual in the abstract.
 */
function regime(series, isRate) {
  const window = series.slice(-91);
  if (window.length < 20) return { z: null, label: 'unknown' };

  const moves = [];
  for (let i = 1; i < window.length; i += 1) {
    const a = window[i - 1].c, b = window[i].c;
    if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) continue;
    moves.push(isRate ? (b - a) * 100 : ((b - a) / a) * 100);
  }
  if (moves.length < 15) return { z: null, label: 'unknown' };

  const today = moves.at(-1);
  const past = moves.slice(0, -1);
  const mean = past.reduce((s, m) => s + m, 0) / past.length;
  const sd = Math.sqrt(past.reduce((s, m) => s + (m - mean) ** 2, 0) / past.length);
  if (!sd) return { z: null, label: 'unknown' };

  const z = (today - mean) / sd;
  const a = Math.abs(z);
  const label = a >= 3 ? 'significant' : a >= 2 ? 'unusual' : a >= 1 ? 'elevated' : 'normal';
  return { z: Math.round(z * 10) / 10, label };
}

// ---- assembly -------------------------------------------------------------

async function loadOne(inst, ctx) {
  const isRate = inst.format === 'rate' || inst.format === 'spread';
  let series, currency = 'USD', asOf = null, source;

  switch (inst.provider) {
    case 'yahoo': {
      const y = await yahooSeries(inst.symbol);
      ({ series, currency, asOf, source } = y);
      break;
    }
    case 'treasury': {
      const curve = await treasuryCurve();
      series = curve[inst.symbol];
      if (!series?.length) throw new Error(`tenor ${inst.symbol} missing`);
      asOf = new Date(`${series.at(-1).d}T21:00:00Z`).getTime();
      source = { name: 'U.S. Department of the Treasury', type: 'Official par yield curve',
        freshness: 'daily official', isLive: false, isDelayed: false, isReference: true,
        url: 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates' };
      break;
    }
    case 'cboe': {
      series = await cboeVix();
      asOf = new Date(`${series.at(-1).d}T21:00:00Z`).getTime();
      source = { name: 'Cboe Global Markets', type: 'Official daily close',
        freshness: 'daily official', isLive: false, isDelayed: false, isReference: true,
        url: 'https://www.cboe.com/tradable_products/vix/' };
      break;
    }
    case 'lbma': {
      series = await lbmaSeries(inst.symbol);
      asOf = new Date(`${series.at(-1).d}T15:00:00Z`).getTime();
      source = { name: 'LBMA', type: `Benchmark price (${inst.symbol.replace('_', ' ')})`,
        freshness: 'daily benchmark', isLive: false, isDelayed: false, isReference: true,
        url: 'https://www.lbma.org.uk/prices-and-data/precious-metal-prices' };
      break;
    }
    case 'derived': {
      // 10y-2y: computed here from two official series, and labelled as computed.
      const two = ctx.byId.get('ust2y'), ten = ctx.byId.get('ust10y');
      if (!two?.series?.length || !ten?.series?.length) throw new Error('curve inputs unavailable');
      const twoBy = new Map(two.series.map((p) => [p.d, p.c]));
      series = ten.series.filter((p) => twoBy.has(p.d))
        .map((p) => ({ d: p.d, c: Math.round((p.c - twoBy.get(p.d)) * 100) / 100 }));
      asOf = two.asOf;
      source = { name: 'Computed from U.S. Treasury par yields', type: 'Derived series',
        freshness: 'daily official', isLive: false, isDelayed: false, isReference: true };
      break;
    }
    case 'fred':
      // Verified unreachable from this machine: TCP connect to the FRED host
      // times out. Reported as unavailable rather than substituted.
      throw new Error('FRED is unreachable from this network — no authoritative source for this series');
    default:
      throw new Error(`no provider "${inst.provider}"`);
  }

  if (!series?.length) throw new Error('empty series');
  const last = series.at(-1);

  return {
    ...inst,
    label: inst.name,                       // situations charts read `label`
    value: last.c,
    price: last.c,                          // kept for the situation view
    currency,
    asOf,
    observedOn: last.d,
    changes: horizons(series, isRate),
    changePct: horizons(series, isRate).d1,
    regime: regime(series, isRate),
    series,
    history: series.slice(-30).map((p) => p.c),
    source,
  };
}

export async function loadMarkets() {
  const ctx = { byId: new Map() };
  const out = [];

  // Everything except derived instruments, which need their inputs first.
  const direct = INSTRUMENTS.filter((i) => i.provider !== 'derived');
  const results = await Promise.all(direct.map(async (inst) => {
    try {
      const obs = await loadOne(inst, ctx);
      ctx.byId.set(inst.id, obs);
      return obs;
    } catch (err) {
      // An unavailable source is reported as unavailable, never filled in.
      return {
        ...inst, label: inst.name, value: null, price: null, series: [], history: [],
        changes: {}, changePct: null, regime: { z: null, label: 'unknown' },
        error: err.message,
        source: { name: inst.provider === 'fred' ? 'FRED (unreachable from this network)' : inst.provider,
          type: 'Unavailable', freshness: 'unavailable', isLive: false, isDelayed: false, isReference: false },
      };
    }
  }));
  out.push(...results);

  for (const inst of INSTRUMENTS.filter((i) => i.provider === 'derived')) {
    try {
      out.push(await loadOne(inst, ctx));
    } catch (err) {
      out.push({ ...inst, label: inst.name, value: null, price: null, series: [], history: [],
        changes: {}, changePct: null, regime: { z: null, label: 'unknown' }, error: err.message,
        source: { name: 'derived', type: 'Unavailable', freshness: 'unavailable' } });
    }
  }

  // preserve registry order
  const order = new Map(INSTRUMENTS.map((i, n) => [i.id, n]));
  return out.sort((a, b) => order.get(a.id) - order.get(b.id));
}
