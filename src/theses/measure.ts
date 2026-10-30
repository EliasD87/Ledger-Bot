import type { MarketHistory } from '../analysis/history.js';
import type { Desk } from '../desk/desk.js';
import type { CryptoQuotes, StockQuotes } from '../quotes.js';
import type { ThesisSpec } from './spec.js';
import { held, reached, touchLevel } from './spec.js';
import type { Thesis, ThesisStore } from './store.js';

const DAY = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Reads a thesis's measure from live prices (with backups) or the stored ETF flows. */
export class Measure {
  constructor(
    private readonly deps: { history: MarketHistory; crypto: Pick<CryptoQuotes, 'stats24h'>; stocks: Pick<StockQuotes, 'stockQuotes'>; desk: Desk | null },
  ) {}

  /** The latest price of a crypto or stock ticker, or null. */
  async price(symbol: string, kind?: 'crypto' | 'stock'): Promise<number | null> {
    const asset = await this.deps.history.identify(symbol, kind);
    if (!asset) return null;
    const value =
      asset.kind === 'crypto'
        ? (await this.deps.crypto.stats24h([asset.pair!]).catch(() => null))?.[asset.pair!]?.price
        : (await this.deps.stocks.stockQuotes([asset.symbol]).catch(() => null))?.[asset.symbol]?.last;
    // A blank or broken quote must never settle a thesis.
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
  }

  /** The measure now: price, ratio, or, for flows, net flows over the sessions since `since`. */
  async now(spec: ThesisSpec, since = 0): Promise<number | null> {
    if (spec.kind === 'flows') return (await this.flows(spec.asset, since, Infinity))?.sum ?? null;
    const a = await this.price(spec.asset, spec.assetKind);
    if (a === null) return null;
    if (spec.kind !== 'relative') return a;
    const b = await this.price(spec.versus!, spec.versusKind);
    return b ? a / b : null;
  }

  /** The highest high and lowest low of a take's asset between two moments (hourly candles), or null. */
  async range(spec: ThesisSpec, from: number, to: number): Promise<{ high: number; low: number } | null> {
    const asset = await this.deps.history.identify(spec.asset, spec.assetKind).catch(() => null);
    if (!asset || typeof this.deps.history.range !== 'function') return null;
    return this.deps.history.range(asset, from, to).catch(() => null);
  }

  /** Summed net flows for sessions dated from `from` up to (not including) `until`, and the latest session seen. */
  async flows(asset: string, from: number, until: number): Promise<{ sum: number; latest: string } | null> {
    const report = await this.deps.desk?.flows(asset).catch(() => null);
    if (!report) return null;
    const start = isoDay(from);
    const end = Number.isFinite(until) ? isoDay(until) : '9999-12-31';
    const sessions = report.days.filter((d) => d.date >= start && d.date < end && d.totalNetInflow !== null);
    return { sum: sessions.reduce((t, d) => t + d.totalNetInflow!, 0), latest: report.latest.date };
  }

  /** The measure at a thesis's check-back, or null if it can't be read yet (flows publish the next day). */
  async atCheck(t: Thesis, now: number): Promise<number | null> {
    if (t.spec.kind !== 'flows') return this.now(t.spec);
    const f = await this.flows(t.spec.asset, t.startAt!, t.checkAt!);
    if (!f) return null;
    // Wait for the last session inside the window to be published, or give up waiting after 3 days.
    const lastDay = isoDay(t.checkAt! - DAY);
    return f.latest >= lastDay || now > t.checkAt! + 3 * DAY ? f.sum : null;
  }
}

export interface Verdict {
  thesis: Thesis;
  endValue: number;
  held: boolean;
}

/**
 * Settles theses. A take that counts on touch (a price target or a % move) is right the moment the price
 * gets there inside its window: every 10 minutes the watcher reads the hourly highs and lows since its last
 * look and the live price, and settles it as soon as the level is touched. Everything else, and a touch take
 * that never got there, is settled at the check-back. Voids a take whose data never shows up.
 */
export class ThesisSettler {
  private running = false;
  private lastWatch = 0;

  constructor(
    private readonly deps: { store: ThesisStore; measure: Measure; now?: () => number },
  ) {}

  async tick(): Promise<{ settled: Verdict[]; voided: Thesis[] }> {
    if (this.running) return { settled: [], voided: [] };
    this.running = true;
    const settled: Verdict[] = [];
    const voided: Thesis[] = [];
    try {
      const now = (this.deps.now ?? Date.now)();
      if (now - this.lastWatch >= WATCH_EVERY) {
        this.lastWatch = now;
        settled.push(...(await this.watchTouches(now)));
      }
      for (const t of this.deps.store.due(now)) {
        // A touch take gets one last look at its whole window before it can age badly.
        const level = t.startValue !== null && t.spec.kind !== 'flows' ? touchLevel(t.spec, t.startValue) : null;
        if (level !== null) {
          const best = await this.furthest(t, t.checkAt!, false);
          if (best !== null && reached(t.spec, level, best)) {
            if (this.deps.store.settle(t.id, best, true, now)) settled.push({ thesis: this.deps.store.get(t.id)!, endValue: best, held: true });
            continue;
          }
        }
        const end = await this.deps.measure.atCheck(t, now).catch(() => null);
        if (end === null) {
          if (now > t.checkAt! + 5 * DAY && this.deps.store.void(t.id, 'no data at the check-back', now)) voided.push(t);
          continue;
        }
        const ok = level !== null ? false : held(t.spec, t.startValue ?? 0, end);
        if (this.deps.store.settle(t.id, end, ok, now)) settled.push({ thesis: this.deps.store.get(t.id)!, endValue: end, held: ok });
      }
      return { settled, voided };
    } finally {
      this.running = false;
    }
  }

  /** Open touch takes whose price got to their level since the last look: settled now, as aged well. */
  private async watchTouches(now: number): Promise<Verdict[]> {
    const out: Verdict[] = [];
    for (const t of this.deps.store.allOpen()) {
      if (t.startValue === null || t.startAt === null || t.spec.kind === 'flows') continue;
      const level = touchLevel(t.spec, t.startValue);
      if (level === null || (t.checkAt !== null && now >= t.checkAt)) continue;
      const best = await this.furthest(t, now, true);
      if (best !== null && reached(t.spec, level, best)) {
        if (this.deps.store.settle(t.id, best, true, now)) out.push({ thesis: this.deps.store.get(t.id)!, endValue: best, held: true });
      } else {
        this.deps.store.markWatched(t.id, best, now);
      }
    }
    return out;
  }

  /**
   * The furthest the price got in the take's direction from logging up to `until`: what was seen before,
   * the hourly highs or lows since the last look, and (while the window is open) the live price.
   */
  private async furthest(t: Thesis, until: number, withLive: boolean): Promise<number | null> {
    const up = t.spec.direction === 'up';
    const from = t.watchedAt ?? t.startAt!;
    const end = Math.min(until, t.checkAt ?? until);
    const range = end > from ? await this.deps.measure.range(t.spec, from, end).catch(() => null) : null;
    const live = withLive ? await this.deps.measure.now(t.spec).catch(() => null) : null;
    const seen = [t.extreme ?? null, range ? (up ? range.high : range.low) : null, live].filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
    if (!seen.length) return null;
    return up ? Math.max(...seen) : Math.min(...seen);
  }
}

/** How often open touch takes are checked. */
const WATCH_EVERY = 10 * 60_000;
