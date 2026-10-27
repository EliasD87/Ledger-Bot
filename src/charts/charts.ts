import type { History } from '../analysis/history.js';
import { type Close, ratio, stdev } from '../analysis/stats.js';
import type { FlowReport } from '../desk/desk.js';
import { formatUsd } from '../format.js';
import { type ThesisSpec, claimText, measureLabel } from '../theses/spec.js';
import type { Thesis } from '../theses/store.js';
import { INK, type Level, type Line, type Mark, type Point, barChart, lineChart } from './draw.js';

const DAY = 86_400_000;
const at = (c: Close): Point => ({ t: Date.parse(`${c.date}T00:00:00Z`), v: c.close });
const shortDate = (ms: number) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** Price-like numbers on an axis: 2,374 · 102.5 · 0.04312. */
function axisFormat(sample: number): (v: number) => string {
  if (sample >= 1000) return (v) => Math.round(v).toLocaleString('en-US');
  if (sample >= 1) return (v) => Number(v.toFixed(2)).toLocaleString('en-US', { maximumFractionDigits: 2 });
  return (v) => v.toPrecision(3);
}

/** The closes within `days` calendar days of the latest (stocks and futures skip weekends, so not a bar count). */
function lastDays(closes: Close[], days: number): Close[] {
  const cutoff = Date.parse(`${closes.at(-1)?.date ?? '1970-01-01'}T00:00:00Z`) - days * DAY;
  return closes.filter((c) => Date.parse(`${c.date}T00:00:00Z`) >= cutoff);
}

/** A rolling average as a line, from the first day it has a full window. */
function rolling(closes: Close[], n: number): Point[] {
  const out: Point[] = [];
  let sum = 0;
  closes.forEach((c, i) => {
    sum += c.close;
    if (i >= n) sum -= closes[i - n]!.close;
    if (i >= n - 1) out.push({ t: at(c).t, v: sum / n });
  });
  return out;
}

/** What a thesis is judged on, as daily values: the price, or the ratio of the two assets. */
export function measuredSeries(spec: ThesisSpec, histories: History[]): Close[] {
  if (spec.kind === 'relative' && histories.length >= 2) return ratio(histories[0]!.closes, histories[1]!.closes);
  return histories[0]?.closes ?? [];
}

/** History shown before a take: about three times its horizon, at least a week, at most two years. */
export function lookbackFor(horizonDays: number): number {
  return Math.min(730, Math.max(7, Math.round(horizonDays * 3)));
}

/**
 * The usual spread of outcomes `days` ahead (plus or minus one standard deviation, about two times in three),
 * from the last 90 daily moves. Assets that skip weekends count trading days.
 */
export function typicalRange(daily: Close[], from: number, days: number, weekdaysOnly: boolean): { lo: number; hi: number } | null {
  const recent = daily.slice(-91);
  const moves = recent.slice(1).map((c, i) => Math.log(c.close / recent[i]!.close));
  if (moves.length < 20 || days <= 0) return null;
  const spread = stdev(moves) * Math.sqrt(Math.max(1, weekdaysOnly ? (days * 252) / 365 : days));
  return { lo: from * Math.exp(-spread), hi: from * Math.exp(spread) };
}

/**
 * A take as a picture: the recent past at a scale that fits the take (about three times its length,
 * hourly for short ones), the runway to the check-back drawn to scale, the line it has to cross, and the
 * typical range by then.
 */
export function thesisChart(spec: ThesisSpec, histories: History[], opts: { hourly?: Point[] } = {}): string {
  const daily = measuredSeries(spec, histories);
  const lookback = lookbackFor(spec.horizonDays);
  const points = opts.hourly && opts.hourly.length >= 6 ? opts.hourly : lastDays(daily, lookback).map(at);
  const last = points.at(-1) ?? { t: Date.now(), v: 0 };
  const check = last.t + spec.horizonDays * DAY;
  const format = axisFormat(last.v);
  const label = spec.kind === 'relative' ? 'ratio' : 'price';
  const range = typicalRange(daily, last.v, spec.horizonDays, histories.some((h) => h.asset.kind === 'stock'));
  return lineChart({
    title: claimText(spec),
    subtitle: `${measureLabel(spec)} · ${windowLabel(lookback)}, then the runway to ${shortDate(check)} · now ${format(last.v)}`,
    lines:
      !opts.hourly && lookback >= 150
        ? withAverages(daily, points.length, label)
        : [{ points, color: INK.main, width: 2.2, fill: true }],
    levels: needLevel(spec, last.v, format),
    marks: [{ t: check, label: `check-back ${shortDate(check)}` }],
    ...(range ? { cone: { t0: last.t, v0: last.v, t1: check, ...range, label: `typical range by ${shortDate(check)}` } } : {}),
    xEnd: check,
    format,
    note: [...new Set(histories.map((h) => h.source))].join(', '),
  });
}

