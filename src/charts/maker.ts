import type { History, MarketHistory } from '../analysis/history.js';
import type { Desk } from '../desk/desk.js';
import { log } from '../log.js';
import type { ThesisSpec } from '../theses/spec.js';
import type { Thesis } from '../theses/store.js';
import { type Close, ratio } from '../analysis/stats.js';
import { assetsChart, flowsChart, progressChart, thesisChart, type WindowSeries, windowChart, windowLabel } from './charts.js';
import { toPng } from './render.js';

/** A chart ready to attach: the file name the card points at, and the PNG. */
export interface ChartFile {
  name: string;
  data: Buffer;
}

export const CHART_NAME = 'chart.png';

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
    },
  ) {}

  /** The chart for a stress test: the measured year, or daily ETF flows for a flows take. */
  async forThesis(spec: ThesisSpec, histories: History[]): Promise<ChartFile | null> {
    if (spec.kind === 'flows') return this.flows(spec.asset);
    return this.draw('thesis', () => thesisChart(spec, histories));
  }

  /** One asset with its averages, or two as a ratio. */
  async forAssets(histories: History[]): Promise<ChartFile | null> {
    if (!histories.length) return null;
    return this.draw('assets', () => assetsChart(histories));
  }

  /**
   * A chart of one asset, or two as a ratio, over any window (1 day to 5 years); hourly prices under 30
   * days. Returns the numbers it shows too, so the reply can talk about the chart without inventing any.
   */
  async window(
    symbols: string[],
    days: number,
    dots?: { date: string; label: string }[],
  ): Promise<{ chart: ChartFile; summary: Record<string, string> } | { error: string }> {
    const span = Math.min(1825, Math.max(1, Math.round(days)));
    const assets = [];
    for (const symbol of symbols.slice(0, 2)) {
      const asset = await this.deps.history.identify(symbol).catch(() => null);
      if (!asset) return { error: `Couldn't find ${symbol}.` };
      assets.push(asset);
    }
    const label = assets.map((a) => a.symbol).join('/');
    let series: WindowSeries | null = null;
    let daily: { closes: Close[] } | undefined;
    if (span < 30) {
      const hourly = await Promise.all(assets.map((a) => this.deps.history.hourly(a, span).catch(() => null)));
      if (hourly.every(Boolean)) {
        const [a, b] = hourly as NonNullable<(typeof hourly)[number]>[];
        const points = b
          ? a!.points.flatMap((p) => {
              const q = b.points.find((x) => Math.abs(x.t - p.t) < 30 * 60_000);
              return q ? [{ t: p.t, v: p.v / q.v }] : [];
            })
          : a!.points;
        series = { label, points, source: [...new Set(hourly.map((h) => h!.source))].join(', ') };
      }
    }
    if (!series) {
      const histories = await Promise.all(assets.map((a) => this.deps.history.daily(a).catch(() => null)));
      if (!histories.every(Boolean)) return { error: `No price history for ${label}.` };
      const closes = histories.length === 2 ? ratio(histories[0]!.closes, histories[1]!.closes) : histories[0]!.closes;
      // Calendar days, not bars: stocks and futures skip weekends, so 90 bars would be about 4 months.
      const cutoff = Date.parse(`${closes.at(-1)?.date ?? '1970-01-01'}T00:00:00Z`) - span * 86_400_000;
      const shown = closes.filter((c) => Date.parse(`${c.date}T00:00:00Z`) >= cutoff);
      daily = { closes };
      series = {
        label,
        points: shown.map((c) => ({ t: Date.parse(`${c.date}T00:00:00Z`), v: c.close })),
        source: [...new Set(histories.map((h) => h!.source))].join(', '),
      };
    }
    if (series.points.length < 2) return { error: `Not enough history to chart ${label}.` };
    const marks = dots?.map((d) => ({ t: Date.parse(`${d.date}T00:00:00Z`), label: d.label }));
    const chart = await this.draw('window', () => windowChart(series, span, daily, marks));
    if (!chart) return { error: "Couldn't draw that chart right now." };
    const values = series.points.map((p) => p.v);
    const first = values[0]!;
    const last = values.at(-1)!;
    const fmt = (v: number) => (v >= 1000 ? Math.round(v).toLocaleString('en-US') : v >= 1 ? v.toFixed(2) : v.toPrecision(4));
    return {
      chart,
      summary: {
        chart: `${label} ${label.includes('/') ? 'ratio ' : ''}· ${windowLabel(span)}`,
        ...(span >= 30 && (series.points.at(-1)!.t - series.points[0]!.t) / 86_400_000 < span - 3
          ? { note: `history only starts ${new Date(series.points[0]!.t).toISOString().slice(0, 10)}` }
          : {}),
        start: fmt(first),
        now: fmt(last),
        change: `${last >= first ? '+' : '−'}${Math.abs((last / first - 1) * 100).toFixed(1)}%`,
        high: fmt(Math.max(...values)),
        low: fmt(Math.min(...values)),
        source: series.source,
      },
    };
  }

  /** A logged thesis so far. */
  async progress(t: Thesis, latest: number | null, now: number): Promise<ChartFile | null> {
    if (t.spec.kind === 'flows') return this.flows(t.spec.asset);
    const symbols = t.spec.kind === 'relative' ? [t.spec.asset, t.spec.versus!] : [t.spec.asset];
    const kinds = [t.spec.assetKind, t.spec.versusKind];
    const histories: History[] = [];
    for (const [i, symbol] of symbols.entries()) {
      const asset = await this.deps.history.identify(symbol, kinds[i]).catch(() => null);
      const h = asset && (await this.deps.history.daily(asset).catch(() => null));
      if (!h) return null;
      histories.push(h);
    }
    return this.draw('progress', () => progressChart(t, histories, latest, now));
  }

  async flows(asset: string): Promise<ChartFile | null> {
    const report = await this.deps.desk?.flows(asset).catch(() => null);
    return report ? this.draw('flows', () => flowsChart(report)) : null;
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
