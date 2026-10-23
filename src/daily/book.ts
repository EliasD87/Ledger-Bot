import { type Board, type Call, type Standing, seasonStart } from '../calls/store.js';
import type { DailyStore, Question } from './store.js';

const HOUR = 60 * 60 * 1000;

/** The member side of Today's Page: how the room did, calls settled and due, the season's leaders. */
export interface PageBook {
  /** The last decided question (if decided in the last 48h), with how the room answered. */
  verdict: { q: Question; counts: { a: number; b: number }; roomRight: boolean | null } | null;
  roomSeason: { right: number; total: number };
  settled: Call[];
  due: Call[];
  leaders: Standing[];
}

/** Room verdicts count only when at least this many answered. */
export const ROOM_MIN_ANSWERS = 3;

export function buildBook(board: Board, daily: DailyStore, guildId: string, now: number): PageBook {
  const last = daily.lastResolved(guildId);
  let verdict: PageBook['verdict'] = null;
  if (last && last.status === 'resolved' && (last.resolvedAt ?? 0) >= now - 48 * HOUR) {
    const counts = daily.counts(last.id);
    const majority = counts.a === counts.b ? null : counts.a > counts.b ? 'a' : 'b';
    const roomRight = counts.a + counts.b >= ROOM_MIN_ANSWERS && majority ? majority === last.answer : null;
    verdict = { q: last, counts, roomRight };
  }
  return {
    verdict,
    roomSeason: daily.roomRecord(guildId, seasonStart(now), ROOM_MIN_ANSWERS),
    settled: board.settledSince(guildId, now - 24 * HOUR).slice(0, 5),
    due: board.dueBefore(guildId, now + 24 * HOUR).slice(0, 3),
    leaders: board.leaderboard(guildId, seasonStart(now)).slice(0, 3),
  };
}
