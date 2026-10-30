import { ComponentType, MessageFlags } from 'discord.js';
import { describe, expect, it } from 'vitest';
import type { History } from '../src/analysis/history.js';
import { assetsChart, flowsChart, lookbackFor, progressChart, thesisChart, typicalRange, verdictChart } from '../src/charts/charts.js';
import { niceRange, ticks } from '../src/charts/draw.js';
import { toPng } from '../src/charts/render.js';
import { thesisCard } from '../src/discord/thesisCards.js';
import { cards, fileUrlIn, replacing, say } from '../src/discord/ui.js';
import type { Thesis } from '../src/theses/store.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 24, 12);
/** A year of made-up daily closes with a gentle wave, oldest first. */
function history(symbol: string, base: number): History {
  const closes = Array.from({ length: 400 }, (_, i) => ({
    date: new Date(NOW - (399 - i) * DAY).toISOString().slice(0, 10),
    close: base * (1 + 0.2 * Math.sin(i / 30) + i / 2000),
  }));
  return { asset: { symbol, kind: 'crypto', pair: `${symbol}USDT` } as History['asset'], closes, source: 'Binance' };
}
const btc = history('BTC', 80_000);
const sol = history('SOL', 100);
const isPng = (b: Buffer) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

describe('charts', () => {
  it('draws every chart as a PNG, with the claim, target and source on it', () => {
    const take = thesisChart({ kind: 'price', asset: 'BTC', direction: 'up', target: 100_000, horizonDays: 62 }, [btc]);
    expect(take).toContain('BTC above 100,000 within 62 days');
    expect(take).toContain('target 100,000');
    expect(take).toContain('Binance');
    const pair = assetsChart([sol, btc]);
    expect(pair).toContain('both = 100 on');
    expect(pair).toMatch(/SOL [+−]\d/);
    const flows = flowsChart({
      asset: 'BTC',
      latest: { date: '2026-10-22', totalNetInflow: -635.5e6 },
      days: Array.from({ length: 21 }, (_, i) => ({ date: `2026-10-${String(22 - i).padStart(2, '0')}`, totalNetInflow: (i % 3 ? 1 : -1) * 1e8 })),
    } as never);
    expect(flows).toContain('BTC spot ETF flows');
    const t = { id: 12, claim: 'BTC above 100,000 within 62 days', spec: { kind: 'price', asset: 'BTC', direction: 'up', target: 100_000, horizonDays: 62 }, startValue: 85_000, startAt: NOW - 20 * DAY, checkAt: NOW + 42 * DAY } as Thesis;
    const progress = progressChart(t, [btc], 81_000, NOW);
    expect(progress).toContain('logged at 85,000');
    expect(progress).toContain('check-back');
    for (const svg of [take, pair, flows, progress]) {
      expect(svg).not.toMatch(/NaN|undefined|Infinity/);
      expect(isPng(toPng(svg))).toBe(true);
    }
  });

  it("scales a take's chart to the take, with the runway and the typical range", () => {
    expect([lookbackFor(1), lookbackFor(14), lookbackFor(60), lookbackFor(365)]).toEqual([7, 42, 180, 730]);
    const twoWeeks = thesisChart({ kind: 'price', asset: 'BTC', direction: 'up', target: 90_000, horizonDays: 14 }, [btc]);
    expect(twoWeeks).toContain('last 42 days, then the runway to');
    expect(twoWeeks).toContain('typical range');
    expect(twoWeeks).toContain('check-back');
    expect(twoWeeks).not.toContain('200-day'); // averages only on long windows
    expect(thesisChart({ kind: 'price', asset: 'BTC', direction: 'up', target: 90_000, horizonDays: 180 }, [btc])).toContain('200-day');
    const r = typicalRange(btc.closes, 100, 14, false)!;
    expect(r.lo).toBeLessThan(100);
    expect(r.hi).toBeGreaterThan(100);
    expect(r.hi * r.lo).toBeCloseTo(100 * 100); // symmetric in log terms
    expect(typicalRange(btc.closes.slice(0, 10), 100, 14, false)).toBeNull();
  });

  it('draws two-asset takes as two rebased lines, with events on the runway', () => {
    const svg = thesisChart({ kind: 'relative', asset: 'SOL', versus: 'BTC', direction: 'up', horizonDays: 30 }, [sol, btc], {
      events: [{ t: NOW + 4 * DAY, label: 'FOMC 28 Oct' }],
    });
    expect(svg).toContain('both = 100 on');
    expect(svg).toMatch(/>SOL [+−][\d.]+%</);
    expect(svg).toMatch(/>BTC [+−][\d.]+%</);
    expect(svg).toContain('FOMC 28 Oct');
    expect(svg).not.toMatch(/NaN|undefined/);
  });

  it('draws the check-back with where it finished against the range it had when logged', () => {
    const spec = { kind: 'price', asset: 'BTC', direction: 'up', target: 100_000, horizonDays: 30 } as const;
    const t = { id: 7, claim: 'BTC above 100,000 within a month', spec, startValue: 80_000, startAt: NOW - 30 * DAY, checkAt: NOW } as Thesis;
    const outside = verdictChart(t, [btc], 101_000, true);
    expect(outside).toContain('aged well');
    expect(outside).toContain('outside its typical range');
    expect(outside).toContain('stroke-linecap="round" stroke-linejoin="round"'); // the check mark
    const inside = verdictChart(t, [btc], 80_500, false);
    expect(inside).toContain('aged badly');
    expect(inside).toContain('inside its typical range');
    expect(isPng(toPng(outside))).toBe(true);
  });

  it('picks round axis steps', () => {
    expect(niceRange(61_000, 114_000)).toEqual([40_000, 120_000]);
    expect(ticks(40_000, 120_000)).toEqual([40_000, 60_000, 80_000, 100_000, 120_000]);
    expect(ticks(-1e9, 1e9)).toContain(0);
  });
});

