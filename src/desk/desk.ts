import type { EtfDay, MacroRelease, NewsItem, SectorMove, SoSoValue } from '../sosovalue.js';
import { type Purchase, type TreasuryWatcher, isoDate } from './treasuries.js';

const DAY = 24 * 60 * 60 * 1000;

/** Assets with US spot ETFs tracked by SoSoValue. */
export const ETF_ASSETS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'LINK', 'AVAX', 'DOT', 'LTC', 'HBAR'] as const;

export interface FlowReport {
  asset: string;
  /** Latest settled US session. */
  latest: EtfDay;
  /** Settled sessions, newest first (up to 10). */
  days: EtfDay[];
  /** How many sessions in a row the net flow has had the same sign as `latest`, and their total. */
  streak: { days: number; total: number };
  /** Per-fund net flow on the latest session, largest first; funds with no flow left out. */
  funds: { ticker: string; name: string; netInflow: number }[];
}

export interface MacroReport {
  /** Events from today on, next 7 days. */
  upcoming: { date: string; events: string[] }[];
  /** Today's releases with whatever values are out. */
  today: (MacroRelease & { event: string })[];
  /** Next FOMC meeting's most likely target ranges. */
  fomc: { meetingDate: string; ranges: { range: string; pct: number }[] } | null;
}

export interface MarketReport {
  totalMarketCap: number | null;
  marketCapChangePct: number | null;
  volume24h: number | null;
  /** Sectors sorted by 24h change, best first. */
  sectors: SectorMove[];
}

/**
 * How Ledger reads market data. The live DataDesk below asks SoSoValue; only the background fetcher
 * uses it. Everything members touch reads a StoredDesk (desk/tape.ts) holding the fetcher's results.
 */
export interface Desk {
  readonly treasuries: { readonly ready: boolean };
  readonly requestsThisMonth: number;
  flows(asset: string, opts?: { withFunds?: boolean }): Promise<FlowReport | null>;
  macro(): Promise<MacroReport>;
  todaysEvents(): Promise<string[]>;
  releaseToday(event: string): Promise<(MacroRelease & { event: string }) | null>;
  treasuryBuys(days?: number): Purchase[];
  news(asset?: string): Promise<{ asset: string | null; items: NewsItem[] }>;
  market(): Promise<MarketReport>;
}

/**
 * Ledger's data desk: market numbers from SoSoValue, reported as entries, never interpreted.
 * Each method returns null (or an empty list) when SoSoValue has nothing for the request.
 */
export class DataDesk {
  constructor(
    private readonly soso: SoSoValue,
    readonly treasuries: TreasuryWatcher,
    private readonly now: () => number = Date.now,
  ) {}

  get requestsThisMonth(): number {
    return this.soso.requestsThisMonth;
  }

  /** `withFunds: false` skips the per-fund split, which costs one request per fund. */
  async flows(asset: string, { withFunds = true } = {}): Promise<FlowReport | null> {
    const symbol = asset.trim().toUpperCase().replace(/^\$/, '');
    if (!(ETF_ASSETS as readonly string[]).includes(symbol)) return null;
    const days = (await this.soso.etfFlows(symbol, 'US', 30)).filter((d) => d.totalNetInflow !== null);
    const latest = days[0];
    if (!latest) return null;

    const sign = Math.sign(latest.totalNetInflow!);
    let streakDays = 0;
    let streakTotal = 0;
    for (const d of days) {
      if (Math.sign(d.totalNetInflow!) !== sign || sign === 0) break;
      streakDays++;
      streakTotal += d.totalNetInflow!;
    }

    if (!withFunds) return { asset: symbol, latest, days, streak: { days: streakDays, total: streakTotal }, funds: [] };
    const listings = await this.soso.etfListings(symbol, 'US');
    const histories = await Promise.all(listings.map((l) => this.soso.etfHistory(l.ticker).catch(() => [])));
    const funds = listings
      .map((l, i) => ({ ticker: l.ticker, name: l.name, netInflow: histories[i]!.find((h) => h.date === latest.date)?.netInflow ?? 0 }))
      .filter((f) => f.netInflow !== 0)
      .sort((a, b) => b.netInflow - a.netInflow);

    return { asset: symbol, latest, days, streak: { days: streakDays, total: streakTotal }, funds };
  }

