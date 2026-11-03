/** One reading of an NFT collection's market, from whichever source covers it. */
export interface NftSnapshot {
  /** Where it comes from and its id there: "cg:pudgy-penguins", "vm:0xcd30…", "me:mad_lads". */
  key: string;
  name: string;
  symbol: string | null;
  chain: string | null;
  /** The coin the collection trades in: ETH, SOL, SOSO… */
  currency: string;
  floor: number | null;
  floorUsd: number | null;
  /** Floor changes in the collection's own coin, as fractions; null where the source doesn't say. */
  change24h: number | null;
  change7d: number | null;
  change30d: number | null;
  volume24h: number | null;
  volume24hUsd: number | null;
  volumeTotal: number | null;
  marketCapUsd: number | null;
  owners: number | null;
  supply: number | null;
  listed: number | null;
  sales24h: number | null;
  /** The page members can open. */
  url: string | null;
  source: string;
  at: number;
}

/** A source refused for now (rate limit): not the same as the collection not existing. */
export class NftSourceBusy extends Error {
  constructor(host: string) {
    super(`${host} is busy (rate limit)`);
  }
}

/** A collection a name search turned up. */
export interface NftMatch {
  key: string;
  name: string;
  symbol: string | null;
  chain?: string | null;
}

const CG = 'https://api.coingecko.com/api/v3';
const HEADERS = { 'user-agent': 'Mozilla/5.0 (Ledger Discord bot)', accept: 'application/json' };
const pct = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v / 100 : null);
const num = (v: unknown) => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
/** An amount in wei (18 decimals, as a string) as a plain number. */
export function fromWei(wei: unknown): number | null {
  if (typeof wei !== 'string' || !/^\d+$/.test(wei)) return null;
  return Number(BigInt(wei) / 10n ** 12n) / 1e6;
}

/**
 * Where NFT numbers come from, all free and keyless:
 * - CoinGecko: thousands of collections on Ethereum, Solana, Base and more (floor, changes, volume, owners).
 * - ValueMint, the marketplace on ValueChain (SoSoValue's Layer 1), for CybeReator and its neighbours: the
 *   collection page carries its own floor, listings and volume, and the ValueChain explorer has the owners.
 * - Magic Eden, for Solana collections CoinGecko doesn't list.
 * Background syncs pass `paced` so they never crowd the free limits; a member's first question about a
 * collection goes straight through.
 */
export class NftSources {
  private nextSlot = 0;
  /** Hosts that refused with a rate limit, and when to try them again. */
  private readonly pausedUntil = new Map<string, number>();

  constructor(
    private readonly deps: {
      /** A free CoinGecko demo key: optional, raises the rate limit (and server IPs are throttled harder without one). */
      coingeckoKey?: string;
      /** The USD price of a coin (SOSO, SOL), for sources that only quote in their own coin. */
      usd?: (symbol: string) => Promise<number | null>;
      fetchImpl?: typeof fetch;
      /** Gap between paced requests; 15 seconds keeps the sync at 4 a minute, well under CoinGecko's free limit. */
      gapMs?: number;
      now?: () => number;
      sleep?: (ms: number) => Promise<void>;
    } = {},
  ) {}

  /** Collections whose name or symbol matches, best first (CoinGecko's search). */
  async search(query: string, paced = false): Promise<NftMatch[]> {
    const body = (await this.json(`${CG}/search?query=${encodeURIComponent(query)}`, paced)) as { nfts?: { id?: string; name?: string; symbol?: string }[] };
    return (body.nfts ?? []).filter((n) => n.id && n.name).slice(0, 6).map((n) => ({ key: `cg:${n.id}`, name: n.name!, symbol: n.symbol ?? null }));
  }

  /** The biggest collections by market cap, for the list Ledger keeps up to date on its own. */
  async top(limit: number, paced = true): Promise<NftMatch[]> {
    const body = (await this.json(`${CG}/nfts/list?order=market_cap_usd_desc&per_page=${limit}&page=1`, paced)) as {
      id?: string;
      name?: string;
      symbol?: string;
      asset_platform_id?: string;
    }[];
    return (Array.isArray(body) ? body : []).filter((n) => n.id && n.name).map((n) => ({ key: `cg:${n.id}`, name: n.name!, symbol: n.symbol ?? null, chain: n.asset_platform_id ?? null }));
  }

