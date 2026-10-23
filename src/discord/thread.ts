import type { ChatMessage } from '../llm/deepseek.js';

/** One message of a reply chain, already reduced to what the model needs. */
export interface ThreadMessage {
  authorName: string;
  fromSelf: boolean;
  content: string;
}

/**
 * Walks a reply chain from `start` back towards its root, stopping after `max` messages,
 * and returns it oldest first.
 */
export async function collectChain<M>(
  start: M,
  parentOf: (message: M) => Promise<M | null>,
  max: number,
): Promise<M[]> {
  const chain = [start];
  for (let current = start; chain.length < max; ) {
    const parent = await parentOf(current);
    if (!parent) break;
    chain.push(parent);
    current = parent;
  }
  return chain.reverse();
}

/**
 * Turns a reply chain into chat turns. Members' messages carry their name, since several members
 * can share one conversation. A chain that starts with Ledger's own post (a member replying to a
 * call card, a result or a print, or a chain cut off by the length limit) keeps that post as context,
 * so the model still sees a member speak first but knows what they are replying to.
 */
export function toChatMessages(thread: ThreadMessage[]): ChatMessage[] {
  const start = thread.findIndex((m) => !m.fromSelf);
  if (start === -1) return [];
  const opening = thread
    .slice(0, start)
    .map((m) => m.content)
    .filter(Boolean);
  const context: ChatMessage[] = opening.length
    ? [{ role: 'system', content: `The member is replying to your own earlier post (you, Ledger, wrote it):\n${opening.join('\n---\n')}` }]
    : [];
  return [...context, ...thread.slice(start).map((m): ChatMessage =>
    m.fromSelf
      ? { role: 'assistant', content: m.content }
      : { role: 'user', content: `${m.authorName}: ${m.content || '(pinged you without a message)'}` },
  )];
}
