import { describe, expect, it, vi } from 'vitest';
import type { PriceSource } from '../src/calls/service.js';
import { Board } from '../src/calls/store.js';
import { openDb } from '../src/db/index.js';
import type { ChatMessage, ChatModel, CompleteOptions, ModelTurn } from '../src/llm/deepseek.js';
import { chatWithTools } from '../src/llm/toolLoop.js';
import { TOOLS, ToolKit, type ToolSession, parseUtc } from '../src/tools.js';

const usage = { cacheHitTokens: 0, cacheMissTokens: 10, outputTokens: 5, costUsd: 0.0001 };
const NOW = Date.UTC(2026, 9, 23, 12, 0);

/** A model that plays back scripted turns and records what it was sent. */
function scriptedModel(turns: Partial<ModelTurn>[]) {
  const calls: { messages: ChatMessage[]; opts: CompleteOptions }[] = [];
  const model: ChatModel = {
    model: 'fake',
    async complete(messages, opts) {
      calls.push({ messages: [...messages], opts });
      const turn = turns[Math.min(calls.length - 1, turns.length - 1)]!;
      return { text: '', toolCalls: [], usage, ...turn };
    },
  };
  return { model, calls };
}

describe('chatWithTools', () => {
  it('runs requested tools, feeds results back, and returns the final text', async () => {
    const { model, calls } = scriptedModel([
      { toolCalls: [{ id: 't1', name: 'check_call', arguments: '{}' }] },
      { text: 'BTC 90k: 14%.' },
    ]);
    const runTool = vi.fn(async () => '{"chance":"14%"}');
    const onUsage = vi.fn();

    const result = await chatWithTools(model, [{ role: 'user', content: 'kai: odds?' }], {
      maxTokens: 100,
      tools: TOOLS,
      runTool,
      onUsage,
    });

    expect(result).toMatchObject({ text: 'BTC 90k: 14%.', toolsUsed: ['check_call'], toolResults: ['{"chance":"14%"}'] });
    expect(runTool).toHaveBeenCalledOnce();
    expect(onUsage).toHaveBeenCalledTimes(2);
    expect(calls[1]!.messages.slice(-2)).toMatchObject([
      { role: 'assistant', tool_calls: [{ id: 't1', function: { name: 'check_call' } }] },
      { role: 'tool', tool_call_id: 't1', content: '{"chance":"14%"}' },
    ]);
  });

  it('forces a text answer on the last round', async () => {
    const { model, calls } = scriptedModel([{ text: 'still asking', toolCalls: [{ id: 'x', name: 'check_call', arguments: '{}' }] }]);
    const result = await chatWithTools(model, [], {
      maxTokens: 100,
      tools: TOOLS,
      runTool: async () => '{}',
      onUsage: () => {},
      maxRounds: 2,
    });
    expect(calls.map((c) => c.opts.toolChoice)).toEqual(['auto', 'none']);
    expect(result.text).toBe('still asking');
  });
});

