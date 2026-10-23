import { describe, expect, it } from 'vitest';
import { Board, ceilMinute, seasonStart } from '../src/calls/store.js';
import { openDb } from '../src/db/index.js';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const NOW = Date.UTC(2026, 9, 23, 12, 0, 30);
const terms = (chance: number, payout: number) => ({ stake: 100, chance, payout });

function setup() {
  const board = new Board(openDb(':memory:'));
  const draft = (overrides: Partial<Parameters<Board['createDraft']>[0]> = {}) =>
    board.createDraft({
      guildId: 'g',
      channelId: 'c',
      callerId: 'alice',
      symbol: 'BTCUSDT',
      base: 'BTC',
      direction: 'above',
      kind: 'touch',
      target: 90_000,
      deadline: NOW + 7 * DAY,
      entryPrice: 80_000,
      chance: 0.1,
      payout: 900,
      now: NOW,
      ...overrides,
    });
  const open = (overrides = {}) => {
    const call = draft(overrides);
    board.lock(call.id, 80_000, terms(0.1, 900), NOW);
    return call.id;
  };
  return { board, draft, open };
}

describe('Board: drafts and locking', () => {
  it('locks a draft once, at fresh terms, and gives the caller a back position', () => {
    const { board, draft } = setup();
    const call = draft();
    expect(call.status).toBe('draft');
    expect(board.lock(call.id, 80_500, terms(0.09, 1011), NOW + 1000)).toBe(true);
    expect(board.lock(call.id, 80_500, terms(0.09, 1011), NOW + 2000)).toBe(false);
    expect(board.get(call.id)).toMatchObject({
      status: 'open',
      entryPrice: 80_500,
      chance: 0.09,
      payout: 1011,
      lockedAt: NOW + 1000,
      checkedUntil: ceilMinute(NOW + 1000),
    });
    expect(board.positions(call.id)).toMatchObject([{ userId: 'alice', side: 'back', stake: 100, payout: 1011 }]);
  });

  it('cancels drafts and finds stale ones', () => {
    const { board, draft } = setup();
    const a = draft();
    const b = draft({ now: NOW + 20 * MIN });
    expect(board.staleDrafts(NOW + 10 * MIN).map((c) => c.id)).toEqual([a.id]);
    expect(board.cancel(a.id, 'draft expired')).toBe(true);
    expect(board.cancel(a.id, 'again')).toBe(false);
    expect(board.get(a.id)).toMatchObject({ status: 'cancelled', note: 'draft expired' });
    expect(board.lock(a.id, 1, terms(0.5, 100), NOW)).toBe(false);
    expect(board.get(b.id)?.status).toBe('draft');
  });
});

describe('Board: positions and settlement', () => {
  it('lets each member join an open call once', () => {
    const { board, draft, open } = setup();
    const id = open();
    expect(board.join(id, 'bob', 'back', terms(0.1, 900), NOW)).toBe('ok');
    expect(board.join(id, 'bob', 'fade', terms(0.9, 11), NOW)).toBe('already-in');
    expect(board.join(id, 'alice', 'fade', terms(0.9, 11), NOW)).toBe('already-in');
    expect(board.join(draft().id, 'bob', 'back', terms(0.1, 900), NOW)).toBe('closed');
  });

  it('pays backers when the call hits and faders when it misses', () => {
    const { board, open } = setup();
    const hit = open();
    board.join(hit, 'bob', 'back', terms(0.2, 400), NOW);
    board.join(hit, 'carol', 'fade', terms(0.8, 25), NOW);
    const paid = board.settle(hit, { won: true, price: 90_010, at: NOW + DAY }, NOW + DAY);
    expect(paid?.map((p) => [p.userId, p.result, p.pnl])).toEqual([
      ['alice', 'won', 900],
      ['bob', 'won', 400],
      ['carol', 'lost', -100],
    ]);
    expect(board.get(hit)).toMatchObject({ status: 'won', settlePrice: 90_010, settleTime: NOW + DAY });
    expect(board.settle(hit, { won: false, price: 1, at: 1 }, NOW)).toBeNull();

    const miss = open();
    board.join(miss, 'carol', 'fade', terms(0.8, 25), NOW);
    const missed = board.settle(miss, { won: false, price: 85_000, at: NOW + 7 * DAY }, NOW + 7 * DAY);
    expect(missed?.map((p) => [p.userId, p.pnl])).toEqual([
      ['alice', -100],
      ['carol', 25],
    ]);
  });

  it('voids open or settled calls back to zero', () => {
    const { board, open } = setup();
    const id = open();
    board.settle(id, { won: true, price: 90_000, at: NOW }, NOW);
    expect(board.void(id, 'bad print', NOW)).toBe(true);
    expect(board.get(id)).toMatchObject({ status: 'void', note: 'bad print' });
    expect(board.positions(id).map((p) => [p.result, p.pnl])).toEqual([['void', 0]]);
    expect(board.void(id, 'twice', NOW)).toBe(false);
  });
});