  async macro(): Promise<MacroReport> {
    const today = isoDate(this.now());
    const weekOut = isoDate(this.now() + 7 * DAY);
    const calendar = await this.soso.macroCalendar();
    const thisWeek = calendar.filter((d) => d.date >= today && d.date <= weekOut).sort((a, b) => a.date.localeCompare(b.date));

    // Event names are the API's keys (some end in a space); look them up raw, show them trimmed.
    const todaysEvents = thisWeek.find((d) => d.date === today)?.events.slice(0, 6) ?? [];
    const today_ = await Promise.all(
      todaysEvents.map(async (event) => {
        const history = await this.soso.macroHistory(event, 3).catch(() => []);
        const row = history.find((h) => h.date === today) ?? { date: today, actual: '', forecast: '', previous: history[0]?.actual ?? '' };
        return { ...row, event: event.trim() };
      }),
    );
    const upcoming = thisWeek.map((d) => ({ date: d.date, events: d.events.map((e) => e.trim()) }));

    let fomc: MacroReport['fomc'] = null;
    try {
      const outlook = await this.soso.fomcOutlook();
      const next = outlook.meetings.find((m) => m.meetingDate >= today);
      if (next) {
        const ranges = next.probabilities
          .map((p, i) => ({ range: formatRateRange(outlook.rateRanges[i] ?? ''), pct: p ?? 0 }))
          .filter((r) => r.pct > 0 && r.range)
          .sort((a, b) => b.pct - a.pct)
          .slice(0, 3);
        fomc = { meetingDate: next.meetingDate, ranges };
      }
    } catch {
      // FOMC numbers are a nice-to-have; the calendar still stands without them.
    }
    return { upcoming, today: today_, fomc };
  }

  /** Today's macro events by their exact API names (some end in a space). */
  async todaysEvents(): Promise<string[]> {
    const today = isoDate(this.now());
    return (await this.soso.macroCalendar()).find((d) => d.date === today)?.events ?? [];
  }

  /** Today's release of one event (by exact API name), or null if SoSoValue has no row for today. */
  async releaseToday(event: string): Promise<(MacroRelease & { event: string }) | null> {
    const today = isoDate(this.now());
    const row = (await this.soso.macroHistory(event, 3)).find((h) => h.date === today);
    return row ? { ...row, event: event.trim() } : null;
  }

  /** Corporate BTC purchases in the last `days` days. Empty until the first background scan finishes. */
  treasuryBuys(days = 14): Purchase[] {
    return this.treasuries.recent(days);
  }

  /** Latest headlines for a coin, or the hottest crypto news if no coin is given (or SoSoValue doesn't know it). */
  async news(asset?: string): Promise<{ asset: string | null; items: NewsItem[] }> {
    if (asset) {
      const id = await this.soso.currencyId(asset.replace(/^\$/, ''));
      if (id) return { asset: asset.toUpperCase(), items: await this.soso.coinNews(id, 6) };
    }
    return { asset: null, items: await this.soso.hotNews(6) };
  }

  async market(): Promise<MarketReport> {
    const [overview, sectors] = await Promise.all([this.soso.marketOverview(), this.soso.sectors().catch(() => ({ sectors: [] }))]);
    return { ...overview, sectors: [...sectors.sectors].sort((a, b) => b.change24h - a.change24h) };
  }
}

/** The fund that moved most in the direction of the day's total: the biggest inflow on an inflow day, the biggest outflow on an outflow day. */
export function leadingFund(r: FlowReport): FlowReport['funds'][number] | undefined {
  const net = r.latest.totalNetInflow!;
  const lead = net >= 0 ? r.funds[0] : r.funds.at(-1);
  return lead && Math.sign(lead.netInflow) === Math.sign(net) ? lead : undefined;
}

/** "350-375" (basis points) → "3.50–3.75%". */
export function formatRateRange(bps: string): string {
  const [lo, hi] = bps.split('-').map(Number);
  if (lo === undefined || hi === undefined || Number.isNaN(lo) || Number.isNaN(hi)) return bps;
  return `${(lo / 100).toFixed(2)}–${(hi / 100).toFixed(2)}%`;
}
