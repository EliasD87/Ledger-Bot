import type { Client } from 'discord.js';
import { DRAFT_TTL_MS } from '../calls/service.js';
import type { Settlement } from '../calls/settle.js';
import type { Board, Call } from '../calls/store.js';
import { log } from '../log.js';
import { callCard, settlementPost } from './callCards.js';
import { replacing } from './ui.js';

/** Updates the call card to its final state and posts the result as a reply to it, pinging only the caller. */
export async function announceSettlement(client: Client, s: Settlement): Promise<void> {
  const channel = await client.channels.fetch(s.call.channelId).catch(() => null);
  if (!channel?.isSendable() || !channel.isTextBased()) {
    log.warn(`Can't post the settlement of call #${s.call.id}: channel ${s.call.channelId} unavailable`);
    return;
  }
  await editCard(client, s.call, callCard(s.call, s.positions));
  await channel.send({
    ...settlementPost(s),
    ...(s.call.messageId ? { reply: { messageReference: s.call.messageId, failIfNotExists: false } } : {}),
  });
}

/** Cancels drafts nobody locked in time, and greys out their buttons. */
export async function expireDrafts(client: Client, board: Board, now: number): Promise<void> {
  for (const draft of board.staleDrafts(now - DRAFT_TTL_MS)) {
    if (!board.cancel(draft.id, 'draft expired')) continue;
    await editCard(client, draft, callCard(board.get(draft.id)!, []));
  }
}

/** Re-renders a call's card after an admin change (e.g. a void). */
export async function refreshCard(client: Client, board: Board, callId: number): Promise<void> {
  const call = board.get(callId);
  if (call) await editCard(client, call, callCard(call, board.positions(callId)));
}

async function editCard(client: Client, call: Call, payload: ReturnType<typeof callCard>): Promise<void> {
  if (!call.messageId) return;
  try {
    const channel = await client.channels.fetch(call.channelId);
    if (!channel?.isTextBased()) return;
    const message = await channel.messages.fetch(call.messageId);
    await message.edit(replacing(message, payload));
  } catch (err) {
    log.warn(`Couldn't update the card for call #${call.id}`, err);
  }
}
