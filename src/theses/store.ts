import type { Fact } from '../analysis/evidence.js';
import type { Db } from '../db/index.js';
import type { Argument } from '../reasoning/stressTest.js';
import type { ThesisSpec } from './spec.js';

const DAY = 86_400_000;

export type ThesisStatus = 'draft' | 'open' | 'aged_well' | 'aged_badly' | 'void' | 'cancelled';
export type Side = 'with' | 'against';

export interface Analysis {
  assumptions: string[];
  argument: Argument;
  facts: Fact[];
  sources: string[];
}

export interface Thesis {
  id: number;
  guildId: string;
  channelId: string;
  messageId: string | null;
  authorId: string;
  take: string;
  claim: string;
  spec: ThesisSpec;
  analysis: Analysis;
  status: ThesisStatus;
  startValue: number | null;
  startAt: number | null;
  checkAt: number | null;
  endValue: number | null;
  settledAt: number | null;
  note: string | null;
  createdAt: number;
}

export interface Sides {
  with: string[];
  against: string[];
}

export interface Record {
  logged: number;
  agedWell: number;
  agedBadly: number;
  open: number;
  /** Aged well while more members were against than with. */
  contrarianWins: number;
  /** Sides taken on other members' theses that were settled, and how many read it right. */
  sidesRight: number;
  sidesSettled: number;
  /** The settled thesis that aged best, by margin. */
  best: Thesis | null;
}

/** The thesis columns, optionally prefixed with a table alias. */
const columns = (t = '') =>
  `${t}id AS id, ${t}guild_id AS guildId, ${t}channel_id AS channelId, ${t}message_id AS messageId, ${t}author_id AS authorId, ` +
  `${t}take AS take, ${t}claim AS claim, ${t}spec AS spec, ${t}analysis AS analysis, ${t}status AS status, ${t}start_value AS startValue, ` +
  `${t}start_at AS startAt, ${t}check_at AS checkAt, ${t}end_value AS endValue, ${t}settled_at AS settledAt, ${t}note AS note, ${t}created_at AS createdAt`;
const COLUMNS = columns();

function parse(row: unknown): Thesis | undefined {
  if (!row) return undefined;
  const r = row as Omit<Thesis, 'spec' | 'analysis'> & { spec: string; analysis: string };
  return { ...r, spec: JSON.parse(r.spec) as ThesisSpec, analysis: JSON.parse(r.analysis) as Analysis };
}

/** Theses and the sides members take on them. */
export class ThesisStore {
  constructor(private readonly db: Db) {}

