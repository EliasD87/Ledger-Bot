import { createHash } from 'node:crypto';
import { type Client, Events, GatewayCloseCodes, type Guild } from 'discord.js';
import { AlertStore } from './alerts/store.js';
import { AlertWatcher } from './alerts/watcher.js';
import { BinanceFeed } from './calls/prices.js';
import { Settler } from './calls/settle.js';
import { Board } from './calls/store.js';
import { loadConfig } from './config.js';
import { buildLedger } from './daily/ledger.js';
import { DailyRunner } from './daily/runner.js';
import { DailyStore } from './daily/store.js';
import { openDb } from './db/index.js';
import { DataDesk } from './desk/desk.js';
import { TreasuryWatcher } from './desk/treasuries.js';
import { DiscordAlertNotifier } from './discord/alertNotifier.js';
import { announceSettlement, expireDrafts } from './discord/announcer.js';
import { createClient, inviteLink } from './discord/client.js';
import { commandData, handleInteraction } from './discord/commands.js';
import { Conversation } from './discord/conversation.js';
import { DiscordDailyPoster } from './discord/dailyPoster.js';
import { ServerMemory } from './discord/memory.js';
import { DeepSeek } from './llm/deepseek.js';
import { RateLimiter, Spend } from './llm/guards.js';
import { log, setLogLevel } from './log.js';
import { MessageArchive } from './memory/archive.js';
import { Activity, buildMyPage } from './pages/myPage.js';
import { Metrics, ReplyIndex } from './metrics.js';
import { SoSoValue } from './sosovalue.js';
import { ToolKit } from './tools.js';

const config = loadConfig();
setLogLevel(config.logLevel);

const db = openDb(config.dbPath);
const metrics = new Metrics(db);
const spend = new Spend(db);
const feed = new BinanceFeed(config.priceFeedUrl);
const board = new Board(db);
const settler = new Settler(board, feed);
const daily = new DailyStore(db);
const soso = config.sosovalueApiKey ? new SoSoValue(config.sosovalueApiKey) : null;
const desk = soso ? new DataDesk(soso, new TreasuryWatcher(soso)) : null;
if (!soso) log.warn("No SOSOVALUE_API_KEY: the tape and ETF-flow questions are off; Today's Page posts without the tape.");
const alerts = new AlertStore(db);
const archive = new MessageArchive(db);
const memory = new ServerMemory(() => client, archive);
const llm = new DeepSeek(config.llm);
const activity = new Activity(db);

const conversation = new Conversation({
  config,
  llm,
  tools: new ToolKit({
    feed,
    board,
    daily,
    desk,
    alerts,
    memory,
    myPage: (guildId, userId) => buildMyPage({ board, daily, alerts, activity, prices: feed, desk }, guildId, userId, Date.now()),
    quotes: { crypto: feed, stocks: soso },
  }),
  board,
  limiter: new RateLimiter(config.guards),
  spend,
  metrics,
  replies: new ReplyIndex(db),
});
const commandDeps = { config, feed, prices: feed, board, settler, daily, desk, alerts, memory, activity, llm, metrics, spend };

let client: Client;
let dailyRunner: DailyRunner | null = null;
let alertWatcher: AlertWatcher | null = null;
/** False until the recap data is cached after startup; the treasury scan waits for it so the two don't compete. */
let deskWarm = !desk;

/** Fetches everything the recap needs once, so the first "what moved yesterday?" after a restart is quick. */
async function warmDesk(): Promise<void> {
  if (!desk) return;
  const started = Date.now();
  await buildLedger(desk).catch((err) => log.warn('Warming the data desk failed', err));
  deskWarm = true;
  log.info(`Data desk warm in ${Math.round((Date.now() - started) / 1000)}s`);
}
let contentIntent = true;

async function start(readContent: boolean): Promise<void> {
  contentIntent = readContent;
  client = createClient({ readContent });
  dailyRunner = new DailyRunner({
    store: daily,
    candles: feed,
    soso,
    desk,
    poster: new DiscordDailyPoster(client, daily, board),
    closeMinute: config.dailyCloseMinuteUtc,
  });
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
    void warmDesk();
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

/** Once a minute: resolve calls, expire drafts, run the Daily Question and alerts, keep the treasury list fresh. */
async function tick(): Promise<void> {
  if (!client?.isReady()) return;
  for (const settlement of await settler.tick()) {
    log.info(`Call #${settlement.call.id} resolved: ${settlement.won ? 'right' : 'wrong'}`);
    await announceSettlement(client, settlement).catch((err) => log.error(`Announcing call #${settlement.call.id} failed`, err));
  }
  await expireDrafts(client, board, Date.now());
  await dailyRunner?.tick();
  await alertWatcher?.tick();
  if (deskWarm) void desk?.treasuries.refreshIfStale(3 * 60 * 60 * 1000); // background lane; a few minutes per scan
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
  await client.destroy();
  db.close();
  process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await start(true);
