import { log } from '../log.js';
import type { DripStack } from './dripstack.js';
import type { AnalystStore } from './store.js';

const MINUTE = 60_000;
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Keeps the analyst calls up to date in the background, like the tape: the first run loads the last 30
 * days (one request), then every 30 minutes the last two days are read again (writers publish late, and
 * stored calls are never duplicated). Chats and stress tests only ever read the store.
 */
export class AnalystRefresher {
  private running = false;
  private lastRun = 0;
  private lastPrune = 0;

  constructor(
    private readonly deps: { client: DripStack; store: AnalystStore; every?: number; now?: () => number },
  ) {}

  /** Runs a sync if one is due. Returns how many new calls were stored, or null if nothing ran. */
  async tick(): Promise<number | null> {
    const now = (this.deps.now ?? Date.now)();
    if (this.running || !this.deps.client.enabled || now - this.lastRun < (this.deps.every ?? 30 * MINUTE)) return null;
    this.running = true;
    this.lastRun = now;
    try {
      const { store, client } = this.deps;
      const { newest } = store.status();
      // Nothing stored, or stored long ago (the bot was off): load the whole month again.
      const from = newest === null || now - newest > 3 * DAY ? iso(now - 29 * DAY) : iso(now - DAY);
      const added = store.upsert(await client.picks(from, iso(now)), now);
      if (now - this.lastPrune > DAY) {
        this.lastPrune = now;
        store.prune(now);
      }
      // The first load is worth seeing in the log; later syncs only when something failed.
      const message = `Analyst calls synced from ${from}: ${added} new, ${store.status().calls} stored`;
      if (newest === null) log.info(message);
      else log.debug(message);
      return added;
    } catch (err) {
      log.warn('Analyst sync failed', err);
      return null;
    } finally {
      this.running = false;
    }
  }
}
