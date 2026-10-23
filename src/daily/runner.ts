import type { Candle } from '../calls/prices.js';
import type { DataDesk } from '../desk/desk.js';
import { formatPrice, formatUsd } from '../format.js';
import { log } from '../log.js';
import type { SoSoValue } from '../sosovalue.js';
import { type LedgerSummary, buildLedger } from './ledger.js';
import {
  type Outcome,
  dayLabel,
  etfOutcome,
  nextQuestionDay,
  questionFor,
  upDownOutcome,
  versusOutcome,
} from './questions.js';
import type { DailyStore, Question } from './store.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The Discord side: posting and editing question cards. */
export interface DailyPoster {
  /** Posts a new question, with Today's Page above it. Returns the message id, or null if posting failed. */
  post(q: Question, ledger: LedgerSummary | null): Promise<string | null>;
  /** Re-renders a question's card (answer count, closed state, result). The verdict also leads the next Today's Page. */
  refresh(q: Question): Promise<void>;
}

export interface MinuteCandles {
  candles(symbol: string, interval: '1m', range: { startTime: number; limit: number }): Promise<Candle[]>;
}

export interface DailyDeps {
  store: DailyStore;
  candles: MinuteCandles;
  /** Null without a SoSoValue key: ETF questions are swapped for price questions and Today's Page has no tape. */
  soso: SoSoValue | null;
  desk: DataDesk | null;
  poster: DailyPoster;
  closeMinute: number;
  now?: () => number;
}

/**
 * Runs the Daily Question once a minute: closes answering on time, opens the next question (with the
 * Today's Page), resolves closed questions as soon as their data is in, and keeps answer counts fresh.
 */
export class DailyRunner {
  private readonly shownCounts = new Map<number, number>();
  private readonly postFailedAt = new Map<string, number>();
  private running = false;

  constructor(private readonly deps: DailyDeps) {}

  private get now(): number {
    return (this.deps.now ?? Date.now)();
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.closeDue();
      await this.openNext();
      await this.resolveClosed();
      await this.refreshCounts();
    } finally {
      this.running = false;
    }
  }

  private async closeDue(): Promise<void> {
    const { store, poster } = this.deps;
    for (const q of store.withStatus('open')) {
      if (this.now < q.closesAt) continue;
      let start: Record<string, number> | null = null;
      if (q.spec.kind !== 'etf-flow') {
        try {
          start = await this.pricesAt(q.spec.assets, q.closesAt, 'open');
        } catch (err) {
          log.warn(`Daily Question #${q.id}: starting prices not available yet`, err);
          continue; // try again next minute
        }
      }
      if (store.close(q.id, start)) await poster.refresh(store.get(q.id)!);
    }
  }

  private async openNext(): Promise<void> {
    const { store, poster, closeMinute, soso, desk } = this.deps;
    for (const { guildId, channelId } of store.channels()) {
      if (store.current(guildId)) continue;
      // A channel that refused a post (deleted, no permission) is retried every 30 minutes, not every minute.
      if (this.now - (this.postFailedAt.get(guildId) ?? 0) < 30 * MINUTE) continue;

      let day = nextQuestionDay(this.now, closeMinute);
      while (store.exists(guildId, day)) day = new Date(Date.parse(`${day}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
      const ledger = desk ? await buildLedger(desk).catch(() => null) : null;
      const q = store.create(guildId, channelId, questionFor(day, closeMinute, soso !== null), this.now);
      const messageId = await poster.post(q, ledger);
      if (messageId) {
        store.attachMessage(q.id, messageId);
        this.postFailedAt.delete(guildId);
      } else {
        store.close(q.id, null);
        store.resolve(q.id, null, 'Could not be posted.', this.now);
        this.postFailedAt.set(guildId, this.now);
      }
    }
  }

  private async resolveClosed(): Promise<void> {
    const { store, poster } = this.deps;
    for (const q of store.withStatus('closed')) {
      try {
        const outcome = await this.outcome(q);
        if (!outcome || !store.resolve(q.id, outcome.answer, outcome.result, this.now)) continue;
        const done = store.get(q.id)!;
        log.info(`Daily Question #${q.id} (${q.spec.day}) resolved: ${done.answer ?? 'void'}`);
        await poster.refresh(done);
      } catch (err) {
        log.warn(`Resolving Daily Question #${q.id} failed; will retry`, err);
      }
    }
  }

  /** The answer, once the data is in; null while it isn't. */
  private async outcome(q: Question): Promise<Outcome | null> {
    const { spec } = q;
    if (spec.kind === 'etf-flow') {
      // Flows settle after the US close and SoSoValue publishes them T+1: start looking 8h after the open, every 30 min.
      if (this.now < q.closesAt + 8 * HOUR || (q.lastCheck && this.now - q.lastCheck < 30 * MINUTE)) return null;
      this.deps.store.markChecked(q.id, this.now);
      const rows = this.deps.soso ? await this.deps.soso.etfFlows(spec.assets[0]!, 'US', 10) : [];
      const row = rows.find((d) => d.date === spec.day && d.totalNetInflow !== null);
      if (row) return etfOutcome(spec, row.totalNetInflow!, (n) => formatUsd(n, true));
      if (this.now > q.closesAt + 4 * DAY) {
        return { answer: null, result: `No US ETF session on record for ${dayLabel(spec.day)} (market holiday?). No points either way.` };
      }
      return null;
    }

    if (this.now < spec.windowEnd! + MINUTE) return null;
    const start = q.startPrices;
    if (!start) return { answer: null, result: 'Starting prices were never recorded. No points either way.' };
    const end = await this.pricesAt(spec.assets, spec.windowEnd! - MINUTE, 'close');
    const [a, b] = spec.assets as [string, string];
    if (spec.kind === 'up-down') return upDownOutcome(spec, start[a]!, end[a]!, formatPrice);
    return versusOutcome(spec, end[a]! / start[a]! - 1, end[b]! / start[b]! - 1);
  }

  /** Each asset's open (or close) in the one-minute candle starting at `at`. */
  private async pricesAt(assets: string[], at: number, field: 'open' | 'close'): Promise<Record<string, number>> {
    const prices: Record<string, number> = {};
    for (const asset of assets) {
      const [candle] = await this.deps.candles.candles(`${asset}USDT`, '1m', { startTime: at, limit: 1 });
      if (!candle || candle.openTime !== at) throw new Error(`no ${asset} candle at ${new Date(at).toISOString()}`);
      prices[asset] = candle[field];
    }
    return prices;
  }

  private async refreshCounts(): Promise<void> {
    const { store, poster } = this.deps;
    for (const q of store.withStatus('open')) {
      const { a, b } = store.counts(q.id);
      if (this.shownCounts.get(q.id) === a + b) continue;
      this.shownCounts.set(q.id, a + b);
      await poster.refresh(q);
    }
  }
}
