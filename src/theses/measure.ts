import type { MarketHistory } from '../analysis/history.js';
import type { Desk } from '../desk/desk.js';
import type { CryptoQuotes, StockQuotes } from '../quotes.js';
import type { ThesisSpec } from './spec.js';
import { held } from './spec.js';
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

/** Settles theses whose check-back has come. Voids one if its data never shows up. */
export class ThesisSettler {
  private running = false;

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
      for (const t of this.deps.store.due(now)) {
        const end = await this.deps.measure.atCheck(t, now).catch(() => null);
        if (end === null) {
          if (now > t.checkAt! + 5 * DAY && this.deps.store.void(t.id, 'no data at the check-back', now)) voided.push(t);
          continue;
        }
        const ok = held(t.spec, t.startValue ?? 0, end);
        if (this.deps.store.settle(t.id, end, ok, now)) settled.push({ thesis: this.deps.store.get(t.id)!, endValue: end, held: ok });
      }
      return { settled, voided };
    } finally {
      this.running = false;
    }
  }
}
