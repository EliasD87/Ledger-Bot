import { describe, expect, it } from 'vitest';
import type { Evidence } from '../src/analysis/evidence.js';
import { EvidenceBuilder } from '../src/analysis/evidence.js';
import { openDb } from '../src/db/index.js';
import { momentPost, parseThesisButtonId, thesisButtonId, verdictPost } from '../src/discord/thesisCards.js';
import type { ChatModel } from '../src/llm/deepseek.js';
import { Spend } from '../src/llm/guards.js';
import { MomentWatcher } from '../src/theses/moments.js';
import { redraftTake, sharpenTake } from '../src/theses/service.js';
import { type ThesisSpec, claimText } from '../src/theses/spec.js';
import { type Analysis, ThesisStore } from '../src/theses/store.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 27, 12);
const usage = { cacheHitTokens: 0, cacheMissTokens: 10, outputTokens: 5, costUsd: 0.001 };
const spec: ThesisSpec = { kind: 'price', asset: 'BTC', direction: 'up', target: 90_000, horizonDays: 14, assetKind: 'crypto' };
const argument = {
  for: [{ point: 'Above its long-term average.', facts: ['F1'] }],
  against: [{ point: 'Rarely moves this far.', facts: ['F2'] }],
  kill: 'k',
  history: 'h',
  lean: 'against' as const,
  verdict: 'v',
};
const analysis = (baseRate: number | null = 0.3): Analysis => ({ assumptions: ["'2 weeks' = 14 days"], argument, facts: [{ id: 'F1', text: 'BTC is at 80,000.' }], sources: ['Binance'], baseRate });

/** A year of daily BTC closes drifting up 0.1% a day with a 1% wiggle. */
function closes(days = 400, from = 60_000) {
  return Array.from({ length: days }, (_, i) => ({
    date: new Date(NOW - (days - 1 - i) * DAY).toISOString().slice(0, 10),
    close: from * (1 + 0.001 * i) * (1 + (i % 2 ? 0.01 : -0.01)),
  }));
}
const fakeHistory = (c = closes()) =>
  ({
    identify: async (s: string) => ({ symbol: s.toUpperCase(), kind: 'crypto', pair: `${s.toUpperCase()}USDT` }),
    daily: async (a: { symbol: string; kind: 'crypto' }) => ({ asset: a, closes: c, source: 'Binance' }),
  }) as never;

function setup() {
  const db = openDb(':memory:');
  const store = new ThesisStore(db);
  const make = (authorId: string, s: ThesisSpec = spec, base: number | null = 0.3) =>
    store.createDraft({ guildId: 'g', channelId: 'c', authorId, take: 'btc 90k in 2 weeks', claim: claimText(s), spec: s, analysis: analysis(base), now: NOW });
  return { db, store, make };
}

describe('duels', () => {
  it('lets one member who is against take a logged take on, never the author', () => {
    const { store, make } = setup();
    const t = make('alice');
    expect(store.challenge(t.id, 'bob', NOW)).toBe('closed'); // still a draft
    store.log(t.id, 80_000, NOW);
    expect(store.challenge(t.id, 'alice', NOW)).toBe('own');
    expect(store.challenge(t.id, 'bob', NOW)).toBe('ok');
    expect(store.challenge(t.id, 'bob', NOW)).toBe('already');
    expect(store.challenge(t.id, 'cy', NOW)).toBe('taken');
    expect(store.get(t.id)!.challengerId).toBe('bob');
    expect(store.sides(t.id).against).toEqual(['bob']); // a challenger is against it
  });

  it('settles duels on both records, with the head to head', () => {
    const { store, make } = setup();
    for (const ok of [true, false, true]) {
      const t = make('alice');
      store.log(t.id, 80_000, NOW);
      store.challenge(t.id, 'bob', NOW);
      store.settle(t.id, ok ? 91_000 : 85_000, ok, NOW + DAY);
    }
    expect(store.record('g', 'alice').duels).toEqual({ won: 2, lost: 1, against: [{ userId: 'bob', won: 2, lost: 1 }] });
    expect(store.record('g', 'bob').duels).toEqual({ won: 1, lost: 2, against: [{ userId: 'alice', won: 1, lost: 2 }] });
  });

  it('names the duel winner on the check-back without notifying anyone', () => {
    const { store, make } = setup();
    const t = make('alice');
    store.log(t.id, 80_000, NOW);
    store.challenge(t.id, 'bob', NOW);
    store.settle(t.id, 85_000, false, NOW + DAY);
    const post = verdictPost({ thesis: store.get(t.id)!, endValue: 85_000, held: false }, store.sides(t.id));
    expect(JSON.stringify(post.components)).toContain('Duel: <@bob> wins against <@alice>');
    expect(post.allowedMentions.users).toEqual([]);
  });
});

