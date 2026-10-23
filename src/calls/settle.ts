import { log } from '../log.js';
import type { Candle } from './prices.js';
import type { Board, Call, Position } from './store.js';

const MINUTE = 60_000;
const PAGE = 1000; // Binance's maximum candles per request

export type Evaluation =
  | { done: false; checkedUntil: number }
  | { done: true; won: boolean; price: number; at: number };

export interface Settlement {
  call: Call;
  positions: Position[];
  won: boolean;
  /** The extreme that hit the target (touch), or the price at the deadline. */
  price: number;
  /** When the target was reached, or the deadline. */
  at: number;
}

export interface CandleSource {
  candles(symbol: string, interval: '1m', range: { startTime?: number; limit?: number }): Promise<Candle[]>;
}

/**
 * Decides a call from minute candles. Only candles that have closed, start at or after the call's
 * `checkedUntil` and start before its deadline count. Touch calls win on the first candle whose high
 * (or low) reaches the target; otherwise a call is decided once the candle ending at the deadline is in.
 */
export function evaluate(
  call: Pick<Call, 'direction' | 'kind' | 'target' | 'deadline' | 'checkedUntil'>,
  candles: Candle[],
  now: number,
): Evaluation {
  const from = call.checkedUntil ?? 0;
  const closed = candles
    .filter((c) => c.openTime >= from && c.openTime < call.deadline && c.openTime + MINUTE <= now)
    .sort((a, b) => a.openTime - b.openTime);

  if (call.kind === 'touch') {
    for (const c of closed) {
      const extreme = call.direction === 'above' ? c.high : c.low;
      const hit = call.direction === 'above' ? extreme >= call.target : extreme <= call.target;
      if (hit) return { done: true, won: true, price: extreme, at: c.openTime };
    }
  }

  const last = closed.at(-1);
  const checkedUntil = last ? last.openTime + MINUTE : from;
  if (!last || checkedUntil < call.deadline) return { done: false, checkedUntil };
  if (call.kind === 'touch') return { done: true, won: false, price: last.close, at: call.deadline };
  const won = call.direction === 'above' ? last.close >= call.target : last.close <= call.target;
  return { done: true, won, price: last.close, at: call.deadline };
}

/** Checks open calls against fresh candles once a minute and settles the ones that are decided. */
export class Settler {
  private running = false;

  constructor(
    private readonly board: Board,
    private readonly feed: CandleSource,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns the calls settled by this check. Skips a run if the previous one is still going. */
  async tick(): Promise<Settlement[]> {
    if (this.running) return [];
    this.running = true;
    try {
      const now = this.now();
      // Close calls only need the candle at their deadline, so they wait until it has closed.
      const due = this.board.openCalls().filter((c) => c.kind === 'touch' || now >= c.deadline);
      const settled: Settlement[] = [];
      for (const [symbol, calls] of groupBy(due, (c) => c.symbol)) {
        try {
          const from = Math.min(...calls.map((c) => startOf(c)));
          const candles = await this.minuteCandles(symbol, from, now);
          for (const call of calls) {
            const result = evaluate({ ...call, checkedUntil: startOf(call) }, candles, now);
            if (!result.done) {
              this.board.markChecked(call.id, result.checkedUntil);
              continue;
            }
            const positions = this.board.settle(call.id, result, now);
            if (positions) settled.push({ call: this.board.get(call.id)!, positions, ...result });
          }
        } catch (err) {
          log.warn(`Settlement check for ${symbol} failed; will retry next minute`, err);
        }
      }
      return settled;
    } finally {
      this.running = false;
    }
  }

  /**
   * Whether a touch call has reached its target since its last check, including the current,
   * unfinished minute. Used before letting anyone join, so nobody backs a call that already hit.
   */
  async reachedSinceCheck(call: Call): Promise<boolean> {
    if (call.kind !== 'touch') return false;
    const candles = await this.minuteCandles(call.symbol, call.checkedUntil ?? call.lockedAt ?? 0, this.now());
    return candles.some((c) => (call.direction === 'above' ? c.high >= call.target : c.low <= call.target));
  }

  /** Minute candles from `from` up to `until`, at most 5 pages (~3.5 days); the rest comes next tick. */
  private async minuteCandles(symbol: string, from: number, until: number): Promise<Candle[]> {
    const out: Candle[] = [];
    for (let start = from, page = 0; start <= until && page < 5; page++) {
      const batch = await this.feed.candles(symbol, '1m', { startTime: start, limit: PAGE });
      out.push(...batch);
      if (batch.length < PAGE) break;
      start = batch.at(-1)!.openTime + MINUTE;
    }
    return out;
  }
}

/** Where checking resumes for a call. Close calls skip straight to the candle that ends at the deadline. */
function startOf(call: Call): number {
  const checked = call.checkedUntil ?? call.lockedAt ?? call.createdAt;
  return call.kind === 'close' ? Math.max(checked, call.deadline - MINUTE) : checked;
}

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    groups.set(k, [...(groups.get(k) ?? []), item]);
  }
  return groups;
}
