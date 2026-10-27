import type { AssetKind, History, MarketHistory } from '../analysis/history.js';
import type { Close } from '../analysis/stats.js';

/**
 * The question of the day: one statement about today's close that members vote With or Against, how it
 * settles from closing prices, Ledger's own vote from history, and how votes score. Pure apart from
 * loading history.
 */

/** Ledger votes too, so members can try to beat it. */
export const LEDGER_ID = 'ledger';

export interface DayRule {
  kind: 'up' | 'beats' | 'above';
  asset: string;
  assetKind: AssetKind;
  versus?: string;
  versusKind?: AssetKind;
  level?: number;
  /** The day whose close settles it (YYYY-MM-DD): the UTC daily close for crypto, the US close for stocks. */
  date: string;
  /** The asset's last close before that day, shown on the card. */
  ref: number;
  /** Whether it settles on the US stock close (else the crypto 00:00 UTC close). */
  stocks: boolean;
  text: { en: string; zh: string };
}

type Hist = Pick<MarketHistory, 'identify' | 'daily'>;

const DAY = 86_400_000;
export const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const at = (date: string) => Date.parse(`${date}T00:00:00Z`);

function closeBefore(closes: Close[], date: string): number | null {
  let v: number | null = null;
  for (const c of closes) {
    if (c.date >= date) break;
    v = c.close;
  }
  return v;
}

/** One day's moves over the last year. */
function dayChanges(closes: Close[], before: string): number[] {
  const past = closes.filter((c) => c.date < before).slice(-366);
  const out: number[] = [];
  for (let i = 1; i < past.length; i++) out.push(past[i]!.close / past[i - 1]!.close - 1);
  return out;
}

/** A round number near a price: the level for "at or above" questions. */
export function roundLevel(price: number): number {
  const step = price >= 10_000 ? 1000 : price >= 1000 ? 50 : price >= 200 ? 5 : price >= 50 ? 1 : price >= 10 ? 0.5 : 0.1;
  return Number((Math.round(price / step) * step).toFixed(2));
}

const fmt = (v: number) => (v >= 1000 ? Math.round(v).toLocaleString('en-US') : Number(v.toFixed(2)).toString());

interface PoolItem {
  type: 'up' | 'beats' | 'above';
  asset: string;
  kind: AssetKind;
  versus?: string;
  versusKind?: AssetKind;
  name: { en: string; zh: string };
  vsName?: { en: string; zh: string };
  stocks: boolean;
}

/** Crypto and market questions, alternating; on weekends only the crypto ones. */
export const POOL: PoolItem[] = [
  { type: 'up', asset: 'BTC', kind: 'crypto', name: { en: 'BTC', zh: 'BTC' }, stocks: false },
  { type: 'up', asset: 'SP500', kind: 'stock', name: { en: 'The S&P 500', zh: '标普 500' }, stocks: true },
  { type: 'beats', asset: 'ETH', kind: 'crypto', versus: 'BTC', versusKind: 'crypto', name: { en: 'ETH', zh: 'ETH' }, vsName: { en: 'BTC', zh: 'BTC' }, stocks: false },
  { type: 'beats', asset: 'NVDA', kind: 'stock', versus: 'QQQ', versusKind: 'stock', name: { en: 'NVDA', zh: 'NVDA' }, vsName: { en: 'the Nasdaq (QQQ)', zh: '纳斯达克 (QQQ)' }, stocks: true },
  { type: 'above', asset: 'BTC', kind: 'crypto', name: { en: 'BTC', zh: 'BTC' }, stocks: false },
  { type: 'up', asset: 'GOLD', kind: 'stock', name: { en: 'Gold', zh: '黄金' }, stocks: true },
  { type: 'beats', asset: 'SOL', kind: 'crypto', versus: 'ETH', versusKind: 'crypto', name: { en: 'SOL', zh: 'SOL' }, vsName: { en: 'ETH', zh: 'ETH' }, stocks: false },
  { type: 'above', asset: 'WTI', kind: 'stock', name: { en: 'Oil (WTI)', zh: '原油 (WTI)' }, stocks: true },
  { type: 'up', asset: 'ETH', kind: 'crypto', name: { en: 'ETH', zh: 'ETH' }, stocks: false },
  { type: 'up', asset: 'DXY', kind: 'stock', name: { en: 'The dollar (DXY)', zh: '美元指数 (DXY)' }, stocks: true },
  { type: 'above', asset: 'ETH', kind: 'crypto', name: { en: 'ETH', zh: 'ETH' }, stocks: false },
  { type: 'beats', asset: 'MSTR', kind: 'stock', versus: 'BTC', versusKind: 'crypto', name: { en: 'MSTR', zh: 'MSTR' }, vsName: { en: 'BTC', zh: 'BTC' }, stocks: true },
];

/** The pool's questions for a day, in the order to try them: the day's own pick first. */
export function picksFor(day: string): number[] {
  const n = Math.floor(at(day) / DAY);
  const weekend = [0, 6].includes(new Date(at(day)).getUTCDay());
  const order = POOL.map((_, k) => (n + k) % POOL.length);
  return weekend ? order.filter((i) => !POOL[i]!.stocks) : order;
}

