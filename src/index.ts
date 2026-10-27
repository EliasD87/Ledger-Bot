import { MomentWatcher } from './theses/moments.js';
import { MarketContext } from './analysis/context.js';
import { WebNews } from './news/webNews.js';
import { createHash } from 'node:crypto';
import { type Client, Events, GatewayCloseCodes, type Guild } from 'discord.js';
import { AlertStore } from './alerts/store.js';
import { AlertWatcher } from './alerts/watcher.js';
import { EvidenceBuilder } from './analysis/evidence.js';
import { MarketHistory } from './analysis/history.js';
import { BinanceFeed } from './calls/prices.js';
import { Charts } from './charts/maker.js';
import { ChartRenderer } from './charts/pool.js';
import { loadConfig } from './config.js';
import { openDb } from './db/index.js';
import { DataDesk } from './desk/desk.js';
import { StoredDesk, TapeRefresher, TapeStore } from './desk/tape.js';
import { TreasuryWatcher } from './desk/treasuries.js';
import { DiscordAlertNotifier } from './discord/alertNotifier.js';
import { createClient, inviteLink } from './discord/client.js';
import { commandData, handleInteraction } from './discord/commands.js';
import { Conversation } from './discord/conversation.js';
import { ServerMemory } from './discord/memory.js';
import { announceMoments, announceVerdicts, expireDrafts } from './discord/thesisButtons.js';
import { DeepSeek } from './llm/deepseek.js';
import { RateLimiter, Spend } from './llm/guards.js';
import { log, setLogLevel } from './log.js';
import { Members } from './members.js';
import { MessageArchive } from './memory/archive.js';
import { Metrics, ReplyIndex } from './metrics.js';
import { Activity, buildMyPage } from './pages/myPage.js';
import { CryptoQuotes, StockQuotes } from './quotes.js';
import { SoSoValue } from './sosovalue.js';
import { Measure, ThesisSettler } from './theses/measure.js';
import type { TakeDeps } from './theses/service.js';
import { ThesisStore } from './theses/store.js';
import { ToolKit } from './tools.js';

const config = loadConfig();
setLogLevel(config.logLevel);

const db = openDb(config.dbPath);
const metrics = new Metrics(db);
const spend = new Spend(db);
const feed = new BinanceFeed(config.priceFeedUrl);
const soso = config.sosovalueApiKey ? new SoSoValue(config.sosovalueApiKey) : null;
// Only the refresher talks to SoSoValue (on a schedule, inside the monthly cap); everything else reads its stored results.
const tape = new TapeStore(db);
const desk = soso ? new StoredDesk(tape) : null;
const treasuries = soso ? new TreasuryWatcher(soso) : null;
const refresher = soso && treasuries ? new TapeRefresher({ tape, soso, live: new DataDesk(soso, treasuries), treasuries }) : null;
if (!soso) log.warn('No SOSOVALUE_API_KEY: the tape, ETF flows and flow takes are off.');
const alerts = new AlertStore(db);
const archive = new MessageArchive(db);
const memory = new ServerMemory(() => client, archive);
const llm = new DeepSeek(config.llm);
const activity = new Activity(db);
const members = new Members(db);

// The sparring partner: price history (with backups), evidence computed in code, takes and their check-backs.
const crypto = new CryptoQuotes(feed);
const stocks = new StockQuotes(desk);
const history = new MarketHistory({ resolve: (asset) => crypto.resolve(asset), binance: feed });
const news = new WebNews();
const context = new MarketContext({ history, news });
const evidence = new EvidenceBuilder({ history, desk, news, context });
const renderer = new ChartRenderer();
const charts = new Charts({ history, desk, renderer });
const theses = new ThesisStore(db);
const measure = new Measure({ history, crypto, stocks, desk });
const settler = new ThesisSettler({ store: theses, measure });
const moments = new MomentWatcher({ store: theses, measure, history });
const take: TakeDeps = { llm, evidence, theses, spend, charts };

const conversation = new Conversation({
  config,
  llm,
  tools: new ToolKit({
    members,
    theses,
    take,
    evidence,
    measure,
    feed,
    desk,
    alerts,
    memory,
    myPage: (guildId, userId) => buildMyPage({ theses, measure, alerts, activity }, guildId, userId, Date.now()),
    quotes: { crypto, stocks, identify: (raw, kind) => history.identify(raw, kind) },
    charts,
    news,
    context,
  }),
  members,
  theses,
  limiter: new RateLimiter(config.guards),
  spend,
  metrics,
  replies: new ReplyIndex(db),
});
const commandDeps = { config, feed, members, theses, take, measure, desk, alerts, memory, activity, llm, metrics, spend, charts };

let client: Client;
let alertWatcher: AlertWatcher | null = null;

/** Brings the stored tape up to date in the background; after a restart only what's stale is fetched. */
async function refreshTape(): Promise<void> {
  const ran = (await refresher?.tick()) ?? [];
  if (ran.length) log.debug(`Tape refreshed: ${ran.join(', ')} (SoSoValue ${tape.usage(Date.now()).toLocaleString('en-US')} requests this month)`);
}
let contentIntent = true;

