import { describe, expect, it } from 'vitest';
import type { AssetKind, History } from '../src/analysis/history.js';
import { rankChart } from '../src/charts/draw.js';
import { toPng } from '../src/charts/render.js';
import { leaderboard } from '../src/daily/board.js';
import { LEDGER_ID, POOL, buildQuestion, picksFor, roundLevel, scoreVotes, settle } from '../src/daily/rules.js';
import { DayRunner } from '../src/daily/runner.js';
import { DayStore } from '../src/daily/store.js';
import { openDb } from '../src/db/index.js';
import { parseDayButtonId, questionContainer } from '../src/discord/dailyCards.js';

const DAY = 86_400_000;
const boardChartRows = [
  { label: 'Kai', score: 412, detail: '6/8 right' },
  { label: 'Ledger', score: 350, detail: '5/8 right', highlight: true },
  { label: 'Elias', score: 300, detail: '4/7 right' },
];
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** A year of daily closes ending on `last`, gently rising with a wobble. */
function closes(last: string, start: number, drift = 0.001): { date: string; close: number }[] {
  const end = Date.parse(`${last}T00:00:00Z`);
  const out = [];
  let v = start;
  for (let i = 400; i >= 0; i--) {
    v *= 1 + drift + (i % 3 === 0 ? -0.01 : 0.006);
    out.push({ date: iso(end - i * DAY), close: Number(v.toFixed(2)) });
  }
  return out;
}

function fakeHistory(series: Record<string, { date: string; close: number }[]>) {
  return {
    identify: async (symbol: string, kind?: AssetKind) => (series[symbol] ? { symbol, kind: kind ?? 'crypto' } : null),
    daily: async (asset: { symbol: string; kind: AssetKind }): Promise<History> => ({ asset, closes: series[asset.symbol]!, source: 'test' }),
  } as never;
}

describe('question of the day rules', () => {
  it('rotates the pool and skips stock questions on weekends', () => {
    const saturday = '2026-10-31';
    expect(picksFor(saturday).every((i) => !POOL[i]!.stocks)).toBe(true);
    const weekdays = new Set(['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29'].map((d) => picksFor(d)[0]));
    expect(weekdays.size).toBe(4);
  });

  it('rounds levels to sensible steps', () => {
    expect(roundLevel(112_437)).toBe(112_000);
    expect(roundLevel(4_017)).toBe(4_000);
    expect(roundLevel(61.7)).toBe(62);
  });

  it('scores right votes higher when fewer people got it', () => {
    const votes = [
      { userId: 'a', value: 1 },
      { userId: 'b', value: 0 },
      { userId: 'c', value: 0 },
      { userId: 'd', value: 0 },
      { userId: LEDGER_ID, value: 1 },
    ];
    const scores = scoreVotes(1, votes);
    expect(scores.get('a')).toBe(88); // 1 of 4 right
    expect(scores.get('b')).toBe(0);
    expect(scores.get(LEDGER_ID)).toBe(88); // Ledger doesn't move the share
    expect(scoreVotes(0, votes).get('b')).toBe(63); // 3 of 4 right
  });

  it("builds a question from history, with Ledger's vote", async () => {
    const day = '2026-10-27';
    const series = Object.fromEntries(POOL.flatMap((q) => [q.asset, q.versus ?? q.asset]).map((s) => [s, closes(iso(Date.parse(day) - DAY), 100)]));
    const built = await buildQuestion(fakeHistory(series), day);
    expect(built).not.toBeNull();
    expect(built!.rule.date).toBe(day);
    expect([0, 1]).toContain(built!.ledger);
    expect(built!.rule.text.en.length).toBeGreaterThan(5);
    expect(built!.rule.text.zh).toMatch(/[一-鿿]/);
  });

  it('settles from the close on the day, waits for data, and voids a market holiday', async () => {
    const rule = { kind: 'up' as const, asset: 'SP500', assetKind: 'stock' as const, date: '2026-10-27', ref: 100, stocks: true, text: { en: '', zh: '' } };
    const now = Date.parse('2026-10-28T03:00:00Z');
    const base = [
      { date: '2026-10-26', close: 100 },
      { date: '2026-10-27', close: 101 },
    ];
    expect(await settle(fakeHistory({ SP500: base }), rule, now)).toBe(1);
    expect(await settle(fakeHistory({ SP500: base.slice(0, 1) }), rule, now)).toBeNull();
    const holiday = [
      { date: '2026-10-26', close: 100 },
      { date: '2026-10-28', close: 99 },
    ];
    expect(await settle(fakeHistory({ SP500: holiday }), rule, now + DAY)).toBe('void');
    const above = { ...rule, kind: 'above' as const, level: 101.5 };
    expect(await settle(fakeHistory({ SP500: base }), above, now)).toBe(0);
  });
});

