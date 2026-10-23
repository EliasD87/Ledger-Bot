import type { Db } from '../db/index.js';

export type AlertKind = 'price' | 'move' | 'day-move' | 'etf-flow' | 'macro' | 'treasury';

export interface Alert {
  id: number;
  guildId: string;
  channelId: string;
  userId: string;
  kind: AlertKind;
  asset: string | null;
  direction: 'above' | 'below' | null;
  target: number | null;
  refPrice: number | null;
  repeat: boolean;
  status: 'active' | 'fired' | 'cancelled';
  createdAt: number;
  firedAt: number | null;
}

export type NewAlert = Pick<Alert, 'guildId' | 'channelId' | 'userId' | 'kind'> &
  Partial<Pick<Alert, 'asset' | 'direction' | 'target' | 'refPrice' | 'repeat'>>;

const COLUMNS = `id, guild_id AS guildId, channel_id AS channelId, user_id AS userId, kind, asset, direction, target,
  ref_price AS refPrice, repeat, status, created_at AS createdAt, fired_at AS firedAt`;

/** Members' alerts, events already announced, and each server's alerts channel. */
export class AlertStore {
  constructor(private readonly db: Db) {}

  create(a: NewAlert, now: number): Alert {
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO alerts (guild_id, channel_id, user_id, kind, asset, direction, target, ref_price, repeat, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      )
      .run(a.guildId, a.channelId, a.userId, a.kind, a.asset ?? null, a.direction ?? null, a.target ?? null, a.refPrice ?? null, a.repeat ? 1 : 0, now);
    return this.get(Number(lastInsertRowid))!;
  }

  get(id: number): Alert | undefined {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM alerts WHERE id = ?`).get(id);
    return row ? parse(row) : undefined;
  }

  active(kind?: AlertKind): Alert[] {
    const rows = kind
      ? this.db.prepare(`SELECT ${COLUMNS} FROM alerts WHERE status = 'active' AND kind = ? ORDER BY id`).all(kind)
      : this.db.prepare(`SELECT ${COLUMNS} FROM alerts WHERE status = 'active' ORDER BY id`).all();
    return rows.map(parse);
  }

  /** A member's alerts that fired since `since` (including repeating ones that are still active). */
  firedSince(guildId: string, userId: string, since: number): Alert[] {
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM alerts WHERE guild_id = ? AND user_id = ? AND fired_at >= ? ORDER BY fired_at DESC`)
      .all(guildId, userId, since)
      .map(parse);
  }

  forUser(guildId: string, userId: string): Alert[] {
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM alerts WHERE status = 'active' AND guild_id = ? AND user_id = ? ORDER BY id`)
      .all(guildId, userId)
      .map(parse);
  }

  /** Only the member who set an alert can cancel it. */
  cancel(id: number, userId: string): boolean {
    return this.db.prepare("UPDATE alerts SET status = 'cancelled' WHERE id = ? AND user_id = ? AND status = 'active'").run(id, userId).changes > 0;
  }

  /** Marks an alert as having fired. One-shot alerts stop; repeating ones stay active. */
  fire(id: number, now: number): void {
    this.db
      .prepare("UPDATE alerts SET fired_at = ?, status = CASE WHEN repeat = 1 THEN 'active' ELSE 'fired' END WHERE id = ?")
      .run(now, id);
  }

  // --- announced events ---

  seen(key: string): boolean {
    return this.db.prepare('SELECT 1 FROM seen_events WHERE key = ?').get(key) !== undefined;
  }

  /** Records an event as announced. Returns false if it already was. */
  markSeen(key: string, now: number): boolean {
    return this.db.prepare('INSERT OR IGNORE INTO seen_events (key, seen_at) VALUES (?, ?)').run(key, now).changes > 0;
  }

  /** Whether anything with this key prefix was ever seen; false means the stream is new and should be primed silently. */
  anySeen(prefix: string): boolean {
    return this.db.prepare("SELECT 1 FROM seen_events WHERE key LIKE ? ESCAPE '\\'").get(`${prefix.replace(/[\\%_]/g, '\\$&')}%`) !== undefined;
  }

  // --- server alerts channel ---

  setChannel(guildId: string, channelId: string | null, now: number): void {
    this.db
      .prepare(
        `INSERT INTO guild_settings (guild_id, alerts_channel_id, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (guild_id) DO UPDATE SET alerts_channel_id = excluded.alerts_channel_id, updated_at = excluded.updated_at`,
      )
      .run(guildId, channelId, now);
  }

  channels(): { guildId: string; channelId: string }[] {
    return this.db
      .prepare('SELECT guild_id AS guildId, alerts_channel_id AS channelId FROM guild_settings WHERE alerts_channel_id IS NOT NULL')
      .all() as unknown as { guildId: string; channelId: string }[];
  }
}

function parse(row: unknown): Alert {
  const r = row as Omit<Alert, 'repeat'> & { repeat: number };
  return { ...r, repeat: r.repeat === 1 };
}
