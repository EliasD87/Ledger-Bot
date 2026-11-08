import { describe, expect, it } from 'vitest';
import { POOL, levelFor, outcomeOf, questionText, roundLevel, ruleFor } from '../src/bar/questions.js';
import { BarRunner } from '../src/bar/runner.js';
import { BarStore } from '../src/bar/store.js';
import { openDb } from '../src/db/index.js';
import { barQuestionContainer, barResultContainer, parseBarButtonId } from '../src/discord/barCards.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOON = Date.UTC(2026, 10, 8, 13, 0, 30);
const closes = Array.from({ length: 400 }, (_, i) => ({ date: new Date(NOON - (400 - i) * DAY).toISOString().slice(0, 10), close: 100 + (i % 3) }));
const history = {
  identify: async (symbol: string) => ({ symbol, kind: 'crypto' as const, pair: `${symbol}USDT` }),
  daily: async (asset: { symbol: string }) => ({ asset, closes, source: 'Binance' }),
} as never;

function setup(prices: number[]) {
  const store = new BarStore(openDb(':memory:'));
  let clock = NOON;
  let i = 0;
  const measure = { now: async () => prices[Math.min(i++, prices.length - 1)]! };
  const runner = new BarRunner({ store, measure, history, now: () => clock });
  return { store, runner, at: (ms: number) => (clock = ms) };
}

