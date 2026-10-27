import { FOMC_DECISIONS } from '../analysis/events.js';
import type { Asset, History, MarketHistory } from '../analysis/history.js';
import type { Close } from '../analysis/stats.js';
import type { Desk } from '../desk/desk.js';
import { log } from '../log.js';
import type { ThesisSpec } from '../theses/spec.js';
import type { Thesis } from '../theses/store.js';
import {
  type ChartExtras,
  type PairPoint,
  type RunwayEvent,
  type WindowSeries,
  assetsChart,
  dailyPairs,
  flowsChart,
  lookbackFor,
  progressChart,
  progressLeadFor,
  thesisChart,
  verdictChart,
  windowChart,
  windowLabel,
} from './charts.js';
import type { Point } from './draw.js';
import { toPng } from './render.js';

/** A chart ready to attach: the file name the card points at, and the PNG. */
export interface ChartFile {
  name: string;
  data: Buffer;
}

export const CHART_NAME = 'chart.png';

const DAY = 86_400_000;
/** Macro releases worth marking on a take's runway, with their short names. */
const MAJOR_RELEASES: [RegExp, string][] = [
  [/CPI/i, 'CPI'],
  [/PCE/i, 'PCE'],
  [/GDP/i, 'GDP'],
  [/nonfarm|payroll/i, 'Jobs'],
];

/**
 * Makes the PNGs that ride along with cards and replies. A chart is a nice-to-have: if the data or the
 * drawing fails, the answer goes out without it.
 */
export class Charts {
  constructor(
    private readonly deps: {
      history: MarketHistory;
      desk: Desk | null;
      /** Draws outside the bot's process (pool.ts); without it, drawing happens in-process. */
      renderer?: { render(svg: string): Promise<Buffer> };
      now?: () => number;
    },
  ) {}

  private get now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** The chart for a stress test: its recent past at the take's scale, the runway and what's on it; or ETF flows. */
  async forThesis(spec: ThesisSpec, histories: History[]): Promise<ChartFile | null> {
    if (spec.kind === 'flows') return this.flows(spec.asset);
    const extras = await this.extras(histories, lookbackFor(spec.horizonDays), spec.kind === 'relative');
    extras.events = await this.runwayEvents(this.now, this.now + spec.horizonDays * DAY);
    return this.draw('thesis', () => thesisChart(spec, histories, extras));
  }

  /** One asset with its averages, or two rebased to 100. */
  async forAssets(histories: History[]): Promise<ChartFile | null> {
    if (!histories.length) return null;
    return this.draw('assets', () => assetsChart(histories));
  }

