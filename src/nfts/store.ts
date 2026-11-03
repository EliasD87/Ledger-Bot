import type { Db } from '../db/index.js';
import type { NftMatch, NftSnapshot } from './sources.js';

const DAY = 86_400_000;
/** Every reading is kept for two weeks; after that, one a day (for floor history). */
const FULL_DAYS = 14;
/** A collection someone asked about stays on the sync list this long. */
const ASKED_DAYS = 7;

export interface NftCollection {
  key: string;
  name: string;
  symbol: string | null;
  chain: string | null;
  /** Other names members use: "pudgies", "cybr". */
  aliases: string[];
}

/** CybeReator, the server's own collection: always synced, and known by every name members use for it. */
export const CYBEREATOR: NftCollection = {
  key: 'vm:0xcd30d4bcaa99e556b70a2c4bdfc4050d26e48d30',
  name: 'CybeReator',
  symbol: 'CYBR',
  chain: 'valuechain',
  aliases: ['cybereator', 'cybereators', 'cyber reator', 'cybr', 'our collection', 'our nft', 'our nfts', 'the collection', 'our floor', 'cybereator floor', 'cybr floor'],
};

/**
 * Collections members talk about most, loaded in the background from the first start and kept up to date,
 * so a question about them never waits on a data source. The aliases are the nicknames members use.
 */
export const POPULAR: NftCollection[] = [
  { key: 'cg:pudgy-penguins', name: 'Pudgy Penguins', symbol: 'PPG', chain: 'ethereum', aliases: ['pudgy', 'pudgies', 'pudgy penguin', 'ppg'] },
  { key: 'cg:lil-pudgys', name: 'Lil Pudgys', symbol: null, chain: 'ethereum', aliases: ['lil pudgy', 'lil pudgies'] },
  { key: 'cg:bored-ape-yacht-club', name: 'Bored Ape Yacht Club', symbol: 'BAYC', chain: 'ethereum', aliases: ['bayc', 'apes', 'bored apes', 'bored ape'] },
  { key: 'cg:mutant-ape-yacht-club', name: 'Mutant Ape Yacht Club', symbol: 'MAYC', chain: 'ethereum', aliases: ['mayc', 'mutants', 'mutant apes'] },
  { key: 'cg:cryptopunks', name: 'CryptoPunks', symbol: 'PUNK', chain: 'ethereum', aliases: ['punks', 'punk', 'crypto punks'] },
  { key: 'cg:milady-maker', name: 'Milady Maker', symbol: null, chain: 'ethereum', aliases: ['milady', 'miladys', 'miladies'] },
  { key: 'cg:azuki', name: 'Azuki', symbol: 'AZUKI', chain: 'ethereum', aliases: ['azukis'] },
  { key: 'cg:doodles-official', name: 'Doodles', symbol: 'DOODLE', chain: 'ethereum', aliases: ['doodle'] },
  { key: 'cg:chromie-squiggle-by-snowfro', name: 'Chromie Squiggle', symbol: null, chain: 'ethereum', aliases: ['squiggle', 'squiggles', 'chromie squiggles'] },
  { key: 'cg:mad-lads', name: 'Mad Lads', symbol: 'MLADS', chain: 'solana', aliases: ['mad lad', 'madlads'] },
  { key: 'cg:okay-bears', name: 'Okay Bears', symbol: null, chain: 'solana', aliases: ['okay bear', 'okb'] },
  { key: 'cg:degods', name: 'DeGods', symbol: null, chain: 'ethereum', aliases: ['degod'] },
  { key: 'cg:hypurr-hyperevm', name: 'Hypurr', symbol: 'HYPURR', chain: 'hyperevm', aliases: ['hypurrs'] },
];

const COLUMNS = `s.key AS key, c.name AS name, c.symbol AS symbol, c.chain AS chain, s.currency AS currency, s.floor AS floor,
  s.floor_usd AS floorUsd, s.change_24h AS change24h, s.change_7d AS change7d, s.change_30d AS change30d, s.volume_24h AS volume24h,
  s.volume_24h_usd AS volume24hUsd, s.volume_total AS volumeTotal, s.market_cap_usd AS marketCapUsd, s.owners AS owners,
  s.supply AS supply, s.listed AS listed, s.sales_24h AS sales24h, s.url AS url, s.source AS source, s.at AS at`;

