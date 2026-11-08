import type { Db } from '../db/index.js';
import type { Lang } from '../lang.js';
import type { BarRule } from './questions.js';

export interface BarQuestion {
  id: number;
  guildId: string;
  channelId: string;
  lang: Lang;
  messageId: string | null;
  day: string;
  rule: BarRule;
  startValue: number;
  /** Ledger's side from history (1 with, 0 against), and how often "with" happened on a day last year. */
  ledger: number;
  ledgerShare: number;
  opensAt: number;
  closesAt: number;
  settlesAt: number;
  status: 'open' | 'closed' | 'settled' | 'void';
  endValue: number | null;
  outcome: number | null;
}

export interface BarVote {
  userId: string;
  value: number;
}

/** A channel that gets the bar question, and the language it's asked in. */
export interface BarChannel {
  channelId: string;
  lang: Lang;
}

const COLUMNS = `id, guild_id AS guildId, channel_id AS channelId, lang, message_id AS messageId, day, rule, start_value AS startValue,
  ledger, ledger_share AS ledgerShare, opens_at AS opensAt, closes_at AS closesAt, settles_at AS settlesAt, status, end_value AS endValue, outcome`;
type Row = Omit<BarQuestion, 'rule'> & { rule: string };
const parse = (r: Row | undefined): BarQuestion | undefined => (r ? { ...r, rule: JSON.parse(r.rule) as BarRule } : undefined);

/** The daily bar question: where it's on, the questions, and who answered what. */
export class BarStore {
  constructor(private readonly db: Db) {}

  /** The channels on a server that get the question. */
  channels(guildId: string): BarChannel[] {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(`bar:channels:${guildId}`) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as BarChannel[]) : [];
  }

  /**
   * Turns the question on in a channel (or changes its language), or off with `lang` null. Off is remembered,
   * so a channel that gets the question by default stays off once an admin turns it off.
   */
  setChannel(guildId: string, channelId: string, lang: Lang | null, now: number): void {
    const rest = this.channels(guildId).filter((c) => c.channelId !== channelId);
    const next = lang ? [...rest, { channelId, lang }] : rest;
    const put = this.db.prepare(
      'INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    );
    put.run(`bar:channels:${guildId}`, JSON.stringify(next), now);
    put.run(`bar:off:${channelId}`, JSON.stringify(lang === null), now);
  }

  /** Whether an admin turned the question off in a channel. */
  isOff(channelId: string): boolean {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(`bar:off:${channelId}`) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as boolean) : false;
  }

  /** Every channel with the question on, on every server. */
  allChannels(): (BarChannel & { guildId: string })[] {
    const rows = this.db.prepare("SELECT key, value FROM kv WHERE key LIKE 'bar:channels:%'").all() as { key: string; value: string }[];
    return rows.flatMap((r) => (JSON.parse(r.value) as BarChannel[]).map((c) => ({ ...c, guildId: r.key.slice('bar:channels:'.length) })));
  }

  create(q: Omit<BarQuestion, 'id' | 'messageId' | 'status' | 'endValue' | 'outcome'>): BarQuestion | null {
    if (this.forDay(q.channelId, q.day)) return null;
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO bar_questions (guild_id, channel_id, lang, day, rule, start_value, ledger, ledger_share, opens_at, closes_at, settles_at, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      )
      .run(q.guildId, q.channelId, q.lang, q.day, JSON.stringify(q.rule), q.startValue, q.ledger, q.ledgerShare, q.opensAt, q.closesAt, q.settlesAt, q.opensAt);
    return this.get(Number(lastInsertRowid))!;
  }

  get(id: number): BarQuestion | undefined {
    return parse(this.db.prepare(`SELECT ${COLUMNS} FROM bar_questions WHERE id = ?`).get(id) as Row | undefined);
  }

  forDay(channelId: string, day: string): BarQuestion | undefined {
    return parse(this.db.prepare(`SELECT ${COLUMNS} FROM bar_questions WHERE channel_id = ? AND day = ?`).get(channelId, day) as Row | undefined);
  }

  /** The last question in a channel before a day that has its result. */
  lastSettled(channelId: string, before: string): BarQuestion | undefined {
    return parse(
      this.db
        .prepare(`SELECT ${COLUMNS} FROM bar_questions WHERE channel_id = ? AND day < ? AND status IN ('settled', 'void') ORDER BY day DESC LIMIT 1`)
        .get(channelId, before) as Row | undefined,
    );
  }

  attachMessage(id: number, messageId: string): void {
    this.db.prepare('UPDATE bar_questions SET message_id = ? WHERE id = ?').run(messageId, id);
  }

  /** A member's answer while answers are open. Switching sides is fine until then. */
  vote(id: number, userId: string, value: number, now: number): 'ok' | 'changed' | 'same' | 'closed' {
    const q = this.get(id);
    if (!q || q.status !== 'open' || now >= q.closesAt) return 'closed';
    const had = this.voteOf(id, userId);
    if (had?.value === value) return 'same';
    this.db
      .prepare(
        'INSERT INTO bar_votes (question_id, user_id, value, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (question_id, user_id) DO UPDATE SET value = excluded.value, created_at = excluded.created_at',
      )
      .run(id, userId, value, now);
    return had ? 'changed' : 'ok';
  }

  voteOf(id: number, userId: string): BarVote | undefined {
    return this.db.prepare('SELECT user_id AS userId, value FROM bar_votes WHERE question_id = ? AND user_id = ?').get(id, userId) as BarVote | undefined;
  }

  votes(id: number): BarVote[] {
    return this.db.prepare('SELECT user_id AS userId, value FROM bar_votes WHERE question_id = ? ORDER BY created_at').all(id) as unknown as BarVote[];
  }

  /** Open questions whose answers should close. */
  toClose(now: number): BarQuestion[] {
    return (this.db.prepare(`SELECT ${COLUMNS} FROM bar_questions WHERE status = 'open' AND closes_at <= ?`).all(now) as unknown as Row[]).map((r) => parse(r)!);
  }

  close(id: number): boolean {
    return this.db.prepare("UPDATE bar_questions SET status = 'closed' WHERE id = ? AND status = 'open'").run(id).changes > 0;
  }

  /** Closed questions whose 24 hours are up. */
  toSettle(now: number): BarQuestion[] {
    return (this.db.prepare(`SELECT ${COLUMNS} FROM bar_questions WHERE status = 'closed' AND settles_at <= ? ORDER BY settles_at`).all(now) as unknown as Row[]).map(
      (r) => parse(r)!,
    );
  }

  settle(id: number, endValue: number, outcome: number): void {
    this.db.prepare("UPDATE bar_questions SET status = 'settled', end_value = ?, outcome = ? WHERE id = ?").run(endValue, outcome, id);
  }

  /** No price came in time: it counts for nobody. */
  void(id: number): void {
    this.db.prepare("UPDATE bar_questions SET status = 'void' WHERE id = ?").run(id);
  }
}
