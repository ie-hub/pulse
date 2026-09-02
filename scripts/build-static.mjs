// Builds the static snapshot GitHub Pages serves.
//
// Pages cannot run Node, so there is no /api/state to call. This runs the same
// buildState() the local server uses, once, and writes the result next to the
// front-end as state.json. The site is therefore a SNAPSHOT, not a live view —
// as old as the workflow run that produced it.
//
// That distinction is the whole reason `snapshot: true` is stamped into the
// payload: the front end reads it and labels the header accordingly, so the
// hosted copy never claims to be something it is not.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildState } from '../server.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, 'dist');

const state = await buildState();

// Stamp provenance for the hosted copy. buildState() already sets generatedAt;
// these say where that number came from and what produced it.
state.snapshot = true;
state.builtBy = process.env.GITHUB_ACTIONS ? 'github-actions' : 'local';
state.buildRef = process.env.GITHUB_SHA ?? null;

await fs.rm(OUT, { recursive: true, force: true });
await fs.cp(path.join(ROOT, 'public'), OUT, { recursive: true });
await fs.writeFile(path.join(OUT, 'state.json'), JSON.stringify(state));

const ok = state.status.filter((s) => s.ok).length;
const bytes = (await fs.stat(path.join(OUT, 'state.json'))).size;
console.log(`dist/ built — ${ok}/${state.status.length} sources ok, state.json ${(bytes / 1024).toFixed(0)}kb`);

// A snapshot with no working sources is not worth publishing over a good one.
if (ok === 0) {
  console.error('every source failed — refusing to publish an empty snapshot');
  process.exit(1);
}
