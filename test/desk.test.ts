import { describe, expect, it, vi } from 'vitest';
import { DataDesk, formatRateRange } from '../src/desk/desk.js';
import { TreasuryWatcher } from '../src/desk/treasuries.js';
import { flowsCard, macroCard } from '../src/discord/deskCards.js';
import { formatUsd } from '../src/format.js';
import { SoSoValue, SoSoValueError, num } from '../src/sosovalue.js';

const NOW = Date.parse('2026-10-23T14:00:00Z');

/** A fetch that answers by path, recording every URL it was asked for. */
function fakeFetch(routes: Record<string, unknown>, status = 200) {
  const urls: string[] = [];
  const impl = vi.fn(async (url: string | URL | Request) => {
    const u = new URL(String(url));
    urls.push(u.toString());
    const body = routes[u.pathname];
    if (body === undefined) return Response.json({ code: 400401, message: 'Resource not found' }, { status: 404 });
    return Response.json(body, { status });
  }) as unknown as typeof fetch;
  return { impl, urls };
}

describe('SoSoValue client', () => {
  it('sends the key, accepts wrapped and bare responses, and maps fields', async () => {
    const { impl, urls } = fakeFetch({
      '/openapi/v1/etfs/summary-history': {
        code: 0,
        message: 'success',
        data: [
          { date: '2026-10-21', total_net_inflow: '-5', total_value_traded: 1, total_net_assets: 2, cum_net_inflow: 3 },
          { date: '2026-10-22', total_net_inflow: 412300000.5, total_value_traded: null, total_net_assets: '', cum_net_inflow: 9 },
        ],
      },
      '/openapi/v1/etfs': [{ ticker: 'IBIT', name: 'iShares Bitcoin Trust', exchange: 'NASDAQ' }],
    });
    const soso = new SoSoValue('secret', {}, impl, () => NOW);
    const days = await soso.etfFlows('BTC');
    expect(days.map((d) => [d.date, d.totalNetInflow, d.totalNetAssets])).toEqual([
      ['2026-10-22', 412300000.5, null],
      ['2026-10-21', -5, 2],
    ]);
    expect(await soso.etfListings('BTC')).toEqual([{ ticker: 'IBIT', name: 'iShares Bitcoin Trust' }]);
    expect(urls[0]).toContain('symbol=BTC');
    expect(urls[0]).toContain('country_code=US');
    const headers = (impl as unknown as { mock: { calls: [unknown, RequestInit][] } }).mock.calls[0]![1].headers as Record<string, string>;
    expect(headers['x-soso-api-key']).toBe('secret');
  });

  it('caches, and counts requests for the month', async () => {
    const { impl, urls } = fakeFetch({ '/openapi/v1/macro/events': [{ date: '2026-10-23', events: ['CPI'] }] });
    const soso = new SoSoValue('k', {}, impl, () => NOW);
    await soso.macroCalendar();
    await soso.macroCalendar();
    expect(urls).toHaveLength(1);
    expect(soso.requestsThisMonth).toBe(1);
  });

  it('waits and retries when SoSoValue says the minute is used up', async () => {
    let calls = 0;
    const impl = vi.fn(async () =>
      ++calls === 1
        ? Response.json({ code: 42901, message: 'Rate limit exceeded', details: { retry_after: 0.001 } }, { status: 429 })
        : Response.json({ total_market_cap: '2.73e12', total_market_cap_change_pct: '-0.1', total_volume_24h: '6.5e10' }),
    ) as unknown as typeof fetch;
    const soso = new SoSoValue('k', {}, impl, () => NOW);
    expect(await soso.marketOverview()).toEqual({ totalMarketCap: 2.73e12, marketCapChangePct: -0.1, volume24h: 6.5e10 });
    expect(calls).toBe(2);
  });

  it('answers stale data at once while refreshing it, and shares one request between concurrent callers', async () => {
    let served = 0;
    const impl = vi.fn(async () => Response.json([{ date: '2026-10-23', events: [`v${++served}`] }])) as unknown as typeof fetch;
    let now = NOW;
    const soso = new SoSoValue('k', {}, impl, () => now);
    const [a, b] = await Promise.all([soso.macroCalendar(), soso.macroCalendar()]);
    expect(a).toEqual(b);
    expect(served).toBe(1);

    now += 31 * 60_000; // past the 30-minute TTL
    expect((await soso.macroCalendar())[0]!.events).toEqual(['v1']); // stale, but instant
    await new Promise((r) => setTimeout(r, 10));
    expect(served).toBe(2); // refreshed in the background
    expect((await soso.macroCalendar())[0]!.events).toEqual(['v2']);
  });

  it('raises SoSoValue errors with their code', async () => {
    const { impl } = fakeFetch({ '/openapi/v1/market/overview': { code: 400101, message: 'Invalid API key', data: null } });
    const soso = new SoSoValue('bad', {}, impl, () => NOW);
    await expect(soso.marketOverview()).rejects.toMatchObject({ code: 400101 });
    await expect(soso.fomcOutlook()).rejects.toBeInstanceOf(SoSoValueError);
  });

  it('reads numbers from numbers and numeric strings', () => {
    expect(num('3.65')).toBe(3.65);
    expect(num('0.6%')).toBe(0.6);
    expect(num('')).toBeNull();
    expect(num(null)).toBeNull();
    expect(num('n/a')).toBeNull();
  });
});