/**
 * The day's question with Ledger's vote. Ledger goes with whichever side has happened more often on a
 * normal day over the last year; when that's close to even, with the last month's direction.
 */
export async function buildQuestion(history: Hist, day: string): Promise<{ rule: DayRule; ledger: number } | null> {
  const load = async (symbol: string, kind: AssetKind): Promise<History | null> => {
    const asset = await history.identify(symbol, kind).catch(() => null);
    return asset ? history.daily(asset).catch(() => null) : null;
  };
  for (const i of picksFor(day).slice(0, 3)) {
    const q = POOL[i]!;
    const a = await load(q.asset, q.kind);
    const b = q.versus ? await load(q.versus, q.versusKind!) : null;
    if (!a || (q.versus && !b)) continue;
    const ref = closeBefore(a.closes, day);
    if (ref === null) continue;
    const base = { asset: q.asset, assetKind: q.kind, date: day, ref, stocks: q.stocks };
    let series = a.closes;
    let rule: DayRule;
    let need = 0;
    if (q.type === 'beats') {
      const byDate = new Map(b!.closes.map((c) => [c.date, c.close]));
      series = a.closes.filter((c) => byDate.has(c.date)).map((c) => ({ date: c.date, close: c.close / byDate.get(c.date)! }));
      rule = {
        ...base,
        kind: 'beats',
        versus: q.versus,
        versusKind: q.versusKind,
        text: { en: `${q.name.en} beats ${q.vsName!.en} today`, zh: `今天 ${q.name.zh} 跑赢 ${q.vsName!.zh}` },
      };
    } else if (q.type === 'up') {
      rule = { ...base, kind: 'up', text: { en: `${q.name.en} closes higher today`, zh: `${q.name.zh} 今天收涨` } };
    } else {
      const level = roundLevel(ref);
      need = level / ref - 1;
      rule = {
        ...base,
        kind: 'above',
        level,
        text: { en: `${q.name.en} closes today at or above ${fmt(level)}`, zh: `${q.name.zh} 今天收盘不低于 ${fmt(level)}` },
      };
    }
    const moves = dayChanges(series, day);
    if (moves.length < 30) continue;
    const share = moves.filter((m) => (q.type === 'above' ? m >= need : m > 0)).length / moves.length;
    const recent = series.filter((c) => c.date < day).slice(-21);
    const trend = recent.length > 1 ? recent.at(-1)!.close / recent[0]!.close - 1 : 0;
    const ledger = share > 0.53 ? 1 : share < 0.47 ? 0 : q.type === 'above' ? (ref >= rule.level! ? 1 : 0) : trend > 0 ? 1 : 0;
    return { rule, ledger };
  }
  return null;
}

/** When a question can settle: a couple of hours after its day's close is in. */
export function settlesAfter(rule: DayRule): number {
  return at(rule.date) + DAY + 2 * 3_600_000;
}

/**
 * The outcome (1: With was right, 0: Against was right), 'void' when the market didn't trade that day (a
 * holiday) or the data never came, or null if it isn't in yet.
 */
export async function settle(history: Hist, rule: DayRule, now: number): Promise<number | 'void' | null> {
  const load = async (symbol: string, kind: AssetKind) => {
    const asset = await history.identify(symbol, kind).catch(() => null);
    return asset ? history.daily(asset).catch(() => null) : null;
  };
  const late = now > at(rule.date) + 4 * DAY;
  const closeOn = async (symbol: string, kind: AssetKind): Promise<{ end: number; start: number } | 'void' | null> => {
    const h = await load(symbol, kind);
    if (!h || (h.closes.at(-1)?.date ?? '') < rule.date) return late ? 'void' : null;
    const end = h.closes.find((c) => c.date === rule.date)?.close;
    const start = closeBefore(h.closes, rule.date);
    return end === undefined || start === null ? 'void' : { end, start };
  };
  const a = await closeOn(rule.asset, rule.assetKind);
  if (a === null || a === 'void') return a;
  if (rule.kind === 'up') return a.end > a.start ? 1 : 0;
  if (rule.kind === 'above') return a.end >= rule.level! ? 1 : 0;
  const b = await closeOn(rule.versus!, rule.versusKind!);
  if (b === null || b === 'void') return b;
  return a.end / a.start > b.end / b.start ? 1 : 0;
}

/**
 * Scores for one question. A right vote earns 50 to 100, more the fewer people got it right (hard calls
 * count more); a wrong one earns nothing. Ledger is scored the same way but doesn't move the shares.
 */
export function scoreVotes(outcome: number, votes: { userId: string; value: number }[]): Map<string, number> {
  const people = votes.filter((v) => v.userId !== LEDGER_ID);
  const right = people.filter((v) => v.value === outcome).length;
  const shareRight = people.length ? right / people.length : 1;
  return new Map(votes.map((v) => [v.userId, v.value === outcome ? Math.round(50 + 50 * (1 - shareRight)) : 0]));
}
