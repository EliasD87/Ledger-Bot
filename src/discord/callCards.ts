import { ButtonBuilder, ButtonStyle, type ContainerBuilder } from 'discord.js';
import { DRAFT_TTL_MS, callHeadline } from '../calls/service.js';
import type { Settlement } from '../calls/settle.js';
import type { Call, CallStatus, Position } from '../calls/store.js';
import { discordTime, formatChance, formatPrice } from '../format.js';
import { myPageButton } from './pageCards.js';
import { ACCENT, card, cards, divider, heading, kicker, row } from './ui.js';

const EDGE: Record<CallStatus, number> = {
  draft: ACCENT.amber,
  open: ACCENT.open,
  won: ACCENT.right,
  lost: ACCENT.wrong,
  void: ACCENT.muted,
  cancelled: ACCENT.muted,
};

const NOT_MONEY = 'points are reputation, not money';

/** Button actions. Internally a position "backs" (agrees with) or "fades" (disagrees with) a call. */
export type ButtonAction = 'lock' | 'cancel' | 'back' | 'fade';

export function buttonId(action: ButtonAction, callId: number): string {
  return `ledger:${action}:${callId}`;
}

export function parseButtonId(customId: string): { action: ButtonAction; callId: number } | null {
  const match = /^ledger:(lock|cancel|back|fade):(\d+)$/.exec(customId);
  return match ? { action: match[1] as ButtonAction, callId: Number(match[2]) } : null;
}

/** A plain word for how likely a call was, for public posts (which never show points next to a rating). */
export function difficulty(chance: number): string {
  return chance < 0.25 ? 'a stretch' : chance < 0.6 ? 'even-ish' : 'the likelier side';
}

/** The draft as a card, for a chat reply to carry under its text. */
export function draftContainer(call: Call): ContainerBuilder {
  return card(EDGE.draft, [
    kicker(`📒 Draft · <@${call.callerId}>`),
    heading(callHeadline(call)),
    whenLine(call),
    `Spot **${formatPrice(call.entryPrice)}** · rated **${formatChance(call.chance)}** · ${difficulty(call.chance)}`,
    row(
      new ButtonBuilder().setCustomId(buttonId('lock', call.id)).setLabel('Lock it in').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(buttonId('cancel', call.id)).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    ),
    kicker(`Expires in ${DRAFT_TTL_MS / 60_000} min · rated from ${call.base}'s recent volatility · ${NOT_MONEY}`),
  ]);
}

/** The card a caller sees before locking in: the call and its rating, plus Lock it in / Cancel. */
export function draftCard(call: Call) {
  return cards([draftContainer(call)]);
}

/** A call's card in any state after the draft: live with Agree / Disagree, then its result. */
export function callContainer(call: Call, positions: Position[]): ContainerBuilder {
  const leans = positions.filter((p) => p.userId !== call.callerId);
  const status = call.status === 'won' ? ' · ✓ right' : call.status === 'lost' ? ' · ✗ wrong' : call.status === 'open' ? '' : ` · ${call.status}`;
  const head = [kicker(`📒 Call #${call.id} · <@${call.callerId}>${status}`), heading(callHeadline(call))];

  if (call.status === 'void' || call.status === 'cancelled') {
    return card(EDGE[call.status], [
      ...head,
      call.status === 'void' ? `Voided${call.note ? `: ${call.note}` : ''}. No points either way.` : `Cancelled${call.note ? `: ${call.note}` : ''}. Never went on the record.`,
    ]);
  }
  if (call.status === 'open') {
    const agree = leans.filter((p) => p.side === 'back');
    const disagree = leans.filter((p) => p.side === 'fade');
    return card(EDGE.open, [
      ...head,
      whenLine(call),
      `Entry **${formatPrice(call.entryPrice)}** · rated **${formatChance(call.chance)}** at lock · ${difficulty(call.chance)}`,
      divider(),
      `**${agree.length}** agree · **${disagree.length}** disagree`,
      leans.length > 0 && kicker([...agree.map((p) => `<@${p.userId}> agrees`), ...disagree.map((p) => `<@${p.userId}> disagrees`)].slice(0, 20).join(' · ')),
      row(
        new ButtonBuilder().setCustomId(buttonId('back', call.id)).setLabel('Agree').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(buttonId('fade', call.id)).setLabel('Disagree').setStyle(ButtonStyle.Secondary),
      ),
      kicker(`Settles by itself on live prices · ${NOT_MONEY}`),
    ]);
  }
  // Settled.
  const right = leans.filter((p) => p.result === 'won');
  return card(EDGE[call.status], [
    ...head,
    outcomeLine(call),
    kicker(`Rated ${formatChance(call.chance)} at lock · ${difficulty(call.chance)}`),
    leans.length > 0 && divider(),
    leans.length > 0 && `${right.length} of ${leans.length} read it right`,
    leans.length > 0 && kicker(leans.slice(0, 20).map((p) => `<@${p.userId}> ${p.result === 'won' ? '✓' : '✗'}`).join(' · ')),
  ]);
}

