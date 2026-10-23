/**
 * Checks the setup without bringing Ledger online: the Discord token, which servers the bot is in,
 * the Message Content intent, the DeepSeek key (one tiny request), and the price feed.
 * Prints no secrets.
 *
 *   npm run check
 */
import {
  type APIApplication,
  type APIUser,
  ApplicationFlags,
  REST,
  type RESTAPIPartialCurrentUserGuild,
  Routes,
} from 'discord.js';
import { BinanceFeed } from '../src/calls/prices.js';
import { loadConfig } from '../src/config.js';
import { inviteLink } from '../src/discord/client.js';
import { formatUsd } from '../src/format.js';
import { DeepSeek } from '../src/llm/deepseek.js';
import { SoSoValue } from '../src/sosovalue.js';

const ok = (msg: string) => console.log(`✅ ${msg}`);
const warn = (msg: string) => console.log(`⚠️  ${msg}`);
const fail = (msg: string) => console.log(`❌ ${msg}`);
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

const config = loadConfig();

// --- Discord ---
try {
  const rest = new REST().setToken(config.discord.token);
  const [user, app, guilds] = (await Promise.all([
    rest.get(Routes.user()),
    rest.get(Routes.currentApplication()),
    rest.get(Routes.userGuilds()),
  ])) as [APIUser, APIApplication, RESTAPIPartialCurrentUserGuild[]];

  ok(`Discord token works. Bot: ${user.username} (application ${app.id})`);
  if (guilds.length === 0) warn('The bot is not in any server yet.');
  else ok(`In ${guilds.length} server(s): ${guilds.map((g) => `${g.name} [${g.id}]`).join(', ')}`);

  const contentFlags = ApplicationFlags.GatewayMessageContent | ApplicationFlags.GatewayMessageContentLimited;
  if ((app.flags ?? 0) & contentFlags) ok('Message Content intent is on.');
  else warn('Message Content intent is OFF. Ledger still runs, but only reads messages that ping it. The bot owner can switch it on.');

  if (app.bot_public === false) warn('The bot is private: only its owner can use the invite link.');
  console.log(`   Invite link: ${inviteLink(app.id)}`);
} catch (err) {
  fail(`Discord: ${errorText(err)}`);
}

// --- DeepSeek ---
try {
  const llm = new DeepSeek(config.llm);
  const { text, usage } = await llm.complete([{ role: 'user', content: 'Reply with exactly one word: ready' }], {
    maxTokens: 5,
  });
  ok(`DeepSeek key works. Model ${config.llm.model} replied "${text}" (cost $${usage.costUsd.toFixed(6)}).`);
} catch (err) {
  fail(`DeepSeek: ${errorText(err)}`);
}
try {
  const res = await fetch(new URL('/user/balance', config.llm.baseUrl), {
    headers: { Authorization: `Bearer ${config.llm.apiKey}` },
  });
  if (res.ok) {
    const body = (await res.json()) as { balance_infos?: { currency: string; total_balance: string }[] };
    const balances = (body.balance_infos ?? []).map((b) => `${b.total_balance} ${b.currency}`).join(', ');
    ok(`DeepSeek balance: ${balances || 'not reported'}`);
  } else {
    warn(`DeepSeek balance check returned HTTP ${res.status}.`);
  }
} catch (err) {
  warn(`DeepSeek balance check failed: ${errorText(err)}`);
}

// --- SoSoValue ---
if (!config.sosovalueApiKey) {
  warn('No SOSOVALUE_API_KEY: data desk, Daily Ledger and ETF-flow Daily Questions are off.');
} else {
  const soso = new SoSoValue(config.sosovalueApiKey);
  try {
    const [latest] = (await soso.etfFlows('BTC', 'US', 5)).filter((d) => d.totalNetInflow !== null);
    ok(`SoSoValue key works. BTC spot ETFs on ${latest?.date ?? '?'}: ${latest ? formatUsd(latest.totalNetInflow!, true) : 'no data'} net.`);
    const [overview, calendar, fomc] = await Promise.all([soso.marketOverview(), soso.macroCalendar(), soso.fomcOutlook()]);
    ok(`Market cap ${overview.totalMarketCap ? formatUsd(overview.totalMarketCap) : '?'} · ${calendar.length} macro dates · ${fomc.meetings.length} FOMC meetings.`);
  } catch (err) {
    fail(`SoSoValue: ${errorText(err)}`);
  }
}

// --- Price feed ---
try {
  const feed = new BinanceFeed(config.priceFeedUrl);
  const symbol = await feed.resolve('BTC');
  if (!symbol) throw new Error('BTCUSDT not listed');
  ok(`Price feed works. BTC = ${await feed.spot(symbol)}`);
} catch (err) {
  fail(`Price feed (${config.priceFeedUrl}): ${errorText(err)}`);
}