  /**
   * A chart of one asset, or two rebased to 100, over any window (1 day to 5 years); hourly prices under
   * 30 days. Numbered markers and a key for event maps. Returns the numbers it shows too, so the reply can
   * talk about the chart without inventing any.
   */
  async window(
    symbols: string[],
    days: number,
    dots?: { date: string; label: string }[],
    key?: string[],
  ): Promise<{ chart: ChartFile; summary: Record<string, string> } | { error: string }> {
    const span = Math.min(1825, Math.max(1, Math.round(days)));
    const assets: Asset[] = [];
    for (const symbol of symbols.slice(0, 2)) {
      const asset = await this.deps.history.identify(symbol).catch(() => null);
      if (!asset) return { error: `Couldn't find ${symbol}.` };
      assets.push(asset);
    }
    const label = assets.map((a) => a.symbol).join('/');
    let series: WindowSeries | null = null;
    let daily: { closes: Close[] } | undefined;
    if (span < 30) {
      if (assets.length === 2) {
        const pairs = await this.hourlyPairs(assets, span);
        if (pairs) series = { label, points: [], pairs, source: 'hourly prices' };
      } else {
        const hourly = await this.deps.history.hourly(assets[0]!, span).catch(() => null);
        if (hourly) series = { label, points: hourly.points, source: hourly.source };
      }
    }
    if (!series) {
      const histories = await Promise.all(assets.map((a) => this.deps.history.daily(a).catch(() => null)));
      if (!histories.every(Boolean)) return { error: `No price history for ${label}.` };
      const [a, b] = histories as History[];
      // Calendar days, not bars: stocks and futures skip weekends, so 90 bars would be about 4 months.
      const cutoff = Date.parse(`${a!.closes.at(-1)?.date ?? '1970-01-01'}T00:00:00Z`) - span * DAY;
      const shown = a!.closes.filter((c) => Date.parse(`${c.date}T00:00:00Z`) >= cutoff);
      const source = [...new Set(histories.map((h) => h!.source))].join(', ');
      if (b) {
        series = { label, points: [], pairs: dailyPairs(shown, b.closes), source };
      } else {
        daily = { closes: a!.closes };
        series = { label, points: shown.map((c) => ({ t: Date.parse(`${c.date}T00:00:00Z`), v: c.close })), source };
      }
    }
    const pairs = series.pairs;
    const points: Point[] = pairs ? pairs.map((p) => ({ t: p.t, v: p.a / p.b })) : series.points;
    if (points.length < 2) return { error: `Not enough history to chart ${label}.` };
    const marks = dots?.map((d) => ({ t: Date.parse(`${d.date}T00:00:00Z`), label: d.label }));
    const drawn = series;
    const chart = await this.draw('window', () => windowChart(drawn, span, daily, marks, key));
    if (!chart) return { error: "Couldn't draw that chart right now." };
    const fmt = (v: number) => (v >= 1000 ? Math.round(v).toLocaleString('en-US') : v >= 1 ? v.toFixed(2) : v.toPrecision(4));
    const change = (from: number, to: number) => `${to >= from ? '+' : '−'}${Math.abs((to / from - 1) * 100).toFixed(1)}%`;
    const values = points.map((p) => p.v);
    const short = span >= 30 && (points.at(-1)!.t - points[0]!.t) / DAY < span - 3;
    return {
      chart,
      summary: {
        chart: `${label} · ${windowLabel(span)}`,
        ...(short ? { note: `history only starts ${new Date(points[0]!.t).toISOString().slice(0, 10)}` } : {}),
        ...(pairs
          ? {
              drawn_as: 'both rebased to 100 at the start of the window',
              [`${assets[0]!.symbol}_change`]: change(pairs[0]!.a, pairs.at(-1)!.a),
              [`${assets[1]!.symbol}_change`]: change(pairs[0]!.b, pairs.at(-1)!.b),
            }
          : {
              start: fmt(values[0]!),
              now: fmt(values.at(-1)!),
              change: change(values[0]!, values.at(-1)!),
              high: fmt(Math.max(...values)),
              low: fmt(Math.min(...values)),
            }),
        source: series.source,
      },
    };
  }

  /** A logged thesis so far, with what's left on its runway. */
  async progress(t: Thesis, latest: number | null, now: number): Promise<ChartFile | null> {
    if (t.spec.kind === 'flows') return this.flows(t.spec.asset);
    const histories = await this.thesisHistories(t);
    if (!histories) return null;
    // Short takes are drawn from hourly prices, like their stress-test chart.
    const span = (now - (t.startAt ?? now)) / DAY + progressLeadFor(t.spec.horizonDays);
    const extras = await this.extras(histories, Math.ceil(span), t.spec.kind === 'relative');
    if (t.checkAt && t.checkAt > now) extras.events = await this.runwayEvents(now, t.checkAt);
    return this.draw('progress', () => progressChart(t, histories, latest, now, extras));
  }

