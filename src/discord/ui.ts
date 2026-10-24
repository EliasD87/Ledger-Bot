import {
  ActionRowBuilder,
  type APIMessageTopLevelComponent,
  ComponentType,
  ContainerBuilder,
  type JSONEncodable,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
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
export type CardPart = string | false | null | undefined | SeparatorBuilder | MediaGalleryBuilder | Row;

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
    else if (part instanceof MediaGalleryBuilder) container.addMediaGalleryComponents(part);
    else container.addActionRowComponents(part);
  }
  flush();
  return container;
}

/** A thin rule between the parts of a card. */
export const divider = (): SeparatorBuilder => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);

export const row = (...items: MessageActionRowComponentBuilder[]): Row => new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(...items);

/** An attached image (a chart) shown inside a card. */
export const picture = (fileName: string, description = 'Chart'): MediaGalleryBuilder =>
  new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(`attachment://${fileName}`).setDescription(description));

/**
 * Edit options that rebuild a card message in place. If the message carries the named file (its chart),
 * the file is attached again with the edit, so the image inside the card survives however Discord treats
 * references to files from the original send.
 */
export function rebuilding<T extends { components: readonly unknown[] }>(message: Message, fileName: string, build: (withFile: boolean) => T) {
  const url = message.attachments.find((a) => a.name === fileName)?.url ?? fileUrlIn(message.components.map((c) => c.toJSON()), fileName);
  const payload = replacing(message, build(!!url));
  return url ? { ...payload, files: [{ attachment: url, name: fileName }], attachments: [] } : payload;
}

/**
 * The CDN address of a file shown inside a card. Card messages list their images inside the components,
 * not in the message's attachments.
 */
export function fileUrlIn(components: unknown, fileName: string): string | undefined {
  if (!components || typeof components !== 'object') return undefined;
  if (Array.isArray(components)) {
    for (const c of components) {
      const found = fileUrlIn(c, fileName);
      if (found) return found;
    }
    return undefined;
  }
  const node = components as { media?: { url?: unknown }; items?: unknown; components?: unknown };
  const url = node.media?.url;
  if (typeof url === 'string' && new URL(url).pathname.endsWith(`/${fileName}`)) return url;
  return fileUrlIn(node.items, fileName) ?? fileUrlIn(node.components, fileName);
}

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
 * Edit options that turn a message into these cards. Text above the first card (Ledger's chat line) is
 * kept. Messages from before cards existed also have their old text and embeds cleared, since a card
 * message can't carry either.
 */
export function replacing<T extends { components: readonly unknown[] }>(
  message: { flags: { has(flag: MessageFlags): boolean }; components: readonly { type: number; toJSON(): unknown }[] },
  payload: T,
): T | (T & { content: null; embeds: [] }) {
  if (!message.flags.has(MessageFlags.IsComponentsV2)) return { ...payload, content: null, embeds: [] };
  const lead: unknown[] = [];
  for (const c of message.components) {
    if (c.type !== ComponentType.TextDisplay) break;
    lead.push(c.toJSON());
  }
  return lead.length ? { ...payload, components: [...lead, ...payload.components] } : payload;
}

/**
 * Shows cards in place of a deferred reply's "thinking…" placeholder. If Discord won't turn the
 * placeholder into cards, they go out as a new message and the placeholder is removed.
 */
export async function replyWithCards(
  interaction: RepliableInteraction,
  payload: ReturnType<typeof cards> & { files?: { attachment: Buffer; name: string }[] },
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
