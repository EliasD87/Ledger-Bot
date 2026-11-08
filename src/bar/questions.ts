import type { History, MarketHistory } from '../analysis/history.js';
import type { Close } from '../analysis/stats.js';
import type { Lang } from '../lang.js';
import type { ThesisSpec } from '../theses/spec.js';

/**
 * The daily bar question: one plain, relatable question about the coins everyone follows, answered With
 * or Against. "Will ETH reach 2,300 within 24 hours?" counts the moment the price gets there. Pure apart
 * from loading history.
 */

export interface BarRule {
  /** reach / drop: touches the level within 24 hours. up / above / beats: the older kinds, judged at 24 hours. */
  kind: 'reach' | 'drop' | 'up' | 'above' | 'beats';
  asset: string;
  versus?: string;
  /** The round number asked about (reach, drop, above). */
  level?: number;
}

const DAY = 86_400_000;
export const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Only the coins people talk about every day; up one day, down the next, a different coin each time. */
export const POOL: BarRule[] = [
  { kind: 'reach', asset: 'BTC' },
  { kind: 'drop', asset: 'ETH' },
  { kind: 'reach', asset: 'SOL' },
  { kind: 'drop', asset: 'BTC' },
  { kind: 'reach', asset: 'ETH' },
  { kind: 'drop', asset: 'SOL' },
];

export function ruleFor(day: string): BarRule {
  return POOL[Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY) % POOL.length]!;
}

/** Whether the question counts the moment the price touches its level. */
export const touches = (rule: BarRule) => rule.kind === 'reach' || rule.kind === 'drop';

/** The question as a take spec, so it measures and draws like one: one day ahead. */
export function specOf(rule: BarRule): ThesisSpec {
  const base = { asset: rule.asset, assetKind: 'crypto' as const, direction: rule.kind === 'drop' ? ('down' as const) : ('up' as const), horizonDays: 1 };
  if (rule.kind === 'reach' || rule.kind === 'drop' || rule.kind === 'above') return { ...base, kind: 'price', target: rule.level! };
  if (rule.kind === 'beats') return { ...base, kind: 'relative', versus: rule.versus!, versusKind: 'crypto' };
  return { ...base, kind: 'move' };
}

const stepOf = (price: number) => (price >= 10_000 ? 1000 : price >= 1000 ? 50 : price >= 200 ? 5 : price >= 50 ? 1 : 0.5);

/** A round number just above the price, so "above" asks for a small move up: 81,000 for 80,750. */
export function roundLevel(price: number): number {
  const step = stepOf(price);
  return Number((Math.ceil(price / step) * step).toFixed(2));
}

/** How far a "reach" or "drop" level sits from the price: about a normal day's swing for each coin. */
const SWING: { [asset: string]: number } = { BTC: 0.025, ETH: 0.035, SOL: 0.045 };

/** The question's round number from the price when it posts: 78,000 for BTC at 76,000 ("reach"). */
export function levelFor(rule: BarRule, price: number): number | undefined {
  if (rule.kind === 'above') return roundLevel(price);
  if (!touches(rule)) return undefined;
  const swing = SWING[rule.asset] ?? 0.03;
  const step = stepOf(price);
  const raw = rule.kind === 'reach' ? price * (1 + swing) : price * (1 - swing);
  return Number(((rule.kind === 'reach' ? Math.ceil(raw / step) : Math.floor(raw / step)) * step).toFixed(2));
}

export const formatLevel = (v: number) => (v >= 1000 ? Math.round(v).toLocaleString('en-US') : Number(v.toFixed(2)).toString());

/** The question in the channel's language. */
export function questionText(rule: BarRule, lang: Lang): string {
  const a = rule.asset;
  const v = rule.versus ?? '';
  const level = rule.level !== undefined ? formatLevel(rule.level) : '';
  const texts: { [L in Lang]: { [K in BarRule['kind']]: string } } = {
    en: {
      reach: `Will ${a} reach ${level} within 24 hours?`,
      drop: `Will ${a} drop to ${level} within 24 hours?`,
      up: `Will ${a} be higher this time tomorrow?`,
      above: `Will ${a} be above ${level} this time tomorrow?`,
      beats: `Will ${a} do better than ${v} over the next 24 hours?`,
    },
    pt: {
      reach: `O ${a} vai chegar a ${level} nas próximas 24 horas?`,
      drop: `O ${a} vai cair até ${level} nas próximas 24 horas?`,
      up: `O ${a} vai estar mais alto amanhã a esta hora?`,
      above: `O ${a} vai estar acima de ${level} amanhã a esta hora?`,
      beats: `O ${a} vai render mais que o ${v} nas próximas 24 horas?`,
    },
    es: {
      reach: `¿Llegará ${a} a ${level} en las próximas 24 horas?`,
      drop: `¿Caerá ${a} hasta ${level} en las próximas 24 horas?`,
      up: `¿Estará ${a} más alto mañana a esta hora?`,
      above: `¿Estará ${a} por encima de ${level} mañana a esta hora?`,
      beats: `¿Le irá mejor a ${a} que a ${v} en las próximas 24 horas?`,
    },
    zh: {
      reach: `未来 24 小时内，${a} 会涨到 ${level} 吗？`,
      drop: `未来 24 小时内，${a} 会跌到 ${level} 吗？`,
      up: `明天这个时候，${a} 会比现在高吗？`,
      above: `明天这个时候，${a} 会在 ${level} 以上吗？`,
      beats: `未来 24 小时，${a} 会跑赢 ${v} 吗？`,
    },
    ja: {
      reach: `24時間以内に ${a} は ${level} に届く？`,
      drop: `24時間以内に ${a} は ${level} まで下がる？`,
      up: `明日の同じ時間、${a} は今より高い？`,
      above: `明日の同じ時間、${a} は ${level} を上回っている？`,
      beats: `次の24時間で、${a} は ${v} より強い？`,
    },
  };
  return texts[lang][rule.kind];
}