describe('DataDesk', () => {
  const day = (date: string, net: number | null) => ({ date, totalNetInflow: net, totalValueTraded: null, totalNetAssets: 1e11, cumNetInflow: 6e10 });
  const soso = {
    etfFlows: async () => [day('2026-10-23', null), day('2026-10-22', 300e6), day('2026-10-21', 100e6), day('2026-10-20', -50e6)],
    etfListings: async () => [
      { ticker: 'IBIT', name: 'iShares' },
      { ticker: 'FBTC', name: 'Fidelity' },
      { ticker: 'GBTC', name: 'Grayscale' },
    ],
    etfHistory: async (t: string) =>
      [{ date: '2026-10-22', ticker: t, netInflow: { IBIT: 350e6, FBTC: 0, GBTC: -50e6 }[t] ?? 0, netAssets: null }],
    macroCalendar: async () => [
      { date: '2026-10-22', events: ['Old'] },
      { date: '2026-10-23', events: ['CPI (YoY)'] },
      { date: '2026-10-28', events: ['FOMC'] },
      { date: '2026-11-20', events: ['Too far'] },
    ],
    macroHistory: async () => [{ date: '2026-10-23', actual: '3.5%', forecast: '3.8%', previous: '4.2%' }],
    fomcOutlook: async () => ({
      rateRanges: ['325-350', '350-375', '375-400'],
      meetings: [
        { meetingDate: '2026-09-16', probabilities: [0, 100, 0] },
        { meetingDate: '2026-10-28', probabilities: [10.5, 89.5, null] },
      ],
    }),
  };
  const desk = new DataDesk(soso as unknown as SoSoValue, new TreasuryWatcher(soso as unknown as SoSoValue, () => NOW), () => NOW);

  it('reports the latest settled flows, the streak and the per-fund split', async () => {
    const r = await desk.flows('$btc');
    expect(r?.latest.date).toBe('2026-10-22');
    expect(r?.streak).toEqual({ days: 2, total: 400e6 });
    expect(r?.funds).toEqual([
      { ticker: 'IBIT', name: 'iShares', netInflow: 350e6 },
      { ticker: 'GBTC', name: 'Grayscale', netInflow: -50e6 },
    ]);
    expect(await desk.flows('PEPE')).toBeNull();
  });

  it("builds the macro docket: today's releases, the week ahead, the next FOMC meeting", async () => {
    const r = await desk.macro();
    expect(r.today).toEqual([{ event: 'CPI (YoY)', date: '2026-10-23', actual: '3.5%', forecast: '3.8%', previous: '4.2%' }]);
    expect(r.upcoming.map((d) => d.date)).toEqual(['2026-10-23', '2026-10-28']);
    expect(r.fomc).toEqual({ meetingDate: '2026-10-28', ranges: [{ range: '3.50–3.75%', pct: 89.5 }, { range: '3.25–3.50%', pct: 10.5 }] });
  });

  it('puts flows and macro on the tape cards', async () => {
    const text = JSON.stringify([flowsCard((await desk.flows('BTC'))!).toJSON(), macroCard(await desk.macro()).toJSON()]);
    expect(text).toContain('BTC ETFs');
    expect(text).toContain('+$300.0M');
    expect(text).toContain('2nd straight day of inflows');
    expect(text).toContain('IBIT +$350.0M');
    expect(text).toContain('CPI (YoY) · **3.5%**');
    expect(text).not.toMatch(/odds|pays?|stake|bet/i);
  });
});

describe('format helpers', () => {
  it('formats money and rate ranges', () => {
    expect(formatUsd(412_345_678, true)).toBe('+$412.3M');
    expect(formatUsd(-18_200_000, true)).toBe('−$18.2M');
    expect(formatUsd(2.28e12)).toBe('$2.28T');
    expect(formatUsd(950)).toBe('$950');
    expect(formatRateRange('350-375')).toBe('3.50–3.75%');
  });
});
