import type { History } from '../analysis/history.js';
import { type Close, ratio, stdev } from '../analysis/stats.js';
import type { FlowReport } from '../desk/desk.js';
import { formatUsd } from '../format.js';
import { type ThesisSpec, claimText, measureLabel } from '../theses/spec.js';
import type { Thesis } from '../theses/store.js';
import { INK, type Level, type Line, type LineChart, type Mark, type Point, barChart, lineChart } from './draw.js';

const DAY = 86_400_000;
const at = (c: Close): Point => ({ t: Date.parse(`${c.date}T00:00:00Z`), v: c.close });
/** "+3.1%": one decimal is plenty on a chart. */
const signedPct = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}%`;
const shortDate = (ms: number) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** Two assets' prices at the same moments, for comparison charts. */
export interface PairPoint {
  t: number;
  a: number;
  b: number;
}

/** A scheduled event to mark on the time axis. */
export interface RunwayEvent {
  t: number;
  label: string;
}

/** What a chart can use beyond daily history: hourly prices for short windows, and events ahead. */
export interface ChartExtras {
  hourly?: Point[];
  hourlyPairs?: PairPoint[];
  events?: RunwayEvent[];
}

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

/** Two daily histories on the days both have a close. */
export function dailyPairs(a: Close[], b: Close[]): PairPoint[] {
  const byDate = new Map(b.map((c) => [c.date, c.close]));
  return a.flatMap((c) => (byDate.has(c.date) ? [{ t: at(c).t, a: c.close, b: byDate.get(c.date)! }] : []));
}

/**
 * Two assets on one scale: each rebased to 100 at `baseT` (or the first point), with value tags that say
 * how far each has moved. Much easier to read than a ratio: you see who's ahead and by how much.
 */
function compareLines(pairs: PairPoint[], symA: string, symB: string, baseT?: number): { lines: Line[]; base: PairPoint; a: number; b: number } {
  const base = pairs.find((p) => baseT === undefined || p.t >= baseT) ?? pairs[0]!;
  const a = pairs.map((p) => ({ t: p.t, v: (p.a / base.a) * 100 }));
  const b = pairs.map((p) => ({ t: p.t, v: (p.b / base.b) * 100 }));
  const changeA = a.at(-1)!.v / 100 - 1;
  const changeB = b.at(-1)!.v / 100 - 1;
  return {
    base,
    a: changeA,
    b: changeB,
    lines: [
      { points: a, color: INK.main, width: 2.4, fill: false, tag: `${symA} ${signedPct(changeA)}` },
      { points: b, color: INK.second, width: 2, tag: `${symB} ${signedPct(changeB)}` },
    ],
  };
}

const indexFormat = (v: number) => v.toFixed(0);
const baseLevel = (t: number): Level => ({ v: 100, label: `100 = ${shortDate(t)}`, color: INK.faint });

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

const weekdaysOnly = (histories: History[]) => histories.some((h) => h.asset.kind === 'stock');
const sourcesOf = (histories: History[]) => [...new Set(histories.map((h) => h.source))].join(', ');

/**
 * A take as a picture: the recent past at a scale that fits the take (about three times its length,
 * hourly for short ones), the runway to the check-back drawn to scale with what's scheduled on it, the
 * line it has to cross, and the typical range by then. Two-asset takes show both, rebased to 100.
 */
export function thesisChart(spec: ThesisSpec, histories: History[], extras: ChartExtras = {}): string {
  const lookback = lookbackFor(spec.horizonDays);
  if (spec.kind === 'relative' && histories.length >= 2) {
    const [a, b] = histories as [History, History];
    const pairs = extras.hourlyPairs?.length ? extras.hourlyPairs : dailyPairs(lastDays(a.closes, lookback), b.closes);
    if (pairs.length < 2) return lineChart({ title: claimText(spec), lines: [], format: indexFormat });
    const c = compareLines(pairs, a.asset.symbol, b.asset.symbol);
    const check = pairs.at(-1)!.t + spec.horizonDays * DAY;
    return lineChart({
      title: claimText(spec),
      subtitle: `both = 100 on ${shortDate(c.base.t)} · the gap is ${signedPct(c.a - c.b).replace('%', ' pts')} · runway to ${shortDate(check)}`,
      lines: c.lines,
      levels: [baseLevel(c.base.t)],
      marks: [{ t: check, label: `check-back ${shortDate(check)}` }],
      events: extras.events,
      xEnd: check,
      format: indexFormat,
      note: sourcesOf(histories),
    });
  }
  const daily = measuredSeries(spec, histories);
  const points = extras.hourly && extras.hourly.length >= 6 ? extras.hourly : lastDays(daily, lookback).map(at);
  const last = points.at(-1) ?? { t: Date.now(), v: 0 };
  const check = last.t + spec.horizonDays * DAY;
  const format = axisFormat(last.v);
  const range = typicalRange(daily, last.v, spec.horizonDays, weekdaysOnly(histories));
  return lineChart({
    title: claimText(spec),
    subtitle: `${measureLabel(spec)} · ${windowLabel(lookback)}, then the runway to ${shortDate(check)} · now ${format(last.v)}`,
    lines: !extras.hourly && lookback >= 150 ? withAverages(daily, points.length) : [{ points, color: INK.main, width: 2.4, fill: true }],
    levels: needLevel(spec, last.v, format),
    marks: [{ t: check, label: `check-back ${shortDate(check)}` }],
    ...(range ? { cone: { t0: last.t, v0: last.v, t1: check, ...range, label: `typical range by ${shortDate(check)}` } } : {}),
    events: extras.events,
    xEnd: check,
    format,
    note: sourcesOf(histories),
  });
}

export interface WindowSeries {
  label: string;
  /** Oldest first. */
  points: Point[];
  source: string;
  /** Two assets: their prices at the same moments, drawn rebased instead of `points`. */
  pairs?: PairPoint[];
}

/**
 * Any window, on request ("the 7-day", "last 3 months"): the price, or two assets rebased to 100. Long
 * windows also show the 50- and 200-day averages. An event map adds numbered markers and a key.
 */
export function windowChart(
  series: WindowSeries,
  days: number,
  daily?: { closes: Close[] },
  dots?: { t: number; label: string }[],
  key?: string[],
): string {
  const t0 = series.points[0]?.t ?? series.pairs?.[0]?.t ?? 0;
  const tEnd = series.points.at(-1)?.t ?? series.pairs?.at(-1)?.t ?? t0;
  // A shorter history than asked for (a new listing) is labelled by its start, not the window.
  const window = (tEnd - t0) / DAY < days - 3 && days >= 30 ? `since ${shortDate(t0)}` : windowLabel(days);
  const extra: Partial<LineChart> = { ...(dots?.length ? { dots } : {}), ...(key?.length ? { key } : {}) };
  if (series.pairs && series.pairs.length >= 2) {
    const [symA, symB] = series.label.split('/') as [string, string];
    const c = compareLines(series.pairs, symA, symB);
    return lineChart({
      title: `${symA} vs ${symB}`,
      subtitle: `both = 100 on ${shortDate(c.base.t)} · ${window} · the gap is ${signedPct(c.a - c.b).replace('%', ' pts')}`,
      lines: c.lines,
      levels: [baseLevel(c.base.t)],
      format: indexFormat,
      note: series.source,
      ...extra,
    });
  }
  const last = series.points.at(-1)?.v ?? 0;
  const first = series.points[0]?.v ?? last;
  const format = axisFormat(last);
  const lines: Line[] =
    daily && days >= 90 ? withAverages(daily.closes, series.points.length) : [{ points: series.points, color: INK.main, width: 2.4, fill: true }];
  return lineChart({
    title: series.label,
    subtitle: `${window} · now ${format(last)} (${signedPct(first ? last / first - 1 : 0)})`,
    lines,
    format,
    note: series.source,
    ...extra,
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

/** One asset with its averages, or two rebased to 100: for analysis replies. */
export function assetsChart(histories: History[]): string {
  if (histories.length >= 2) {
    const [a, b] = histories as [History, History];
    const pairs = dailyPairs(lastDays(a.closes, 365), b.closes);
    return windowChart({ label: `${a.asset.symbol}/${b.asset.symbol}`, points: [], pairs, source: sourcesOf(histories) }, 365);
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
 * the runway left to the check-back with what's scheduled on it, and the typical range by then.
 * `latest` is today's live value. Two-asset takes show both, rebased to 100 at the logging date.
 */
export function progressChart(t: Thesis, histories: History[], latest: number | null, now: number, extras: ChartExtras = {}): string {
  const start = t.startAt ?? now;
  const end = t.checkAt ?? now;
  const lead = progressLeadFor(t.spec.horizonDays);
  const marks: Mark[] = [{ t: start, label: 'logged' }];
  if (t.spec.kind === 'relative' && histories.length >= 2) {
    const [a, b] = histories as [History, History];
    const pairs = (extras.hourlyPairs?.length ? extras.hourlyPairs : dailyPairs(a.closes, b.closes)).filter((p) => p.t >= start - lead * DAY);
    if (pairs.length < 2) return lineChart({ title: `#${t.id} ${t.claim}`, lines: [], format: indexFormat });
    const c = compareLines(pairs, a.asset.symbol, b.asset.symbol, start);
    if (end > pairs.at(-1)!.t) marks.push({ t: end, label: `check-back ${shortDate(end)}` });
    return lineChart({
      title: `#${t.id} ${t.claim}`,
      subtitle: `since logged: ${a.asset.symbol} ${signedPct(c.a)}, ${b.asset.symbol} ${signedPct(c.b)} · checks back ${shortDate(end)}`,
      lines: c.lines,
      levels: [baseLevel(c.base.t)],
      marks,
      events: extras.events,
      xEnd: Math.max(end, pairs.at(-1)!.t),
      format: indexFormat,
      note: sourcesOf(histories),
    });
  }
  const daily = measuredSeries(t.spec, histories);
  const points = extras.hourly && extras.hourly.length >= 6 ? [...extras.hourly] : daily.filter((c) => at(c).t >= start - lead * DAY).map(at);
  if (latest !== null && points.length) points[points.length - 1] = { t: Math.max(points.at(-1)!.t, Math.min(now, end)), v: latest };
  const last = points.at(-1) ?? { t: now, v: t.startValue ?? 0 };
  const format = axisFormat(last.v);
  if (end > last.t) marks.push({ t: end, label: `check-back ${shortDate(end)}` });
  const left = (end - last.t) / DAY;
  const range = left >= 1 ? typicalRange(daily, last.v, left, weekdaysOnly(histories)) : null;
  return lineChart({
    title: `#${t.id} ${t.claim}`,
    subtitle: `${measureLabel(t.spec)} · now ${format(last.v)} · checks back ${shortDate(end)}`,
    lines: [{ points, color: INK.main, width: 2.4, fill: true }],
    levels: [
      ...(t.startValue !== null ? [{ v: t.startValue, label: `logged at ${format(t.startValue)}`, color: INK.sub }] : []),
      ...needLevel(t.spec, t.startValue ?? last.v, format),
    ],
    marks,
    ...(range ? { cone: { t0: last.t, v0: last.v, t1: end, ...range, label: `typical range by ${shortDate(end)}` } } : {}),
    events: extras.events,
    format,
    xEnd: Math.max(end, last.t),
    note: sourcesOf(histories),
  });
}

