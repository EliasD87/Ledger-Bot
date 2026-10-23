import { ActionRowBuilder, type ButtonBuilder, type Client, type Message } from 'discord.js';
import type { Board } from '../calls/store.js';
import { buildBook } from '../daily/book.js';
import type { LedgerSummary } from '../daily/ledger.js';
import type { DailyPoster } from '../daily/runner.js';
import type { DailyStore, Question } from '../daily/store.js';
import { log } from '../log.js';
import { isDailyEmbedTitle, questionCard } from './dailyCards.js';
import { todaysPageEmbed } from './deskCards.js';
import { myPageButton } from './pageCards.js';

/**
 * Posts Today's Page: one message with the page (room vs tape, the tape, calls) above the new question,
 * its answer buttons and [My page]. When a question is decided, its card is edited in place; the
 * verdict then leads the next Today's Page, so the channel never gets the same fact twice.
 */
export class DiscordDailyPoster implements DailyPoster {
  constructor(
    private readonly client: Client,
    private readonly store: DailyStore,
    private readonly board: Board,
  ) {}

  async post(q: Question, ledger: LedgerSummary | null): Promise<string | null> {
    try {
      const channel = await this.client.channels.fetch(q.channelId);
      if (!channel?.isSendable()) throw new Error(`channel ${q.channelId} is not one Ledger can post in`);
      const now = Date.now();
      const { embed, components } = questionCard(q, this.store.counts(q.id));
      const page = todaysPageEmbed(ledger, now, buildBook(this.board, this.store, q.guildId, now));
      const pageRow = new ActionRowBuilder<ButtonBuilder>().addComponents(myPageButton(q.guildId));
      const message = await channel.send({
        embeds: page ? [page, embed] : [embed],
        components: [...(components ?? []), pageRow],
        allowedMentions: { parse: [] },
      });
      return message.id;
    } catch (err) {
      log.warn(`Couldn't post Today's Page for question #${q.id}`, err);
      return null;
    }
  }

  async refresh(q: Question): Promise<void> {
    const message = await this.message(q);
    if (!message) return;
    const { embed, components } = questionCard(q, this.store.counts(q.id));
    // Keep Today's Page (if any) and swap only the question card; keep [My page].
    const embeds = [...message.embeds.filter((e) => !isDailyEmbedTitle(e.title)), embed];
    const pageRow = new ActionRowBuilder<ButtonBuilder>().addComponents(myPageButton(q.guildId));
    await message.edit({ embeds, components: [...(components ?? []), pageRow] }).catch((err) => log.warn(`Couldn't update question #${q.id}`, err));
  }

  private async message(q: Question): Promise<Message | null> {
    if (!q.messageId) return null;
    try {
      const channel = await this.client.channels.fetch(q.channelId);
      return channel?.isTextBased() ? await channel.messages.fetch(q.messageId) : null;
    } catch {
      return null;
    }
  }
}
