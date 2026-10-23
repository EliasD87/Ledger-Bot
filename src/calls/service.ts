import { formatDuration, formatPrice } from '../format.js';
import { type CallKind, type Direction, type Quote, RULES, type Side, quote, winChance } from './odds.js';
import type { BinanceFeed } from './prices.js';
import { type Board, type Call, ceilMinute } from './store.js';

const DAY = 24 * 60 * 60 * 1000;

/** How long a caller has to press "Lock it in" before the draft's chance is too stale to honour. */
export const DRAFT_TTL_MS = 10 * 60 * 1000;

export type PriceSource = Pick<BinanceFeed, 'resolve' | 'spot' | 'dailyVol'>;

export interface CallRequest {
  asset: string;
  direction: Direction;
  target: number;
  windowMs: number;
  kind: CallKind;
}

export interface PricedCall {
  /** Ticker without the quote currency, e.g. "BTC". */
  base: string;
  spot: number;
  dailyVol: number;
  quote: Quote;
}

/**
 * Prices a call against live market data; null if the feed has no market for the asset.
 * Throws if the feed fails or the asset is too new to price.
 */
export async function priceCall(feed: PriceSource, req: CallRequest): Promise<PricedCall | null> {
  const symbol = await feed.resolve(req.asset);
  if (!symbol) return null;
  const [spot, dailyVol] = await Promise.all([feed.spot(symbol), feed.dailyVol(symbol)]);
  return {
    base: symbol.replace(/USDT$/, ''),
    spot,
    dailyVol,
    quote: quote({ ...req, spot, dailyVol, days: req.windowMs / DAY }),
  };
}

/**
 * For a call the board refused as too far out or too easy: the nearest round target, same asset,
 * direction, kind and window, that the board would score (rated about 20% or about 75%).
 * Pure: reuses the volatility already fetched. Null if no round number fits.
 */
export function scoreableTarget(req: CallRequest, priced: Pick<PricedCall, 'spot' | 'dailyVol' | 'quote'>): { target: number; chance: number } | null {
  if (priced.quote.ok || (priced.quote.reason !== 'too-far' && priced.quote.reason !== 'too-easy')) return null;
  const goal = priced.quote.reason === 'too-far' ? 0.2 : 0.75;
  const { spot, dailyVol } = priced;
  const days = req.windowMs / DAY;
  const chanceAt = (target: number) => winChance({ spot, target, direction: req.direction, kind: req.kind, dailyVol, days });
  // The chance falls as the target rises for "above" calls and rises with it for "below" calls: bisect on log price.
  const spread = dailyVol * RULES.volMargin * Math.sqrt(days);
  let lo = Math.log(spot) - 10 * spread;
  let hi = Math.log(spot) + 10 * spread;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const c = chanceAt(Math.exp(mid));
    if (req.direction === 'above' ? c < goal : c > goal) hi = mid;
    else lo = mid;
  }
  // The roundest number that stays within 10 points of the goal; failing that, the closest one the board accepts.
  const exact = Math.exp((lo + hi) / 2);
  const candidates = [2, 3, 4]
    .map((digits) => {
      const target = roundSignificant(exact, digits);
      const q = quote({ ...req, target, spot, dailyVol, days });
      return q.ok ? { target, chance: q.chance } : null;
    })
    .filter((c): c is { target: number; chance: number } => c !== null);
  return candidates.find((c) => Math.abs(c.chance - goal) <= 0.1) ?? candidates.sort((a, b) => Math.abs(a.chance - goal) - Math.abs(b.chance - goal))[0] ?? null;
}

function roundSignificant(n: number, digits: number): number {
  const step = 10 ** (Math.floor(Math.log10(n)) - digits + 1);
  return Math.round(n / step) * step;
}

/**
 * Prices a call and, if the board accepts it, saves it as a draft for the caller to lock in.
 * `call` is set only when a draft was created; otherwise `priced` says why not (null = unknown asset).
 */
export async function draftCall(
  feed: PriceSource,
  board: Board,
  who: { guildId: string; channelId: string; callerId: string },
  req: CallRequest,
  now: number,
): Promise<{ priced: PricedCall | null; call?: Call }> {
  const priced = await priceCall(feed, req);
  if (!priced?.quote.ok) return { priced };
  const call = board.createDraft({
    ...who,
    symbol: `${priced.base}USDT`,
    base: priced.base,
    direction: req.direction,
    kind: req.kind,
    target: req.target,
    deadline: ceilMinute(now + req.windowMs),
    entryPrice: priced.spot,
    chance: priced.quote.chance,
    payout: priced.quote.payout,
    now,
  });
  return { priced, call };
}

/** Prices one side of an existing call at this moment, for the time it has left. */
export async function quoteNow(
  feed: PriceSource,
  call: Call,
  side: Side,
  now: number,
): Promise<{ spot: number; quote: Quote }> {
  const [spot, dailyVol] = await Promise.all([feed.spot(call.symbol), feed.dailyVol(call.symbol)]);
  const scenario = { spot, target: call.target, direction: call.direction, kind: call.kind, dailyVol, days: (call.deadline - now) / DAY };
  return { spot, quote: quote(scenario, side) };
}

/** Why the board turned a quote down, in Ledger's voice. */
export function refusalText(q: Exclude<Quote, { ok: true }>, base: string, spot: number): string {
  switch (q.reason) {
    case 'bad-price':
      return "That target isn't a price.";
    case 'bad-window':
      return `Windows run from 1 hour to ${RULES.maxDays} days.`;
    case 'already-there':
      return `${base} is already past that (spot ${formatPrice(spot)}). That's not a call, that's a screenshot.`;
    case 'too-easy':
      return `That's a ${Math.round((q.chance ?? 1) * 100)}% chance. The board doesn't score weather reports.`;
    case 'too-far':
      return `That's rated ${Math.max(1, Math.round((q.chance ?? 0) * 100))}%: too far out to score fairly. Pick a closer target or a longer window.`;
  }
}

/** "**BTC** ≥ 90,000 within 7d" or "**BTC** ≥ 90,000 at the 7d mark". */
export function describeCall(base: string, req: CallRequest): string {
  const sign = req.direction === 'above' ? '≥' : '≤';
  const when = req.kind === 'touch' ? `within ${formatDuration(req.windowMs)}` : `at the ${formatDuration(req.windowMs)} mark`;
  return `**${base}** ${sign} ${formatPrice(req.target)} ${when}`;
}

/** "BTC ≥ 90,000", the part of a call that doesn't depend on time. */
export function callHeadline(call: Pick<Call, 'base' | 'direction' | 'target'>): string {
  return `${call.base} ${call.direction === 'above' ? '≥' : '≤'} ${formatPrice(call.target)}`;
}
