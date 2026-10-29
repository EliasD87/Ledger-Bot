import type { CryptoStats } from './prices.js';

/** One market's 24h numbers as SoDEX sends them (strings, as on the wire). */
interface SoDexTicker {
  symbol: string;
  lastPx: string;
}

type Kind = 'perps' | 'spot';

const BASE = 'https://mainnet-gw.sodex.dev/api/v1';
const MINUTE = 60_000;

/**
 * SoDEX's public market data (no key): one more price layer after Binance, OKX and Bybit, and one more
 * source of daily closes. Only prices are taken: its 24h change, range, volume, funding and open interest
 * describe SoDEX's own market, not the coin's. One request returns every market's ticker, kept for a
 * minute, so a busy chat costs a request a minute at most (SoDEX allows 1,200 weight a minute per IP).
 */
export class SoDex {
  private readonly tickers = new Map<Kind, { rows: SoDexTicker[]; at: number }>();

  constructor(private readonly deps: { fetchImpl?: typeof fetch; now?: () => number } = {}) {}

  private get now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** The SoDEX market for a base ticker ("HYPE", or "HYPEUSDT"): perps first, then spot. */
  async market(asset: string): Promise<{ kind: Kind; symbol: string; scale: number; ticker: SoDexTicker } | null> {
    const base = asset.toUpperCase().replace(/USDT?$/, '');
    if (!base) return null;
    const perps = await this.all('perps').catch(() => []);
    for (const [symbol, scale] of [[`${base}-USD`, 1], [`1000${base}-USD`, 1000]] as const) {
      const ticker = perps.find((t) => t.symbol.toUpperCase() === symbol);
      if (ticker) return { kind: 'perps', symbol: ticker.symbol, scale, ticker };
    }
    const spot = await this.all('spot').catch(() => []);
    const ticker = spot.find((t) => t.symbol.toUpperCase() === `V${base}_VUSDC`);
    return ticker ? { kind: 'spot', symbol: ticker.symbol, scale: 1, ticker } : null;
  }

  /** The last price, and nothing else (see the class note). Null if SoDEX doesn't list it. */
  async stats(asset: string): Promise<CryptoStats | null> {
    const m = await this.market(asset);
    if (!m) return null;
    const price = Number(m.ticker.lastPx) / m.scale;
    if (!Number.isFinite(price) || price <= 0) return null;
    // The other fields are placeholders that nothing reads: priceOnly says so.
    return { price, change: Number.NaN, high: price, low: price, volumeUsd: 0, source: 'SoDEX', priceOnly: true };
  }

  /** Daily closes, oldest first (up to about four years). Null if SoDEX doesn't list it. */
  async daily(asset: string): Promise<{ date: string; close: number }[] | null> {
    const m = await this.market(asset);
    if (!m) return null;
    const body = (await this.get(`/${m.kind}/markets/${encodeURIComponent(m.symbol)}/klines?interval=1d&limit=1500`)) as { data?: { t: number; c: string }[] };
    const rows = (body.data ?? [])
      .map((k) => ({ date: new Date(k.t).toISOString().slice(0, 10), close: Number(k.c) / m.scale }))
      .filter((r) => r.close > 0)
      .sort((a, b) => a.date.localeCompare(b.date));
    return rows.length ? rows : null;
  }

  private async all(kind: Kind): Promise<SoDexTicker[]> {
    const cached = this.tickers.get(kind);
    if (cached && this.now - cached.at < MINUTE) return cached.rows;
    const body = (await this.get(`/${kind}/markets/tickers`)) as { data?: SoDexTicker[] };
    const rows = body.data ?? [];
    this.tickers.set(kind, { rows, at: this.now });
    return rows;
  }

  private async get(path: string): Promise<unknown> {
    const res = await (this.deps.fetchImpl ?? fetch)(`${BASE}${path}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(`SoDEX returned HTTP ${res.status}`);
    const body = (await res.json()) as { code?: number; error?: string };
    if (body.code !== undefined && body.code !== 0) throw new Error(`SoDEX error ${body.code}: ${body.error ?? ''}`);
    return body;
  }
}