  createDraft(d: { guildId: string; channelId: string; authorId: string; take: string; claim: string; spec: ThesisSpec; analysis: Analysis; now: number }): Thesis {
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO theses (guild_id, channel_id, author_id, take, claim, spec, analysis, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?)`,
      )
      .run(d.guildId, d.channelId, d.authorId, d.take, d.claim, JSON.stringify(d.spec), JSON.stringify(d.analysis), d.now);
    return this.get(Number(lastInsertRowid))!;
  }

  get(id: number): Thesis | undefined {
    return parse(this.db.prepare(`SELECT ${COLUMNS} FROM theses WHERE id = ?`).get(id));
  }

  attachMessage(id: number, channelId: string, messageId: string): void {
    this.db.prepare('UPDATE theses SET channel_id = ?, message_id = ? WHERE id = ?').run(channelId, messageId, id);
  }

  /** Puts a draft on the record, measured from now. False if it isn't a draft any more. */
  log(id: number, startValue: number, now: number): boolean {
    const t = this.get(id);
    if (!t || t.status !== 'draft') return false;
    return (
      this.db
        .prepare("UPDATE theses SET status = 'open', start_value = ?, start_at = ?, check_at = ? WHERE id = ? AND status = 'draft'")
        .run(startValue, now, now + t.spec.horizonDays * DAY, id).changes > 0
    );
  }

  cancel(id: number, note: string): boolean {
    return this.db.prepare("UPDATE theses SET status = 'cancelled', note = ? WHERE id = ? AND status = 'draft'").run(note, id).changes > 0;
  }

  void(id: number, note: string, now: number): boolean {
    return this.db.prepare("UPDATE theses SET status = 'void', note = ?, settled_at = ? WHERE id = ? AND status IN ('draft', 'open')").run(note, now, id).changes > 0;
  }

  settle(id: number, endValue: number, held: boolean, now: number): boolean {
    return (
      this.db
        .prepare("UPDATE theses SET status = ?, end_value = ?, settled_at = ? WHERE id = ? AND status = 'open'")
        .run(held ? 'aged_well' : 'aged_badly', endValue, now, id).changes > 0
    );
  }

  /** Open theses whose check-back time has come. */
  due(now: number): Thesis[] {
    return this.db.prepare(`SELECT ${COLUMNS} FROM theses WHERE status = 'open' AND check_at <= ? ORDER BY check_at`).all(now).map((r) => parse(r)!);
  }

  staleDrafts(before: number): Thesis[] {
    return this.db.prepare(`SELECT ${COLUMNS} FROM theses WHERE status = 'draft' AND created_at < ?`).all(before).map((r) => parse(r)!);
  }

  open(guildId: string): Thesis[] {
    return this.db.prepare(`SELECT ${COLUMNS} FROM theses WHERE guild_id = ? AND status = 'open' ORDER BY check_at`).all(guildId).map((r) => parse(r)!);
  }

  /** A member's theses: open ones and those settled since `since`, newest first. */
  byAuthor(guildId: string, authorId: string, since = 0): Thesis[] {
    return this.db
      .prepare(
        `SELECT ${COLUMNS} FROM theses WHERE guild_id = ? AND author_id = ?
         AND (status = 'open' OR (status IN ('aged_well', 'aged_badly') AND settled_at >= ?)) ORDER BY id DESC`,
      )
      .all(guildId, authorId, since)
      .map((r) => parse(r)!);
  }

  /** Other members' theses this member took a side on: open, or settled since `since`. */
  sidedBy(guildId: string, userId: string, since = 0): { thesis: Thesis; side: Side }[] {
    return this.db
      .prepare(
        `SELECT ${columns('t.')}, s.side AS side
         FROM thesis_sides s JOIN theses t ON t.id = s.thesis_id
         WHERE t.guild_id = ? AND s.user_id = ? AND (t.status = 'open' OR (t.status IN ('aged_well', 'aged_badly') AND t.settled_at >= ?))
         ORDER BY t.id DESC`,
      )
      .all(guildId, userId, since)
      .map((r) => ({ thesis: parse(r)!, side: (r as { side: Side }).side }));
  }

  /** Takes a side on someone else's open thesis, or switches it. */
  side(thesisId: number, userId: string, side: Side, now: number): 'ok' | 'switched' | 'same' | 'own' | 'closed' {
    const t = this.get(thesisId);
    if (!t || t.status !== 'open') return 'closed';
    if (t.authorId === userId) return 'own';
    const existing = this.db.prepare('SELECT side FROM thesis_sides WHERE thesis_id = ? AND user_id = ?').get(thesisId, userId) as { side: Side } | undefined;
    if (existing?.side === side) return 'same';
    this.db
      .prepare('INSERT INTO thesis_sides (thesis_id, user_id, side, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (thesis_id, user_id) DO UPDATE SET side = excluded.side, created_at = excluded.created_at')
      .run(thesisId, userId, side, now);
    return existing ? 'switched' : 'ok';
  }

  sides(thesisId: number): Sides {
    const rows = this.db.prepare('SELECT user_id AS userId, side FROM thesis_sides WHERE thesis_id = ? ORDER BY created_at').all(thesisId) as { userId: string; side: Side }[];
    return { with: rows.filter((r) => r.side === 'with').map((r) => r.userId), against: rows.filter((r) => r.side === 'against').map((r) => r.userId) };
  }

  record(guildId: string, userId: string, since = 0): Record {
    const own = this.db
      .prepare(`SELECT ${COLUMNS} FROM theses WHERE guild_id = ? AND author_id = ? AND status IN ('open', 'aged_well', 'aged_badly') AND COALESCE(settled_at, start_at) >= ?`)
      .all(guildId, userId, since)
      .map((r) => parse(r)!);
    const settled = own.filter((t) => t.status === 'aged_well' || t.status === 'aged_badly');
    const contrarianWins = settled.filter((t) => {
      if (t.status !== 'aged_well') return false;
      const s = this.sides(t.id);
      return s.against.length > s.with.length;
    }).length;
    const sided = this.db
      .prepare(
        `SELECT s.side, t.status FROM thesis_sides s JOIN theses t ON t.id = s.thesis_id
         WHERE t.guild_id = ? AND s.user_id = ? AND t.status IN ('aged_well', 'aged_badly') AND t.settled_at >= ?`,
      )
      .all(guildId, userId, since) as { side: Side; status: ThesisStatus }[];
    const best =
      settled
        .filter((t) => t.status === 'aged_well')
        .sort((a, b) => margin(b) - margin(a))[0] ?? null;
    return {
      logged: own.length,
      agedWell: settled.filter((t) => t.status === 'aged_well').length,
      agedBadly: settled.filter((t) => t.status === 'aged_badly').length,
      open: own.filter((t) => t.status === 'open').length,
      contrarianWins,
      sidesRight: sided.filter((s) => (s.side === 'with') === (s.status === 'aged_well')).length,
      sidesSettled: sided.length,
      best,
    };
  }

  /** Members with at least `min` settled theses, best record first. */
  leaders(guildId: string, since: number, min = 1): { userId: string; agedWell: number; settled: number }[] {
    return this.db
      .prepare(
        `SELECT author_id AS userId, SUM(status = 'aged_well') AS agedWell, COUNT(*) AS settled FROM theses
         WHERE guild_id = ? AND status IN ('aged_well', 'aged_badly') AND settled_at >= ?
         GROUP BY author_id HAVING COUNT(*) >= ? ORDER BY agedWell DESC, CAST(SUM(status = 'aged_well') AS REAL) / COUNT(*) DESC, settled DESC LIMIT 10`,
      )
      .all(guildId, since, min) as { userId: string; agedWell: number; settled: number }[];
  }
}

/** How far past the line a settled thesis finished, for picking someone's best take. */
export function margin(t: Thesis): number {
  if (t.startValue === null || t.endValue === null) return 0;
  if (t.spec.kind === 'price') return Math.abs(t.endValue / t.spec.target! - 1);
  if (t.spec.kind === 'flows') return Math.abs(t.endValue) / 1e9;
  return Math.abs(t.endValue / t.startValue - 1);
}
