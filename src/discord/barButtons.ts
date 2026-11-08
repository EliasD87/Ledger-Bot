import { type ButtonInteraction, type Client, MessageFlags } from 'discord.js';
import { chartTitle, specOf } from '../bar/questions.js';
import type { BarEvent, BarRunner } from '../bar/runner.js';
import type { BarQuestion, BarStore } from '../bar/store.js';
import { BAR_IMAGE, type Charts } from '../charts/maker.js';
import { discordTime } from '../format.js';
import type { Lang } from '../lang.js';
import { log } from '../log.js';
import type { Members } from '../members.js';
import type { Metrics } from '../metrics.js';
import { barQuestionContainer, barResultContainer, barWords, parseBarButtonId } from './barCards.js';
import { cards, rebuilding } from './ui.js';

export interface BarDeps {
  bar: BarStore;
  runner: BarRunner;
  members: Members;
  metrics: Metrics;
  charts?: Charts;
}

/** Posts a question in its channel with its chart, and remembers the message. Returns its link. */
export async function postBarQuestion(client: Client, deps: BarDeps, q: BarQuestion): Promise<string | null> {
  const channel = await client.channels.fetch(q.channelId).catch(() => null);
  if (!channel?.isSendable()) {
    log.warn(`Bar question ${q.id}: can't post in channel ${q.channelId}`);
    return null;
  }
  const w = barWords(q.lang);
  const chart = await deps.charts?.barQuestion(specOf(q.rule), chartTitle(q.rule, q.lang), w.chartResult, q.lang).catch(() => null);
  // Big scheduled releases today (CPI, FOMC, jobs): named on the card and marked on the chart.
  const events = ((await deps.charts?.runwayEvents(q.opensAt, q.opensAt).catch(() => [])) ?? []).map((e) => e.label.split(' ')[0]!);
  const sent = await channel
    .send({ ...cards([barQuestionContainer(q, [], { chart: !!chart, events, headline: deps.bar.headline(q.day) })]), files: chart ? [{ attachment: chart.data, name: chart.name }] : [] })
    .catch((err: unknown) => (log.warn('Bar question post failed', err), null));
  if (sent) deps.bar.attachMessage(q.id, sent.id);
  return sent?.url ?? null;
}

/** Brings a question's card up to date (answers so far, closed, result), keeping its chart. */
async function refresh(client: Client, deps: BarDeps, q: BarQuestion): Promise<void> {
  if (!q.messageId) return;
  const channel = await client.channels.fetch(q.channelId).catch(() => null);
  const message = channel?.isTextBased() ? await channel.messages.fetch(q.messageId).catch(() => null) : null;
  if (!message) return;
  const votes = deps.bar.votes(q.id);
  await message
    .edit(rebuilding(message, BAR_IMAGE, (chart) => cards([barQuestionContainer(q, votes, { chart })])))
    .catch((err: unknown) => log.warn('Bar question edit failed', err));
}

/** The result as its own message, a reply to the question, naming who read it right and who missed. Pings nobody. */
async function postResult(client: Client, deps: BarDeps, q: BarQuestion): Promise<void> {
  const channel = await client.channels.fetch(q.channelId).catch(() => null);
  if (!channel?.isSendable()) return;
  const payload = cards([barResultContainer(q, deps.bar.votes(q.id))]);
  await channel
    .send(q.messageId ? { ...payload, reply: { messageReference: q.messageId, failIfNotExists: false } } : payload)
    .catch((err: unknown) => log.warn('Bar result post failed', err));
}

/**
 * The channels that get the bar question without anyone turning it on: each server's chat channels by
 * name, in their language. An admin can still turn one off (or another one on) with /ledger-bar.
 */
export const DEFAULT_BAR_CHANNELS: { [name: string]: Lang } = {
  'general-chat': 'en',
  'general-chat-portuguese': 'pt',
  'general-chat-中文': 'zh',
  'general-chat-日本語': 'ja',
};

export function defaultChannels(client: Client) {
  return [...client.guilds.cache.values()].flatMap((g) =>
    [...g.channels.cache.values()].flatMap((c) => {
      const lang = DEFAULT_BAR_CHANNELS[c.name];
      return lang && c.isTextBased() ? [{ guildId: g.id, channelId: c.id, lang }] : [];
    }),
  );
}

/** Runs the bar question's clock and posts or updates what changed. */
export async function runBar(client: Client, deps: BarDeps): Promise<void> {
  const events = await deps.runner.tick(defaultChannels(client)).catch((err: unknown) => (log.warn('Bar question tick failed', err), [] as BarEvent[]));
  for (const ev of events) {
    if (ev.kind === 'opened') await postBarQuestion(client, deps, ev.question);
    else await refresh(client, deps, ev.question);
    if (ev.kind === 'settled') await postResult(client, deps, ev.question);
  }
}

/** With and Against. The answer is private; the card's count goes up. */
export async function handleBarButton(interaction: ButtonInteraction, deps: BarDeps): Promise<void> {
  const parsed = parseBarButtonId(interaction.customId);
  if (!parsed || !interaction.inGuild()) return;
  const now = Date.now();
  const member = interaction.member;
  deps.members.remember(interaction.user.id, member && 'displayName' in member ? member.displayName : interaction.user.displayName);
  deps.metrics.record({
    type: 'button',
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    userId: interaction.user.id,
    meta: { pillar: 'bar', button: parsed.action },
  });
  const q = deps.bar.get(parsed.id);
  if (!q || q.guildId !== interaction.guildId) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: "That question isn't around any more." });
    return;
  }
  const w = barWords(q.lang);
  const value = parsed.action === 'with' ? 1 : 0;
  const result = deps.bar.vote(q.id, interaction.user.id, value, now);
  const side = w.side(value);
  const until = w.until(discordTime(q.closesAt, 't'));
  await interaction.reply({
    flags: MessageFlags.Ephemeral,
    content: result === 'closed' ? w.locked : `${result === 'changed' ? w.switched(side) : result === 'same' ? w.same(side) : w.voted(side)} ${until}`,
  });
  if (result === 'ok') void refresh(interaction.client, deps, deps.bar.get(q.id)!);
}