  /** The latest reading for a collection, or null if its source has nothing on it. */
  async snapshot(key: string, paced = false): Promise<NftSnapshot | null> {
    const [where, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    if (where === 'cg') return this.coingecko(id, paced);
    if (where === 'vm') return this.valuemint(id, paced);
    if (where === 'me') return this.magicEden(id, paced);
    return null;
  }

  /** A Solana collection by its Magic Eden slug, guessed from a name ("mad lads" → mad_lads). */
  async magicEdenByName(name: string): Promise<NftSnapshot | null> {
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    return slug ? this.magicEden(slug, false) : null;
  }

  private async coingecko(id: string, paced: boolean): Promise<NftSnapshot | null> {
    const d = (await this.json(`${CG}/nfts/${encodeURIComponent(id)}`, paced)) as Record<string, any>;
    if (!d?.id) return null;
    return {
      key: `cg:${id}`,
      name: String(d.name ?? id),
      symbol: d.symbol ?? null,
      chain: d.asset_platform_id ?? null,
      currency: String(d.native_currency_symbol ?? '').toUpperCase() || 'ETH',
      floor: num(d.floor_price?.native_currency),
      floorUsd: num(d.floor_price?.usd),
      change24h: pct(d.floor_price_24h_percentage_change?.native_currency),
      change7d: pct(d.floor_price_7d_percentage_change?.native_currency),
      change30d: pct(d.floor_price_30d_percentage_change?.native_currency),
      volume24h: num(d.volume_24h?.native_currency),
      volume24hUsd: num(d.volume_24h?.usd),
      volumeTotal: null,
      marketCapUsd: num(d.market_cap?.usd),
      owners: num(d.number_of_unique_addresses),
      supply: num(d.total_supply),
      listed: null,
      sales24h: num(d.one_day_sales),
      url: `https://www.coingecko.com/en/nft/${d.web_slug ?? id}`,
      source: 'CoinGecko',
      at: this.now(),
    };
  }

  /**
   * A ValueChain collection. The floor, listings and 24h change come from ValueMint's floor API; volume
   * (which the API doesn't give) from the collection page; owners from the ValueChain explorer. If the API
   * is down, the page's own figures stand in for it.
   */
  private async valuemint(address: string, paced: boolean): Promise<NftSnapshot | null> {
    const url = `https://www.valuemint.store/collection/${address}`;
    const api = (await this.json(`https://www.valuemint.store/api/v1/collections/${address}/floor`, paced).catch(() => null)) as {
      name?: string;
      currency?: string;
      floorWei?: string | null;
      listed?: number;
      change24h?: number | null;
    } | null;
    const seed = parseValueMintSeed(await this.text(url, paced).catch(() => ''));
    if (!api && !seed) return null;
    const token = (await this.json(`https://main-scan.valuechain.xyz/api/v2/tokens/${address}`, paced).catch(() => null)) as {
      holders_count?: string;
      total_supply?: string;
    } | null;
    const floor = fromWei(api ? api.floorWei : seed?.figures?.floorWei);
    const volume24h = fromWei(seed?.figures?.volumeDayWei);
    const currency = api?.currency?.toUpperCase() || 'SOSO';
    const coin = await this.deps.usd?.(currency).catch(() => null);
    return {
      key: `vm:${address.toLowerCase()}`,
      name: api?.name ?? seed?.name ?? address,
      symbol: seed?.symbol ?? null,
      chain: 'valuechain',
      currency,
      floor,
      floorUsd: floor !== null && coin ? floor * coin : null,
      change24h: pct(api?.change24h),
      change7d: null,
      change30d: null,
      volume24h,
      volume24hUsd: volume24h !== null && coin ? volume24h * coin : null,
      volumeTotal: fromWei(seed?.figures?.volumeTotalWei),
      marketCapUsd: null,
      owners: num(token?.holders_count),
      supply: num(token?.total_supply) ?? num(seed?.minted),
      listed: num(api?.listed ?? seed?.figures?.listed),
      sales24h: null,
      url,
      source: 'ValueMint',
      at: this.now(),
    };
  }

  private async magicEden(slug: string, paced: boolean): Promise<NftSnapshot | null> {
    const d = (await this.json(`https://api-mainnet.magiceden.dev/v2/collections/${encodeURIComponent(slug)}/stats`, paced)) as Record<string, unknown>;
    const lamports = num(d?.floorPrice);
    if (lamports === null) return null;
    const floor = lamports / 1e9;
    const sol = await this.deps.usd?.('SOL').catch(() => null);
    return {
      key: `me:${slug}`,
      name: slug.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      symbol: null,
      chain: 'solana',
      currency: 'SOL',
      floor,
      floorUsd: sol ? floor * sol : null,
      change24h: null,
      change7d: null,
      change30d: null,
      volume24h: null,
      volume24hUsd: null,
      volumeTotal: null,
      marketCapUsd: null,
      owners: null,
      supply: null,
      listed: num(d.listedCount),
      sales24h: null,
      url: `https://magiceden.io/marketplace/${slug}`,
      source: 'Magic Eden',
      at: this.now(),
    };
  }

  private async json(url: string, paced = false): Promise<unknown> {
    const res = await this.get(url, paced);
    return res.json();
  }

  private async text(url: string, paced: boolean): Promise<string> {
    return (await this.get(url, paced, { ...HEADERS, accept: 'text/html' })).text();
  }

  /** Whether a source is resting after a rate limit; nothing is sent to it until then. */
  paused(key: string): boolean {
    const host = key.startsWith('vm:') ? 'www.valuemint.store' : key.startsWith('me:') ? 'api-mainnet.magiceden.dev' : new URL(CG).host;
    return (this.pausedUntil.get(host) ?? 0) > this.now();
  }

  private async get(url: string, paced: boolean, headers: Record<string, string> = HEADERS): Promise<Response> {
    const host = new URL(url).host;
    if ((this.pausedUntil.get(host) ?? 0) > this.now()) throw new NftSourceBusy(host);
    if (url.startsWith(CG) && this.deps.coingeckoKey) headers = { ...headers, 'x-cg-demo-api-key': this.deps.coingeckoKey };
    if (paced) await this.waitTurn();
    const res = await (this.deps.fetchImpl ?? fetch)(url, { headers, signal: AbortSignal.timeout(15_000) });
    // A rate limit: leave that source alone for a while (as long as it asks, 5 minutes at least) instead
    // of retrying into it, which only extends the block.
    if (res.status === 429) {
      const wait = Math.max(300, Number(res.headers.get('retry-after')) || 0) * 1000;
      this.pausedUntil.set(host, this.now() + wait);
      throw new NftSourceBusy(host);
    }
    if (!res.ok) throw new Error(`${host} returned HTTP ${res.status}`);
    return res;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Spaces paced requests out: at most one per gap, however many are queued. */
  private async waitTurn(): Promise<void> {
    const now = this.now();
    const at = Math.max(now, this.nextSlot);
    this.nextSlot = at + (this.deps.gapMs ?? 15_000);
    if (at > now) await (this.deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(at - now);
  }
}

interface ValueMintSeed {
  name?: string;
  symbol?: string;
  minted?: string;
  figures?: { floorWei?: string | null; listed?: number; volumeDayWei?: string; volumeTotalWei?: string };
}

/**
 * The figures a ValueMint collection page is built from. The page has no API: Next.js sends the data it
 * renders as an escaped JSON string inside a script tag, and the collection's part starts at "seed".
 */
export function parseValueMintSeed(html: string): ValueMintSeed | null {
  const plain = html.replace(/\\"/g, '"');
  const at = plain.indexOf('"seed":{');
  if (at < 0) return null;
  const start = plain.indexOf('{', at);
  let depth = 0;
  for (let i = start; i < plain.length; i++) {
    if (plain[i] === '{') depth++;
    else if (plain[i] === '}' && --depth === 0) {
      try {
        return JSON.parse(plain.slice(start, i + 1)) as ValueMintSeed;
      } catch {
        return null;
      }
    }
  }
  return null;
}
