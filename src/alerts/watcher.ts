import type { Candle } from '../calls/prices.js';
import { dayLabel, signedPct } from '../daily/questions.js';
import { type DataDesk, leadingFund } from '../desk/desk.js';
import { formatPrice, formatUsd } from '../format.js';
import { log } from '../log.js';
import type { Alert, AlertStore } from './store.js';

const MINUTE = 60_000;

/** Server-wide prints: ETF days at least this big, BTC buys at least this size, daily moves at least this sharp. */
export const SERVER_THRESHOLDS = {
  etfFlowUsd: { BTC: 250e6, ETH: 100e6 } as Record<string, number>,
  treasuryBtc: 100,
  dailyMove: 0.05,
  moveAssets: ['BTC', 'ETH', 'SOL'],
};

/** Macro releases worth a server print. */
const MAJOR_MACRO = /\b(CPI|PCE|Nonfarm|Unemployment Rate|GDP|PPI|Interest Rate Decision|FOMC|Retail Sales)\b/i;

/** Server print priority when several land in one check: macro first, then flows, buys, moves. */
const PRIORITY = { macro: 0, flows: 1, treasury: 2, move: 3 } as const;

export interface PersonalBatch {
  userId: string;
  guildId: string;
  texts: string[];
  /** The alerts that fired, so the DM can offer to stop one. */
  alerts: Alert[];
}

export interface AlertNotifier {
  /** One DM per member per check, never posted publicly. If DMs are closed, the hits wait on Your Page. */
  personal(batch: PersonalBatch): Promise<void>;
  /** One merged post per server per check, already in priority order. The notifier applies the daily cap. */
  server(texts: string[]): Promise<void>;
}

export interface AlertPrices {
  candles(symbol: string, interval: '1m', range: { limit: number }): Promise<Candle[]>;
  change24h(symbols: string[]): Promise<Record<string, { price: number; change: number }>>;
}

export interface AlertDeps {
  store: AlertStore;
  prices: AlertPrices;
  /** Null without a SoSoValue key: flow, macro and BTC-buy watches stay quiet. */
  desk: DataDesk | null;
  notifier: AlertNotifier;
  now?: () => number;
}

/**
 * Checks everything members asked to watch. Prices every minute; daily moves and macro every 5 minutes;
 * ETF flows every 30. Every event fires at most once (seen_events); the first look at a data stream is
 * recorded silently, so a fresh start never announces old news. Hits are batched: one DM per member and
 * one server post per check.
 */
export class AlertWatcher {
  private readonly lastRun = new Map<string, number>();
  private running = false;
  private personal = new Map<string, PersonalBatch>();
  private prints: { priority: number; text: string }[] = [];

  constructor(private readonly deps: AlertDeps) {}

