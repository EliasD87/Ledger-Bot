import type { Db } from './db/index.js';

/** Display names of members Ledger has seen, so records and lookups can use names. */
export class Members {
  constructor(private readonly db: Db) {}

  remember(userId: string, name: string): void {
    this.db
      .prepare('INSERT INTO members (user_id, name, updated_at) VALUES (?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at')
      .run(userId, name, Date.now());
  }

  nameOf(userId: string): string {
    const row = this.db.prepare('SELECT name FROM members WHERE user_id = ?').get(userId) as { name: string } | undefined;
    return row?.name ?? 'someone';
  }

  /** A member id from "kai", "@Kai", or the start of a name; exact matches first. */
  find(query: string): string | undefined {
    const q = query.trim().replace(/^@/, '').toLowerCase();
    if (!q || /[%_]/.test(q)) return undefined;
    const exact = this.db.prepare('SELECT user_id AS id FROM members WHERE lower(name) = ?').get(q) as { id: string } | undefined;
    if (exact) return exact.id;
    const prefix = this.db.prepare('SELECT user_id AS id FROM members WHERE lower(name) LIKE ? ORDER BY length(name) LIMIT 1').get(`${q}%`) as { id: string } | undefined;
    return prefix?.id;
  }
}
