import {
  ActionRowBuilder,
  type ButtonBuilder,
  ChannelType,
  type ChatInputCommandInteraction,
  EmbedBuilder,
  type Interaction,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { type AlertRequest, createAlert, describeAlert } from '../alerts/service.js';
import type { AlertStore } from '../alerts/store.js';
import type { CallKind, Direction } from '../calls/odds.js';
import type { BinanceFeed } from '../calls/prices.js';
import { type CallRequest, type PriceSource, callHeadline, draftCall, refusalText } from '../calls/service.js';
import type { Settler } from '../calls/settle.js';
import { type Board, seasonStart } from '../calls/store.js';
import type { Config } from '../config.js';
import type { DailyStore } from '../daily/store.js';
import { type DataDesk, ETF_ASSETS } from '../desk/desk.js';
import { count, discordTime, formatPoints, monthLabel, parseDuration } from '../format.js';
import type { ChatModel } from '../llm/deepseek.js';
import type { Spend } from '../llm/guards.js';
import { log } from '../log.js';
import { RETENTION_DAYS } from '../memory/archive.js';
import { summarize } from '../memory/summarize.js';
import { COMMAND_PILLAR, type Metrics } from '../metrics.js';
import type { Activity } from '../pages/myPage.js';
import { refreshCard } from './announcer.js';
import { handleCallButton } from './callButtons.js';
import { draftCard } from './callCards.js';
import { handleDailyButton } from './dailyButtons.js';
import { flowsEmbed, macroEmbed, marketEmbed, newsEmbed, treasuriesEmbed } from './deskCards.js';
import type { ServerMemory } from './memory.js';
import { handlePageInteraction, showMyPage } from './pageButtons.js';
import { callLink, myPageButton, receiptsEmbed } from './pageCards.js';
import { postableReply } from './text.js';
import { handleWatchButton, watchButton } from './watchButtons.js';

const DAY = 24 * 60 * 60 * 1000;
const FEED_DOWN = "Price feed isn't answering, or the asset is too new to price. Try again later.";

const guildCommand = (name: string, description: string) =>
  new SlashCommandBuilder().setName(name).setDescription(description).setContexts(InteractionContextType.Guild);

/**
 * The whole surface: 7 member commands and 2 admin commands. Everything else is a button on a card,
 * or a sentence to @Ledger.
 */
export const commandData = [
  guildCommand('ledger', 'Your page: what changed for you since you last looked'),
  guildCommand('call', 'Put a price call on the record')
    .addStringOption((o) => o.setName('asset').setDescription('Ticker, e.g. BTC, ETH, SOL').setRequired(true))
    .addStringOption((o) =>
      o.setName('direction').setDescription('Above or below the target').setRequired(true).addChoices({ name: 'above', value: 'above' }, { name: 'below', value: 'below' }),
    )
    .addNumberOption((o) => o.setName('target').setDescription('Target price in USD').setRequired(true).setMinValue(0))
    .addStringOption((o) => o.setName('within').setDescription('Time window, e.g. 6h, 3d, 2w (1h to 90d)').setRequired(true))
    .addStringOption((o) =>
      o
        .setName('type')
        .setDescription('touch: hits the target any time (default). close: is past it at the deadline.')
        .addChoices({ name: 'touch', value: 'touch' }, { name: 'close', value: 'close' }),
    ),
  guildCommand('watch', 'Your watchlist: DMs when something you follow happens')
    .addSubcommand((s) =>
      s
        .setName('price')
        .setDescription('When an asset crosses a price (once)')
        .addStringOption((o) => o.setName('asset').setDescription('Ticker, e.g. BTC').setRequired(true))
        .addStringOption((o) =>
          o.setName('direction').setDescription('Above or below').setRequired(true).addChoices({ name: 'above', value: 'above' }, { name: 'below', value: 'below' }),
        )
        .addNumberOption((o) => o.setName('price').setDescription('Price in USD').setRequired(true).setMinValue(0)),
    )
    .addSubcommand((s) =>
      s
        .setName('daily')
        .setDescription('Any day an asset moves this much over 24h (repeats)')
        .addStringOption((o) => o.setName('asset').setDescription('Ticker, e.g. SOL').setRequired(true))
        .addNumberOption((o) => o.setName('percent').setDescription('1 to 50 (default 5)').setMinValue(1).setMaxValue(50)),
    )
    .addSubcommand((s) =>
      s
        .setName('move')
        .setDescription('When an asset moves this much from now (once)')
        .addStringOption((o) => o.setName('asset').setDescription('Ticker, e.g. SOL').setRequired(true))
        .addNumberOption((o) => o.setName('percent').setDescription('1 to 50').setRequired(true).setMinValue(1).setMaxValue(50)),
    )
    .addSubcommand((s) =>
      s
        .setName('flows')
        .setDescription('Every new spot ETF flow day for an asset (repeats)')
        .addStringOption((o) =>
          o.setName('asset').setDescription('Which ETFs').setRequired(true).addChoices(...ETF_ASSETS.map((a) => ({ name: a, value: a }))),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('macro')
        .setDescription('When a macro release is out (once)')
        .addStringOption((o) => o.setName('event').setDescription('e.g. CPI, PCE, Nonfarm Payrolls, GDP').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('buys').setDescription('Every new corporate BTC purchase (repeats)'))
    .addSubcommand((s) => s.setName('list').setDescription('What you watch'))
    .addSubcommand((s) =>
      s
        .setName('stop')
        .setDescription('Stop one watch')
        .addIntegerOption((o) => o.setName('id').setDescription('Number from /watch list').setRequired(true)),
    ),
  guildCommand('tape', 'The numbers: ETF flows, macro, BTC buys, news, market (SoSoValue)')
    .addStringOption((o) =>
      o
        .setName('topic')
        .setDescription('What to show')
        .setRequired(true)
        .addChoices(
          { name: 'flows', value: 'flows' },
          { name: 'macro', value: 'macro' },
          { name: 'buys', value: 'buys' },
          { name: 'news', value: 'news' },
          { name: 'market', value: 'market' },
        ),
    )
    .addStringOption((o) => o.setName('asset').setDescription('For flows and news, e.g. ETH (default BTC / hottest news)')),
  guildCommand('receipts', "A member's record").addUserOption((o) => o.setName('member').setDescription('Whose (default: yours)')),
  guildCommand('board', 'Standings and open calls').addStringOption((o) =>
    o
      .setName('view')
      .setDescription('Season (default), all time, or open calls')
      .addChoices({ name: 'season', value: 'season' }, { name: 'all-time', value: 'all-time' }, { name: 'open calls', value: 'open' }),
  ),
  guildCommand('recall', 'What people said about a topic (only you see it)')
    .addStringOption((o) => o.setName('topic').setDescription('e.g. SOL, the mint, airdrop').setRequired(true))
    .addIntegerOption((o) => o.setName('days').setDescription('How far back (default 7)').setMinValue(1).setMaxValue(30)),
  guildCommand('ledger-setup', "Set Ledger's channel: Today's Page and big prints (admins)")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption((o) => o.setName('channel').setDescription('The Ledger channel').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
    .addBooleanOption((o) => o.setName('archive').setDescription(`Keep ${RETENTION_DAYS} days of messages for server-wide /recall`))
    .addBooleanOption((o) => o.setName('off').setDescription("Stop Today's Page and prints")),
  guildCommand('ledger-admin', 'Engagement numbers, or void a call (admins)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) => s.setName('stats').setDescription('Habit numbers for this server'))
    .addSubcommand((s) =>
      s
        .setName('void')
        .setDescription('Void a call: every position goes back to zero')
        .addIntegerOption((o) => o.setName('call').setDescription('Call number').setRequired(true).setMinValue(1))
        .addStringOption((o) => o.setName('reason').setDescription('Why, shown on the card').setRequired(true)),
    ),
].map((command) => command.toJSON());

export interface CommandDeps {
  config: Config;
  feed: PriceSource;
  /** Batched live prices for Your Page. */
  prices: Pick<BinanceFeed, 'change24h'>;
  board: Board;
  settler: Settler;
  daily: DailyStore;
  /** Null without a SoSoValue key. */
  desk: DataDesk | null;
  alerts: AlertStore;
  memory: ServerMemory;
  activity: Activity;
  /** For /recall and catch-up summaries. */
  llm: ChatModel;
  metrics: Metrics;
  spend: Spend;
}

export async function handleInteraction(interaction: Interaction, deps: CommandDeps): Promise<void> {
  const pageDeps = { ...deps, prices: deps.prices };
  if (interaction.isButton() || interaction.isChannelSelectMenu()) {
    const id = interaction.customId;
    if (id.startsWith('page:')) return handlePageInteraction(interaction, pageDeps);
    if (!interaction.isButton()) return;
    if (id.startsWith('watch:')) return handleWatchButton(interaction, { store: deps.alerts, feed: deps.feed, desk: deps.desk, metrics: deps.metrics });
    if (id.startsWith('daily:')) return handleDailyButton(interaction, deps);
    return handleCallButton(interaction, deps);
  }
  if (!interaction.isChatInputCommand() || !interaction.inCachedGuild()) return;
  deps.board.remember(interaction.user.id, interaction.member.displayName);
  deps.metrics.record({
    type: 'command',
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    userId: interaction.user.id,
    meta: { name: interaction.commandName, pillar: COMMAND_PILLAR[interaction.commandName] ?? 'chat' },
  });
  switch (interaction.commandName) {
    case 'ledger':
      return showMyPage(interaction, pageDeps, interaction.guildId, 'command');
    case 'call':
      return call(interaction, deps);
    case 'watch':
      return watch(interaction, deps);
    case 'tape':
      return tape(interaction, deps);
    case 'receipts': {
      const member = interaction.options.getMember('member') ?? interaction.member;
      deps.board.remember(member.id, member.displayName);
      await interaction.reply({ embeds: [receiptsEmbed(deps.board, deps.daily, interaction.guildId, { id: member.id, name: member.displayName }, Date.now())] });
      return;
    }
    case 'board':
      return board(interaction, deps);
    case 'recall':
      return recall(interaction, deps);
    case 'ledger-setup':
      return setup(interaction, deps);
    case 'ledger-admin':
      return interaction.options.getSubcommand() === 'void' ? voidCall(interaction, deps) : stats(interaction, deps);
  }
}

function readCallOptions(interaction: ChatInputCommandInteraction): CallRequest | string {
  const windowMs = parseDuration(interaction.options.getString('within', true));
  if (windowMs === null) return 'Give me a window like `6h`, `3d` or `2w`.';
  return {
    asset: interaction.options.getString('asset', true),
    direction: interaction.options.getString('direction', true) as Direction,
    target: interaction.options.getNumber('target', true),
    windowMs,
    kind: (interaction.options.getString('type') ?? 'touch') as CallKind,
  };
}

async function call(interaction: ChatInputCommandInteraction<'cached'>, { feed, board }: CommandDeps): Promise<void> {
  const request = readCallOptions(interaction);
  if (typeof request === 'string') {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: request });
    return;
  }
  await interaction.deferReply();
  let result;
  try {
    const who = { guildId: interaction.guildId, channelId: interaction.channelId, callerId: interaction.user.id };
    result = await draftCall(feed, board, who, request, Date.now());
  } catch {
    await interaction.editReply(FEED_DOWN);
    return;
  }
  if (!result.call) {
    const { priced } = result;
    await interaction.editReply(
      !priced
        ? `No live USDT market for \`${request.asset}\` on my feed. Crypto only, for now.`
        : priced.quote.ok
          ? FEED_DOWN
          : refusalText(priced.quote, priced.base, priced.spot),
    );
    return;
  }
  const message = await interaction.editReply(draftCard(result.call));
  board.attachMessage(result.call.id, interaction.channelId, message.id);
}

async function watch(interaction: ChatInputCommandInteraction<'cached'>, { alerts, feed, desk }: CommandDeps): Promise<void> {
  const o = interaction.options;
  const sub = o.getSubcommand();
  if (sub === 'list') {
    const mine = alerts.forUser(interaction.guildId, interaction.user.id);
    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: mine.length
        ? `🔔 **Your watchlist**\n${mine.map(describeAlert).join('\n')}\n-# Stop one with /watch stop.`
        : 'Nothing on your watchlist. Try `/watch flows asset:BTC`, or tell me "alert me if BTC drops below 80k".',
    });
    return;
  }
  if (sub === 'stop') {
    const id = o.getInteger('id', true);
    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: alerts.cancel(id, interaction.user.id) ? `Watch #${id} stopped.` : `You have no active watch #${id}.`,
    });
    return;
  }
  const request: AlertRequest =
    sub === 'price'
      ? { kind: 'price', asset: o.getString('asset', true), direction: o.getString('direction', true) as 'above' | 'below', price: o.getNumber('price', true) }
      : sub === 'daily'
        ? { kind: 'day-move', asset: o.getString('asset', true), percent: o.getNumber('percent') ?? 5 }
        : sub === 'move'
          ? { kind: 'move', asset: o.getString('asset', true), percent: o.getNumber('percent', true) }
          : sub === 'flows'
            ? { kind: 'etf-flow', asset: o.getString('asset', true) }
            : sub === 'macro'
              ? { kind: 'macro', event: o.getString('event', true) }
              : { kind: 'treasury' };
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const who = { guildId: interaction.guildId, channelId: interaction.channelId, userId: interaction.user.id };
    const result = await createAlert({ store: alerts, feed, desk }, who, request, Date.now());
    await interaction.editReply(result.ok ? `🔔 ${result.summary}\n-# Hits come by DM and show on your page.` : result.error);
  } catch {
    await interaction.editReply("The price feed isn't answering. Try again in a minute.");
  }
}

