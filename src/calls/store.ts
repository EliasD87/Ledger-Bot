import type { Db } from '../db/index.js';
import type { CallKind, Direction, Side } from './odds.js';

export type CallStatus = 'draft' | 'open' | 'won' | 'lost' | 'void' | 'cancelled';
export type Result = 'won' | 'lost' | 'void';

export interface Call {
  id: number;
  guildId: string;
  channelId: string;
  messageId: string | null;
  callerId: string;
  symbol: string;
  base: string;
  direction: Direction;
  kind: CallKind;
  target: number;
  deadline: number;
  status: CallStatus;
  createdAt: number;
  entryPrice: number;
  chance: number;
  payout: number;
  lockedAt: number | null;
  checkedUntil: number | null;
  settledAt: number | null;
  settlePrice: number | null;
  settleTime: number | null;
  note: string | null;
}

export interface Position {
  id: number;
  callId: number;
  userId: string;
  side: Side;
  stake: number;
  chance: number;
  payout: number;
  createdAt: number;
  result: Result | null;
  pnl: number | null;
  settledAt: number | null;
}

export interface Terms {
  stake: number;
  chance: number;
  payout: number;
}

export interface Standing {
  userId: string;
  name: string;
  /** Rep: callPoints + dailyPoints. */
  points: number;
  wins: number;
  losses: number;
  callPoints: number;
  dailyPoints: number;
}

export interface Receipts {
  userId: string;
  name: string;
  season: { points: number; wins: number; losses: number };
  lifetime: { points: number; wins: number; losses: number };
  callsMade: { open: number; won: number; lost: number };
  biggestHit: { call: Call; points: number } | null;
  /** Last 10 settled results of their own calls, newest first. */
  recent: ('won' | 'lost')[];
  /** Calls they made or agreed/disagreed with that are still open. */
  open: { call: Call; side: Side }[];
  /** Agreeing or disagreeing with other members' calls: recorded right or wrong, worth no points. */
  leans: { right: number; wrong: number; open: number };
}

const MINUTE = 60_000;

const CALL_COLUMNS = `
  id, guild_id AS guildId, channel_id AS channelId, message_id AS messageId, caller_id AS callerId,
  symbol, base, direction, kind, target, deadline, status, created_at AS createdAt,
  entry_price AS entryPrice, chance, payout, locked_at AS lockedAt, checked_until AS checkedUntil,
  settled_at AS settledAt, settle_price AS settlePrice, settle_time AS settleTime, note`;

/** Position columns, optionally qualified with a table alias like "p.". */
const positionColumns = (t = '') => `
  ${t}id, ${t}call_id AS callId, ${t}user_id AS userId, ${t}side, ${t}stake, ${t}chance, ${t}payout,
  ${t}created_at AS createdAt, ${t}result, ${t}pnl, ${t}settled_at AS settledAt`;
const POSITION_COLUMNS = positionColumns();

/** Everything on the books: calls, positions, standings. All writes that must agree run in a transaction. */
export class Board {
  constructor(private readonly db: Db) {}

  // --- members ---

  /** Records the name a member currently goes by, for receipts and leaderboards. */
  remember(userId: string, name: string, now = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO members (user_id, name, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
      )
      .run(userId, name, now);
  }

  nameOf(userId: string): string {
    const row = this.db.prepare('SELECT name FROM members WHERE user_id = ?').get(userId) as { name: string } | undefined;
    return row?.name ?? 'someone';
  }

  /** Finds a member by display name: exact match first, then prefix. Ignores case and a leading @. */
  findMember(name: string): string | undefined {
    const clean = name.trim().replace(/^@/, '').toLowerCase();
    if (!clean) return undefined;
    const exact = this.db.prepare('SELECT user_id FROM members WHERE lower(name) = ? ORDER BY updated_at DESC').get(clean);
    const row =
      exact ??
      this.db
        .prepare("SELECT user_id FROM members WHERE lower(name) LIKE ? ESCAPE '\\' ORDER BY updated_at DESC")
        .get(`${clean.replace(/[\\%_]/g, '\\$&')}%`);
    return (row as { user_id: string } | undefined)?.user_id;
  }

