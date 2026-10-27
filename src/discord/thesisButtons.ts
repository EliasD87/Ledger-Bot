import { type ButtonInteraction, ButtonBuilder, ButtonStyle, type Client, MessageFlags } from 'discord.js';
import { CHART_NAME, type ChartFile, type Charts } from '../charts/maker.js';
import type { Config } from '../config.js';
import { log } from '../log.js';
import type { Members } from '../members.js';
import type { Metrics } from '../metrics.js';
import type { Measure, Verdict } from '../theses/measure.js';
import type { Moment } from '../theses/moments.js';
import { type TakeDeps, redraftTake, sharpenTake } from '../theses/service.js';
import { type ThesisSpec, held } from '../theses/spec.js';
import type { Thesis, ThesisStore } from '../theses/store.js';
import { pageRow } from './pageCards.js';
import {
  momentPost,
  parseThesisButtonId,
  progressText,
  sharpenContainer,
  thesisButtonId,
  thesisCard,
  timeframesContainer,
  verdictPost,
} from './thesisCards.js';
import { ACCENT, card, cards, rebuilding, replacing, replyWithCards, row } from './ui.js';

export interface ThesisButtonDeps {
  theses: ThesisStore;
  measure: Measure;
  members: Members;
  metrics: Metrics;
  charts?: Charts;
  /** The stress-test pipeline, for other timeframes and sharper versions. */
  take?: TakeDeps;
  config?: Config;
}

/** Sharper versions offered but not tested yet, by thesis; kept for half an hour. */
const proposals = new Map<number, { spec: ThesisSpec; claim: string; at: number }>();
const PROPOSAL_TTL = 30 * 60_000;

const note = (text: string) => cards([card(ACCENT.amber, [text])]);
const daysLabel = (d: number) => (d % 30 === 0 && d >= 30 ? (d === 30 ? '1 month' : `${d / 30} months`) : d % 7 === 0 ? (d === 7 ? '1 week' : `${d / 7} weeks`) : `${d} days`);

/**
 * Buttons on a stress test (Log it, Other timeframes, Make it sharper, Not now) and on a thesis (I'm with
 * you, I'm against, How's it doing?), plus the private follow-ups (Use 1 month, Test this version, duel).
 */
