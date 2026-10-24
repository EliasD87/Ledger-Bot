import { formatPrice } from '../format.js';

/** What a thesis measures. Every take that goes on the record becomes one of these. */
export type ThesisKind = 'price' | 'move' | 'relative' | 'flows';

export interface ThesisSpec {
  kind: ThesisKind;
  /** "SOL", "NVDA", "BTC" (for flows: the ETF asset). */
  asset: string;
  /** relative only: the asset it's measured against. */
  versus?: string;
  /** price: ends above (up) or below (down) the target. move/relative: rises or falls. flows: net in (up) or out (down). */
  direction: 'up' | 'down';
  /** price only. */
  target?: number;
  /** move/relative: the minimum change as a fraction (0.1 = 10%); 0 or absent means any. */
  pct?: number;
  /** 1 to 365. */
  horizonDays: number;
}

export const MIN_DAYS = 1;
export const MAX_DAYS = 365;

/** Why a spec can't go on the record, or null if it can. */
export function specProblem(s: ThesisSpec): string | null {
  if (!s.asset) return 'Which asset?';
  if (!(s.horizonDays >= MIN_DAYS && s.horizonDays <= MAX_DAYS)) return 'Check-backs run from 1 day to a year.';
  if (s.kind === 'price' && !(s.target && s.target > 0)) return 'A price take needs a target price.';
  if (s.kind === 'relative' && !s.versus) return 'Measured against what?';
  if (s.kind === 'relative' && s.versus === s.asset) return 'That compares an asset with itself.';
  if (s.pct !== undefined && !(s.pct >= 0 && s.pct < 10)) return 'That percentage is out of range.';
  return null;
}

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;

/** The claim in plain words, written by code so the record says exactly what will be checked. */
export function claimText(s: ThesisSpec): string {
  const p = s.pct ? ` ${pct(s.pct)}+` : '';
  switch (s.kind) {
    case 'price':
      return `${s.asset} ${s.direction === 'up' ? 'above' : 'below'} ${formatPrice(s.target!)} in ${days(s.horizonDays)}`;
    case 'move':
      return `${s.asset} ${s.direction === 'up' ? 'up' : 'down'}${p || ''} over ${days(s.horizonDays)}`;
    case 'relative':
      return `${s.asset} ${s.direction === 'up' ? 'beats' : 'trails'} ${s.versus}${s.pct ? ` by${p}` : ''} over ${days(s.horizonDays)}`;
    case 'flows':
      return `${s.asset} spot ETFs net ${s.direction === 'up' ? 'inflows' : 'outflows'} over ${days(s.horizonDays)}`;
  }
}

/** What gets measured, for labels: "SOL price", "SOL/ETH". */
export function measureLabel(s: ThesisSpec): string {
  if (s.kind === 'relative') return `${s.asset}/${s.versus}`;
  if (s.kind === 'flows') return `${s.asset} ETF net flows`;
  return `${s.asset} price`;
}

/**
 * Whether the thesis held, from the measure at the start and at the check-back. For flows, `end` is
 * the window's summed net flow and `start` is unused.
 */
export function held(s: ThesisSpec, start: number, end: number): boolean {
  const up = s.direction === 'up';
  switch (s.kind) {
    case 'price':
      return up ? end >= s.target! : end <= s.target!;
    case 'move':
    case 'relative': {
      const change = end / start - 1;
      const need = s.pct ?? 0;
      if (up) return need > 0 ? change >= need : change > 0;
      return need > 0 ? change <= -need : change < 0;
    }
    case 'flows':
      return up ? end > 0 : end < 0;
  }
}

/** The change in the measure that the thesis needs from here, as a fraction, or null where that doesn't apply. */
export function neededChange(s: ThesisSpec, now: number): number | null {
  if (s.kind === 'price') return s.target! / now - 1;
  if (s.kind === 'move' || s.kind === 'relative') return (s.direction === 'up' ? 1 : -1) * (s.pct ?? 0);
  return null;
}

function days(n: number): string {
  if (n % 7 === 0 && n <= 56) return n === 7 ? 'a week' : `${n / 7} weeks`;
  if (n === 30) return 'a month';
  if (n === 365) return 'a year';
  return n === 1 ? 'a day' : `${n} days`;
}