export interface WindowSeries {
  label: string;
  /** Oldest first. */
  points: Point[];
  source: string;
}

/**
 * Any window, on request ("the 7-day", "last 3 months"): the price, or the ratio of two assets. Long
 * windows also show the 50- and 200-day averages when there's history for them.
 */
export function windowChart(series: WindowSeries, days: number, daily?: { closes: Close[] }, dots?: { t: number; label: string }[]): string {
  const last = series.points.at(-1)?.v ?? 0;
  const first = series.points[0]?.v ?? last;
  const format = axisFormat(last);
  const change = first ? last / first - 1 : 0;
  // A shorter history than asked for (a new listing) is labelled by its start, not the window.
  const t0 = series.points[0]?.t ?? 0;
  const spanDays = ((series.points.at(-1)?.t ?? t0) - t0) / DAY;
  const window = spanDays < days - 3 && days >= 30 ? `since ${shortDate(t0)}` : windowLabel(days);
  const lines: Line[] =
    daily && days >= 90
      ? withAverages(daily.closes, series.points.length, series.label.includes('/') ? 'ratio' : 'price')
      : [{ points: series.points, color: INK.main, width: 2.2, fill: true }];
  return lineChart({
    title: series.label.includes('/') ? series.label.replace('/', ' vs ') : series.label,
    subtitle: `${series.label.includes('/') ? `${series.label} ratio` : 'price'} · ${window} · now ${format(last)} (${change >= 0 ? '+' : '−'}${Math.abs(change * 100).toFixed(1)}%)`,
    lines,
    format,
    note: series.source,
    ...(dots?.length ? { dots } : {}),
  });
}

export function windowLabel(days: number): string {
  if (days <= 1) return 'last 24 hours';
  if (days === 7) return 'last 7 days';
  if (days % 365 === 0) return days === 365 ? 'last year' : `last ${days / 365} years`;
  if (days >= 28 && days <= 31) return 'last month';
  if (days % 30 === 0) return `last ${days / 30} months`;
  return `last ${days} days`;
}

/** One asset with its averages, or two as a ratio: for analysis replies. */
export function assetsChart(histories: History[]): string {
  if (histories.length >= 2) {
    const [a, b] = histories as [History, History];
    const all = ratio(a.closes, b.closes);
    const closes = lastDays(all, 365);
    const format = axisFormat(closes.at(-1)?.close ?? 0);
    return lineChart({
      title: `${a.asset.symbol} vs ${b.asset.symbol}`,
      subtitle: `${a.asset.symbol}/${b.asset.symbol} ratio · last year · rising means ${a.asset.symbol} is ahead`,
      lines: withAverages(all, closes.length, 'ratio'),
      format,
      note: [...new Set([a.source, b.source])].join(', '),
    });
  }
  const h = histories[0]!;
  const closes = lastDays(h.closes, 365);
  const format = axisFormat(closes.at(-1)?.close ?? 0);
  return lineChart({
    title: h.asset.symbol,
    subtitle: `last year · now ${format(closes.at(-1)?.close ?? 0)}`,
    lines: withAverages(h.closes, closes.length),
    format,
    note: h.source,
  });
}

/** How far before the logging date a progress chart starts: about twice the horizon, a week to a year. */
export function progressLeadFor(horizonDays: number): number {
  return Math.min(365, Math.max(7, Math.round(horizonDays * 2)));
}

/**
 * A logged thesis so far: the run-up, the day it was logged, where it stands, the line it has to cross,
 * and the runway left to the check-back with the typical range by then. `latest` is today's live value.
 */
