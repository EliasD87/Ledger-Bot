import { type Headline, type WebNews, newsQuery } from '../news/webNews.js';
import { marketOf } from './commodities.js';
import { type BigMove, type EventStudy, FOMC_DECISIONS, bigMoves, eventReaction, nextFomc } from './events.js';
import type { History, MarketHistory } from './history.js';
import { changeOver, correlation } from './stats.js';

/** What a member's asset is read against: the dollar, rates, fear, stocks, gold, oil, bitcoin. */
const DRIVERS = [
  { symbol: 'DXY', label: 'the dollar index' },
  { symbol: 'US10Y', label: 'the 10-year yield' },
  { symbol: 'VIX', label: 'the VIX' },
  { symbol: 'SP500', label: 'the S&P 500' },
  { symbol: 'GOLD', label: 'gold' },
  { symbol: 'WTI', label: 'WTI crude' },
  { symbol: 'BTC', label: 'bitcoin' },
];

export interface MappedMove extends BigMove {
  headlines: Headline[];
}

export interface EventMap {
  symbol: string;
  moves: MappedMove[];
  fomc: EventStudy | null;
  nextFomc: string | null;
}

const pct = (x: number, digits = 1) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(digits)}%`;
const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/**
 * The context around an asset, computed from data: what the big macro gauges did, which of them the
 * asset actually moves with, how it behaves on Fed days, and what was reported on its biggest days.
 */
export class MarketContext {
  constructor(private readonly deps: { history: MarketHistory; news?: WebNews; now?: () => number }) {}

  private get now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** The drivers' last 30 days, and which ones this asset lined up with over 90 days. */
  async drivers(main: History): Promise<string[]> {
    const loaded = await Promise.all(
      DRIVERS.filter((d) => d.symbol !== main.asset.symbol).map(async (d) => {
        const asset = await this.deps.history.identify(d.symbol, d.symbol === 'BTC' ? 'crypto' : 'stock').catch(() => null);
        const h = asset && (await this.deps.history.daily(asset).catch(() => null));
        return h ? { ...d, h } : null;
      }),
    );
    const drivers = loaded.filter((d): d is NonNullable<typeof d> => d !== null);
    if (!drivers.length) return [];
    const facts: string[] = [];
    const moves = drivers.flatMap((d) => {
      const last = d.h.closes.at(-1)!.close;
      if (marketOf(d.symbol)?.rate) {
        const then = closeDaysAgo(d.h, 30);
        return then === null ? [] : [`${d.label} ${last.toFixed(2)}% (${last - then >= 0 ? '+' : '−'}${Math.abs(last - then).toFixed(2)} pts)`];
      }
      const m = changeOver(d.h.closes, 30);
      return m === null ? [] : [`${d.label} ${pct(m)}`];
    });
    if (moves.length) facts.push(`Backdrop, last 30 days: ${moves.join(', ')}.`);
    const corr = drivers
      .map((d) => ({ label: d.label, c: correlation(main.closes, d.h.closes, 90) }))
      .filter((x): x is { label: string; c: number } => x.c !== null && Math.abs(x.c) >= 0.25)
      .sort((a, b) => Math.abs(b.c) - Math.abs(a.c))
      .slice(0, 3);
    const s = main.asset.symbol;
    if (corr.length) {
      const withIt = corr.filter((x) => x.c > 0).map((x) => `${x.label} (${x.c.toFixed(2)})`);
      const against = corr.filter((x) => x.c < 0).map((x) => `${x.label} (${x.c.toFixed(2)})`);
      facts.push(
        `Over 90 days, ${s}'s daily moves lined up most with ${[withIt.length && withIt.join(', '), against.length && `opposite to ${against.join(', ')}`].filter(Boolean).join(', and ')} (correlation of daily moves; 1 = in lockstep).`,
      );
    } else {
      facts.push(`Over 90 days, ${s} moved mostly on its own: no correlation of 0.25 or more with the dollar, yields, the VIX, the S&P 500, gold, oil or bitcoin.`);
    }
    return facts;
  }

  /** How this asset moved over past FOMC decisions (decision day and the next), and the next decision date. */
  fomcFacts(main: History): string[] {
    const study = eventReaction(main.closes, FOMC_DECISIONS);
    const next = nextFomc(this.now);
    return study ? [fomcLine(main.asset.symbol, study, next)] : next ? [`Next FOMC decision: ${day(next)}.`] : [];
  }

  /** Big moves of the window matched to that day's headlines, FOMC behaviour, and the next decision. */
  async eventMap(main: History, days = 90, n = 4): Promise<EventMap> {
    const moves = bigMoves(main.closes, days, n);
    const query = newsQuery(main.asset.symbol, main.asset.kind === 'crypto');
    const mapped = await Promise.all(
      moves.map(async (m) => ({ ...m, headlines: this.deps.news ? await this.deps.news.onDay(query, m.date, 2).catch(() => []) : [] })),
    );
    return { symbol: main.asset.symbol, moves: mapped, fomc: eventReaction(main.closes, FOMC_DECISIONS), nextFomc: nextFomc(this.now) };
  }

  /** Everything for one asset by name or ticker: its history, the backdrop facts and the event map. */
  async forAsset(raw: string, days = 90): Promise<{ main: History; drivers: string[]; map: EventMap } | { error: string }> {
    const asset = await this.deps.history.identify(raw).catch(() => null);
    const main = asset && (await this.deps.history.daily(asset).catch(() => null));
    if (!main) return { error: `No price history found for ${raw}.` };
    const [drivers, map] = await Promise.all([this.drivers(main).catch(() => []), this.eventMap(main, days, 5)]);
    return { main, drivers, map };
  }

  /** The event map as facts the model can cite (FOMC behaviour too, unless left out). */
  eventFacts(map: EventMap, withFomc = true): string[] {
    const facts = map.moves.map(
      (m) =>
        `${day(m.date)}: ${map.symbol} ${pct(m.move)} on the day (${Math.abs(m.sigma).toFixed(1)}x a normal day's move)` +
        (m.headlines.length ? `; that day's headlines: ${m.headlines.map((h) => `"${h.title.slice(0, 110)}" (${h.source})`).join('; ')}` : '; no matching headlines found') +
        '.',
    );
    if (withFomc && map.fomc) facts.push(fomcLine(map.symbol, map.fomc, map.nextFomc));
    return facts;
  }
}

function fomcLine(symbol: string, s: EventStudy, next: string | null): string {
  const ratio = s.normalAbsMove ? s.avgAbsMove / s.normalAbsMove : 1;
  const size = ratio >= 1.2 ? `${ratio.toFixed(1)}x a normal two-day move` : ratio <= 0.85 ? `smaller than a normal two-day move (${ratio.toFixed(1)}x)` : 'about a normal two-day move';
  return (
    `Around the last ${s.count} FOMC decisions (decision day plus the next), ${symbol} moved ${(s.avgAbsMove * 100).toFixed(1)}% on average, up or down, ${size}; ` +
    `up ${Math.round(s.upShare * 100)}% of the time, median ${pct(s.median)}. Most recent: ${s.recent.map((r) => `${day(r.date)} ${pct(r.move)}`).join(', ')}.` +
    (next ? ` Next decision: ${day(next)}.` : '')
  );
}

function closeDaysAgo(h: History, days: number): number | null {
  const cutoff = Date.parse(`${h.closes.at(-1)!.date}T00:00:00Z`) - days * 86_400_000;
  let then: number | null = null;
  for (const c of h.closes) {
    if (Date.parse(`${c.date}T00:00:00Z`) > cutoff) break;
    then = c.close;
  }
  return then;
}
