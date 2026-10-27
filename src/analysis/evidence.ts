import type { MarketContext } from './context.js';
import { type WebNews, newsQuery } from '../news/webNews.js';
import { leadingFund, type Desk, ETF_ASSETS } from '../desk/desk.js';
import { formatPrice, formatUsd } from '../format.js';
import { type ThesisSpec, measureLabel, neededChange } from '../theses/spec.js';
import type { AssetKind, History, MarketHistory } from './history.js';
import {
  type Analogs,
  type BaseRate,
  type Close,
  analogs,
  baseRate,
  change,
  changeOver,
  correlation,
  latestMove,
  maxDrawdown,
  rangePosition,
  ratio,
  sma,
  volatility,
} from './stats.js';

/** One numbered, checkable statement. The model argues from these and cites them by id. */
export interface Fact {
  id: string;
  text: string;
}

export interface Evidence {
  facts: Fact[];
  /** The thing the thesis measures, now (price, ratio, or null for flows). */
  start: number | null;
  measure: string;
  baseRate: BaseRate | null;
  analogs: Analogs | null;
  sources: string[];
  /** The price histories behind it, for charts. Not stored with the thesis. */
  histories: History[];
}

const pct = (x: number, digits = 1) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(digits)}%`;
const share = (x: number) => `${Math.round(x * 100)}%`;
const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
/** Calendar days as daily bars: crypto trades every day, stocks about 252 days a year. */
const bars = (days: number, tradingDaysOnly: boolean) => (tradingDaysOnly ? Math.max(1, Math.round((days * 252) / 365)) : days);
const month = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });

/**
 * Builds the evidence for a take or a question, all computed in code from real data: trend, range,
 * volatility, unusual moves, ratio and correlation for pairs, the base rate of the move the take
 * needs, analogs, ETF flows, macro inside the horizon, headlines. Nothing here is the model's opinion.
 */
export class EvidenceBuilder {
  constructor(
    private readonly deps: { history: MarketHistory; desk: Desk | null; news?: WebNews; context?: MarketContext; now?: () => number },
  ) {}

  private get now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Evidence for one or two assets with no particular take: for chat questions like "how's SOL looking vs ETH?". */
  async forAssets(symbols: string[]): Promise<Evidence | { error: string }> {
    const histories = await this.load(symbols.slice(0, 2));
    if ('error' in histories) return histories;
    const facts = new FactList();
    for (const h of histories) this.assetFacts(facts, h);
    if (histories.length === 2) this.pairFacts(facts, histories[0]!, histories[1]!);
    await this.contextFacts(facts, histories, 30);
    return { facts: facts.all, start: null, measure: histories.map((h) => h.asset.symbol).join('/'), baseRate: null, analogs: null, sources: sourcesOf(histories, facts), histories };
  }

  /** Evidence for a specific take, including how often what it needs has happened before. */
  async forThesis(spec: ThesisSpec): Promise<Evidence | { error: string }> {
    const histories = await this.load(spec.kind === 'relative' ? [spec.asset, spec.versus!] : [spec.asset], [spec.assetKind, spec.versusKind]);
    if ('error' in histories) return histories;
    const facts = new FactList();
    for (const h of histories) this.assetFacts(facts, h);
    if (histories.length === 2) this.pairFacts(facts, histories[0]!, histories[1]!);

    // The series the thesis is judged on: the price, or the ratio of the two.
    const series = spec.kind === 'relative' ? ratio(histories[0]!.closes, histories[1]!.closes) : histories[0]!.closes;
    const start = spec.kind === 'flows' ? null : (series.at(-1)?.close ?? null);
    let rate: BaseRate | null = null;
    let similar: Analogs | null = null;
    if (start !== null) {
      const need = neededChange(spec, start);
      const h = spec.horizonDays;
      const window = bars(h, histories.some((x) => x.asset.kind === 'stock'));
      const up = spec.direction === 'up';
      if (need !== null) {
        if (spec.kind === 'price') {
          facts.add(`To end ${up ? 'above' : 'below'} ${formatPrice(spec.target!)} it needs ${pct(need)} from ${formatPrice(start)} in ${h} days.`);
        }
        rate = baseRate(series, window, (c) => (up ? (need > 0 ? c >= need : c > need) : need < 0 ? c <= need : c < need));
        if (rate) {
          const what =
            Math.abs(need) < 0.0005
              ? up ? 'rose' : 'fell'
              : up
                ? need > 0 ? `rose ${pct(need)} or more` : `ended no lower than ${pct(need)}`
                : need < 0 ? `fell ${pct(need)} or more` : `ended no higher than ${pct(need)}`;
          facts.add(
            `Base rate: ${measureLabel(spec)} ${what} over ${h} days in ${share(rate.rate)} of ${rate.windows} rolling windows since ${month(rate.since)} (median change ${pct(rate.median)}).`,
          );
        }
      }
      similar = analogs(series, window, bars(30, histories.some((x) => x.asset.kind === 'stock')));
      if (similar) {
        facts.add(
          `Analogs: the ${similar.count} past times ${measureLabel(spec)} had moved about ${pct(similar.setup.change)} over 30 days, it was higher ${h} days later in ${share(similar.upShare)} of cases (median ${pct(similar.median)}).`,
        );
      }
    }
    await this.contextFacts(facts, histories, spec.horizonDays);
    return { facts: facts.all, start, measure: measureLabel(spec), baseRate: rate, analogs: similar, sources: sourcesOf(histories, facts), histories };
  }

  /**
   * How often what a take needs has happened over other timeframes: the same level or move over
   * `horizons` days. In code, from history; nothing to do with the model.
   */
  async timeframes(spec: ThesisSpec, horizons: number[]): Promise<{ days: number; rate: number; windows: number; median: number }[] | { error: string }> {
    if (spec.kind === 'flows') return { error: 'Timeframes are for price takes; ETF flows have no long history to compare.' };
    const histories = await this.load(spec.kind === 'relative' ? [spec.asset, spec.versus!] : [spec.asset], [spec.assetKind, spec.versusKind]);
    if ('error' in histories) return histories;
    const series = spec.kind === 'relative' ? ratio(histories[0]!.closes, histories[1]!.closes) : histories[0]!.closes;
    const start = series.at(-1)?.close;
    if (!start) return { error: 'No recent price to measure from.' };
    const stock = histories.some((x) => x.asset.kind === 'stock');
    const up = spec.direction === 'up';
    const need = neededChange(spec, start) ?? 0;
    const out = [];
    for (const days of [...new Set(horizons)].sort((x, y) => x - y)) {
      const r = baseRate(series, bars(days, stock), (c) => (up ? (need > 0 ? c >= need : c > need) : need < 0 ? c <= need : c < need));
      if (r) out.push({ days, rate: r.rate, windows: r.windows, median: r.median });
    }
    return out.length ? out : { error: 'Not enough history to compare timeframes.' };
  }

  private async load(symbols: string[], kinds: (AssetKind | undefined)[] = []): Promise<History[] | { error: string }> {
    // Both assets of a pair load at the same time.
    const loaded = await Promise.all(
      symbols.map(async (symbol, i) => {
        const asset = await this.deps.history.identify(symbol, kinds[i]);
        return asset ? await this.deps.history.daily(asset) : null;
      }),
    );
    const missing = loaded.findIndex((h) => !h);
    return missing >= 0 ? { error: `No price history found for ${symbols[missing]}.` } : (loaded as History[]);
  }

  private assetFacts(facts: FactList, h: History): void {
    const c = h.closes;
    const s = h.asset.symbol;
    const last = c.at(-1)!.close;
    const stock = h.asset.kind === 'stock';
    const changes = ([['1d', 1], ['7d', 7], ['30d', 30], ['90d', 90], ['1y', 365]] as const)
      .map(([label, n]) => [label, label === '1d' ? change(c, 1) : changeOver(c, n)] as const)
      .filter(([, v]) => v !== null)
      .map(([label, v]) => `${label} ${pct(v!)}`);
    facts.add(`${s} is at ${formatPrice(last)}: ${changes.join(', ')}.`);

    const ma50 = sma(c, 50);
    const ma200 = sma(c, 200);
    if (ma50 && ma200) {
      facts.add(`${s} is ${pct(last / ma50 - 1)} vs its 50-day average and ${pct(last / ma200 - 1)} vs its 200-day; the 50-day is ${ma50 > ma200 ? 'above' : 'below'} the 200-day.`);
    }
    const range = rangePosition(c, bars(365, stock));
    if (range) facts.add(`${s} is ${pct(range.fromHigh)} from its 1-year high (${formatPrice(range.high)}) and ${pct(range.fromLow)} above its 1-year low (${formatPrice(range.low)}).`);
    const vol = volatility(c);
    if (vol) {
      facts.add(`${s}'s typical daily move over 30 days is ${(vol.now * 100).toFixed(1)}%, ${vol.ratio > 1.15 ? `${vol.ratio.toFixed(1)}x its 1-year norm (hot)` : vol.ratio < 0.85 ? `${vol.ratio.toFixed(1)}x its 1-year norm (calm)` : 'about its 1-year norm'}.`);
    }
    const move = latestMove(c);
    if (move && Math.abs(move.sigma) >= 2) {
      facts.add(`${s}'s latest daily move, ${pct(move.move)}, is a ${Math.abs(move.sigma).toFixed(1)}-sigma day, the biggest in ${move.biggestIn} days.`);
    }
    const dd = maxDrawdown(c, bars(90, stock));
    if (dd !== null && dd < -0.1) facts.add(`${s}'s deepest fall in the last 90 days was ${pct(dd)} from its peak.`);
  }

  private pairFacts(facts: FactList, a: History, b: History): void {
    const r = ratio(a.closes, b.closes);
    if (r.length < 30) return;
    const label = `${a.asset.symbol}/${b.asset.symbol}`;
    const stock = a.asset.kind === 'stock' || b.asset.kind === 'stock';
    const parts = ([['7d', 7], ['30d', 30], ['90d', 90]] as const).map(([l, n]) => [l, changeOver(r, n)] as const).filter(([, v]) => v !== null);
    facts.add(
      `${label} ratio is ${r.at(-1)!.close.toPrecision(4)} (rising means ${a.asset.symbol} outperforms ${b.asset.symbol}): ${parts.map(([l, v]) => `${l} ${pct(v!)}`).join(', ')}.`,
    );
    const range = rangePosition(r, bars(365, stock));
    if (range) facts.add(`${label} sits at the ${ordinal(Math.round(range.percentile * 100))} percentile of its 1-year range (${pct(range.fromHigh)} from the high).`);
    const corr = correlation(a.closes, b.closes, bars(90, stock));
    if (corr !== null) facts.add(`${a.asset.symbol} and ${b.asset.symbol} daily moves correlate at ${corr.toFixed(2)} over 90 days.`);
  }

  /** The backdrop: market context, ETF flows, macro inside the horizon, headlines. Stored data only. */
  private async contextFacts(facts: FactList, histories: History[], horizonDays: number): Promise<void> {
    const main = histories[0]!.asset;
    const { desk } = this.deps;
    const backdrop = main.kind === 'crypto' && main.symbol !== 'BTC' ? 'BTC' : main.kind === 'stock' && main.symbol !== 'QQQ' ? 'QQQ' : null;
    if (backdrop && !histories.some((h) => h.asset.symbol === backdrop)) {
      const asset = await this.deps.history.identify(backdrop, main.kind);
      const h = asset && (await this.deps.history.daily(asset).catch(() => null));
      const m = h && changeOver(h.closes, 30);
      if (m !== null && m !== undefined) facts.add(`Backdrop: ${backdrop} ${pct(m)} over 30 days.`);
    }
    await this.marketContext(facts, histories[0]!, horizonDays);
    await this.worldHeadlines(facts, main);
    if (!desk) return;
    for (const h of histories) {
      const sym = h.asset.symbol;
      if (!(ETF_ASSETS as readonly string[]).includes(sym)) continue;
      const f = await desk.flows(sym).catch(() => null);
      if (!f) continue;
      const lead = leadingFund(f);
      const recent = f.days.slice(0, 5);
      const sum = recent.reduce((t, d) => t + (d.totalNetInflow ?? 0), 0);
      const month = f.days.slice(0, 30);
      if (month.length >= 10) {
        const inflowDays = month.filter((d) => (d.totalNetInflow ?? 0) > 0).length;
        const total = month.reduce((t, d) => t + (d.totalNetInflow ?? 0), 0);
        facts.add(`${sym} spot ETFs over the last ${month.length} sessions: ${inflowDays} inflow days, ${month.length - inflowDays} outflow days, ${formatUsd(total, true)} net.`, 'SoSoValue');
      }
      facts.add(
        `${sym} spot ETFs: ${formatUsd(f.latest.totalNetInflow!, true)} on ${f.latest.date}${lead ? ` (${lead.ticker} led)` : ''}` +
          `${f.streak.days >= 2 ? `, ${f.streak.days} sessions in a row of ${f.latest.totalNetInflow! > 0 ? 'inflows' : 'outflows'}` : ''}` +
          `; last ${recent.length} sessions ${formatUsd(sum, true)}.`,
        'SoSoValue',
      );
    }
    const macro = await desk.macro().catch(() => null);
    const until = new Date(this.now + horizonDays * 86_400_000).toISOString().slice(0, 10);
    if (macro?.fomc && macro.fomc.meetingDate <= until) {
      facts.add(`FOMC meets ${macro.fomc.meetingDate}, inside the window; market pricing: ${macro.fomc.ranges.map((r) => `${r.range} ${r.pct.toFixed(0)}%`).join(', ')}.`, 'SoSoValue');
    }
    const events = macro?.upcoming.filter((d) => d.date <= until).flatMap((d) => d.events.filter((e) => /CPI|PCE|payroll|GDP|unemployment|retail sales/i.test(e)).map((e) => `${e} (${d.date})`)) ?? [];
    if (events.length) facts.add(`Macro inside the window: ${events.slice(0, 4).join(', ')}.`, 'SoSoValue');
    if (main.kind === 'crypto') {
      const news = await desk.news(main.symbol).catch(() => null);
      const titles = news?.items.slice(0, 3).map((n) => n.title) ?? [];
      if (titles.length) facts.add(`Headlines${news?.asset ? ` on ${news.asset}` : ''}: ${titles.map((t) => `"${t.slice(0, 90)}"`).join('; ')}.`, 'SoSoValue');
    }
  }

  /**
   * The wider picture: what the dollar, yields, the VIX, stocks, gold, oil and bitcoin did and which of
   * them this asset moves with; its biggest recent days and what was reported on them; and how it has
   * behaved on Fed days, when a decision falls inside the window.
   */
  private async marketContext(facts: FactList, main: History, horizonDays: number): Promise<void> {
    const ctx = this.deps.context;
    if (!ctx) return;
    const [drivers, map] = await Promise.all([ctx.drivers(main).catch(() => []), ctx.eventMap(main, 90, 3).catch(() => null)]);
    for (const f of drivers) facts.add(f, 'Yahoo Finance');
    if (!map) return;
    const until = new Date(this.now + horizonDays * 86_400_000).toISOString().slice(0, 10);
    const fedInWindow = map.nextFomc !== null && map.nextFomc <= until;
    for (const f of ctx.eventFacts(map, fedInWindow)) facts.add(f, f.includes('headlines: "') ? 'Google News' : undefined);
  }

  /** What the world is saying about a stock or commodity (crypto headlines come from SoSoValue). */
  private async worldHeadlines(facts: FactList, main: History['asset']): Promise<void> {
    if (main.kind === 'crypto' || !this.deps.news) return;
    const items = await this.deps.news.search(newsQuery(main.symbol), { days: 3, limit: 5 }).catch(() => []);
    if (!items.length) return;
    const day = (ms: number) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
    facts.add(
      `Headlines on ${main.symbol}, last 3 days: ${items.map((h) => `"${h.title.slice(0, 110)}" (${h.source}, ${day(h.publishedAt)})`).join('; ')}.`,
      'Google News',
    );
  }
}

class FactList {
  readonly all: Fact[] = [];
  /** Data sources beyond the price history, for the card's small print. */
  readonly sources = new Set<string>();
  add(text: string, source?: string): void {
    this.all.push({ id: `F${this.all.length + 1}`, text });
    if (source) this.sources.add(source);
  }
}

function sourcesOf(histories: History[], facts: FactList): string[] {
  return [...new Set([...histories.map((h) => h.source), ...facts.sources])];
}

export type { Close };