/** /tape: SoSoValue numbers as a public card, with a one-tap watch where one fits. */
async function tape(interaction: ChatInputCommandInteraction<'cached'>, { desk }: CommandDeps): Promise<void> {
  if (!desk) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: 'The tape needs a SoSoValue API key (SOSOVALUE_API_KEY).' });
    return;
  }
  const topic = interaction.options.getString('topic', true);
  const asset = interaction.options.getString('asset')?.trim().toUpperCase().replace(/^\$/, '');
  await interaction.deferReply();
  try {
    const row = new ActionRowBuilder<ButtonBuilder>();
    let embed: EmbedBuilder;
    if (topic === 'flows') {
      const which = asset ?? 'BTC';
      const report = await desk.flows(which);
      embed = report ? flowsEmbed(report) : new EmbedBuilder().setTitle(`📒 ${which} spot ETF flows`).setDescription(`No US spot ETF flow data for ${which}. Try: ${ETF_ASSETS.join(', ')}.`);
      if (report) row.addComponents(watchButton({ kind: 'flows', asset: report.asset }));
    } else if (topic === 'macro') {
      embed = macroEmbed(await desk.macro());
    } else if (topic === 'buys') {
      embed = treasuriesEmbed(desk.treasuryBuys(14), desk.treasuries.ready, 14);
      row.addComponents(watchButton({ kind: 'buys' }));
    } else if (topic === 'news') {
      embed = newsEmbed(await desk.news(asset));
    } else {
      embed = marketEmbed(await desk.market());
    }
    row.addComponents(myPageButton(interaction.guildId));
    await interaction.editReply({ embeds: [embed], components: [row] });
  } catch (err) {
    log.warn(`/tape ${topic} failed`, err);
    await interaction.editReply("SoSoValue isn't answering right now. Try again in a minute.");
  }
}

