import { ActionRowBuilder, type ButtonBuilder, type ButtonInteraction, MessageFlags } from 'discord.js';
import type { AlertStore } from '../alerts/store.js';
import { callHeadline } from '../calls/service.js';
import type { Board } from '../calls/store.js';
import type { DailyStore } from '../daily/store.js';
import { discordTime } from '../format.js';
import type { Metrics } from '../metrics.js';
import { parseDailyButtonId } from './dailyCards.js';
import { callLink, myPageButton } from './pageCards.js';
import { watchButton } from './watchButtons.js';

/**
 * A tap on a question: records (or changes) the answer and replies with where the member stands.
 * The A/B split stays hidden until answers close, so nobody can just copy the majority.
 */
export async function handleDailyButton(
  interaction: ButtonInteraction,
  deps: { daily: DailyStore; board: Board; alerts: AlertStore; metrics: Metrics },
): Promise<void> {
  const parsed = parseDailyButtonId(interaction.customId);
  if (!parsed) return;
  const { daily, board, alerts } = deps;
  const q = daily.get(parsed.questionId);
  if (!q || !interaction.inGuild()) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: "That question isn't on the record." });
    return;
  }
  const member = interaction.member;
  board.remember(interaction.user.id, member && 'displayName' in member ? member.displayName : interaction.user.displayName);
  deps.metrics.record({
    type: 'button',
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    userId: interaction.user.id,
    meta: { pillar: 'record', button: 'answer', questionId: q.id },
  });

  const label = parsed.choice === 'a' ? q.spec.options[0] : q.spec.options[1];
  const outcome = daily.answer(q.id, interaction.user.id, parsed.choice, Date.now());
  if (outcome === 'closed') {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: `Answers closed ${discordTime(q.closesAt, 'R')}. The next question is in the latest Today's Page.` });
    return;
  }

  const { a, b } = daily.counts(q.id);
  const streak = daily.stats(interaction.guildId, interaction.user.id).streak;
  const settles = q.spec.windowEnd ? `It settles ${discordTime(q.spec.windowEnd + 60_000, 'R')}` : 'It settles when SoSoValue posts that session (T+1)';
  const myCalls = board
    .openCalls(interaction.guildId)
    .filter((c) => q.spec.assets.includes(c.base) && board.positionOf(c.id, interaction.user.id))
    .slice(0, 2)
    .map((c) => `${callLink(c)} ${callHeadline(c)}`);
  const lines = [
    `📒 ${outcome === 'changed' ? 'Changed to' : 'Entered'}: **${label}**. ${a + b} answered so far; the split shows when answers close (${discordTime(q.closesAt, 't')}).`,
    `${settles}. ${streak >= 1 ? `Streak: ${streak} day${streak === 1 ? '' : 's'} (counting today).` : ''}`,
    ...(myCalls.length ? [`Your open ${q.spec.assets.join('/')} calls: ${myCalls.join(' · ')}`] : []),
  ];

  // One tap into the watchlist for the asset this question is about, unless they already watch it.
  const asset = q.spec.assets[0]!;
  const mine = alerts.forUser(interaction.guildId, interaction.user.id);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(myPageButton(interaction.guildId));
  if (q.spec.kind === 'etf-flow' && !mine.some((x) => x.kind === 'etf-flow' && x.asset === asset)) {
    row.addComponents(watchButton({ kind: 'flows', asset }));
  } else if (q.spec.kind !== 'etf-flow' && !mine.some((x) => x.kind === 'day-move' && x.asset === asset)) {
    row.addComponents(watchButton({ kind: 'daymove', asset, percent: 5 }));
  }
  await interaction.reply({ flags: MessageFlags.Ephemeral, content: lines.join('\n'), components: [row] });
}

