/**
 * Posts one of every Ledger card to a Discord channel, so the look can be judged in the real client.
 * Sends plain REST messages with the bot token; it never logs in to the gateway, so it can run while
 * Ledger is live. Sample calls use made-up numbers (#9001…), so their buttons touch nothing real.
 *
 *   npm run preview -- <channelId> [ownerUserId]
 */
import { REST, Routes } from 'discord.js';
import type { Call, Position } from '../src/calls/store.js';
import { Board } from '../src/calls/store.js';
import { loadConfig } from '../src/config.js';
import { DailyStore } from '../src/daily/store.js';
import { openDb } from '../src/db/index.js';
import { DataDesk } from '../src/desk/desk.js';
import { TreasuryWatcher } from '../src/desk/treasuries.js';
import { callContainer, draftContainer, settlementPost } from '../src/discord/callCards.js';
import { flowsCard, macroCard, marketCard, newsCard } from '../src/discord/deskCards.js';
import { myPageButton, myPageMessage, receiptsContainer } from '../src/discord/pageCards.js';
import { ACCENT, card, cards, kicker, row, say } from '../src/discord/ui.js';
import { SoSoValue } from '../src/sosovalue.js';

const [channelId, owner = '1064109967025639496'] = process.argv.slice(2);
if (!channelId) throw new Error('usage: npm run preview -- <channelId> [ownerUserId]');

const config = loadConfig();
const rest = new REST().setToken(config.discord.token);
const post = async (label: string, payload: { components: readonly unknown[]; flags: unknown; allowedMentions?: unknown }) => {
  const body = JSON.parse(JSON.stringify({ ...payload, allowed_mentions: { parse: [] } }));
  delete body.allowedMentions;
  await rest.post(Routes.channelMessages(channelId), { body });
  console.log(`posted: ${label}`);
};

const NOW = Date.now();
const H = 3_600_000;
const base: Call = {
  id: 9001, guildId: '', channelId, messageId: null, callerId: owner, symbol: 'ETHUSDT', base: 'ETH', direction: 'above',
  kind: 'touch', target: 2480, deadline: NOW + 46 * H, status: 'open', createdAt: NOW, entryPrice: 2407.28, chance: 0.35,
  payout: 65, lockedAt: NOW, checkedUntil: NOW, settledAt: null, settlePrice: null, settleTime: null, note: null,
};
const lean = (i: number, side: 'back' | 'fade', result: Position['result'] = null): Position => ({
  id: i, callId: base.id, userId: owner, side, stake: 0, chance: 0.35, payout: 0, createdAt: NOW, result, pnl: null, settledAt: null,
});

await post('section title', cards([say('## 🎨 Ledger card preview\n-# Sample data. Buttons on these samples do nothing.')]));
await post('chat reply + draft', cards([say('Drafted, Elias. Lock it in within 10 minutes.'), draftContainer({ ...base, status: 'draft' })]));
await post('open call', cards([callContainer(base, [lean(1, 'back'), lean(2, 'fade')])]));
await post('settled call', cards([callContainer({ ...base, id: 9002, status: 'won', settlePrice: 2481.4, settleTime: NOW - H, settledAt: NOW - H }, [lean(1, 'back', 'won'), lean(2, 'fade', 'lost')])]));
await post('result post', settlementPost({ call: { ...base, id: 9003, status: 'lost' }, positions: [lean(1, 'back', 'lost'), lean(2, 'fade', 'won')], won: false, price: 2401.9, at: NOW }));

const db = openDb(config.dbPath.replace(/ledger\.db$/, 'preview.db'));
const board = new Board(db);
const daily = new DailyStore(db);
await post(
  'your page',
  myPageMessage(
    {
      since: NOW - 5 * H,
      firstVisit: false,
      record: {
        settled: [{ call: { ...base, id: 9002, status: 'won', target: 82_000, base: 'BTC' }, position: { ...lean(1, 'back', 'won'), pnl: 62 }, asCaller: true }],
        open: [{ call: base, side: 'back', asCaller: true, price: 2410.5 }],
        rep: 41,
        rank: 2,
        ranked: 9,
        leans: { right: 3, wrong: 1 },
      },
      question: { current: null, pending: [], last: null, streak: 0 },
      watching: {
        active: [{ id: 7, guildId: '', channelId, userId: owner, kind: 'price', asset: 'BTC', direction: 'below', target: 80_000, refPrice: null, repeat: false, status: 'active', createdAt: NOW, firedAt: null }],
        fired: [{ id: 6, guildId: '', channelId, userId: owner, kind: 'price', asset: 'BTC', direction: 'above', target: 81_650, refPrice: null, repeat: false, status: 'fired', createdAt: NOW, firedAt: NOW - 2 * H }],
      },
      tape: null,
    },
    '',
    true,
  ),
);
await post('receipts', cards([receiptsContainer(board, daily, '', { id: owner, name: 'Elias' }, NOW)]));
await post(
  'watch DM',
  cards([
    card(ACCENT.amber, [
      kicker('🔔 Your watchlist'),
      '**BTC** went below 80,000 (low 79,941, now 79,987).',
      row(myPageButton('')),
      kicker('#7 BTC below 80,000'),
    ]),
  ]),
);

if (config.sosovalueApiKey) {
  const soso = new SoSoValue(config.sosovalueApiKey);
  const desk = new DataDesk(soso, new TreasuryWatcher(soso));
  const flows = await desk.flows('BTC').catch(() => null);
  if (flows) await post('tape: flows', cards([flowsCard(flows)]));
  await post('tape: macro', cards([macroCard(await desk.macro())]));
  await post('tape: market', cards([marketCard(await desk.market())]));
  await post('tape: news', cards([newsCard(await desk.news())]));
}
console.log('done');