/** NFT collections Ledger follows, and the readings the background sync takes of them. */
export class NftStore {
  constructor(private readonly db: Db) {
    for (const c of [CYBEREATOR, ...POPULAR]) this.add(c, Date.now(), { pinned: true });
  }

  /** Adds a collection (or refreshes its name); `pinned` keeps it on the sync list for good. */
  add(c: NftMatch & { aliases?: string[] }, now: number, flags: { pinned?: boolean } = {}): void {
    this.db
      .prepare(
        `INSERT INTO nft_collections (key, name, symbol, chain, aliases, pinned, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET name = excluded.name, symbol = COALESCE(excluded.symbol, symbol), chain = COALESCE(excluded.chain, chain),
           aliases = COALESCE(excluded.aliases, aliases), pinned = MAX(pinned, excluded.pinned)`,
      )
      .run(c.key, c.name, c.symbol ?? null, c.chain ?? null, c.aliases ? JSON.stringify(c.aliases) : null, flags.pinned ? 1 : 0, now);
  }

  /** The collection a member means, from a name, symbol or nickname Ledger already knows; null if none. */
  find(query: string): string | null {
    const q = query.trim().toLowerCase().replace(/^\$/, '').replace(/\s+nfts?$/, '').replace(/\s+/g, ' ');
    if (!q) return null;
    const rows = this.db.prepare('SELECT key, name, symbol, aliases FROM nft_collections').all() as {
      key: string;
      name: string;
      symbol: string | null;
      aliases: string | null;
    }[];
    const hit = rows.find(
      (r) =>
        r.key === q ||
        r.name.toLowerCase() === q ||
        (r.symbol && r.symbol.toLowerCase() === q) ||
        (r.aliases ? (JSON.parse(r.aliases) as string[]) : []).includes(q),
    );
    return hit?.key ?? null;
  }

  markAsked(key: string, now: number): void {
    this.db.prepare('UPDATE nft_collections SET asked_at = ? WHERE key = ?').run(now, key);
  }

  /** The biggest collections: replaces the previous list. */
  setTop(matches: NftMatch[], now: number): void {
    this.db.prepare('UPDATE nft_collections SET top = 0').run();
    for (const m of matches) {
      this.add(m, now);
      this.db.prepare('UPDATE nft_collections SET top = 1 WHERE key = ?').run(m.key);
    }
  }

  /** What the sync keeps up to date: CybeReator, popular and the biggest collections, and anything asked about lately. */
  watchlist(now: number): string[] {
    return this.due(now, 0).map((d) => d.key);
  }

  /**
   * Followed collections whose latest reading is older than `maxAge` (or that were never read): never-read
   * first (asked about, then popular, then the top list), then the stalest.
   */
  due(now: number, maxAge: number): { key: string; last: number | null }[] {
    const rows = this.db
      .prepare(
        `SELECT c.key AS key, c.asked_at AS asked, c.pinned AS pinned, (SELECT MAX(at) FROM nft_snapshots s WHERE s.key = c.key) AS last
         FROM nft_collections c WHERE c.pinned = 1 OR c.top = 1 OR c.asked_at >= ?`,
      )
      .all(now - ASKED_DAYS * DAY) as { key: string; asked: number | null; pinned: number; last: number | null }[];
    // Never read: asked about first, then the popular ones, then the rest of the top list.
    const rank = (r: (typeof rows)[number]) => (r.last !== null ? 3 : r.asked !== null ? 0 : r.pinned ? 1 : 2);
    return rows
      .filter((r) => r.last === null || now - r.last >= maxAge)
      .sort((a, b) => rank(a) - rank(b) || (a.last ?? 0) - (b.last ?? 0) || (b.asked ?? 0) - (a.asked ?? 0) || a.key.localeCompare(b.key))
      .map(({ key, last }) => ({ key, last }));
  }

