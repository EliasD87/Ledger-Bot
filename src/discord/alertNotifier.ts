import { ButtonBuilder, ButtonStyle, type Client } from 'discord.js';
import { describeAlert } from '../alerts/service.js';
import type { AlertStore } from '../alerts/store.js';
import type { AlertNotifier, PersonalBatch } from '../alerts/watcher.js';
import { log } from '../log.js';
import { pageButtonId } from './pageCards.js';
import { ACCENT, card, cards, kicker, row } from './ui.js';
import { watchStopId } from './watchButtons.js';

/** Server prints allowed per server per UTC day, so the Ledger channel stays worth reading. */
export const PRINTS_PER_DAY = 2;

/**
 * Delivers watch hits by DM (one per member per check, with [My page] and [Stop]) and server prints to
 * the Ledger channel (merged, capped). Hits are never posted publicly: if a member's DMs are closed, the
 * hit is still recorded as fired and shows on their page.
 */
export class DiscordAlertNotifier implements AlertNotifier {
  constructor(
    private readonly client: Client,
    private readonly store: AlertStore,
  ) {}

  async personal(batch: PersonalBatch): Promise<void> {
    const repeating = batch.alerts.filter((a) => a.repeat);
    const buttons = row(
      new ButtonBuilder().setCustomId(pageButtonId('me', batch.guildId)).setLabel('My page').setEmoji('📒').setStyle(ButtonStyle.Secondary),
      ...(repeating.length === 1
        ? [new ButtonBuilder().setCustomId(watchStopId(repeating[0]!.id)).setLabel('Stop this watch').setStyle(ButtonStyle.Secondary)]
        : []),
    );
    const dm = cards([
      card(ACCENT.amber, [
        kicker('🔔 Your watchlist'),
        ...batch.texts.map(unbell),
        buttons,
        kicker(batch.alerts.map((a) => describeAlert(a).replace(/^Alert #(\d+): /, '#$1 ')).join(' · ').slice(0, 300)),
      ]),
    ]);
    try {
      const user = await this.client.users.fetch(batch.userId);
      await user.send(dm);
    } catch (err) {
      log.debug(`Couldn't DM ${batch.userId}; the hit waits on their page`, err);
    }
  }

  async server(texts: string[]): Promise<void> {
    const day = new Date().toISOString().slice(0, 10);
    for (const { guildId, channelId } of this.store.channels()) {
      const slot = Array.from({ length: PRINTS_PER_DAY }, (_, i) => `print:${guildId}:${day}:${i + 1}`).find((k) => !this.store.seen(k));
      if (!slot) {
        log.info(`Print cap reached in ${guildId}; skipped: ${texts[0]?.slice(0, 80)}`);
        continue;
      }
      try {
        const channel = await this.client.channels.fetch(channelId);
        if (!channel?.isSendable()) continue;
        await channel.send(cards([card(ACCENT.amber, [kicker('🔔 Ledger · on the tape'), ...texts.map(unbell)])]));
        this.store.markSeen(slot, Date.now());
      } catch (err) {
        log.warn(`Couldn't post a print in ${guildId}`, err);
      }
    }
  }
}

/** The card's kicker carries the bell; the lines don't need their own. */
function unbell(text: string): string {
  return text.replace(/^🔔\s*/, '');
}