async function board(interaction: ChatInputCommandInteraction<'cached'>, { board }: CommandDeps): Promise<void> {
  const view = interaction.options.getString('view') ?? 'season';
  const now = Date.now();
  if (view === 'open') {
    const open = board.openCalls(interaction.guildId);
    const lines = open.slice(0, 15).map((c) => {
      const positions = board.positions(c.id).filter((p) => p.userId !== c.callerId);
      const agree = positions.filter((p) => p.side === 'back').length;
      return `${callLink(c)} ${callHeadline(c)} ${c.kind === 'touch' ? 'by' : 'at'} ${discordTime(c.deadline, 'R')} · <@${c.callerId}> · ${agree} agree, ${positions.length - agree} disagree`;
    });
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`📒 Open calls (${open.length})`)
      .setDescription(lines.length ? lines.join('\n') + (open.length > 15 ? `\n+${open.length - 15} more` : '') : "No open calls. Make one: `/call` or `@Ledger I call BTC hits 90k by Friday`.");
    await interaction.reply({ embeds: [embed] });
    return;
  }
  const allTime = view === 'all-time';
  const standings = board.leaderboard(interaction.guildId, allTime ? 0 : seasonStart(now));
  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle(allTime ? '📒 Board · all time' : `📒 Board · ${monthLabel(now)} season`);
  if (!standings.length) {
    embed.setDescription("Nobody's on the board yet. Answer the daily question or make a call.");
  } else {
    const medals = ['🥇', '🥈', '🥉'];
    const line = (s: (typeof standings)[number], i: number) =>
      `${medals[i] ?? `**${i + 1}.**`} <@${s.userId}> **${formatPoints(s.points)}** · calls ${s.wins}–${s.losses} (${formatPoints(s.callPoints)}) · daily ${formatPoints(s.dailyPoints)}`;
    const lines = standings.slice(0, 10).map(line);
    const mine = standings.findIndex((s) => s.userId === interaction.user.id);
    if (mine >= 10) lines.push('…', line(standings[mine]!, mine));
    embed.setDescription(lines.join('\n')).setFooter({ text: 'Rep = call scores (result minus rating) + daily answers. Agree/disagree is recorded, not scored.' });
  }
  await interaction.reply({ embeds: [embed] });
}

