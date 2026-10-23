import { ActionRowBuilder, type BaseMessageOptions, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { DRAFT_TTL_MS, callHeadline } from '../calls/service.js';
import type { Settlement } from '../calls/settle.js';
import type { Call, CallStatus, Position } from '../calls/store.js';
import { discordTime, formatChance, formatPrice } from '../format.js';

const COLOR: Record<CallStatus, number> = {
  draft: 0xf1c40f,
  open: 0x5865f2,
  won: 0x2ecc71,
  lost: 0xe74c3c,
  void: 0x95a5a6,
  cancelled: 0x95a5a6,
};

const STATUS: Record<CallStatus, string> = {
  draft: 'draft',
  open: 'open',
  won: 'right ✅',
  lost: 'wrong ❌',
  void: 'void',
  cancelled: 'cancelled',
};

const NOT_MONEY = 'Points are reputation, not money.';

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

/** The card a caller sees before locking in: the call and its rating, plus Lock it in / Cancel. */
export function draftCard(call: Call): BaseMessageOptions {
  const embed = baseEmbed(call)
    .addFields(
      { name: 'Caller', value: `<@${call.callerId}>`, inline: true },
      { name: 'Spot', value: formatPrice(call.entryPrice), inline: true },
      { name: 'Rated', value: `${formatChance(call.chance)} (${difficulty(call.chance)})`, inline: true },
    )
    .setFooter({
      text:
        `Rated from ${call.base}'s recent volatility. Only the caller can lock it in; the rating is re-checked then. ` +
        `Draft expires in ${DRAFT_TTL_MS / 60_000} minutes. ${NOT_MONEY}`,
    });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(buttonId('lock', call.id)).setLabel('Lock it in').setEmoji('🔒').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(buttonId('cancel', call.id)).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row] };
}

/** The card of a locked (or finished) call: who agrees and disagrees, the result, and the buttons while it's open. */
export function callCard(call: Call, positions: Position[]): BaseMessageOptions {
  const agree = positions.filter((p) => p.side === 'back');
  const disagree = positions.filter((p) => p.side === 'fade');
  const embed = baseEmbed(call).addFields(
    { name: 'Caller', value: `<@${call.callerId}>`, inline: true },
    { name: call.lockedAt ? 'Entry' : 'Spot', value: formatPrice(call.entryPrice), inline: true },
    { name: call.lockedAt ? 'Rated at lock' : 'Rated', value: `${formatChance(call.chance)} (${difficulty(call.chance)})`, inline: true },
    { name: `Agree (${agree.length})`, value: roster(agree), inline: true },
    { name: `Disagree (${disagree.length})`, value: roster(disagree), inline: true },
  );
  const result = resultLine(call);
  if (result) embed.addFields({ name: 'Result', value: result });

  if (call.status !== 'open') return { embeds: [embed], components: [] };
  embed.setFooter({
    text: `Agree or disagree to put your read on the record. Resolves automatically against live prices. ${NOT_MONEY}`,
  });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(buttonId('back', call.id)).setLabel('Agree').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(buttonId('fade', call.id)).setLabel('Disagree').setEmoji('❌').setStyle(ButtonStyle.Danger),
  );
  return { embeds: [embed], components: [row] };
}

/** The public result post: what happened and who read it right. Only the caller is pinged; no points in public. */
export function settlementText({ call, positions, won, price, at }: Settlement): string {
  const head = won
    ? call.kind === 'touch'
      ? `✅ **Call #${call.id} was right.** ${call.base} reached ${formatPrice(price)} at ${discordTime(at, 't')}. <@${call.callerId}> called it.`
      : `✅ **Call #${call.id} was right.** ${call.base} closed at ${formatPrice(price)} at the deadline. <@${call.callerId}> called it.`
    : call.kind === 'touch'
      ? `❌ **Call #${call.id} was wrong.** ${call.base} never reached ${formatPrice(call.target)} before the deadline (last ${formatPrice(price)}).`
      : `❌ **Call #${call.id} was wrong.** ${call.base} closed at ${formatPrice(price)}, on the wrong side of ${formatPrice(call.target)}.`;
  const leans = positions.filter((p) => p.userId !== call.callerId);
  const right = leans.filter((p) => p.result === 'won').length;
  const agreed = leans.filter((p) => p.side === 'back').length;
  const tally = leans.length ? `\nAgreed ${agreed} · disagreed ${leans.length - agreed} · ${right} of ${leans.length} read it right.` : '';
  return `${head} It was ${difficulty(call.chance)}.${tally}\n-# In ink. /ledger shows your page.`;
}

function baseEmbed(call: Call): EmbedBuilder {
  const deadline = `${discordTime(call.deadline)} (${discordTime(call.deadline, 'R')})`;
  const rule =
    call.kind === 'touch'
      ? `Right if price touches the target any time before ${deadline}.`
      : `Judged on the price at ${deadline}.`;
  return new EmbedBuilder()
    .setColor(COLOR[call.status])
    .setTitle(`📒 Call #${call.id} · ${STATUS[call.status]}`)
    .setDescription(`**${callHeadline(call)}**\n${rule}`);
}

function roster(positions: Position[]): string {
  if (positions.length === 0) return '—';
  const shown = positions.slice(0, 15).map((p) => `<@${p.userId}>${p.result === 'won' ? ' ✅' : p.result === 'lost' ? ' ❌' : ''}`);
  return positions.length > 15 ? `${shown.join('\n')}\n+${positions.length - 15} more` : shown.join('\n');
}

function resultLine(call: Call): string | null {
  switch (call.status) {
    case 'won':
      return `Right: reached ${formatPrice(call.settlePrice ?? call.target)}, ${discordTime(call.settleTime ?? call.settledAt ?? 0)}.`;
    case 'lost':
      return `Wrong. Price at the deadline: ${formatPrice(call.settlePrice ?? 0)}.`;
    case 'void':
      return `Voided${call.note ? `: ${call.note}` : ''}. No points either way.`;
    case 'cancelled':
      return `Cancelled${call.note ? `: ${call.note}` : ''}. Never went on the record.`;
    default:
      return null;
  }
}