describe('question of the day store and clock', () => {
  it('opens at 03:00, takes votes until 13:00, locks, settles and ranks', async () => {
    const db = openDb(':memory:');
    const store = new DayStore(db);
    let now = Date.parse('2026-10-27T02:00:00Z');
    const series = Object.fromEntries(POOL.flatMap((q) => [q.asset, q.versus ?? q.asset]).map((s) => [s, closes('2026-10-26', 100)]));
    const runner = new DayRunner({ store, history: fakeHistory(series), now: () => now });
    store.setChannel('g', 'c', now);

    expect(await runner.tick()).toEqual([]); // before 03:00
    now = Date.parse('2026-10-27T03:00:00Z');
    const opened = await runner.tick();
    expect(opened.map((e) => e.kind)).toEqual(['opened']);
    const q = opened[0]!.question;
    expect(q.closesAt).toBe(Date.parse('2026-10-27T13:00:00Z'));

    expect(store.vote(q.id, 'a', 1, now)).toBe('ok');
    expect(store.vote(q.id, 'a', 1, now)).toBe('same');
    expect(store.vote(q.id, 'a', 0, now)).toBe('changed');
    expect(store.vote(q.id, 'b', 1, now)).toBe('ok');
    expect(store.voters(q.id)).toBe(2);

    // Ledger's side stays hidden on the card while votes are open.
    const openCard = JSON.stringify(questionContainer(q, store.votes(q.id), now).toJSON());
    expect(openCard).not.toMatch(/Ledger is (with|against)/);
    expect(openCard).toContain('qotd:with:');

    now = Date.parse('2026-10-27T13:00:00Z');
    expect((await runner.tick()).map((e) => e.kind)).toEqual(['closed']);
    expect(store.vote(q.id, 'c', 1, now)).toBe('closed');
    const lockedCard = JSON.stringify(questionContainer(store.get(q.id)!, store.votes(q.id), now).toJSON());
    expect(lockedCard).toMatch(/Ledger is (with|against)/);
    expect(lockedCard).not.toContain('qotd:with:');

    // Its day's close lands; the next morning it settles.
    for (const s of Object.values(series)) s.push({ date: '2026-10-27', close: s.at(-1)!.close * 1.01 }, { date: '2026-10-28', close: s.at(-1)!.close });
    now = Date.parse('2026-10-28T02:30:00Z');
    const settled = (await runner.tick()).filter((e) => e.kind === 'settled');
    expect(settled).toHaveLength(1);
    const done = store.get(q.id)!;
    expect(done.status).toBe('settled');

    const { rows } = leaderboard(store, 'g', now);
    expect(rows.map((r) => r.userId).sort()).toEqual(['a', 'b', LEDGER_ID].sort());
    const right = rows.filter((r) => r.score > 0);
    expect(right.every((r) => r.right === 1 && r.played === 1)).toBe(true);
    expect(store.streak('g', right.find((r) => r.userId !== LEDGER_ID)!.userId)).toBe(1);
  });

  it('posts on demand later in the day with a short window, and refuses late at night', async () => {
    const store = new DayStore(openDb(':memory:'));
    let now = Date.parse('2026-10-31T18:00:00Z'); // a Saturday: crypto only
    const series = Object.fromEntries(POOL.flatMap((q) => [q.asset, q.versus ?? q.asset]).map((s) => [s, closes('2026-10-30', 100)]));
    const runner = new DayRunner({ store, history: fakeHistory(series), now: () => now });
    expect('error' in (await runner.open('g', 'c'))).toBe(true);
    const forced = await runner.open('g', 'c', true);
    expect('question' in forced && forced.question.closesAt).toBe(now + 3 * 3_600_000);
    now = Date.parse('2026-11-01T22:30:00Z');
    expect('error' in (await runner.open('g2', 'c', true))).toBe(true);
  });

  it('parses its button ids', () => {
    expect(parseDayButtonId('qotd:with:12')).toEqual({ action: 'with', id: '12' });
    expect(parseDayButtonId('thesis:log:12')).toBeNull();
  });
});

describe('leaderboard image', () => {
  it('draws ranked bars with Ledger highlighted', () => {
    const svg = rankChart({ title: 'Leaderboard · October', subtitle: 'Question of the day', rows: boardChartRows });
    expect(svg).toContain('Ledger');
    expect(toPng(svg).length).toBeGreaterThan(1000);
  });
});
