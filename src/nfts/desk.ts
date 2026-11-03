import { log } from '../log.js';
import type { NftMatch, NftSnapshot, NftSources } from './sources.js';
import type { NftStore } from './store.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** How many of the biggest collections Ledger keeps up to date without being asked. */
const TOP = 25;

export type NftLookup =
  | { found: NftSnapshot; others: string[] }
  | { notFound: string; others: string[] }
  /** A source couldn't be read just now: the collection may well exist. */
  | { unavailable: string };

/**
 * NFT numbers for Ledger. Like the tape, a background sync does the fetching: every 30 minutes it reads
 * CybeReator, the biggest collections and anything members asked about in the last week, and keeps the
 * readings. Chats read those; only the first question about a new collection fetches it live (once), and
 * from then on it's on the sync list.
 */
export class NftDesk {
  private running = false;
  private lastRun = 0;
  private lastTop = 0;
  private lastPrune = 0;

  constructor(private readonly deps: { store: NftStore; sources: NftSources; every?: number; now?: () => number }) {}

  /** Runs a sync if one is due. Returns how many collections were read, or null if nothing ran. */
  async tick(): Promise<number | null> {
    const now = this.now();
    if (this.running || now - this.lastRun < (this.deps.every ?? 30 * MINUTE)) return null;
    this.running = true;
    this.lastRun = now;
    const { store, sources } = this.deps;
    try {
      if (now - this.lastTop > DAY) {
        const top = await sources.top(TOP).catch((err) => (log.debug('NFT top list failed', err), null));
        if (top?.length) {
          store.setTop(top, now);
          this.lastTop = now;
        }
      }
      let read = 0;
      for (const key of store.watchlist(now)) {
        // Skip what a member's question read moments ago.
        const last = store.latest(key);
        if (last && now - last.at < 20 * MINUTE) continue;
        try {
          const s = await sources.snapshot(key, true);
          if (s) {
            store.record(s);
            read++;
          }
        } catch (err) {
          log.debug(`NFT reading for ${key} failed`, err);
        }
      }
      if (now - this.lastPrune > DAY) {
        this.lastPrune = now;
        store.prune(now);
      }
      log.debug(`NFT sync: ${read} collections read`);
      return read;
    } catch (err) {
      log.warn('NFT sync failed', err);
      return null;
    } finally {
      this.running = false;
    }
  }

  /** The collection a member means and its latest reading; new collections are read once and then synced. */
  async lookup(query: string): Promise<NftLookup> {
    const { store, sources } = this.deps;
    const now = this.now();
    let key = store.find(query);
    let others: string[] = [];
    let failed = false;
    const tryRead = async <T>(read: () => Promise<T>): Promise<T | null> => {
      try {
        return await read();
      } catch (err) {
        failed = true;
        log.debug(`NFT lookup for "${query}" hit an error`, err);
        return null;
      }
    };
    if (!key) {
      const matches = (await tryRead(() => sources.search(query))) ?? ([] as NftMatch[]);
      const q = query.trim().toLowerCase();
      const best = matches.find((m) => m.name.toLowerCase() === q || m.symbol?.toLowerCase() === q) ?? matches[0];
      others = matches.filter((m) => m !== best).map((m) => m.name).slice(0, 4);
      if (best) {
        store.add(best, now);
        key = best.key;
      }
    }
    let reading = key ? store.latest(key) : null;
    if (key && (!reading || now - reading.at > 2 * HOUR)) {
      const fresh = await tryRead(() => sources.snapshot(key!));
      if (fresh) {
        store.record(fresh);
        reading = fresh;
      }
    }
    // A Solana collection CoinGecko doesn't list may still be on Magic Eden.
    if (!reading) {
      const me = await sources.magicEdenByName(query).catch(() => null); // a miss there is normal, not a failure
      if (me) {
        store.record(me);
        reading = me;
      }
    }
    if (!reading) return failed ? { unavailable: query } : { notFound: query, others };
    store.markAsked(reading.key, now);
    return { found: this.withChanges(reading), others };
  }

  /** The biggest collections' latest readings, CybeReator first. */
  top(limit = 10): NftSnapshot[] {
    return this.deps.store.top(limit).map((s) => this.withChanges(s));
  }

  /** Fills in floor changes the source doesn't report, from Ledger's own readings. */
  private withChanges(s: NftSnapshot): NftSnapshot {
    const now = this.now();
    const { store } = this.deps;
    return {
      ...s,
      change24h: s.change24h ?? store.floorChange(s.key, 1, now),
      change7d: s.change7d ?? store.floorChange(s.key, 7, now),
      change30d: s.change30d ?? store.floorChange(s.key, 30, now),
    };
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}
