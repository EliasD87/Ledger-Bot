import type { Db } from '../db/index.js';
import { log } from '../log.js';
import type { MacroRelease, NewsItem, SoSoValue, StockQuote } from '../sosovalue.js';
import { type DataDesk, type Desk, ETF_ASSETS, type FlowReport, type MacroReport, type MarketReport } from './desk.js';
import { type Purchase, type TreasuryWatcher, isoDate } from './treasuries.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** SoSoValue's plan: 100,000 requests a month. The fetcher slows down near it and stops short of it. */
export const MONTHLY_CAP = 100_000;
const SLOW_DOWN_AT = 80_000;
const STOP_AT = 96_000;

/** US stocks this server talks about; fetched in one batched request. Others come from the backup sources. */
export const STOCK_WATCH = ['NVDA', 'TSLA', 'MSTR', 'COIN', 'HOOD', 'AAPL', 'MSFT', 'AMZN', 'META', 'GOOGL', 'AMD', 'PLTR', 'MARA', 'RIOT', 'CRCL', 'SPY', 'QQQ', 'IBIT'];
/** Coins with their own stored headlines; anything else gets the hot list. */
export const NEWS_ASSETS = ['BTC', 'ETH', 'SOL'];

/** Snapshots of everything Ledger shows from SoSoValue, kept in the database so a restart doesn't refetch. */
export class TapeStore {
  constructor(private readonly db: Db) {}

  get<T>(key: string): { value: T; at: number } | null {
    const row = this.db.prepare('SELECT value, updated_at AS at FROM kv WHERE key = ?').get(`tape:${key}`) as { value: string; at: number } | undefined;
    return row ? { value: JSON.parse(row.value) as T, at: row.at } : null;
  }

  set(key: string, value: unknown, now: number): void {
    this.db
      .prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .run(`tape:${key}`, JSON.stringify(value), now);
  }

  /** SoSoValue requests made this calendar month (UTC), across restarts. */
  usage(now: number): number {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(usageKey(now)) as { value: string } | undefined;
    return row ? Number(row.value) : 0;
  }

  addUsage(requests: number, now: number): void {
    if (requests <= 0) return;
    this.db
      .prepare(
        `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + ? AS TEXT), updated_at = excluded.updated_at`,
      )
      .run(usageKey(now), String(requests), now, requests);
  }
}

const usageKey = (now: number) => `sosovalue-requests:${new Date(now).toISOString().slice(0, 7)}`;

/** The stored tape, read like the live desk. Nothing here calls SoSoValue. */
export class StoredDesk implements Desk {
  constructor(
    private readonly tape: TapeStore,
    private readonly now: () => number = Date.now,
  ) {}

  get treasuries() {
    return { ready: this.tape.get('treasury') !== null };
  }

  get requestsThisMonth(): number {
    return this.tape.usage(this.now());
  }

  async flows(asset: string): Promise<FlowReport | null> {
    return this.tape.get<FlowReport>(`flows:${asset.trim().toUpperCase().replace(/^\$/, '')}`)?.value ?? null;
  }

  async macro(): Promise<MacroReport> {
    const stored = this.tape.get<MacroReport>('macro')?.value;
    const today = isoDate(this.now());
    return {
      today: stored?.today.filter((t) => t.date === today) ?? [],
      upcoming: stored?.upcoming.filter((d) => d.date >= today) ?? [],
      fomc: stored?.fomc && stored.fomc.meetingDate >= today ? stored.fomc : null,
    };
  }

  async todaysEvents(): Promise<string[]> {
    return (await this.macro()).today.map((t) => t.event);
  }

  async releaseToday(event: string): Promise<(MacroRelease & { event: string }) | null> {
    return (await this.macro()).today.find((t) => t.event === event.trim()) ?? null;
  }

  treasuryBuys(days = 14): Purchase[] {
    const cutoff = isoDate(this.now() - days * DAY);
    return (this.tape.get<Purchase[]>('treasury')?.value ?? []).filter((p) => p.date >= cutoff);
  }

  async news(asset?: string): Promise<{ asset: string | null; items: NewsItem[] }> {
    const symbol = asset?.trim().toUpperCase().replace(/^\$/, '');
    const own = symbol ? this.tape.get<NewsItem[]>(`news:${symbol}`) : null;
    if (symbol && own) return { asset: symbol, items: own.value };
    return { asset: null, items: this.tape.get<NewsItem[]>('news:hot')?.value ?? [] };
  }

  async market(): Promise<MarketReport> {
    return this.tape.get<MarketReport>('market')?.value ?? { totalMarketCap: null, marketCapChangePct: null, volume24h: null, sectors: [] };
  }

  /** The stored batch of stock quotes and when it was fetched. */
  stocks(): { value: Record<string, StockQuote>; at: number } | null {
    return this.tape.get<Record<string, StockQuote>>('stocks');
  }
}

interface Job {
  key: string;
  /** How long a snapshot stays good at this moment. */
  every: (now: number) => number;
  run: (now: number) => Promise<unknown>;
}

