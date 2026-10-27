import type { Charts } from '../charts/maker.js';
import { type ButtonInteraction, type ChannelSelectMenuInteraction, type ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import type { Config } from '../config.js';
import type { ChatModel } from '../llm/deepseek.js';
import type { Spend } from '../llm/guards.js';
import { log } from '../log.js';
import { summarize } from '../memory/summarize.js';
import type { Metrics } from '../metrics.js';
import { type PageDeps, buildMyPage } from '../pages/myPage.js';
import { count, discordTime } from '../format.js';
import type { ServerMemory } from './memory.js';
import type { Members } from '../members.js';
import { howItWorks, myPageMessage, parsePageButtonId } from './pageCards.js';
import { recordContainer } from './thesisCards.js';
import { cards, privateCards, replyWithCards } from './ui.js';
import { postableReply } from './text.js';

export interface PageInteractionDeps extends PageDeps {
  members: Members;
  memory: ServerMemory;
  llm: ChatModel;
  spend: Spend;
  config: Config;
  metrics: Metrics;
  charts?: Charts;
}

type Opener = ButtonInteraction | ChatInputCommandInteraction;

/** Opens Your Page for the member, privately. Works from a DM button too, for members of that server. */
export async function showMyPage(interaction: Opener, deps: PageInteractionDeps, guildId: string, source: string): Promise<void> {
  if (!guildId) return;
  if (!interaction.inGuild()) {
    const guild = interaction.client.guilds.cache.get(guildId);
    const member = guild && (await guild.members.fetch(interaction.user.id).catch(() => null));
    if (!member) {
      await interaction.reply({ content: "You're not in that server any more." });
      return;
    }
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const page = await buildMyPage(deps, guildId, interaction.user.id, Date.now());
  deps.metrics.record({ type: 'page_open', guildId, channelId: interaction.channelId, userId: interaction.user.id, meta: { pillar: 'takes', source } });
  await replyWithCards(interaction, myPageMessage(page, guildId, interaction.inGuild()), { ephemeral: true });
}

/** [My takes], [My record], [How it works] and the catch-up channel picker. */
export async function handlePageInteraction(interaction: ButtonInteraction | ChannelSelectMenuInteraction, deps: PageInteractionDeps): Promise<void> {
  const parsed = parsePageButtonId(interaction.customId);
  if (!parsed) return;
  const guildId = parsed.guildId || interaction.guildId || '';

  if (parsed.action === 'me' && interaction.isButton()) return showMyPage(interaction, deps, guildId, 'button');

  if (parsed.action === 'how') {
    await interaction.reply(howItWorks());
    return;
  }

  if (parsed.action === 'record') {
    const name = interaction.member && 'displayName' in interaction.member ? interaction.member.displayName : interaction.user.displayName;
    const record = deps.theses.record(guildId, interaction.user.id);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const chart = await deps.charts?.form(name, record.form).catch(() => null);
    await replyWithCards(
      interaction,
      { ...cards([recordContainer(name, record, { chart: !!chart })]), files: chart ? [{ attachment: chart.data, name: chart.name }] : [] },
      { ephemeral: true },
    );
    return;
  }

  if (parsed.action === 'catchup' && interaction.isChannelSelectMenu() && interaction.inGuild()) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (deps.spend.today() >= deps.config.guards.dailyBudgetUsd) {
      await interaction.editReply("That's it for today: my daily budget is spent. Try again after 00:00 UTC.");
      return;
    }
    const channelId = interaction.values[0]!;
    deps.metrics.record({ type: 'button', guildId, channelId: interaction.channelId, userId: interaction.user.id, meta: { pillar: 'memory', button: 'catchup' } });
    try {
      const found = await deps.memory.catchUp({ guildId, channelId: interaction.channelId, userId: interaction.user.id }, { channel: channelId });
      if (!found.ok) {
        await interaction.editReply(found.error);
        return;
      }
      const summary = await summarize(deps.llm, found.transcript, `Catch the member up on #${found.channelName}: ${found.count} messages they missed.`, (usage) =>
        deps.spend.record({ purpose: 'catchup', model: deps.llm.model, userId: interaction.user.id, guildId, usage }),
      );
      await interaction.editReply(`**#${found.channelName}** · ${count(found.count, 'message')} since ${discordTime(found.since, 'R')}\n${postableReply(summary)}`.slice(0, 2000));
    } catch (err) {
      log.warn('Catch-up failed', err);
      await interaction.editReply("Couldn't read that channel's history right now. Try again in a minute.");
    }
  }
}
