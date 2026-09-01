# Pulse

A personal intelligence dashboard: what is happening in the world, what changed,
and where attention is warranted.

Local only. No accounts, no API keys, no remote — this repo has no `origin` and
is unrelated to any work project.

## Run it

```
npm start
```

Then open <http://localhost:4173>. No `npm install` — there are no dependencies.

## The three levels

**Pulse** (`#/`) — Attention (subjects ranked by activity), What changed (one
ranked stream across every domain), and a four-way world overview.

**Domain** (`#/world`, `#/markets`, `#/government`, `#/climate`, `#/wire`) — a
structured view of one domain. Conflicts are a dense sortable matrix, not cards,
so 16 subjects can be compared at a glance.

**Entity** (`#/situation/<id>`, `#/world/<slug>`) — the narrative view: headline,
figures, latest development, event-annotated price chart, full timeline.

## How activity is measured

    Activity = recency × significance × change

Two signals feed it, deliberately kept apart because they are not equally
trustworthy:

1. **Curated timeline events** — hand-written and sourced, with enough history
   that a 7-day window can be compared to the one before it. Change here is
   measured, so these subjects carry real trend arrows.
2. **Live wire mentions** — matched on headline keywords. Feeds only reach back
   about 24 hours, so this measures *volume today* and cannot produce a trend on
   its own.

Anything not measurable is shown as `·` (unknown), never filled in with a guess.
Domain-level trends come from [`data/pulse-history.json`](data), which the server
appends to hourly — they read as unknown until a couple of samples exist.

## Market data and provenance

Instruments do not all come from one place. Each declares its own provider in
[`lib/markets.mjs`](lib/markets.mjs), and every number carries what it is, when
it was measured and where it came from:

| Source | Instruments | Nature |
| --- | --- | --- |
| U.S. Treasury | 2y / 10y / 30y par yields | Official, daily |
| Cboe | VIX | Official daily close |
| LBMA | Gold, silver | Benchmark, daily |
| Yahoo Finance | Energy, FX, equities, copper, BTC, wheat | Exchange-derived, **delayed** |
| FRED | Fed funds, credit spreads | **Unreachable from this machine** |

Nothing is labelled live, because nothing here is. Fed funds shows as
*unavailable* rather than being substituted from another source — the FRED host
times out from this network.

Each instrument carries changes over 1D / 5D / 1M / 3M / YTD, and a **regime**
label (normal / elevated / unusual / significant) computed as a z-score of
today's move against that instrument's own 90-day distribution — so "unusual"
means unusual for gold, not unusual in the abstract.

`whatMatters` and `signals` in [`lib/macro.mjs`](lib/macro.mjs) are the
dashboard's own reading of those numbers, labelled as such in the UI. They are
interpretation, not advice, and each states the evidence it was drawn from.

## Tracked vs. watched

**Tracked** subjects (`situations` in `data/situations.json`) have a curated
timeline, a linked market, and measured trends.

**Watched** subjects (`watchlist`) have only keywords. Their level reflects
today's reporting volume and nothing is asserted about them. Promote one by
writing it a timeline.

## Adding things

- **A source**: an entry in [`lib/sources.mjs`](lib/sources.mjs) — `id`, `lane`
  (`wire` / `official` / `hazard`), `outlet`, `kind: 'rss'`.
- **A market**: an entry in [`lib/markets.mjs`](lib/markets.mjs) naming its
  provider. Currency and cent-quoted contracts (`USX`) are normalised on load.
- **A conflict**: an entry in [`data/situations.json`](data/situations.json).
  It is re-read on every request, so a save shows up on reload.

## Known limits

- Ground News has no public feed. Outlet counts are computed locally and measure
  how widely a story is carried — not bias or factuality.
- Reuters and AP ended public RSS; State Dept and Treasury publish none.
- GDELT and the ACLED API were unreachable when this was built, so conflict
  event data is curated by hand rather than machine-fed.
- The climate view is near-term hazard (NWS alerts, USGS quakes). No temperature
  or emissions series is wired in.
