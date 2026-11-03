import { log } from '../log.js';
import { type NftMatch, type NftSnapshot, NftSourceBusy, type NftSources } from './sources.js';
import type { NftStore } from './store.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** How many of the biggest collections Ledger keeps up to date without being asked. */
const TOP = 20;
/** CoinGecko and Magic Eden readings are refreshed this often; floors don't need more. */
const REFRESH = 3 * HOUR;
/** At most this many CoinGecko or Magic Eden reads per sync (15 seconds apart), so the free limits are never pushed. */
const PER_TICK = 6;

export type NftLookup =
  | { found: NftSnapshot; others: string[] }
  | { notFound: string; others: string[] }
  /** Not stored yet and the source can't be read right now: queued for the background sync. */
  | { loading: string };

/**
 * NFT numbers for Ledger. Fetched once, stored, and kept up to date in the background, gently:
 * - every 10 minutes the sync reads CybeReator (ValueMint's own API, updated every minute) and up to six
 *   other collections whose reading is over 3 hours old (never-read ones first), 15 seconds apart;
 * - a rate limit pauses that source for 5 minutes instead of retrying into it.
 * Chats answer from the store. Only a collection that was never stored is fetched live, once; if the source
 * is busy, it's queued and the next sync loads it.
 */
export class NftDesk {
  private running = false;
  private lastRun = 0;
  private lastTop = 0;
  private lastPrune = 0;
  /** Names members asked about that couldn't be looked up yet. */
  private readonly pending = new Set<string>();
  /** When each collection was last tried, so one that keeps failing waits its turn instead of blocking the rest. */
  private readonly tried = new Map<string, number>();

  constructor(private readonly deps: { store: NftStore; sources: NftSources; every?: number; now?: () => number }) {}

  /** Runs a sync if one is due. Returns how many collections were read, or null if nothing ran. */
  async tick(): Promise<number | null> {
    const now = this.now();
    if (this.running || now - this.lastRun < (this.deps.every ?? 10 * MINUTE)) return null;
    this.running = true;
    this.lastRun = now;
    const { store, sources } = this.deps;
    let read = 0;
    let budget = PER_TICK;
    const busy = (err: unknown) => err instanceof NftSourceBusy;
    try {
      // CybeReator and other ValueChain collections: their own API, every sync.
      for (const { key } of store.due(now, 5 * MINUTE).filter((d) => d.key.startsWith('vm:'))) {
        const s = await sources.snapshot(key, true).catch((err) => (log.debug(`NFT reading for ${key} failed`, err), null));
        if (s) {
          store.record(s);
          read++;
        }
      }
      // Names members asked about while the source was busy.
      for (const query of [...this.pending]) {
        if (budget <= 0 || sources.paused('cg:')) break;
        budget--;
        try {
          const best = pickMatch(query, await sources.search(query, true));
          this.pending.delete(query);
          if (best) {
            store.add(best, now);
            store.markAsked(best.key, now);
          }
        } catch (err) {
          if (!busy(err)) this.pending.delete(query);
        }
      }
      if (now - this.lastTop > DAY && budget > 0 && !sources.paused('cg:')) {
        budget--;
        const top = await sources.top(TOP).catch((err) => (log.debug('NFT top list failed', err), null));
        if (top?.length) {
          store.setTop(top, now);
          this.lastTop = now;
        }
      }
      // Everything else, never-read and stalest first, a few per sync.
      for (const { key } of store.due(now, REFRESH).filter((d) => !d.key.startsWith('vm:'))) {
        if (budget <= 0) break;
        if (sources.paused(key) || now - (this.tried.get(key) ?? 0) < REFRESH) continue;
        budget--;
        this.tried.set(key, now);
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

  /** The collection a member means and its stored reading. Only a never-stored collection is fetched, once. */
  async lookup(query: string): Promise<NftLookup> {
    const { store, sources } = this.deps;
    const now = this.now();
    let key = store.find(query);
    let others: string[] = [];
    let busy = false;
    const tryRead = async <T>(read: () => Promise<T>): Promise<T | null> => {
      try {
        return await read();
      } catch (err) {
        if (err instanceof NftSourceBusy) busy = true;
        log.debug(`NFT lookup for "${query}" hit an error`, err);
        return null;
      }
    };
    if (!key) {
      const matches = await tryRead(() => sources.search(query));
      if (busy) {
        this.pending.add(query.trim().toLowerCase());
        return { loading: query };
      }
      const best = pickMatch(query, matches ?? []);
      others = (matches ?? []).filter((m) => m !== best).map((m) => m.name).slice(0, 4);
      if (best) {
        store.add(best, now);
        key = best.key;
      }
    }
    if (key) store.markAsked(key, now);
    let reading = key ? store.latest(key) : null;
    if (key && !reading) {
      const fresh = await tryRead(() => sources.snapshot(key!));
      if (fresh) {
        store.record(fresh);
        reading = fresh;
      } else if (busy) {
        return { loading: query }; // on the sync list now (asked about): the next sync reads it
      }
    }
    // A Solana collection CoinGecko doesn't list may still be on Magic Eden.
    if (!reading && !key) {
      const me = await sources.magicEdenByName(query).catch(() => null); // a miss there is normal, not a failure
      if (me) {
        store.record(me);
        store.markAsked(me.key, now);
        reading = me;
      }
    }
    if (!reading) return { notFound: query, others };
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

/** The search result a member most likely means: an exact name or symbol, else the first. */
function pickMatch(query: string, matches: NftMatch[]): NftMatch | undefined {
  const q = query.trim().toLowerCase();
  return matches.find((m) => m.name.toLowerCase() === q || m.symbol?.toLowerCase() === q) ?? matches[0];
}
