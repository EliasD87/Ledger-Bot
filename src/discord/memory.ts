import {
  type Client,
  type Collection,
  type GuildMember,
  type GuildTextBasedChannel,
  type Message,
  PermissionFlagsBits,
} from 'discord.js';
import { type MessageArchive, topicTerms } from '../memory/archive.js';
import { readableContent } from './text.js';

const HOUR = 60 * 60 * 1000;
const PAGE = 100;
const MAX_PAGES = 5; // up to 500 messages per catch-up
const MAX_TRANSCRIPT = 24_000; // characters (~7k tokens)

export type MemoryResult =
  | { ok: true; channelName: string; since: number; count: number; transcript: string }
  | { ok: false; error: string };

export interface MemoryContext {
  guildId: string;
  channelId: string;
  userId: string;
}

/**
 * "Catch me up" and recall. Reads Discord history live (catch-up) or from the opt-in archive (recall).
 * A member only ever gets a summary of channels they can read themselves.
 */
export class ServerMemory {
  constructor(
    /** The current Discord client (it is replaced when Ledger reconnects). */
    private readonly getClient: () => Client,
    readonly archive: MessageArchive,
  ) {}

  private get client(): Client {
    return this.getClient();
  }

  /** What a member missed in a channel: since their last message there (default), or the last `hours` hours. */
  async catchUp(ctx: MemoryContext, opts: { channel?: string; hours?: number } = {}): Promise<MemoryResult> {
    const access = await this.access(ctx, opts.channel);
    if (!access.ok) return access;
    const { channel } = access;
    const maxHours = Math.min(Math.max(opts.hours ?? 72, 1), 72);
    const floor = Date.now() - maxHours * HOUR;

    const messages = await this.history(channel, floor);
    // Default start: the member's last message from before this minute (so not the request itself), else 24h.
    const lastSaid = messages.filter((m) => m.author.id === ctx.userId && m.createdTimestamp < Date.now() - 60_000).at(-1);
    const since = opts.hours ? floor : (lastSaid?.createdTimestamp ?? Date.now() - 24 * HOUR);
    const missed = messages.filter((m) => m.createdTimestamp > since && m.author.id !== this.client.user?.id);
    if (!missed.length) return { ok: false, error: `Nothing new in #${channel.name} since ${opts.hours ? `the last ${opts.hours}h` : 'your last message'}.` };
    return { ok: true, channelName: channel.name, since, count: missed.length, transcript: transcript(missed.map(line)) };
  }

  /** What was said about a topic: the whole server from the archive if it's on, else this channel's recent history. */
  async recall(ctx: MemoryContext, topic: string, days = 7): Promise<MemoryResult> {
    const guild = await this.client.guilds.fetch(ctx.guildId);
    const member = await guild.members.fetch(ctx.userId);
    const since = Date.now() - Math.min(Math.max(days, 1), 30) * 24 * HOUR;

    if (this.archive.enabled(ctx.guildId)) {
      const readable = new Set(
        guild.channels.cache.filter((c) => c.isTextBased() && canRead(c as GuildTextBasedChannel, member)).map((c) => c.id),
      );
      const found = this.archive.search(ctx.guildId, topic, since, readable);
      if (!found.length) return { ok: false, error: `Nothing on the record about "${topic}" in the last ${days} days.` };
      const names = new Map(guild.channels.cache.map((c) => [c.id, c.name]));
      const lines = found.map((m) => `[${stamp(m.ts)}] #${names.get(m.channelId) ?? 'channel'} ${m.authorName}: ${clip(m.content)}`);
      return { ok: true, channelName: 'the whole server', since, count: found.length, transcript: transcript(lines) };
    }

    const access = await this.access(ctx);
    if (!access.ok) return access;
    const words = topicTerms(topic);
    const found = (await this.history(access.channel, since)).filter((m) => words.some((w) => m.content.toLowerCase().includes(w)));
    if (!found.length) {
      return { ok: false, error: `Nothing about "${topic}" in #${access.channel.name} lately. (Server-wide recall needs an admin to run /ledger-setup archive:true.)` };
    }
    return { ok: true, channelName: access.channel.name, since, count: found.length, transcript: transcript(found.map(line)) };
  }

  /** The channel to read (by name, mention or id; default: the current one), if the member can read it. */
  private async access(ctx: MemoryContext, channelRef?: string): Promise<{ ok: true; channel: GuildTextBasedChannel } | { ok: false; error: string }> {
    const guild = await this.client.guilds.fetch(ctx.guildId);
    const ref = channelRef?.trim().replace(/^<#(\d+)>$/, '$1').replace(/^#/, '');
    const channel = ref
      ? guild.channels.cache.find((c) => c.id === ref || c.name.toLowerCase() === ref.toLowerCase())
      : await guild.channels.fetch(ctx.channelId);
    if (!channel || !channel.isTextBased()) return { ok: false, error: `No text channel called "${channelRef}" here.` };
    const member = await guild.members.fetch(ctx.userId);
    if (!canRead(channel, member)) return { ok: false, error: "That's a channel you can't read, so I won't summarize it for you." };
    return { ok: true, channel };
  }

  /** Messages newer than `floor`, oldest first (up to 500). */
  private async history(channel: GuildTextBasedChannel, floor: number): Promise<Message[]> {
    const out: Message[] = [];
    let before: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const batch: Collection<string, Message> = await channel.messages.fetch({ limit: PAGE, ...(before ? { before } : {}) });
      if (!batch.size) break;
      const sorted = [...batch.values()].sort((a, b) => b.createdTimestamp - a.createdTimestamp);
      out.push(...sorted.filter((m) => m.createdTimestamp >= floor));
      if (sorted.at(-1)!.createdTimestamp < floor || batch.size < PAGE) break;
      before = sorted.at(-1)!.id;
    }
    return out.filter((m) => !m.system).sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  }
}

function canRead(channel: GuildTextBasedChannel, member: GuildMember): boolean {
  return channel.permissionsFor(member)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]) ?? false;
}

function line(m: Message): string {
  const names = {
    selfId: m.client.user.id,
    selfRoleId: undefined,
    users: new Map([...m.mentions.users.values()].map((u) => [u.id, u.displayName])),
    roles: new Map([...m.mentions.roles.values()].map((r) => [r.id, r.name])),
    channels: new Map<string, string>(),
  };
  const body = [m.content, ...m.embeds.map((e) => [e.title, e.description].filter(Boolean).join(': ')), ...[...m.attachments.values()].map((a) => `[attachment: ${a.name}]`)]
    .filter(Boolean)
    .join(' ');
  return `[${stamp(m.createdTimestamp)}] ${m.member?.displayName ?? m.author.displayName}: ${clip(readableContent(body, names, 600))}`;
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 400 ? `${flat.slice(0, 399)}…` : flat;
}

/** "Oct 23 14:05" in UTC. */
function stamp(ms: number): string {
  const iso = new Date(ms).toISOString();
  return `${new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })} ${iso.slice(11, 16)}`;
}

/** Joins lines, keeping the most recent ones if it's too long. */
function transcript(lines: string[]): string {
  const kept: string[] = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0 && size + lines[i]!.length < MAX_TRANSCRIPT; i--) {
    kept.unshift(lines[i]!);
    size += lines[i]!.length + 1;
  }
  return (kept.length < lines.length ? `(${lines.length - kept.length} earlier messages left out)\n` : '') + kept.join('\n');
}
