import { describe, expect, it } from 'vitest';
import { analogs, baseRate, change, correlation, latestMove, maxDrawdown, rangePosition, ratio, sma, volatility } from '../src/analysis/stats.js';

const day = (i: number) => new Date(Date.UTC(2024, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
const series = (values: number[]) => values.map((close, i) => ({ date: day(i), close }));
/** A gentle uptrend with a wobble, so returns aren't constant. */
const trend = (n: number, start = 100) => series(Array.from({ length: n }, (_, i) => start * (1 + 0.001 * i) * (1 + 0.02 * Math.sin(i / 3))));

describe('analytics', () => {
  it('changes, averages and ranges', () => {
    const s = series([100, 110, 99, 121]);
    expect(change(s, 1)).toBeCloseTo(121 / 99 - 1, 10);
    expect(change(s, 3)).toBeCloseTo(0.21, 10);
    expect(change(s, 4)).toBeNull();
    expect(sma(s, 2)).toBe(110);
    const r = rangePosition(trend(60))!;
    expect(r.high).toBeGreaterThan(r.low);
    expect(r.fromHigh).toBeLessThanOrEqual(0);
    expect(maxDrawdown(series([100, 120, 90, 130]))).toBeCloseTo(-0.25, 10);
  });

  it('measures how unusual the latest day is', () => {
    const calm = trend(120).map((c) => c.close);
    const s = series([...calm, calm.at(-1)! * 1.15]);
    const m = latestMove(s)!;
    expect(m.move).toBeCloseTo(0.15, 6);
    expect(m.sigma).toBeGreaterThan(3);
    expect(m.biggestIn).toBeGreaterThanOrEqual(119);
    expect(volatility(s)!.ratio).toBeGreaterThan(1);
  });

  it('ratios and correlation line up by date, skipping days one side is missing', () => {
    const a = series([10, 20, 30, 40]);
    const b = [{ date: day(0), close: 5 }, { date: day(2), close: 10 }, { date: day(3), close: 8 }];
    expect(ratio(a, b)).toEqual([
      { date: day(0), close: 2 },
      { date: day(2), close: 3 },
      { date: day(3), close: 5 },
    ]);
    const x = trend(100);
    expect(correlation(x, x)).toBeCloseTo(1, 6);
    expect(correlation(x, series(x.map((c) => 1 / c.close)))).toBeLessThan(-0.9);
  });

  it('base rates count every rolling window', () => {
    const up = series(Array.from({ length: 50 }, (_, i) => 100 + i)); // always up
    const r = baseRate(up, 10, (c) => c > 0)!;
    expect(r).toMatchObject({ hits: 40, windows: 40, rate: 1, since: day(0) });
    expect(baseRate(up.slice(0, 20), 10, () => true)).toBeNull(); // too little history
  });

  it('analogs find similar past setups and what followed', () => {
    const a = analogs(trend(400), 30)!;
    expect(a.count).toBeGreaterThanOrEqual(5);
    expect(a.upShare).toBeGreaterThan(0.5); // an uptrend: mostly higher 30 days later
    expect(a.setup.lookback).toBe(30);
  });
});
