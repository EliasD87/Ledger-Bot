import { describe, expect, it } from 'vitest';
import type { Candle } from '../src/calls/prices.js';
import { type CandleSource, Settler, evaluate } from '../src/calls/settle.js';
import { Board } from '../src/calls/store.js';
import { openDb } from '../src/db/index.js';

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 23, 12, 0);
/** A candle opening `minute` minutes after T0. */
const c = (minute: number, high: number, low = high, close = high): Candle => ({
  openTime: T0 + minute * MIN,
  open: close,
  high,
  low,
  close,
});

const touchAbove = { direction: 'above' as const, kind: 'touch' as const, target: 100, deadline: T0 + 10 * MIN, checkedUntil: T0 };

describe('evaluate', () => {
  it('wins a touch call on the first closed candle that reaches the target', () => {
    const result = evaluate(touchAbove, [c(0, 98), c(1, 101), c(2, 105)], T0 + 5 * MIN);
    expect(result).toEqual({ done: true, won: true, price: 101, at: T0 + MIN });
  });

  it('works downwards too', () => {
    const below = { ...touchAbove, direction: 'below' as const, target: 90 };
    expect(evaluate(below, [c(0, 95, 92), c(1, 93, 89)], T0 + 5 * MIN)).toMatchObject({ done: true, won: true, price: 89 });
  });

  it('ignores candles before the check point and the unfinished current minute', () => {
    const fromMinute2 = { ...touchAbove, checkedUntil: T0 + 2 * MIN };
    expect(evaluate(fromMinute2, [c(1, 150), c(2, 99)], T0 + 3 * MIN)).toEqual({ done: false, checkedUntil: T0 + 3 * MIN });
    expect(evaluate(touchAbove, [c(0, 99), c(1, 150)], T0 + MIN + 30_000)).toEqual({ done: false, checkedUntil: T0 + MIN });
  });

  it('ignores anything after the deadline', () => {
    expect(evaluate(touchAbove, [c(9, 99), c(10, 150)], T0 + 20 * MIN)).toMatchObject({ done: true, won: false, price: 99 });
  });

  it('misses a touch call once the deadline candle is in', () => {
    const candles = Array.from({ length: 10 }, (_, i) => c(i, 95 + i * 0.1));
    expect(evaluate(touchAbove, candles, T0 + 10 * MIN)).toEqual({ done: true, won: false, price: 95.9, at: T0 + 10 * MIN });
    expect(evaluate(touchAbove, candles.slice(0, 5), T0 + 10 * MIN)).toEqual({ done: false, checkedUntil: T0 + 5 * MIN });
  });

  it('judges a close call only on the price at the deadline', () => {
    const close = { ...touchAbove, kind: 'close' as const, checkedUntil: T0 + 9 * MIN };
    expect(evaluate(close, [c(9, 120, 99, 99)], T0 + 10 * MIN)).toMatchObject({ done: true, won: false, price: 99 });
    expect(evaluate(close, [c(9, 101, 90, 100)], T0 + 10 * MIN)).toMatchObject({ done: true, won: true, price: 100 });
  });
});

describe('Settler', () => {
  function setup(candles: Candle[], kind: 'touch' | 'close' = 'touch') {
    const board = new Board(openDb(':memory:'));
    const call = board.createDraft({
      guildId: 'g', channelId: 'c', callerId: 'alice', symbol: 'BTCUSDT', base: 'BTC', direction: 'above', kind,
      target: 100, deadline: T0 + 10 * MIN, entryPrice: 95, chance: 0.2, payout: 400, now: T0 - MIN,
    });
    board.lock(call.id, 95, { stake: 100, chance: 0.2, payout: 400 }, T0 - 30_000);
    board.join(call.id, 'bob', 'fade', { stake: 100, chance: 0.8, payout: 25 }, T0);
    const requests: number[] = [];
    const feed: CandleSource = {
      async candles(_symbol, _interval, range) {
        requests.push(range.startTime ?? 0);
        return candles.filter((x) => x.openTime >= (range.startTime ?? 0));
      },
    };
    let now = T0 + 3 * MIN;
    const settler = new Settler(board, feed, () => now);
    return { board, call, settler, requests, setNow: (t: number) => (now = t) };
  }

  it('settles a call that hit and pays everyone on it', async () => {
    const { board, call, settler } = setup([c(0, 97), c(1, 100.5), c(2, 99)]);
    const [settlement, ...rest] = await settler.tick();
    expect(rest).toEqual([]);
    expect(settlement).toMatchObject({ won: true, price: 100.5, at: T0 + MIN, call: { id: call.id, status: 'won' } });
    expect(settlement!.positions.map((p) => [p.userId, p.pnl])).toEqual([
      ['alice', 400],
      ['bob', -100],
    ]);
    expect(board.openCalls()).toEqual([]);
  });

  it('remembers how far it has checked when nothing has happened yet', async () => {
    const { board, call, settler, requests, setNow } = setup([c(0, 97), c(1, 98)]);
    expect(await settler.tick()).toEqual([]);
    expect(board.get(call.id)?.checkedUntil).toBe(T0 + 2 * MIN);
    setNow(T0 + 4 * MIN);
    await settler.tick();
    expect(requests).toEqual([T0, T0 + 2 * MIN]);
  });

  it("leaves close calls alone until their deadline", async () => {
    const { settler, requests, setNow } = setup([c(9, 101)], 'close');
    expect(await settler.tick()).toEqual([]);
    expect(requests).toEqual([]);
    setNow(T0 + 10 * MIN);
    const [settlement] = await settler.tick();
    expect(requests).toEqual([T0 + 9 * MIN]);
    expect(settlement).toMatchObject({ won: true, price: 101 });
  });

  it('sees a hit in the unfinished minute before letting anyone join', async () => {
    const { board, call, settler } = setup([c(0, 97), c(3, 100.2)]);
    expect(await settler.reachedSinceCheck(board.get(call.id)!)).toBe(true);
  });
});
