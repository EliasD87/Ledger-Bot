/**
 * SoSoValue OpenAPI client (https://sosovalue.gitbook.io/soso-value-api-doc).
 *
 * The plan allows 20 requests a minute and 100,000 a month per key. Requests go through a
 * one-minute sliding window with two lanes: chat lookups may use up to `perMinute`, background
 * jobs (like the treasury scan) only `backgroundPerMinute`, so they never make a member wait.
 * Responses are cached per URL for as long as the data can't change.
 */

const MINUTE = 60_000;

export interface EtfDay {
  date: string;
  totalNetInflow: number | null;
  totalValueTraded: number | null;
  totalNetAssets: number | null;
  cumNetInflow: number | null;
}

export interface EtfTickerDay {
  date: string;
  ticker: string;
  netInflow: number | null;
  netAssets: number | null;
}

export interface EtfListing {
  ticker: string;
  name: string;
}

export interface MacroDay {
  date: string;
  events: string[];
}

export interface MacroRelease {
  date: string;
  actual: string;
  forecast: string;
  previous: string;
}

export interface FomcOutlook {
  /** Basis-point ranges, e.g. "350-375" = 3.50%–3.75%. */
  rateRanges: string[];
  meetings: { meetingDate: string; probabilities: (number | null)[] }[];
}

export interface TreasuryCompany {
  ticker: string;
  name: string;
}

export interface TreasuryPurchase {
  date: string;
  ticker: string;
  btcHolding: number;
  btcAcquired: number;
  costUsd: number;
}

export interface NewsItem {
  title: string;
  link: string;
  releasedAt: number;
}

export interface MarketOverview {
  totalMarketCap: number | null;
  marketCapChangePct: number | null;
  volume24h: number | null;
}

export interface SectorMove {
  name: string;
  /** Fraction: -0.0012 = -0.12%. */
  change24h: number;
}

export interface StockQuote {
  ticker: string;
  last: number;
  prevClose: number | null;
  /** Percent: 1.82 = +1.82% on the day. */
  changePct: number | null;
  marketCap: number | null;
  high52w: number | null;
  low52w: number | null;
  /** e.g. TRADING, CLOSED, PRE_MARKET. */
  marketStatus: string;
  asOf: string;
}

export class SoSoValueError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
  ) {
    super(message);
  }
}

type Lane = 'chat' | 'background';

export class SoSoValue {
  private readonly calls: number[] = [];
  private readonly cache = new Map<string, { at: number; value: unknown }>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private monthKey = '';
  private monthCount = 0;

