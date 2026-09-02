// The one article surfaced on the Pulse page.
//
// Two ways it can be chosen, and the UI says which, because "article of the
// day" is an editorial claim and the reader should know whose it is:
//
//   pinned    set by hand in data/feature.json. Wins whenever present.
//   carried   otherwise, the story the most outlets ran today. That is a
//             measurement — how widely a story is carried — not a judgement
//             about how important it is, and it is labelled as exactly that.
//
// A cluster of one outlet is not "most carried", it is just the newest thing,
// so the automatic pick needs corroboration before it will claim the slot.
const MIN_OUTLETS = 2;

export function chooseFeature(pinned, wire) {
  if (pinned?.title && pinned?.link) {
    const time = pinned.date ? Date.parse(`${pinned.date}T00:00:00Z`) : null;
    return {
      ...pinned,
      time: Number.isFinite(time) ? time : null,
      basis: 'pinned',
      why: 'Picked by hand.',
    };
  }

  const best = [...(wire ?? [])]
    .filter((w) => (w.outlets?.length ?? 0) >= MIN_OUTLETS)
    .sort((a, b) => (b.outlets.length - a.outlets.length) || ((b.time ?? 0) - (a.time ?? 0)))[0];

  if (!best) return null;

  const outlets = best.outlets.map((o) => o.outlet);
  return {
    title: best.title,
    link: best.outlets[0].link,
    outlet: outlets.join(' · '),
    summary: best.summary ?? '',
    time: best.time ?? null,
    basis: 'carried',
    why: `Carried by ${outlets.length} of the outlets on the wire.`,
  };
}
