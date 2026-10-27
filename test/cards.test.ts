import { describe, expect, it } from 'vitest';
import { flowsCard, macroCard, marketCard, newsCard, treasuriesCard } from '../src/discord/deskCards.js';
import { howItWorks, myPageMessage } from '../src/discord/pageCards.js';
import { boardContainer, recordContainer, thesisCard, verdictPost } from '../src/discord/thesisCards.js';
import { cards } from '../src/discord/ui.js';
import { BETTING } from '../src/llm/replyCheck.js';
import type { MyPage } from '../src/pages/myPage.js';
import type { Thesis } from '../src/theses/store.js';

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
const long = (n: number) => 'The ratio sits in the 12th percentile of its year, so a lot of bad news is already in the price. '.repeat(n).trim();
const thesis: Thesis = {
  id: 12, guildId: 'g', channelId: 'c', messageId: 'm', authorId: '111', take: 'sol flips eth this month, trust me, the chart is screaming', claim: 'SOL beats ETH over 8 days',
  spec: { kind: 'relative', asset: 'SOL', versus: 'ETH', direction: 'up', horizonDays: 8 },
  analysis: {
    assumptions: ['this month = 8 days', '"flips" read as outperforms'],
    // The longest argument the model is allowed: 3 points a side at the word limit.
    argument: {
      for: Array.from({ length: 3 }, () => ({ point: long(2), facts: ['F1'] })),
      against: Array.from({ length: 3 }, () => ({ point: long(2), facts: ['F2'] })),
      kill: long(2), history: long(2), lean: 'against', verdict: 'Cheap for a reason, until it is not.',
    },
    facts: [], sources: ['Binance', 'SoSoValue'],
  },
  status: 'draft', startValue: null, startAt: null, checkAt: null, endValue: null, settledAt: null, note: null, createdAt: NOW, challengerId: null,
};
const open: Thesis = { ...thesis, status: 'open', startValue: 0.0412, startAt: NOW, checkAt: NOW + 8 * 86_400_000 };
// A crowded debate: 40 members took a side.
const crowd = { with: Array.from({ length: 15 }, (_, i) => `${300 + i}`), against: Array.from({ length: 25 }, (_, i) => `${400 + i}`) };

describe('cards fit Discord and read like a record', () => {
  it('thesis cards in every state', () => {
    const states: Thesis[] = [
      thesis,
      open,
      { ...open, status: 'aged_well', endValue: 0.045, settledAt: open.checkAt },
      { ...open, status: 'aged_badly', endValue: 0.039, settledAt: open.checkAt },
      { ...open, status: 'void', note: 'bad print' },
      { ...thesis, status: 'cancelled', note: 'not logged within a day' },
    ];
    for (const t of states) {
      const { text } = checkLimits(thesisCard(t, t.status === 'draft' ? { with: [], against: [] } : crowd));
      expect(text.replace(/thesis:\w+:\d+/g, '')).not.toMatch(BETTING);
    }
    expect(checkLimits(thesisCard(thesis, { with: [], against: [] })).text).toContain('Log it');
    expect(checkLimits(thesisCard(open, crowd)).text).toContain("I'm against");
  });

  it('check-back posts ping only the author and show a contrarian win', () => {
    const post = verdictPost({ thesis: { ...open, status: 'aged_well', endValue: 0.045 }, endValue: 0.045, held: true }, crowd);
    expect(post.allowedMentions.users).toEqual(['111']);
    const { text } = checkLimits(post);
    expect(text).toMatch(/aged well/);
    expect(text).toMatch(/contrarian/i);
    expect(text).not.toMatch(BETTING);
  });

  it('your takes, records, open debates and how it works', () => {
    const page: MyPage = {
      since: NOW - 3_600_000,
      firstVisit: false,
      open: Array.from({ length: 12 }, (_, i) => ({ thesis: { ...open, id: 20 + i }, value: 0.043, holding: i % 2 === 0 })),
      results: Array.from({ length: 8 }, (_, i) => ({ ...open, id: 40 + i, status: i % 2 ? 'aged_well' : 'aged_badly' }) as Thesis),
      sided: Array.from({ length: 10 }, (_, i) => ({ thesis: { ...open, id: 60 + i, authorId: '222' }, side: i % 2 ? 'with' : 'against' })),
      record: { logged: 30, agedWell: 12, agedBadly: 9, open: 9, contrarianWins: 3, sidesRight: 14, sidesSettled: 20, bold: { right: 2, total: 3 }, bestAsset: { asset: 'WTI', right: 4, total: 5 }, duels: { won: 3, lost: 1, against: [{ userId: '222', won: 2, lost: 0 }] }, form: [], best: { ...open, status: 'aged_well', endValue: 0.05 } },
      watching: {
        active: Array.from({ length: 20 }, (_, i) => ({ id: i, guildId: 'g', channelId: 'c', userId: '111', kind: 'price', asset: 'BTC', direction: 'above', target: 80_000 + i * 1000, refPrice: null, repeat: false, status: 'active', createdAt: NOW, firedAt: null }) as never),
        fired: [],
      },
    };
    expect(checkLimits(myPageMessage(page, 'g', true)).text).not.toMatch(BETTING);
    const empty = { logged: 0, agedWell: 0, agedBadly: 0, open: 0, contrarianWins: 0, sidesRight: 0, sidesSettled: 0, bold: { right: 0, total: 0 }, bestAsset: null, duels: { won: 0, lost: 0, against: [] }, form: [], best: null };
    checkLimits(myPageMessage({ ...page, firstVisit: true, open: [], results: [], sided: [], record: empty, watching: { active: [], fired: [] } }, 'g', false));
    checkLimits(cards([recordContainer('Elias', page.record)]));
    checkLimits(cards([recordContainer('Elias', empty)]));
    checkLimits(cards([boardContainer(Array.from({ length: 30 }, (_, i) => ({ t: { ...open, id: i }, sides: crowd })), Array.from({ length: 10 }, (_, i) => ({ userId: `${i}`, right: 9, total: 14, takesRight: 5, takes: 8, sidesRight: 4, sides: 6 })))]));
    checkLimits(cards([boardContainer([], [])]));
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
