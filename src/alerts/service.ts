import type { BinanceFeed } from '../calls/prices.js';
import { dayLabel } from '../format.js';
import { type Desk, ETF_ASSETS } from '../desk/desk.js';
import { formatPrice } from '../format.js';
import type { Alert, AlertStore } from './store.js';

export const MAX_ALERTS_PER_MEMBER = 20;

export type AlertRequest =
  | { kind: 'price'; asset: string; direction: 'above' | 'below'; price: number }
  | { kind: 'move'; asset: string; percent: number }
  | { kind: 'day-move'; asset: string; percent: number }
  | { kind: 'etf-flow'; asset: string }
  | { kind: 'macro'; event: string }
  | { kind: 'treasury' };

export interface AlertDepsForCreate {
  store: AlertStore;
  feed: Pick<BinanceFeed, 'resolve' | 'spot'>;
  desk: Desk | null;
}

type Result = { ok: true; alert: Alert; summary: string } | { ok: false; error: string };

const NEEDS_DESK = 'That alert needs the data desk (a SoSoValue key), which is off here.';

/** Validates and saves an alert for a member. Used by both chat and /alert. */
export async function createAlert(
  deps: AlertDepsForCreate,
  who: { guildId: string; channelId: string; userId: string },
  req: AlertRequest,
  now: number,
): Promise<Result> {
  const { store, feed, desk } = deps;
  const mine = store.forUser(who.guildId, who.userId);
  if (mine.length >= MAX_ALERTS_PER_MEMBER) {
    return { ok: false, error: `You have ${mine.length} alerts already (the limit is ${MAX_ALERTS_PER_MEMBER}). Cancel one first.` };
  }

  switch (req.kind) {
    case 'price':
    case 'move': {
      const symbol = await feed.resolve(req.asset);
      if (!symbol) return { ok: false, error: `No live USDT market for ${req.asset}. Crypto only, for now.` };
      const asset = symbol.replace(/USDT$/, '');
      const spot = await feed.spot(symbol);
      if (req.kind === 'price') {
        if (!(req.price > 0)) return { ok: false, error: 'Give a price level above zero.' };
        const already = req.direction === 'above' ? spot >= req.price : spot <= req.price;
        if (already) return { ok: false, error: `${asset} is already ${req.direction} ${formatPrice(req.price)} (now ${formatPrice(spot)}).` };
        const alert = store.create({ ...who, kind: 'price', asset, direction: req.direction, target: req.price }, now);
        return { ok: true, alert, summary: `${describeAlert(alert)} (now ${formatPrice(spot)}).` };
      }
      if (!(req.percent >= 1 && req.percent <= 50)) return { ok: false, error: 'Give a move between 1% and 50%.' };
      const alert = store.create({ ...who, kind: 'move', asset, target: req.percent / 100, refPrice: spot }, now);
      return { ok: true, alert, summary: `${describeAlert(alert)}.` };
    }
    case 'day-move': {
      const symbol = await feed.resolve(req.asset);
      if (!symbol) return { ok: false, error: `No live USDT market for ${req.asset}. Crypto only, for now.` };
      const asset = symbol.replace(/USDT$/, '');
      if (!(req.percent >= 1 && req.percent <= 50)) return { ok: false, error: 'Give a move between 1% and 50%.' };
      const existing = mine.find((a) => a.kind === 'day-move' && a.asset === asset);
      if (existing) return { ok: true, alert: existing, summary: `${describeAlert(existing)}: already set.` };
      const alert = store.create({ ...who, kind: 'day-move', asset, target: req.percent / 100, repeat: true }, now);
      return { ok: true, alert, summary: `${describeAlert(alert)}.` };
    }
    case 'etf-flow': {
      if (!desk) return { ok: false, error: NEEDS_DESK };
      const asset = req.asset.trim().toUpperCase().replace(/^\$/, '');
      if (!(ETF_ASSETS as readonly string[]).includes(asset)) {
        return { ok: false, error: `No US spot ETF flow data for ${asset}. Try one of: ${ETF_ASSETS.join(', ')}.` };
      }
      const existing = mine.find((a) => a.kind === 'etf-flow' && a.asset === asset);
      if (existing) return { ok: true, alert: existing, summary: `${describeAlert(existing)}: already set.` };
      const alert = store.create({ ...who, kind: 'etf-flow', asset, repeat: true }, now);
      return { ok: true, alert, summary: `${describeAlert(alert)}. SoSoValue publishes each US session's flows the next day.` };
    }
    case 'macro': {
      if (!desk) return { ok: false, error: NEEDS_DESK };
      const event = req.event.trim();
      if (event.length < 2) return { ok: false, error: 'Name the release, e.g. CPI, PCE, Nonfarm Payrolls, GDP.' };
      const alert = store.create({ ...who, kind: 'macro', asset: event }, now);
      const upcoming = (await desk.macro().catch(() => null))?.upcoming
        .flatMap((d) => d.events.filter((e) => e.toLowerCase().includes(event.toLowerCase())).map((e) => `${e} on ${dayLabel(d.date)}`))
        .slice(0, 2);
      const next = upcoming?.length ? ` Next on the calendar: ${upcoming.join(', ')}.` : " It's not on this week's calendar; you'll hear when it's next released.";
      return { ok: true, alert, summary: `${describeAlert(alert)}.${next}` };
    }
    case 'treasury': {
      if (!desk) return { ok: false, error: NEEDS_DESK };
      const existing = mine.find((a) => a.kind === 'treasury');
      if (existing) return { ok: true, alert: existing, summary: `${describeAlert(existing)}: already set.` };
      const alert = store.create({ ...who, kind: 'treasury', repeat: true }, now);
      return { ok: true, alert, summary: `${describeAlert(alert)}. Company filings are checked every few hours.` };
    }
  }
}

/** "Alert #3: BTC below 80,000" and friends. */
export function describeAlert(a: Alert): string {
  switch (a.kind) {
    case 'price':
      return `Alert #${a.id}: ${a.asset} ${a.direction} ${formatPrice(a.target!)}`;
    case 'move':
      return `Alert #${a.id}: ${a.asset} moving ±${Math.round(a.target! * 100)}% from ${formatPrice(a.refPrice!)}`;
    case 'day-move':
      return `Alert #${a.id}: any day ${a.asset} moves ±${Math.round(a.target! * 100)}% over 24h`;
    case 'etf-flow':
      return `Alert #${a.id}: every new ${a.asset} spot ETF flow day`;
    case 'macro':
      return `Alert #${a.id}: when "${a.asset}" is released`;
    case 'treasury':
      return `Alert #${a.id}: every new corporate BTC purchase`;
  }
}
