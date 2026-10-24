import { describe, expect, it } from 'vitest';
import type { Call, Position } from '../src/calls/store.js';
import { Board } from '../src/calls/store.js';
import { DailyStore } from '../src/daily/store.js';
import { openDb } from '../src/db/index.js';
import { callCard, draftCard, settlementPost } from '../src/discord/callCards.js';
import { flowsCard, macroCard, marketCard, newsCard, treasuriesCard } from '../src/discord/deskCards.js';
import { howItWorks, myPageMessage, receiptsContainer } from '../src/discord/pageCards.js';
import { cards } from '../src/discord/ui.js';
import type { MyPage } from '../src/pages/myPage.js';

/** Discord refuses a card message with more than 40 components or 4,000 characters of text, or an empty text block. */
function checkLimits(payload: { components: readonly unknown[]; flags: unknown }) {
  const json = JSON.parse(JSON.stringify(payload.components)) as unknown[];
  let components = 0;
  let chars = 0;
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const n = node as { type?: number; content?: string; components?: unknown[]; accessory?: unknown };
    if (typeof n.type === 'number') components++;
    if (n.type === 10) {
      expect(n.content?.trim(), 'empty text block').toBeTruthy();
      chars += n.content!.length;
    }
    if (n.type === 1) expect(n.components!.length, 'buttons per row').toBeLessThanOrEqual(5);
    for (const child of n.components ?? []) walk(child);
    if (n.accessory) walk(n.accessory);
  };
  json.forEach(walk);
  expect(components).toBeLessThanOrEqual(40);
  expect(chars).toBeLessThanOrEqual(4000);
  expect(payload.flags).toBeDefined();
  return { components, chars, text: JSON.stringify(json) };
}

const NOW = Date.UTC(2026, 9, 24, 12);
const call: Call = {
  id: 4, guildId: 'g', channelId: 'c', messageId: 'm', callerId: '111', symbol: 'ETHUSDT', base: 'ETH',
  direction: 'above', kind: 'touch', target: 2480, deadline: NOW + 2 * 86_400_000, status: 'open',
  createdAt: NOW, entryPrice: 2407.28, chance: 0.35, payout: 65, lockedAt: NOW, checkedUntil: NOW,
  settledAt: null, settlePrice: null, settleTime: null, note: null,
};
// A crowded call: 30 members took a side.
const positions: Position[] = Array.from({ length: 31 }, (_, i) => ({
  id: i, callId: 4, userId: i === 0 ? '111' : `${200 + i}`, side: i % 3 ? 'back' : 'fade', stake: 0, chance: 0.35, payout: 0,
  createdAt: NOW, result: null, pnl: null, settledAt: null,
}));
const BETTING = /\bodds\b|\bpays?\b|payout|stake|\bbet\b|wager|gambl|×/i;

