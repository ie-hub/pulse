// The daily verse.
//
// Chosen by calendar day rather than at random, so it is the same all day and
// turns over at local midnight. Text comes from bible-api.com (free, no key);
// if that is unreachable the bundled fallback is used, and the payload says
// which happened rather than hiding it.

import fs from 'node:fs/promises';
import { get } from './feeds.mjs';

let cache = null;   // { day, verse }

/** Local calendar day as a stable integer, so the pick rolls over at midnight here. */
function dayIndex(now = new Date()) {
  const local = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.floor(local.getTime() / 86400000 - local.getTimezoneOffset() / 1440);
}

const tidy = (s) => s.replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();

export async function dailyScripture(file) {
  const day = dayIndex();
  if (cache?.day === day) return cache.verse;

  let config;
  try {
    config = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    return { reference: null, text: null, error: `scripture.json: ${err.message}` };
  }

  const refs = config.references ?? [];
  const fallbacks = config.fallback ?? [];
  const reference = refs.length ? refs[((day % refs.length) + refs.length) % refs.length] : null;

  let verse;
  if (reference) {
    try {
      const url = `https://bible-api.com/${encodeURIComponent(reference)}`
                + `?translation=${encodeURIComponent(config.translation ?? 'kjv')}`;
      const data = await get(url, { json: true, retries: 1, timeout: 8000 });
      if (!data?.text) throw new Error('no text returned');
      verse = {
        reference: data.reference ?? reference,
        text: tidy(data.text),
        translation: (data.translation_id ?? config.translation ?? 'kjv').toUpperCase(),
        source: 'bible-api.com',
      };
    } catch (err) {
      const pick = fallbacks.length ? fallbacks[((day % fallbacks.length) + fallbacks.length) % fallbacks.length] : null;
      verse = pick
        ? { ...pick, translation: 'KJV', source: 'bundled', note: `Live lookup failed (${err.message})` }
        : { reference: null, text: null, error: err.message };
    }
  } else {
    verse = { reference: null, text: null, error: 'no references configured' };
  }

  cache = { day, verse };
  return verse;
}