export function callCard(call: Call, positions: Position[]) {
  return cards([callContainer(call, positions)]);
}

/** The public result post, replying to the card: what happened and who read it right. Pings only the caller; no points in public. */
export function settlementPost(s: Settlement) {
  const { call, positions, won, price, at } = s;
  const leans = positions.filter((p) => p.userId !== call.callerId);
  const right = leans.filter((p) => p.result === 'won').length;
  const what =
    call.kind === 'touch'
      ? won
        ? `${call.base} reached **${formatPrice(price)}** at ${discordTime(at, 't')}.`
        : `${call.base} never got there before the deadline · last **${formatPrice(price)}**.`
      : `${call.base} closed at **${formatPrice(price)}** at the deadline.`;
  return cards(
    [
      card(won ? ACCENT.right : ACCENT.wrong, [
        kicker(`📒 Result · call #${call.id}`),
        heading(`${callHeadline(call)} · ${won ? 'right' : 'wrong'}`),
        `<@${call.callerId}> ${won ? 'called it' : 'missed this one'}. ${what}`,
        kicker(`It was ${difficulty(call.chance)} · ${leans.length ? `${right} of ${leans.length} read it right · ` : ''}in ink`),
        row(myPageButton(call.guildId)),
      ]),
    ],
    { ping: [call.callerId] },
  );
}

/** The result in one plain line (for logs and anywhere a card won't fit). */
export function settlementText({ call, won, price }: Settlement): string {
  return `${won ? '✓' : '✗'} Call #${call.id} ${callHeadline(call)} was ${won ? 'right' : 'wrong'} (${call.kind === 'touch' && !won ? 'last' : 'at'} ${formatPrice(price)}). It was ${difficulty(call.chance)}.`;
}

function whenLine(call: Pick<Call, 'kind' | 'deadline'>): string {
  return call.kind === 'touch'
    ? `Touch any time before ${discordTime(call.deadline)} · ${discordTime(call.deadline, 'R')}`
    : `Judged on the price at ${discordTime(call.deadline)} · ${discordTime(call.deadline, 'R')}`;
}

function outcomeLine(call: Call): string {
  const at = call.settleTime ?? call.settledAt ?? call.deadline;
  if (call.status === 'won') {
    return call.kind === 'touch'
      ? `Reached **${formatPrice(call.settlePrice ?? call.target)}** · ${discordTime(at)}`
      : `Closed at **${formatPrice(call.settlePrice ?? call.target)}** at the deadline`;
  }
  return call.kind === 'touch'
    ? `Never got there before ${discordTime(call.deadline)} · last **${formatPrice(call.settlePrice ?? 0)}**`
    : `Closed at **${formatPrice(call.settlePrice ?? 0)}** at the deadline`;
}
