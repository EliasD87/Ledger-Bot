import { MessageFlags } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { Conversation, holdLine } from '../src/discord/conversation.js';
import type { ChatModel, ToolCall } from '../src/llm/deepseek.js';

const usage = { cacheHitTokens: 0, cacheMissTokens: 10, outputTokens: 5, costUsd: 0.001 };

/** Just enough of a Discord message for Conversation.handle, recording what Ledger sends and edits. */
function fakeMessage(content: string) {
  const log: { kind: 'reply' | 'edit'; payload: unknown }[] = [];
  const sentMessage = (payload: unknown) => {
    const m = {
      id: `sent${log.length}`,
      flags: { has: () => false },
      components: [],
      edit: async (p: unknown) => (log.push({ kind: 'edit', payload: p }), m),
      delete: async () => {},
    };
    return m;
  };
  const message = {
    content,
    author: { id: 'u1', bot: false, displayName: 'Elias' },
    member: { displayName: 'Elias' },
    system: false,
    inGuild: () => true,
    guildId: 'g',
    channelId: 'c',
    guild: { name: 'CybeReator', roles: { cache: new Map() }, members: { me: null } },
    channel: { name: 'general', sendTyping: async () => {}, isThread: () => false },
    client: { user: { id: 'bot', username: 'Ledger' } },
    mentions: { users: new Map([['bot', { id: 'bot', displayName: 'Ledger' }]]), members: new Map(), roles: new Map(), channels: new Map() },
    reference: null,
    attachments: new Map(),
    embeds: [],
    stickers: new Map(),
    poll: null,
    components: [],
    react: async () => {},
    reply: async (p: unknown) => (log.push({ kind: 'reply', payload: p }), sentMessage(p)),
  };
  return { message, log };
}

function conversation(llm: ChatModel, runTool: (call: ToolCall) => Promise<string>) {
  return new Conversation({
    config: { guards: { dailyBudgetUsd: 5 }, discord: { allowedChannelIds: new Set() }, threadMaxMessages: 10, llm: { maxReplyTokens: 700 } } as never,
    llm,
    tools: { definitions: [], session: () => ({ run: runTool, draft: undefined, charts: [] }) } as never,
    members: { remember: () => {} } as never,
    theses: { attachMessage: () => {} } as never,
    limiter: { check: () => ({ ok: true }), hit: () => {} } as never,
    spend: { today: () => 0, record: () => {} } as never,
    metrics: { record: () => {} } as never,
    replies: { remember: () => {}, rootOf: () => undefined } as never,
  });
}

/** A model that calls one tool, then answers. */
function toolThenAnswer(tool: string, answer: string): ChatModel {
  let calls = 0;
  return {
    model: 'fake',
    complete: async () =>
      calls++ === 0 ? { text: '', toolCalls: [{ id: 't1', name: tool, arguments: '{}' }], usage } : { text: answer, toolCalls: [], usage },
  };
}

describe('the quick first line', () => {
  it('matches what Ledger is doing, in the member\'s language', () => {
    expect(holdLine('stress_test', 'en')).toBe('Testing that against the data. One moment.');
    expect(holdLine('stress_test', 'zh')).toMatch(/稍等/);
    expect(holdLine(undefined, 'en')).toBe('Looking into it. One moment.');
  });

  it('goes up as soon as a stress test starts, and the answer is edited into it', async () => {
    const { message, log } = fakeMessage('<@bot> SOL beats ETH this week');
    let sawLineDuringTool = false;
    await conversation(toolThenAnswer('stress_test', 'A real case. Read the against side first.'), async () => {
      sawLineDuringTool = log.some((l) => l.kind === 'reply' && (l.payload as { content?: string }).content === 'Testing that against the data. One moment.');
      return '{}';
    }).handle(message as never);
    expect(sawLineDuringTool).toBe(true);
    expect(log.map((l) => l.kind)).toEqual(['reply', 'edit']);
    expect((log[1]!.payload as { content: string }).content).toContain('A real case');
  });

  it('stays out of the way of a quick answer', async () => {
    const { message, log } = fakeMessage('<@bot> gm');
    const llm: ChatModel = { model: 'fake', complete: async () => ({ text: 'Morning Elias.', toolCalls: [], usage }) };
    await conversation(llm, async () => '{}').handle(message as never);
    expect(log.map((l) => l.kind)).toEqual(['reply']);
    expect((log[0]!.payload as { content: string }).content).toBe('Morning Elias.');
  });

  it('turns the line into a card when the answer carries one', async () => {
    const { message, log } = fakeMessage('<@bot> SOL beats ETH this week');
    const draft = {
      id: 7, guildId: 'g', channelId: 'c', messageId: null, authorId: 'u1', take: 'x', claim: 'SOL beats ETH over a week', status: 'draft',
      spec: { kind: 'relative', asset: 'SOL', versus: 'ETH', direction: 'up', horizonDays: 7 },
      analysis: { assumptions: [], argument: { for: [], against: [], kill: 'x', history: 'x', lean: 'even', verdict: 'Close call.' }, facts: [], sources: [] },
      startValue: null, startAt: null, checkAt: null, endValue: null, settledAt: null, note: null, createdAt: 0, challengerId: null,
    };
    const c = new Conversation({
      ...((conversation(toolThenAnswer('stress_test', 'Close call. Read both sides.'), async () => '{}') as unknown as { deps: object }).deps),
      tools: { definitions: [], session: () => ({ run: async () => '{}', draft, charts: [] }) },
    } as never);
    await c.handle(message as never);
    expect(log.map((l) => l.kind)).toEqual(['reply', 'edit']);
    const edit = log[1]!.payload as { content: unknown; flags: number; components: unknown[] };
    expect(edit.content).toBeNull(); // the plain line's text is cleared for the card
    expect(edit.flags & MessageFlags.IsComponentsV2).toBeTruthy();
    expect(edit.components.length).toBeGreaterThan(1);
  });
});
