import { type ButtonInteraction, type Client, MessageFlags } from 'discord.js';
import { CHART_NAME, type Charts } from '../charts/maker.js';
import { log } from '../log.js';
import type { Members } from '../members.js';
import type { Metrics } from '../metrics.js';
import type { Measure, Verdict } from '../theses/measure.js';
import { held } from '../theses/spec.js';
import type { ThesisStore } from '../theses/store.js';
import { pageRow } from './pageCards.js';
import { parseThesisButtonId, progressText, thesisCard, verdictPost } from './thesisCards.js';
import { rebuilding } from './ui.js';

export interface ThesisButtonDeps {
  theses: ThesisStore;
  measure: Measure;
  members: Members;
  metrics: Metrics;
  charts?: Charts;
}

/** Log it / Not now on a stress test; I'm with you / I'm against / How's it doing? on a thesis. */
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
  // The card rebuilt in place, its chart re-attached.
  const refresh = () => rebuilding(interaction.message, CHART_NAME, (chart) => thesisCard(theses.get(t.id)!, theses.sides(t.id), { chart }));

  switch (parsed.action) {
    case 'log': {
      if (interaction.user.id !== t.authorId) {
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
      if (interaction.user.id !== t.authorId) {
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
      await interaction.reply({ flags: MessageFlags.Ephemeral, content: reply, components: outcome === 'ok' || outcome === 'switched' ? [pageRow(t.guildId)] : [] });
      if (outcome === 'ok' || outcome === 'switched') {
        await interaction.message.edit(refresh()).catch((err) => log.warn(`Couldn't update thesis #${t.id}`, err));
      }
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
  }
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
