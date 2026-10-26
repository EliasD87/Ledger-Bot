/**
 * Market maths on daily closes, oldest first. Pure functions: the language model never computes a
 * number; it reads what these return. Every function returns null when the history is too short.
 */

export interface Close {
  /** UTC calendar day, "2026-10-23". */
  date: string;
  close: number;
}

/** Change over the last `days` closes, as a fraction (0.05 = +5%). */
export function change(closes: Close[], days: number): number | null {
  const last = closes.at(-1);
  const then = closes.at(-1 - days);
  return last && then && then.close > 0 ? last.close / then.close - 1 : null;
}

/**
 * Change over `days` calendar days: from the last close on or before that date. Matches the charts for
 * assets that skip weekends (stocks, futures), where a bar count would land on a different day.
 */
export function changeOver(closes: Close[], days: number): number | null {
  const last = closes.at(-1);
  if (!last) return null;
  const cutoff = Date.parse(`${last.date}T00:00:00Z`) - days * 86_400_000;
  let then: Close | undefined;
  for (const c of closes) {
    if (Date.parse(`${c.date}T00:00:00Z`) > cutoff) break;
    then = c;
  }
  return then && then.close > 0 ? last.close / then.close - 1 : null;
}

export function average(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Simple moving average of the last `n` closes. */
export function sma(closes: Close[], n: number): number | null {
  return closes.length >= n ? average(closes.slice(-n).map((c) => c.close)) : null;
}

/** Day-over-day simple returns. */
export function dailyReturns(closes: Close[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) if (closes[i - 1]!.close > 0) out.push(closes[i]!.close / closes[i - 1]!.close - 1);
  return out;
}

export function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = average(values);
  return Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1));
}

/** Daily volatility (stdev of daily returns) over the last `n` days, and over the year for comparison. */
export function volatility(closes: Close[], n = 30): { now: number; year: number; ratio: number } | null {
  const returns = dailyReturns(closes);
  if (returns.length < n + 5) return null;
  const now = stdev(returns.slice(-n));
  const year = stdev(returns.slice(-365));
  return { now, year, ratio: year > 0 ? now / year : 1 };
}

/**
 * How unusual the latest day was: its move in standard deviations of the previous 90 days, and how
 * many days back you have to go to find a bigger one.
 */
export function latestMove(closes: Close[]): { move: number; sigma: number; biggestIn: number } | null {
  const returns = dailyReturns(closes);
  if (returns.length < 31) return null;
  const move = returns.at(-1)!;
  const sd = stdev(returns.slice(-91, -1));
  let biggestIn = 0;
  for (let i = returns.length - 2; i >= 0 && Math.abs(returns[i]!) <= Math.abs(move); i--) biggestIn++;
  return { move, sigma: sd > 0 ? move / sd : 0, biggestIn };
}

/** Where the last close sits in the range of the last `n` days. */
export function rangePosition(closes: Close[], n = 365): { high: number; low: number; fromHigh: number; fromLow: number; percentile: number } | null {
  if (closes.length < 20) return null;
  const window = closes.slice(-n).map((c) => c.close);
  const last = window.at(-1)!;
  const high = Math.max(...window);
  const low = Math.min(...window);
  return { high, low, fromHigh: last / high - 1, fromLow: last / low - 1, percentile: percentileOf(window, last) };
}

/** Share of `values` at or below `x`, 0..1. */
export function percentileOf(values: number[], x: number): number {
  return values.length ? values.filter((v) => v <= x).length / values.length : 0;
}

/** Worst peak-to-trough fall over the last `n` days, as a negative fraction. */
export function maxDrawdown(closes: Close[], n = 90): number | null {
  if (closes.length < 2) return null;
  let peak = -Infinity;
  let worst = 0;
  for (const { close } of closes.slice(-n)) {
    peak = Math.max(peak, close);
    worst = Math.min(worst, close / peak - 1);
  }
  return worst;
}

/** A over B, day by day, on the days both have a close (crypto trades weekends, stocks don't). */
export function ratio(a: Close[], b: Close[]): Close[] {
  const byDate = new Map(b.map((c) => [c.date, c.close]));
  return a.flatMap((c) => {
    const other = byDate.get(c.date);
    return other ? [{ date: c.date, close: c.close / other }] : [];
  });
}

/** Correlation of daily returns over the last `n` shared days. */
export function correlation(a: Close[], b: Close[], n = 90): number | null {
  const byDate = new Map(b.map((c) => [c.date, c.close]));
  const pairs = a.filter((c) => byDate.has(c.date)).map((c) => [c.close, byDate.get(c.date)!] as const).slice(-(n + 1));
  if (pairs.length < 20) return null;
  const ra: number[] = [];
  const rb: number[] = [];
  for (let i = 1; i < pairs.length; i++) {
    ra.push(pairs[i]![0] / pairs[i - 1]![0] - 1);
    rb.push(pairs[i]![1] / pairs[i - 1]![1] - 1);
  }
  const ma = average(ra);
  const mb = average(rb);
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < ra.length; i++) {
    cov += (ra[i]! - ma) * (rb[i]! - mb);
    va += (ra[i]! - ma) ** 2;
    vb += (rb[i]! - mb) ** 2;
  }
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : null;
}

export interface BaseRate {
  /** Windows where the condition held. */
  hits: number;
  /** Windows looked at. */
  windows: number;
  rate: number;
  /** Median change over the horizon across all windows. */
  median: number;
  since: string;
}

/**
 * How often a change over `horizon` days met `condition`, across every rolling window in the history.
 * E.g. "SOL rose 20% or more within 30 days in 14% of 30-day windows since Jan 2024".
 */
export function baseRate(closes: Close[], horizon: number, condition: (change: number) => boolean): BaseRate | null {
  const changes: number[] = [];
  for (let i = 0; i + horizon < closes.length; i++) changes.push(closes[i + horizon]!.close / closes[i]!.close - 1);
  if (changes.length < 30) return null;
  const hits = changes.filter(condition).length;
  return { hits, windows: changes.length, rate: hits / changes.length, median: median(changes), since: closes[0]!.date };
}

export interface Analogs {
  /** Past moments that looked like now. */
  count: number;
  /** Share of them that were higher `horizon` days later. */
  upShare: number;
  /** Median change over the following `horizon` days. */
  median: number;
  /** The setup that was matched, in words-ready numbers. */
  setup: { lookback: number; change: number; tolerance: number };
}

/**
 * Past days whose trailing `lookback`-day change was close to today's, at least `spacing` days apart,
 * and what happened over the next `horizon` days. A rough "when it looked like this before" check.
 */
export function analogs(closes: Close[], horizon: number, lookback = 30, spacing = 7): Analogs | null {
  const now = change(closes, lookback);
  if (now === null) return null;
  const tolerance = Math.max(0.03, Math.abs(now) * 0.25);
  const outcomes: number[] = [];
  let lastTaken = -Infinity;
  for (let i = lookback; i + horizon < closes.length - horizon; i++) {
    if (i - lastTaken < spacing) continue;
    const then = closes[i]!.close / closes[i - lookback]!.close - 1;
    if (Math.abs(then - now) > tolerance) continue;
    outcomes.push(closes[i + horizon]!.close / closes[i]!.close - 1);
    lastTaken = i;
  }
  if (outcomes.length < 5) return null;
  return { count: outcomes.length, upShare: outcomes.filter((o) => o > 0).length / outcomes.length, median: median(outcomes), setup: { lookback, change: now, tolerance } };
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
