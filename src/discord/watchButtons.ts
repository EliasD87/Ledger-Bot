import { ActionRowBuilder, ButtonBuilder, type ButtonInteraction, ButtonStyle, MessageFlags } from 'discord.js';
import { type AlertDepsForCreate, type AlertRequest, createAlert, describeAlert } from '../alerts/service.js';
import type { Metrics } from '../metrics.js';
import { pageRow } from './pageCards.js';

/** One-tap watches offered on cards: [Watch BTC flows], [Watch SOL ±5% days], [Watch BTC buys]. */
export type WatchOffer = { kind: 'flows'; asset: string } | { kind: 'daymove'; asset: string; percent: number } | { kind: 'buys' };

export function watchButtonId(offer: WatchOffer): string {
  return offer.kind === 'flows' ? `watch:flows:${offer.asset}` : offer.kind === 'daymove' ? `watch:daymove:${offer.asset}:${offer.percent}` : 'watch:buys';
}

export function watchStopId(alertId: number): string {
  return `watch:stop:${alertId}`;
}

export function watchButton(offer: WatchOffer): ButtonBuilder {
  const label = offer.kind === 'flows' ? `Watch ${offer.asset} flows` : offer.kind === 'daymove' ? `Watch ${offer.asset} ±${offer.percent}% days` : 'Watch BTC buys';
  return new ButtonBuilder().setCustomId(watchButtonId(offer)).setLabel(label).setEmoji('🔔').setStyle(ButtonStyle.Secondary);
}

/** Taps on watch buttons: start a repeating watch, or stop one (from a DM). */
export async function handleWatchButton(interaction: ButtonInteraction, deps: AlertDepsForCreate & { metrics: Metrics }): Promise<void> {
  const [, action, asset, extra] = interaction.customId.split(':');
  if (action === 'stop') {
    const id = Number(asset);
    const alert = deps.store.get(id);
    const ok = deps.store.cancel(id, interaction.user.id);
    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: ok && alert ? `Stopped: ${describeAlert(alert).replace(/^Alert #\d+: /, '')}.` : 'That watch is already off.',
    });
    return;
  }
  if (!interaction.inGuild()) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: 'Use this button in the server.' });
    return;
  }

  const request: AlertRequest | null =
    action === 'flows' && asset
      ? { kind: 'etf-flow', asset }
      : action === 'daymove' && asset
        ? { kind: 'day-move', asset, percent: Number(extra) || 5 }
        : action === 'buys'
          ? { kind: 'treasury' }
          : null;
  if (!request) return;
  deps.metrics.record({
    type: 'button',
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    userId: interaction.user.id,
    meta: { pillar: 'watch', button: interaction.customId },
  });
  const who = { guildId: interaction.guildId, channelId: interaction.channelId, userId: interaction.user.id };
  const result = await createAlert(deps, who, request, Date.now()).catch(() => ({ ok: false as const, error: "The price feed isn't answering. Try again in a minute." }));
  await interaction.reply({
    flags: MessageFlags.Ephemeral,
    content: result.ok
      ? `🔔 Watching: ${result.summary.replace(/^Alert #\d+: /, '')} Hits come by DM and show on your page.`
      : result.error,
    components: [pageRow(interaction.guildId)],
  });
}

/** A row of watch offers (at most 2) plus nothing else; callers add [My page] where it fits. */
export function watchRow(...offers: WatchOffer[]): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(...offers.slice(0, 2).map(watchButton));
}
