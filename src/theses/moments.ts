import type { MarketHistory } from '../analysis/history.js';
import { measuredSeries, typicalRange } from '../charts/charts.js';
import type { History } from '../analysis/history.js';
import type { Measure } from './measure.js';
import { held } from './spec.js';
import type { MomentKind, Thesis, ThesisStore } from './store.js';

export interface Moment {
  thesis: Thesis;
  kind: MomentKind;
  /** The measure right now. */
  value: number;
}

const DAY = 86_400_000;
const EVERY = 10 * 60_000;

/**
 * Watches logged takes between logging and check-back for the moments worth a word in their thread:
 * the target reached early, given back after that, and a move against the take bigger than its usual
 * range for the whole window. Each is posted once per take. ETF-flow takes only count at the end.
 */
export class MomentWatcher {
  private last = 0;
  private running = false;
  /** The usual range of each take's window, worked out once from history up to its logging day. */
  private readonly bands = new Map<number, { lo: number; hi: number } | null>();

  constructor(private readonly deps: { store: ThesisStore; measure: Pick<Measure, 'now'>; history: MarketHistory; now?: () => number }) {}

  async tick(): Promise<Moment[]> {
    const now = (this.deps.now ?? Date.now)();
    if (this.running || now - this.last < EVERY) return [];
    this.running = true;
    this.last = now;
    const out: Moment[] = [];
    try {
      for (const t of this.deps.store.allOpen()) {
        if (t.spec.kind === 'flows' || t.startValue === null || !t.startAt || !t.checkAt || now >= t.checkAt) continue;
        const value = await this.deps.measure.now(t.spec, t.startAt).catch(() => null);
        if (value === null) continue;
        const kind = await this.moment(t, value);
        if (kind && this.deps.store.markMoment(t.id, kind, now)) out.push({ thesis: t, kind, value });
      }
    } finally {
      this.running = false;
    }
    return out;
  }

  private async moment(t: Thesis, value: number): Promise<MomentKind | null> {
    const { store } = this.deps;
    const holding = held(t.spec, t.startValue!, value);
    if (holding) return store.hasMoment(t.id, 'reached') ? null : 'reached';
    if (store.hasMoment(t.id, 'reached')) return store.hasMoment(t.id, 'slipped') ? null : 'slipped';
    if (store.hasMoment(t.id, 'pressure')) return null;
    const band = await this.band(t);
    if (!band) return null;
    // Against the take, past the edge of the whole window's usual range.
    const against = t.spec.direction === 'up' ? value < band.lo : value > band.hi;
    return against ? 'pressure' : null;
  }

  private async band(t: Thesis): Promise<{ lo: number; hi: number } | null> {
    if (this.bands.has(t.id)) return this.bands.get(t.id)!;
    const symbols = t.spec.kind === 'relative' ? [t.spec.asset, t.spec.versus!] : [t.spec.asset];
    const kinds = [t.spec.assetKind, t.spec.versusKind];
    const histories: History[] = [];
    for (const [i, s] of symbols.entries()) {
      const asset = await this.deps.history.identify(s, kinds[i]).catch(() => null);
      const h = asset && (await this.deps.history.daily(asset).catch(() => null));
      if (!h) return null;
      histories.push(h);
    }
    const before = measuredSeries(t.spec, histories).filter((c) => Date.parse(`${c.date}T00:00:00Z`) <= t.startAt!);
    const band = typicalRange(before, t.startValue!, t.spec.horizonDays, histories.some((h) => h.asset.kind === 'stock'));
    this.bands.set(t.id, band);
    return band;
  }
}

/** Days left before a check-back, rounded for people ("9 days", "a day", "hours"). */
export function timeLeft(checkAt: number, now: number): string {
  const days = (checkAt - now) / DAY;
  if (days < 1) return 'hours';
  const n = Math.round(days);
  return n === 1 ? 'a day' : `${n} days`;
}
