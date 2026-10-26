import { describe, expect, it } from 'vitest';
import { FOMC_DECISIONS, bigMoves, eventReaction, nextFomc } from '../src/analysis/events.js';
import { lineChart } from '../src/charts/draw.js';

const DAY = 86_400_000;
/** Daily closes from 2025-01-01: a quiet 0.5% wiggle, with chosen jumps on chosen days. */
function series(days: number, jumps: Record<string, number> = {}) {
  const out: { date: string; close: number }[] = [];
  let close = 100;
  for (let i = 0; i < days; i++) {
    const date = new Date(Date.UTC(2025, 0, 1) + i * DAY).toISOString().slice(0, 10);
    close *= 1 + (jumps[date] ?? (i % 2 ? 0.005 : -0.005));
    out.push({ date, close });
  }
  return out;
}

describe('the event engine', () => {
  it('knows the next Fed decision', () => {
    expect(nextFomc(Date.UTC(2026, 9, 26))).toBe('2026-10-28');
    expect(nextFomc(Date.UTC(2026, 9, 28, 20))).toBe('2026-10-28');
    expect(FOMC_DECISIONS).toEqual([...FOMC_DECISIONS].sort());
  });

  it('measures moves around events against a normal stretch', () => {
    // Big up days on every 2025 FOMC decision.
    const fomc2025 = FOMC_DECISIONS.filter((d) => d.startsWith('2025'));
    const closes = series(360, Object.fromEntries(fomc2025.map((d) => [d, 0.04]))); // through 26 Dec 2025
    const s = eventReaction(closes, FOMC_DECISIONS)!;
    expect(s.count).toBe(fomc2025.length);
    expect(s.upShare).toBe(1);
    expect(s.avgAbsMove).toBeGreaterThan(s.normalAbsMove * 3);
    expect(s.recent.at(-1)!.date).toBe('2025-12-10');
    expect(eventReaction(series(20), FOMC_DECISIONS)).toBeNull();
  });

  it('finds the biggest days of a window, in date order', () => {
    const closes = series(400, { '2026-01-20': 0.06, '2025-12-15': -0.05, '2025-06-01': 0.09 });
    const moves = bigMoves(closes, 90, 4);
    expect(moves.map((m) => m.date)).toEqual(['2025-12-15', '2026-01-20']); // June is outside the window
    expect(moves[1]!.sigma).toBeGreaterThan(3);
  });

  it('numbers the events on the chart', () => {
    const points = series(60).map((c) => ({ t: Date.parse(`${c.date}T00:00:00Z`), v: c.close }));
    const svg = lineChart({ title: 'X', lines: [{ points, color: '#fff' }], format: (v) => v.toFixed(0), dots: [{ t: points[30]!.t, label: '1' }, { t: points[50]!.t, label: '2' }] });
    expect(svg.match(/r="9"/g)).toHaveLength(2);
    expect(svg).toContain('>2</text>');
  });
});
