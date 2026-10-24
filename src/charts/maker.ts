import type { History, MarketHistory } from '../analysis/history.js';
import type { Desk } from '../desk/desk.js';
import { log } from '../log.js';
import type { ThesisSpec } from '../theses/spec.js';
import type { Thesis } from '../theses/store.js';
import { assetsChart, flowsChart, progressChart, thesisChart } from './charts.js';
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

  /** A logged thesis so far. */
  async progress(t: Thesis, latest: number | null, now: number): Promise<ChartFile | null> {
    if (t.spec.kind === 'flows') return this.flows(t.spec.asset);
    const symbols = t.spec.kind === 'relative' ? [t.spec.asset, t.spec.versus!] : [t.spec.asset];
    const histories: History[] = [];
    for (const symbol of symbols) {
      const asset = await this.deps.history.identify(symbol).catch(() => null);
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
