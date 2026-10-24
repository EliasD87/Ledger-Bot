
export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface CryptoStats {
  price: number;
  /** Over the last 24h, as a fraction: −0.053 = −5.3%. */
  change: number;
  high: number;
  low: number;
  volumeUsd: number;
  /** Where the numbers came from when it wasn't Binance. */
  source?: string;
}

const HOUR = 60 * 60 * 1000;

/** Common names people type instead of tickers. */
const ALIASES: Record<string, string> = { BITCOIN: 'BTC', XBT: 'BTC', ETHEREUM: 'ETH', SOLANA: 'SOL' };

/** Turns "$btc", "eth/usdt" or "Solana" into a base ticker like "BTC", or null if it can't be one. */
export function normalizeAsset(input: string): string | null {
  let s = input.trim().toUpperCase().replace(/^\$/, '');
  const pair = /^([A-Z0-9]+?)[\s/-]?(USDT|USD)$/.exec(s);
  if (pair && pair[1]!.length >= 2) s = pair[1]!;
  s = ALIASES[s] ?? s;
  return /^[A-Z0-9]{2,15}$/.test(s) ? s : null;
}

/**
 * Spot prices, candles and volatility for USDT pairs from Binance's public market-data API
 * (no key needed). `data-api.binance.vision` serves market data only; if it's unreachable from
 * the server, point PRICE_FEED_URL at https://api.binance.com.
 */
export class BinanceFeed {
  private symbols: { set: Set<string>; at: number } | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** The Binance symbol for an asset (e.g. "BTCUSDT"), or null if there's no live USDT market. */
  async resolve(asset: string): Promise<string | null> {
    const base = normalizeAsset(asset);
    if (!base) return null;
    const symbol = `${base}USDT`;
    return (await this.tradingSymbols()).has(symbol) ? symbol : null;
  }

  async spot(symbol: string): Promise<number> {
    const data = await this.get<{ price: string }>('/api/v3/ticker/price', { symbol });
    return Number(data.price);
  }

  async candles(
    symbol: string,
    interval: '1m' | '1h' | '1d',
    range: { startTime?: number; endTime?: number; limit?: number } = {},
  ): Promise<Candle[]> {
    const rows = await this.get<(string | number)[][]>('/api/v3/klines', { symbol, interval, ...range });
    return rows.map((r) => ({
      openTime: Number(r[0]),
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
    }));
  }

  /** Price and change over the last 24h for several symbols in one request. Change is a fraction (−0.053 = −5.3%). */
  async change24h(symbols: string[]): Promise<Record<string, { price: number; change: number }>> {
    const rows = await this.get<{ symbol: string; lastPrice: string; openPrice: string }[]>('/api/v3/ticker/24hr', {
      symbols: JSON.stringify(symbols),
    });
    return Object.fromEntries(
      rows.map((r) => [r.symbol, { price: Number(r.lastPrice), change: Number(r.lastPrice) / Number(r.openPrice) - 1 }]),
    );
  }

  /** The 24h board for several symbols in one request: last price, change (a fraction), range and USD volume. */
  async stats24h(symbols: string[]): Promise<Record<string, CryptoStats>> {
    const rows = await this.get<{ symbol: string; lastPrice: string; openPrice: string; highPrice: string; lowPrice: string; quoteVolume: string }[]>(
      '/api/v3/ticker/24hr',
      { symbols: JSON.stringify(symbols) },
    );
    return Object.fromEntries(
      rows.map((r) => [
        r.symbol,
        {
          price: Number(r.lastPrice),
          change: Number(r.lastPrice) / Number(r.openPrice) - 1,
          high: Number(r.highPrice),
          low: Number(r.lowPrice),
          volumeUsd: Number(r.quoteVolume),
        },
      ]),
    );
  }

  private async tradingSymbols(): Promise<Set<string>> {
    if (this.symbols && this.now() - this.symbols.at < 6 * HOUR) return this.symbols.set;
    const info = await this.get<{ symbols: { symbol: string; quoteAsset: string }[] }>('/api/v3/exchangeInfo', {
      symbolStatus: 'TRADING',
      showPermissionSets: 'false',
    });
    const set = new Set(info.symbols.filter((s) => s.quoteAsset === 'USDT').map((s) => s.symbol));
    this.symbols = { set, at: this.now() };
    return set;
  }

  private async get<T>(path: string, params: Record<string, string | number | undefined>): Promise<T> {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      const hint = res.status === 451 ? ' (blocked in this region; try another PRICE_FEED_URL)' : '';
      throw new Error(`Binance ${path} returned HTTP ${res.status}${hint}`);
    }
    return (await res.json()) as T;
  }
}
