import { describe, expect, it, vi } from 'vitest';
import { MarketHistory } from '../src/analysis/history.js';
import { SoDex } from '../src/calls/sodex.js';
import { CryptoQuotes } from '../src/quotes.js';
import { ToolKit } from '../src/tools.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const PERPS = [
  { symbol: 'HYPE-USD', lastPx: '94', openPx: '80', highPx: '95', lowPx: '78', quoteVolume: '2271425', fundingRate: '0.0000125', openInterest: '2000', markPrice: '94' },
  { symbol: '1000PEPE-USD', lastPx: '0.005', openPx: '0.004', highPx: '0.0051', lowPx: '0.0039', quoteVolume: '1000' },
];
const SPOT = [{ symbol: 'vWSOSO_vUSDC', lastPx: '0.3', openPx: '0.3', highPx: '0.31', lowPx: '0.29', quoteVolume: '50' }, { symbol: 'vLINK_vUSDC', lastPx: '12', openPx: '11', highPx: '12.5', lowPx: '10.8', quoteVolume: '9000' }];
const KLINES = [{ t: Date.UTC(2026, 9, 27), c: '94' }, { t: Date.UTC(2026, 9, 26), c: '80' }];

/** A fake SoDEX gateway; anything else (Binance, OKX, Bybit) fails. */
function sodexOnly() {
  return vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes('/perps/markets/tickers')) return json({ code: 0, data: PERPS });
    if (u.includes('/spot/markets/tickers')) return json({ code: 0, data: SPOT });
    if (u.includes('/klines')) return json({ code: 0, data: KLINES });
    return json({}, 404);
  }) as unknown as typeof fetch;
}

describe('SoDEX layer', () => {
  it('finds perps first, scales 1000x markets, then spot', async () => {
    const s = new SoDex({ fetchImpl: sodexOnly() });
    expect(await s.stats('HYPEUSDT')).toMatchObject({ price: 94, source: 'SoDEX', fundingRate: 0.0000125, openInterestUsd: 188_000 });
    expect((await s.stats('PEPE'))!.price).toBeCloseTo(0.000005, 12);
    expect(await s.stats('LINK')).toMatchObject({ price: 12, source: 'SoDEX' });
    expect(await s.stats('NOPE')).toBeNull();
    expect(await s.daily('HYPE')).toEqual([{ date: '2026-10-26', close: 80 }, { date: '2026-10-27', close: 94 }]);
  });

  it('is the last price layer: used only when Binance, OKX and Bybit have nothing', async () => {
    const binance = { resolve: async () => null, stats24h: async () => Promise.reject(new Error('not listed')) };
    const out = await new CryptoQuotes(binance, sodexOnly()).stats24h(['HYPEUSDT']);
    expect(out.HYPEUSDT).toMatchObject({ price: 94, source: 'SoDEX' });
  });

  it('asks Binance only for the coins it lists, so one unlisted coin no longer sinks the batch', async () => {
    const asked: string[][] = [];
    const binance = {
      resolve: async (s: string) => (s.startsWith('BTC') ? 'BTCUSDT' : null),
      stats24h: async (symbols: string[]) => (asked.push(symbols), { BTCUSDT: { price: 80_000, change: 0.01, high: 81_000, low: 79_000, volumeUsd: 1e9 } }),
    };
    const out = await new CryptoQuotes(binance, sodexOnly()).stats24h(['BTCUSDT', 'HYPEUSDT']);
    expect(asked).toEqual([['BTCUSDT']]);
    expect(out.BTCUSDT!.price).toBe(80_000);
    expect(out.HYPEUSDT!.source).toBe('SoDEX');
  });

  it('gives daily history when Binance and Bybit have none', async () => {
    const closes = Array.from({ length: 40 }, (_, i) => ({ t: Date.UTC(2026, 8, 1) + i * 86_400_000, c: String(50 + i) }));
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('/klines') ? json({ code: 0, data: closes }) : await (sodexOnly() as unknown as (u: string) => Promise<Response>)(String(url)),
    ) as unknown as typeof fetch;
    const h = await new MarketHistory({ resolve: async () => null, binance: { candles: async () => Promise.reject(new Error('no')) }, fetchImpl }).daily({ symbol: 'HYPE', kind: 'crypto', pair: 'HYPEUSDT' });
    expect(h).toMatchObject({ source: 'SoDEX' });
    expect(h!.closes).toHaveLength(40);
  });
});

describe('names', () => {
  const coingecko = (coins: object[]) =>
    vi.fn(async (url: string | URL | Request) => (String(url).includes('coingecko') ? json({ coins }) : json({ quotes: [] }))) as unknown as typeof fetch;

  it('turns a coin name into its ticker, preferring an exact name over the first result', async () => {
    const history = new MarketHistory({
      resolve: async (s) => (s === 'ENA' ? 'ENAUSDT' : null),
      binance: { candles: async () => [] },
      fetchImpl: coingecko([{ symbol: 'USDE', name: 'Ethena USDe', market_cap_rank: 25 }, { symbol: 'ENA', name: 'Ethena', market_cap_rank: 39 }]),
    });
    expect(await history.identify('ethena')).toEqual({ symbol: 'ENA', kind: 'crypto', pair: 'ENAUSDT' });
  });

  it("doesn't invent a stock from a name nothing matched", async () => {
    const history = new MarketHistory({ resolve: async () => null, binance: { candles: async () => [] }, fetchImpl: coingecko([]) });
    expect(await history.identify('blahblahcoin')).toBeNull();
    expect(await history.identify('HOOD')).toEqual({ symbol: 'HOOD', kind: 'stock' });
  });

  it('tells the model to try again with the ticker when a lookup finds nothing', async () => {
    const kit = new ToolKit({
      quotes: { crypto: { resolve: async () => null, stats24h: async () => ({}) }, stocks: null, identify: async () => null },
    } as never);
    const out = JSON.parse(await kit.session({ guildId: 'g', channelId: 'c', userId: 'u' }).run({ id: '1', name: 'get_price', arguments: '{"symbols":["hyperliwui"]}' }));
    expect(out.not_found).toMatch(/HYPERLIWUI/);
    expect(out.retry).toMatch(/call this tool again now with the ticker/);
  });
});