  record(s: NftSnapshot): void {
    this.add({ key: s.key, name: s.name, symbol: s.symbol, chain: s.chain }, s.at);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO nft_snapshots (key, at, currency, floor, floor_usd, change_24h, change_7d, change_30d, volume_24h,
           volume_24h_usd, volume_total, market_cap_usd, owners, supply, listed, sales_24h, url, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        s.key,
        s.at,
        s.currency,
        s.floor,
        s.floorUsd,
        s.change24h,
        s.change7d,
        s.change30d,
        s.volume24h,
        s.volume24hUsd,
        s.volumeTotal,
        s.marketCapUsd,
        s.owners,
        s.supply,
        s.listed,
        s.sales24h,
        s.url,
        s.source,
      );
  }

  latest(key: string): NftSnapshot | null {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM nft_snapshots s JOIN nft_collections c ON c.key = s.key WHERE s.key = ? ORDER BY s.at DESC LIMIT 1`)
      .get(key) as NftSnapshot | undefined;
    return row ?? null;
  }

  /**
   * How the floor moved over `days`, from Ledger's own readings: for sources that don't report changes
   * (ValueMint). Null until there's a reading from at least that long ago.
   */
  floorChange(key: string, days: number, now: number): number | null {
    const latest = this.latest(key);
    const then = this.db
      .prepare('SELECT floor FROM nft_snapshots WHERE key = ? AND at <= ? AND floor > 0 ORDER BY at DESC LIMIT 1')
      .get(key, now - days * DAY) as { floor: number } | undefined;
    // A reading much older than asked for would overstate the window: it must be within a day of it.
    const old = this.db.prepare('SELECT MIN(at) AS first FROM nft_snapshots WHERE key = ?').get(key) as { first: number | null };
    if (!latest?.floor || !then || old.first === null || old.first > now - days * DAY) return null;
    return latest.floor / then.floor - 1;
  }

  /** The lowest and highest floor read between two moments, or null if there was no reading. */
  floorRange(key: string, from: number, to: number): { high: number; low: number } | null {
    const row = this.db
      .prepare('SELECT MAX(floor) AS high, MIN(floor) AS low FROM nft_snapshots WHERE key = ? AND at > ? AND at <= ? AND floor > 0')
      .get(key, from, to) as { high: number | null; low: number | null };
    return row.high !== null && row.low !== null ? { high: row.high, low: row.low } : null;
  }

  /** The floor at the end of each UTC day Ledger has readings for, oldest first: its own floor history. */
  dailyFloors(key: string): { date: string; close: number }[] {
    const rows = this.db
      .prepare(
        `SELECT at, floor FROM nft_snapshots WHERE key = ? AND floor > 0 AND rowid IN (
           SELECT MAX(rowid) FROM nft_snapshots WHERE key = ? AND floor > 0 GROUP BY at / ${DAY}) ORDER BY at`,
      )
      .all(key, key) as { at: number; floor: number }[];
    return rows.map((r) => ({ date: new Date(r.at).toISOString().slice(0, 10), close: r.floor }));
  }

  /** The latest readings of the biggest collections, by market cap, with CybeReator first. */
  top(limit: number): NftSnapshot[] {
    const keys = this.db.prepare('SELECT key FROM nft_collections WHERE top = 1 OR pinned = 1').all() as { key: string }[];
    return keys
      .flatMap((k) => this.latest(k.key) ?? [])
      .sort((a, b) => Number(b.key === CYBEREATOR.key) - Number(a.key === CYBEREATOR.key) || (b.marketCapUsd ?? 0) - (a.marketCapUsd ?? 0))
      .slice(0, limit);
  }

  /** Thins old readings to one a day per collection, and drops collections nobody follows any more. */
  prune(now: number): void {
    const cutoff = now - FULL_DAYS * DAY;
    this.db
      .prepare(
        `DELETE FROM nft_snapshots WHERE at < ? AND rowid NOT IN (
           SELECT MAX(rowid) FROM nft_snapshots WHERE at < ? GROUP BY key, at / ${DAY})`,
      )
      .run(cutoff, cutoff);
    this.db.prepare('DELETE FROM nft_snapshots WHERE at < ?').run(now - 400 * DAY);
  }
}
