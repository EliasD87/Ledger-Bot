import type { Db } from '../db/index.js';

const DAY = 24 * 60 * 60 * 1000;

/** How long archived messages are kept. */
export const RETENTION_DAYS = 30;

export interface ArchivedMessage {
  messageId: string;
  channelId: string;
  authorName: string;
  content: string;
  ts: number;
}

/**
 * The opt-in message archive behind /recall: the last 30 days of what was said in channels Ledger can
 * read, searchable by keyword. Off by default; switching it off deletes everything stored for that server.
 */
export class MessageArchive {
  private readonly enabledCache = new Map<string, boolean>();

  constructor(private readonly db: Db) {}

  enabled(guildId: string): boolean {
    let on = this.enabledCache.get(guildId);
    if (on === undefined) {
      const row = this.db.prepare('SELECT memory_enabled AS on_ FROM guild_settings WHERE guild_id = ?').get(guildId) as { on_: number } | undefined;
      on = row?.on_ === 1;
      this.enabledCache.set(guildId, on);
    }
    return on;
  }

  /** Turns the archive on or off for a server. Turning it off deletes what was stored; returns how many messages. */
  setEnabled(guildId: string, on: boolean, now: number): number {
    this.db
      .prepare(
        `INSERT INTO guild_settings (guild_id, memory_enabled, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (guild_id) DO UPDATE SET memory_enabled = excluded.memory_enabled, updated_at = excluded.updated_at`,
      )
      .run(guildId, on ? 1 : 0, now);
    this.enabledCache.set(guildId, on);
    return on ? 0 : Number(this.db.prepare('DELETE FROM archive WHERE guild_id = ?').run(guildId).changes);
  }

  record(m: ArchivedMessage & { guildId: string; authorId: string }): void {
    if (!m.content.trim() || !this.enabled(m.guildId)) return;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO archive (message_id, guild_id, channel_id, author_id, author_name, content, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(m.messageId, m.guildId, m.channelId, m.authorId, m.authorName, m.content, m.ts);
  }

  /** Messages mentioning any of the topic's words since `since`, in the given channels only, oldest first. */
  search(guildId: string, topic: string, since: number, channelIds: ReadonlySet<string>, limit = 80): ArchivedMessage[] {
    const terms = topicTerms(topic).map((t) => `"${t}"`);
    if (!terms.length || !channelIds.size) return [];
    const rows = this.db
      .prepare(
        `SELECT a.message_id AS messageId, a.channel_id AS channelId, a.author_name AS authorName, a.content, a.ts
         FROM archive_fts f JOIN archive a ON a.rowid = f.rowid
         WHERE archive_fts MATCH ? AND a.guild_id = ? AND a.ts >= ?
         ORDER BY a.ts DESC LIMIT ?`,
      )
      .all(terms.join(' OR '), guildId, since, limit * 3) as unknown as ArchivedMessage[];
    return rows.filter((r) => channelIds.has(r.channelId)).slice(0, limit).reverse();
  }

  /** Deletes messages past the retention window. */
  prune(now: number): number {
    return Number(this.db.prepare('DELETE FROM archive WHERE ts < ?').run(now - RETENTION_DAYS * DAY).changes);
  }
}

const STOPWORDS = new Set(
  ('the a an and or but of to in on at for with about from into over this that these those what which who whom whose when where why how ' +
    'is are was were be been being do does did have has had any some all people say said says talk talked talking think thought ' +
    'week weeks today yesterday day days lately recently me my i you your we our they them their it its there here anything something').split(' '),
);

/** The words worth searching for in a topic like "what did people say about $SOL this week?" → ["sol"]. */
export function topicTerms(topic: string): string[] {
  const words = topic.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  return [...new Set(words.filter((w) => !STOPWORDS.has(w)))];
}
