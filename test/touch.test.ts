import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index.js';
import { touchRate } from '../src/analysis/stats.js';
import { ThesisSettler } from '../src/theses/measure.js';
import { type ThesisSpec, claimText, reached, touchLevel } from '../src/theses/spec.js';
import { type Analysis, ThesisStore } from '../src/theses/store.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 30, 12);
const analysis: Analysis = {
  assumptions: [],
  argument: { for: [], against: [], kill: 'x', history: 'x', lean: 'even', verdict: 'x' },
  facts: [],
  sources: [],
};

describe('which takes count on touch', () => {
  const drop: ThesisSpec = { kind: 'price', asset: 'BTC', direction: 'down', target: 60_000, horizonDays: 7 };
  it('price targets and % moves do, at their level', () => {
    expect(touchLevel(drop, 65_000)).toBe(60_000);
    expect(touchLevel({ kind: 'move', asset: 'NVDA', direction: 'up', pct: 0.1, horizonDays: 14 }, 200)).toBeCloseTo(220, 6);
    expect(reached(drop, 60_000, 59_900)).toBe(true);
    expect(reached(drop, 60_000, 60_100)).toBe(false);
    expect(claimText(drop)).toBe('BTC below 60,000 within a week');
  });

  it('a target already passed when logged, "beats" takes and plain direction takes are judged at the end', () => {
    expect(touchLevel({ ...drop, target: 70_000 }, 65_000)).toBeNull();
    expect(touchLevel({ kind: 'relative', asset: 'SOL', versus: 'ETH', direction: 'up', horizonDays: 30 }, 0.04)).toBeNull();
    expect(touchLevel({ kind: 'move', asset: 'ETH', direction: 'up', horizonDays: 7 }, 2400)).toBeNull();
  });

  it('counts the windows where the move was reached at any point, not only at the end', () => {
    // Up 10% on day 2, back to flat by day 5: reached within 5 days, but not at the end.
    const closes = Array.from({ length: 40 }, (_, i) => ({ date: `d${String(i).padStart(2, '0')}`, close: i % 5 === 2 ? 110 : 100 }));
    const r = touchRate(closes, 5, 0.1, true)!;
    expect(r.rate).toBeGreaterThan(0.5);
    expect(r.median).toBe(0);
  });
});

describe('settling on touch', () => {
  function setup(range: { high: number; low: number } | null, live: number) {
    const store = new ThesisStore(openDb(':memory:'));
    const log = (spec: ThesisSpec, start: number) => {
      const t = store.createDraft({ guildId: 'g', channelId: 'c', authorId: 'alice', take: 'x', claim: claimText(spec), spec, analysis, now: NOW - 3 * DAY });
      store.log(t.id, start, NOW - 3 * DAY);
      return t.id;
    };
    let now = NOW;
    const asked: [number, number][] = [];
    const measure = {
      now: async () => live,
      range: async (_s: ThesisSpec, from: number, to: number) => (asked.push([from, to]), range),
      atCheck: async () => live,
    };
    const settler = new ThesisSettler({ store, measure: measure as never, now: () => now });
    return { store, log, settler, asked, at: (ms: number) => (now = ms) };
  }
  const drop: ThesisSpec = { kind: 'price', asset: 'BTC', direction: 'down', target: 60_000, horizonDays: 7 };

  it('settles as aged well the moment the price touched the level, days before the check-back', async () => {
    const { store, log, settler, asked } = setup({ high: 66_000, low: 59_800 }, 63_000); // a dip to 59.8k, back to 63k now
    const id = log(drop, 65_000);
    const { settled } = await settler.tick();
    expect(settled.map((v) => [v.thesis.id, v.held, v.endValue])).toEqual([[id, true, 59_800]]);
    expect(store.get(id)).toMatchObject({ status: 'aged_well' });
    expect(asked[0]![0]).toBe(NOW - 3 * DAY); // looked from when it was logged
  });

  it('keeps watching from where it left off, and ages badly if it never gets there', async () => {
    const { store, log, settler, asked, at } = setup({ high: 66_000, low: 61_000 }, 62_000);
    const id = log(drop, 65_000);
    expect((await settler.tick()).settled).toEqual([]);
    expect(store.get(id)).toMatchObject({ status: 'open', extreme: 61_000, watchedAt: NOW });
    at(NOW + 11 * 60_000);
    await settler.tick();
    expect(asked[1]![0]).toBe(NOW); // the second look starts where the first ended
    at(NOW + 5 * DAY); // past the check-back, still never touched
    const { settled } = await settler.tick();
    expect(settled.map((v) => v.held)).toEqual([false]);
    expect(store.get(id)).toMatchObject({ status: 'aged_badly' });
  });

  it('judges a take already past its level when logged at the check-back, as before', async () => {
    const { store, log, settler, at } = setup({ high: 66_000, low: 50_000 }, 64_000);
    const id = log({ ...drop, target: 70_000 }, 65_000); // "below 70k" while already at 65k: still below on the date?
    expect((await settler.tick()).settled).toEqual([]);
    at(NOW + 5 * DAY);
    expect((await settler.tick()).settled.map((v) => v.held)).toEqual([true]);
    expect(store.get(id)).toMatchObject({ status: 'aged_well', endValue: 64_000 });
  });
});
