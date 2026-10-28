import { describe, expect, it } from 'vitest';
import { EvidenceBuilder } from '../src/analysis/evidence.js';
import { type DripPick, DripStack } from '../src/analysts/dripstack.js';
import { AnalystRefresher } from '../src/analysts/refresher.js';
import { AnalystStore, shortQuote, targetText } from '../src/analysts/store.js';
import { openDb } from '../src/db/index.js';
import { ToolKit } from '../src/tools.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 27, 18);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const pick = (p: Partial<DripPick> & { author: string; sentiment: string; daysAgo: number }): DripPick => ({
  date: iso(NOW - p.daysAgo * DAY),
  ticker: 'NVDA',
  asset: { kind: 'EQUITY', name: 'NVIDIA Corporation' },
  action: 'HOLD',
  publicationTitle: `${p.author} Weekly`,
  publicationSlug: `${p.author.toLowerCase()}.substack.com`,
  convictionLabel: 'medium',
  conviction: 2,
  evidenceQuote: 'I still like the setup here. The chart is strong and demand keeps growing.',
  speakerIsGuest: false,
  publishedAt: new Date(NOW - p.daysAgo * DAY).toISOString(),
  ...p,
});

function stored() {
  const store = new AnalystStore(openDb(':memory:'));
  store.upsert(
    [
      pick({ author: 'Za', sentiment: 'BULLISH', daysAgo: 2, convictionLabel: 'high', conviction: 3 }),
      pick({ author: 'Za', sentiment: 'BEARISH', daysAgo: 20 }), // older: Za's latest call is bullish
      pick({ author: 'Kim', sentiment: 'BEARISH', daysAgo: 5, action: 'EXIT', priceTarget: { kind: 'range', value: 100, valueHigh: 199 }, timeframe: 'over the next year' }),
      pick({ author: 'Lee', sentiment: 'BULLISH', daysAgo: 8 }),
      pick({ author: 'Guest', sentiment: 'BEARISH', daysAgo: 1, speakerIsGuest: true }), // podcast guest: left out
      pick({ author: 'Old', sentiment: 'BEARISH', daysAgo: 45 }), // outside 30 days
      pick({ author: 'Ann', sentiment: 'BULLISH', daysAgo: 3, ticker: 'BTC', asset: { kind: 'CRYPTO', name: 'Bitcoin' } }),
    ],
    NOW,
  );
  return store;
}

describe('analyst store', () => {
  it('counts each analyst once by their latest call, without podcast guests or old calls', () => {
    const v = stored().view('nvda', 30, NOW)!;
    expect(v).toMatchObject({ ticker: 'NVDA', name: 'NVIDIA Corporation', analysts: 3, bullish: 2, bearish: 1, neutral: 0, calls: 4 });
    expect(v.latest[0]!.author).toBe('Za'); // most confident first
    expect(stored().view('PLTR', 30, NOW)).toBeNull();
  });

  it('counts commodities through the ETFs and futures analysts name', () => {
    const store = new AnalystStore(openDb(':memory:'));
    store.upsert(
      [
        pick({ author: 'A', sentiment: 'BULLISH', daysAgo: 1, ticker: 'GLD', asset: { kind: 'ETF', name: 'SPDR Gold Shares' } }),
        pick({ author: 'B', sentiment: 'BEARISH', daysAgo: 2, ticker: 'GC=F', asset: { kind: 'OTHER', name: null } }),
      ],
      NOW,
    );
    expect(store.view('GOLD', 30, NOW)).toMatchObject({ ticker: 'GOLD', name: null, analysts: 2, bullish: 1, bearish: 1 });
  });

  it('stores the same call once', () => {
    const store = stored();
    expect(store.upsert([pick({ author: 'Za', sentiment: 'BULLISH', daysAgo: 2, convictionLabel: 'high', conviction: 3 })], NOW)).toBe(0);
    expect(store.status().calls).toBe(7);
  });

  it('lists what analysts talk about most', () => {
    expect(stored().trending(30, NOW).map((v) => v.ticker)).toEqual(['NVDA', 'BTC']);
  });

  it('shortens quotes and writes targets in words', () => {
    expect(shortQuote('I still like the setup here. The chart is strong.')).toBe('I still like the setup here.');
    expect(shortQuote(Array.from({ length: 40 }, () => 'word').join(' '))!.split(' ')).toHaveLength(25);
    expect(targetText({ kind: 'range', value: 100, valueHigh: 199 })).toBe('100–199');
    expect(targetText({ kind: 'above', value: 387 })).toBe('above 387');
    expect(targetText(null)).toBeNull();
  });
});

