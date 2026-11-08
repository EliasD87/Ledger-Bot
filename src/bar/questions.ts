import type { History, MarketHistory } from '../analysis/history.js';
import type { Close } from '../analysis/stats.js';
import type { Lang } from '../lang.js';
import type { ThesisSpec } from '../theses/spec.js';

/**
 * The daily bar question: one plain, relatable question about the coins everyone follows, answered With
 * or Against and settled 24 hours after it posts. Pure apart from loading history.
 */

export interface BarRule {
  kind: 'up' | 'above' | 'beats';
  asset: string;
  versus?: string;
  /** For "above": the round number asked about. */
  level?: number;
}

const DAY = 86_400_000;
export const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Only the coins people talk about every day, in a rotation that changes the coin and the kind daily. */
export const POOL: BarRule[] = [
  { kind: 'up', asset: 'BTC' },
  { kind: 'above', asset: 'ETH' },
  { kind: 'up', asset: 'SOL' },
  { kind: 'beats', asset: 'ETH', versus: 'BTC' },
  { kind: 'above', asset: 'BTC' },
  { kind: 'up', asset: 'ETH' },
  { kind: 'beats', asset: 'SOL', versus: 'ETH' },
  { kind: 'above', asset: 'SOL' },
];

export function ruleFor(day: string): BarRule {
  return POOL[Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY) % POOL.length]!;
}

/** The question as a take spec, so it measures and draws like one: one day ahead. */
export function specOf(rule: BarRule): ThesisSpec {
  const base = { asset: rule.asset, assetKind: 'crypto' as const, direction: 'up' as const, horizonDays: 1 };
  if (rule.kind === 'above') return { ...base, kind: 'price', target: rule.level! };
  if (rule.kind === 'beats') return { ...base, kind: 'relative', versus: rule.versus!, versusKind: 'crypto' };
  return { ...base, kind: 'move' };
}

/** A round number just above the price, so "above" asks for a small move up: 81,000 for 80,750. */
export function roundLevel(price: number): number {
  const step = price >= 10_000 ? 1000 : price >= 1000 ? 50 : price >= 200 ? 5 : price >= 50 ? 1 : 0.5;
  return Number((Math.ceil(price / step) * step).toFixed(2));
}

export const formatLevel = (v: number) => (v >= 1000 ? Math.round(v).toLocaleString('en-US') : Number(v.toFixed(2)).toString());

/** The question in the channel's language. */
export function questionText(rule: BarRule, lang: Lang): string {
  const a = rule.asset;
  const v = rule.versus ?? '';
  const level = rule.level !== undefined ? formatLevel(rule.level) : '';
  const texts: { [L in Lang]: { [K in BarRule['kind']]: string } } = {
    en: {
      up: `Will ${a} be higher this time tomorrow?`,
      above: `Will ${a} be above ${level} this time tomorrow?`,
      beats: `Will ${a} do better than ${v} over the next 24 hours?`,
    },
    pt: {
      up: `O ${a} vai estar mais alto amanhã a esta hora?`,
      above: `O ${a} vai estar acima de ${level} amanhã a esta hora?`,
      beats: `O ${a} vai render mais que o ${v} nas próximas 24 horas?`,
    },
    es: {
      up: `¿Estará ${a} más alto mañana a esta hora?`,
      above: `¿Estará ${a} por encima de ${level} mañana a esta hora?`,
      beats: `¿Le irá mejor a ${a} que a ${v} en las próximas 24 horas?`,
    },
    zh: {
      up: `明天这个时候，${a} 会比现在高吗？`,
      above: `明天这个时候，${a} 会在 ${level} 以上吗？`,
      beats: `未来 24 小时，${a} 会跑赢 ${v} 吗？`,
    },
    ja: {
      up: `明日の同じ時間、${a} は今より高い？`,
      above: `明日の同じ時間、${a} は ${level} を上回っている？`,
      beats: `次の24時間で、${a} は ${v} より強い？`,
    },
  };
  return texts[lang][rule.kind];
}

/** Whether With was right: higher than at the start, at or above the level, or a rising ratio. */
export function outcomeOf(rule: BarRule, start: number, end: number): number {
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
 * Ledger's own side, from history: how often over the last year the coin (or the ratio) did what the question
 * asks within a day. With if that happened on more than half the days, else Against.
 */
export async function ledgerSide(
  history: Pick<MarketHistory, 'identify' | 'daily'>,
  rule: BarRule,
  start: number,
): Promise<{ side: number; share: number } | null> {
  const load = async (symbol: string): Promise<History | null> => {
    const asset = await history.identify(symbol, 'crypto').catch(() => null);
    return asset ? history.daily(asset).catch(() => null) : null;
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

/** The question cut down to fit as a chart title: "BTC above 76,000 tomorrow?". */
export function chartTitle(rule: BarRule, lang: Lang): string {
  const a = rule.asset;
  const v = rule.versus ?? '';
  const level = rule.level !== undefined ? formatLevel(rule.level) : '';
  const titles: { [L in Lang]: { [K in BarRule['kind']]: string } } = {
    en: { up: `${a} higher this time tomorrow?`, above: `${a} above ${level} tomorrow?`, beats: `${a} vs ${v}, next 24 hours` },
    pt: { up: `${a} mais alto amanhã?`, above: `${a} acima de ${level} amanhã?`, beats: `${a} vs ${v}, próximas 24 horas` },
    es: { up: `¿${a} más alto mañana?`, above: `¿${a} por encima de ${level} mañana?`, beats: `${a} vs ${v}, próximas 24 horas` },
    zh: { up: `${a} 明天会更高吗？`, above: `${a} 明天在 ${level} 以上吗？`, beats: `${a} 对比 ${v} · 未来 24 小时` },
    ja: { up: `${a} 明日は今より上？`, above: `${a} 明日 ${level} 超え？`, beats: `${a} 対 ${v} · 次の24時間` },
  };
  return titles[lang][rule.kind];
}
