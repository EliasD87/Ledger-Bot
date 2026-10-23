import { type ButtonInteraction, MessageFlags } from 'discord.js';
import type { Side } from '../calls/odds.js';
import { DRAFT_TTL_MS, type PriceSource, quoteNow, refusalText } from '../calls/service.js';
import type { Settler } from '../calls/settle.js';
import type { Board, Call } from '../calls/store.js';
import { log } from '../log.js';
import type { Metrics } from '../metrics.js';
import { callCard, parseButtonId } from './callCards.js';
import { pageRow } from './pageCards.js';

export interface CallButtonDeps {
  board: Board;
  feed: PriceSource;
  settler: Settler;
  metrics: Metrics;
}

const FEED_DOWN = "Price feed isn't answering. Try again in a minute.";

/** Lock it in / Cancel on drafts, Agree / Disagree on open calls. */
export async function handleCallButton(interaction: ButtonInteraction, deps: CallButtonDeps): Promise<void> {
  const parsed = parseButtonId(interaction.customId);
  if (!parsed) return;
  const { board } = deps;
  const call = board.get(parsed.callId);
  if (!call) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: "That call isn't on the record." });
    return;
  }
  const member = interaction.member;
  board.remember(interaction.user.id, member && 'displayName' in member ? member.displayName : interaction.user.displayName);
  deps.metrics.record({
    type: 'command',
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    userId: interaction.user.id,
    meta: { button: parsed.action, callId: call.id },
  });

  switch (parsed.action) {
    case 'lock':
      return lock(interaction, call, deps);
    case 'cancel':
      return cancel(interaction, call, deps);
    case 'back':
    case 'fade':
      return join(interaction, call, parsed.action, deps);
  }
}

async function lock(interaction: ButtonInteraction, call: Call, { board, feed }: CallButtonDeps): Promise<void> {
  if (interaction.user.id !== call.callerId) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: `Only <@${call.callerId}> can lock in their own call.` });
    return;
  }
  if (call.status !== 'draft') {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: `Call #${call.id} is already ${call.status}.` });
    return;
  }
  const now = Date.now();
  if (now - call.createdAt > DRAFT_TTL_MS) {
    board.cancel(call.id, 'draft expired');
    await interaction.update(callCard(board.get(call.id)!, []));
    await interaction.followUp({ flags: MessageFlags.Ephemeral, content: 'Draft expired; its chance is out of date. Make the call again.' });
    return;
  }

  await interaction.deferUpdate();
  let fresh;
  try {
    fresh = await quoteNow(feed, call, 'back', now);
  } catch (err) {
    log.warn(`Pricing call #${call.id} for lock-in failed`, err);
    await interaction.followUp({ flags: MessageFlags.Ephemeral, content: FEED_DOWN });
    return;
  }
  if (!fresh.quote.ok) {
    const why = refusalText(fresh.quote, call.base, fresh.spot);
    board.cancel(call.id, `price moved: ${why}`);
    await interaction.editReply(callCard(board.get(call.id)!, []));
    await interaction.followUp({ flags: MessageFlags.Ephemeral, content: `Price moved since the draft. ${why}` });
    return;
  }
  const { chance, payout, stake } = fresh.quote;
  if (!board.lock(call.id, fresh.spot, { stake, chance, payout }, now)) {
    await interaction.followUp({ flags: MessageFlags.Ephemeral, content: `Call #${call.id} was already handled.` });
    return;
  }
  await interaction.editReply(callCard(board.get(call.id)!, board.positions(call.id)));
}

async function cancel(interaction: ButtonInteraction, call: Call, { board }: CallButtonDeps): Promise<void> {
  if (interaction.user.id !== call.callerId) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: `Only <@${call.callerId}> can cancel their own draft.` });
    return;
  }
  if (!board.cancel(call.id, 'called off by the caller')) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: `Call #${call.id} is ${call.status}; too late to cancel.` });
    return;
  }
  await interaction.update(callCard(board.get(call.id)!, []));
}

async function join(interaction: ButtonInteraction, call: Call, side: Side, deps: CallButtonDeps): Promise<void> {
  const { board, feed, settler } = deps;
  if (call.status !== 'open') {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: `Call #${call.id} is ${call.status}. Board's closed on it.` });
    return;
  }
  const existing = board.positionOf(call.id, interaction.user.id);
  if (existing) {
    const verb = existing.side === 'back' ? 'agreed with' : 'disagreed with';
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: `You already ${verb} call #${call.id}. One position per call.` });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const now = Date.now();
  let fresh;
  try {
    if (await settler.reachedSinceCheck(call)) {
      await interaction.editReply('Too late: it just got there. The result is on its way.');
      return;
    }
    fresh = await quoteNow(feed, call, side, now);
  } catch (err) {
    log.warn(`Pricing a ${side} on call #${call.id} failed`, err);
    await interaction.editReply(FEED_DOWN);
    return;
  }
  // A lean is a record, not a score: refuse only when the call can no longer be joined at all.
  const q = fresh.quote;
  if (!q.ok && (q.reason === 'bad-window' || q.reason === 'already-there' || q.reason === 'bad-price')) {
    const why = q.reason === 'bad-window' ? "Under an hour left. The window's closed." : refusalText(q, call.base, fresh.spot);
    await interaction.editReply(why);
    return;
  }
  const chance = q.ok ? q.chance : (q.chance ?? 0.5);

  const outcome = board.join(call.id, interaction.user.id, side, { stake: 0, chance, payout: 0 }, now);
  if (outcome !== 'ok') {
    await interaction.editReply(outcome === 'already-in' ? "You're already on this call." : 'That call just closed.');
    return;
  }
  await interaction.editReply({
    content:
      `${side === 'back' ? '✅ On the record: you agree with' : '❌ On the record: you disagree with'} call #${call.id}. ` +
      `It goes on your receipts as right or wrong; agreeing and disagreeing don't move points.`,
    components: [pageRow()],
  });
  await interaction.message.edit(callCard(board.get(call.id)!, board.positions(call.id))).catch((err) => {
    log.warn(`Couldn't update the card for call #${call.id}`, err);
  });
}
