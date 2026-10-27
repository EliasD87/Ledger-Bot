import {
  ChannelType,
  type ChatInputCommandInteraction,
  type Interaction,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { type AlertDepsForCreate, type AlertRequest, createAlert, describeAlert } from '../alerts/service.js';
import type { AlertStore } from '../alerts/store.js';
import { CHART_NAME, type Charts } from '../charts/maker.js';
import type { Config } from '../config.js';
import { type Desk, ETF_ASSETS } from '../desk/desk.js';
import { count } from '../format.js';
import type { ChatModel } from '../llm/deepseek.js';
import type { Spend } from '../llm/guards.js';
import { log } from '../log.js';
import type { Members } from '../members.js';
import { RETENTION_DAYS } from '../memory/archive.js';
import { summarize } from '../memory/summarize.js';
import { COMMAND_PILLAR, type Metrics } from '../metrics.js';
import type { Activity } from '../pages/myPage.js';
import type { Measure } from '../theses/measure.js';
import { type TakeDeps, draftTake } from '../theses/service.js';
import type { ThesisStore } from '../theses/store.js';
import { flowsCard, macroCard, marketCard, newsCard, treasuriesCard } from './deskCards.js';
import type { ServerMemory } from './memory.js';
import { handlePageInteraction, showMyPage } from './pageButtons.js';
import { myPageButton } from './pageCards.js';
import { postableReply } from './text.js';
import { handleThesisButton } from './thesisButtons.js';
import { boardContainer, recordContainer, thesisCard } from './thesisCards.js';
import { ACCENT, card, cards, kicker, rebuilding, replyWithCards, row } from './ui.js';
import { handleWatchButton, watchButton } from './watchButtons.js';

const DAY = 24 * 60 * 60 * 1000;

const guildCommand = (name: string, description: string) =>
  new SlashCommandBuilder().setName(name).setDescription(description).setContexts(InteractionContextType.Guild);

/** The surface: takes first, then the watchlist and the tape. Everything else is a button or a sentence to @Ledger. */
export const commandData = [
  guildCommand('ledger', 'Your takes: open theses, verdicts, debates you joined, your watchlist'),
  guildCommand('take', 'Bring a take: Ledger argues it out with real data')
    .addStringOption((o) => o.setName('take').setDescription('e.g. "SOL beats ETH this month", "NVDA up 10% by December"').setRequired(true).setMaxLength(300)),
  guildCommand('takes', "Someone's record of takes, or the server's open debates")
    .addUserOption((o) => o.setName('member').setDescription('Whose record (default: the open debates)')),
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
  guildCommand('tape', 'The numbers: ETF flows, macro, BTC buys, news, market')
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
  guildCommand('recall', 'What people said about a topic (only you see it)')
    .addStringOption((o) => o.setName('topic').setDescription('e.g. SOL, the mint, airdrop').setRequired(true))
    .addIntegerOption((o) => o.setName('days').setDescription('How far back (default 7)').setMinValue(1).setMaxValue(30)),
  guildCommand('ledger-setup', "Ledger's channel for big market prints, and the recall archive (admins)")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption((o) => o.setName('channel').setDescription('Where big prints go').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
    .addBooleanOption((o) => o.setName('archive').setDescription(`Keep ${RETENTION_DAYS} days of messages for server-wide /recall`))
    .addBooleanOption((o) => o.setName('off').setDescription('Stop the prints')),
  guildCommand('ledger-admin', 'Engagement numbers, or void a thesis (admins)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) => s.setName('stats').setDescription('Habit numbers for this server'))
    .addSubcommand((s) =>
      s
        .setName('void')
        .setDescription('Void a thesis (bad data, a mistake)')
        .addIntegerOption((o) => o.setName('thesis').setDescription('Thesis number').setRequired(true).setMinValue(1))
        .addStringOption((o) => o.setName('reason').setDescription('Why, shown on the card').setRequired(true)),
    ),
].map((command) => command.toJSON());

export interface CommandDeps {
  config: Config;
  /** Ticker lookups and spot prices for the watchlist. */
  feed: AlertDepsForCreate['feed'];
  members: Members;
  theses: ThesisStore;
  take: TakeDeps;
  measure: Measure;
  /** Null without a SoSoValue key. */
  desk: Desk | null;
  alerts: AlertStore;
  memory: ServerMemory;
  activity: Activity;
  /** For /recall and catch-up summaries. */
  llm: ChatModel;
  metrics: Metrics;
  spend: Spend;
  charts?: Charts;
}

export async function handleInteraction(interaction: Interaction, deps: CommandDeps): Promise<void> {
  if (interaction.isButton() || interaction.isChannelSelectMenu()) {
    const id = interaction.customId;
    if (id.startsWith('page:')) return handlePageInteraction(interaction, deps);
    if (!interaction.isButton()) return;
    if (id.startsWith('watch:')) return handleWatchButton(interaction, { store: deps.alerts, feed: deps.feed, desk: deps.desk, metrics: deps.metrics });
    if (id.startsWith('thesis:')) return handleThesisButton(interaction, deps);
    // Buttons on cards from the old design (calls, the daily question) no longer do anything.
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: "That card is from Ledger's old design. Bring a take instead: /take or @Ledger." });
    return;
  }
  if (!interaction.isChatInputCommand() || !interaction.inCachedGuild()) return;
  deps.members.remember(interaction.user.id, interaction.member.displayName);
  deps.metrics.record({
    type: 'command',
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    userId: interaction.user.id,
    meta: { name: interaction.commandName, pillar: COMMAND_PILLAR[interaction.commandName] ?? 'chat' },
  });
  switch (interaction.commandName) {
    case 'ledger':
      return showMyPage(interaction, deps, interaction.guildId, 'command');
    case 'take':
      return take(interaction, deps);
    case 'takes':
      return takes(interaction, deps);
    case 'watch':
      return watch(interaction, deps);
    case 'tape':
      return tape(interaction, deps);
    case 'recall':
      return recall(interaction, deps);
    case 'ledger-setup':
      return setup(interaction, deps);
    case 'ledger-admin':
      return interaction.options.getSubcommand() === 'void' ? voidThesis(interaction, deps) : stats(interaction, deps);
  }
}

/** /take: the same stress test as @Ledger, posted publicly with its Log it button. */
async function take(interaction: ChatInputCommandInteraction<'cached'>, deps: CommandDeps): Promise<void> {
  if (deps.spend.today() >= deps.config.guards.dailyBudgetUsd) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: "That's it for today: my daily budget is spent. Try again after 00:00 UTC." });
    return;
  }
  await interaction.deferReply();
  const text = interaction.options.getString('take', true);
  const result = await draftTake(deps.take, { guildId: interaction.guildId, channelId: interaction.channelId, userId: interaction.user.id, name: interaction.member.displayName }, text).catch(
    (err: unknown) => {
      log.warn('/take failed', err);
      return { ok: false as const, reason: 'failed' as const, message: "Couldn't pull the data right now. Try again in a minute." };
    },
  );
  if (!result.ok) {
    await interaction.editReply(
      result.reason === 'not-a-take' ? `That doesn't read as a take on where a market goes. Try something like "SOL beats ETH this month".` : result.message,
    );
    return;
  }
  const files = result.chart ? [{ attachment: result.chart.data, name: result.chart.name }] : [];
  const message = await replyWithCards(interaction, { ...thesisCard(result.thesis, { with: [], against: [] }, { chart: files.length > 0 }), files });
  deps.theses.attachMessage(result.thesis.id, interaction.channelId, message.id);
}