/** /recall: a private summary of what people said about a topic, only from channels the member can read. */
async function recall(interaction: ChatInputCommandInteraction<'cached'>, { memory, llm, spend, config }: CommandDeps): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (spend.today() >= config.guards.dailyBudgetUsd) {
    await interaction.editReply("That's it for today: my daily budget is spent. Try again after 00:00 UTC.");
    return;
  }
  const topic = interaction.options.getString('topic', true);
  try {
    const found = await memory.recall(
      { guildId: interaction.guildId, channelId: interaction.channelId, userId: interaction.user.id },
      topic,
      interaction.options.getInteger('days') ?? 7,
    );
    if (!found.ok) {
      await interaction.editReply(found.error);
      return;
    }
    const summary = await summarize(llm, found.transcript, `Summarize what people said about "${topic}" (${found.count} messages from ${found.channelName}).`, (usage) =>
      spend.record({ purpose: 'recall', model: llm.model, userId: interaction.user.id, guildId: interaction.guildId, usage }),
    );
    const where = found.channelName === 'the whole server' ? 'the server' : `#${found.channelName}`;
    await interaction.editReply(`📒 **${topic}** · ${count(found.count, 'message')} in ${where}\n${postableReply(summary)}`.slice(0, 2000));
  } catch (err) {
    log.warn('/recall failed', err);
    await interaction.editReply("Couldn't read the history right now. Try again in a minute.");
  }
}

