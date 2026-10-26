import { type Close, average, median, stdev } from './stats.js';

/**
 * FOMC decision days (the second day of each meeting, when the statement comes out), from the Fed's
 * published calendars. Add next year's when the Fed publishes it.
 */
export const FOMC_DECISIONS = [
  '2021-11-03', '2021-12-15',
  '2022-01-26', '2022-03-16', '2022-05-04', '2022-06-15', '2022-07-27', '2022-09-21', '2022-11-02', '2022-12-14',
  '2023-02-01', '2023-03-22', '2023-05-03', '2023-06-14', '2023-07-26', '2023-09-20', '2023-11-01', '2023-12-13',
  '2024-01-31', '2024-03-20', '2024-05-01', '2024-06-12', '2024-07-31', '2024-09-18', '2024-11-07', '2024-12-18',
  '2025-01-29', '2025-03-19', '2025-05-07', '2025-06-18', '2025-07-30', '2025-09-17', '2025-10-29', '2025-12-10',
  '2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17', '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09',
];

const DAY = 86_400_000;
const at = (date: string) => Date.parse(`${date}T00:00:00Z`);

/** The next FOMC decision on or after `now`, if the calendar has one. */
export function nextFomc(now: number): string | null {
  const today = new Date(now).toISOString().slice(0, 10);
  return FOMC_DECISIONS.find((d) => d >= today) ?? null;
}

export interface EventStudy {
  /** How many past events had data. */
  count: number;
  /** Average size of the move over the event window (up or down), as a fraction. */
  avgAbsMove: number;
  /** The same for an ordinary window of the same length, for comparison. */
  normalAbsMove: number;
  upShare: number;
  median: number;
  /** The most recent ones, newest last. */
  recent: { date: string; move: number }[];
}

/**
 * How an asset moved around past events: from the close before each event day to the close
 * `windowDays - 1` sessions after it (2 by default: the decision day and the next, which catches an
 * afternoon announcement on assets whose day closes earlier).
 */
export function eventReaction(closes: Close[], dates: string[], windowDays = 2): EventStudy | null {
  if (closes.length < 30) return null;
  const first = at(closes[0]!.date);
  const last = at(closes.at(-1)!.date);
  const moves: { date: string; move: number }[] = [];
  for (const date of dates) {
    const t = at(date);
    if (t <= first || t > last) continue;
    const i = closes.findIndex((c) => at(c.date) >= t);
    // The event day must have traded (within 3 days, for weekends and holidays) and have a close before it.
    if (i < 1 || at(closes[i]!.date) - t > 3 * DAY) continue;
    const end = Math.min(closes.length - 1, i + windowDays - 1);
    if (end === closes.length - 1 && end < i + windowDays - 1) continue; // still unfolding
    moves.push({ date, move: closes[end]!.close / closes[i - 1]!.close - 1 });
  }
  if (moves.length < 4) return null;
  const normal: number[] = [];
  for (let j = windowDays; j < closes.length; j++) normal.push(Math.abs(closes[j]!.close / closes[j - windowDays]!.close - 1));
  return {
    count: moves.length,
    avgAbsMove: average(moves.map((m) => Math.abs(m.move))),
    normalAbsMove: average(normal),
    upShare: moves.filter((m) => m.move > 0).length / moves.length,
    median: median(moves.map((m) => m.move)),
    recent: moves.slice(-4),
  };
}

export interface BigMove {
  date: string;
  move: number;
  /** The move in standard deviations of a normal day over the prior year. */
  sigma: number;
}

/** The biggest daily moves of the last `days` calendar days, by size against the asset's own normal day. */
export function bigMoves(closes: Close[], days = 90, n = 4): BigMove[] {
  if (closes.length < 60) return [];
  const cutoff = at(closes.at(-1)!.date) - days * DAY;
  const returns = closes.slice(1).map((c, i) => ({ date: c.date, move: c.close / closes[i]!.close - 1 }));
  const year = returns.slice(-260).map((r) => r.move);
  const sd = stdev(year);
  if (!sd) return [];
  return returns
    .filter((r) => at(r.date) > cutoff)
    .map((r) => ({ ...r, sigma: r.move / sd }))
    .sort((a, b) => Math.abs(b.sigma) - Math.abs(a.sigma))
    .slice(0, n)
    .filter((r) => Math.abs(r.sigma) >= 1.5)
    .sort((a, b) => a.date.localeCompare(b.date));
}
