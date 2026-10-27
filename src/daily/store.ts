import type { Db } from '../db/index.js';
import { type DayRule, LEDGER_ID } from './rules.js';

export interface DayQuestion {
  id: number;
  guildId: string;
  channelId: string;
  messageId: string | null;
  day: string;
  rule: DayRule;
  /** Ledger's vote: 1 with, 0 against. */
  ledger: number;
  opensAt: number;
  closesAt: number;
  status: 'open' | 'closed' | 'settled' | 'void';
  outcome: number | null;
}

export interface BoardRow {
  userId: string;
  score: number;
  /** Questions voted on, and how many were right. */
  played: number;
  right: number;
}

export interface Vote {
  userId: string;
  value: number;
  score: number | null;
}

const COLUMNS = `id, guild_id AS guildId, channel_id AS channelId, message_id AS messageId, day, rule, ledger, opens_at AS opensAt, closes_at AS closesAt, status, outcome`;
type Row = Omit<DayQuestion, 'rule'> & { rule: string };
const parse = (r: Row | undefined): DayQuestion | undefined => (r ? { ...r, rule: JSON.parse(r.rule) as DayRule } : undefined);

/** The question of the day: questions, votes and the leaderboard. */
export class DayStore {
  constructor(private readonly db: Db) {}

  /** Where a server's question of the day posts, or null if it's off there. */
  channel(guildId: string): string | null {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(`question:channel:${guildId}`) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as string | null) : null;
  }

  setChannel(guildId: string, channelId: string | null, now: number): void {
    this.db
      .prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .run(`question:channel:${guildId}`, JSON.stringify(channelId), now);
  }

  /** Servers with the question of the day on. */
  servers(): { guildId: string; channelId: string }[] {
    const rows = this.db.prepare("SELECT key, value FROM kv WHERE key LIKE 'question:channel:%'").all() as { key: string; value: string }[];
    return rows.flatMap((r) => {
      const channelId = JSON.parse(r.value) as string | null;
      return channelId ? [{ guildId: r.key.slice('question:channel:'.length), channelId }] : [];
    });
  }

  /** Posts a day's question and enters Ledger's vote. Null if the day already has one. */
  create(d: { guildId: string; channelId: string; day: string; opensAt: number; closesAt: number }, rule: DayRule, ledger: number): DayQuestion | null {
    if (this.forDay(d.guildId, d.day)) return null;
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO day_questions (guild_id, channel_id, day, rule, ledger, opens_at, closes_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)")
      .run(d.guildId, d.channelId, d.day, JSON.stringify(rule), ledger, d.opensAt, d.closesAt, d.opensAt);
    const id = Number(lastInsertRowid);
    this.db.prepare('INSERT INTO day_votes (question_id, user_id, value, created_at) VALUES (?, ?, ?, ?)').run(id, LEDGER_ID, ledger, d.opensAt);
    return this.get(id)!;
  }

  get(id: number): DayQuestion | undefined {
    return parse(this.db.prepare(`SELECT ${COLUMNS} FROM day_questions WHERE id = ?`).get(id) as Row | undefined);
  }

  forDay(guildId: string, day: string): DayQuestion | undefined {
    return parse(this.db.prepare(`SELECT ${COLUMNS} FROM day_questions WHERE guild_id = ? AND day = ?`).get(guildId, day) as Row | undefined);
  }

  /** The newest question on a server. */
  latest(guildId: string): DayQuestion | undefined {
    return parse(this.db.prepare(`SELECT ${COLUMNS} FROM day_questions WHERE guild_id = ? ORDER BY day DESC LIMIT 1`).get(guildId) as Row | undefined);
  }

  /** The last question before a day that has its result. */
  lastSettled(guildId: string, before: string): DayQuestion | undefined {
    return parse(
      this.db.prepare(`SELECT ${COLUMNS} FROM day_questions WHERE guild_id = ? AND day < ? AND status IN ('settled', 'void') ORDER BY day DESC LIMIT 1`).get(guildId, before) as
        | Row
        | undefined,
    );
  }

  attachMessage(id: number, messageId: string): void {
    this.db.prepare('UPDATE day_questions SET message_id = ? WHERE id = ?').run(messageId, id);
  }

  /** A member's vote, while votes are open. Switching sides is fine until the deadline. */
  vote(id: number, userId: string, value: number, now: number): 'ok' | 'changed' | 'same' | 'closed' {
    const q = this.get(id);
    if (!q || q.status !== 'open' || now >= q.closesAt) return 'closed';
    const had = this.voteOf(id, userId);
    if (had?.value === value) return 'same';
    this.db
      .prepare(
        'INSERT INTO day_votes (question_id, user_id, value, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (question_id, user_id) DO UPDATE SET value = excluded.value, created_at = excluded.created_at',
      )
      .run(id, userId, value, now);
    return had ? 'changed' : 'ok';
  }

  voteOf(id: number, userId: string): Vote | undefined {
    return this.db.prepare('SELECT user_id AS userId, value, score FROM day_votes WHERE question_id = ? AND user_id = ?').get(id, userId) as Vote | undefined;
  }

  votes(id: number): Vote[] {
    return this.db.prepare('SELECT user_id AS userId, value, score FROM day_votes WHERE question_id = ?').all(id) as unknown as Vote[];
  }

  /** Members (not Ledger) who voted. */
  voters(id: number): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM day_votes WHERE question_id = ? AND user_id <> ?').get(id, LEDGER_ID) as { n: number }).n;
  }

  /** Questions past their deadline that still take votes. */
  toClose(now: number): DayQuestion[] {
    return (this.db.prepare(`SELECT ${COLUMNS} FROM day_questions WHERE status = 'open' AND closes_at <= ?`).all(now) as unknown as Row[]).map((r) => parse(r)!);
  }

  close(id: number): boolean {
    return this.db.prepare("UPDATE day_questions SET status = 'closed' WHERE id = ? AND status = 'open'").run(id).changes > 0;
  }

  /** Locked questions waiting for their result. */
  toSettle(): DayQuestion[] {
    return (this.db.prepare(`SELECT ${COLUMNS} FROM day_questions WHERE status = 'closed' ORDER BY day`).all() as unknown as Row[]).map((r) => parse(r)!);
  }

  /** Records the outcome and everyone's score. */
  settle(id: number, outcome: number, scores: Map<string, number>, now: number): void {
    this.db.prepare("UPDATE day_questions SET status = 'settled', outcome = ?, settled_at = ? WHERE id = ?").run(outcome, now, id);
    const set = this.db.prepare('UPDATE day_votes SET score = ? WHERE question_id = ? AND user_id = ?');
    for (const [userId, score] of scores) set.run(score, id, userId);
  }

  /** No result (a market holiday, no data): it scores nothing for anyone. */
  void(id: number, now: number): void {
    this.db.prepare("UPDATE day_questions SET status = 'void', settled_at = ? WHERE id = ?").run(now, id);
  }

  /** Points per member (and Ledger) over settled questions with days in [from, to), best first. */
  board(guildId: string, fromDay: string, toDay: string): BoardRow[] {
    return this.db
      .prepare(
        `SELECT v.user_id AS userId, SUM(v.score) AS score, COUNT(*) AS played, SUM(v.score > 0) AS "right"
         FROM day_votes v JOIN day_questions q ON q.id = v.question_id
         WHERE q.guild_id = ? AND q.day >= ? AND q.day < ? AND q.status = 'settled'
         GROUP BY v.user_id ORDER BY score DESC, "right" DESC, played ASC`,
      )
      .all(guildId, fromDay, toDay) as unknown as BoardRow[];
  }

  /** How many right in a row, counting back from the member's latest settled vote. */
  streak(guildId: string, userId: string): number {
    const rows = this.db
      .prepare(
        `SELECT v.score FROM day_votes v JOIN day_questions q ON q.id = v.question_id
         WHERE q.guild_id = ? AND v.user_id = ? AND q.status = 'settled' ORDER BY q.day DESC LIMIT 60`,
      )
      .all(guildId, userId) as { score: number }[];
    let n = 0;
    for (const r of rows) {
      if (r.score <= 0) break;
      n++;
    }
    return n;
  }
}