/** /ledger-setup: one channel for Today's Page and big prints; optionally the recall archive. */
async function setup(interaction: ChatInputCommandInteraction<'cached'>, { daily, alerts, memory, config }: CommandDeps): Promise<void> {
  const now = Date.now();
  const notes: string[] = [];
  const archive = interaction.options.getBoolean('archive');
  if (archive !== null) {
    const deleted = memory.archive.setEnabled(interaction.guildId, archive, now);
    notes.push(
      archive
        ? `Server-wide recall is on: Ledger keeps ${RETENTION_DAYS} days of messages from channels it can read (members only ever see results from channels they can read). Worth telling the server.`
        : `Server-wide recall is off; ${count(deleted, 'stored message')} deleted.`,
    );
  }
  if (interaction.options.getBoolean('off')) {
    daily.setChannel(interaction.guildId, null, now);
    alerts.setChannel(interaction.guildId, null, now);
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: ["Ledger is off here: no Today's Page, no prints. Open questions still resolve.", ...notes].join('\n') });
    return;
  }
  const channel = interaction.options.getChannel('channel');
  if (!channel) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: notes.join('\n') || 'Pick a `channel`, or set `off: true`.' });
    return;
  }
  const me = interaction.guild.members.me;
  const needed = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];
  if (me && 'permissionsFor' in channel && !channel.permissionsFor(me)?.has(needed)) {
    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: `I can't post in <#${channel.id}>. Give Ledger View Channel, Send Messages and Embed Links there, then run this again.`,
    });
    return;
  }
  daily.setChannel(interaction.guildId, channel.id, now);
  alerts.setChannel(interaction.guildId, channel.id, now);
  const close = `${String(Math.floor(config.dailyCloseMinuteUtc / 60)).padStart(2, '0')}:${String(config.dailyCloseMinuteUtc % 60).padStart(2, '0')}`;
  await interaction.reply({
    flags: MessageFlags.Ephemeral,
    content: [
      `📒 Ledger channel: <#${channel.id}>. Today's Page posts there within a minute, then every day at ${close} UTC. Big prints (at most 2 a day) post there too. Nobody gets pinged.`,
      ...notes,
    ].join('\n'),
  });
}