describe('Board: standings', () => {
  it('ranks this season by call scores, leaves agree/disagree out, and keeps last season out of it', () => {
    const { board, open } = setup();
    board.remember('alice', 'Alice');
    board.remember('bob', 'Bob');
    const lastMonth = seasonStart(NOW) - DAY;

    const old = open();
    board.settle(old, { won: true, price: 1, at: lastMonth }, lastMonth);

    const now = open();
    board.join(now, 'bob', 'fade', { stake: 0, chance: 0.9, payout: 0 }, NOW); // a lean: recorded, not scored
    board.settle(now, { won: true, price: 1, at: NOW }, NOW);

    const bobs = open({ callerId: 'bob' });
    board.settle(bobs, { won: false, price: 1, at: NOW }, NOW);

    expect(board.leaderboard('g', seasonStart(NOW))).toEqual([
      { userId: 'alice', name: 'Alice', points: 900, wins: 1, losses: 0, callPoints: 900, dailyPoints: 0 },
      { userId: 'bob', name: 'Bob', points: -100, wins: 0, losses: 1, callPoints: -100, dailyPoints: 0 },
    ]);
    expect(board.receipts('g', 'bob', seasonStart(NOW)).leans).toEqual({ right: 0, wrong: 1, open: 0 });
    expect(board.leaderboard('g', 0)[0]).toMatchObject({ userId: 'alice', points: 1800 });
    expect(board.leaderboard('other-server', 0)).toEqual([]);
  });

  it('builds receipts', () => {
    const { board, open } = setup();
    board.remember('alice', 'Alice');
    const won = open();
    board.settle(won, { won: true, price: 1, at: NOW }, NOW);
    const lost = open({ target: 100_000 });
    board.settle(lost, { won: false, price: 1, at: NOW }, NOW + 1);
    const pending = open();

    const r = board.receipts('g', 'alice', seasonStart(NOW));
    expect(r).toMatchObject({
      name: 'Alice',
      season: { points: 800, wins: 1, losses: 1 },
      lifetime: { points: 800, wins: 1, losses: 1 },
      callsMade: { open: 1, won: 1, lost: 1 },
      recent: ['lost', 'won'],
    });
    expect(r.biggestHit).toMatchObject({ points: 900, call: { id: won } });
    expect(r.open.map((o) => o.call.id)).toEqual([pending]);
  });

  it('finds members by display name', () => {
    const { board } = setup();
    board.remember('u1', 'Kai_Trades');
    board.remember('u2', 'Mo');
    expect(board.findMember('@kai_trades')).toBe('u1');
    expect(board.findMember('kai')).toBe('u1');
    expect(board.findMember('MO')).toBe('u2');
    expect(board.findMember('nobody')).toBeUndefined();
    expect(board.findMember('%')).toBeUndefined();
    expect(board.nameOf('u2')).toBe('Mo');
  });
});