describe('cards fit Discord and read like a record', () => {
  it('call cards in every state', () => {
    const states: Call[] = [
      { ...call, status: 'draft' },
      call,
      { ...call, status: 'won', settlePrice: 2481, settleTime: NOW + 3_600_000, settledAt: NOW + 3_600_000 },
      { ...call, status: 'lost', settlePrice: 2401, settledAt: NOW + 2 * 86_400_000 },
      { ...call, status: 'void', note: 'bad print' },
      { ...call, status: 'cancelled', note: 'draft expired' },
    ];
    const settled = positions.map((p) => ({ ...p, result: (p.side === 'back' ? 'won' : 'lost') as Position['result'] }));
    for (const c of states) {
      const { text } = checkLimits(c.status === 'draft' ? draftCard(c) : callCard(c, c.status === 'open' ? positions : settled));
      // Button ids keep their internal names (ledger:back:4); only check what members read.
      expect(text.replace(/ledger:\w+:\d+/g, '')).not.toMatch(BETTING);
    }
    const post = settlementPost({ call: { ...call, status: 'won' }, positions: settled, won: true, price: 2481, at: NOW });
    expect(post.allowedMentions.users).toEqual(['111']);
    expect(checkLimits(post).text).not.toMatch(BETTING);
  });

  it('your page, receipts and how it works', () => {
    const page: MyPage = {
      since: NOW - 3_600_000,
      firstVisit: false,
      record: {
        settled: Array.from({ length: 8 }, (_, i) => ({ call: { ...call, id: i, status: 'won' }, position: { ...positions[0]!, result: 'won', pnl: 65 }, asCaller: true })),
        open: Array.from({ length: 8 }, (_, i) => ({ call: { ...call, id: 20 + i }, side: 'back', asCaller: i % 2 === 0, price: 2410 })),
        rep: 130,
        rank: 2,
        ranked: 14,
        leans: { right: 3, wrong: 1 },
      },
      question: { current: null, pending: [], last: null, streak: 0 },
      watching: {
        active: Array.from({ length: 20 }, (_, i) => ({ id: i, guildId: 'g', channelId: 'c', userId: '111', kind: 'price', asset: 'BTC', direction: 'above', target: 80_000 + i * 1000, refPrice: null, repeat: false, status: 'active', createdAt: NOW, firedAt: null }) as never),
        fired: [],
      },
      tape: null,
    };
    checkLimits(myPageMessage(page, 'g', true));
    checkLimits(myPageMessage({ ...page, firstVisit: true, record: { ...page.record, settled: [], open: [] }, watching: { active: [], fired: [] } }, 'g', false));
    const db = openDb(':memory:');
    checkLimits(cards([receiptsContainer(new Board(db), new DailyStore(db), 'g', { id: '111', name: 'Elias' }, NOW)]));
    expect(checkLimits(howItWorks()).text).not.toMatch(BETTING);
  });

  it('tape cards, including long and empty ones', () => {
    const day = (d: number) => ({ date: `2026-10-${String(d).padStart(2, '0')}`, totalNetInflow: -635.5e6, totalValueTraded: 1e9, totalNetAssets: 1e11, cumNetInflow: 5e10 });
    const flows = {
      asset: 'BTC', latest: day(22), days: [22, 21, 20, 17, 16].map(day), streak: { days: 3, total: -1.2e9 },
      funds: Array.from({ length: 12 }, (_, i) => ({ ticker: `F${i}`, name: 'Fund', netInflow: (i - 6) * 1e7 })),
    };
    checkLimits(cards([flowsCard(flows as never)]));
    checkLimits(cards([macroCard({ today: [{ event: 'CPI (YoY)', date: '2026-10-24', actual: '3.5%', forecast: '3.8%', previous: '4.2%' }], upcoming: Array.from({ length: 7 }, (_, i) => ({ date: `2026-10-${25 + i}`, events: ['A', 'B', 'C', 'D', 'E', 'F'] })), fomc: { meetingDate: '2026-10-28', ranges: [{ range: '3.75–4.00%', pct: 88.9 }] } })]));
    checkLimits(cards([macroCard({ today: [], upcoming: [], fomc: null })]));
    checkLimits(cards([treasuriesCard(Array.from({ length: 30 }, () => ({ company: 'Strategy', ticker: 'MSTR', date: '2026-10-19', btcAcquired: 267, btcHolding: 848_517, costUsd: 22.1e6 })), true, 14)]));
    checkLimits(cards([treasuriesCard([], false, 14)]));
    checkLimits(cards([newsCard({ asset: null, items: Array.from({ length: 10 }, () => ({ title: 'x'.repeat(300), link: 'https://example.com/a', releasedAt: NOW })) as never })]));
    checkLimits(cards([marketCard({ totalMarketCap: 2.7e12, marketCapChangePct: -0.4, volume24h: 6e10, sectors: Array.from({ length: 12 }, (_, i) => ({ name: `Sector ${i}`, change24h: 0.01 * i })) as never })]));
  });
});