describe('cards with charts', () => {
  const t = { id: 3, guildId: 'g', authorId: '1', take: 'sol flips eth', claim: 'SOL beats ETH over a week', spec: { kind: 'relative', asset: 'SOL', versus: 'ETH', direction: 'up', horizonDays: 7 },
    analysis: { assumptions: [], argument: { for: [{ point: 'a', facts: [] }], against: [{ point: 'b', facts: [] }], kill: 'k', history: 'h', lean: 'even', verdict: 'v' }, facts: [], sources: ['Binance'] },
    status: 'draft', startValue: null, startAt: null, checkAt: null, endValue: null, settledAt: null, note: null, createdAt: NOW } as unknown as Thesis;

  it('shows the attached chart inside the card only when there is one', () => {
    const withChart = JSON.stringify(thesisCard(t, { with: [], against: [] }, { chart: true }).components);
    expect(withChart).toContain('attachment://chart.png');
    expect(JSON.stringify(thesisCard(t, { with: [], against: [] }).components)).not.toContain('attachment://');
  });

  it('finds the chart inside a card, where Discord keeps it', () => {
    const url = 'https://cdn.discordapp.com/attachments/1/2/chart.png?ex=a&is=b&hm=c&';
    const stored = [{ type: 17, components: [{ type: 10, content: 'x' }, { type: 12, items: [{ media: { url, attachment_id: '2' }, description: 'Chart' }] }] }];
    expect(fileUrlIn(stored, 'chart.png')).toBe(url);
    expect(fileUrlIn(stored, 'other.png')).toBeUndefined();
    expect(fileUrlIn([{ type: 10, content: 'no images' }], 'chart.png')).toBeUndefined();
  });

  it("keeps Ledger's line above the card when the card is rebuilt", () => {
    const sent = cards([say('Braver than it sounds.'), ...thesisCard(t, { with: [], against: [] }).components]);
    const message = {
      flags: { has: (f: MessageFlags) => f === MessageFlags.IsComponentsV2 },
      components: sent.components.map((c) => ({ type: (c.toJSON() as { type: number }).type, toJSON: () => c.toJSON() })),
    };
    const edited = replacing(message, thesisCard({ ...t, status: 'open' } as Thesis, { with: [], against: [] }));
    const json = edited.components.map((c) => (typeof (c as { toJSON?: unknown }).toJSON === 'function' ? (c as { toJSON(): unknown }).toJSON() : c)) as { type: number; content?: string }[];
    expect(json[0]).toMatchObject({ type: ComponentType.TextDisplay, content: 'Braver than it sounds.' });
    expect(json[1]!.type).toBe(ComponentType.Container);
  });
});
