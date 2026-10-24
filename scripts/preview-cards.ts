/**
 * Posts one of every Ledger card to a Discord channel, so the look can be judged in the real client.
 * Sends plain REST messages with the bot token; it never logs in to the gateway, so it can run while
 * Ledger is live. The stress test is real (live data and DeepSeek, about $0.005); the other states reuse
 * it with made-up results, and their thesis numbers (#9001…) touch nothing real.
 *
 *   npm run preview -- <channelId> [ownerUserId] [--take "SOL beats ETH this month"]
 */
import { REST, Routes } from 'discord.js';
import { EvidenceBuilder } from '../src/analysis/evidence.js';
import { MarketHistory } from '../src/analysis/history.js';
import { BinanceFeed } from '../src/calls/prices.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { DataDesk } from '../src/desk/desk.js';
import { TreasuryWatcher } from '../src/desk/treasuries.js';
import { flowsCard, macroCard, marketCard, newsCard } from '../src/discord/deskCards.js';
import { myPageButton, myPageMessage } from '../src/discord/pageCards.js';
import { boardContainer, recordContainer, thesisCard, verdictPost } from '../src/discord/thesisCards.js';
import { ACCENT, card, cards, kicker, row, say } from '../src/discord/ui.js';
import { DeepSeek } from '../src/llm/deepseek.js';
import { Spend } from '../src/llm/guards.js';
import { CryptoQuotes, StockQuotes } from '../src/quotes.js';
import { SoSoValue } from '../src/sosovalue.js';
import { Measure } from '../src/theses/measure.js';
import { draftTake } from '../src/theses/service.js';
import { type Thesis, ThesisStore } from '../src/theses/store.js';

const args = process.argv.slice(2);
const takeAt = args.indexOf('--take');
const takeText = takeAt === -1 ? 'SOL beats ETH this month' : args.splice(takeAt, 2)[1]!;
const [channelId, owner = '1064109967025639496'] = args;
if (!channelId) throw new Error('usage: npm run preview -- <channelId> [ownerUserId] [--take "..."]');

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
const DAY = 24 * H;
const soso = config.sosovalueApiKey ? new SoSoValue(config.sosovalueApiKey) : null;
const desk = soso ? new DataDesk(soso, new TreasuryWatcher(soso)) : null;

// A real stress test, drafted into a throwaway database next to the live one.
const db = openDb(config.dbPath.replace(/ledger\.db$/, 'preview.db'));
const theses = new ThesisStore(db);
const feed = new BinanceFeed(config.priceFeedUrl);
const crypto = new CryptoQuotes(feed);
const history = new MarketHistory({ resolve: (asset) => crypto.resolve(asset), binance: feed });
const take = { llm: new DeepSeek(config.llm), evidence: new EvidenceBuilder({ history, desk }), theses, spend: new Spend(db) };
const result = await draftTake(take, { guildId: '', channelId, userId: owner, name: 'Elias' }, takeText);
if (!result.ok) throw new Error(`The sample take didn't stress-test: ${result.message}`);
const draft: Thesis = { ...result.thesis, id: 9001 };
const measure = new Measure({ history, crypto, stocks: new StockQuotes(null), desk });
const start = (await measure.now(draft.spec, NOW - 3 * DAY)) ?? 1;
const open: Thesis = { ...draft, id: 9002, status: 'open', startValue: start, startAt: NOW - 3 * DAY, checkAt: NOW + 27 * DAY };
const agedWell: Thesis = { ...open, id: 9003, status: 'aged_well', endValue: draft.spec.kind === 'flows' ? start + 4e8 : start * 1.08, settledAt: NOW, checkAt: NOW - H };
const sides = { with: [owner], against: [owner] };

await post('section title', cards([say('## 🎨 Ledger card preview\n-# Sample data. Buttons on these samples do nothing.')]));
await post('chat reply + stress test', cards([say('Braver than it sounds. Read the against column before you log it.'), ...thesisCard(draft, { with: [], against: [] }).components], { replyPing: true }));
await post('logged thesis', thesisCard(open, sides));
await post('check-back reply', verdictPost({ thesis: agedWell, endValue: agedWell.endValue!, held: true }, sides));
await post(
  'your takes',
  myPageMessage(
    {
      since: NOW - 5 * H,
      firstVisit: false,
      open: [{ thesis: open, value: draft.spec.kind === 'flows' ? start + 1e8 : start * 1.03, holding: true }],
      results: [agedWell],
      sided: [],
      record: { logged: 4, agedWell: 2, agedBadly: 1, open: 1, contrarianWins: 1, sidesRight: 3, sidesSettled: 4, best: agedWell },
      watching: {
        active: [{ id: 7, guildId: '', channelId, userId: owner, kind: 'price', asset: 'BTC', direction: 'below', target: 80_000, refPrice: null, repeat: false, status: 'active', createdAt: NOW, firedAt: null }],
        fired: [],
      },
    },
    '',
    true,
  ),
);
await post('record', cards([recordContainer('Elias', { logged: 4, agedWell: 2, agedBadly: 1, open: 1, contrarianWins: 1, sidesRight: 3, sidesSettled: 4, best: agedWell })]));
await post('open debates', cards([boardContainer([{ t: open, sides }], [{ userId: owner, agedWell: 2, settled: 3 }])]));
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

if (desk) {
  const flows = await desk.flows('BTC').catch(() => null);
  if (flows) await post('tape: flows', cards([flowsCard(flows)]));
  await post('tape: macro', cards([macroCard(await desk.macro())]));
  await post('tape: market', cards([marketCard(await desk.market())]));
  await post('tape: news', cards([newsCard(await desk.news())]));
}
console.log('done');
