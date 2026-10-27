import { LEDGER_ID, iso } from './rules.js';
import type { BoardRow, DayStore } from './store.js';

const monthName = (ms: number) => new Date(ms).toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' });

/** This month's leaderboard (or last month's, early on before anything has settled), or all time. */
export function leaderboard(days: DayStore, guildId: string, now: number, allTime = false): { title: string; rows: BoardRow[] } {
  if (allTime) return { title: 'All time', rows: days.board(guildId, '0000-00-00', '9999-12-31') };
  const d = new Date(now);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const rows = days.board(guildId, iso(start), iso(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)));
  if (rows.some((r) => r.userId !== LEDGER_ID) || d.getUTCDate() > 3) return { title: monthName(start), rows };
  const prev = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1);
  const last = days.board(guildId, iso(prev), iso(start));
  return last.some((r) => r.userId !== LEDGER_ID) ? { title: `${monthName(prev)} (final)`, rows: last } : { title: monthName(start), rows };
}