async function stats(interaction: ChatInputCommandInteraction<'cached'>, { metrics, spend, config, desk }: CommandDeps): Promise<void> {
  const h = metrics.habit(interaction.guildId);
  const members = interaction.guild.memberCount;
  const now = Date.now();
  const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : '0%');
  await interaction.reply({
    flags: MessageFlags.Ephemeral,
    content: [
      '📒 **Ledger stats** · last 7 days',
      `**${h.weekActive} of ${members} members** used Ledger (${pct(h.weekActive, members)}) · returning (3+ of 8 days): **${h.returning}** · using 2+ parts (calls/answers, tape, watchlist, memory): **${h.multiPillar}**`,
      `Page opens ${h.pageOpens} · answers ${h.answers} · calls ${h.callsLocked} · agree/disagree ${h.leans} · watches added ${h.watchAdds} · button taps ${h.buttons}`,
      `Chat: ${count(h.chatMessages, 'message')}, ${h.chatWithTools} with tools · 30-day actives ${h.monthActive} · DAU/MAU ${pct(h.avgDailyActive, h.monthActive)}`,
      `DeepSeek: $${spend.since(now - 7 * DAY).toFixed(3)} this week (cap $${config.guards.dailyBudgetUsd.toFixed(2)}/day) · $${spend.since(0).toFixed(3)} all time` +
        (desk ? ` · SoSoValue: ${desk.requestsThisMonth.toLocaleString('en-US')} requests this month since restart` : ''),
    ].join('\n'),
  });
}

async function voidCall(interaction: ChatInputCommandInteraction<'cached'>, { board }: CommandDeps): Promise<void> {
  const id = interaction.options.getInteger('call', true);
  const reason = interaction.options.getString('reason', true);
  const call = board.get(id);
  if (!call || call.guildId !== interaction.guildId) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: `No call #${id} on this server.` });
    return;
  }
  if (!board.void(id, reason, Date.now())) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: `Call #${id} is ${call.status}; nothing to void.` });
    return;
  }
  await refreshCard(interaction.client, board, id);
  await interaction.reply({ flags: MessageFlags.Ephemeral, content: `Call #${id} voided. Every position on it is back to zero.` });
}