/** /takes: a member's record, or the server's open debates and best records. */
async function takes(interaction: ChatInputCommandInteraction<'cached'>, { theses, members, charts }: CommandDeps): Promise<void> {
  const member = interaction.options.getMember('member');
  if (member) {
    members.remember(member.id, member.displayName);
    const record = theses.record(interaction.guildId, member.id);
    await interaction.deferReply();
    // Their recent form as a chart, when there are a couple of checked takes to draw.
    const chart = await charts?.form(member.displayName, record.form).catch(() => null);
    await replyWithCards(interaction, {
      ...cards([recordContainer(member.displayName, record, { chart: !!chart })]),
      files: chart ? [{ attachment: chart.data, name: chart.name }] : [],
    });
    return;
  }
  const open = theses.open(interaction.guildId).map((t) => ({ t, sides: theses.sides(t.id) }));
  await interaction.reply(cards([boardContainer(open, theses.leaders(interaction.guildId, 0))]));
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

/** /tape: the stored market numbers as a public card, with a one-tap watch where one fits. */
async function tape(interaction: ChatInputCommandInteraction<'cached'>, { desk, charts }: CommandDeps): Promise<void> {
  if (!desk) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: 'The tape needs a SoSoValue API key (SOSOVALUE_API_KEY).' });
    return;
  }
  const topic = interaction.options.getString('topic', true);
  const asset = interaction.options.getString('asset')?.trim().toUpperCase().replace(/^\$/, '');
  await interaction.deferReply();
  try {
    const page = myPageButton(interaction.guildId);
    let tapeCard;
    const files: { attachment: Buffer; name: string }[] = [];
    if (topic === 'flows') {
      const which = asset ?? 'BTC';
      const report = await desk.flows(which);
      const chart = report ? await charts?.flows(report.asset).catch(() => null) : null;
      if (chart) files.push({ attachment: chart.data, name: chart.name });
      tapeCard = report
        ? flowsCard(report, row(watchButton({ kind: 'flows', asset: report.asset }), page), { chart: !!chart })
        : card(ACCENT.muted, [`No US spot ETF flow data for ${which} yet.`, kicker(`Try: ${ETF_ASSETS.join(', ')}`)]);
    } else if (topic === 'macro') {
      tapeCard = macroCard(await desk.macro(), row(page));
    } else if (topic === 'buys') {
      tapeCard = treasuriesCard(desk.treasuryBuys(14), desk.treasuries.ready, 14, row(watchButton({ kind: 'buys' }), page));
    } else if (topic === 'news') {
      tapeCard = newsCard(await desk.news(asset), row(page));
    } else {
      tapeCard = marketCard(await desk.market(), row(page));
    }
    await replyWithCards(interaction, { ...cards([tapeCard]), files });
  } catch (err) {
    log.warn(`/tape ${topic} failed`, err);
    await interaction.editReply("Couldn't read the tape right now. Try again in a minute.");
  }
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
    await interaction.editReply(`**${topic}** · ${count(found.count, 'message')} in ${where}\n${postableReply(summary)}`.slice(0, 2000));
  } catch (err) {
    log.warn('/recall failed', err);
    await interaction.editReply("Couldn't read the history right now. Try again in a minute.");
  }
}

