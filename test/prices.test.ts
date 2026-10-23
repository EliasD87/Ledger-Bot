import { describe, expect, it, vi } from 'vitest';
import { BinanceFeed, normalizeAsset } from '../src/calls/prices.js';
import { formatChance, formatDuration, formatPrice, parseDuration } from '../src/format.js';

describe('normalizeAsset', () => {
  it.each([
    ['btc', 'BTC'],
    ['$ETH', 'ETH'],
    ['sol/usdt', 'SOL'],
    ['PEPE-USD', 'PEPE'],
    ['Bitcoin', 'BTC'],
    ['1000SATS', '1000SATS'],
    ['SUSD', 'SUSD'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeAsset(input)).toBe(expected);
  });

  it('rejects things that are not tickers', () => {
    expect(normalizeAsset('')).toBeNull();
    expect(normalizeAsset('to the moon')).toBeNull();
    expect(normalizeAsset('x')).toBeNull();
  });
});

describe('BinanceFeed', () => {
  function fakeFetch(routes: Record<string, unknown>) {
    return vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (!(path in routes)) return new Response('not found', { status: 404 });
      return Response.json(routes[path]);
    }) as unknown as typeof fetch;
  }

  it('resolves only live USDT markets, and caches the market list', async () => {
    const fetchImpl = fakeFetch({
      '/api/v3/exchangeInfo': {
        symbols: [
          { symbol: 'BTCUSDT', quoteAsset: 'USDT' },
          { symbol: 'ETHBTC', quoteAsset: 'BTC' },
        ],
      },
    });
    const feed = new BinanceFeed('https://example.test', fetchImpl);
    expect(await feed.resolve('btc')).toBe('BTCUSDT');
    expect(await feed.resolve('eth')).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('parses candles', async () => {
    const feed = new BinanceFeed(
      'https://example.test',
      fakeFetch({ '/api/v3/klines': [[1000, '1.5', '2.5', '1.0', '2.0', '99', 1999]] }),
    );
    expect(await feed.candles('BTCUSDT', '1m')).toEqual([{ openTime: 1000, open: 1.5, high: 2.5, low: 1, close: 2 }]);
  });

  it('explains region blocks', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 451 })) as unknown as typeof fetch;
    await expect(new BinanceFeed('https://example.test', fetchImpl).spot('BTCUSDT')).rejects.toThrow(/PRICE_FEED_URL/);
  });
});

describe('format', () => {
  it('parses and prints windows', () => {
    expect(parseDuration('6h')).toBe(6 * 3_600_000);
    expect(parseDuration('3 days')).toBe(3 * 86_400_000);
    expect(parseDuration('2w')).toBe(14 * 86_400_000);
    expect(parseDuration('1.5d')).toBe(36 * 3_600_000);
    expect(parseDuration('soon')).toBeNull();
    expect(formatDuration(36 * 3_600_000)).toBe('1d 12h');
    expect(formatDuration(45 * 60_000)).toBe('45m');
  });

  it('prints prices and chances', () => {
    expect(formatPrice(81724.01)).toBe('81,724');
    expect(formatPrice(81861.7)).toBe('81,862');
    expect(formatPrice(2407.44)).toBe('2,407.44');
    expect(formatPrice(2400)).toBe('2,400');
    expect(formatPrice(178.456)).toBe('178.456');
    expect(formatPrice(0.0000123456789)).toBe('0.0000123457');
    expect(formatChance(0.182)).toBe('18%');
    expect(formatChance(0.052)).toBe('5.2%');
    expect(formatChance(0.0001)).toBe('<0.1%');
  });
});
