import { describe, expect, it } from 'vitest';
import { thesisChart } from '../src/charts/charts.js';
import { toPng } from '../src/charts/render.js';
import { thesisCard } from '../src/discord/thesisCards.js';
import { langOf } from '../src/lang.js';
import { claimText } from '../src/theses/spec.js';
import type { Thesis } from '../src/theses/store.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 27, 12);
const closes = Array.from({ length: 400 }, (_, i) => ({ date: new Date(NOW - (399 - i) * DAY).toISOString().slice(0, 10), close: 80_000 * (1 + 0.1 * Math.sin(i / 20)) }));
const btc = { asset: { symbol: 'BTC', kind: 'crypto' as const, pair: 'BTCUSDT' }, closes, source: 'Binance' };

describe('Chinese', () => {
  it('knows a Chinese message from an English one, tickers and all', () => {
    expect(langOf('比特币圣诞节前到 10万')).toBe('zh');
    expect(langOf('<@123> BTC 年底前能到 100k 吗')).toBe('zh');
    expect(langOf('btc 100k by christmas')).toBe('en');
    expect(langOf('gm 你好 everyone how are you doing today')).toBe('en');
  });

  it('writes the claim in Chinese', () => {
    expect(claimText({ kind: 'price', asset: 'BTC', direction: 'up', target: 100_000, horizonDays: 30 }, 'zh')).toBe('BTC 一个月内高于 100,000');
    expect(claimText({ kind: 'relative', asset: 'SOL', versus: 'ETH', direction: 'up', horizonDays: 7 }, 'zh')).toBe('SOL 一周内跑赢 ETH');
    expect(claimText({ kind: 'move', asset: 'NVDA', direction: 'down', pct: 0.1, horizonDays: 14 }, 'zh')).toBe('NVDA 2 周内下跌 10% 以上');
  });

  it('puts Chinese labels on the card and the chart, and draws the characters', () => {
    const spec = { kind: 'price', asset: 'BTC', direction: 'up', target: 100_000, horizonDays: 30 } as const;
    const t = {
      id: 3, guildId: 'g', channelId: 'c', messageId: null, authorId: '1', take: '比特币一个月到10万', claim: claimText(spec, 'zh'), spec,
      analysis: { assumptions: ['「一个月」= 30 天'], argument: { for: [{ point: '在 200 日均线上方。', facts: [] }], against: [{ point: '历史上很少这么快。', facts: [] }], kill: 'k', history: 'h', lean: 'against', verdict: 'v' }, facts: [], sources: ['Binance'], lang: 'zh' },
      status: 'draft', startValue: null, startAt: null, checkAt: null, endValue: null, settledAt: null, note: null, createdAt: NOW, challengerId: null,
    } as unknown as Thesis;
    const card = JSON.stringify(thesisCard(t, { with: [], against: [] }).components);
    for (const word of ['压力测试', '支持', '反对', '记录', '证据更不支持这个观点', '什么情况说明它错了']) expect(card).toContain(word);
    expect(card).not.toContain('Log it');
    const svg = thesisChart(spec, [btc], { lang: 'zh' });
    for (const word of ['BTC 一个月内高于 100,000', '目标 100,000', '复盘', '常见区间']) expect(svg).toContain(word);
    expect(svg).toMatch(/\d+月\d+日/);
    expect(toPng(svg).subarray(1, 4).toString()).toBe('PNG');
    // English stays English.
    expect(thesisChart(spec, [btc])).not.toMatch(/[一-鿿]/);
  });
});
