import { describe, expect, it } from 'vitest';
import { AlertStore } from '../src/alerts/store.js';
import { Board } from '../src/calls/store.js';
import { ROOM_MIN_ANSWERS, buildBook } from '../src/daily/book.js';
import { questionFor } from '../src/daily/questions.js';
import { DailyStore } from '../src/daily/store.js';
import { openDb } from '../src/db/index.js';
import { todaysPageEmbed } from '../src/discord/deskCards.js';
import { HOW_IT_WORKS, myPageMessage, receiptsEmbed } from '../src/discord/pageCards.js';
import { Metrics } from '../src/metrics.js';
import { Activity, buildMyPage } from '../src/pages/myPage.js';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 23, 14, 0);
const CLOSE = 13 * 60 + 30;
// Points are reputation: nothing a member reads may look like a betting slip.
const BETTING = /\bodds\b|\bpays?\b|payout|stake|\bbet\b|wager|gambl|\bback(ing)?\b|\bfad(e|ing)\b|×/i;

function setup() {
  const db = openDb(':memory:');
  const board = new Board(db);
  const daily = new DailyStore(db);
  const alerts = new AlertStore(db);
  const activity = new Activity(db);
  const prices = { change24h: async () => ({ BTCUSDT: { price: 85_000, change: 0.01 } }) };
  const deps = { board, daily, alerts, activity, prices, desk: null };
  board.remember('alice', 'Alice');
  board.remember('bob', 'Bob');

  /** A locked call, rated `chance`, scored the way the lock button scores it. */
  const call = (callerId: string, at: number, chance = 0.26) => {
    const c = board.createDraft({
      guildId: 'g', channelId: 'c', callerId, symbol: 'BTCUSDT', base: 'BTC', direction: 'above', kind: 'touch',
      target: 90_000, deadline: NOW + 7 * DAY, entryPrice: 80_000, chance, payout: 0, now: at,
    });
    board.lock(c.id, 80_000, { stake: Math.round(100 * chance), chance, payout: Math.round(100 * (1 - chance)) }, at);
    return c.id;
  };
  return { db, board, daily, alerts, activity, deps, call };
}