/**
 * The check-back: the whole run from before it was logged to the check, the typical range it had when
 * it was logged, and where it finished, marked ✓ or ✗. Whether it landed inside that range is the story.
 */
export function verdictChart(t: Thesis, histories: History[], endValue: number, held: boolean, extras: ChartExtras = {}): string {
  const start = t.startAt ?? Date.now();
  const end = t.checkAt ?? Date.now();
  const lead = progressLeadFor(t.spec.horizonDays);
  const title = `#${t.id} ${t.claim}`;
  // The verdict leads the subtitle: a long claim can be shortened to fit, the verdict never is.
  const verdict = held ? 'aged well' : 'aged badly';
  const marks: Mark[] = [{ t: start, label: 'logged' }];
  if (t.spec.kind === 'relative' && histories.length >= 2) {
    const [a, b] = histories as [History, History];
    const pairs = (extras.hourlyPairs?.length ? extras.hourlyPairs : dailyPairs(a.closes, b.closes)).filter(
      (p) => p.t >= start - lead * DAY && p.t <= end + DAY,
    );
    if (pairs.length < 2) return lineChart({ title, lines: [], format: indexFormat });
    const c = compareLines(pairs, a.asset.symbol, b.asset.symbol, start);
    const last = c.lines[0]!.points.at(-1)!;
    return lineChart({
      title,
      subtitle: `${verdict} · ${a.asset.symbol} ${signedPct(c.a)}, ${b.asset.symbol} ${signedPct(c.b)} from logging to check-back`,
      lines: c.lines,
      levels: [baseLevel(c.base.t)],
      marks,
      finish: { t: last.t, v: last.v, ok: held },
      format: indexFormat,
      note: sourcesOf(histories),
    });
  }
  const daily = measuredSeries(t.spec, histories);
  const points = (extras.hourly && extras.hourly.length >= 6 ? [...extras.hourly] : daily.map(at)).filter((p) => p.t >= start - lead * DAY && p.t <= end);
  points.push({ t: end, v: endValue });
  const format = axisFormat(endValue);
  // The range as it stood when the take was logged: from history up to that day only.
  const before = daily.filter((c) => at(c).t <= start);
  const startValue = t.startValue ?? before.at(-1)?.close ?? endValue;
  const range = typicalRange(before, startValue, t.spec.horizonDays, weekdaysOnly(histories));
  const inside = range ? endValue >= range.lo && endValue <= range.hi : null;
  return lineChart({
    title,
    subtitle: `${verdict} · finished at ${format(endValue)}${inside === null ? '' : `, ${inside ? 'inside' : 'outside'} its typical range`}`,
    lines: [{ points, color: INK.main, width: 2.4, fill: true }],
    levels: [
      ...(t.startValue !== null ? [{ v: t.startValue, label: `logged at ${format(t.startValue)}`, color: INK.sub }] : []),
      ...needLevel(t.spec, startValue, format),
    ],
    marks,
    ...(range ? { cone: { t0: start, v0: startValue, t1: end, ...range, label: 'typical range when logged' } } : {}),
    finish: { t: end, v: endValue, ok: held },
    format,
    xEnd: end,
    note: sourcesOf(histories),
  });
}

