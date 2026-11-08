/**
 * Posts a preview of the bar question card (live prices and chart, a sample "yesterday" section) to a
 * channel through Discord's REST API, without logging in as the bot. Its buttons are for looks only.
 *
 *   npx tsx scripts/bar-preview-post.ts <server name> <channel name> [en,pt,...]
 */
import { MarketHistory } from '../src/analysis/history.js';
import { type BarRule, chartTitle, iso, roundLevel, ruleFor, specOf } from '../src/bar/questions.js';
import type { BarQuestion } from '../src/bar/store.js';
import { BinanceFeed } from '../src/calls/prices.js';
import { Charts } from '../src/charts/maker.js';
import { loadConfig } from '../src/config.js';
import { barQuestionContainer, barWords } from '../src/discord/barCards.js';
import { cards } from '../src/discord/ui.js';
import type { Lang } from '../src/lang.js';
import { CryptoQuotes } from '../src/quotes.js';

const [serverName, channelName, langList = 'en'] = process.argv.slice(2);
const config = loadConfig();
const API = 'https://discord.com/api/v10';
const auth = { Authorization: `Bot ${config.discord.token}` };
const get = async <T>(path: string) => (await (await fetch(`${API}${path}`, { headers: auth })).json()) as T;

const me = await get<{ id: string }>('/users/@me');
const guild = (await get<{ id: string; name: string }[]>('/users/@me/guilds')).find((g) => g.name === serverName);
if (!guild) throw new Error(`Ledger isn't in a server called ${serverName}`);
const channel = (await get<{ id: string; name: string }[]>(`/guilds/${guild.id}/channels`)).find((c) => c.name === channelName);
if (!channel) throw new Error(`No #${channelName} there`);
// The sample "yesterday" names the member who last talked to Ledger in that channel.
const recent = await get<{ author: { id: string; bot?: boolean } }[]>(`/channels/${channel.id}/messages?limit=50`);
const member = recent.find((m) => !m.author.bot)?.author.id ?? me.id;

const feed = new BinanceFeed(config.priceFeedUrl);
const crypto = new CryptoQuotes(feed);
const history = new MarketHistory({ resolve: (a) => crypto.resolve(a), binance: feed });
const charts = new Charts({ history, desk: null });
const stats = (await crypto.stats24h(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']))!;
const price = (asset: string) => stats[`${asset}USDT`]!.price;

const now = Date.now();
const today = iso(now);
const base = ruleFor(today);
const start = base.kind === 'beats' ? price(base.asset) / price(base.versus!) : price(base.asset);
const rule: BarRule = base.kind === 'above' ? { ...base, level: roundLevel(start) } : base;
const eth = stats.ETHUSDT!;
const question = (lang: Lang, r: BarRule, extra: Partial<BarQuestion>): BarQuestion => ({
  id: 0, guildId: guild.id, channelId: channel.id, lang, messageId: null, day: today, rule: r, startValue: start, ledger: 1, ledgerShare: 0.52,
  opensAt: now, closesAt: now + 8 * 3_600_000, settlesAt: now + 24 * 3_600_000, status: 'open', endValue: null, outcome: null, ...extra,
});

for (const lang of langList.split(',') as Lang[]) {
  const q = question(lang, rule, {});
  const yesterday = question(lang, { kind: 'up', asset: 'ETH' }, {
    day: iso(now - 86_400_000), status: 'settled', startValue: eth.price / (1 + eth.change), endValue: eth.price, outcome: eth.change > 0 ? 1 : 0, ledger: 1,
  });
  // The sample: the member read it right, and Ledger stands in for someone who missed.
  const votes = [{ userId: member, value: yesterday.outcome! }, { userId: me.id, value: 1 - yesterday.outcome! }];
  const chart = await charts.barQuestion(specOf(rule), chartTitle(rule, lang), barWords(lang).chartResult, lang);
  const payload = JSON.parse(JSON.stringify(cards([barQuestionContainer(q, [], { chart: !!chart, yesterday: { question: yesterday, votes } })])));
  const form = new FormData();
  form.append('payload_json', JSON.stringify(payload));
  if (chart) form.append('files[0]', new Blob([new Uint8Array(chart.data)], { type: 'image/png' }), chart.name);
  const res = await fetch(`${API}/channels/${channel.id}/messages`, { method: 'POST', headers: auth, body: form });
  console.log(lang, res.status, res.ok ? 'posted' : await res.text());
}