describe('richer records', () => {
  it('counts bold takes, the best asset and recent form', () => {
    const { store, make } = setup();
    const eth: ThesisSpec = { ...spec, asset: 'ETH', target: 3000 };
    const runs: [ThesisSpec, number, boolean][] = [
      [spec, 0.1, true], // bold, aged well
      [spec, 0.15, false], // bold, aged badly
      [spec, 0.5, true],
      [eth, 0.4, false],
      [eth, 0.4, false],
    ];
    runs.forEach(([s, base, ok], i) => {
      const t = make('alice', s, base);
      store.log(t.id, 80_000, NOW);
      store.settle(t.id, ok ? s.target! * 1.05 : s.target! * 0.9, ok, NOW + i * DAY);
    });
    const r = store.record('g', 'alice');
    expect(r.bold).toEqual({ right: 1, total: 2 });
    expect(r.bestAsset).toEqual({ asset: 'BTC', right: 2, total: 3 });
    expect(r.form.map((f) => f.ok)).toEqual([true, false, true, false, false]);
    expect(r.form[0]!.margin).toBeCloseTo(0.05);
    expect(r.form[1]!.margin).toBeCloseTo(-0.1);
  });
});

describe('mid-take moments', () => {
  it('posts target reached, then given back, once each', async () => {
    const { store, make } = setup();
    const t = make('alice');
    store.log(t.id, 80_000, NOW - 3 * DAY);
    let price = 91_000;
    let now = NOW;
    const watcher = new MomentWatcher({ store, measure: { now: async () => price }, history: fakeHistory(), now: () => now });
    expect((await watcher.tick()).map((m) => m.kind)).toEqual(['reached']);
    now += 11 * 60_000;
    expect(await watcher.tick()).toEqual([]); // still above: nothing new
    price = 88_000;
    now += 11 * 60_000;
    expect((await watcher.tick()).map((m) => m.kind)).toEqual(['slipped']);
    now += 11 * 60_000;
    expect(await watcher.tick()).toEqual([]);
  });

  it('flags a move against the take past its usual range for the whole window', async () => {
    const { store, make } = setup();
    const t = make('alice');
    store.log(t.id, 80_000, NOW - 3 * DAY);
    const watcher = new MomentWatcher({ store, measure: { now: async () => 60_000 }, history: fakeHistory(), now: () => NOW });
    const [m] = await watcher.tick();
    expect(m?.kind).toBe('pressure');
    const text = JSON.stringify(momentPost(store.get(t.id)!, 'pressure', 60_000, NOW).components);
    expect(text).toContain('Under pressure');
    expect(text).toContain('since logged −25.0%');
  });

  it('checks at most every 10 minutes and skips flow takes', async () => {
    const { store, make } = setup();
    const t = make('alice', { kind: 'flows', asset: 'BTC', direction: 'up', horizonDays: 7 });
    store.log(t.id, 0, NOW);
    let calls = 0;
    const watcher = new MomentWatcher({ store, measure: { now: async () => (calls++, 1e9) }, history: fakeHistory(), now: () => NOW });
    await watcher.tick();
    expect(calls).toBe(0);
  });
});

