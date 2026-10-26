import { type BinanceFeed, normalizeAsset } from '../calls/prices.js';
import { log } from '../log.js';
import { commodity, yahooSymbol } from './commodities.js';
import type { Close } from './stats.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** US listings in Yahoo's search results: Nasdaq, NYSE, NYSE American and Arca, Cboe BZX. */
const US_EXCHANGES = new Set(['NMS', 'NGM', 'NCM', 'NAS', 'NYQ', 'NYS', 'ASE', 'PCX', 'BTS']);
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

  /**
   * What a member means: a crypto ticker with a USDT market, else a US stock or ETF. Names and tickers
   * the code doesn't know ("nvidia", "spacex", "c3 ai", "dogecoin") are looked up on Yahoo's search.
   */
  async identify(raw: string, hint?: AssetKind): Promise<Asset | null> {
    const typed = raw.trim().replace(/^\$/, '');
    // Oil, gold and friends first: "CL" means crude here, not Colgate.
    const c = hint !== 'crypto' ? commodity(typed) : null;
    if (c) return { symbol: c.symbol, kind: 'stock' };
    const symbol = normalizeAsset(typed);
    if (symbol && hint !== 'stock') {
      const pair = await this.deps.resolve(symbol).catch(() => null);
      if (pair) return { symbol, kind: 'crypto', pair };
    }
    const found = await this.lookup(typed);
    if (found?.kind === 'crypto' && hint !== 'stock') {
      const pair = await this.deps.resolve(found.symbol).catch(() => null);
      if (pair) return { symbol: found.symbol, kind: 'crypto', pair };
    }
    if (hint === 'crypto') return null;
    if (found?.kind === 'stock') return found;
    return symbol ? { symbol, kind: 'stock' } : null;
  }

  private readonly lookups = new Map<string, { asset: Asset | null; at: number }>();

  /** The best US listing or coin for a name or ticker, from Yahoo's search; cached for a day. */
  private async lookup(query: string): Promise<Asset | null> {
    const key = query.toLowerCase();
    const cached = this.lookups.get(key);
    if (cached && this.now - cached.at < DAY) return cached.asset;
    let asset: Asset | null = null;
    try {
      const body = (await this.getJson(
        `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=6&newsCount=0`,
      )) as { quotes?: { symbol?: string; quoteType?: string; exchange?: string }[] };
      const candidates = (body.quotes ?? []).flatMap((q): Asset[] => {
        if (!q.symbol) return [];
        if ((q.quoteType === 'EQUITY' || q.quoteType === 'ETF') && US_EXCHANGES.has(q.exchange ?? '')) return [{ symbol: q.symbol, kind: 'stock' }];
        if (q.quoteType === 'CRYPTOCURRENCY' && q.symbol.endsWith('-USD')) return [{ symbol: q.symbol.slice(0, -4), kind: 'crypto' }];
        return [];
      });
      // An exact ticker match wins. A short, ticker-like query ("ton") takes nothing else: Yahoo's fuzzy
      // match for it (Tonix, TNXP) is a different company. Names ("nvidia", "spacex") take the top result.
      const exact = query.toUpperCase();
      asset = candidates.find((c) => c.symbol === exact) ?? (query.trim().length <= 4 ? null : (candidates[0] ?? null));
    } catch (err) {
      log.debug(`Name lookup for "${query}" failed`, err);
      return null; // not cached: try again next time
    }
    this.lookups.set(key, { asset, at: this.now });
    return asset;
  }

  async daily(asset: Asset): Promise<History | null> {
    const key = `${asset.kind}:${asset.symbol}`;
    const cached = this.cache.get(key);
    if (cached && this.now - cached.at < 30 * MINUTE) return cached.history;
    const sources = asset.kind === 'crypto' ? [() => this.binance(asset), () => this.bybit(asset)] : [() => this.yahoo(asset), () => this.nasdaq(asset)];
    let best: History | null = null;
    for (const source of sources) {
      try {
        const history = await source();
        if (history && history.closes.length >= 30 && history.closes.length > (best?.closes.length ?? 0)) best = history;
        // A year or more is plenty; a short one (a renamed coin, say) is worth checking the next source for.
        if (best && best.closes.length >= 400) break;
      } catch (err) {
        log.debug(`History for ${asset.symbol} from one source failed; trying the next`, err);
      }
    }
    if (best) this.cache.set(key, { history: best, at: this.now });
    return best;
  }

  /** Hourly prices over the last `days` (up to 41), for short-window charts. Oldest first, as timestamps. */
  async hourly(asset: Asset, days: number): Promise<{ points: { t: number; v: number }[]; source: string } | null> {
    const hours = Math.min(1000, Math.max(24, Math.round(days * 24)));
    const tries =
      asset.kind === 'crypto'
        ? [
            async () => ({
              points: (await this.deps.binance.candles(asset.pair!, '1h', { limit: hours })).map((c) => ({ t: c.openTime, v: c.close })),
              source: 'Binance',
            }),
            async () => {
              const body = (await this.getJson(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${asset.pair}&interval=60&limit=${hours}`)) as {
                result?: { list?: string[][] };
              };
              return { points: [...(body.result?.list ?? [])].reverse().map((r) => ({ t: Number(r[0]), v: Number(r[4]) })), source: 'Bybit' };
            },
          ]
        : [
            async () => {
              const range = days <= 5 ? '5d' : days <= 30 ? '1mo' : '3mo';
              const interval = days <= 2 ? '5m' : '60m';
              const body = (await this.getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol(asset.symbol))}?range=${range}&interval=${interval}`)) as {
                chart?: { result?: { timestamp?: number[]; indicators?: { quote?: { close?: (number | null)[] }[] } }[] };
              };
              const r = body.chart?.result?.[0];
              // Counted back from the last trade, so a weekend or holiday still shows the latest sessions.
              const from = ((r?.timestamp ?? []).at(-1) ?? this.now / 1000) * 1000 - days * DAY;
              const points = (r?.timestamp ?? []).flatMap((t, i) => {
                const v = r?.indicators?.quote?.[0]?.close?.[i];
                return v && t * 1000 >= from ? [{ t: t * 1000, v }] : [];
              });
              return { points, source: 'Yahoo Finance' };
            },
          ];
    for (const attempt of tries) {
      try {
        const result = await attempt();
        if (result.points.filter((p) => p.v > 0).length >= 6) return { ...result, points: result.points.filter((p) => p.v > 0) };
      } catch (err) {
        log.debug(`Hourly prices for ${asset.symbol} from one source failed`, err);
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
    const body = (await this.getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol(asset.symbol))}?range=5y&interval=1d`)) as {
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
