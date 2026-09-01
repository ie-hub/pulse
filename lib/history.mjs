// A rolling record of domain activity, so "what changed" is measured rather
// than asserted. Feeds only reach back about a day; without this file the
// interface could not honestly draw a single trend arrow.
//
// One sample per domain per hour, 30 days kept. Written next to the data.

import fs from 'node:fs/promises';
import path from 'node:path';

const HOUR = 3600000;
const KEEP = 30 * 24 * HOUR;

export async function readHistory(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Append a sample per domain, at most one an hour, and prune old ones.
 * Returns the updated history so callers can compute trends from it.
 */
export async function recordHistory(file, domains) {
  const history = await readHistory(file);
  const now = Date.now();
  let changed = false;

  for (const d of domains) {
    const series = history[d.id] ?? (history[d.id] = []);
    const last = series.at(-1);
    if (!last || now - last.t >= HOUR) {
      series.push({ t: now, value: d.value });
      changed = true;
    } else {
      last.value = d.value;   // keep the current hour's sample fresh
    }
    const cutoff = now - KEEP;
    while (series.length && series[0].t < cutoff) series.shift();
  }

  if (changed) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(history));
  }
  return history;
}
