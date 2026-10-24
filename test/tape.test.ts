import { describe, expect, it, vi } from 'vitest';
import { openDb } from '../src/db/index.js';
import type { DataDesk, FlowReport } from '../src/desk/desk.js';
import { StoredDesk, TapeRefresher, TapeStore } from '../src/desk/tape.js';
import type { TreasuryWatcher } from '../src/desk/treasuries.js';
import { CryptoQuotes, StockQuotes } from '../src/quotes.js';
import type { SoSoValue, StockQuote } from '../src/sosovalue.js';

const NOW = Date.parse('2026-10-24T15:00:00Z'); // a Saturday: US market closed
const MIN = 60_000;

const flows = (date: string, funds: FlowReport['funds'] = []): FlowReport => ({
  asset: 'BTC',
  latest: { date, totalNetInflow: -635.5e6, totalValueTraded: null, totalNetAssets: null, cumNetInflow: null },
  days: [],
  streak: { days: 1, total: -635.5e6 },
  funds,
});

/** A fake SoSoValue setup that counts requests the way the real client does. */
function setup(opts: { used?: number } = {}) {
  let now = NOW;
  const tape = new TapeStore(openDb(':memory:'));
  if (opts.used) tape.addUsage(opts.used, now);
  const soso = { requestsThisMonth: 0, stockQuotes: vi.fn(async () => ({ NVDA: { ticker: 'NVDA', last: 211 } })) } as unknown as SoSoValue & { requestsThisMonth: number };
  const count = <T>(n: number, value: T) => {
    (soso as { requestsThisMonth: number }).requestsThisMonth += n;
    return value;
  };
  const live = {
    flows: vi.fn(async (asset: string, o?: { withFunds?: boolean }) =>
      count(o?.withFunds === false ? 1 : 5, asset === 'BTC' ? flows('2026-10-22', o?.withFunds === false ? [] : [{ ticker: 'IBIT', name: 'iShares', netInflow: -254e6 }]) : null),
    ),
    macro: vi.fn(async () => count(3, { today: [{ event: 'CPI', date: '2026-10-24', actual: '3.5%', forecast: '', previous: '' }], upcoming: [], fomc: null })),
    market: vi.fn(async () => count(2, { totalMarketCap: 2.7e12, marketCapChangePct: -1, volume24h: 6e10, sectors: [] })),
    news: vi.fn(async (asset?: string) => count(1, { asset: asset ?? null, items: [{ title: `${asset ?? 'hot'} news`, link: '', releasedAt: NOW }] })),
  } as unknown as DataDesk;
  const treasuries = { ready: true, refreshIfStale: vi.fn(async () => {}), recent: () => [{ company: 'Strategy', ticker: 'MSTR', date: '2026-10-19', btcAcquired: 267, btcHolding: 1, costUsd: 1 }] } as unknown as TreasuryWatcher;
  const refresher = new TapeRefresher({ tape, soso, live, treasuries, now: () => now });
  return { tape, soso, live, refresher, desk: new StoredDesk(tape, () => now), advance: (ms: number) => (now += ms) };
}

