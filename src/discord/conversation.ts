import { ComponentType, type Message, MessageReferenceType } from 'discord.js';
import type { Config } from '../config.js';
import type { Board } from '../calls/store.js';
import type { ChatMessage, ChatModel, Usage } from '../llm/deepseek.js';
import type { RateLimiter, Spend } from '../llm/guards.js';
import { answerChecked } from '../llm/replyCheck.js';
import { log } from '../log.js';
import type { Metrics, ReplyIndex } from '../metrics.js';
import { LINES, PERSONA, PERSONA_EXAMPLES, contextLine } from '../persona.js';
import type { ToolKit } from '../tools.js';
import { draftContainer } from './callCards.js';
import { postableReply, readableContent, roleMentionIds } from './text.js';
import { type ThreadMessage, collectChain, toChatMessages } from './thread.js';
import { cards, say } from './ui.js';

const MAX_CHARS_PER_MESSAGE = 1200;

export interface ConversationDeps {
  config: Config;
  llm: ChatModel;
  /** The model's tools (see src/tools.ts). */
  tools: ToolKit;
  board: Board;
  limiter: RateLimiter;
  spend: Spend;
  metrics: Metrics;
  replies: ReplyIndex;
}

/**
 * Ledger's chat: a mention starts a conversation, and replying to any of Ledger's messages
 * continues it. The reply chain is the conversation's memory, so parallel threads never mix.
 */
export class Conversation {
  constructor(private readonly deps: ConversationDeps) {}

  async handle(message: Message): Promise<void> {
    if (message.author.bot || message.system || !message.inGuild()) return;
    const selfId = message.client.user.id;
    const parent = await parentOf(message);
    if (!isAddressedToSelf(message, selfId, parent)) return;
    if (!this.channelAllowed(message)) return;
    if (isHiddenFromSelf(message)) {
      // Without the Message Content intent, Discord blanks replies that don't ping Ledger.
      await message.reply(LINES.cantRead);
      return;
    }

    const { config, limiter, spend, metrics, board } = this.deps;
    const base = { guildId: message.guildId, channelId: message.channelId, userId: message.author.id };
    board.remember(message.author.id, message.member?.displayName ?? message.author.displayName);

    const verdict = limiter.check(message.author.id);
    if (!verdict.ok) {
      metrics.record({ ...base, type: 'limited', meta: { reason: verdict.reason } });
      if (verdict.reason === 'cooldown') await message.react('⏳').catch(() => {});
      else if (verdict.warn) await message.reply(LINES.hourlyLimit(Math.ceil(verdict.retryInMs / 60_000)));
      return;
    }
    limiter.hit(message.author.id);

    if (spend.today() >= config.guards.dailyBudgetUsd) {
      metrics.record({ ...base, type: 'limited', meta: { reason: 'budget' } });
      await message.reply(LINES.budgetSpent);
      return;
    }

    await message.channel.sendTyping().catch(() => {});
    const chain = await collectChain(message, parentOf, config.threadMaxMessages);
    const rootId = this.rootOf(chain, selfId);
    const prompt: ChatMessage[] = [
      { role: 'system', content: PERSONA },
      {
        role: 'system',
        content: contextLine({ server: message.guild.name, channel: channelName(message), now: new Date() }),
      },
      ...toChatMessages(chain.map((m) => toThreadMessage(m, selfId))),
    ];

    const session = this.deps.tools.session(base);
    let text: string;
    let toolsUsed: string[];
    let corrected: number;
    // Discord's typing indicator lasts ~10s; keep it on while tools fetch data, so a slow answer never looks dead.
    const typing = setInterval(() => void message.channel.sendTyping().catch(() => {}), 8_000);
    try {
      const { llm } = this.deps;
      const onUsage = (usage: Usage) => spend.record({ purpose: 'chat', model: llm.model, ...base, usage });
      // Checked against what its tools returned; a reply with invented figures or claimed-but-undone actions gets one redo.
      const answer = await answerChecked(llm, prompt, {
        maxTokens: config.llm.maxReplyTokens,
        tools: this.deps.tools.definitions,
        runTool: (call) => session.run(call),
        onUsage,
      }, PERSONA_EXAMPLES);
      text = postableReply(answer.text) || LINES.empty;
      toolsUsed = answer.toolsUsed;
      corrected = answer.problems.length;
    } catch (err) {
      log.error('DeepSeek request failed', err);
      await message.reply(LINES.llmError).catch(() => {});
      return;
    } finally {
      clearInterval(typing);
    }

    // A call drafted during this reply rides along as a card with its Lock it in button, under the text.
    const { draft } = session;
    const sent = await message.reply(draft ? cards([say(text), draftContainer(draft)], { replyPing: true }) : text);
    if (draft) board.attachMessage(draft.id, message.channelId, sent.id);
    this.deps.replies.remember(sent.id, rootId, message.channelId);
    metrics.record({
      ...base,
      type: 'message',
      rootId,
      meta: { depth: chain.length, ...(toolsUsed.length ? { tools: toolsUsed } : {}), ...(corrected ? { corrected } : {}) },
    });
  }

