import { describe, expect, it, vi } from 'vitest';
import type { Evidence } from '../src/analysis/evidence.js';
import { openDb } from '../src/db/index.js';
import { cardCaption } from '../src/discord/text.js';
import type { ChatMessage, ChatModel, CompleteOptions, ModelTurn } from '../src/llm/deepseek.js';
import { Spend } from '../src/llm/guards.js';
import { chatWithTools } from '../src/llm/toolLoop.js';
import { Members } from '../src/members.js';
import { ThesisStore } from '../src/theses/store.js';
import { ToolKit, type ToolKitDeps, type ToolSession } from '../src/tools.js';

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
      { toolCalls: [{ id: 't1', name: 'get_thesis', arguments: '{"id":12}' }] },
      { text: 'Still open, and on track.' },
    ]);
    const runTool = vi.fn(async () => '{"claim":"SOL beats ETH"}');
    const onUsage = vi.fn();

    const result = await chatWithTools(model, [{ role: 'user', content: "kai: how's #12 doing?" }], {
      maxTokens: 100,
      tools: [],
      runTool,
      onUsage,
    });

    expect(result).toMatchObject({ text: 'Still open, and on track.', toolsUsed: ['get_thesis'], toolResults: ['{"claim":"SOL beats ETH"}'] });
    expect(runTool).toHaveBeenCalledOnce();
    expect(onUsage).toHaveBeenCalledTimes(2);
    expect(calls[1]!.messages.slice(-2)).toMatchObject([
      { role: 'assistant', tool_calls: [{ id: 't1', function: { name: 'get_thesis' } }] },
      { role: 'tool', tool_call_id: 't1', content: '{"claim":"SOL beats ETH"}' },
    ]);
  });

  it('forces a text answer on the last round', async () => {
    const { model, calls } = scriptedModel([{ text: 'still asking', toolCalls: [{ id: 'x', name: 'get_thesis', arguments: '{}' }] }]);
    const result = await chatWithTools(model, [], {
      maxTokens: 100,
      tools: [],
      runTool: async () => '{}',
      onUsage: () => {},
      maxRounds: 2,
    });
    expect(calls.map((c) => c.opts.toolChoice)).toEqual(['auto', 'none']);
    expect(result.text).toBe('still asking');
  });
});