/** The question cut down to fit as a chart title: "ETH to 2,300 within 24 hours?". */
export function chartTitle(rule: BarRule, lang: Lang): string {
  const a = rule.asset;
  const v = rule.versus ?? '';
  const level = rule.level !== undefined ? formatLevel(rule.level) : '';
  const titles: { [L in Lang]: { [K in BarRule['kind']]: string } } = {
    en: { reach: `${a} to ${level} within 24 hours?`, drop: `${a} down to ${level} within 24 hours?`, up: `${a} higher this time tomorrow?`, above: `${a} above ${level} tomorrow?`, beats: `${a} vs ${v}, next 24 hours` },
    pt: { reach: `${a} a ${level} em 24 horas?`, drop: `${a} até ${level} em 24 horas?`, up: `${a} mais alto amanhã?`, above: `${a} acima de ${level} amanhã?`, beats: `${a} vs ${v}, próximas 24 horas` },
    es: { reach: `¿${a} a ${level} en 24 horas?`, drop: `¿${a} hasta ${level} en 24 horas?`, up: `¿${a} más alto mañana?`, above: `¿${a} por encima de ${level} mañana?`, beats: `${a} vs ${v}, próximas 24 horas` },
    zh: { reach: `${a} 24 小时内涨到 ${level}？`, drop: `${a} 24 小时内跌到 ${level}？`, up: `${a} 明天会更高吗？`, above: `${a} 明天在 ${level} 以上吗？`, beats: `${a} 对比 ${v} · 未来 24 小时` },
    ja: { reach: `${a} 24時間以内に ${level}？`, drop: `${a} 24時間以内に ${level} まで？`, up: `${a} 明日は今より上？`, above: `${a} 明日 ${level} 超え？`, beats: `${a} 対 ${v} · 次の24時間` },
  };
  return titles[lang][rule.kind];
}

/** Whether a price has touched a "reach" or "drop" level. */
export function reachedLevel(rule: BarRule, price: number): boolean {
  return rule.kind === 'drop' ? price <= rule.level! : price >= rule.level!;
}

/**
 * Whether With was right. Touch questions: did the 24 hours' high (reach) or low (drop) get to the level.
 * The rest: compared at the end, against the level or the start.
 */
export function outcomeOf(rule: BarRule, start: number, end: number): number {
  if (touches(rule)) return reachedLevel(rule, end) ? 1 : 0;
  if (rule.kind === 'above') return end >= rule.level! ? 1 : 0;
  return end > start ? 1 : 0;
}

/** Day-to-day moves over the last year of a series. */
function dayMoves(closes: Close[]): number[] {
  const past = closes.slice(-366);
  const out: number[] = [];
  for (let i = 1; i < past.length; i++) out.push(past[i]!.close / past[i - 1]!.close - 1);
  return out;
}

/**
 * Ledger's own side, from history: how often the coin did what the question asks within a day. For touch
 * questions, from the last month's hourly prices (did any 24-hour stretch get that far); else from a year
 * of daily closes. With if that happened more than half the time, else Against.
 */
export async function ledgerSide(
  history: Pick<MarketHistory, 'identify' | 'daily'> & Partial<Pick<MarketHistory, 'hourly'>>,
  rule: BarRule,
  start: number,
): Promise<{ side: number; share: number } | null> {
  const asset = await history.identify(rule.asset, 'crypto').catch(() => null);
  if (!asset) return null;
  if (touches(rule)) {
    const hourly = history.hourly ? await history.hourly(asset, 30).catch(() => null) : null;
    const v = hourly?.points.map((p) => p.v) ?? [];
    if (v.length < 72) return null;
    const need = rule.level! / start - 1;
    let hits = 0;
    let windows = 0;
    for (let i = 0; i + 24 < v.length; i++) {
      const ahead = v.slice(i + 1, i + 25);
      const move = rule.kind === 'reach' ? Math.max(...ahead) / v[i]! - 1 : Math.min(...ahead) / v[i]! - 1;
      windows++;
      if (rule.kind === 'reach' ? move >= need : move <= need) hits++;
    }
    const share = hits / windows;
    return { side: share > 0.5 ? 1 : 0, share };
  }
  const load = async (symbol: string): Promise<History | null> => {
    const a = await history.identify(symbol, 'crypto').catch(() => null);
    return a ? history.daily(a).catch(() => null) : null;
  };
  const a = await load(rule.asset);
  if (!a) return null;
  let series = a.closes;
  if (rule.kind === 'beats') {
    const b = await load(rule.versus!);
    if (!b) return null;
    const byDate = new Map(b.closes.map((c) => [c.date, c.close]));
    series = a.closes.filter((c) => byDate.has(c.date)).map((c) => ({ date: c.date, close: c.close / byDate.get(c.date)! }));
  }
  const moves = dayMoves(series);
  if (moves.length < 30) return null;
  const need = rule.kind === 'above' ? rule.level! / start - 1 : 0;
  const share = moves.filter((m) => (rule.kind === 'above' ? m >= need : m > 0)).length / moves.length;
  return { side: share > 0.5 ? 1 : 0, share };
}
