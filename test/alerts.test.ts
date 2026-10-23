import { describe, expect, it } from 'vitest';
import { createAlert, describeAlert } from '../src/alerts/service.js';
import { AlertStore } from '../src/alerts/store.js';
import { type AlertNotifier, AlertWatcher } from '../src/alerts/watcher.js';
import type { Candle } from '../src/calls/prices.js';
import { openDb } from '../src/db/index.js';
import type { DataDesk, FlowReport, MacroReport } from '../src/desk/desk.js';
import type { Purchase } from '../src/desk/treasuries.js';
import { MessageArchive } from '../src/memory/archive.js';

const NOW = Date.parse('2026-10-23T14:00:00Z');
const who = { guildId: 'g', channelId: 'c', userId: 'u1' };
const feed = { resolve: async (a: string) => (['BTC', 'SOL'].includes(a.toUpperCase()) ? `${a.toUpperCase()}USDT` : null), spot: async () => 100 };

function candle(high: number, low: number, close = (high + low) / 2): Candle {
  return { openTime: NOW, open: close, high, low, close };
}

describe('createAlert', () => {
  const store = () => new AlertStore(openDb(':memory:'));

  it('sets price and move alerts, refusing ones that are already true', async () => {
    const s = store();
    const above = await createAlert({ store: s, feed, desk: null }, who, { kind: 'price', asset: 'btc', direction: 'above', price: 110 }, NOW);
    expect(above).toMatchObject({ ok: true, alert: { asset: 'BTC', direction: 'above', target: 110, repeat: false } });
    expect(await createAlert({ store: s, feed, desk: null }, who, { kind: 'price', asset: 'BTC', direction: 'below', price: 120 }, NOW)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/already below/),
    });
    const move = await createAlert({ store: s, feed, desk: null }, who, { kind: 'move', asset: 'SOL', percent: 5 }, NOW);
    expect(move.ok && describeAlert(move.alert)).toBe(`Alert #${move.ok ? move.alert.id : 0}: SOL moving ±5% from 100`);
    expect(await createAlert({ store: s, feed, desk: null }, who, { kind: 'price', asset: 'NOPE', direction: 'above', price: 1 }, NOW)).toMatchObject({ ok: false });
  });

  it('needs the data desk for flow, macro and BTC-buy alerts', async () => {
    expect(await createAlert({ store: store(), feed, desk: null }, who, { kind: 'treasury' }, NOW)).toMatchObject({ ok: false, error: expect.stringMatching(/SoSoValue/) });
  });

  it('caps alerts per member', async () => {
    const s = store();
    for (let i = 0; i < 20; i++) s.create({ ...who, kind: 'price', asset: 'BTC', direction: 'above', target: 200 + i }, NOW);
    expect(await createAlert({ store: s, feed, desk: null }, who, { kind: 'move', asset: 'BTC', percent: 5 }, NOW)).toMatchObject({ ok: false, error: expect.stringMatching(/limit/) });
  });

  it('lets only the owner cancel', () => {
    const s = store();
    const a = s.create({ ...who, kind: 'treasury', repeat: true }, NOW);
    expect(s.cancel(a.id, 'someone-else')).toBe(false);
    expect(s.cancel(a.id, 'u1')).toBe(true);
    expect(s.forUser('g', 'u1')).toEqual([]);
  });
});

