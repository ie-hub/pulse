// Ground News has no public feed, so its useful behaviour is approximated here:
// group the same story across outlets so a headline appears once, carrying the
// list of outlets that ran it. This is coverage breadth only — it is NOT the
// bias/factuality rating Ground News does, and shouldn't be read as one.

const STOP = new Set(`
about after again against among around because before being between both could
does doing during each from have having here into just like more most only
other over said same since some such than that their them then there these
they this those through under until very what when where which while will
with would your after also amid says say new news world report reports
`.trim().split(/\s+/));

function tokens(title) {
  return new Set(
    title.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOP.has(w))
  );
}

function similarity(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  return shared / (a.size + b.size - shared);
}

// Tuned against live feeds: 0.30 caught every genuine cross-outlet story with
// no false merges; higher values silently dropped real ones.
const THRESHOLD = 0.30;

// Daily-briefing headlines ("First Thing: …") match a story's tokens but make
// terrible representatives for it, so they are never chosen to lead a cluster.
const ROUNDUP = /^(first thing|morning mail|the briefing|briefing|today in|this week in|week in review|the guardian view|newsletter)\b/i;

// Live-blog headlines are real coverage but read as fragments out of context
// ("… – as it happened"), so a plain headline wins the slot when one exists.
const LIVEBLOG = /(as it happened|live updates?|–\s*live\b|latest updates)/i;

function leadOf(members) {
  const penalty = (m) =>
    (ROUNDUP.test(m.title) ? 1000 : 0) + (LIVEBLOG.test(m.title) ? 500 : 0) + m.title.length;
  return [...members].sort((a, b) => penalty(a) - penalty(b))[0];
}

export function clusterStories(items) {
  const sorted = [...items].sort((a, b) => (b.time ?? 0) - (a.time ?? 0));
  const clusters = [];

  for (const item of sorted) {
    const tok = tokens(item.title);
    let best = null;
    let bestScore = THRESHOLD;

    for (const c of clusters) {
      // Compare against every member, not just the lead: outlets word the same
      // story differently, and one close match is enough to belong.
      for (const member of c.members) {
        const score = similarity(tok, member.tokens);
        if (score > bestScore) { bestScore = score; best = c; }
      }
    }

    if (best) {
      best.members.push({ ...item, tokens: tok });
    } else {
      clusters.push({ members: [{ ...item, tokens: tok }] });
    }
  }

  return clusters.map((c) => {
    const lead = leadOf(c.members);
    const newest = Math.max(...c.members.map((m) => m.time ?? 0)) || null;
    const outlets = [];
    for (const m of c.members) {
      if (!outlets.some((o) => o.outlet === m.outlet)) {
        outlets.push({ outlet: m.outlet, link: m.link, time: m.time });
      }
    }
    return {
      title: lead.title,
      summary: lead.summary,
      link: lead.link,
      time: newest,
      outlets,
      searchTerms: [...tokens(lead.title)].slice(0, 6).join(' '),
    };
  }).sort((a, b) => {
    // Multi-outlet stories first — breadth of coverage is the signal — then recency.
    if (b.outlets.length !== a.outlets.length) return b.outlets.length - a.outlets.length;
    return (b.time ?? 0) - (a.time ?? 0);
  });
}
