import { describe, expect, it } from 'vitest';
import type { Candle } from '../src/calls/prices.js';
import { Board } from '../src/calls/store.js';
import {
  DAILY_POINTS,
  etfOutcome,
  nextQuestionDay,
  questionFor,
  upDownOutcome,
  versusOutcome,
} from '../src/daily/questions.js';
import { DailyRunner, type DailyPoster } from '../src/daily/runner.js';
import { DailyStore, type Question } from '../src/daily/store.js';
import { openDb } from '../src/db/index.js';
import type { EtfDay, SoSoValue } from '../src/sosovalue.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const CLOSE = 13 * 60 + 30; // 13:30 UTC
const at = (iso: string) => Date.parse(iso);

describe('questionFor', () => {
  it('rotates by weekday and asks about ETF flows on US trading days', () => {
    // 2026-10-26 is a Monday.
    expect(questionFor('2026-10-26', CLOSE, true)).toMatchObject({ kind: 'etf-flow', assets: ['BTC'], options: ['Inflow', 'Outflow'] });
    expect(questionFor('2026-10-27', CLOSE, true)).toMatchObject({ kind: 'up-down', assets: ['BTC'], options: ['Up', 'Down'] });
    expect(questionFor('2026-10-28', CLOSE, true)).toMatchObject({ kind: 'etf-flow', assets: ['ETH'] });
    expect(questionFor('2026-10-29', CLOSE, true)).toMatchObject({ kind: 'versus', assets: ['ETH', 'SOL'], options: ['ETH', 'SOL'] });
    expect(questionFor('2026-10-31', CLOSE, true)).toMatchObject({ kind: 'up-down', assets: ['SOL'] });
    expect(questionFor('2026-11-01', CLOSE, true)).toMatchObject({ kind: 'versus', assets: ['BTC', 'ETH'] });
  });

  it('closes answers at the close time and measures prices to the UTC close', () => {
    const q = questionFor('2026-10-27', CLOSE, true);
    expect(q.closesAt).toBe(at('2026-10-27T13:30:00Z'));
    expect(q.windowEnd).toBe(at('2026-10-28T00:00:00Z'));
    expect(q.prompt).toBe('BTC from 13:30 to 00:00 UTC on Tue 27 Oct: up or down?');
  });

  it('swaps ETF questions for price questions without SoSoValue', () => {
    expect(questionFor('2026-10-26', CLOSE, false)).toMatchObject({ kind: 'up-down', assets: ['BTC'] });
  });

  it('never uses betting words', () => {
    for (let d = 26; d <= 32; d++) {
      const day = new Date(Date.UTC(2026, 9, d)).toISOString().slice(0, 10);
      const q = questionFor(day, CLOSE, true);
      expect(`${q.prompt} ${q.detail} ${q.options.join(' ')}`).not.toMatch(/\bodds\b|\bpay|stake|\bbet|wager|gambl/i);
    }
  });
});

describe('nextQuestionDay', () => {
  it("asks about today until an hour before today's close, then tomorrow", () => {
    expect(nextQuestionDay(at('2026-10-23T12:00:00Z'), CLOSE)).toBe('2026-10-23');
    expect(nextQuestionDay(at('2026-10-23T12:45:00Z'), CLOSE)).toBe('2026-10-24');
    expect(nextQuestionDay(at('2026-10-23T13:30:00Z'), CLOSE)).toBe('2026-10-24');
  });
});

describe('outcomes', () => {
  const etf = questionFor('2026-10-26', CLOSE, true);
  const upDown = questionFor('2026-10-27', CLOSE, true);
  const versus = questionFor('2026-10-29', CLOSE, true);
  const usd = (n: number) => `${n}`;

  it('decides ETF questions by the sign of the net flow', () => {
    expect(etfOutcome(etf, 412_300_000, usd).answer).toBe('a');
    expect(etfOutcome(etf, -5, usd).answer).toBe('b');
    expect(etfOutcome(etf, 0, usd).answer).toBeNull();
  });

  it('decides price questions, and voids exact ties', () => {
    expect(upDownOutcome(upDown, 100, 101, String)).toMatchObject({ answer: 'a', result: 'BTC 100 → 101 (+1.00%).' });
    expect(upDownOutcome(upDown, 100, 99, String).answer).toBe('b');
    expect(upDownOutcome(upDown, 100, 100, String).answer).toBeNull();
    expect(versusOutcome(versus, 0.008, 0.021)).toEqual({ answer: 'b', result: 'ETH +0.80% vs SOL +2.10%.' });
    expect(versusOutcome(versus, -0.01, -0.02).answer).toBe('a');
    expect(versusOutcome(versus, 0.01, 0.01).answer).toBeNull();
  });
});