  constructor(
    private readonly apiKey: string,
    private readonly opts: { baseUrl?: string; perMinute?: number; backgroundPerMinute?: number } = {},
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** Requests made this calendar month (since this process started). */
  get requestsThisMonth(): number {
    return this.monthCount;
  }

  // --- ETFs ---

  /** Daily totals for a country's spot ETFs on one asset, newest first (last ~month). */
  etfFlows(symbol: string, country = 'US', limit = 10): Promise<EtfDay[]> {
    return this.cached(60 * MINUTE, '/openapi/v1/etfs/summary-history', { symbol, country_code: country, limit }, (rows) =>
      asArray(rows)
        .map((r) => ({
          date: str(r.date),
          totalNetInflow: num(r.total_net_inflow),
          totalValueTraded: num(r.total_value_traded),
          totalNetAssets: num(r.total_net_assets),
          cumNetInflow: num(r.cum_net_inflow),
        }))
        .sort((a, b) => b.date.localeCompare(a.date)),
    );
  }

  etfListings(symbol: string, country = 'US'): Promise<EtfListing[]> {
    return this.cached(24 * 60 * MINUTE, '/openapi/v1/etfs', { symbol, country_code: country }, (rows) =>
      asArray(rows).map((r) => ({ ticker: str(r.ticker), name: str(r.name) })),
    );
  }

  /** One ETF's daily rows, newest first. Today's row has null flows until it settles (T+1). */
  etfHistory(ticker: string): Promise<EtfTickerDay[]> {
    return this.cached(2 * 60 * MINUTE, `/openapi/v1/etfs/${encodeURIComponent(ticker)}/history`, {}, (rows) =>
      asArray(rows)
        .map((r) => ({ date: str(r.date), ticker: str(r.ticker) || ticker, netInflow: num(r.net_inflow), netAssets: num(r.net_assets) }))
        .sort((a, b) => b.date.localeCompare(a.date)),
    );
  }

  // --- macro ---

  macroCalendar(): Promise<MacroDay[]> {
    return this.cached(30 * MINUTE, '/openapi/v1/macro/events', {}, (rows) =>
      asArray(rows).map((r) => ({ date: str(r.date), events: Array.isArray(r.events) ? r.events.map(String) : [] })),
    );
  }

  /** Releases of one macro event, newest first. Unreleased values are "". */
  macroHistory(event: string, limit = 3): Promise<MacroRelease[]> {
    return this.cached(10 * MINUTE, `/openapi/v1/macro/events/${encodeURIComponent(event)}/history`, { limit }, (rows) =>
      asArray(rows).map((r) => ({ date: str(r.date), actual: str(r.actual), forecast: str(r.forecast), previous: str(r.previous) })),
    );
  }

  fomcOutlook(): Promise<FomcOutlook> {
    return this.cached(60 * MINUTE, '/openapi/v1/macro/fomc-probabilities', {}, (body) => {
      const o = asObject(body);
      return {
        rateRanges: Array.isArray(o.rate_ranges) ? o.rate_ranges.map(String) : [],
        meetings: asArray(o.meetings).map((m) => ({
          meetingDate: str(m.meeting_date),
          probabilities: Array.isArray(m.probabilities) ? m.probabilities.map((p: unknown) => num(p)) : [],
        })),
      };
    });
  }

  // --- BTC treasuries ---

  treasuryCompanies(): Promise<TreasuryCompany[]> {
    return this.cached(12 * 60 * MINUTE, '/openapi/v1/btc-treasuries', {}, (rows) =>
      asArray(rows).map((r) => ({ ticker: str(r.ticker), name: str(r.name) })),
    );
  }

  treasuryPurchases(ticker: string, limit = 3, lane: Lane = 'chat'): Promise<TreasuryPurchase[]> {
    return this.cached(
      6 * 60 * MINUTE,
      `/openapi/v1/btc-treasuries/${encodeURIComponent(ticker)}/purchase-history`,
      { limit },
      (rows) =>
        asArray(rows)
          .map((r) => ({
            date: str(r.date),
            ticker: str(r.ticker) || ticker,
            btcHolding: num(r.btc_holding) ?? 0,
            btcAcquired: num(r.btc_acq) ?? 0,
            costUsd: num(r.acq_cost) ?? 0,
          }))
          .sort((a, b) => b.date.localeCompare(a.date)),
      lane,
    );
  }

  // --- news ---

  hotNews(limit = 8): Promise<NewsItem[]> {
    return this.cached(5 * MINUTE, '/openapi/v1/news/hot', { page: 1, page_size: limit, language: 'en' }, newsList);
  }

  coinNews(currencyId: string, limit = 6): Promise<NewsItem[]> {
    return this.cached(5 * MINUTE, '/openapi/v1/news', { currency_id: currencyId, page: 1, page_size: limit, language: 'en' }, newsList);
  }

  /** SoSoValue's id for a coin symbol like "SOL", or null if it doesn't know the coin. */
  async currencyId(symbol: string): Promise<string | null> {
    const all = await this.cached(24 * 60 * MINUTE, '/openapi/v1/currencies', {}, (rows) =>
      asArray(rows).map((r) => ({ id: str(r.currency_id), symbol: str(r.symbol).toUpperCase() })),
    );
    return all.find((c) => c.symbol === symbol.toUpperCase())?.id ?? null;
  }

  // --- market ---

  marketOverview(): Promise<MarketOverview> {
    return this.cached(MINUTE, '/openapi/v1/market/overview', {}, (body) => {
      const o = asObject(body);
      return {
        totalMarketCap: num(o.total_market_cap),
        marketCapChangePct: num(o.total_market_cap_change_pct),
        volume24h: num(o.total_volume_24h),
      };
    });
  }

  /** Sector moves over 24h, plus "spotlight" themes. */
  sectors(): Promise<{ sectors: SectorMove[]; spotlight: SectorMove[] }> {
    return this.cached(5 * MINUTE, '/openapi/v1/currencies/sector-spotlight', {}, (body) => {
      const o = asObject(body);
      const moves = (list: unknown) => asArray(list).map((s) => ({ name: str(s.name), change24h: num(s.change_pct_24h) ?? 0 }));
      return { sectors: moves(o.sector), spotlight: moves(o.spotlight) };
    });
  }

  // --- US equities (Market Data API v3) ---

  /** Latest quotes for up to 50 US tickers ("NVDA", "MSTR"…), keyed by ticker. Unknown tickers are left out. */
  async stockQuotes(tickers: string[]): Promise<Record<string, StockQuote>> {
    const refs = [...new Set(tickers.map((t) => `${t.trim().toUpperCase().replace(/\.US$/, '')}.US`))].slice(0, 50);
    if (!refs.length) return {};
    return this.cached(MINUTE, '/openapi/v3/quotes', { refs: refs.join(',') }, (data) => {
      const quotes = asObject(asObject(data).quotes);
      const out: Record<string, StockQuote> = {};
      for (const [ref, raw] of Object.entries(quotes)) {
        const q = asObject(raw);
        const last = num(q.last);
        if (last === null) continue;
        out[ref.replace(/\.US$/, '')] = {
          ticker: ref.replace(/\.US$/, ''),
          last,
          prevClose: num(q.prev_close),
          changePct: num(q.change_pct),
          marketCap: num(q.market_cap),
          high52w: num(q.high_52w),
          low52w: num(q.low_52w),
          marketStatus: str(q.market_status),
          asOf: str(q.as_of),
        };
      }
      return out;
    });
  }

  /** Daily candles for a US ticker, newest first. */
  stockDailyCandles(ticker: string, limit = 30): Promise<{ date: string; open: number; high: number; low: number; close: number }[]> {
    const ref = `${ticker.trim().toUpperCase().replace(/\.US$/, '')}.US`;
    return this.cached(15 * MINUTE, `/openapi/v3/instruments/${encodeURIComponent(ref)}/candles`, { interval: '1d', limit }, (data) =>
      asArray(asObject(data).candles).map((c) => ({
        date: str(c.trade_date),
        open: num(c.open) ?? 0,
        high: num(c.high) ?? 0,
        low: num(c.low) ?? 0,
        close: num(c.close) ?? 0,
      })),
    );
  }

  // --- plumbing ---

  /**
   * Cached GET. Fresh hits return at once. Stale hits also return at once while a background refresh
   * runs, so members never wait on data the bot has fetched before; only the very first fetch of a
   * URL blocks. Concurrent fetches of one URL share a single request.
   */
  private async cached<T>(
    ttlMs: number,
    path: string,
    params: Record<string, string | number>,
    parse: (data: unknown) => T,
    lane: Lane = 'chat',
  ): Promise<T> {
    const url = new URL(path, this.opts.baseUrl ?? 'https://openapi.sosovalue.com');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const key = url.toString();
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < ttlMs) return hit.value as T;
    if (hit) {
      void this.fetchInto(key, url, parse, 'background').catch(() => {}); // stale: refresh quietly, answer now
      return hit.value as T;
    }
    return this.fetchInto(key, url, parse, lane);
  }

