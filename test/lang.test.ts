import { describe, expect, it } from 'vitest';
import { thesisChart } from '../src/charts/charts.js';
import { toPng } from '../src/charts/render.js';
import { caseContainer, thesisCard } from '../src/discord/thesisCards.js';
import { detectLang, langOf, langOfThread } from '../src/lang.js';
import { holdLine } from '../src/discord/conversation.js';
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
    for (const word of ['压力测试', '支持', '反对', '记录', '证据更不支持这个观点', '这样就错了', '完整分析']) expect(card).toContain(word);
    // The rest sits behind Full case.
    const full = JSON.stringify(caseContainer(t).toJSON());
    for (const word of ['什么情况说明它错了', '历史', '理解为']) expect(full).toContain(word);
    expect(card).not.toContain('Log it');
    const svg = thesisChart(spec, [btc], { lang: 'zh' });
    for (const word of ['BTC 一个月内高于 100,000', '目标 100,000', '复盘', '常见区间']) expect(svg).toContain(word);
    expect(svg).toMatch(/\d+月\d+日/);
    expect(toPng(svg).subarray(1, 4).toString()).toBe('PNG');
    // English stays English.
    expect(thesisChart(spec, [btc])).not.toMatch(/[一-鿿]/);
  });
});

describe('Japanese, Portuguese and Spanish', () => {
  it('tells the languages apart, including short messages', () => {
    expect(detectLang('ビットコインはどう？')).toBe('ja');
    expect(detectLang('日本語で話せますか')).toBe('ja');
    expect(detectLang('Consegue falar português')).toBe('pt');
    expect(detectLang('Ok, nao tem problema')).toBe('pt');
    expect(detectLang('qual o preço do eth')).toBe('pt');
    expect(detectLang('¿Qué opinas de ETH?')).toBe('es');
    expect(detectLang('cual es el precio de eth')).toBe('es');
    expect(detectLang('eth looking weak today?')).toBe('en');
    expect(detectLang('ok')).toBeNull();
    expect(detectLang('BTC?')).toBeNull();
  });

  it('keeps the conversation language on a short follow-up, and switches when asked', () => {
    expect(langOfThread(['Consegue falar português', 'ok'])).toBe('pt');
    expect(langOfThread(['hola, ¿cómo está el BTC hoy?', 'BTC?'])).toBe('es');
    expect(langOfThread(['Consegue falar português', 'in english please'])).toBe('en');
    expect(langOfThread(['ok'])).toBe('en');
  });

  it('writes the claim in each language', () => {
    const price = { kind: 'price', asset: 'BTC', direction: 'up', target: 100_000, horizonDays: 30 } as const;
    expect(claimText(price, 'ja')).toBe('BTC が1か月以内に 100,000 を上回る');
    expect(claimText(price, 'pt')).toBe('BTC acima de 100,000 em até um mês');
    expect(claimText(price, 'es')).toBe('BTC por encima de 100,000 en un mes');
    const move = { kind: 'move', asset: 'NVDA', direction: 'down', pct: 0.1, horizonDays: 14 } as const;
    expect(claimText(move, 'pt')).toBe('NVDA cai 10%+ em até 2 semanas');
    expect(claimText(move, 'es')).toBe('NVDA baja 10%+ en 2 semanas');
  });

  it('puts the language on the card, the chart and the waiting line', () => {
    const spec = { kind: 'price', asset: 'BTC', direction: 'up', target: 100_000, horizonDays: 30 } as const;
    for (const [lang, words] of [
      ['pt', ['Teste de estresse', 'Registrar', 'Outros prazos', 'Agora não']],
      ['es', ['Prueba de estrés', 'Registrar', 'Otros plazos', 'Ahora no']],
      ['ja', ['ストレステスト', '記録する', '他の期間', '今はいい']],
    ] as const) {
      const t = {
        id: 3, guildId: 'g', channelId: 'c', messageId: null, authorId: '1', take: 'x', claim: claimText(spec, lang), spec,
        analysis: { assumptions: [], argument: { for: [], against: [], kill: '', history: '', lean: 'even', verdict: '' }, facts: [], sources: ['Binance'], lang },
        status: 'draft', startValue: null, startAt: null, checkAt: null, endValue: null, settledAt: null, note: null, createdAt: NOW, challengerId: null,
      } as unknown as Thesis;
      const card = JSON.stringify(thesisCard(t, { with: [], against: [] }).components);
      for (const word of words) expect(card).toContain(word);
      expect(card).not.toContain('Log it');
      expect(holdLine('stress_test', lang)).not.toBe(holdLine('stress_test', 'en'));
    }
    const svg = thesisChart(spec, [btc], { lang: 'ja' });
    expect(svg).toContain('目標 100,000');
    expect(toPng(svg).subarray(1, 4).toString()).toBe('PNG');
    expect(thesisChart(spec, [btc], { lang: 'pt' })).toContain('alvo 100,000');
  });
});
