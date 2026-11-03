import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index.js';
import { NftDesk } from '../src/nfts/desk.js';
import { NftSources, fromWei, parseValueMintSeed } from '../src/nfts/sources.js';
import { CYBEREATOR, NftStore } from '../src/nfts/store.js';
import { ToolKit } from '../src/tools.js';

const MINUTE = 60_000;
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 3, 12);
const CYBR = CYBEREATOR.key.slice(3);

/** A ValueMint page as Next.js sends it: the collection's figures as escaped JSON inside a script tag. */
const VALUEMINT_PAGE =
  '<html><script>self.__next_f.push([1,"2b:[\\"$\\",\\"$L2c\\",null,{\\"params\\":\\"$@2d\\",\\"seed\\":{\\"name\\":\\"Cybereator\\",\\"symbol\\":\\"CYBR\\",' +
  '\\"minted\\":\\"3884\\",\\"figures\\":{\\"floorWei\\":\\"249999999990000000000\\",\\"listed\\":20,\\"volumeDayWei\\":\\"2872980000000000000000\\",' +
  '\\"volumeTotalWei\\":\\"36834145001118999900000\\"}}}]\\n"])</script></html>';

const PUDGY = {
  id: 'pudgy-penguins',
  web_slug: 'pudgy-penguins',
  name: 'Pudgy Penguins',
  symbol: 'PPG',
  asset_platform_id: 'ethereum',
  native_currency_symbol: 'eth',
  floor_price: { native_currency: 2.34, usd: 5261.67 },
  floor_price_24h_percentage_change: { native_currency: -3.75 },
  floor_price_7d_percentage_change: { native_currency: -6.44 },
  floor_price_30d_percentage_change: { native_currency: -24.53 },
  volume_24h: { native_currency: 25.06, usd: 56376 },
  market_cap: { usd: 46_765_741 },
  number_of_unique_addresses: 5031,
  total_supply: 8888,
  one_day_sales: 11,
};