describe('the bar question', () => {
  it('asks only about the coins everyone follows, a different one each day', () => {
    expect(new Set(POOL.map((r) => r.asset))).toEqual(new Set(['BTC', 'ETH', 'SOL']));
    expect(ruleFor('2026-11-08')).not.toEqual(ruleFor('2026-11-09'));
  });

  it('writes the question in each language', () => {
    const rule = { kind: 'above' as const, asset: 'BTC', level: 81_000 };
    expect(questionText(rule, 'en')).toBe('Will BTC be above 81,000 this time tomorrow?');
    expect(questionText(rule, 'pt')).toBe('O BTC vai estar acima de 81,000 amanhã a esta hora?');
    expect(questionText({ kind: 'up', asset: 'ETH' }, 'es')).toBe('¿Estará ETH más alto mañana a esta hora?');
    expect(questionText({ kind: 'beats', asset: 'SOL', versus: 'ETH' }, 'zh')).toContain('跑赢 ETH');
  });

  it('picks a round number just above the price, and settles from the price a day later', () => {
    expect(roundLevel(80_750)).toBe(81_000);
    expect(roundLevel(2_431)).toBe(2_450);
    expect(roundLevel(158.3)).toBe(159);
    expect(outcomeOf({ kind: 'up', asset: 'BTC' }, 100, 101)).toBe(1);
    expect(outcomeOf({ kind: 'up', asset: 'BTC' }, 100, 100)).toBe(0);
    expect(outcomeOf({ kind: 'above', asset: 'BTC', level: 81_000 }, 80_750, 81_000)).toBe(1);
  });

  it('posts at 13:00 UTC, closes answers 8 hours later, settles after 24 hours, then posts the next', async () => {
    const { store, runner, at } = setup([80_750, 81_900, 81_900]);
    store.setChannel('g', 'c', 'pt', NOON);
    at(NOON - 2 * HOUR);
    expect(await runner.tick()).toEqual([]);
    at(NOON);
    const [opened] = await runner.tick();
    expect(opened).toMatchObject({ kind: 'opened', question: { channelId: 'c', lang: 'pt', status: 'open' } });
    const q = opened!.question;
    expect(store.vote(q.id, 'ana', 1, NOON + HOUR)).toBe('ok');
    expect(store.vote(q.id, 'ana', 0, NOON + 2 * HOUR)).toBe('changed');
    expect(store.vote(q.id, 'bo', 1, NOON + 2 * HOUR)).toBe('ok');
    at(NOON + 8 * HOUR);
    expect((await runner.tick()).map((e) => e.kind)).toEqual(['closed']);
    expect(store.vote(q.id, 'cy', 1, NOON + 8 * HOUR)).toBe('closed');
    at(NOON + DAY);
    const events = await runner.tick();
    expect(events.map((e) => e.kind)).toEqual(['settled', 'opened']);
    expect(store.get(q.id)).toMatchObject({ status: 'settled', endValue: 81_900 });
  });

  it('shows the answers, who read it right without pinging, and yesterday on the next card', async () => {
    const { store, runner } = setup([80_750]);
    const opened = await runner.open('g', 'c', 'en', true);
    if (!('question' in opened)) throw new Error(opened.error);
    const q = opened.question;
    store.vote(q.id, '111', 1, NOON);
    store.vote(q.id, '222', 0, NOON);
    const open = JSON.stringify(barQuestionContainer(q, store.votes(q.id), { chart: true }).toJSON());
    expect(open).toContain('2 answers so far');
    expect(open).toContain('bar:with:');
    store.close(q.id);
    store.settle(q.id, q.rule.kind === 'beats' ? q.startValue * 1.01 : 99_999, 1);
    const done = store.get(q.id)!;
    const settled = JSON.stringify(barQuestionContainer(done, store.votes(q.id)).toJSON());
    expect(settled).toContain('Result: yes.');
    expect(settled).toContain('1 of 2 read it right.');
    expect(settled).not.toContain('bar:with:');
    // The result goes out as its own message: who read it right and who missed, named but not pinged.
    const result = JSON.stringify(barResultContainer(done, store.votes(q.id)).toJSON());
    expect(result).toContain('Result: yes.');
    expect(result).toContain('✓ **Read it right (1):** <@111>');
    expect(result).toContain('✗ **Missed (1):** <@222>');
    expect(parseBarButtonId('bar:against:7')).toEqual({ action: 'against', id: 7 });
  });

  it('posts in the chat channels by default, and stays off where an admin turned it off', async () => {
    const { store, runner, at } = setup([80_750]);
    at(NOON);
    const defaults = [
      { guildId: 'g', channelId: 'pt-chat', lang: 'pt' as const },
      { guildId: 'g', channelId: 'zh-chat', lang: 'zh' as const },
    ];
    store.setChannel('g', 'zh-chat', null, NOON);
    const events = await runner.tick(defaults);
    expect(events.map((e) => [e.kind, e.question.channelId, e.question.lang])).toEqual([['opened', 'pt-chat', 'pt']]);
    expect(store.isOff('zh-chat')).toBe(true);
    store.setChannel('g', 'zh-chat', 'zh', NOON);
    expect(store.isOff('zh-chat')).toBe(false);
  });

  it('asks if a coin reaches or drops to a round number a normal day away, and counts the moment it gets there', async () => {
    expect(levelFor({ kind: 'reach', asset: 'BTC' }, 76_000)).toBe(78_000);
    expect(levelFor({ kind: 'drop', asset: 'ETH' }, 2_234)).toBe(2_150);
    expect(questionText({ kind: 'reach', asset: 'ETH', level: 2_300 }, 'en')).toBe('Will ETH reach 2,300 within 24 hours?');
    expect(questionText({ kind: 'drop', asset: 'BTC', level: 74_000 }, 'pt')).toBe('O BTC vai cair até 74,000 nas próximas 24 horas?');

    // Posts at 76,000 asking about 78,000; the price gets there two hours in.
    const store = new BarStore(openDb(':memory:'));
    let clock = NOON;
    let price = 76_000;
    const measure = { now: async () => price, range: async () => ({ high: 78_400, low: 75_100 }) };
    const runner = new BarRunner({ store, measure, history, now: () => clock });
    const opened = await runner.open('g', 'c', 'en', true);
    if (!('question' in opened)) throw new Error(opened.error);
    const q = { ...opened.question, rule: { kind: 'reach' as const, asset: 'BTC', level: 78_000 } };
    store.vote(q.id, 'ana', 1, NOON);
    // (The rotation picked its own rule; point the test at a known one.)
    (store as unknown as { db: { prepare(s: string): { run(...a: unknown[]): void } } }).db.prepare('UPDATE bar_questions SET rule = ? WHERE id = ?').run(JSON.stringify(q.rule), q.id);
    clock = NOON + 2 * HOUR;
    price = 78_050;
    expect((await runner.tick()).map((e) => e.kind)).toEqual(['closed']);
    expect(store.get(q.id)).toMatchObject({ status: 'closed', closesAt: NOON + 2 * HOUR });
    expect(store.vote(q.id, 'bo', 1, NOON + 3 * HOUR)).toBe('closed');
    // It falls back later; it still counts, and the result says how far it got.
    price = 75_500;
    clock = NOON + 24 * HOUR;
    await runner.tick();
    const done = store.get(q.id)!;
    expect(done).toMatchObject({ status: 'settled', outcome: 1, endValue: 78_400 });
    expect(JSON.stringify(barResultContainer(done, store.votes(q.id)).toJSON())).toContain('BTC got to 78,000 (as far as 78,400).');
  });

  it('shows a headline picked for the day, and big scheduled news', () => {
    const store = new BarStore(openDb(':memory:'));
    store.setHeadline('2026-11-08', 'Fed cuts rates by 0.25%', NOON);
    expect(store.headline('2026-11-08')).toBe('Fed cuts rates by 0.25%');
    const q = { id: 1, guildId: 'g', channelId: 'c', lang: 'en' as const, messageId: null, day: '2026-11-08', rule: { kind: 'reach' as const, asset: 'ETH', level: 2_300 },
      startValue: 2_234, ledger: 0, ledgerShare: 0.4, opensAt: NOON, closesAt: NOON + 8 * HOUR, settlesAt: NOON + DAY, status: 'open' as const, endValue: null, outcome: null, touchedAt: null };
    const card = JSON.stringify(barQuestionContainer(q, [], { events: ['CPI'], headline: store.headline(q.day) }).toJSON());
    expect(card).toContain('**Big one today: CPI.**');
    expect(card).toContain('**Headline:** Fed cuts rates by 0.25%');
    expect(card).toContain('It counts the moment the price gets there');
  });
});
