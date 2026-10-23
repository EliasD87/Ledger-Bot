import type { Db } from '../db/index.js';
import { type Choice, DAILY_POINTS, type QuestionSpec } from './questions.js';

export type QuestionStatus = 'open' | 'closed' | 'resolved' | 'void';

export interface Question {
  id: number;
  guildId: string;
  channelId: string;
  messageId: string | null;
  day: string;
  spec: QuestionSpec;
  closesAt: number;
  status: QuestionStatus;
  answer: Choice | null;
  resultText: string | null;
  startPrices: Record<string, number> | null;
  lastCheck: number | null;
  resolvedAt: number | null;
}

export interface DailyStats {
  /** Decided questions answered (void ones included). */
  answered: number;
  right: number;
  points: number;
  /** Points from questions decided since the season started. */
  seasonPoints: number;
  /** Questions answered in a row, counting back from the latest one. */
  streak: number;
}

type Row = Omit<Question, 'spec' | 'startPrices'> & { spec: string; startPrices: string | null };

const COLUMNS = `id, guild_id AS guildId, channel_id AS channelId, message_id AS messageId, day, spec,
  closes_at AS closesAt, status, answer, result_text AS resultText, start_prices AS startPrices,
  last_check AS lastCheck, resolved_at AS resolvedAt`;

/** Daily Questions, the answers to them, and which channel each server wants them in. */
export class DailyStore {
  constructor(private readonly db: Db) {}

  // --- settings ---

  setChannel(guildId: string, channelId: string | null, now: number): void {
    this.db
      .prepare(
        `INSERT INTO guild_settings (guild_id, daily_channel_id, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (guild_id) DO UPDATE SET daily_channel_id = excluded.daily_channel_id, updated_at = excluded.updated_at`,
      )
      .run(guildId, channelId, now);
  }

  channels(): { guildId: string; channelId: string }[] {
    return this.db
      .prepare('SELECT guild_id AS guildId, daily_channel_id AS channelId FROM guild_settings WHERE daily_channel_id IS NOT NULL')
      .all() as unknown as { guildId: string; channelId: string }[];
  }

  // --- questions ---

  create(guildId: string, channelId: string, spec: QuestionSpec, now: number): Question {
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO daily_questions (guild_id, channel_id, day, kind, spec, closes_at, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
      )
      .run(guildId, channelId, spec.day, spec.kind, JSON.stringify(spec), spec.closesAt, now);
    return this.get(Number(lastInsertRowid))!;
  }

  get(id: number): Question | undefined {
    return this.parse(this.db.prepare(`SELECT ${COLUMNS} FROM daily_questions WHERE id = ?`).get(id));
  }

  exists(guildId: string, day: string): boolean {
    return this.db.prepare('SELECT 1 FROM daily_questions WHERE guild_id = ? AND day = ?').get(guildId, day) !== undefined;
  }

  /** The question members can answer right now in a server, if any. */
  current(guildId: string): Question | undefined {
    return this.parse(
      this.db.prepare(`SELECT ${COLUMNS} FROM daily_questions WHERE guild_id = ? AND status = 'open' ORDER BY day DESC`).get(guildId),
    );
  }

  /** The most recently decided question in a server. */
  lastResolved(guildId: string): Question | undefined {
    return this.parse(
      this.db
        .prepare(`SELECT ${COLUMNS} FROM daily_questions WHERE guild_id = ? AND status IN ('resolved', 'void') ORDER BY day DESC`)
        .get(guildId),
    );
  }

  withStatus(status: QuestionStatus): Question[] {
    return (this.db.prepare(`SELECT ${COLUMNS} FROM daily_questions WHERE status = ? ORDER BY day`).all(status) as unknown[])
      .map((row) => this.parse(row)!);
  }

  attachMessage(id: number, messageId: string): void {
    this.db.prepare('UPDATE daily_questions SET message_id = ? WHERE id = ?').run(messageId, id);
  }

  /** Closes answering. Price questions record their starting prices here. */
  close(id: number, startPrices: Record<string, number> | null): boolean {
    const { changes } = this.db
      .prepare("UPDATE daily_questions SET status = 'closed', start_prices = ? WHERE id = ? AND status = 'open'")
      .run(startPrices ? JSON.stringify(startPrices) : null, id);
    return changes > 0;
  }

  markChecked(id: number, now: number): void {
    this.db.prepare('UPDATE daily_questions SET last_check = ? WHERE id = ?').run(now, id);
  }