/** A fake web: answers by URL, and remembers what was asked. */
function web(routes: Record<string, unknown>) {
  const asked: string[] = [];
  const fetchImpl = (async (url: string) => {
    asked.push(url);
    const hit = Object.entries(routes).find(([part]) => url.includes(part));
    if (!hit) return new Response('{}', { status: 404 });
    const body = typeof hit[1] === 'string' ? hit[1] : JSON.stringify(hit[1]);
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, asked };
}

const VALUEMINT_API = {
  collection: '0xCD30D4bCaa99E556B70A2C4bDFC4050D26E48D30',
  name: 'Cybereator',
  currency: 'SOSO',
  floor: '249.99999999',
  floorWei: '249999999990000000000',
  listed: 20,
  change24h: 111.96,
  updatedAt: '2026-11-03T05:26:55.566Z',
};

const ROUTES = {
  '/api/v1/collections/': VALUEMINT_API,
  'valuemint.store/collection/': VALUEMINT_PAGE,
  'valuechain.xyz/api/v2/tokens/': { holders_count: '558', total_supply: '3884' },
  '/search?query=pudgy': { nfts: [{ id: 'pudgy-penguins', name: 'Pudgy Penguins', symbol: 'PPG' }, { id: 'lil-pudgys', name: 'Lil Pudgys', symbol: 'LP' }] },
  '/search?query=': { nfts: [] },
  '/nfts/pudgy-penguins': PUDGY,
  '/nfts/list': [{ id: 'cryptopunks', name: 'CryptoPunks', symbol: 'PUNK', asset_platform_id: 'ethereum' }],
  '/nfts/cryptopunks': { ...PUDGY, id: 'cryptopunks', web_slug: 'cryptopunks', name: 'CryptoPunks', symbol: 'PUNK', market_cap: { usd: 300_000_000 } },
};

function setup(routes: Record<string, unknown> = ROUTES) {
  let now = NOW;
  const { fetchImpl, asked } = web(routes);
  const store = new NftStore(openDb(':memory:'));
  const sources = new NftSources({ fetchImpl, usd: async (coin) => (coin === 'SOSO' ? 0.32 : coin === 'SOL' ? 150 : null), now: () => now, sleep: async () => {} });
  const desk = new NftDesk({ store, sources, now: () => now });
  return { store, sources, desk, asked, at: (ms: number) => (now = ms) };
}

describe('NFT sources', () => {
  it('reads CybeReator from the ValueMint API, its page (volume) and the ValueChain explorer, priced in SOSO', async () => {
    expect(parseValueMintSeed(VALUEMINT_PAGE)).toMatchObject({ name: 'Cybereator', minted: '3884', figures: { listed: 20 } });
    expect(fromWei('249999999990000000000')).toBeCloseTo(250, 4);
    const s = (await setup().sources.snapshot(CYBEREATOR.key))!;
    expect(s).toMatchObject({ currency: 'SOSO', listed: 20, owners: 558, supply: 3884, source: 'ValueMint', chain: 'valuechain' });
    expect(s.floor).toBeCloseTo(250, 4);
    expect(s.floorUsd).toBeCloseTo(80, 2);
    expect(s.volume24h).toBeCloseTo(2872.98, 2);
    expect(s.change24h).toBeCloseTo(1.1196, 6);
  });

  it('falls back to the page figures when the ValueMint API is down', async () => {
    const { '/api/v1/collections/': _api, ...withoutApi } = ROUTES;
    const s = (await setup(withoutApi).sources.snapshot(CYBEREATOR.key))!;
    expect(s).toMatchObject({ listed: 20, change24h: null, owners: 558 });
    expect(s.floor).toBeCloseTo(250, 4);
  });

  it('reads a CoinGecko collection, with changes as fractions in its own coin', async () => {
    const s = (await setup().sources.snapshot('cg:pudgy-penguins'))!;
    expect(s).toMatchObject({ name: 'Pudgy Penguins', currency: 'ETH', floor: 2.34, floorUsd: 5261.67, owners: 5031, sales24h: 11 });
    expect(s.change7d).toBeCloseTo(-0.0644, 6);
  });

  it('has nothing for a page without figures', () => {
    expect(parseValueMintSeed('<html>no data</html>')).toBeNull();
  });
});

describe('the NFT store', () => {
  it('knows CybeReator by the names members use, and big collections by nickname', () => {
    const { store } = setup();
    for (const name of ['CybeReator', 'cybr', '$CYBR', 'our floor'.replace('floor', 'collection'), 'Cybereator NFTs']) expect(store.find(name)).toBe(CYBEREATOR.key);
    expect(store.find('BAYC')).toBe('cg:bored-ape-yacht-club');
    expect(store.find('pudgies')).toBe('cg:pudgy-penguins');
    expect(store.find('something new')).toBeNull();
  });

  it('works out floor changes from its own readings once it has them', () => {
    const { store } = setup();
    const reading = (at: number, floor: number) => ({
      key: CYBEREATOR.key, name: 'Cybereator', symbol: 'CYBR', chain: 'valuechain', currency: 'SOSO', floor, floorUsd: null, change24h: null, change7d: null,
      change30d: null, volume24h: null, volume24hUsd: null, volumeTotal: null, marketCapUsd: null, owners: null, supply: null, listed: null, sales24h: null,
      url: null, source: 'ValueMint', at,
    });
    store.record(reading(NOW - 2 * DAY, 200));
    store.record(reading(NOW - DAY, 240));
    store.record(reading(NOW, 250));
    expect(store.floorChange(CYBEREATOR.key, 1, NOW)).toBeCloseTo(250 / 240 - 1, 6);
    expect(store.floorChange(CYBEREATOR.key, 7, NOW)).toBeNull(); // not a week of readings yet
  });
});

describe('the NFT desk', () => {
  it('fetches a never-stored collection once, then answers from the store and keeps it on the sync list', async () => {
    const { desk, store, asked } = setup();
    expect(await desk.lookup('lil pudgys')).toMatchObject({ notFound: 'lil pudgys' }); // a popular one, but this fake web has nothing on it
    const first = await desk.lookup('pudgy penguins');
    expect(first).toMatchObject({ found: { name: 'Pudgy Penguins', floor: 2.34 } });
    const fetched = asked.length;
    await desk.lookup('pudgies');
    expect(asked.length).toBe(fetched); // stored: no request
    expect(store.watchlist(NOW)).toContain('cg:pudgy-penguins');
  });

  it('turns up a collection by search, and names the others it found', async () => {
    const r = await setup().desk.lookup('pudgy p');
    expect(r).toMatchObject({ found: { name: 'Pudgy Penguins' }, others: ['Lil Pudgys'] });
    expect(await setup().desk.lookup('zzz')).toMatchObject({ notFound: 'zzz', others: [] });
  });

  it('reads CybeReator every sync, and the rest at most six at a time, skipping ones that just failed', async () => {
    const { desk, store, asked, at } = setup();
    const coingecko = () => asked.filter((u) => u.includes('coingecko')).length;
    expect(await desk.tick()).toBe(2); // CybeReator and CryptoPunks; the other CoinGecko reads hit popular collections this fake web lacks
    expect(store.latest(CYBEREATOR.key)).toMatchObject({ listed: 20 });
    expect(coingecko()).toBe(6); // the top list and five collections: six requests a sync at most
    expect(await desk.tick()).toBeNull(); // not due yet
    for (let i = 1; i <= 4; i++) {
      const before = coingecko();
      at(NOW + i * 11 * MINUTE);
      await desk.tick();
      expect(coingecko() - before).toBeLessThanOrEqual(6);
    }
    expect(coingecko()).toBe(1 + 13); // the top list once, and each of the 13 collections (CryptoPunks is on both lists) tried once
    expect(store.latest('cg:cryptopunks')).toMatchObject({ name: 'CryptoPunks' }); // reached once the failing ones stepped aside
  });

  it('rests a rate-limited source for 5 minutes, queues new names, and loads them on a later sync', async () => {
    let throttled = true;
    const { fetchImpl, asked } = web(ROUTES);
    const store = new NftStore(openDb(':memory:'));
    let now = NOW;
    const flaky = (async (url: string) =>
      throttled && url.includes('coingecko') ? new Response('Throttled', { status: 429 }) : fetchImpl(url)) as typeof fetch;
    const desk = new NftDesk({ store, sources: new NftSources({ fetchImpl: flaky, now: () => now, sleep: async () => {} }), now: () => now });
    expect(await desk.lookup('pudgy p')).toEqual({ loading: 'pudgy p' });
    const before = asked.length;
    expect(await desk.lookup('azuki')).toEqual({ loading: 'azuki' }); // paused: nothing sent
    expect(asked.length).toBe(before);
    throttled = false;
    now += 11 * MINUTE;
    await desk.tick();
    expect(store.latest('cg:pudgy-penguins')).toMatchObject({ floor: 2.34 }); // the queued name was searched, then read first
  });
});

describe('nft_stats', () => {
  async function run(args: object, routes?: Record<string, unknown>) {
    const { desk, at } = setup(routes);
    for (let i = 0; i < 5; i++) {
      at(NOW + i * 11 * MINUTE);
      await desk.tick();
    }
    await desk.lookup('pudgies');
    const kit = new ToolKit({ nfts: desk, now: () => NOW } as never);
    return JSON.parse(await kit.session({ guildId: 'g', channelId: 'c', userId: 'u' }).run({ id: '1', name: 'nft_stats', arguments: JSON.stringify(args) }));
  }

  it('gives the floor in the collection coin first, then USD', async () => {
    const cybr = await run({ collection: 'our collection' });
    expect(cybr).toMatchObject({ collection: 'Cybereator (CYBR)', floor: '250 SOSO (about $80.00)', floor_change: { '24h': '+111.96%' }, listed: 20, owners: 558, source: 'ValueMint' });
    const pudgy = await run({ collection: 'pudgies' });
    expect(pudgy).toMatchObject({ floor: '2.34 ETH (about $5.3K)', floor_change: { '24h': '−3.75%', '7d': '−6.44%' }, market_cap: '$46.8M' });
  });

  it('lists the biggest collections when no name is given', async () => {
    const r = await run({});
    expect(r.biggest_collections.map((c: { collection: string }) => c.collection)).toEqual(['Cybereator (CYBR)', 'CryptoPunks (PUNK)', 'Pudgy Penguins (PPG)']);
  });

  it('says a collection is loading, not missing, when the source is rate limited', async () => {
    const store = new NftStore(openDb(':memory:'));
    const fetchImpl = (async () => new Response('Throttled', { status: 429 })) as unknown as typeof fetch;
    const desk = new NftDesk({ store, sources: new NftSources({ fetchImpl, sleep: async () => {} }), now: () => NOW });
    const kit = new ToolKit({ nfts: desk, now: () => NOW } as never);
    const r = JSON.parse(await kit.session({ guildId: 'g', channelId: 'c', userId: 'u' }).run({ id: '1', name: 'nft_stats', arguments: '{"collection":"doodles"}' }));
    expect(r.not_loaded_yet).toMatch(/queued/);
    expect(r.retry).toBeUndefined();
  });

  it('asks the model to retry with the full name when nothing is found', async () => {
    const r = await run({ collection: 'zzz apes' });
    expect(r.not_found).toMatch(/No NFT collection/);
    expect(r.retry).toMatch(/Bored Ape Yacht Club/);
  });
});