describe('timeframes and sharper takes', () => {
  it('carries a timeframe in the button id', () => {
    expect(parseThesisButtonId(thesisButtonId('retime', 12, 30))).toEqual({ action: 'retime', id: 12, arg: 30 });
    expect(parseThesisButtonId(thesisButtonId('duel', 12))).toEqual({ action: 'duel', id: 12 });
  });

  it('gives the same claim a base rate over each timeframe, longer windows more room', async () => {
    const evidence = new EvidenceBuilder({ history: fakeHistory(), desk: null });
    const rows = await evidence.timeframes({ ...spec, target: undefined, kind: 'move', pct: 0.03 }, [7, 30, 90, 14]);
    if ('error' in rows) throw new Error(rows.error);
    expect(rows.map((r) => r.days)).toEqual([7, 14, 30, 90]);
    expect(rows.at(-1)!.rate).toBeGreaterThan(rows[0]!.rate);
    expect(await evidence.timeframes({ kind: 'flows', asset: 'BTC', direction: 'up', horizonDays: 7 }, [7])).toHaveProperty('error');
  });

  const evidenceStub = (ev: Partial<Evidence> = {}) =>
    ({
      timeframes: async () => [
        { days: 7, rate: 0.05, windows: 900, median: 0.001 },
        { days: 30, rate: 0.3, windows: 900, median: 0.01 },
      ],
      forThesis: async () => ({ facts: [{ id: 'F1', text: 'BTC is at 80,000.' }, { id: 'F2', text: 'BTC rarely moves 12% in two weeks.' }], start: 80_000, measure: 'BTC price', baseRate: { rate: 0.3 }, analogs: null, sources: ['Binance'], histories: [], ...ev }),
    }) as never;

  it('proposes a sharper version that keeps the asset and direction', async () => {
    const { db, store, make } = setup();
    const t = make('alice');
    const llm: ChatModel = { model: 'fake', complete: async () => ({ text: JSON.stringify({ spec: { kind: 'price', asset: 'ETH', direction: 'up', target: 88_000, horizonDays: 30 }, why: 'More room.' }), toolCalls: [], usage }) };
    const out = await sharpenTake({ llm, evidence: evidenceStub(), theses: store, spend: new Spend(db) }, t);
    expect(out).toMatchObject({ claim: 'BTC above 88,000 in a month', why: 'More room.' });
    // A reason quoting a number it was never shown is replaced with a plain one.
    const invented: ChatModel = { model: 'fake', complete: async () => ({ text: JSON.stringify({ spec: { kind: 'price', asset: 'BTC', direction: 'up', target: 88_000, horizonDays: 30 }, why: 'Hits 77% of the time.' }), toolCalls: [], usage }) };
    expect(await sharpenTake({ llm: invented, evidence: evidenceStub(), theses: store, spend: new Spend(db) }, t)).toMatchObject({ why: 'A clearer level and timeframe, so the check-back says something.' });
    // The same claim back is not a sharper version.
    const same: ChatModel = { model: 'fake', complete: async () => ({ text: JSON.stringify({ spec }), toolCalls: [], usage }) };
    expect(await sharpenTake({ llm: same, evidence: evidenceStub(), theses: store, spend: new Spend(db) }, t)).toHaveProperty('error');
  });

  it('re-tests a draft in place with a new claim, and refuses once it is logged', async () => {
    const { db, store, make } = setup();
    const t = make('alice');
    const llm: ChatModel = { model: 'fake', complete: async () => ({ text: JSON.stringify(argument), toolCalls: [], usage }) };
    const deps = { llm, evidence: evidenceStub(), theses: store, spend: new Spend(db), now: () => NOW };
    const out = await redraftTake(deps, t, 'Alice', { ...spec, horizonDays: 30 }, 'timeframe changed to 1 month');
    expect(out.ok).toBe(true);
    const after = store.get(t.id)!;
    expect(after.claim).toBe('BTC above 90,000 in a month');
    expect(after.analysis.assumptions[0]).toBe('timeframe changed to 1 month');
    expect(after.analysis.assumptions.join(' ')).not.toContain('14 days'); // the old timeframe note is gone
    expect(after.analysis.baseRate).toBe(0.3);
    store.log(t.id, 80_000, NOW);
    expect(await redraftTake(deps, store.get(t.id)!, 'Alice', spec, 'x')).toMatchObject({ ok: false });
  });
});
