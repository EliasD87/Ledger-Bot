import { type ButtonInteraction, type Client, MessageFlags } from 'discord.js';
import type { Charts } from '../charts/maker.js';
import { leaderboard } from '../daily/board.js';
import { LEDGER_ID, iso } from '../daily/rules.js';
import type { DayEvent, DayRunner } from '../daily/runner.js';
import type { BoardRow, DayQuestion, DayStore } from '../daily/store.js';
import { log } from '../log.js';
import type { Members } from '../members.js';
import type { Metrics } from '../metrics.js';
import { boardContainer, parseDayButtonId, questionContainer, resultText, rightLine, side } from './dailyCards.js';
import { cards, replyWithCards } from './ui.js';

export interface DayDeps {
  days: DayStore;
  runner: DayRunner;
  members: Members;
  metrics: Metrics;
  charts?: Charts;
}

/** The leaderboard image: the top ten members, plus Ledger wherever it sits. */
async function boardImage(deps: DayDeps, title: string, rows: BoardRow[]) {
  if (!deps.charts || !rows.some((r) => r.userId !== LEDGER_ID)) return null;
  const top = rows.filter((r) => r.userId !== LEDGER_ID).slice(0, 10);
  const ledger = rows.find((r) => r.userId === LEDGER_ID);
  const shown = ledger ? [...top, ledger].sort((a, b) => b.score - a.score) : top;
  return deps.charts
    .board({
      title: `Leaderboard · ${title}`,
      subtitle: 'Question of the day. Hard calls count more. Ledger plays too.',
      rows: shown.map((r) => ({
        label: r.userId === LEDGER_ID ? 'Ledger' : deps.members.nameOf(r.userId),
        score: r.score,
        detail: `${r.right}/${r.played} right`,
        highlight: r.userId === LEDGER_ID,
      })),
    })
    .catch(() => null);
}

/** The leaderboard card with its image. */
export async function leaderboardPayload(deps: DayDeps, guildId: string, now: number, opts: { allTime?: boolean; viewer?: string } = {}) {
  const { title, rows } = leaderboard(deps.days, guildId, now, opts.allTime);
  const chart = await boardImage(deps, title, rows);
  const viewer = opts.viewer ? { userId: opts.viewer, streak: deps.days.streak(guildId, opts.viewer) } : undefined;
  return { ...cards([boardContainer(title, rows, { chart: !!chart, viewer })]), files: chart ? [{ attachment: chart.data, name: chart.name }] : [] };
}

/** "Yesterday: BTC closes higher today. It happened; 9 of 15 got it right." */
function yesterdayLine(days: DayStore, q: DayQuestion): string | undefined {
  const prev = days.lastSettled(q.guildId, q.day);
  if (!prev || prev.day < iso(Date.parse(`${q.day}T00:00:00Z`) - 3 * 86_400_000)) return undefined;
  return `Last time: "${prev.rule.text.en}". Result: ${resultText(prev)}${prev.status === 'settled' ? `; ${rightLine(prev, days.votes(prev.id))}` : ''}.`;
}

function payload(days: DayStore, q: DayQuestion, now: number) {
  return cards([questionContainer(q, days.votes(q.id), now, { yesterday: q.status === 'open' ? yesterdayLine(days, q) : undefined })]);
}

/** Posts a question in its channel and remembers the message. Returns its link. */
export async function postQuestion(client: Client, deps: DayDeps, q: DayQuestion): Promise<string | null> {
  const channel = await client.channels.fetch(q.channelId).catch(() => null);
  if (!channel?.isSendable()) {
    log.warn(`Question ${q.id}: can't post in channel ${q.channelId}`);
    return null;
  }
  const sent = await channel.send(payload(deps.days, q, Date.now())).catch((err: unknown) => (log.warn('Question post failed', err), null));
  if (sent) deps.days.attachMessage(q.id, sent.id);
  return sent?.url ?? null;
}

/** Brings a question's card up to date (votes so far, locked, result). */
async function refresh(client: Client, deps: DayDeps, q: DayQuestion): Promise<void> {
  if (!q.messageId) return;
  const channel = await client.channels.fetch(q.channelId).catch(() => null);
  const message = channel?.isTextBased() ? await channel.messages.fetch(q.messageId).catch(() => null) : null;
  await message?.edit(payload(deps.days, q, Date.now())).catch((err: unknown) => log.warn('Question edit failed', err));
}

/** Runs the question of the day's clock and posts or updates what changed. */
export async function runDaily(client: Client, deps: DayDeps): Promise<void> {
  const events = await deps.runner.tick().catch((err: unknown) => (log.warn('Question tick failed', err), [] as DayEvent[]));
  for (const ev of events) {
    if (ev.kind === 'opened') await postQuestion(client, deps, ev.question);
    else await refresh(client, deps, ev.question);
  }
}

/** With, Against and Leaderboard. */
export async function handleDayButton(interaction: ButtonInteraction, deps: DayDeps): Promise<void> {
  const parsed = parseDayButtonId(interaction.customId);
  if (!parsed || !interaction.inGuild()) return;
  const now = Date.now();
  const member = interaction.member;
  deps.members.remember(interaction.user.id, member && 'displayName' in member ? member.displayName : interaction.user.displayName);
  deps.metrics.record({
    type: 'button',
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    userId: interaction.user.id,
    meta: { pillar: 'question', button: parsed.action },
  });

  if (parsed.action === 'board') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await replyWithCards(interaction, await leaderboardPayload(deps, interaction.guildId, now, { viewer: interaction.user.id }), { ephemeral: true });
    return;
  }

  const q = deps.days.get(Number(parsed.id));
  if (!q || q.guildId !== interaction.guildId) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: "That question isn't around any more." });
    return;
  }
  const value = parsed.action === 'with' ? 1 : 0;
  const result = deps.days.vote(q.id, interaction.user.id, value, now);
  const lock = `${new Date(q.closesAt).toISOString().slice(11, 16)} UTC`;
  await interaction.reply({
    flags: MessageFlags.Ephemeral,
    content:
      result === 'closed'
        ? 'Votes on this one are locked. The next question comes at 03:00 UTC.'
        : result === 'changed'
          ? `Switched: you're **${side(value)}** now. You can change it until ${lock}.`
          : result === 'same'
            ? `You're already **${side(value)}**. You can change it until ${lock}.`
            : `You're **${side(value)}**. You can change it until ${lock}; Ledger's side shows when votes lock.`,
  });
  // A new voter: the card's count goes up.
  if (result === 'ok') void refresh(interaction.client, deps, deps.days.get(q.id)!);
}
