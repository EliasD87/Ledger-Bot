import type { Lang } from '../lang.js';
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
  /** Whether `asset` / `versus` are crypto or stocks, once looked up (tickers like AI exist as both). */
  assetKind?: 'crypto' | 'stock';
  versusKind?: 'crypto' | 'stock';
  /**
   * An NFT collection's floor instead of a coin or stock price (price and move takes only). `asset` is the
   * collection's name; the target is in its own coin. Key and currency are filled in once it's looked up.
   */
  nft?: { key?: string; currency?: string };
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
  if (s.nft && s.kind !== 'price' && s.kind !== 'move') return 'NFT floor takes are a target ("above 300 SOSO") or a move ("up 20%").';
  if (s.pct !== undefined && !(s.pct >= 0 && s.pct < 10)) return 'That percentage is out of range.';
  return null;
}

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;

/** The claim in plain words, written by code so the record says exactly what will be checked. */
export function claimText(s: ThesisSpec, lang: Lang = 'en'): string {
  if (lang !== 'en') return CLAIMS[lang](s);
  const p = s.pct ? ` ${pct(s.pct)}+` : '';
  if (s.nft) {
    return s.kind === 'price'
      ? `${s.asset} floor ${s.direction === 'up' ? 'above' : 'below'} ${nftAmount(s.target!, s.nft.currency)} within ${days(s.horizonDays)}`
      : `${s.asset} floor ${s.direction === 'up' ? 'up' : 'down'}${p} ${p ? 'within' : 'over'} ${days(s.horizonDays)}`;
  }
  switch (s.kind) {
    case 'price':
      return `${s.asset} ${s.direction === 'up' ? 'above' : 'below'} ${formatPrice(s.target!)} within ${days(s.horizonDays)}`;
    case 'move':
      return `${s.asset} ${s.direction === 'up' ? 'up' : 'down'}${p || ''} ${p ? 'within' : 'over'} ${days(s.horizonDays)}`;
    case 'relative':
      return `${s.asset} ${s.direction === 'up' ? 'beats' : 'trails'} ${s.versus}${s.pct ? ` by${p}` : ''} over ${days(s.horizonDays)}`;
    case 'flows':
      return `${s.asset} spot ETFs net ${s.direction === 'up' ? 'inflows' : 'outflows'} over ${days(s.horizonDays)}`;
  }
}

/** What gets measured, for labels: "SOL price", "SOL/ETH". */
export function measureLabel(s: ThesisSpec, lang: Lang = 'en'): string {
  if (s.kind === 'relative') return `${s.asset}/${s.versus}`;
  const [floor, flows, price] = MEASURES[lang];
  const label = s.nft ? floor : s.kind === 'flows' ? flows : price;
  return label.replace('{}', s.asset);
}

/** NFT floor, ETF net flows and price, in each language ("{}" is the asset). */
const MEASURES: { [L in Lang]: [string, string, string] } = {
  en: ['{} floor', '{} ETF net flows', '{} price'],
  zh: ['{} 地板价', '{} ETF 净流量', '{} 价格'],
  ja: ['{} フロア価格', '{} ETF 純流入', '{} 価格'],
  pt: ['floor de {}', 'fluxo líquido dos ETFs de {}', 'preço de {}'],
  es: ['floor de {}', 'flujo neto de los ETF de {}', 'precio de {}'],
};

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

/**
 * The level that settles a take the moment the price touches it, or null when the take is judged at the end
 * of its window instead. Price targets and % moves count on touch ("BTC drops to 60k within a week" is right
 * if it gets there on Tuesday). A target the price was already past when logged ("above 100k" at 110k) means
 * "still there on the date", so it stays end-of-window; so do "A beats B" and ETF-flow takes, which compare
 * over the whole period.
 */
export function touchLevel(s: ThesisSpec, start: number): number | null {
  const up = s.direction === 'up';
  if (s.kind === 'price') {
    const already = up ? start >= s.target! : start <= s.target!;
    return already ? null : s.target!;
  }
  if (s.kind === 'move' && (s.pct ?? 0) > 0) return start * (up ? 1 + s.pct! : 1 - s.pct!);
  return null;
}

/** Whether a price reached a touch level, in the take's direction. */
export function reached(s: ThesisSpec, level: number, price: number): boolean {
  return s.direction === 'up' ? price >= level : price <= level;
}

/** The change in the measure that the thesis needs from here, as a fraction, or null where that doesn't apply. */
export function neededChange(s: ThesisSpec, now: number): number | null {
  if (s.kind === 'price') return s.target! / now - 1;
  if (s.kind === 'move' || s.kind === 'relative') return (s.direction === 'up' ? 1 : -1) * (s.pct ?? 0);
  return null;
}

/** 「BTC 在 30 天内高于 100,000」 */
function claimTextZh(s: ThesisSpec): string {
  const when = daysZh(s.horizonDays);
  const p = s.pct ? ` ${pct(s.pct)} 以上` : '';
  if (s.nft) {
    return s.kind === 'price'
      ? `${s.asset} 地板价${when}${s.direction === 'up' ? '高于' : '低于'} ${nftAmount(s.target!, s.nft.currency)}`
      : `${s.asset} 地板价${when}${s.direction === 'up' ? '上涨' : '下跌'}${p}`;
  }
  switch (s.kind) {
    case 'price':
      return `${s.asset} ${when}${s.direction === 'up' ? '高于' : '低于'} ${formatPrice(s.target!)}`;
    case 'move':
      return `${s.asset} ${when}${s.direction === 'up' ? '上涨' : '下跌'}${p}`;
    case 'relative':
      return `${s.asset} ${when}${s.direction === 'up' ? '跑赢' : '跑输'} ${s.versus}${p}`;
    case 'flows':
      return `${s.asset} 现货 ETF ${when}净${s.direction === 'up' ? '流入' : '流出'}`;
  }
}

