// Interpretation of the market data — explicitly the dashboard's reading, not
// anyone's official indicator and not advice.
//
// Every observation and signal below is derived from numbers already fetched,
// and each carries the evidence it was drawn from so the reasoning is checkable
// rather than asserted.

const val = (markets, id) => markets.find((m) => m.id === id);
const ch = (m, horizon = 'd1') => m?.changes?.[horizon] ?? null;
const has = (m) => m && m.value != null;

const pct = (n, d = 1) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(d)}%`;
const bp = (n) => `${n >= 0 ? '+' : '−'}${Math.abs(Math.round(n))} bp`;

/**
 * Two to four observations about today, ordered by how unusual they are.
 * Only relationships actually present in the data are described.
 */
export function whatMatters(markets) {
  const m = (id) => val(markets, id);
  const notes = [];

  const brent = m('brent'), wti = m('crude'), gold = m('gold'), dxy = m('dxy');
  const ten = m('ust10y'), two = m('ust2y'), curve = m('curve');
  const sp = m('sp500'), vix = m('vix'), copper = m('copper');

  // 1. the most unusual move of the day, whatever it is
  const ranked = markets
    .filter((x) => has(x) && Number.isFinite(x.regime?.z) && x.regime.label !== 'normal')
    .sort((a, b) => Math.abs(b.regime.z) - Math.abs(a.regime.z));
  if (ranked.length) {
    const top = ranked[0];
    const move = top.format === 'rate' || top.format === 'spread' ? bp(ch(top)) : pct(ch(top));
    notes.push({
      text: `${top.name} moved ${move} today — ${top.regime.label} against its own 90-day range.`,
      evidence: `z-score ${top.regime.z}`,
    });
  }

  // 2. energy, where it is moving together
  if (has(brent) && has(wti) && ch(brent) != null && ch(wti) != null) {
    const both = (ch(brent) + ch(wti)) / 2;
    if (Math.abs(both) >= 1) {
      notes.push({
        text: `Crude is ${both > 0 ? 'rising' : 'falling'} on both benchmarks — Brent ${pct(ch(brent))}, WTI ${pct(ch(wti))}`
          + `${ch(brent, 'm1') != null ? `, ${pct(ch(brent, 'm1'))} over the past month` : ''}.`,
        evidence: 'Brent and WTI 1D and 1M',
      });
    }
  }

  // 3. gold against the dollar — the classic pairing, only when it actually holds
  if (has(gold) && has(dxy) && ch(gold) != null && ch(dxy) != null && Math.abs(ch(gold)) >= 0.4) {
    const together = Math.sign(ch(gold)) === Math.sign(ch(dxy));
    notes.push({
      text: together
        ? `Gold ${pct(ch(gold))} and the dollar ${pct(ch(dxy))} are moving the same way, which is the less usual pairing.`
        : `Gold ${pct(ch(gold))} as the dollar ${pct(ch(dxy))} — the familiar inverse.`,
      evidence: 'Gold benchmark vs dollar index, 1D',
    });
  }

  // 4. rates and the curve
  if (has(ten) && ch(ten) != null && Math.abs(ch(ten)) >= 3) {
    const shape = has(curve) && ch(curve) != null
      ? ` The 10y–2y spread ${ch(curve) > 0 ? 'steepened' : 'flattened'} ${bp(Math.abs(ch(curve)))}.` : '';
    notes.push({
      text: `The 10-year yield ${ch(ten) > 0 ? 'rose' : 'fell'} ${bp(Math.abs(ch(ten)))} to ${ten.value.toFixed(2)}%.${shape}`,
      evidence: 'U.S. Treasury par yields, official daily',
    });
  }

  // 5. risk tone, when equities and volatility disagree with each other
  if (has(sp) && has(vix) && ch(sp) != null && ch(vix) != null) {
    const contradiction = Math.sign(ch(sp)) === Math.sign(ch(vix)) && Math.abs(ch(vix)) > 3;
    if (contradiction) {
      notes.push({
        text: `Equities ${pct(ch(sp))} and the VIX ${pct(ch(vix))} are moving together, which usually means one of them is about to give way.`,
        evidence: 'S&P 500 vs Cboe VIX, 1D',
      });
    }
  }

  // 6. industrial demand read
  if (!notes.length && has(copper) && ch(copper, 'm1') != null) {
    notes.push({
      text: `Copper is ${pct(ch(copper, 'm1'))} over the past month, a read on industrial demand.`,
      evidence: 'Copper 1M',
    });
  }

  return notes.slice(0, 4);
}

/**
 * Compact directional signals. Each states the instruments it was computed
 * from — these are the dashboard's reading, not published indices.
 */
export function marketSignals(markets) {
  const m = (id) => val(markets, id);
  const dir = (n, dead = 0.25) => (n == null ? 'unknown' : n > dead ? 'up' : n < -dead ? 'down' : 'flat');

  const brent = m('brent'), gold = m('gold'), copper = m('copper');
  const dxy = m('dxy'), two = m('ust2y'), vix = m('vix');
  const sp = m('sp500'), russell = m('russell');

  const signals = [];

  // inflation pressure: energy and industrial metals over a month
  const infl = [ch(brent, 'm1'), ch(copper, 'm1'), ch(gold, 'm1')].filter((n) => n != null);
  if (infl.length) {
    const avg = infl.reduce((s, n) => s + n, 0) / infl.length;
    signals.push({ label: 'Inflation pressure', trend: dir(avg, 1), value: pct(avg),
      basis: 'Brent, copper and gold over one month' });
  }

  // risk appetite: small caps and the broad index against volatility
  const risk = [ch(sp, 'd5'), ch(russell, 'd5')].filter((n) => n != null);
  const volFive = ch(vix, 'd5');
  if (risk.length) {
    const avg = risk.reduce((s, n) => s + n, 0) / risk.length;
    const score = avg - (volFive ?? 0) / 4;
    signals.push({ label: 'Risk appetite', trend: dir(score, 0.5), value: pct(avg),
      basis: 'S&P 500 and Russell 2000 over five days, against the VIX' });
  }

  if (has(dxy)) {
    signals.push({ label: 'Dollar strength', trend: dir(ch(dxy, 'd5'), 0.3), value: pct(ch(dxy, 'd5') ?? 0),
      basis: 'Dollar index over five days' });
  }

  if (has(two) && ch(two, 'm1') != null) {
    signals.push({ label: 'Rate expectations', trend: dir(ch(two, 'm1'), 5), value: bp(ch(two, 'm1')),
      basis: '2-year Treasury yield over one month — the market’s read on policy' });
  }

  if (has(vix) && volFive != null) {
    signals.push({ label: 'Volatility', trend: dir(volFive, 2), value: pct(volFive),
      basis: 'Cboe VIX over five days' });
  }

  return signals;
}