describe('Your page', () => {
  it('shows what changed since the last look, then starts over from now', async () => {
    const { board, alerts, activity, deps, call } = setup();
    activity.touch('g', 'alice', NOW - 3 * HOUR);

    const before = call('alice', NOW - 5 * DAY);
    board.settle(before, { won: true, price: 90_100, at: NOW - 4 * DAY }, NOW - 4 * DAY); // seen already
    const mine = call('alice', NOW - 2 * DAY);
    board.settle(mine, { won: true, price: 90_100, at: NOW - HOUR }, NOW - HOUR);
    const bobs = call('bob', NOW - DAY);
    board.join(bobs, 'alice', 'back', { stake: 0, chance: 0.26, payout: 0 }, NOW - DAY);
    alerts.create({ guildId: 'g', channelId: 'c', userId: 'alice', kind: 'price', asset: 'BTC', direction: 'above', target: 100_000 }, NOW);

    const page = await buildMyPage(deps, 'g', 'alice', NOW);
    expect(page).toMatchObject({ since: NOW - 3 * HOUR, firstVisit: false });
    expect(page.record.settled.map((s) => [s.call.id, s.asCaller, s.position.result])).toEqual([[mine, true, 'won']]);
    expect(page.record.open.map((o) => [o.call.id, o.asCaller, o.price])).toEqual([[bobs, false, 85_000]]);
    expect(page.record).toMatchObject({ rep: 148, rank: 1, ranked: 1 }); // two calls rated 26%, both right
    expect(page.watching.active).toHaveLength(1);
    expect(activity.lastPageAt('g', 'alice')).toBe(NOW);

    const again = await buildMyPage(deps, 'g', 'alice', NOW + 60_000);
    expect(again.record.settled).toEqual([]);
  });

  it('looks back a day on the first visit, and never more than a week', async () => {
    const { activity, deps } = setup();
    expect(await buildMyPage(deps, 'g', 'carol', NOW)).toMatchObject({ firstVisit: true, since: NOW - DAY });
    activity.touch('g', 'dave', NOW - 30 * DAY);
    expect((await buildMyPage(deps, 'g', 'dave', NOW)).since).toBe(NOW - 7 * DAY);
  });

  it('reads like a record, not a betting slip', async () => {
    const { board, daily, deps, call } = setup();
    const id = call('alice', NOW - DAY);
    board.settle(id, { won: false, price: 79_000, at: NOW - HOUR }, NOW - HOUR);
    call('alice', NOW - HOUR);
    const page = await buildMyPage({ ...deps, activity: new Activity(openDb(':memory:')) }, 'g', 'alice', NOW);
    const texts = [
      JSON.stringify(myPageMessage(page, 'g', true)),
      JSON.stringify(receiptsEmbed(board, daily, 'g', { id: 'alice', name: 'Alice' }, NOW).toJSON()),
      HOW_IT_WORKS,
    ];
    for (const text of texts) expect(text.replace(/"custom_id":"[^"]*"/g, '')).not.toMatch(BETTING);
  });
});

describe("Today's Page", () => {
  it("says how the room's answer held up, and lists calls settled and due", () => {
    const { board, daily, call } = setup();
    const spec = questionFor('2026-10-22', CLOSE, false);
    const q = daily.create('g', 'c', spec, NOW - 2 * DAY);
    for (const [user, choice] of [['u1', 'a'], ['u2', 'a'], ['u3', 'b']] as const) daily.answer(q.id, user, choice, q.closesAt - HOUR);
    daily.close(q.id, null);
    daily.resolve(q.id, 'a', 'It went the first way.', NOW - 2 * HOUR);

    const settled = call('alice', NOW - DAY);
    board.settle(settled, { won: true, price: 90_100, at: NOW - HOUR }, NOW - HOUR);
    const book = buildBook(board, daily, 'g', NOW);
    expect(book.verdict).toMatchObject({ counts: { a: 2, b: 1 }, roomRight: true });
    expect(book.roomSeason).toEqual({ right: 1, total: 1 });
    expect(book.settled.map((c) => c.id)).toEqual([settled]);

    const text = JSON.stringify(todaysPageEmbed(null, NOW, book)!.toJSON());
    expect(text).toContain(`Room said ${spec.options[0]} 2–1: right`);
    expect(text).not.toMatch(BETTING);
  });

  it(`gives no room verdict under ${ROOM_MIN_ANSWERS} answers`, () => {
    const { board, daily } = setup();
    const q = daily.create('g', 'c', questionFor('2026-10-22', CLOSE, false), NOW - 2 * DAY);
    daily.answer(q.id, 'u1', 'a', q.closesAt - HOUR);
    daily.close(q.id, null);
    daily.resolve(q.id, 'b', 'It went the other way.', NOW - 2 * HOUR);
    expect(buildBook(board, daily, 'g', NOW).verdict).toMatchObject({ roomRight: null });
  });
});

describe('habit metrics', () => {
  it('counts returning members and members who use two or more parts of Ledger', () => {
    const { db } = setup();
    let now = NOW - 5 * DAY;
    const metrics = new Metrics(db, () => now);
    for (let d = 0; d < 4; d++) {
      now = NOW - (4 - d) * DAY;
      metrics.record({ type: 'page_open', guildId: 'g', userId: 'alice', meta: { pillar: 'record' } });
    }
    metrics.record({ type: 'command', guildId: 'g', userId: 'alice', meta: { pillar: 'tape' } });
    metrics.record({ type: 'message', guildId: 'g', userId: 'bob', rootId: 'r', meta: { pillars: ['watch'], tools: ['set_alert'] } });

    expect(metrics.habit('g', NOW)).toMatchObject({
      weekActive: 2,
      returning: 1,
      multiPillar: 1,
      pageOpens: 4,
      chatMessages: 1,
      chatWithTools: 1,
    });
  });
});
