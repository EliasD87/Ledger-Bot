import {
  ActionRowBuilder,
  type APIMessageTopLevelComponent,
  ContainerBuilder,
  type JSONEncodable,
  type Message,
  type MessageActionRowComponentBuilder,
  MessageFlags,
  type RepliableInteraction,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
} from 'discord.js';
import { log } from '../log.js';

/**
 * Ledger's look. Every card is one Discord container: a coloured edge for its state, a small grey
 * kicker line, a heading, a line or two of facts, and its buttons inside the card. The same shapes
 * everywhere, so any card reads at a glance and nothing crowds.
 */
export const ACCENT = {
  /** Waiting on someone: drafts, alerts. */
  amber: 0xf0b232,
  /** Live calls. */
  open: 0x5865f2,
  /** Settled: muted sage and rose, so results read calmly. */
  right: 0x7e9c84,
  wrong: 0xa8797a,
  /** Void, cancelled, nothing to show. */
  muted: 0x80848e,
  /** Personal: your page, receipts, standings. */
  page: 0xc9a46a,
  /** Market numbers. */
  tape: 0x1abc9c,
} as const;

export type Row = ActionRowBuilder<MessageActionRowComponentBuilder>;
export type CardPart = string | false | null | undefined | SeparatorBuilder | Row;

/** One card. Neighbouring strings become one block of text; null, false and '' are skipped. */
export function card(accent: number, parts: CardPart[]): ContainerBuilder {
  const container = new ContainerBuilder().setAccentColor(accent);
  let text: string[] = [];
  const flush = () => {
    if (text.length) container.addTextDisplayComponents(new TextDisplayBuilder().setContent(text.join('\n')));
    text = [];
  };
  for (const part of parts) {
    if (!part) continue;
    if (typeof part === 'string') {
      text.push(part);
      continue;
    }
    flush();
    if (part instanceof SeparatorBuilder) container.addSeparatorComponents(part);
    else container.addActionRowComponents(part);
  }
  flush();
  return container;
}

/** A thin rule between the parts of a card. */
export const divider = (): SeparatorBuilder => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);

export const row = (...items: MessageActionRowComponentBuilder[]): Row => new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(...items);

/** Small grey text: labels, sources, fine print. */
export const kicker = (text: string): string => `-# ${text}`;
export const heading = (text: string): string => `### ${text}`;

/** Plain text above a card, e.g. Ledger's chat reply with a call card under it. */
export const say = (text: string): TextDisplayBuilder => new TextDisplayBuilder().setContent(text);

type TopLevel = JSONEncodable<APIMessageTopLevelComponent>;

/** Message options for cards. Nobody is pinged unless named in `ping`. */
export function cards(components: TopLevel[], opts: { ping?: string[]; replyPing?: boolean } = {}) {
  return {
    components,
    flags: MessageFlags.IsComponentsV2 as const,
    allowedMentions: { parse: [], users: opts.ping ?? [], repliedUser: opts.replyPing ?? false },
  };
}

/**
 * Edit options that turn a message into these cards. Messages from before cards existed also have their
 * old text and embeds cleared, since a card message can't carry either.
 */
export function replacing<T extends object>(message: { flags: { has(flag: MessageFlags): boolean } }, payload: T) {
  return message.flags.has(MessageFlags.IsComponentsV2) ? payload : { ...payload, content: null, embeds: [] };
}

/**
 * Shows cards in place of a deferred reply's "thinking…" placeholder. If Discord won't turn the
 * placeholder into cards, they go out as a new message and the placeholder is removed.
 */
export async function replyWithCards(
  interaction: RepliableInteraction,
  payload: ReturnType<typeof cards>,
  opts: { ephemeral?: boolean } = {},
): Promise<Message> {
  try {
    return await interaction.editReply(payload);
  } catch (err) {
    log.debug('Deferred reply refused cards; sending them as a follow-up', err);
    const sent = await interaction.followUp(opts.ephemeral ? { ...payload, flags: [MessageFlags.Ephemeral, MessageFlags.IsComponentsV2] } : payload);
    await interaction.deleteReply().catch(() => {});
    return sent;
  }
}

/** Cards only the member sees (slash command and button replies that aren't deferred). */
export function privateCards(components: TopLevel[]) {
  return { components, flags: [MessageFlags.Ephemeral, MessageFlags.IsComponentsV2] as const, allowedMentions: { parse: [] } };
}