describe('AlertWatcher', () => {
  function setup(opts: { candles?: Candle[]; desk?: Partial<DataDesk> | null; change?: number } = {}) {
    const store = new AlertStore(openDb(':memory:'));
    const personal: [number, string][] = [];
    const server: string[] = [];
    const notifier: AlertNotifier = {
      personal: async (batch) => {
        for (const text of batch.texts) personal.push([batch.alerts[0]!.id, text]);
      },
      server: async (texts) => void server.push(...texts),
    };
    let candles = opts.candles ?? [candle(101, 99)];
    const prices = {
      candles: async () => candles,
      change24h: async () => ({ BTCUSDT: { price: 95, change: opts.change ?? 0 }, ETHUSDT: { price: 1, change: 0 }, SOLUSDT: { price: 1, change: 0 } }),
    };
    let now = NOW;
    const watcher = new AlertWatcher({
      store,
      prices,
      desk: opts.desk === undefined ? null : (opts.desk as DataDesk | null),
      notifier,
      now: () => now,
    });
    return { store, watcher, personal, server, setCandles: (c: Candle[]) => (candles = c), advance: (ms: number) => (now += ms) };
  }

  it('fires a price alert once when the level is crossed, using the candle high/low', async () => {
    const { store, watcher, personal, setCandles, advance } = setup();
    const a = store.create({ ...who, kind: 'price', asset: 'BTC', direction: 'below', target: 95 }, NOW);
    await watcher.tick();
    expect(personal).toEqual([]);
    setCandles([candle(100, 94.5, 96)]);
    advance(60_000);
    await watcher.tick();
    expect(personal).toHaveLength(1);
    expect(personal[0]![1]).toContain('went below 95 (low 94.5');
    expect(store.get(a.id)?.status).toBe('fired');
    advance(60_000);
    await watcher.tick();
    expect(personal).toHaveLength(1);
  });

  it('fires move alerts either way', async () => {
    const { store, watcher, personal } = setup({ candles: [candle(106, 100)] });
    store.create({ ...who, kind: 'move', asset: 'SOL', target: 0.05, refPrice: 100 }, NOW);
    await watcher.tick();
    expect(personal[0]![1]).toContain('moved +6.00%');
  });

  it('posts ±5% days to the server once', async () => {
    const { store, watcher, server, advance } = setup({ change: -0.053 });
    store.setChannel('g', 'alerts', NOW);
    await watcher.tick();
    advance(10 * 60_000);
    await watcher.tick();
    expect(server).toEqual(['🔔 Over 24 hours: **BTC** −5.30%.']);
  });

  it('stays quiet on its first look at ETF flows, then announces each new day', async () => {
    const report = (date: string, net: number): FlowReport => ({
      asset: 'BTC',
      latest: { date, totalNetInflow: net, totalValueTraded: null, totalNetAssets: null, cumNetInflow: null },
      days: [],
      streak: { days: 1, total: net },
      funds: [{ ticker: 'IBIT', name: 'iShares', netInflow: net }],
    });
    let current = report('2026-10-22', -635e6);
    const desk = { flows: async (asset: string) => (asset === 'BTC' ? current : null), treasuries: { ready: false } } as unknown as DataDesk;
    const { store, watcher, personal, server, advance } = setup({ desk });
    store.setChannel('g', 'alerts', NOW);
    store.create({ ...who, kind: 'etf-flow', asset: 'BTC', repeat: true }, NOW);
    await watcher.tick();
    expect(personal).toEqual([]);
    expect(server).toEqual([]);

    current = report('2026-10-23', 412e6);
    advance(31 * 60_000);
    await watcher.tick();
    expect(personal).toHaveLength(1);
    expect(personal[0]![1]).toContain('+$412.0M net, led by IBIT +$412.0M');
    expect(server).toHaveLength(1); // ≥ $250M
  });

  it('announces macro releases once the number is out', async () => {
    let today: MacroReport['today'] = [{ event: 'CPI (YoY)', date: '2026-10-23', actual: '', forecast: '3.8%', previous: '4.2%' }];
    const desk = {
      todaysEvents: async () => today.map((r) => r.event),
      releaseToday: async (event: string) => today.find((r) => r.event === event) ?? null,
      treasuries: { ready: false },
    } as unknown as DataDesk;
    const { store, watcher, personal, server, advance } = setup({ desk });
    store.setChannel('g', 'alerts', NOW);
    store.create({ ...who, kind: 'macro', asset: 'cpi' }, NOW);
    await watcher.tick();
    expect(personal).toEqual([]);
    today = [{ ...today[0]!, actual: '3.5%' }];
    advance(5 * 60_000);
    await watcher.tick();
    expect(personal[0]![1]).toContain('**CPI (YoY)** is out: **3.5%** (forecast 3.8%, previous 4.2%)');
    expect(server).toHaveLength(1);
  });

  it('announces new corporate BTC buys, but not the ones already there at start', async () => {
    let buys: Purchase[] = [{ company: 'Strategy', ticker: 'MSTR', date: '2026-10-19', btcAcquired: 267, btcHolding: 848517, costUsd: 22.1e6 }];
    const desk = { treasuries: { ready: true }, treasuryBuys: () => buys } as unknown as DataDesk;
    const { store, watcher, personal, server } = setup({ desk });
    store.setChannel('g', 'alerts', NOW);
    store.create({ ...who, kind: 'treasury', repeat: true }, NOW);
    await watcher.tick();
    expect(personal).toEqual([]);
    buys = [{ company: 'Metaplanet', ticker: '3350', date: '2026-10-23', btcAcquired: 50, btcHolding: 30_000, costUsd: 4e6 }, ...buys];
    await watcher.tick();
    expect(personal.map(([, t]) => t.split('\n')[0])).toEqual(['🔔 **Metaplanet (3350)** bought 50 BTC for $4.0M (Fri 23 Oct). Now holds 30,000 BTC. (SoSoValue)']);
    expect(server).toEqual([]); // under 100 BTC
  });
});

describe('MessageArchive', () => {
  it('only stores when enabled, searches by keyword within readable channels, and forgets when switched off', () => {
    const archive = new MessageArchive(openDb(':memory:'));
    const msg = (id: string, channelId: string, content: string, ts = NOW) => ({ messageId: id, guildId: 'g', channelId, authorId: 'a', authorName: 'Kai', content, ts });
    archive.record(msg('0', 'c1', 'SOL before opt-in'));
    archive.setEnabled('g', true, NOW);
    archive.record(msg('1', 'c1', 'SOL looks strong on the daily'));
    archive.record(msg('2', 'secret', 'SOL whale wallet spotted'));
    archive.record(msg('3', 'c1', 'unrelated chatter about lunch'));
    archive.record(msg('4', 'c1', 'old SOL take', NOW - 40 * 86_400_000));

    const found = archive.search('g', 'what about $SOL?', NOW - 7 * 86_400_000, new Set(['c1']));
    expect(found.map((m) => m.messageId)).toEqual(['1']);
    expect(archive.prune(NOW)).toBe(1);
    expect(archive.setEnabled('g', false, NOW)).toBe(3);
    expect(archive.search('g', 'SOL', 0, new Set(['c1', 'secret']))).toEqual([]);
  });
});