/** /ledger-setup: a channel for big market prints (at most 2 a day); optionally the recall archive. */
async function setup(interaction: ChatInputCommandInteraction<'cached'>, { alerts, memory }: CommandDeps): Promise<void> {
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
    alerts.setChannel(interaction.guildId, null, now);
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: ['Prints are off here.', ...notes].join('\n') });
    return;
  }
  const channel = interaction.options.getChannel('channel');
  if (!channel) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: notes.join('\n') || 'Pick a `channel`, or set `off: true`.' });
    return;
  }
  const me = interaction.guild.members.me;
  const needed = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];
  if (me && 'permissionsFor' in channel && !channel.permissionsFor(me)?.has(needed)) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: `I can't post in <#${channel.id}>. Give Ledger View Channel and Send Messages there, then run this again.` });
    return;
  }
  alerts.setChannel(interaction.guildId, channel.id, now);
  await interaction.reply({
    flags: MessageFlags.Ephemeral,
    content: [`Big market prints (large ETF days, big BTC buys, major macro, ±5% days) go to <#${channel.id}>, at most 2 a day. Nobody gets pinged.`, ...notes].join('\n'),
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
      '⚖️ **Ledger stats** · last 7 days',
      `**${h.weekActive} of ${members} members** used Ledger (${pct(h.weekActive, members)}) · returning (3+ of 8 days): **${h.returning}** · using 2+ parts (takes, tape, watchlist, memory): **${h.multiPillar}**`,
      `Takes stress-tested ${h.stressTests} · logged ${h.logged} · sides taken ${h.sides} · page opens ${h.pageOpens} · watches added ${h.watchAdds} · button taps ${h.buttons}`,
      `Chat: ${count(h.chatMessages, 'message')}, ${h.chatWithTools} with tools · 30-day actives ${h.monthActive} · DAU/MAU ${pct(h.avgDailyActive, h.monthActive)}`,
      `DeepSeek: $${spend.since(now - 7 * DAY).toFixed(3)} this week (cap $${config.guards.dailyBudgetUsd.toFixed(2)}/day) · $${spend.since(0).toFixed(3)} all time` +
        (desk ? ` · SoSoValue: ${desk.requestsThisMonth.toLocaleString('en-US')} of 100,000 requests this month` : ''),
    ].join('\n'),
  });
}

async function voidThesis(interaction: ChatInputCommandInteraction<'cached'>, { theses }: CommandDeps): Promise<void> {
  const id = interaction.options.getInteger('thesis', true);
  const reason = interaction.options.getString('reason', true);
  const t = theses.get(id);
  if (!t || t.guildId !== interaction.guildId) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: `No thesis #${id} on this server.` });
    return;
  }
  if (!theses.void(id, reason, Date.now())) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: `Thesis #${id} is already closed.` });
    return;
  }
  if (t.messageId) {
    const channel = await interaction.client.channels.fetch(t.channelId).catch(() => null);
    const message = channel?.isTextBased() ? await channel.messages.fetch(t.messageId).catch(() => null) : null;
    await message?.edit(rebuilding(message, CHART_NAME, (chart) => thesisCard(theses.get(id)!, theses.sides(id), { chart }))).catch(() => {});
  }
  await interaction.reply({ flags: MessageFlags.Ephemeral, content: `Thesis #${id} voided: ${reason}.` });
}