async function start(readContent: boolean): Promise<void> {
  contentIntent = readContent;
  client = createClient({ readContent });
  alertWatcher = new AlertWatcher({ store: alerts, prices: feed, desk, notifier: new DiscordAlertNotifier(client, alerts) });

  client.once(Events.ClientReady, async (c) => {
    log.info(`Logged in as ${c.user.tag}, in ${c.guilds.cache.size} server(s)`);
    log.info(`Invite link: ${inviteLink(c.application.id)}`);
    if (!readContent) {
      log.warn(
        'Running WITHOUT the Message Content intent: Ledger only reads messages that ping it ' +
          '(mentions, and replies with the @ ping left on). To fix, whoever owns the bot app turns on ' +
          'Developer Portal → Bot → Privileged Gateway Intents → Message Content Intent; then restart Ledger.',
      );
    }
    void refreshTape();
    await Promise.all(c.guilds.cache.map((guild) => registerCommands(guild)));
  });
  client.on(Events.GuildCreate, (guild) => void registerCommands(guild));
  client.on(Events.MessageCreate, (message) => {
    if (message.inGuild() && !message.system && message.author.id !== message.client.user.id) {
      archive.record({
        messageId: message.id,
        guildId: message.guildId,
        channelId: message.channelId,
        authorId: message.author.id,
        authorName: message.member?.displayName ?? message.author.displayName,
        content: message.content,
        ts: message.createdTimestamp,
      });
    }
    conversation.handle(message).catch((err) => log.error('Message handler failed', err));
  });
  client.on(Events.InteractionCreate, (interaction) => {
    handleInteraction(interaction, commandDeps).catch((err) => log.error('Interaction handler failed', err));
  });
  client.on(Events.Error, (err) => log.error('Discord client error', err));
  client.on(Events.ShardDisconnect, ({ code }) => {
    if (code === GatewayCloseCodes.DisallowedIntents && readContent) {
      log.warn('Discord refused the Message Content intent (not enabled for this bot). Reconnecting without it.');
      void client.destroy().then(() => start(false));
    }
  });

  await client.login(config.discord.token);
}

/**
 * Server-scoped commands appear instantly, and need nothing beyond the bot token. Discord rate-limits
 * registration, so a server whose commands haven't changed since the last start is left alone.
 */
async function registerCommands(guild: Guild): Promise<void> {
  const key = `commands:${guild.id}:${createHash('sha1').update(JSON.stringify(commandData)).digest('hex')}`;
  if (alerts.seen(key)) {
    log.info(`Slash commands ready in ${guild.name} (unchanged)`);
    return;
  }
  try {
    await guild.commands.set(commandData);
    alerts.markSeen(key, Date.now());
    log.info(`Slash commands ready in ${guild.name}`);
  } catch (err) {
    log.warn(
      `Couldn't register slash commands in ${guild.name}. The bot was probably invited without the ` +
        '"applications.commands" scope; re-invite it with the invite link above.',
      err,
    );
  }
}

/** Once a minute: check back on due theses, expire unlogged stress tests, run alerts, refresh what's due on the tape. */
async function tick(): Promise<void> {
  if (!client?.isReady()) return;
  const { settled, voided } = await settler.tick();
  for (const v of settled) log.info(`Thesis #${v.thesis.id} checked back: ${v.held ? 'aged well' : 'aged badly'}`);
  for (const t of voided) log.warn(`Thesis #${t.id} voided: no data at the check-back`);
  await announceVerdicts(client, theses, settled, charts);
  // Between logging and check-back: target reached, given back, under pressure (checked every 10 minutes).
  await announceMoments(client, await moments.tick().catch((err) => (log.warn('Moment check failed', err), [])));
  await expireDrafts(client, theses, Date.now());
  await alertWatcher?.tick();
  void refreshTape().catch((err) => log.warn('Tape refresh failed', err));
  if (Date.now() - lastPrune > 60 * 60 * 1000) {
    lastPrune = Date.now();
    archive.prune(lastPrune);
  }
}
let lastPrune = 0;
const ticker = setInterval(() => void tick().catch((err) => log.error('Tick failed', err)), 60_000);

// A network blip while reconnecting to Discord (e.g. a Cloudflare 522 during the gateway handshake) can
// surface as an uncaught error. Reconnect instead of dying; give up and exit if it keeps happening, so a
// supervisor (systemd on the server) can restart the process cleanly.
const recentCrashes: number[] = [];
let reconnecting = false;

process.on('uncaughtException', (err) => {
  log.error('Uncaught error', err);
  const now = Date.now();
  recentCrashes.push(now);
  while (recentCrashes.length && now - recentCrashes[0]! > 10 * 60_000) recentCrashes.shift();
  if (recentCrashes.length > 5) {
    log.error('More than 5 uncaught errors in 10 minutes; exiting');
    process.exit(1);
  }
  void reconnect();
});
process.on('unhandledRejection', (err) => log.error('Unhandled promise rejection', err));

async function reconnect(): Promise<void> {
  if (reconnecting) return;
  reconnecting = true;
  try {
    await client?.destroy().catch(() => {});
    await new Promise((r) => setTimeout(r, 5_000));
    log.info('Reconnecting to Discord');
    await start(contentIntent);
    reconnecting = false;
  } catch (err) {
    log.error('Reconnect failed; trying again in 30 seconds', err);
    setTimeout(() => {
      reconnecting = false;
      void reconnect();
    }, 30_000);
  }
}

async function shutdown(signal: string): Promise<void> {
  log.info(`${signal} received, shutting down`);
  clearInterval(ticker);
  renderer.close();
  await client.destroy();
  db.close();
  process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await start(true);