export function progressChart(t: Thesis, histories: History[], latest: number | null, now: number, opts: { hourly?: Point[] } = {}): string {
  const start = t.startAt ?? now;
  const daily = measuredSeries(t.spec, histories);
  const lead = progressLeadFor(t.spec.horizonDays);
  const points =
    opts.hourly && opts.hourly.length >= 6 ? [...opts.hourly] : daily.filter((c) => at(c).t >= start - lead * DAY).map(at);
  if (latest !== null && points.length) points[points.length - 1] = { t: Math.max(points.at(-1)!.t, Math.min(now, t.checkAt ?? now)), v: latest };
  const last = points.at(-1) ?? { t: now, v: t.startValue ?? 0 };
  const format = axisFormat(last.v);
  const end = t.checkAt ?? now;
  const marks: Mark[] = [{ t: start, label: 'logged' }];
  if (end > last.t) marks.push({ t: end, label: `check-back ${shortDate(end)}` });
  const levels = [
    ...(t.startValue !== null ? [{ v: t.startValue, label: `logged at ${format(t.startValue)}`, color: INK.sub }] : []),
    ...needLevel(t.spec, t.startValue ?? last.v, format),
  ];
  const left = (end - last.t) / DAY;
  const range = left >= 1 ? typicalRange(daily, last.v, left, histories.some((h) => h.asset.kind === 'stock')) : null;
  return lineChart({
    title: `#${t.id} ${t.claim}`,
    subtitle: `${measureLabel(t.spec)} · now ${format(last.v)} · checks back ${shortDate(end)}`,
    lines: [{ points, color: INK.main, width: 2.2, fill: true }],
    levels,
    marks,
    ...(range ? { cone: { t0: last.t, v0: last.v, t1: end, ...range, label: `typical range by ${shortDate(end)}` } } : {}),
    format,
    xEnd: Math.max(end, last.t),
    note: [...new Set(histories.map((h) => h.source))].join(', '),
  });
}

/** Daily ETF flows: the last 30 sessions as bars around zero. */
export function flowsChart(r: FlowReport): string {
  const days = [...r.days].filter((d) => d.totalNetInflow !== null).slice(0, 30).reverse();
  const inflow = days.filter((d) => d.totalNetInflow! > 0).length;
  const total = days.reduce((s, d) => s + d.totalNetInflow!, 0);
  return barChart({
    title: `${r.asset} spot ETF flows`,
    subtitle: `last ${days.length} sessions · ${inflow} in, ${days.length - inflow} out · ${formatUsd(total, true)} net`,
    bars: days.map((d) => ({ t: Date.parse(`${d.date}T00:00:00Z`), v: d.totalNetInflow! })),
    format: (v) => (v === 0 ? '0' : formatUsd(v, true)),
    note: 'SoSoValue',
  });
}

function withAverages(all: Close[], shown: number, label = 'price'): Line[] {
  const from = at(all[Math.max(0, all.length - shown)]!).t;
  const keep = (p: Point[]) => p.filter((x) => x.t >= from);
  const lines: Line[] = [{ points: all.slice(-shown).map(at), color: INK.main, width: 2.2, fill: true, label }];
  const a50 = keep(rolling(all, 50));
  const a200 = keep(rolling(all, 200));
  if (a50.length > 10) lines.push({ points: a50, color: INK.avg50, dash: true, label: '50-day' });
  if (a200.length > 10) lines.push({ points: a200, color: INK.avg200, dash: true, label: '200-day' });
  return lines;
}

/** The line a take has to cross: the target, or start ± the minimum move. */
function needLevel(spec: ThesisSpec, start: number, format: (v: number) => string): Level[] {
  if (spec.kind === 'price' && spec.target) return [{ v: spec.target, label: `target ${format(spec.target)}`, color: INK.target }];
  if ((spec.kind === 'move' || spec.kind === 'relative') && spec.pct) {
    const v = start * (1 + (spec.direction === 'up' ? spec.pct : -spec.pct));
    return [{ v, label: `needs ${spec.direction === 'up' ? '+' : '−'}${Math.round(spec.pct * 1000) / 10}% · ${format(v)}`, color: INK.target }];
  }
  return [];
}