describe('ToolKit', () => {
  const feed: PriceSource = {
    resolve: async (asset) => (asset.toUpperCase() === 'BTC' ? 'BTCUSDT' : null),
    spot: async () => 80_000,
    dailyVol: async () => 0.025,
  };
  const btc85k = { asset: 'btc', direction: 'above', target: 85_000, window_hours: 168, kind: 'touch' };

  function setup(source: PriceSource = feed) {
    const board = new Board(openDb(':memory:'));
    const tools = new ToolKit({ feed: source, board, now: () => NOW });
    return { board, tools, session: tools.session({ guildId: 'g', channelId: 'c', userId: 'alice' }) };
  }
  const run = async (session: ToolSession, name: string, args: unknown) =>
    JSON.parse(await session.run({ id: '1', name, arguments: typeof args === 'string' ? args : JSON.stringify(args) })) as Record<string, unknown>;

  it('checks a call against live data', async () => {
    const out = await run(setup().session, 'check_call', btc85k);
    expect(out).toMatchObject({ call: 'BTC ≥ 85,000 within 7d (touch)', spot: '80,000', rated: '26% (even-ish)' });
    expect(JSON.stringify(out)).not.toMatch(/odds|pays|payout|stake|points|×/i);
  });

  it('refuses unknown assets and too-easy calls', async () => {
    const { session } = setup();
    expect(await run(session, 'check_call', { ...btc85k, asset: 'NOPE' })).toMatchObject({ refused: 'unknown-asset' });
    expect(await run(session, 'check_call', { ...btc85k, target: 80_100, window_hours: 720 })).toMatchObject({ refused: 'too-easy' });
  });

  it('reports bad arguments and feed failures as results instead of throwing', async () => {
    const { session } = setup();
    expect(await run(session, 'check_call', 'not json')).toHaveProperty('error');
    expect(await run(session, 'check_call', { ...btc85k, direction: 'sideways' })).toHaveProperty('error');
    expect(await run(session, 'nope', {})).toHaveProperty('error');
    const broken = setup({ ...feed, spot: async () => Promise.reject(new Error('down')) }).session;
    expect(await run(broken, 'check_call', btc85k)).toHaveProperty('error');
    expect(await run(broken, 'draft_call', btc85k)).toHaveProperty('error');
  });

  it('drafts one call per message for the speaker', async () => {
    const { board, session } = setup();
    const out = await run(session, 'draft_call', btc85k);
    expect(out.drafted).toMatchObject({ caller: 'someone', status: 'draft', spot: '80,000' });
    expect(session.draft).toMatchObject({ callerId: 'alice', base: 'BTC', status: 'draft', deadline: NOW + 168 * 3_600_000 });
    expect(board.get(session.draft!.id)).toBeDefined();
    expect(await run(session, 'draft_call', btc85k)).toHaveProperty('error');
  });

  it('takes deadlines as UTC dates', async () => {
    const { session } = setup();
    const { window_hours: _, ...byDate } = { ...btc85k, target: 82_000 };
    await run(session, 'draft_call', { ...byDate, deadline_utc: '2026-10-24 23:59' });
    expect(session.draft?.deadline).toBe(Date.UTC(2026, 9, 24, 23, 59));
    expect(await run(setup().session, 'check_call', { ...byDate, deadline_utc: '2026-10-01 12:00' })).toMatchObject({
      error: expect.stringMatching(/past/),
    });
    expect(await run(setup().session, 'check_call', byDate)).toHaveProperty('error');
    expect(parseUtc('2026-10-31')).toBe(Date.UTC(2026, 9, 31, 23, 59));
    expect(parseUtc('2026-10-24T08:30Z')).toBe(Date.UTC(2026, 9, 24, 8, 30));
    expect(parseUtc('Friday')).toBeNull();
  });

  it('quotes crypto and US stocks in one go, and names tickers it could not find', async () => {
    const quotes = {
      crypto: {
        resolve: async (a: string) => (a === 'BTC' ? 'BTCUSDT' : null),
        stats24h: async () => ({ BTCUSDT: { price: 81_500, change: 0.012, high: 82_000, low: 80_100, volumeUsd: 1.2e9 } }),
      },
      stocks: {
        stockQuotes: async (tickers: string[]) =>
          Object.fromEntries(
            tickers
              .filter((t) => t === 'NVDA')
              .map((t) => [t, { ticker: t, last: 212, prevClose: 212.21, changePct: -0.1, marketCap: 5.1e12, high52w: 243.37, low52w: 163.9, marketStatus: 'TRADING', asOf: '2026-10-23T16:32:00Z' }]),
          ),
      },
    };
    const tools = new ToolKit({ feed, board: new Board(openDb(':memory:')), quotes, now: () => NOW });
    expect(tools.definitions.map((t) => t.function.name)).toContain('get_price');
    const out = await run(tools.session({ guildId: 'g', channelId: 'c', userId: 'alice' }), 'get_price', { symbols: ['btc', '$NVDA', 'NOPE'] });
    expect(out.prices).toMatchObject([
      { ticker: 'BTC', market: 'crypto', price: '81,500', change_24h: '+1.20%', source: 'Binance' },
      { ticker: 'NVDA', market: 'US stock', change_today: '−0.10%', market_status: 'trading', source: 'SoSoValue' },
    ]);
    expect(out.not_found).toMatch(/^NOPE:/);
  });

  it("doesn't draft calls the board refuses", async () => {
    const { session } = setup();
    expect(await run(session, 'draft_call', { ...btc85k, target: 70_000 })).toMatchObject({ refused: 'already-there' });
    expect(session.draft).toBeUndefined();
  });

  it('reads receipts, the leaderboard and open calls', async () => {
    const { board, session } = setup();
    board.remember('alice', 'Alice');
    board.remember('bob', 'Bob');
    expect(await run(session, 'get_receipts', { member: 'me' })).toMatchObject({ note: expect.stringMatching(/Nothing on the record/) });
    expect(await run(session, 'get_receipts', { member: 'zed' })).toHaveProperty('error');

    await run(session, 'draft_call', btc85k);
    const id = session.draft!.id;
    board.lock(id, 80_000, { stake: 26, chance: 0.26, payout: 74 }, NOW);
    board.join(id, 'bob', 'fade', { stake: 0, chance: 0.74, payout: 0 }, NOW);

    expect(await run(session, 'list_open_calls', {})).toMatchObject({ total: 1, open_calls: [{ id, agree: 1, disagree: 1 }] });

    board.settle(id, { won: true, price: 90_100, at: NOW }, NOW);
    // Bob only disagreed: it's on his receipts, but it scores nothing and keeps him off the board.
    expect(await run(session, 'get_receipts', { member: '@bob' })).toMatchObject({
      member: 'Bob',
      lifetime: { record: '0–0', hit_rate: 'n/a' },
      agreed_or_disagreed: { right: 0, wrong: 1, open: 0 },
    });
    expect(await run(session, 'get_leaderboard', { period: 'season' })).toMatchObject({
      standings: [{ rank: 1, member: 'Alice', points: '+74', record: '1–0' }],
      speaker_rank: 1,
      total_ranked: 1,
    });
  });
});