  private fetchInto<T>(key: string, url: URL, parse: (data: unknown) => T, lane: Lane): Promise<T> {
    let pending = this.inFlight.get(key) as Promise<T> | undefined;
    if (!pending) {
      pending = this.request(url, lane)
        .then((data) => {
          const value = parse(data);
          this.cache.set(key, { at: this.now(), value });
          if (this.cache.size > 2000) this.cache.delete(this.cache.keys().next().value!);
          return value;
        })
        .finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, pending);
    }
    return pending;
  }

  private async request(url: URL, lane: Lane, attempt = 1): Promise<unknown> {
    await this.slot(lane);
    const res = await this.fetchImpl(url, {
      headers: { 'x-soso-api-key': this.apiKey, accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    // The per-minute limit is per key, so anything else using the key (a script, another copy of the bot)
    // can use up the minute. Wait as long as SoSoValue asks, then try again.
    if (res.status === 429 && attempt < 3) {
      const details = body?.details as { retry_after?: unknown } | undefined;
      const resetAt = num(res.headers.get('x-ratelimit-reset'));
      const waitMs = num(details?.retry_after) !== null ? num(details?.retry_after)! * 1000 : resetAt ? resetAt - this.now() : 30_000;
      await new Promise((r) => setTimeout(r, Math.min(Math.max(waitMs, 1000), 65_000)));
      return this.request(url, lane, attempt + 1);
    }
    if (!res.ok) {
      const message = typeof body?.message === 'string' ? body.message : `HTTP ${res.status}`;
      throw new SoSoValueError(`SoSoValue ${url.pathname}: ${message}`, res.status, num(body?.code) ?? undefined);
    }
    // The docs describe a {code, message, data} wrapper, but many examples are unwrapped. Accept both.
    if (body && typeof body === 'object' && !Array.isArray(body) && 'code' in body && 'data' in body) {
      if (body.code !== 0) throw new SoSoValueError(`SoSoValue ${url.pathname}: ${String(body.message)}`, res.status, num(body.code) ?? undefined);
      return body.data;
    }
    return body;
  }

  /** Waits until the one-minute window has room for this lane, then records the call. */
  private async slot(lane: Lane): Promise<void> {
    const limit = lane === 'chat' ? (this.opts.perMinute ?? 18) : (this.opts.backgroundPerMinute ?? 8);
    for (;;) {
      const t = this.now();
      while (this.calls.length && t - this.calls[0]! >= MINUTE) this.calls.shift();
      if (this.calls.length < limit) {
        this.calls.push(t);
        this.countMonth(t);
        return;
      }
      await new Promise((r) => setTimeout(r, this.calls[0]! + MINUTE - t + 50));
    }
  }

  private countMonth(t: number): void {
    const key = new Date(t).toISOString().slice(0, 7);
    if (key !== this.monthKey) {
      this.monthKey = key;
      this.monthCount = 0;
    }
    this.monthCount++;
  }
}

function newsList(data: unknown): NewsItem[] {
  const o = asObject(data);
  return asArray(Array.isArray(data) ? data : o.list)
    .map((n) => ({
      title: str(n.title) || stripHtml(str(n.content)).slice(0, 140),
      link: str(n.source_link) || str(n.original_link),
      releasedAt: num(n.release_time) ?? 0,
    }))
    .filter((n) => n.title);
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

type Row = Record<string, any>;

function asArray(value: unknown): Row[] {
  return Array.isArray(value) ? (value.filter((v) => v && typeof v === 'object') as Row[]) : [];
}

function asObject(value: unknown): Row {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
}

function str(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

/** Numbers arrive as numbers or numeric strings; "" and null mean "no value". */
export function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[%,]/g, ''));
  return Number.isFinite(n) ? n : null;
}
