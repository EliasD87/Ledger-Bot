import { ActionRowBuilder, type BaseMessageOptions, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { type Choice, DAILY_POINTS, dayLabel } from '../daily/questions.js';
import type { Question, QuestionStatus } from '../daily/store.js';
import { discordTime } from '../format.js';

const COLOR: Record<QuestionStatus, number> = { open: 0xf1c40f, closed: 0x5865f2, resolved: 0x2ecc71, void: 0x95a5a6 };
const TITLE_PREFIX = '📒 Question for';

export function dailyButtonId(choice: Choice, questionId: number): string {
  return `daily:${choice}:${questionId}`;
}

export function parseDailyButtonId(customId: string): { choice: Choice; questionId: number } | null {
  const match = /^daily:(a|b):(\d+)$/.exec(customId);
  return match ? { choice: match[1] as Choice, questionId: Number(match[2]) } : null;
}

export function isDailyEmbedTitle(title: string | null | undefined): boolean {
  return !!title?.startsWith(TITLE_PREFIX);
}

/** The question card: the question, how many have answered, and its buttons while answers are open. */
export function questionCard(q: Question, counts: { a: number; b: number }): { embed: EmbedBuilder; components: BaseMessageOptions['components'] } {
  const { spec } = q;
  const [optA, optB] = spec.options;
  const total = counts.a + counts.b;
  const embed = new EmbedBuilder()
    .setColor(COLOR[q.status])
    .setTitle(`${TITLE_PREFIX} ${dayLabel(spec.day)}`)
    .setDescription(`**${spec.prompt}**\n${spec.detail}`);

  switch (q.status) {
    case 'open':
      embed.addFields(
        { name: 'Answers close', value: `${discordTime(q.closesAt)} (${discordTime(q.closesAt, 'R')})`, inline: true },
        { name: 'Answered', value: String(total), inline: true },
      );
      break;
    case 'closed':
      embed.addFields(
        { name: 'Answers', value: `${optA}: ${counts.a} · ${optB}: ${counts.b}`, inline: true },
        {
          name: 'Result',
          value: spec.windowEnd ? `Measuring until ${discordTime(spec.windowEnd, 't')}.` : "Waiting for SoSoValue's flow numbers.",
          inline: true,
        },
      );
      break;
    case 'resolved': {
      const answer = q.answer === 'a' ? optA : optB;
      const right = q.answer === 'a' ? counts.a : counts.b;
      embed.addFields(
        { name: 'Answer', value: `**${answer}**. ${q.resultText ?? ''}` },
        { name: 'Got it right', value: `${right} of ${total}${right ? ` (+${DAILY_POINTS} each)` : ''}`, inline: true },
      );
      break;
    }
    case 'void':
      embed.addFields({ name: 'No answer', value: q.resultText ?? 'Voided. No points either way.' });
      break;
  }
  embed.setFooter({ text: `One tap. Right answers earn ${DAILY_POINTS} points on the leaderboard. Points are reputation, not money.` });

  if (q.status !== 'open') return { embed, components: [] };
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(dailyButtonId('a', q.id)).setLabel(optA).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(dailyButtonId('b', q.id)).setLabel(optB).setStyle(ButtonStyle.Primary),
  );
  return { embed, components: [row] };
}