  private channelAllowed(message: Message<true>): boolean {
    const allowed = this.deps.config.discord.allowedChannelIds;
    if (allowed.size === 0) return true;
    const parentId = message.channel.isThread() ? message.channel.parentId : null;
    return allowed.has(message.channelId) || (parentId !== null && allowed.has(parentId));
  }

  /** The conversation a chain belongs to: the root of the earliest Ledger message we know, else the chain's first message. */
  private rootOf(chain: Message[], selfId: string): string {
    for (const m of chain) {
      if (m.author.id !== selfId) continue;
      const root = this.deps.replies.rootOf(m.id);
      if (root) return root;
    }
    return chain[0]!.id;
  }
}

/** The message `message` replies to, if it is a plain reply in the same channel and still exists. */
async function parentOf(message: Message): Promise<Message | null> {
  const ref = message.reference;
  if (!ref?.messageId || ref.type !== MessageReferenceType.Default || ref.channelId !== message.channelId) return null;
  try {
    return await message.fetchReference();
  } catch {
    return null; // deleted, or no access
  }
}

function isAddressedToSelf(message: Message<true>, selfId: string, parent: Message | null): boolean {
  if (parent?.author.id === selfId) return true;
  if (message.mentions.users.has(selfId)) return true;
  // Discord's autocomplete often offers the bot's role (also called "Ledger") next to the bot itself.
  // When that role isn't mentionable, Discord leaves it out of `mentions`, so read the raw tags too.
  const selfName = message.client.user.username.toLowerCase();
  return roleMentionIds(message.content).some((id) => {
    const role = message.guild.roles.cache.get(id);
    return role !== undefined && (role.tags?.botId === selfId || role.name.toLowerCase() === selfName);
  });
}

/** A message with nothing in it at all, which only happens when Discord withholds its content. */
function isHiddenFromSelf(m: Message): boolean {
  return !m.content && m.attachments.size === 0 && m.embeds.length === 0 && m.stickers.size === 0 && !m.poll;
}

function toThreadMessage(m: Message, selfId: string): ThreadMessage {
  const fromSelf = m.author.id === selfId;
  return {
    authorName: m.member?.displayName ?? m.author.displayName,
    fromSelf,
    // Ledger's own cards are read too, so "reply to ask" works on any post.
    content: readableContent(fullText(m, fromSelf), mentionNames(m, selfId), fromSelf ? 2400 : MAX_CHARS_PER_MESSAGE),
  };
}

/**
 * Message text plus what it would otherwise hide from the model: cards, embeds and attachments.
 * Ledger's own cards come through as one bracketed line each, never field by field: given the layout,
 * the model starts typing cards out by hand under the real one.
 */
function fullText(m: Message, fromSelf: boolean): string {
  const parts = [m.content];
  const { text, cardTexts } = componentText(m.components.map((c) => c.toJSON()));
  parts.push(...text);
  const cardsSeen = [
    ...cardTexts,
    ...m.embeds.map((e) => [e.title, e.description, ...e.fields.map((f) => `${f.name}: ${f.value}`)].filter(Boolean).join('\n')),
  ];
  for (const c of cardsSeen) parts.push(fromSelf ? `[card attached: ${oneLine(c).slice(0, 300)}]` : c);
  for (const file of m.attachments.values()) parts.push(`[attachment: ${file.name}]`);
  return parts.filter(Boolean).join('\n');
}

/** Text from a card layout: loose text blocks, and each container's text as one card. */
function componentText(components: unknown[]): { text: string[]; cardTexts: string[] } {
  const text: string[] = [];
  const cardTexts: string[] = [];
  const collect = (node: unknown, into: string[]) => {
    if (!node || typeof node !== 'object') return;
    const n = node as { type?: number; content?: unknown; components?: unknown[] };
    if (n.type === ComponentType.TextDisplay && typeof n.content === 'string') into.push(n.content);
    for (const child of n.components ?? []) collect(child, into);
  };
  for (const top of components) {
    if ((top as { type?: number }).type === ComponentType.Container) {
      const inside: string[] = [];
      collect(top, inside);
      if (inside.length) cardTexts.push(inside.join('\n'));
    } else {
      collect(top, text);
    }
  }
  return { text, cardTexts };
}

/** "### BTC ≥ 90,000\n-# Call #4" → "BTC ≥ 90,000 · Call #4". */
function oneLine(markdown: string): string {
  return markdown
    .split('\n')
    .map((l) => l.replace(/^(#{1,3}|-#)\s+/, '').trim())
    .filter(Boolean)
    .join(' · ');
}

function mentionNames(m: Message, selfId: string) {
  const users = new Map<string, string>();
  for (const user of m.mentions.users.values()) users.set(user.id, user.displayName);
  for (const member of m.mentions.members?.values() ?? []) users.set(member.id, member.displayName);
  const channels = new Map<string, string>();
  for (const channel of m.mentions.channels.values()) {
    if ('name' in channel && channel.name) channels.set(channel.id, channel.name);
  }
  return {
    selfId,
    selfRoleId: m.guild?.members.me?.roles.botRole?.id,
    users,
    roles: new Map([...m.mentions.roles.values()].map((r) => [r.id, r.name])),
    channels,
  };
}

function channelName(message: Message<true>): string {
  return 'name' in message.channel ? message.channel.name : 'unknown';
}