describe('ToolKit', () => {
  const evidence: Evidence = {
    facts: [
      { id: 'F1', text: 'SOL/ETH ratio 0.0412, −8.3% over 30 days, in the 12th percentile of its 1-year range.' },
      { id: 'F2', text: 'Over 938 windows of 30 days, SOL beat ETH in 41% of them.' },
    ],
    start: 0.0412,
    measure: 'SOL/ETH',
    baseRate: null,
    analogs: null,
    sources: ['Binance'],
    histories: [],
  };
  const argument = {
    for: [{ point: 'The ratio is in the 12th percentile of its year.', facts: ['F1'] }],
    against: [{ point: 'SOL beat ETH in only 41% of 938 windows.', facts: ['F2'] }],
    kill: 'The ratio falling below 0.0412.',
    history: 'SOL beat ETH in 41% of similar windows.',
    lean: 'against',
    verdict: 'Cheap for a reason.',
  };
  const thesisJson = JSON.stringify({
    type: 'thesis',
    spec: { kind: 'relative', asset: 'SOL', versus: 'ETH', direction: 'up', horizonDays: 8 },
    assumptions: ['this month = 8 days'],
  });

  /** A model for the stress test: answers "understand" with `understood`, "argue" (thinking mode) with the argument. */
  function takeModel(understood = thesisJson): ChatModel {
    return {
      model: 'fake',
      complete: async (_m, opts) => ({ text: opts.thinking ? JSON.stringify(argument) : understood, toolCalls: [], usage }),
    };
  }

  function setup(extra: Partial<ToolKitDeps> = {}, llm = takeModel()) {
    const db = openDb(':memory:');
    const members = new Members(db);
    const theses = new ThesisStore(db);
    const spend = new Spend(db, () => NOW);
    const builder = { forAssets: async () => evidence, forThesis: async () => evidence } as never;
    const tools = new ToolKit({
      members,
      theses,
      take: { llm, evidence: builder, theses, spend, now: () => NOW },
      evidence: builder,
      measure: { now: async () => 0.045 },
      feed: { resolve: async () => null, spot: async () => 0 },
      now: () => NOW,
      ...extra,
    });
    members.remember('alice', 'Alice');
    members.remember('bob', 'Bob');
    return { members, theses, spend, tools, session: tools.session({ guildId: 'g', channelId: 'c', userId: 'alice', name: 'Alice' }) };
  }
  const run = async (session: ToolSession, name: string, args: unknown) =>
    JSON.parse(await session.run({ id: '1', name, arguments: typeof args === 'string' ? args : JSON.stringify(args) })) as Record<string, unknown>;

  it('offers only the tools this setup can serve', () => {
    expect(setup().tools.definitions.map((t) => t.function.name)).toEqual(['stress_test', 'analyze', 'get_thesis', 'get_takes', 'list_debates']);
  });

  it('stress-tests one take per message, as a draft for the speaker, and records the spend', async () => {
    const { session, theses, spend } = setup();
    const out = await run(session, 'stress_test', { take: 'sol flips eth this month' });
    expect(out).toMatchObject({ lean: 'against', verdict: 'Cheap for a reason.', read_as: ['this month = 8 days'] });
    // The card carries the numbers; the chat line only reacts to them.
    expect(JSON.stringify(out)).not.toMatch(/0\.0412|41%/);
    expect(session.draft).toMatchObject({ authorId: 'alice', status: 'draft', claim: 'SOL beats ETH over 8 days' });
    expect(theses.get(session.draft!.id)?.analysis.argument.lean).toBe('against');
    expect(spend.today()).toBeGreaterThan(0);
    expect(await run(session, 'stress_test', { take: 'eth is dead' })).toHaveProperty('error');
    // The card carries the analysis: no second helping of data for the line above it.
    expect(await run(session, 'analyze', { assets: ['SOL'] })).toHaveProperty('skipped');
  });

  it('keeps the line above a card to a short caption', () => {
    expect(cardCaption('Braver than it sounds.\n\nSecond paragraph that repeats the card.')).toBe('Braver than it sounds.');
    const long = `${'A sentence that goes on for a while. '.repeat(12)}`;
    expect(cardCaption(long).length).toBeLessThanOrEqual(300);
    expect(cardCaption(long).endsWith('.')).toBe(true);
  });

  it('hands small talk and vague takes back to the chat', async () => {
    const chatty = setup({}, takeModel('{"type":"not_a_take","why":"a greeting"}')).session;
    expect(await run(chatty, 'stress_test', { take: 'gm' })).toHaveProperty('not_a_take');
    expect(chatty.draft).toBeUndefined();
    const vague = setup({}, takeModel('{"type":"needs_detail","question":"Which coin?"}')).session;
    expect(await run(vague, 'stress_test', { take: 'it pumps' })).toEqual({ ask: 'Which coin?' });
  });

  it('analyzes assets from computed facts', async () => {
    const out = await run(setup().session, 'analyze', { assets: ['SOL', 'ETH'] });
    expect(out.facts).toEqual(evidence.facts.map((f) => f.text));
    expect(await run(setup().session, 'analyze', { assets: [] })).toHaveProperty('error');
  });

  it('reads theses, records and the open debates', async () => {
    const { session, theses } = setup();
    await run(session, 'stress_test', { take: 'sol flips eth' });
    const id = session.draft!.id;
    theses.log(id, 0.0412, NOW);
    theses.side(id, 'bob', 'against', NOW);

    expect(await run(session, 'get_thesis', { id })).toMatchObject({ id, by: 'Alice', status: 'open', against: ['Bob'], now: { on_track: true } });
    expect(await run(session, 'get_thesis', { id: 999 })).toHaveProperty('error');
    expect(await run(session, 'list_debates', {})).toMatchObject({ total_open: 1, open: [{ id, with: 0, against: 1 }] });
    expect(await run(session, 'get_takes', { member: 'me' })).toMatchObject({ member: 'Alice', open: 1, aged_well: 0 });
    expect(await run(session, 'get_takes', { member: '@bob' })).toMatchObject({ member: 'Bob', open: 0 });
    expect(await run(session, 'get_takes', { member: 'zed' })).toHaveProperty('error');

    theses.settle(id, 0.045, true, NOW + 9 * 86_400_000);
    expect(await run(session, 'get_takes', { member: 'bob' })).toMatchObject({ sides_read_right: '0 of 1' });
    expect(await run(session, 'list_debates', {})).toMatchObject({ total_open: 0, best_records: ['Alice: 1 of 1 aged well'] });
  });

  it('reports bad arguments and unknown tools as results instead of throwing', async () => {
    const { session } = setup();
    expect(await run(session, 'get_thesis', 'not json')).toHaveProperty('error');
    expect(await run(session, 'stress_test', {})).toHaveProperty('error');
    expect(await run(session, 'nope', {})).toHaveProperty('error');
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
              .map((t) => [
                t,
                { ticker: t, last: 212, prevClose: 212.21, changePct: -0.1, marketCap: 5.1e12, high52w: 243.37, low52w: 163.9, marketStatus: 'TRADING', asOf: '2026-10-23T16:32:00Z', source: 'SoSoValue' },
              ]),
          ),
      },
    };
    const { tools } = setup({ quotes });
    expect(tools.definitions.map((t) => t.function.name)).toContain('get_price');
    const out = await run(tools.session({ guildId: 'g', channelId: 'c', userId: 'alice' }), 'get_price', { symbols: ['btc', '$NVDA', 'NOPE'] });
    expect(out.prices).toMatchObject([
      { ticker: 'BTC', market: 'crypto', price: '81,500', change_24h: '+1.20%', source: 'Binance' },
      { ticker: 'NVDA', market: 'US stock', change_today: '−0.10%', market_status: 'trading', source: 'SoSoValue' },
    ]);
    expect(out.not_found).toMatch(/^NOPE:/);
  });
});