describe('DripStack client', () => {
  function fakeFetch(responses: { status: number; body: unknown }[]) {
    const urls: string[] = [];
    const fetch = (async (url: string) => {
      urls.push(url);
      const r = responses.shift()!;
      return { status: r.status, ok: r.status < 400, json: async () => r.body } as Response;
    }) as unknown as typeof globalThis.fetch;
    return { fetch, urls };
  }

  it('spaces requests out and follows pages', async () => {
    const { fetch, urls } = fakeFetch([
      { status: 200, body: { meta: { plan: 'EXPERT' }, picks: [pick({ author: 'A', sentiment: 'BULLISH', daysAgo: 1 })], pagination: { nextCursor: '2026-10-20' } } },
      { status: 200, body: { meta: { plan: 'EXPERT' }, picks: [pick({ author: 'B', sentiment: 'BEARISH', daysAgo: 9 })], pagination: { nextCursor: null } } },
    ]);
    const waits: number[] = [];
    let now = NOW;
    const client = new DripStack({ apiKey: 'k', fetch, now: () => now, sleep: async (ms) => void waits.push(ms) });
    const picks = await client.picks('2026-09-28', '2026-10-27');
    expect(picks.map((p) => p.author)).toEqual(['A', 'B']);
    expect(urls[1]).toContain('cursor=2026-10-20');
    expect(urls.every((u) => u.includes('/api/v2/stock-picks?'))).toBe(true); // never a paid route
    expect(waits).toEqual([3_000]); // the second request waited its turn: at most 20 a minute
  });

  it('switches off on a payment or plan error, and outside an included plan', async () => {
    const paid = new DripStack({ apiKey: 'k', fetch: fakeFetch([{ status: 402, body: { code: 'payment_required' } }]).fetch, sleep: async () => {} });
    await expect(paid.picks('2026-10-27', '2026-10-27')).rejects.toThrow();
    expect(paid.enabled).toBe(false);
    const free = new DripStack({ apiKey: 'k', fetch: fakeFetch([{ status: 200, body: { meta: { plan: 'FREE' }, picks: [] } }]).fetch, sleep: async () => {} });
    await expect(free.picks('2026-10-27', '2026-10-27')).rejects.toThrow(/plan FREE/);
    expect(free.enabled).toBe(false);
  });
});

describe('analyst sync', () => {
  it('loads the month first, then the last two days every 30 minutes', async () => {
    const store = new AnalystStore(openDb(':memory:'));
    const asked: [string, string][] = [];
    const client = { enabled: true, picks: async (from: string, to: string) => (asked.push([from, to]), [pick({ author: 'Za', sentiment: 'BULLISH', daysAgo: 1 })]) };
    let now = NOW;
    const sync = new AnalystRefresher({ client: client as never, store, now: () => now });
    expect(await sync.tick()).toBe(1);
    expect(asked[0]).toEqual([iso(NOW - 29 * DAY), iso(NOW)]);
    now += 10 * 60_000;
    expect(await sync.tick()).toBeNull(); // not due yet
    now += 25 * 60_000;
    expect(await sync.tick()).toBe(0); // same call, stored once
    expect(asked[1]).toEqual([iso(now - DAY), iso(now)]);
  });
});

describe('analysts in takes and chat', () => {
  const closes = Array.from({ length: 400 }, (_, i) => ({ date: iso(NOW - (399 - i) * DAY), close: 100 + i * 0.1 }));
  const history = {
    identify: async (s: string) => ({ symbol: s.toUpperCase(), kind: 'stock' }),
    daily: async (a: { symbol: string; kind: 'stock' }) => ({ asset: a, closes, source: 'Yahoo' }),
  } as never;

  it('adds the split and the most confident calls as facts, and keeps the snapshot', async () => {
    const e = await new EvidenceBuilder({ history, desk: null, analysts: stored(), now: () => NOW }).forThesis({
      kind: 'price', asset: 'NVDA', assetKind: 'stock', direction: 'up', target: 150, horizonDays: 30,
    });
    if ('error' in e) throw new Error(e.error);
    const text = e.facts.map((f) => f.text).join('\n');
    expect(text).toContain('3 covered NVDA; by each one\'s latest call, 2 bullish, 1 bearish, 0 neutral');
    expect(text).toContain('Most confident bullish call on NVDA: Za (Za Weekly), high conviction');
    expect(text).toContain('Most confident bearish call on NVDA: Kim (Kim Weekly), medium conviction, 22 Oct, target 100–199, timeframe "over the next year"');
    expect(e.analysts).toEqual([{ ticker: 'NVDA', days: 30, analysts: 3, bullish: 2, bearish: 1, neutral: 0 }]);
    expect(e.sources).toContain('DripStack');
  });

  it('answers "what are analysts saying" from the store, by name or ticker', async () => {
    const kit = new ToolKit({
      analysts: stored(),
      quotes: { crypto: {} as never, stocks: null, identify: async (raw: string) => (/nvidia/i.test(raw) ? { symbol: 'NVDA', kind: 'stock' } : null) },
      now: () => NOW,
    } as never);
    const session = kit.session({ guildId: 'g', channelId: 'c', userId: 'u' });
    const run = async (args: object) => JSON.parse(await session.run({ id: '1', name: 'analyst_views', arguments: JSON.stringify(args) }));
    const nvda = await run({ asset: 'nvidia' });
    expect(nvda).toMatchObject({ asset: 'NVDA (NVIDIA Corporation)', analysts: 3, split_by_latest_call: { bullish: 2, bearish: 1 } });
    expect(nvda.strongest_calls[0]).toMatchObject({ who: 'Za (Za Weekly)', stance: 'bullish', newsletter: 'https://za.substack.com' });
    expect((await run({ asset: 'PLTR' })).note).toMatch(/No newsletter/);
    expect((await run({})).most_talked_about.map((x: { asset: string }) => x.asset)).toEqual(['NVDA (NVIDIA Corporation)', 'BTC']);
  });
});