  /** The check-back: the whole run, the range it had when logged, and where it finished. */
  async verdict(t: Thesis, endValue: number, held: boolean): Promise<ChartFile | null> {
    if (t.spec.kind === 'flows') return this.flows(t.spec.asset);
    const histories = await this.thesisHistories(t);
    if (!histories) return null;
    const span = (this.now - (t.startAt ?? this.now)) / DAY + progressLeadFor(t.spec.horizonDays);
    const extras = await this.extras(histories, Math.ceil(span), t.spec.kind === 'relative');
    return this.draw('verdict', () => verdictChart(t, histories, endValue, held, extras));
  }

  async flows(asset: string): Promise<ChartFile | null> {
    const report = await this.deps.desk?.flows(asset).catch(() => null);
    return report ? this.draw('flows', () => flowsChart(report)) : null;
  }

  /**
   * What's scheduled between two moments: FOMC decisions from the Fed's calendar, and the big macro releases
   * (CPI, PCE, GDP, jobs) the tape knows about. One label per day.
   */
  async runwayEvents(from: number, to: number): Promise<RunwayEvent[]> {
    const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const byDay = new Map<string, string[]>();
    const add = (date: string, name: string) => {
      if (date < iso(from) || date > iso(to)) return;
      const names = byDay.get(date) ?? [];
      if (!names.includes(name)) names.push(name);
      byDay.set(date, names);
    };
    for (const d of FOMC_DECISIONS) add(d, 'FOMC');
    const macro = await this.deps.desk?.macro().catch(() => null);
    for (const day of macro?.upcoming ?? []) {
      for (const event of day.events) {
        const name = MAJOR_RELEASES.find(([re]) => re.test(event))?.[1];
        if (name) add(day.date, name);
      }
    }
    const label = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
    return [...byDay].map(([date, names]) => ({ t: Date.parse(`${date}T12:00:00Z`), label: `${names.join(', ')} ${label(date)}` }));
  }

  /** The histories behind a thesis, each looked up as the kind it was stored as. */
  private async thesisHistories(t: Thesis): Promise<History[] | null> {
    const symbols = t.spec.kind === 'relative' ? [t.spec.asset, t.spec.versus!] : [t.spec.asset];
    const kinds = [t.spec.assetKind, t.spec.versusKind];
    const histories: History[] = [];
    for (const [i, symbol] of symbols.entries()) {
      const asset = await this.deps.history.identify(symbol, kinds[i]).catch(() => null);
      const h = asset && (await this.deps.history.daily(asset).catch(() => null));
      if (!h) return null;
      histories.push(h);
    }
    return histories;
  }

  /** Hourly prices when the window is under a month: one series, or two aligned for comparison. */
  private async extras(histories: History[], days: number, pair: boolean): Promise<ChartExtras> {
    if (days >= 30) return {};
    const assets = histories.map((h) => h.asset);
    if (pair && assets.length >= 2) {
      const hourlyPairs = await this.hourlyPairs(assets, days);
      return hourlyPairs ? { hourlyPairs } : {};
    }
    const hourly = await this.deps.history.hourly(assets[0]!, days).catch(() => null);
    return hourly ? { hourly: hourly.points } : {};
  }

  /** Two assets' hourly prices at the same hours (within half an hour), or null if either has none. */
  private async hourlyPairs(assets: Asset[], days: number): Promise<PairPoint[] | null> {
    const [a, b] = await Promise.all(assets.slice(0, 2).map((x) => this.deps.history.hourly(x, days).catch(() => null)));
    if (!a || !b) return null;
    const pairs = a.points.flatMap((p) => {
      const q = b.points.find((x) => Math.abs(x.t - p.t) < 30 * 60_000);
      return q ? [{ t: p.t, a: p.v, b: q.v }] : [];
    });
    return pairs.length >= 6 ? pairs : null;
  }

  private async draw(kind: string, svg: () => string): Promise<ChartFile | null> {
    try {
      const drawing = svg();
      const data = this.deps.renderer ? await this.deps.renderer.render(drawing) : toPng(drawing);
      return { name: CHART_NAME, data };
    } catch (err) {
      log.warn(`Couldn't draw the ${kind} chart`, err);
      return null;
    }
  }
}
