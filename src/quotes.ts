import { yahooSymbol } from './analysis/commodities.js';
import { type BinanceFeed, type CryptoStats, normalizeAsset } from './calls/prices.js';
import { type StoredDesk, usMarketOpen } from './desk/tape.js';
import { log } from './log.js';
import type { StockQuote } from './sosovalue.js';

const MINUTE = 60_000;
const UA = { 'user-agent': 'Mozilla/5.0 (Ledger Discord bot)', accept: 'application/json' };

async function getJson(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  const res = await fetchImpl(url, { headers: UA, signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`${new URL(url).host} returned HTTP ${res.status}`);
  return res.json();
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(/[$,%\s]/g, '')) : NaN;
  return Number.isFinite(n) ? n : null;
};

/**
 * Crypto prices with backups: Binance first, then OKX, then Bybit, so one exchange's outage or block
 * never leaves members without a price.
 */
export class CryptoQuotes {
  constructor(
    private readonly binance: Pick<BinanceFeed, 'resolve' | 'stats24h'>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** "BTCUSDT" for BTC. If Binance can't be asked, assume the usual USDT pair and let the backups answer. */
  async resolve(asset: string): Promise<string | null> {
    try {
      return await this.binance.resolve(asset);
    } catch {
      const base = normalizeAsset(asset);
      return base ? `${base}USDT` : null;
    }
  }

  async stats24h(symbols: string[]): Promise<Record<string, CryptoStats>> {
    try {
      return await this.binance.stats24h(symbols);
    } catch (err) {
      log.warn('Binance 24h prices failed; trying OKX and Bybit', err);
    }
    const out: Record<string, CryptoStats> = {};
    for (const symbol of symbols) {
      const stats = (await this.okx(symbol).catch(() => null)) ?? (await this.bybit(symbol).catch(() => null));
      if (stats) out[symbol] = stats;
    }
    if (!Object.keys(out).length) throw new Error('No crypto price source answered');
    return out;
  }

  private async okx(symbol: string): Promise<CryptoStats | null> {
    const body = (await getJson(this.fetchImpl, `https://www.okx.com/api/v5/market/ticker?instId=${symbol.replace(/USDT$/, '')}-USDT`)) as { data?: Record<string, string>[] };
    const t = body.data?.[0];
    const price = num(t?.last);
    const open = num(t?.open24h);
    if (!t || price === null || !open) return null;
    return { price, change: price / open - 1, high: num(t.high24h) ?? price, low: num(t.low24h) ?? price, volumeUsd: num(t.volCcy24h) ?? 0, source: 'OKX' };
  }

  private async bybit(symbol: string): Promise<CryptoStats | null> {
    const body = (await getJson(this.fetchImpl, `https://api.bybit.com/v5/market/tickers?category=spot&symbol=${symbol}`)) as { result?: { list?: Record<string, string>[] } };
    const t = body.result?.list?.[0];
    const price = num(t?.lastPrice);
    const prev = num(t?.prevPrice24h);
    if (!t || price === null || !prev) return null;
    return { price, change: price / prev - 1, high: num(t.highPrice24h) ?? price, low: num(t.lowPrice24h) ?? price, volumeUsd: num(t.turnover24h) ?? 0, source: 'Bybit' };
  }
}

export type SourcedQuote = StockQuote & { source: string };

/**
 * US stock quotes without asking SoSoValue during a chat: the background fetcher's stored batch when
 * it's fresh, then Yahoo, then Nasdaq, then the stored batch even if it's old (dated, so it reads as such).
 */
export class StockQuotes {
  constructor(
    private readonly stored: Pick<StoredDesk, 'stocks'> | null,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async stockQuotes(tickers: string[]): Promise<Record<string, SourcedQuote>> {
    const batch = this.stored?.stocks() ?? null;
    const open = usMarketOpen(this.now());
    const fresh = batch !== null && this.now() - batch.at <= (open ? 10 * MINUTE : 12 * 60 * MINUTE);
    const out: Record<string, SourcedQuote> = {};
    for (const raw of [...new Set(tickers.map((t) => t.trim().toUpperCase().replace(/^\$/, '').replace(/\.US$/, '')))]) {
      const kept = batch?.value[raw];
      if (fresh && kept) {
        out[raw] = { ...kept, source: 'SoSoValue' };
        continue;
      }
      const live = (await this.yahoo(raw, open).catch(() => null)) ?? (await this.nasdaq(raw, open).catch(() => null));
      if (live) out[raw] = live;
      else if (kept) out[raw] = { ...kept, source: 'SoSoValue (last stored)' };
    }
    return out;
  }

  private async yahoo(ticker: string, open: boolean): Promise<SourcedQuote | null> {
    const body = (await getJson(this.fetchImpl, `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol(ticker))}?range=1d&interval=1d`)) as {
      chart?: { result?: { meta?: Record<string, unknown> }[] };
    };
    const m = body.chart?.result?.[0]?.meta;
    const last = num(m?.regularMarketPrice);
    if (!m || last === null || m.instrumentType === 'CRYPTOCURRENCY') return null;
    const prevClose = num(m.chartPreviousClose) ?? num(m.previousClose);
    return {
      ticker,
      last,
      prevClose,
      changePct: prevClose ? (last / prevClose - 1) * 100 : num(m.regularMarketChangePercent),
      marketCap: null,
      high52w: num(m.fiftyTwoWeekHigh),
      low52w: num(m.fiftyTwoWeekLow),
      marketStatus: open ? 'TRADING' : 'CLOSED',
      asOf: new Date((num(m.regularMarketTime) ?? this.now() / 1000) * 1000).toISOString(),
      source: 'Yahoo Finance',
    };
  }

  private async nasdaq(ticker: string, open: boolean): Promise<SourcedQuote | null> {
    for (const assetclass of ['stocks', 'etf']) {
      const body = (await getJson(this.fetchImpl, `https://api.nasdaq.com/api/quote/${encodeURIComponent(ticker)}/info?assetclass=${assetclass}`)) as {
        data?: { primaryData?: Record<string, string>; keyStats?: { fiftyTwoWeekHighLow?: { value?: string } } } | null;
      };
      const p = body.data?.primaryData;
      const last = num(p?.lastSalePrice);
      if (!p || last === null) continue;
      const change = num(p.netChange);
      const [low52w, high52w] = (body.data?.keyStats?.fiftyTwoWeekHighLow?.value ?? '').split('-').map((s) => num(s));
      return {
        ticker,
        last,
        prevClose: change !== null ? last - change : null,
        changePct: num(p.percentageChange),
        marketCap: null,
        high52w: high52w ?? null,
        low52w: low52w ?? null,
        marketStatus: open ? 'TRADING' : 'CLOSED',
        asOf: new Date(this.now()).toISOString(),
        source: 'Nasdaq',
      };
    }
    return null;
  }
}
