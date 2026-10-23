export type Direction = 'above' | 'below';
/** touch: wins the moment price reaches the target before the deadline. close: judged on the price at the deadline. */
export type CallKind = 'touch' | 'close';

export interface Rules {
  /** Points scale: a call scores scale × (result − rating). */
  scale: number;
  /** Calls rated below this are refused: too far out to score fairly. */
  minWinChance: number;
  /** Calls rated above this are refused: weather reports. */
  maxWinChance: number;
  /** Measured volatility is inflated by this factor before pricing. */
  volMargin: number;
  minDays: number;
  maxDays: number;
}

/**
 * A call is a record, not a wager: it scores its result minus its rating. Right on a call rated 18%
 * is +82; wrong is −18. With a well-calibrated rating, guessing averages zero, so the only way up is
 * reading the market better than the rating does. Calibrated with `npm run backtest` (8 large coins,
 * ~2.3 years of daily candles): every rating band from 10% to 90% averages within ±2 per call.
 */
export const RULES: Rules = {
  scale: 100,
  minWinChance: 0.1,
  maxWinChance: 0.9,
  volMargin: 1.0,
  minDays: 1 / 24,
  maxDays: 90,
};

export interface Scenario {
  spot: number;
  target: number;
  direction: Direction;
  kind: CallKind;
  /** Standard deviation of daily log returns, as measured. */
  dailyVol: number;
  /** Time left until the deadline, in days. */
  days: number;
}

export type Quote =
  | { ok: true; chance: number; /** points if right */ payout: number; /** points lost if wrong */ stake: number }
  | { ok: false; reason: 'bad-price' | 'bad-window' | 'already-there' | 'too-easy' | 'too-far'; chance?: number };

/**
 * CDF of a Student-t distribution with 4 degrees of freedom, scaled to unit variance.
 * Crypto returns have fat tails: a normal distribution makes big moves look far rarer than they
 * are, which would let members farm long-shot calls.
 */
export function fatTailCdf(z: number): number {
  const x = z * Math.SQRT2; // t(4) has variance 2
  const q = 1 + (x * x) / 4;
  return 0.5 + 0.375 * (x / Math.sqrt(q)) * (1 - (x * x) / (12 * q));
}

/** Chance the call comes true, modelling log price as a driftless, fat-tailed random walk. */
export function winChance(s: Scenario, rules: Rules = RULES): number {
  const spread = s.dailyVol * rules.volMargin * Math.sqrt(s.days);
  const distance = Math.log(s.target / s.spot); // > 0 when the target is above spot
  if (s.kind === 'touch') {
    const reached = s.direction === 'above' ? distance <= 0 : distance >= 0;
    // Reflection principle: P(touch within T) ≈ 2 × P(finish beyond the target at T).
    return reached ? 1 : Math.min(1, 2 * fatTailCdf(-Math.abs(distance) / spread));
  }
  return s.direction === 'above' ? fatTailCdf(-distance / spread) : fatTailCdf(distance / spread);
}

/** What a call rated `chance` scores: +scale × (1 − chance) if right, −scale × chance if wrong. */
export function recordTerms(chance: number, rules: Rules = RULES): { payout: number; stake: number } {
  return { payout: Math.round(rules.scale * (1 - chance)), stake: Math.round(rules.scale * chance) };
}

/** Backing a call wins if it comes true; fading wins if it doesn't. */
export type Side = 'back' | 'fade';

/** Prices one side of a call and applies the board's rules. */
export function quote(s: Scenario, side: Side = 'back', rules: Rules = RULES): Quote {
  if (!(s.spot > 0) || !(s.target > 0)) return { ok: false, reason: 'bad-price' };
  if (!(s.days >= rules.minDays && s.days <= rules.maxDays)) return { ok: false, reason: 'bad-window' };
  const callChance = winChance(s, rules);
  if (callChance >= 1) return { ok: false, reason: 'already-there', chance: callChance };
  const chance = side === 'back' ? callChance : 1 - callChance;
  if (chance > rules.maxWinChance) return { ok: false, reason: 'too-easy', chance };
  if (chance < rules.minWinChance) return { ok: false, reason: 'too-far', chance };
  return { ok: true, chance, ...recordTerms(chance, rules) };
}

/** Standard deviation of daily log returns. Needs at least 8 closes to mean anything. */
export function dailyVolatility(closes: number[]): number {
  if (closes.length < 8) throw new Error(`need at least 8 daily closes, got ${closes.length}`);
  const returns = closes.slice(1).map((close, i) => Math.log(close / closes[i]!));
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (returns.length - 1);
  // Floor it so a pegged asset can't produce division-by-zero odds.
  return Math.max(Math.sqrt(variance), 0.002);
}