/**
 * The only thing in Ledger that asks SoSoValue for data. Each part of the tape has its own schedule
 * (stocks often during US hours, macro often around release times, the rest slower), results land in
 * the TapeStore, and every request is counted against the monthly cap. About 1,200 requests a day,
 * a third of the plan; past 80% of the month it slows to a quarter, past 96% it stops.
 */
export class TapeRefresher {
  private readonly jobs: Job[];
  /** When each job last ran, data or not: a coin without ETFs, or a failed request, waits its turn like the rest. */
  private readonly attempted = new Map<string, number>();
  private running = false;

  constructor(
    private readonly deps: { tape: TapeStore; soso: SoSoValue; live: DataDesk; treasuries: TreasuryWatcher; now?: () => number },
  ) {
    const { tape, soso, live, treasuries } = deps;
    const flowsJob = (asset: string, every: number): Job => ({
      key: `flows:${asset}`,
      every: () => every,
      run: async (now) => {
        // The day's total is one request; the fund split costs one per fund, so it's fetched once per new session.
        const total = await live.flows(asset, { withFunds: false });
        if (!total) return;
        const stored = tape.get<FlowReport>(`flows:${asset}`)?.value;
        const report = stored && stored.latest.date === total.latest.date && stored.funds.length ? { ...total, funds: stored.funds } : await live.flows(asset);
        tape.set(`flows:${asset}`, report ?? total, now);
      },
    });
    this.jobs = [
      flowsJob('BTC', 30 * MINUTE),
      flowsJob('ETH', 30 * MINUTE),
      ...ETF_ASSETS.filter((a) => a !== 'BTC' && a !== 'ETH').map((a) => flowsJob(a, 3 * HOUR)),
      { key: 'macro', every: (now) => (inReleaseWindow(now) ? 10 * MINUTE : 2 * HOUR), run: async (now) => tape.set('macro', await live.macro(), now) },
      { key: 'market', every: () => 10 * MINUTE, run: async (now) => tape.set('market', await live.market(), now) },
      { key: 'news:hot', every: () => 15 * MINUTE, run: async (now) => tape.set('news:hot', (await live.news()).items, now) },
      ...NEWS_ASSETS.map(
        (asset): Job => ({
          key: `news:${asset}`,
          every: () => HOUR,
          run: async (now) => {
            const n = await live.news(asset);
            if (n.asset) tape.set(`news:${asset}`, n.items, now);
          },
        }),
      ),
      {
        key: 'stocks',
        every: (now) => (usMarketOpen(now) ? 3 * MINUTE : 30 * MINUTE),
        run: async (now) => {
          const quotes = await soso.stockQuotes(STOCK_WATCH);
          if (Object.keys(quotes).length) tape.set('stocks', quotes, now);
        },
      },
      {
        key: 'treasury',
        every: () => DAY,
        run: async (now) => {
          await treasuries.refreshIfStale(0);
          if (treasuries.ready) tape.set('treasury', treasuries.recent(90), now);
        },
      },
    ];
  }

  private get now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Runs whatever is due, most overdue first, at most a few jobs per call. Call it every minute. */
  async tick(maxJobs = 4): Promise<string[]> {
    if (this.running) return [];
    this.running = true;
    const ran: string[] = [];
    try {
      const { tape, soso } = this.deps;
      const used = tape.usage(this.now);
      if (used >= STOP_AT) return ran;
      const stretch = used >= SLOW_DOWN_AT ? 4 : 1;
      const due = this.jobs
        .map((job) => {
          const at = Math.max(tape.get(job.key)?.at ?? 0, this.attempted.get(job.key) ?? 0);
          return { job, overdue: (this.now - at) / (job.every(this.now) * stretch) };
        })
        .filter((d) => d.overdue >= 1)
        .sort((a, b) => b.overdue - a.overdue)
        .slice(0, maxJobs);
      for (const { job } of due) {
        const before = soso.requestsThisMonth;
        this.attempted.set(job.key, this.now);
        try {
          await job.run(this.now);
          ran.push(job.key);
        } catch (err) {
          log.warn(`Tape: ${job.key} refresh failed; keeping the last copy`, err);
        } finally {
          tape.addUsage(soso.requestsThisMonth - before, this.now);
        }
      }
      return ran;
    } finally {
      this.running = false;
    }
  }
}

/** US regular hours, Monday to Friday 9:30–16:00 New York time (holidays not counted). */
export function usMarketOpen(now: number): boolean {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(new Date(now));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  if (get('weekday') === 'Sat' || get('weekday') === 'Sun') return false;
  const minutes = (Number(get('hour')) % 24) * 60 + Number(get('minute'));
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

/** Weekdays 12:00–20:30 UTC: when US macro numbers (8:30, 10:00, 14:00 New York) come out. */
function inReleaseWindow(now: number): boolean {
  const d = new Date(now);
  const day = d.getUTCDay();
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  return day >= 1 && day <= 5 && minutes >= 12 * 60 && minutes <= 20 * 60 + 30;
}
