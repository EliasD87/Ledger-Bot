import { describe, expect, it } from 'vitest';
import type { ChatModel, ModelTurn } from '../src/llm/deepseek.js';
import { answerChecked, replyProblems } from '../src/llm/replyCheck.js';

const usage = { cacheHitTokens: 0, cacheMissTokens: 1, outputTokens: 1, costUsd: 0 };
const check = (reply: string, opts: { request?: string; toolsUsed?: string[]; sources?: string[] } = {}) =>
  replyProblems(reply, { request: opts.request ?? 'kai: hi', toolsUsed: opts.toolsUsed ?? [], sources: opts.sources ?? [] });

describe('replyProblems', () => {
  it('flags market figures that no tool returned and no message contains', () => {
    const [problem] = check('ETH $2,847, −0.42% on the day.', { sources: ['{"price":"2,412.34","change_24h":"−1.17%"}'] });
    expect(problem).toContain('2,847');
    expect(problem).toContain('0.42');
  });

  it('accepts figures from tool results or the thread, including rounding and "82k"', () => {
    const sources = ['{"price":"2,412.34","flow":"−$635.5M","cap":"$2.73T"}', 'mo: put me down btc 82k by eod'];
    expect(check('ETH 2,412, ETFs −$635.5M, cap $2.73T. BTC 82,000 by tonight.', { sources })).toEqual([]);
  });

  it('leaves small numbers, times, ids, years and links alone', () => {
    expect(check('Rated 13%: a stretch. Alert #12, Sun 25 Oct 23:59 UTC, 0–2 in 2026. https://x.com/a/status/1849021733')).toEqual([]);
  });

  it('flags alert changes claimed without the tool, only when the member asked for one', () => {
    expect(check('Done, housing release cancelled.', { request: 'Elias: drop the housing one lol' })[0]).toMatch(/cancel_alert/);
    expect(check('Done, cancelled.', { request: 'Elias: drop the housing one', toolsUsed: ['list_alerts', 'cancel_alert'] })).toEqual([]);
    expect(check('ETH dropped hard today.', { request: 'kai: what happened to eth' })).toEqual([]);
    expect(check('ETH 5% days, on watch.', { request: 'Elias: ping me any day eth moves 5%' })[0]).toMatch(/set_alert/);
    expect(check('Set: BTC above 83,000, DM on the cross.', { request: 'Elias: set a new one at 83k', sources: ['Elias: set a new one at 83k'] })[0]).toMatch(/set_alert/);
  });

  it('flags betting words, denials included, and a rating next to points', () => {
    expect(check('No payouts here.')[0]).toMatch(/payouts/);
    expect(check('A call rated 13% that lands scores +87 points.')[0]).toMatch(/rating next to points/);
    expect(check('GameFi +5.97% led, Others −1.17% lagged.', { sources: ['GameFi +5.97%, Others −1.17%'] })).toEqual([]);
  });
});

describe('answerChecked', () => {
  function model(turns: Partial<ModelTurn>[]) {
    const seen: unknown[][] = [];
    const m: ChatModel = {
      model: 'fake',
      async complete(messages) {
        seen.push([...messages]);
        return { text: '', toolCalls: [], usage, ...turns[Math.min(seen.length - 1, turns.length - 1)]! };
      },
    };
    return { m, seen };
  }
  const opts = { maxTokens: 50, tools: [], runTool: async () => '{"price":"2,412.34"}', onUsage: () => {} };
  const prompt = [
    { role: 'system' as const, content: 'You are Ledger. Example: BTC 90,000.' },
    { role: 'user' as const, content: 'kai: and eth?' },
  ];

  it('redoes a reply once, with its tool results in view, when it states figures nobody gave it', async () => {
    const { m, seen } = model([{ text: 'ETH 2,847.' }, { toolCalls: [{ id: 't', name: 'get_price', arguments: '{}' }] }, { text: 'ETH 2,412.' }]);
    const out = await answerChecked(m, prompt, opts);
    expect(out).toMatchObject({ text: 'ETH 2,412.', toolsUsed: ['get_price'] });
    expect(out.problems[0]).toContain('2,847');
    expect(JSON.stringify(seen[1])).toContain('Your reply above has problems');
  });

  it("doesn't count the system prompt's examples as evidence, and leaves a clean reply alone", async () => {
    expect((await answerChecked(model([{ text: 'BTC 90,000.' }, { text: 'Not sure.' }]).m, prompt, opts)).text).toBe('Not sure.');
    const clean = model([{ text: 'Ask me anything.' }]);
    expect(await answerChecked(clean.m, prompt, opts)).toMatchObject({ text: 'Ask me anything.', problems: [] });
    expect(clean.seen).toHaveLength(1);
  });
});
