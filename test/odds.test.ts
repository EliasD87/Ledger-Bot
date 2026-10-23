import { describe, expect, it } from 'vitest';
import { RULES, type Scenario, dailyVolatility, fatTailCdf, quote, recordTerms, winChance } from '../src/calls/odds.js';
import { callCard, draftCard, settlementText } from '../src/discord/callCards.js';
import type { Call } from '../src/calls/store.js';

const base: Scenario = { spot: 100, target: 110, direction: 'above', kind: 'touch', dailyVol: 0.03, days: 7 };

describe('fatTailCdf', () => {
  it('is a symmetric CDF centred on zero', () => {
    expect(fatTailCdf(0)).toBeCloseTo(0.5, 10);
    expect(fatTailCdf(1.3) + fatTailCdf(-1.3)).toBeCloseTo(1, 10);
    expect(fatTailCdf(50)).toBeCloseTo(1, 4);
    expect(fatTailCdf(1)).toBeGreaterThan(fatTailCdf(0.5));
  });

  it('has fatter tails than a normal distribution', () => {
    // Normal: P(Z < -4) ≈ 3.2e-5.
    expect(fatTailCdf(-4)).toBeGreaterThan(1e-3);
  });
});

describe('winChance', () => {
  it('is certain for a touch call whose target is already reached', () => {
    expect(winChance({ ...base, target: 95 })).toBe(1);
    expect(winChance({ ...base, direction: 'below', target: 105 })).toBe(1);
  });

  it('is symmetric for equal log distances above and below', () => {
    const up = winChance({ ...base, target: 100 * Math.exp(0.08) });
    const down = winChance({ ...base, direction: 'below', target: 100 * Math.exp(-0.08) });
    expect(up).toBeCloseTo(down, 12);
  });

  it('rises with time and volatility, falls with distance', () => {
    const p = winChance(base);
    expect(winChance({ ...base, days: 30 })).toBeGreaterThan(p);
    expect(winChance({ ...base, dailyVol: 0.06 })).toBeGreaterThan(p);
    expect(winChance({ ...base, target: 130 })).toBeLessThan(p);
  });

  it('prices a touch above a close at the same target', () => {
    expect(winChance(base)).toBeGreaterThan(winChance({ ...base, kind: 'close' }));
  });

  it('gives a close call at spot a coin flip, and above + below sum to one', () => {
    expect(winChance({ ...base, kind: 'close', target: 100 })).toBeCloseTo(0.5, 10);
    const above = winChance({ ...base, kind: 'close' });
    const below = winChance({ ...base, kind: 'close', direction: 'below' });
    expect(above + below).toBeCloseTo(1, 10);
  });
});

describe('recordTerms', () => {
  it('scores result minus rating', () => {
    expect(recordTerms(0.5)).toEqual({ payout: 50, stake: 50 });
    expect(recordTerms(0.2)).toEqual({ payout: 80, stake: 20 });
  });

  it('averages zero for a caller who is exactly as good as the rating', () => {
    for (const r of [0.1, 0.25, 0.6, 0.9]) {
      const { payout, stake } = recordTerms(r);
      expect(r * payout - (1 - r) * stake).toBeCloseTo(0, 0);
    }
  });
});

describe('quote', () => {
  it('quotes a reasonable call', () => {
    const q = quote(base);
    expect(q.ok).toBe(true);
    if (q.ok) {
      expect(q.chance).toBeGreaterThan(0);
      expect(q.chance).toBeLessThan(RULES.maxWinChance);
      expect(q.payout).toBe(recordTerms(q.chance).payout);
      expect(q.stake).toBe(recordTerms(q.chance).stake);
    }
  });

  it('prices a fade as the other side of the same call', () => {
    const back = quote(base, 'back');
    const fade = quote(base, 'fade');
    expect(back.ok && fade.ok).toBe(true);
    if (back.ok && fade.ok) expect(back.chance + fade.chance).toBeCloseTo(1, 10);
  });

  it('refuses long shots and near-certainties, and both sides once the target is reached', () => {
    expect(quote({ ...base, target: 300 }, 'back')).toMatchObject({ ok: false, reason: 'too-far' });
    expect(quote({ ...base, target: 300 }, 'fade')).toMatchObject({ ok: false, reason: 'too-easy' });
    expect(quote({ ...base, target: 90 }, 'fade')).toMatchObject({ ok: false, reason: 'already-there' });
  });

  it('refuses calls that are already true, too easy, or outside the window', () => {
    expect(quote({ ...base, target: 90 })).toMatchObject({ ok: false, reason: 'already-there' });
    expect(quote({ ...base, target: 100.1 })).toMatchObject({ ok: false, reason: 'too-easy' });
    expect(quote({ ...base, days: 0.01 })).toMatchObject({ ok: false, reason: 'bad-window' });
    expect(quote({ ...base, days: 91 })).toMatchObject({ ok: false, reason: 'bad-window' });
    expect(quote({ ...base, target: 0 })).toMatchObject({ ok: false, reason: 'bad-price' });
  });
});

describe('dailyVolatility', () => {
  it('measures the spread of daily log returns', () => {
    const closes = [100, 110, 100, 110, 100, 110, 100, 110, 100];
    expect(dailyVolatility(closes)).toBeCloseTo(0.1019, 3);
  });

  it('floors a flat price and needs enough history', () => {
    expect(dailyVolatility(Array(10).fill(1))).toBe(0.002);
    expect(() => dailyVolatility([1, 2, 3])).toThrow();
  });
});

describe('wording', () => {
  // Ledger is a scoreboard, not a betting bot: nothing members see may read like a betting slip.
  const BETTING = /\bodds\b|\bpays?\b|payout|stake|\bbet\b|wager|gambl|\bback(ing)?\b|\bfad(e|ing)\b|×/i;
  const call: Call = {
    id: 1, guildId: 'g', channelId: 'c', messageId: 'm', callerId: 'u', symbol: 'BTCUSDT', base: 'BTC',
    direction: 'below', kind: 'touch', target: 81_000, deadline: Date.UTC(2026, 9, 23, 16), status: 'open',
    createdAt: 0, entryPrice: 81_874, chance: 0.068, payout: 1379, lockedAt: 0, checkedUntil: 0,
    settledAt: null, settlePrice: null, settleTime: null, note: null,
  };
  const position = { id: 1, callId: 1, userId: 'u', side: 'back' as const, stake: 100, chance: 0.068, payout: 1379, createdAt: 0, result: 'won' as const, pnl: 1379, settledAt: 1 };

  it('keeps betting words off call cards and result posts', () => {
    const texts = [
      JSON.stringify(draftCard({ ...call, status: 'draft' })),
      JSON.stringify(callCard(call, [position])),
      JSON.stringify(callCard({ ...call, status: 'won', settlePrice: 80_990, settleTime: 1 }, [position])),
      settlementText({ call: { ...call, status: 'won' }, positions: [position], won: true, price: 80_990, at: 1 }),
    ];
    // Button IDs keep their internal names (ledger:back:1); only check what members read.
    for (const text of texts) expect(text.replace(/ledger:\w+:\d+/g, '')).not.toMatch(BETTING);
  });
});
