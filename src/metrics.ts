import type { Db } from './db/index.js';

export type EventType = 'message' | 'command' | 'button' | 'page_open' | 'post' | 'limited';

/**
 * What a member used, for the "2+ pillars" number. Page (the hub) and plain chat don't count as pillars:
 * they would make every member look connected by design.
 */
export type Pillar = 'record' | 'tape' | 'watch' | 'memory' | 'page' | 'chat';

/** Which pillar each chat tool belongs to. */
export const TOOL_PILLAR: Record<string, Pillar> = {
  stress_test: 'record',
  get_thesis: 'record',
  get_takes: 'record',
  list_debates: 'record',
  analyze: 'tape',
  show_chart: 'tape',
  search_news: 'tape',
  map_events: 'tape',
  get_price: 'tape',
  get_recap: 'tape',
  get_etf_flows: 'tape',
  get_macro: 'tape',
  get_treasury_buys: 'tape',
  get_news: 'tape',
  get_market: 'tape',
  set_alert: 'watch',
  list_alerts: 'watch',
  cancel_alert: 'watch',
  catch_up: 'memory',
  recall: 'memory',
  get_my_page: 'page',
};

/** Which pillar each slash command belongs to. */
export const COMMAND_PILLAR: Record<string, Pillar> = {
  take: 'record',
  takes: 'record',
  tape: 'tape',
  watch: 'watch',
  recall: 'memory',
  ledger: 'page',
};

export interface Habit {
  /** Members active in the last 7 days (chat, command, button or page open). */
  weekActive: number;
  monthActive: number;
  /** Average distinct active members per day over the last 7 days. */
  avgDailyActive: number;
  /** Members active on 3 or more of the last 8 UTC days. */
  returning: number;
  /** Members who used 2 or more of takes / tape / watch / memory in the last 7 days. */
  multiPillar: number;
  pageOpens: number;
  buttons: number;
  /** Takes argued out (drafts), logged as theses, and sides taken by other members. */
  stressTests: number;
  logged: number;
  sides: number;
  watchAdds: number;
  chatMessages: number;
  chatWithTools: number;
}

export interface EventInput {
  type: EventType;
  guildId?: string | null;
  channelId?: string | null;
  userId?: string | null;
  /** Conversation root, for 'message' events. */
  rootId?: string | null;
  meta?: Record<string, unknown>;
}

export interface Summary {
  /** Member messages Ledger answered. */
  messages: number;
  /** Distinct members who talked to Ledger or used a command. */
  members: number;
  conversations: number;
  /** Conversations with two or more members in them. */
  groupConversations: number;
  commands: number;
  /** Requests turned away by rate limits or the daily budget. */
  limited: number;
}

/** Engagement events: the numbers that show whether people actually use Ledger. */
export class Metrics {
  private readonly insert;
  private readonly summaryQuery;