/** 「BTC が 30日以内に 100,000 を上回る」 */
function claimTextJa(s: ThesisSpec): string {
  const when = `${durationJa(s.horizonDays)}以内に`;
  const p = s.pct ? `${pct(s.pct)}以上` : '';
  const up = s.direction === 'up';
  const what = s.nft ? `${s.asset} のフロア価格が` : `${s.asset} が`;
  switch (s.nft ? (s.kind === 'price' ? 'price' : 'move') : s.kind) {
    case 'price':
      return `${what}${when} ${s.nft ? nftAmount(s.target!, s.nft.currency) : formatPrice(s.target!)} を${up ? '上回る' : '下回る'}`;
    case 'move':
      return `${what}${when}${p}${up ? '上昇' : '下落'}`;
    case 'relative':
      return `${s.asset} が${durationJa(s.horizonDays)}で ${s.versus} を${p}${up ? '上回る' : '下回る'}`;
    case 'flows':
    default:
      return `${s.asset} 現物ETF が${durationJa(s.horizonDays)}で純${up ? '流入' : '流出'}`;
  }
}

/** "BTC acima de 100,000 em até 30 dias" */
function claimTextPt(s: ThesisSpec): string {
  const when = durationPt(s.horizonDays);
  const p = s.pct ? ` ${pct(s.pct)}+` : '';
  const up = s.direction === 'up';
  const what = s.nft ? `Floor de ${s.asset}` : s.asset;
  switch (s.nft ? (s.kind === 'price' ? 'price' : 'move') : s.kind) {
    case 'price':
      return `${what} ${up ? 'acima de' : 'abaixo de'} ${s.nft ? nftAmount(s.target!, s.nft.currency) : formatPrice(s.target!)} em até ${when}`;
    case 'move':
      return `${what} ${up ? 'sobe' : 'cai'}${p} ${p ? 'em até' : 'em'} ${when}`;
    case 'relative':
      return `${s.asset} ${up ? 'supera' : 'fica atrás de'} ${s.versus}${s.pct ? ` por${p}` : ''} em ${when}`;
    case 'flows':
    default:
      return `ETFs à vista de ${s.asset} com ${up ? 'entradas' : 'saídas'} líquidas em ${when}`;
  }
}

/** "BTC por encima de 100,000 en 30 días" */
function claimTextEs(s: ThesisSpec): string {
  const when = durationEs(s.horizonDays);
  const p = s.pct ? ` ${pct(s.pct)}+` : '';
  const up = s.direction === 'up';
  const what = s.nft ? `Floor de ${s.asset}` : s.asset;
  switch (s.nft ? (s.kind === 'price' ? 'price' : 'move') : s.kind) {
    case 'price':
      return `${what} ${up ? 'por encima de' : 'por debajo de'} ${s.nft ? nftAmount(s.target!, s.nft.currency) : formatPrice(s.target!)} en ${when}`;
    case 'move':
      return `${what} ${up ? 'sube' : 'baja'}${p} en ${when}`;
    case 'relative':
      return `${s.asset} ${up ? 'supera a' : 'queda por detrás de'} ${s.versus}${s.pct ? ` por${p}` : ''} en ${when}`;
    case 'flows':
    default:
      return `ETF al contado de ${s.asset} con ${up ? 'entradas' : 'salidas'} netas en ${when}`;
  }
}

const CLAIMS: { [L in Exclude<Lang, 'en'>]: (s: ThesisSpec) => string } = { zh: claimTextZh, ja: claimTextJa, pt: claimTextPt, es: claimTextEs };

/** "1週間", "30日" */
export function durationJa(n: number): string {
  if (n % 7 === 0 && n <= 56) return `${n / 7}週間`;
  if (n === 30) return '1か月';
  if (n === 365) return '1年';
  return `${n}日`;
}

/** "uma semana", "30 dias" */
export function durationPt(n: number): string {
  if (n % 7 === 0 && n <= 56) return n === 7 ? 'uma semana' : `${n / 7} semanas`;
  if (n === 30) return 'um mês';
  if (n === 365) return 'um ano';
  return n === 1 ? 'um dia' : `${n} dias`;
}

/** "una semana", "30 días" */
export function durationEs(n: number): string {
  if (n % 7 === 0 && n <= 56) return n === 7 ? 'una semana' : `${n / 7} semanas`;
  if (n === 30) return 'un mes';
  if (n === 365) return 'un año';
  return n === 1 ? 'un día' : `${n} días`;
}

/** An amount in a collection's own coin: "300 SOSO", "2.5 ETH". */
export function nftAmount(n: number, currency?: string): string {
  const digits = n >= 1000 ? 0 : n >= 10 ? 1 : n >= 1 ? 2 : 4;
  return `${Number(n.toFixed(digits)).toLocaleString('en-US', { maximumFractionDigits: digits })}${currency ? ` ${currency}` : ''}`;
}

export function daysZh(n: number): string {
  if (n === 1) return '一天内';
  if (n === 7) return '一周内';
  if (n % 7 === 0 && n <= 56) return `${n / 7} 周内`;
  if (n === 30) return '一个月内';
  if (n === 365) return '一年内';
  return `${n} 天内`;
}

function days(n: number): string {
  if (n % 7 === 0 && n <= 56) return n === 7 ? 'a week' : `${n / 7} weeks`;
  if (n === 30) return 'a month';
  if (n === 365) return 'a year';
  return n === 1 ? 'a day' : `${n} days`;
}
