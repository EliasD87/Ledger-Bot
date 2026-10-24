import type { Desk, FlowReport, MacroReport, MarketReport } from './desk.js';
import type { Purchase } from './treasuries.js';
import { log } from '../log.js';

/** The latest tape in one go: flows, BTC buys, macro, the market board. Sections without data are left out. */
export interface Recap {
  flows: FlowReport[];
  treasuryBuys: Purchase[];
  /** False until the first background scan of company purchases finishes. */
  treasuriesReady: boolean;
  macro: MacroReport | null;
  market: MarketReport | null;
}

/** Spot ETFs worth a daily line; fund-by-fund detail only for the two big ones (it costs a request per fund). */
const LEDGER_FLOWS: { asset: string; withFunds: boolean }[] = [
  { asset: 'BTC', withFunds: true },
  { asset: 'ETH', withFunds: true },
  { asset: 'SOL', withFunds: false },
  { asset: 'XRP', withFunds: false },
];

/**
 * Gathers every section at once. With `timeoutMs` (chat), a section still loading by then is left
 * out and named in `pending`; its request keeps running and fills the cache for the next ask.
 */
export async function buildRecap(desk: Desk, opts: { timeoutMs?: number } = {}): Promise<Recap & { pending: string[] }> {
  const pending: string[] = [];
  const section = async <T>(name: string, load: () => Promise<T>): Promise<T | null> => {
    const loading = load().catch((err: unknown) => {
      log.warn(`Recap: ${name} unavailable`, err);
      return null;
    });
    if (!opts.timeoutMs) return loading;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<'late'>((resolve) => (timer = setTimeout(() => resolve('late'), opts.timeoutMs)));
    const result = await Promise.race([loading, late]);
    clearTimeout(timer);
    if (result === 'late') {
      pending.push(name);
      return null;
    }
    return result;
  };
  const [flows, macro, market] = await Promise.all([
    Promise.all(LEDGER_FLOWS.map((f) => section(`${f.asset} flows`, () => desk.flows(f.asset, f)))),
    section('macro', () => desk.macro()),
    section('market', () => desk.market()),
  ]);
  return {
    flows: flows.filter((f): f is FlowReport => f !== null),
    treasuryBuys: desk.treasuryBuys(7),
    treasuriesReady: desk.treasuries.ready,
    macro,
    market,
    pending,
  };
}