  /** Decides a closed question: right answers get the points. A null answer voids it (nobody gains anything). */
  resolve(id: number, answer: Choice | null, resultText: string, now: number): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const { changes } = this.db
        .prepare(
          `UPDATE daily_questions SET status = ?, answer = ?, result_text = ?, resolved_at = ?
           WHERE id = ? AND status = 'closed'`,
        )
        .run(answer ? 'resolved' : 'void', answer, resultText, now, id);
      if (changes > 0) {
        this.db
          .prepare(
            `UPDATE daily_answers SET correct = CASE WHEN choice = :answer THEN 1 ELSE 0 END,
                    points = CASE WHEN choice = :answer THEN :points ELSE 0 END
             WHERE question_id = :id`,
          )
          .run({ answer: answer ?? '', points: answer ? DAILY_POINTS : 0, id });
      }
      this.db.exec('COMMIT');
      return changes > 0;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // --- answers ---

  /** Records (or changes) a member's answer while answering is open. */
  answer(id: number, userId: string, choice: Choice, now: number): 'new' | 'changed' | 'closed' {
    const q = this.get(id);
    if (!q || q.status !== 'open' || now >= q.closesAt) return 'closed';
    const before = this.answerOf(id, userId);
    this.db
      .prepare(
        `INSERT INTO daily_answers (question_id, user_id, choice, answered_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (question_id, user_id) DO UPDATE SET choice = excluded.choice, answered_at = excluded.answered_at`,
      )
      .run(id, userId, choice, now);
    return before ? 'changed' : 'new';
  }

  answerOf(id: number, userId: string): Choice | undefined {
    const row = this.db.prepare('SELECT choice FROM daily_answers WHERE question_id = ? AND user_id = ?').get(id, userId);
    return (row as { choice: Choice } | undefined)?.choice;
  }

  counts(id: number): { a: number; b: number } {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(choice = 'a'), 0) AS a, COALESCE(SUM(choice = 'b'), 0) AS b
         FROM daily_answers WHERE question_id = ?`,
      )
      .get(id) as { a: number; b: number };
    return { a: row.a, b: row.b };
  }

  /**
   * The room's record since `since`: decided questions where at least `minAnswers` members answered and
   * one side had a strict majority, and how often that majority was right.
   */
  roomRecord(guildId: string, since: number, minAnswers = 3): { right: number; total: number } {
    const rows = this.db
      .prepare(
        `SELECT q.answer AS answer, SUM(a.choice = 'a') AS a, SUM(a.choice = 'b') AS b
         FROM daily_questions q JOIN daily_answers a ON a.question_id = q.id
         WHERE q.guild_id = ? AND q.status = 'resolved' AND q.resolved_at >= ?
         GROUP BY q.id`,
      )
      .all(guildId, since) as { answer: Choice; a: number; b: number }[];
    let right = 0;
    let total = 0;
    for (const r of rows) {
      if (r.a + r.b < minAnswers || r.a === r.b) continue;
      total++;
      if ((r.a > r.b ? 'a' : 'b') === r.answer) right++;
    }
    return { right, total };
  }

  /** A member's Daily Question record in a server. */
  stats(guildId: string, userId: string, seasonStart = 0): DailyStats {
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS answered, COALESCE(SUM(a.correct), 0) AS rightCount, COALESCE(SUM(a.points), 0) AS points,
                COALESCE(SUM(CASE WHEN q.resolved_at >= :season THEN a.points ELSE 0 END), 0) AS seasonPoints
         FROM daily_answers a JOIN daily_questions q ON q.id = a.question_id
         WHERE q.guild_id = :guild AND a.user_id = :user AND q.status IN ('resolved', 'void')`,
      )
      .get({ guild: guildId, user: userId, season: seasonStart }) as {
      answered: number;
      rightCount: number;
      points: number;
      seasonPoints: number;
    };
    // Streak: walk back through the server's questions (newest first) while the member answered each one.
    const days = this.db
      .prepare(
        `SELECT q.id, (SELECT 1 FROM daily_answers a WHERE a.question_id = q.id AND a.user_id = ?) AS answered
         FROM daily_questions q WHERE q.guild_id = ? ORDER BY q.day DESC LIMIT 400`,
      )
      .all(userId, guildId) as { answered: number | null }[];
    let streak = 0;
    for (const [i, d] of days.entries()) {
      if (d.answered) streak++;
      else if (i > 0) break; // today's question may simply not be answered yet
    }
    return { answered: totals.answered, right: totals.rightCount, points: totals.points, seasonPoints: totals.seasonPoints, streak };
  }

  private parse(row: unknown): Question | undefined {
    if (!row) return undefined;
    const r = row as Row;
    return { ...r, spec: JSON.parse(r.spec) as QuestionSpec, startPrices: r.startPrices ? JSON.parse(r.startPrices) : null };
  }
}