  constructor(private readonly db: Db, private readonly now: () => number = Date.now) {
    this.insert = db.prepare(
      'INSERT INTO events (ts, type, guild_id, channel_id, user_id, root_id, meta) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    this.summaryQuery = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM events WHERE ts >= :since AND type = 'message') AS messages,
        (SELECT COUNT(DISTINCT user_id) FROM events WHERE ts >= :since AND type IN ('message', 'command')) AS members,
        (SELECT COUNT(DISTINCT root_id) FROM events WHERE ts >= :since AND type = 'message') AS conversations,
        (SELECT COUNT(*) FROM (
           SELECT root_id FROM events WHERE ts >= :since AND type = 'message'
           GROUP BY root_id HAVING COUNT(DISTINCT user_id) >= 2
        )) AS groupConversations,
        (SELECT COUNT(*) FROM events WHERE ts >= :since AND type = 'command') AS commands,
        (SELECT COUNT(*) FROM events WHERE ts >= :since AND type = 'limited') AS limited
    `);
  }

  record(e: EventInput): void {
    this.insert.run(
      this.now(), e.type, e.guildId ?? null, e.channelId ?? null, e.userId ?? null, e.rootId ?? null,
      e.meta ? JSON.stringify(e.meta) : null,
    );
  }

  /** Habit numbers for one server, for /ledger-admin stats and the grant report. */
  habit(guildId: string, now: number = this.now()): Habit {
    const DAY = 86_400_000;
    const active = "type IN ('message', 'command', 'button', 'page_open') AND user_id IS NOT NULL";
    const count = (sql: string, ...params: (string | number)[]) => (this.db.prepare(sql).get(...params) as { n: number }).n;
    const week = now - 7 * DAY;
    const daily = this.db
      .prepare(`SELECT COUNT(DISTINCT user_id) AS n FROM events WHERE guild_id = ? AND ${active} AND ts >= ? GROUP BY date(ts / 1000, 'unixepoch')`)
      .all(guildId, week) as { n: number }[];
    return {
      weekActive: count(`SELECT COUNT(DISTINCT user_id) AS n FROM events WHERE guild_id = ? AND ${active} AND ts >= ?`, guildId, week),
      monthActive: count(`SELECT COUNT(DISTINCT user_id) AS n FROM events WHERE guild_id = ? AND ${active} AND ts >= ?`, guildId, now - 30 * DAY),
      avgDailyActive: daily.reduce((sum, d) => sum + d.n, 0) / 7,
      returning: count(
        `SELECT COUNT(*) AS n FROM (SELECT user_id FROM events WHERE guild_id = ? AND ${active} AND ts >= ?
         GROUP BY user_id HAVING COUNT(DISTINCT date(ts / 1000, 'unixepoch')) >= 3)`,
        guildId,
        now - 8 * DAY,
      ),
      multiPillar: count(
        `SELECT COUNT(*) AS n FROM (
           SELECT user_id FROM (
             SELECT user_id, json_extract(meta, '$.pillar') AS pillar FROM events WHERE guild_id = ? AND ts >= ? AND meta IS NOT NULL
             UNION ALL
             SELECT e.user_id, j.value FROM events e, json_each(e.meta, '$.pillars') j
             WHERE e.guild_id = ? AND e.ts >= ? AND json_type(e.meta, '$.pillars') = 'array'
           ) WHERE pillar IN ('record', 'tape', 'watch', 'memory')
           GROUP BY user_id HAVING COUNT(DISTINCT pillar) >= 2)`,
        guildId,
        week,
        guildId,
        week,
      ),
      pageOpens: count("SELECT COUNT(*) AS n FROM events WHERE guild_id = ? AND type = 'page_open' AND ts >= ?", guildId, week),
      buttons: count("SELECT COUNT(*) AS n FROM events WHERE guild_id = ? AND type = 'button' AND ts >= ?", guildId, week),
      stressTests: count('SELECT COUNT(*) AS n FROM theses WHERE guild_id = ? AND created_at >= ?', guildId, week),
      logged: count('SELECT COUNT(*) AS n FROM theses WHERE guild_id = ? AND start_at >= ?', guildId, week),
      sides: count(
        'SELECT COUNT(*) AS n FROM thesis_sides s JOIN theses t ON t.id = s.thesis_id WHERE t.guild_id = ? AND s.created_at >= ?',
        guildId,
        week,
      ),
      watchAdds: count('SELECT COUNT(*) AS n FROM alerts WHERE guild_id = ? AND created_at >= ?', guildId, week),
      chatMessages: count("SELECT COUNT(*) AS n FROM events WHERE guild_id = ? AND type = 'message' AND ts >= ?", guildId, week),
      chatWithTools: count(
        "SELECT COUNT(*) AS n FROM events WHERE guild_id = ? AND type = 'message' AND ts >= ? AND json_extract(meta, '$.tools') IS NOT NULL",
        guildId,
        week,
      ),
    };
  }

  summary(sinceMs: number): Summary {
    return { ...(this.summaryQuery.get({ since: sinceMs }) as unknown as Summary) };
  }
}

/** Remembers which conversation each of Ledger's messages belongs to. */
export class ReplyIndex {
  private readonly insert;
  private readonly lookup;

  constructor(db: Db, private readonly now: () => number = Date.now) {
    this.insert = db.prepare('INSERT OR REPLACE INTO bot_replies (message_id, root_id, channel_id, ts) VALUES (?, ?, ?, ?)');
    this.lookup = db.prepare('SELECT root_id FROM bot_replies WHERE message_id = ?');
  }

  remember(messageId: string, rootId: string, channelId: string): void {
    this.insert.run(messageId, rootId, channelId, this.now());
  }

  rootOf(messageId: string): string | undefined {
    return (this.lookup.get(messageId) as { root_id: string } | undefined)?.root_id;
  }
}
