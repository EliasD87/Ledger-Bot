import { type BinanceFeed, normalizeAsset } from '../calls/prices.js';
import { log } from '../log.js';
import type { Close } from './stats.js';

const MINUTE = 60_000;
const UA = { 'user-agent': 'Mozilla/5.0 (Ledger Discord bot)', accept: 'application/json' };

export type AssetKind = 'crypto' | 'stock';

export interface Asset {
  symbol: string;
  kind: AssetKind;
  /** Exchange pair for crypto, e.g. "SOLUSDT". */
  pair?: string;
}

export interface History {
  asset: Asset;
  /** Daily closes, oldest first; the last one is today's so far. */
  closes: Close[];
  source: string;
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Daily price history for any crypto (Binance, then Bybit) or US stock or ETF (Yahoo, then Nasdaq),
 * cached for half an hour. None of it touches SoSoValue's quota.
 */
export class MarketHistory {
  private readonly cache = new Map<string, { history: History; at: number }>();

  constructor(
    private readonly deps: {
      resolve: (asset: string) => Promise<string | null>;
      binance: Pick<BinanceFeed, 'candles'>;
      fetchImpl?: typeof fetch;
      now?: () => number;
    },
  ) {}

  private get now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Crypto if there's a USDT market for it, otherwise a US stock or ETF ticker. */
  async identify(raw: string, hint?: AssetKind): Promise<Asset | null> {
    const symbol = normalizeAsset(raw);
    if (!symbol) return null;
    if (hint !== 'stock') {
      const pair = await this.deps.resolve(symbol).catch(() => null);
      if (pair) return { symbol, kind: 'crypto', pair };
      if (hint === 'crypto') return null;
    }
    return { symbol, kind: 'stock' };
  }

  async daily(asset: Asset): Promise<History | null> {
    const key = `${asset.kind}:${asset.symbol}`;
    const cached = this.cache.get(key);
    if (cached && this.now - cached.at < 30 * MINUTE) return cached.history;
    const sources = asset.kind === 'crypto' ? [() => this.binance(asset), () => this.bybit(asset)] : [() => this.yahoo(asset), () => this.nasdaq(asset)];
    for (const source of sources) {
      try {
        const history = await source();
        if (history && history.closes.length >= 30) {
          this.cache.set(key, { history, at: this.now });
          return history;
        }
      } catch (err) {
        log.debug(`History for ${asset.symbol} from one source failed; trying the next`, err);
      }
    }
    return null;
  }

  private async getJson(url: string): Promise<unknown> {
    const res = await (this.deps.fetchImpl ?? fetch)(url, { headers: UA, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`${new URL(url).host} returned HTTP ${res.status}`);
    return res.json();
  }

  private async binance(asset: Asset): Promise<History> {
    const candles = await this.deps.binance.candles(asset.pair!, '1d', { limit: 1000 });
    return { asset, closes: candles.map((c) => ({ date: isoDay(c.openTime), close: c.close })), source: 'Binance' };
  }

  private async bybit(asset: Asset): Promise<History> {
    const body = (await this.getJson(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${asset.pair}&interval=D&limit=1000`)) as { result?: { list?: string[][] } };
    const rows = [...(body.result?.list ?? [])].reverse();
    return { asset, closes: rows.map((r) => ({ date: isoDay(Number(r[0])), close: Number(r[4]) })).filter((c) => c.close > 0), source: 'Bybit' };
  }

  private async yahoo(asset: Asset): Promise<History> {
    const body = (await this.getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(asset.symbol)}?range=5y&interval=1d`)) as {
      chart?: { result?: { timestamp?: number[]; indicators?: { quote?: { close?: (number | null)[] }[] } }[] };
    };
    const r = body.chart?.result?.[0];
    const closes = (r?.timestamp ?? []).flatMap((t, i) => {
      const close = r?.indicators?.quote?.[0]?.close?.[i];
      return close ? [{ date: isoDay(t * 1000), close }] : [];
    });
    return { asset, closes, source: 'Yahoo Finance' };
  }

  private async nasdaq(asset: Asset): Promise<History> {
    const from = isoDay(this.now - 5 * 365 * 86_400_000);
    const body = (await this.getJson(
      `https://api.nasdaq.com/api/quote/${encodeURIComponent(asset.symbol)}/historical?assetclass=stocks&fromdate=${from}&todate=${isoDay(this.now)}&limit=9999`,
    )) as { data?: { tradesTable?: { rows?: { date: string; close: string }[] } } | null };
    const rows = [...(body.data?.tradesTable?.rows ?? [])].reverse();
    const closes = rows.flatMap((r) => {
      const [m, d, y] = r.date.split('/');
      const close = Number(r.close.replace(/[$,]/g, ''));
      return y && close > 0 ? [{ date: `${y}-${m!.padStart(2, '0')}-${d!.padStart(2, '0')}`, close }] : [];
    });
    return { asset, closes, source: 'Nasdaq' };
  }
}