/** A member's recent form: one bar per checked take, how far past (up) or short of (down) its line it finished. */
export function formChart(name: string, form: { at: number; ok: boolean; margin: number }[]): string {
  const right = form.filter((f) => f.ok).length;
  return barChart({
    title: `${name}'s last ${form.length} takes`,
    subtitle: `${right} aged well, ${form.length - right} aged badly · how far past or short of the line`,
    bars: form.map((f) => ({ t: f.at, v: f.margin * 100 })),
    format: (v) => (v === 0 ? '0' : `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}%`),
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

function withAverages(all: Close[], shown: number): Line[] {
  const from = at(all[Math.max(0, all.length - shown)]!).t;
  const keep = (p: Point[]) => p.filter((x) => x.t >= from);
  const lines: Line[] = [{ points: all.slice(-shown).map(at), color: INK.main, width: 2.4, fill: true }];
  const a50 = keep(rolling(all, 50));
  const a200 = keep(rolling(all, 200));
  if (a50.length > 10) lines.push({ points: a50, color: INK.avg50, dash: true, label: '50-day' });
  if (a200.length > 10) lines.push({ points: a200, color: INK.avg200, dash: true, label: '200-day' });
  return lines;
}

/** The line a take has to cross: the target, or start ± the minimum move. */
function needLevel(spec: ThesisSpec, start: number, format: (v: number) => string): Level[] {
  if (spec.kind === 'price' && spec.target) return [{ v: spec.target, label: `target ${format(spec.target)}`, color: INK.target }];
  if (spec.kind === 'move' && spec.pct) {
    const v = start * (1 + (spec.direction === 'up' ? spec.pct : -spec.pct));
    return [{ v, label: `needs ${spec.direction === 'up' ? '+' : '−'}${Math.round(spec.pct * 1000) / 10}% · ${format(v)}`, color: INK.target }];
  }
  return [];
}