describe('DailyStore', () => {
  function setup() {
    const db = openDb(':memory:');
    return { db, store: new DailyStore(db), board: new Board(db) };
  }

  it('takes one answer per member, lets them change it, and refuses after close', () => {
    const { store } = setup();
    const q = store.create('g', 'c', questionFor('2026-10-27', CLOSE, true), at('2026-10-26T13:30:00Z'));
    const before = at('2026-10-27T09:00:00Z');
    expect(store.answer(q.id, 'u1', 'a', before)).toBe('new');
    expect(store.answer(q.id, 'u1', 'b', before)).toBe('changed');
    expect(store.answer(q.id, 'u2', 'b', before)).toBe('new');
    expect(store.counts(q.id)).toEqual({ a: 0, b: 2 });
    expect(store.answer(q.id, 'u3', 'a', at('2026-10-27T13:30:00Z'))).toBe('closed');
  });

  it('scores right answers, counts streaks, and feeds the leaderboard', () => {
    const { store, board } = setup();
    board.remember('u1', 'Una');
    board.remember('u2', 'Dee');
    const days = ['2026-10-26', '2026-10-27', '2026-10-28'];
    for (const [i, day] of days.entries()) {
      const q = store.create('g', 'c', questionFor(day, CLOSE, true), at(`${day}T00:00:00Z`));
      store.answer(q.id, 'u1', 'a', at(`${day}T01:00:00Z`));
      if (i === 2) store.answer(q.id, 'u2', 'b', at(`${day}T01:00:00Z`));
      store.close(q.id, null);
      store.resolve(q.id, 'a', 'test', at(`${day}T23:00:00Z`));
    }
    expect(store.stats('g', 'u1')).toMatchObject({ answered: 3, right: 3, points: 3 * DAILY_POINTS, streak: 3 });
    expect(store.stats('g', 'u2')).toMatchObject({ answered: 1, right: 0, points: 0, streak: 1 });
    expect(store.stats('g', 'u1', at('2026-10-28T00:00:00Z')).seasonPoints).toBe(DAILY_POINTS);
    expect(board.leaderboard('g', 0).map((s) => [s.name, s.points])).toEqual([
      ['Una', 3 * DAILY_POINTS],
      ['Dee', 0],
    ]);
  });

  it('stores the daily channel per server', () => {
    const { store } = setup();
    store.setChannel('g1', 'c1', 0);
    store.setChannel('g2', 'c2', 0);
    store.setChannel('g2', null, 1);
    expect(store.channels()).toEqual([{ guildId: 'g1', channelId: 'c1' }]);
  });
});

describe('DailyRunner', () => {
  function setup(opts: { etf?: EtfDay[]; withSoso?: boolean } = {}) {
    const store = new DailyStore(openDb(':memory:'));
    store.setChannel('g', 'c', 0);
    let now = at('2026-10-26T14:00:00Z'); // Monday, after the close
    const posted: Question[] = [];
    const poster: DailyPoster = {
      post: async (q) => (posted.push(q), `m${q.id}`),
      refresh: async () => {},
    };
    const prices: Record<string, number> = {};
    const candles = {
      async candles(symbol: string, _i: '1m', range: { startTime: number }): Promise<Candle[]> {
        const p = prices[`${symbol}@${range.startTime}`];
        return p === undefined ? [] : [{ openTime: range.startTime, open: p, high: p, low: p, close: p }];
      },
    };
    const soso = opts.withSoso === false ? null : ({ etfFlows: async () => opts.etf ?? [] } as unknown as SoSoValue);
    const runner = new DailyRunner({ store, candles, soso, desk: null, poster, closeMinute: CLOSE, now: () => now });
    return { store, runner, posted, prices, setNow: (t: number) => (now = t) };
  }

  it('opens the next question, closes it on time, and resolves it from prices', async () => {
    const { store, runner, posted, prices, setNow } = setup();
    await runner.tick();
    expect(posted.map((q) => q.spec.day)).toEqual(['2026-10-27']); // Tuesday: BTC up or down
    const q = store.current('g')!;
    expect(q.messageId).toBe(`m${q.id}`);
    store.answer(q.id, 'up-voter', 'a', at('2026-10-27T10:00:00Z'));
    store.answer(q.id, 'down-voter', 'b', at('2026-10-27T10:00:00Z'));

    prices[`BTCUSDT@${at('2026-10-27T13:30:00Z')}`] = 100;
    setNow(at('2026-10-27T13:30:20Z'));
    await runner.tick();
    expect(store.get(q.id)).toMatchObject({ status: 'closed', startPrices: { BTC: 100 } });
    expect(posted.map((x) => x.spec.day)).toEqual(['2026-10-27', '2026-10-28']); // the next one opened right away

    prices[`BTCUSDT@${at('2026-10-27T23:59:00Z')}`] = 103;
    setNow(at('2026-10-28T00:01:05Z'));
    await runner.tick();
    expect(store.get(q.id)).toMatchObject({ status: 'resolved', answer: 'a', resultText: 'BTC 100 → 103 (+3.00%).' });
    expect(store.stats('g', 'up-voter').points).toBe(DAILY_POINTS);
    expect(store.stats('g', 'down-voter').points).toBe(0);
  });

  it('waits for SoSoValue to publish ETF flows, and voids a day that never comes', async () => {
    const etf: EtfDay[] = [];
    const { store, runner, setNow } = setup({ etf });
    setNow(at('2026-10-25T14:00:00Z')); // Sunday → next question is Monday's BTC ETF flows
    await runner.tick();
    const q = store.current('g')!;
    expect(q.spec.kind).toBe('etf-flow');

    setNow(at('2026-10-26T13:31:00Z'));
    await runner.tick();
    expect(store.get(q.id)!.status).toBe('closed');

    setNow(at('2026-10-27T03:00:00Z'));
    await runner.tick();
    expect(store.get(q.id)!.status).toBe('closed'); // not published yet

    etf.push({ date: '2026-10-26', totalNetInflow: -18_200_000, totalValueTraded: null, totalNetAssets: null, cumNetInflow: null });
    setNow(at('2026-10-27T03:31:00Z'));
    await runner.tick();
    expect(store.get(q.id)).toMatchObject({ status: 'resolved', answer: 'b' });
  });

  it('falls back to price questions without SoSoValue', async () => {
    const { store, runner, setNow } = setup({ withSoso: false });
    setNow(at('2026-10-25T14:00:00Z'));
    await runner.tick();
    expect(store.current('g')!.spec).toMatchObject({ kind: 'up-down', day: '2026-10-26' });
  });
});