  private get now(): number {
    return (this.deps.now ?? Date.now)();
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.step('prices', 0, () => this.checkPrices());
      await this.step('moves', 5 * MINUTE, () => this.checkDailyMoves());
      await this.step('macro', 5 * MINUTE, () => this.checkMacro());
      await this.step('flows', 30 * MINUTE, () => this.checkFlows());
      await this.step('treasuries', 0, () => this.checkTreasuries());
      await this.flush();
    } finally {
      this.running = false;
    }
  }

  private async step(name: string, every: number, run: () => Promise<void>): Promise<void> {
    if (this.now - (this.lastRun.get(name) ?? -Infinity) < every) return;
    this.lastRun.set(name, this.now);
    try {
      await run();
    } catch (err) {
      log.warn(`Watch check "${name}" failed; will retry`, err);
    }
  }

  /** Queues a hit for a member and marks the alert fired (one-shot alerts stop; repeating ones stay). */
  private hit(alert: Alert, text: string): void {
    this.deps.store.fire(alert.id, this.now);
    const key = `${alert.guildId}:${alert.userId}`;
    const batch = this.personal.get(key) ?? { userId: alert.userId, guildId: alert.guildId, texts: [], alerts: [] };
    batch.texts.push(text);
    batch.alerts.push(alert);
    this.personal.set(key, batch);
  }

  private print(kind: keyof typeof PRIORITY, text: string): void {
    this.prints.push({ priority: PRIORITY[kind], text });
  }

  private async flush(): Promise<void> {
    const batches = [...this.personal.values()];
    const prints = this.prints.sort((a, b) => a.priority - b.priority).map((p) => p.text);
    this.personal = new Map();
    this.prints = [];
    for (const batch of batches) await this.deps.notifier.personal(batch);
    if (prints.length) await this.deps.notifier.server(prints);
  }

  /** Price-level and move-from-here alerts, against the high and low of the last two minutes. */
  private async checkPrices(): Promise<void> {
    const { store, prices } = this.deps;
    const alerts = [...store.active('price'), ...store.active('move')];
    for (const asset of new Set(alerts.map((a) => a.asset!))) {
      const candles = await prices.candles(`${asset}USDT`, '1m', { limit: 2 });
      if (!candles.length) continue;
      const high = Math.max(...candles.map((c) => c.high));
      const low = Math.min(...candles.map((c) => c.low));
      const last = candles.at(-1)!.close;
      for (const a of alerts.filter((x) => x.asset === asset)) {
        if (a.kind === 'price' && a.direction === 'above' && high >= a.target!) {
          this.hit(a, `🔔 **${asset}** reached ${formatPrice(a.target!)} (high ${formatPrice(high)}, now ${formatPrice(last)}).`);
        } else if (a.kind === 'price' && a.direction === 'below' && low <= a.target!) {
          this.hit(a, `🔔 **${asset}** went below ${formatPrice(a.target!)} (low ${formatPrice(low)}, now ${formatPrice(last)}).`);
        } else if (a.kind === 'move') {
          const up = high / a.refPrice! - 1;
          const down = low / a.refPrice! - 1;
          const moved = up >= a.target! ? up : -down >= a.target! ? down : null;
          if (moved !== null) {
            this.hit(a, `🔔 **${asset}** moved ${signedPct(moved)} since you set the watch (${formatPrice(a.refPrice!)} → ${formatPrice(moved > 0 ? high : low)}).`);
          }
        }
      }
    }
  }

  /** ±X% over 24h: members' daily-move watches, and the server's ±5% print (merged into one line). */
  private async checkDailyMoves(): Promise<void> {
    const { store, prices } = this.deps;
    const watches = store.active('day-move');
    const serverOn = store.channels().length > 0;
    const assets = new Set([...watches.map((a) => a.asset!), ...(serverOn ? SERVER_THRESHOLDS.moveAssets : [])]);
    if (!assets.size) return;
    const changes = await prices.change24h([...assets].map((a) => `${a}USDT`));
    const day = new Date(this.now).toISOString().slice(0, 10);

    for (const a of watches) {
      const c = changes[`${a.asset}USDT`];
      if (!c || Math.abs(c.change) < a.target!) continue;
      if (!store.markSeen(`daymove:${a.id}:${day}`, this.now)) continue; // once per watch per day
      this.hit(a, `🔔 **${a.asset}** is ${signedPct(c.change)} over 24 hours (now ${formatPrice(c.price)}).`);
    }

    if (!serverOn) return;
    const big = SERVER_THRESHOLDS.moveAssets.filter((asset) => {
      const c = changes[`${asset}USDT`];
      return c && Math.abs(c.change) >= SERVER_THRESHOLDS.dailyMove && store.markSeen(`move:${asset}:${day}`, this.now);
    });
    if (big.length) {
      this.print('move', `🔔 Over 24 hours: ${big.map((asset) => `**${asset}** ${signedPct(changes[`${asset}USDT`]!.change)}`).join(' · ')}.`);
    }
  }

  /** A new settled ETF day: flow watchers hear about it; the server only on big days. */
  private async checkFlows(): Promise<void> {
    const { store, desk } = this.deps;
    if (!desk) return;
    const watchers = store.active('etf-flow');
    const serverAssets = store.channels().length ? Object.keys(SERVER_THRESHOLDS.etfFlowUsd) : [];
    for (const asset of new Set([...watchers.map((a) => a.asset!), ...serverAssets])) {
      // Poll the daily total only; the per-fund split costs one request per fund, so fetch it once per new day.
      const total = await desk.flows(asset, { withFunds: false });
      if (!total) continue;
      const prefix = `etf:${asset}:`;
      const primed = store.anySeen(prefix);
      if (!store.markSeen(`${prefix}${total.latest.date}`, this.now) || !primed) continue; // seen, or first look: stay quiet

      const report = (await desk.flows(asset).catch(() => null)) ?? total;
      const net = report.latest.totalNetInflow!;
      const lead = leadingFund(report);
      const led = lead ? `, led by ${lead.ticker} ${formatUsd(lead.netInflow, true)}` : '';
      const streak = report.streak.days >= 2 ? ` ${report.streak.days} sessions in a row of ${net > 0 ? 'inflows' : 'outflows'}.` : '';
      const text = `🔔 **${asset} spot ETFs**, ${dayLabel(report.latest.date)}: ${formatUsd(net, true)} net${led}.${streak} (SoSoValue)`;
      for (const a of watchers.filter((w) => w.asset === asset)) this.hit(a, text);
      const threshold = SERVER_THRESHOLDS.etfFlowUsd[asset];
      if (threshold !== undefined && Math.abs(net) >= threshold) this.print('flows', text);
    }
  }

  /** Today's macro releases, as soon as the actual number is out. Stops asking once an event is announced. */
  private async checkMacro(): Promise<void> {
    const { store, desk } = this.deps;
    if (!desk) return;
    const watchers = store.active('macro');
    const serverOn = store.channels().length > 0;
    if (!watchers.length && !serverOn) return;
    const today = new Date(this.now).toISOString().slice(0, 10);
    for (const event of await desk.todaysEvents()) {
      const name = event.trim();
      const wanted = watchers.filter((w) => name.toLowerCase().includes(w.asset!.toLowerCase()));
      const major = serverOn && MAJOR_MACRO.test(name);
      const key = `macro:${name}:${today}`;
      if ((!wanted.length && !major) || store.seen(key)) continue;
      const r = await desk.releaseToday(event);
      if (!r?.actual || !store.markSeen(key, this.now)) continue;
      const context = [r.forecast && `forecast ${r.forecast}`, r.previous && `previous ${r.previous}`].filter(Boolean).join(', ');
      const text = `🔔 **${name}** is out: **${r.actual}**${context ? ` (${context})` : ''}. (SoSoValue)`;
      for (const a of wanted) this.hit(a, text);
      if (major) this.print('macro', text);
    }
  }

  /** New corporate BTC purchases found by the background scan. */
  private async checkTreasuries(): Promise<void> {
    const { store, desk } = this.deps;
    if (!desk?.treasuries.ready) return;
    const watchers = store.active('treasury');
    const primed = store.anySeen('treasury:');
    for (const p of desk.treasuryBuys(14)) {
      if (!store.markSeen(`treasury:${p.ticker}:${p.date}:${p.btcAcquired}`, this.now) || !primed) continue;
      const text =
        `🔔 **${p.company} (${p.ticker})** bought ${p.btcAcquired.toLocaleString('en-US')} BTC` +
        `${p.costUsd ? ` for ${formatUsd(p.costUsd)}` : ''} (${dayLabel(p.date)}). Now holds ${p.btcHolding.toLocaleString('en-US')} BTC. (SoSoValue)`;
      for (const a of watchers) this.hit(a, text);
      if (p.btcAcquired >= SERVER_THRESHOLDS.treasuryBtc) this.print('treasury', text);
    }
  }
}
