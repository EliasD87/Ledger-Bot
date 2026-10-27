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
import { ACCENT, card, cards, fileUrlIn, kicker, row, say } from '../src/discord/ui.js';
import { DeepSeek } from '../src/llm/deepseek.js';
import { Spend } from '../src/llm/guards.js';
import { CryptoQuotes, StockQuotes } from '../src/quotes.js';
import { Charts } from '../src/charts/maker.js';
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
type Payload = { components: readonly unknown[]; flags: unknown; allowedMentions?: unknown };
type File = { name: string; data: Buffer } | null | undefined;
const bodyOf = (payload: Payload, files: File[] = []) => {
  const body = JSON.parse(JSON.stringify({ ...payload, allowed_mentions: { parse: [] } }));
  delete body.allowedMentions;
  const real = files.filter((f): f is NonNullable<File> => !!f);
  if (real.length) body.attachments = real.map((f, id) => ({ id, filename: f.name }));
  return { body, files: real.map((f) => ({ name: f.name, data: f.data })) };
};
const post = async (label: string, payload: Payload, files: File[] = []) => {
  const { body, files: attach } = bodyOf(payload, files);
  const sent = (await rest.post(Routes.channelMessages(channelId), { body, files: attach })) as { id: string };
  console.log(`posted: ${label}`);
  return sent.id;
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
const charts = new Charts({ history, desk });
const take = { llm: new DeepSeek(config.llm), evidence: new EvidenceBuilder({ history, desk }), theses, spend: new Spend(db), charts };
const result = await draftTake(take, { guildId: '', channelId, userId: owner, name: 'Elias' }, takeText);
if (!result.ok) throw new Error(`The sample take didn't stress-test: ${result.message}`);
const draft: Thesis = { ...result.thesis, id: 9001 };
const measure = new Measure({ history, crypto, stocks: new StockQuotes(null), desk });
const start = (await measure.now(draft.spec, NOW - 3 * DAY)) ?? 1;
const open: Thesis = { ...draft, id: 9002, status: 'open', startValue: start, startAt: NOW - 3 * DAY, checkAt: NOW + 27 * DAY };
const agedWell: Thesis = { ...open, id: 9003, status: 'aged_well', endValue: draft.spec.kind === 'flows' ? start + 4e8 : start * 1.08, settledAt: NOW, checkAt: NOW - H };
const sides = { with: [owner], against: [owner] };

await post('section title', cards([say('## 🎨 Ledger card preview\n-# Sample data. Buttons on these samples do nothing.')]));
const chart = result.chart;
const lead = say('Braver than it sounds. Read the against column before you log it.');
const draftId = await post('chat reply + stress test', cards([lead, ...thesisCard(draft, { with: [], against: [] }, { chart: !!chart }).components], { replyPing: true }), [chart]);
// What Log it does: rebuild the card in place and attach the chart again (as rebuilding() in ui.ts does).
{
  const before = (await rest.get(Routes.channelMessage(channelId, draftId))) as { components: unknown[] };
  const old = fileUrlIn(before.components, 'chart.png');
  const again = old ? { name: 'chart.png', data: Buffer.from(await (await fetch(old)).arrayBuffer()) } : null;
  const { body, files } = bodyOf(cards([lead, ...thesisCard({ ...open, id: draft.id }, sides, { chart: !!again }).components]), [again]);
  await rest.patch(Routes.channelMessage(channelId, draftId), { body, files });
  const after = (await rest.get(Routes.channelMessage(channelId, draftId))) as { components: unknown[]; attachments: { filename: string }[] };
  const media = JSON.stringify(after.components).match(/"media":\{"url":"([^"]+)"/)?.[1];
  console.log(`edit kept the chart: ${media && !media.startsWith('attachment://') ? 'yes' : `NO (${media ?? 'no media'})`} · attachments: ${after.attachments.map((a) => a.filename).join(', ') || 'none'}`);
}
const progress = await charts.verdict(agedWell, agedWell.endValue!, true);
await post('check-back reply', verdictPost({ thesis: agedWell, endValue: agedWell.endValue!, held: true }, sides, { chart: !!progress }), [progress]);
await post(
  'your takes',
  myPageMessage(
    {
      since: NOW - 5 * H,
      firstVisit: false,
      open: [{ thesis: open, value: draft.spec.kind === 'flows' ? start + 1e8 : start * 1.03, holding: true }],
      results: [agedWell],
      sided: [],
      record: { logged: 4, agedWell: 2, agedBadly: 1, open: 1, contrarianWins: 1, sidesRight: 3, sidesSettled: 4, bold: { right: 2, total: 3 }, bestAsset: { asset: 'WTI', right: 4, total: 5 }, duels: { won: 3, lost: 1, against: [{ userId: '222', won: 2, lost: 0 }] }, form: [], best: agedWell },
      watching: {
        active: [{ id: 7, guildId: '', channelId, userId: owner, kind: 'price', asset: 'BTC', direction: 'below', target: 80_000, refPrice: null, repeat: false, status: 'active', createdAt: NOW, firedAt: null }],
        fired: [],
      },
    },
    '',
    true,
  ),
);
await post('record', cards([recordContainer('Elias', { logged: 4, agedWell: 2, agedBadly: 1, open: 1, contrarianWins: 1, sidesRight: 3, sidesSettled: 4, bold: { right: 2, total: 3 }, bestAsset: { asset: 'WTI', right: 4, total: 5 }, duels: { won: 3, lost: 1, against: [{ userId: '222', won: 2, lost: 0 }] }, form: [], best: agedWell })]));
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
  const flowChart = flows ? await charts.flows('BTC') : null;
  if (flows) await post('tape: flows', cards([flowsCard(flows, undefined, { chart: !!flowChart })]), [flowChart]);
  await post('tape: macro', cards([macroCard(await desk.macro())]));
  await post('tape: market', cards([marketCard(await desk.market())]));
  await post('tape: news', cards([newsCard(await desk.news())]));
}
console.log('done');