  // --- calls ---

  createDraft(d: {
    guildId: string;
    channelId: string;
    callerId: string;
    symbol: string;
    base: string;
    direction: Direction;
    kind: CallKind;
    target: number;
    deadline: number;
    entryPrice: number;
    chance: number;
    payout: number;
    now: number;
  }): Call {
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO calls (guild_id, channel_id, caller_id, symbol, base, direction, kind, target, deadline, status,
                            created_at, entry_price, chance, payout)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
      )
      .run(d.guildId, d.channelId, d.callerId, d.symbol, d.base, d.direction, d.kind, d.target, d.deadline, d.now,
        d.entryPrice, d.chance, d.payout);
    return this.get(Number(lastInsertRowid))!;
  }

  get(id: number): Call | undefined {
    return this.db.prepare(`SELECT ${CALL_COLUMNS} FROM calls WHERE id = ?`).get(id) as Call | undefined;
  }

  attachMessage(id: number, channelId: string, messageId: string): void {
    this.db.prepare('UPDATE calls SET channel_id = ?, message_id = ? WHERE id = ?').run(channelId, messageId, id);
  }

  /** Locks a draft at fresh terms and gives the caller their position. False if it wasn't a draft any more. */
  lock(id: number, entryPrice: number, terms: Terms, now: number): boolean {
    return this.transaction(() => {
      const { changes } = this.db
        .prepare(
          `UPDATE calls SET status = 'open', entry_price = ?, chance = ?, payout = ?, locked_at = ?, checked_until = ?
           WHERE id = ? AND status = 'draft'`,
        )
        .run(entryPrice, terms.chance, terms.payout, now, ceilMinute(now), id);
      if (changes === 0) return false;
      const call = this.get(id)!;
      this.insertPosition(id, call.callerId, 'back', terms, now);
      return true;
    });
  }

  /** Cancels a draft. False if it wasn't a draft any more. */
  cancel(id: number, note: string): boolean {
    const { changes } = this.db
      .prepare("UPDATE calls SET status = 'cancelled', note = ? WHERE id = ? AND status = 'draft'")
      .run(note, id);
    return changes > 0;
  }

  /** Drafts created before `before`, which are now too stale to lock. */
  staleDrafts(before: number): Call[] {
    return this.db.prepare(`SELECT ${CALL_COLUMNS} FROM calls WHERE status = 'draft' AND created_at < ?`).all(before) as unknown as Call[];
  }

  /** Open calls, soonest deadline first; all servers unless one is given. */
  openCalls(guildId?: string): Call[] {
    const sql = `SELECT ${CALL_COLUMNS} FROM calls WHERE status = 'open' ${guildId ? 'AND guild_id = ?' : ''} ORDER BY deadline`;
    return this.db.prepare(sql).all(...(guildId ? [guildId] : [])) as unknown as Call[];
  }

  markChecked(id: number, until: number): void {
    this.db.prepare('UPDATE calls SET checked_until = ? WHERE id = ? AND status = ?').run(until, id, 'open');
  }

  // --- positions ---

  /** Adds a member to an open call. */
  join(callId: number, userId: string, side: Side, terms: Terms, now: number): 'ok' | 'already-in' | 'closed' {
    return this.transaction(() => {
      if (this.get(callId)?.status !== 'open') return 'closed';
      if (this.positionOf(callId, userId)) return 'already-in';
      this.insertPosition(callId, userId, side, terms, now);
      return 'ok';
    });
  }

  positionOf(callId: number, userId: string): Position | undefined {
    return this.db
      .prepare(`SELECT ${POSITION_COLUMNS} FROM positions WHERE call_id = ? AND user_id = ?`)
      .get(callId, userId) as Position | undefined;
  }

  positions(callId: number): Position[] {
    return this.db
      .prepare(`SELECT ${POSITION_COLUMNS} FROM positions WHERE call_id = ? ORDER BY created_at`)
      .all(callId) as unknown as Position[];
  }

  // --- settlement ---

  /**
   * Settles an open call and pays out every position: backers win if the call came true, faders if not.
   * Returns the settled positions, or null if the call was no longer open.
   */
  settle(id: number, outcome: { won: boolean; price: number; at: number }, now: number): Position[] | null {
    return this.transaction(() => {
      const { changes } = this.db
        .prepare(
          `UPDATE calls SET status = ?, settled_at = ?, settle_price = ?, settle_time = ?
           WHERE id = ? AND status = 'open'`,
        )
        .run(outcome.won ? 'won' : 'lost', now, outcome.price, outcome.at, id);
      if (changes === 0) return null;
      const pay = this.db.prepare('UPDATE positions SET result = ?, pnl = ?, settled_at = ? WHERE id = ?');
      for (const p of this.positions(id)) {
        const right = (p.side === 'back') === outcome.won;
        pay.run(right ? 'won' : 'lost', right ? p.payout : -p.stake, now, p.id);
      }
      return this.positions(id);
    });
  }

  /** Voids a call (open or already settled): every position goes back to zero. False if there was nothing to void. */
  void(id: number, note: string, now: number): boolean {
    return this.transaction(() => {
      const { changes } = this.db
        .prepare("UPDATE calls SET status = 'void', note = ?, settled_at = ? WHERE id = ? AND status IN ('open', 'won', 'lost')")
        .run(note, now, id);
      if (changes === 0) return false;
      this.db.prepare("UPDATE positions SET result = 'void', pnl = 0, settled_at = ? WHERE call_id = ?").run(now, id);
      return true;
    });
  }

  // --- standings ---

  /**
   * Standings since `since`, best first. Rep = the member's own call scores plus Daily Question points;
   * agreeing or disagreeing with someone else's call moves nothing. Wins and losses count own calls only.
   */
  leaderboard(guildId: string, since: number): Standing[] {
    return this.db
      .prepare(
        `SELECT x.user_id AS userId, COALESCE(m.name, 'someone') AS name, SUM(x.points) AS points,
                SUM(x.wins) AS wins, SUM(x.losses) AS losses, SUM(x.call_points) AS callPoints, SUM(x.daily_points) AS dailyPoints
         FROM (
           SELECT p.user_id, p.pnl AS points, (p.result = 'won') AS wins, (p.result = 'lost') AS losses,
                  p.pnl AS call_points, 0 AS daily_points
           FROM positions p JOIN calls c ON c.id = p.call_id
           WHERE c.guild_id = :guild AND p.user_id = c.caller_id AND p.result IN ('won', 'lost') AND p.settled_at >= :since
           UNION ALL
           SELECT a.user_id, a.points, 0, 0, 0, a.points
           FROM daily_answers a JOIN daily_questions q ON q.id = a.question_id
           WHERE q.guild_id = :guild AND q.status = 'resolved' AND q.resolved_at >= :since
         ) x
         LEFT JOIN members m ON m.user_id = x.user_id
         GROUP BY x.user_id
         ORDER BY points DESC, wins DESC, losses ASC`,
      )
      .all({ guild: guildId, since }) as unknown as Standing[];
  }

  receipts(guildId: string, userId: string, seasonStart: number): Receipts {
    const rows = this.db
      .prepare(
        `SELECT ${positionColumns('p.')}
         FROM positions p JOIN calls c ON c.id = p.call_id
         WHERE c.guild_id = ? AND p.user_id = ?
         ORDER BY COALESCE(p.settled_at, p.created_at) DESC`,
      )
      .all(guildId, userId) as unknown as Position[];
    const isCaller = (p: Position) => this.get(p.callId)?.callerId === userId;
    const leanRows = rows.filter((p) => !isCaller(p));
    const leans = {
      right: leanRows.filter((p) => p.result === 'won').length,
      wrong: leanRows.filter((p) => p.result === 'lost').length,
      open: leanRows.filter((p) => p.result === null).length,
    };
    const settled = rows.filter((p) => isCaller(p) && (p.result === 'won' || p.result === 'lost'));
    const tally = (list: Position[]) => ({
      points: list.reduce((sum, p) => sum + (p.pnl ?? 0), 0),
      wins: list.filter((p) => p.result === 'won').length,
      losses: list.filter((p) => p.result === 'lost').length,
    });
    const best = settled.filter((p) => p.result === 'won').sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0))[0];
    const made = this.db
      .prepare("SELECT status, COUNT(*) AS n FROM calls WHERE guild_id = ? AND caller_id = ? AND status IN ('open', 'won', 'lost') GROUP BY status")
      .all(guildId, userId) as { status: 'open' | 'won' | 'lost'; n: number }[];
    const callsMade = { open: 0, won: 0, lost: 0 };
    for (const { status, n } of made) callsMade[status] = n;
    return {
      userId,
      name: this.nameOf(userId),
      season: tally(settled.filter((p) => (p.settledAt ?? 0) >= seasonStart)),
      lifetime: tally(settled),
      callsMade,
      biggestHit: best ? { call: this.get(best.callId)!, points: best.pnl ?? 0 } : null,
      recent: settled.slice(0, 10).map((p) => p.result as 'won' | 'lost'),
      open: rows.filter((p) => p.result === null).map((p) => ({ call: this.get(p.callId)!, side: p.side })),
      leans,
    };
  }

  /** A member's positions (own calls and agree/disagree) that resolved since `since`, newest first. */
  resultsSince(guildId: string, userId: string, since: number): { call: Call; position: Position }[] {
    const rows = this.db
      .prepare(
        `SELECT ${positionColumns('p.')} FROM positions p JOIN calls c ON c.id = p.call_id
         WHERE c.guild_id = ? AND p.user_id = ? AND p.result IN ('won', 'lost') AND p.settled_at >= ?
         ORDER BY p.settled_at DESC`,
      )
      .all(guildId, userId, since) as unknown as Position[];
    return rows.map((position) => ({ call: this.get(position.callId)!, position }));
  }

  /** Calls in a server that resolved since `since` (right or wrong), newest first. */
  settledSince(guildId: string, since: number): Call[] {
    return this.db
      .prepare(`SELECT ${CALL_COLUMNS} FROM calls WHERE guild_id = ? AND status IN ('won', 'lost') AND settled_at >= ? ORDER BY settled_at DESC`)
      .all(guildId, since) as unknown as Call[];
  }

  /** Open calls in a server whose deadline falls before `until`, soonest first. */
  dueBefore(guildId: string, until: number): Call[] {
    return this.db
      .prepare(`SELECT ${CALL_COLUMNS} FROM calls WHERE guild_id = ? AND status = 'open' AND deadline <= ? ORDER BY deadline`)
      .all(guildId, until) as unknown as Call[];
  }

  /** Link to a call's card, or null if it was never posted. */
  static link(call: Call): string | null {
    return call.messageId ? `https://discord.com/channels/${call.guildId}/${call.channelId}/${call.messageId}` : null;
  }

  /** Board activity since `since`, for /ledger-admin stats. */
  activity(since: number): { locked: number; positions: number; settled: number } {
    return this.db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM calls WHERE locked_at >= :since) AS locked,
                (SELECT COUNT(*) FROM positions WHERE created_at >= :since) AS positions,
                (SELECT COUNT(*) FROM calls WHERE status IN ('won', 'lost') AND settled_at >= :since) AS settled`,
      )
      .get({ since }) as unknown as { locked: number; positions: number; settled: number };
  }

  private insertPosition(callId: number, userId: string, side: Side, terms: Terms, now: number): void {
    this.db
      .prepare('INSERT INTO positions (call_id, user_id, side, stake, chance, payout, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(callId, userId, side, terms.stake, terms.chance, terms.payout, now);
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}

export function ceilMinute(ms: number): number {
  return Math.ceil(ms / MINUTE) * MINUTE;
}

/** Seasons are calendar months, UTC. */
export function seasonStart(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}