export async function handleThesisButton(interaction: ButtonInteraction, deps: ThesisButtonDeps): Promise<void> {
  const parsed = parseThesisButtonId(interaction.customId);
  if (!parsed) return;
  const { theses } = deps;
  const t = theses.get(parsed.id);
  if (!t) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: "That take isn't on the record." });
    return;
  }
  const member = interaction.member;
  deps.members.remember(interaction.user.id, member && 'displayName' in member ? member.displayName : interaction.user.displayName);
  deps.metrics.record({
    type: 'button',
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    userId: interaction.user.id,
    meta: { pillar: 'takes', button: parsed.action, thesisId: t.id },
  });
  const now = Date.now();
  const isAuthor = interaction.user.id === t.authorId;
  // The card rebuilt in place, its chart re-attached.
  const refresh = () => rebuilding(interaction.message, CHART_NAME, (chart) => thesisCard(theses.get(t.id)!, theses.sides(t.id), { chart }));
  const overBudget = () => !!deps.config && !!deps.take && deps.take.spend.today() >= deps.config.guards.dailyBudgetUsd;

  switch (parsed.action) {
    case 'log': {
      if (!isAuthor) {
        await interaction.reply({ flags: MessageFlags.Ephemeral, content: `Only <@${t.authorId}> can put their take on the record. Bring your own: @Ledger and say what you think.` });
        return;
      }
      if (t.status !== 'draft') {
        await interaction.reply({ flags: MessageFlags.Ephemeral, content: `This one is already ${t.status === 'open' ? 'on the record' : 'closed'}.` });
        return;
      }
      await interaction.deferUpdate();
      // Measured from the moment it's logged, not when it was stress-tested.
      const start = t.spec.kind === 'flows' ? 0 : await deps.measure.now(t.spec).catch(() => null);
      if (start === null || !theses.log(t.id, start, now)) {
        await interaction.followUp({ flags: MessageFlags.Ephemeral, content: "Couldn't read the price to log it from. Try again in a minute." });
        return;
      }
      await interaction.editReply(refresh());
      return;
    }
    case 'drop': {
      if (!isAuthor) {
        await interaction.reply({ flags: MessageFlags.Ephemeral, content: `That's <@${t.authorId}>'s call to make.` });
        return;
      }
      theses.cancel(t.id, 'not logged');
      await interaction.update(refresh());
      return;
    }
    case 'with':
    case 'against': {
      const outcome = theses.side(t.id, interaction.user.id, parsed.action, now);
      const reply = {
        ok: `You're ${parsed.action === 'with' ? 'with' : 'against'} <@${t.authorId}> on #${t.id}. It counts on your record when it's checked.`,
        switched: `Switched: you're now ${parsed.action === 'with' ? 'with' : 'against'} <@${t.authorId}> on #${t.id}.`,
        same: `You're already ${parsed.action === 'with' ? 'with' : 'against'} this one.`,
        own: "It's your take; you're with it by definition.",
        closed: 'This one is closed.',
      }[outcome];
      // Against an open take nobody has challenged yet: offer to make it a duel.
      const duel =
        parsed.action === 'against' && outcome !== 'own' && outcome !== 'closed' && !t.challengerId
          ? [
              new ButtonBuilder()
                .setCustomId(thesisButtonId('duel', t.id))
                .setLabel(`Make it a duel with ${deps.members.nameOf(t.authorId).slice(0, 40)}`)
                .setStyle(ButtonStyle.Secondary),
            ]
          : [];
      const buttons = outcome === 'ok' || outcome === 'switched' || duel.length ? [row(...duel, ...pageRow(t.guildId).components)] : [];
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: duel.length ? `${reply}\n-# A duel puts you head to head: one check-back settles it, and it goes on both your records.` : reply,
        components: buttons,
      });
      if (outcome === 'ok' || outcome === 'switched') {
        await interaction.message.edit(refresh()).catch((err) => log.warn(`Couldn't update thesis #${t.id}`, err));
      }
      return;
    }
    case 'duel': {
      const outcome = theses.challenge(t.id, interaction.user.id, now);
      const reply = {
        ok: `⚔️ It's a duel: you against <@${t.authorId}> on #${t.id}. The check-back settles it.`,
        own: "You can't duel your own take.",
        taken: `Someone already took #${t.id} on. You're on the record as against it.`,
        closed: 'This one is closed.',
        already: "You're already in this duel.",
      }[outcome];
      await interaction.update({ content: reply, components: [] });
      if (outcome === 'ok') await updateCard(interaction.client, theses, t.id);
      return;
    }
    case 'progress': {
      if (t.status !== 'open') {
        await interaction.reply({ flags: MessageFlags.Ephemeral, content: t.status === 'draft' ? 'Not on the record yet.' : 'This one has been checked already.' });
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const value = await deps.measure.now(t.spec, t.startAt ?? 0).catch(() => null);
      const holding = value === null ? null : held(t.spec, t.startValue ?? 0, value);
      const chart = value === null ? null : await deps.charts?.progress(t, value, now).catch(() => null);
      await interaction.editReply({ content: progressText(t, now, value, holding), files: chart ? [{ attachment: chart.data, name: chart.name }] : [] });
      return;
    }
    case 'timeframes': {
      if (t.status !== 'draft' || !deps.take) {
        await interaction.reply({ flags: MessageFlags.Ephemeral, content: 'Timeframes can only change before a take is logged.' });
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const table = await deps.take.evidence.timeframes(t.spec, [7, 30, 90, 180, t.spec.horizonDays]).catch(() => ({ error: "Couldn't read the history right now." }));
      if ('error' in table) {
        await interaction.editReply(table.error);
        return;
      }
      await replyWithCards(interaction, cards([timeframesContainer(t, table, isAuthor)]), { ephemeral: true });
      return;
    }
    case 'retime':
    case 'sharpened': {
      if (!isAuthor || !deps.take) {
        await interaction.reply({ flags: MessageFlags.Ephemeral, content: `Only <@${t.authorId}> can change their take.` });
        return;
      }
      if (t.status !== 'draft') {
        await interaction.update({ ...note('This take is already logged, so it stays as it is.'), components: note('This take is already logged, so it stays as it is.').components });
        return;
      }
      if (overBudget()) {
        await interaction.reply({ flags: MessageFlags.Ephemeral, content: "That's it for today: my daily budget is spent. Try again after 00:00 UTC." });
        return;
      }
      let spec: ThesisSpec;
      let why: string;
      if (parsed.action === 'retime') {
        const days = parsed.arg ?? t.spec.horizonDays;
        spec = { ...t.spec, horizonDays: days };
        why = `timeframe changed to ${daysLabel(days)}`;
      } else {
        const p = proposals.get(t.id);
        if (!p || now - p.at > PROPOSAL_TTL) {
          await interaction.update(note('That suggestion expired. Press Make it sharper on the card again.'));
          return;
        }
        spec = p.spec;
        why = `sharpened from: ${t.claim}`;
      }
      await interaction.update(note(`Re-testing it as **${parsed.action === 'retime' ? `${t.claim.replace(/ (in|over) .+$/, '')} over ${daysLabel(spec.horizonDays)}` : proposals.get(t.id)!.claim}**… about half a minute.`));
      const result = await redraftTake(deps.take, t, deps.members.nameOf(t.authorId), spec, why).catch((err: unknown) => {
        log.warn(`Re-testing thesis #${t.id} failed`, err);
        return { ok: false as const, reason: 'failed' as const, message: "Couldn't re-test it right now. Try again in a minute." };
      });
      if (!result.ok) {
        await interaction.editReply(note(result.message));
        return;
      }
      proposals.delete(t.id);
      await updateCard(interaction.client, theses, t.id, result.chart);
      await interaction.editReply(note(`Done: your card now tests **${result.thesis.claim}**. Log it from the card when you're happy with it.`));
      return;
    }
    case 'sharpen': {
      if (!isAuthor || !deps.take) {
        await interaction.reply({ flags: MessageFlags.Ephemeral, content: `Only <@${t.authorId}> can sharpen their take. Bring your own: @Ledger and say what you think.` });
        return;
      }
      if (t.status !== 'draft') {
        await interaction.reply({ flags: MessageFlags.Ephemeral, content: 'This take is already logged, so it stays as it is.' });
        return;
      }
      if (overBudget()) {
        await interaction.reply({ flags: MessageFlags.Ephemeral, content: "That's it for today: my daily budget is spent. Try again after 00:00 UTC." });
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const proposal = await sharpenTake(deps.take, t).catch(() => ({ error: "Couldn't come up with a sharper version right now." }));
      if ('error' in proposal) {
        await interaction.editReply(proposal.error);
        return;
      }
      proposals.set(t.id, { spec: proposal.spec, claim: proposal.claim, at: now });
      await replyWithCards(interaction, cards([sharpenContainer(t, proposal)]), { ephemeral: true });
      return;
    }
  }
}

/**
 * Rebuilds a thesis card in place from the store: with a new chart if one is given (a re-test), else
 * keeping the one it has.
 */
async function updateCard(client: Client, theses: ThesisStore, id: number, chart?: ChartFile | null): Promise<void> {
  const t = theses.get(id);
  if (!t?.messageId) return;
  const channel = await client.channels.fetch(t.channelId).catch(() => null);
  const message = channel?.isTextBased() ? await channel.messages.fetch(t.messageId).catch(() => null) : null;
  if (!message) return;
  const sides = theses.sides(id);
  const payload =
    chart !== undefined
      ? { ...replacing(message, thesisCard(t, sides, { chart: !!chart })), files: chart ? [{ attachment: chart.data, name: chart.name }] : [], attachments: [] }
      : rebuilding(message, CHART_NAME, (has) => thesisCard(t, sides, { chart: has }));
  await message.edit(payload).catch((err) => log.warn(`Couldn't update thesis #${id}`, err));
}

/** Posts each check-back as a reply to its thesis card, and updates the card to its result. */
export async function announceVerdicts(client: Client, theses: ThesisStore, verdicts: Verdict[], charts?: Charts): Promise<void> {
  for (const v of verdicts) {
    const t = v.thesis;
    try {
      const channel = await client.channels.fetch(t.channelId);
      if (!channel?.isSendable() || !channel.isTextBased()) continue;
      const sides = theses.sides(t.id);
      if (t.messageId) {
        const message = await channel.messages.fetch(t.messageId).catch(() => null);
        if (message) await message.edit(rebuilding(message, CHART_NAME, (chart) => thesisCard(t, sides, { chart }))).catch(() => {});
      }
      const chart = await charts?.verdict(t, v.endValue, v.held).catch(() => null);
      await channel.send({
        ...verdictPost(v, sides, { chart: !!chart }),
        files: chart ? [{ attachment: chart.data, name: chart.name }] : [],
        ...(t.messageId ? { reply: { messageReference: t.messageId, failIfNotExists: false } } : {}),
      });
    } catch (err) {
      log.warn(`Couldn't post the check-back for thesis #${t.id}`, err);
    }
  }
}

/** Posts mid-take moments (target reached, given back, under pressure) as replies to their thesis cards. */
export async function announceMoments(client: Client, moments: Moment[]): Promise<void> {
  for (const m of moments) {
    const t: Thesis = m.thesis;
    try {
      const channel = await client.channels.fetch(t.channelId);
      if (!channel?.isSendable()) continue;
      await channel.send({
        ...momentPost(t, m.kind, m.value, Date.now()),
        ...(t.messageId ? { reply: { messageReference: t.messageId, failIfNotExists: false } } : {}),
      });
    } catch (err) {
      log.warn(`Couldn't post a moment for thesis #${t.id}`, err);
    }
  }
}

/** Stress tests nobody logged within a day lose their buttons. */
export async function expireDrafts(client: Client, theses: ThesisStore, now: number): Promise<void> {
  for (const t of theses.staleDrafts(now - 24 * 3_600_000)) {
    if (!theses.cancel(t.id, 'not logged within a day') || !t.messageId) continue;
    try {
      const channel = await client.channels.fetch(t.channelId);
      if (!channel?.isTextBased()) continue;
      const message = await channel.messages.fetch(t.messageId);
      await message.edit(rebuilding(message, CHART_NAME, (chart) => thesisCard(theses.get(t.id)!, theses.sides(t.id), { chart })));
    } catch {
      // The message is gone or out of reach; the record is already updated.
    }
  }
}