describe('the stored tape', () => {
  it('fills from one refresher and serves every reader without asking SoSoValue', async () => {
    const { refresher, desk, live, tape } = setup();
    expect(await desk.flows('BTC')).toBeNull();
    for (let i = 0; i < 6; i++) await refresher.tick();
    const calls = (live.flows as ReturnType<typeof vi.fn>).mock.calls.length;
    expect((await desk.flows('$btc'))?.funds[0]?.ticker).toBe('IBIT');
    expect(await desk.releaseToday('CPI')).toMatchObject({ actual: '3.5%' });
    expect((await desk.news('btc')).items[0]?.title).toBe('BTC news');
    expect((await desk.news('PEPE')).asset).toBeNull(); // untracked coin: the hot list, no request
    expect(desk.treasuryBuys(14)).toHaveLength(1);
    expect((live.flows as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls); // reading asked nothing
    expect(tape.usage(NOW)).toBeGreaterThan(0);
  });

  it("re-asks only what's due, and fetches the fund split once per new session", async () => {
    const { refresher, live, advance } = setup();
    for (let i = 0; i < 6; i++) await refresher.tick();
    const flowsMock = live.flows as ReturnType<typeof vi.fn>;
    flowsMock.mockClear();
    expect(await refresher.tick()).toEqual([]); // everything fresh
    advance(31 * MIN);
    await refresher.tick();
    // BTC is due again: the cheap total only, since the session date hasn't changed.
    expect(flowsMock.mock.calls.filter(([asset]) => asset === 'BTC')).toEqual([['BTC', { withFunds: false }]]);
  });

  it('slows down near the monthly cap and stops before it', async () => {
    expect(await setup({ used: 96_500 }).refresher.tick()).toEqual([]);
    const near = setup({ used: 85_000 });
    for (let i = 0; i < 6; i++) await near.refresher.tick();
    near.advance(31 * MIN);
    expect(await near.refresher.tick()).toEqual([]); // a 30-minute job now waits 2 hours
  });
});

describe('price backups', () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  it('crypto: Binance, then OKX, then Bybit', async () => {
    const binance = { resolve: async () => 'BTCUSDT', stats24h: async () => Promise.reject(new Error('451')) };
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('okx')
        ? json({ data: [] })
        : json({ result: { list: [{ lastPrice: '81000', prevPrice24h: '80000', highPrice24h: '82000', lowPrice24h: '79000', turnover24h: '1e9' }] } }),
    ) as unknown as typeof fetch;
    const out = await new CryptoQuotes(binance, fetchImpl).stats24h(['BTCUSDT']);
    expect(out.BTCUSDT).toMatchObject({ price: 81_000, source: 'Bybit' });
    expect(out.BTCUSDT!.change).toBeCloseTo(0.0125, 6);
  });

  it('stocks: a fresh stored batch, then Yahoo, then Nasdaq, then the old batch, labelled', async () => {
    const quote = (last: number): StockQuote => ({ ticker: 'NVDA', last, prevClose: 200, changePct: 1, marketCap: null, high52w: null, low52w: null, marketStatus: 'CLOSED', asOf: '2026-10-23T20:00:00Z' });
    const stored = (at: number) => ({ stocks: () => ({ value: { NVDA: quote(211) }, at }) });
    const yahoo = json({ chart: { result: [{ meta: { regularMarketPrice: 212, chartPreviousClose: 210, regularMarketTime: NOW / 1000 } }] } });
    const nasdaq = json({ data: { primaryData: { lastSalePrice: '$213.00', netChange: '2.00', percentageChange: '0.95%' } } });

    const fresh = new StockQuotes(stored(NOW - 60 * MIN), vi.fn() as unknown as typeof fetch, () => NOW);
    expect((await fresh.stockQuotes(['nvda'])).NVDA).toMatchObject({ last: 211, source: 'SoSoValue' });

    const viaYahoo = new StockQuotes(stored(NOW - 20 * 60 * MIN), (async () => yahoo.clone()) as unknown as typeof fetch, () => NOW);
    expect((await viaYahoo.stockQuotes(['NVDA'])).NVDA).toMatchObject({ last: 212, source: 'Yahoo Finance' });

    const viaNasdaq = new StockQuotes(null, (async (u: string) => (String(u).includes('yahoo') ? json({}, 429) : nasdaq.clone())) as unknown as typeof fetch, () => NOW);
    expect((await viaNasdaq.stockQuotes(['NVDA'])).NVDA).toMatchObject({ last: 213, changePct: 0.95, source: 'Nasdaq' });

    const allDown = new StockQuotes(stored(NOW - 20 * 60 * MIN), (async () => json({}, 503)) as unknown as typeof fetch, () => NOW);
    expect((await allDown.stockQuotes(['NVDA'])).NVDA).toMatchObject({ last: 211, source: 'SoSoValue (last stored)' });
  });
});
