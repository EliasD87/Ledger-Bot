import { describe, expect, it } from 'vitest';
import { postableReply, readableContent, roleMentionIds } from '../src/discord/text.js';
import { collectChain, toChatMessages } from '../src/discord/thread.js';

describe('collectChain', () => {
  // m1 <- m2 <- m3 <- m4 (each replies to the previous one)
  const parents: Record<string, string | null> = { m1: null, m2: 'm1', m3: 'm2', m4: 'm3' };
  const parentOf = async (id: string) => parents[id] ?? null;

  it('returns the reply chain oldest first', async () => {
    expect(await collectChain('m4', parentOf, 10)).toEqual(['m1', 'm2', 'm3', 'm4']);
  });

  it('keeps only the most recent messages when the chain is long', async () => {
    expect(await collectChain('m4', parentOf, 2)).toEqual(['m3', 'm4']);
  });

  it('handles a message that is not a reply', async () => {
    expect(await collectChain('m1', parentOf, 10)).toEqual(['m1']);
  });
});

describe('toChatMessages', () => {
  it('names members and maps Ledger to the assistant role', () => {
    expect(
      toChatMessages([
        { authorName: 'kai', fromSelf: false, content: 'odds on btc 130k?' },
        { authorName: 'Ledger', fromSelf: true, content: 'Entered.' },
        { authorName: 'mo', fromSelf: false, content: 'fade' },
      ]),
    ).toEqual([
      { role: 'user', content: 'kai: odds on btc 130k?' },
      { role: 'assistant', content: 'Entered.' },
      { role: 'user', content: 'mo: fade' },
    ]);
  });

  it('keeps a Ledger post the chain starts from as context, with a member speaking first', () => {
    const messages = toChatMessages([
      { authorName: 'Ledger', fromSelf: true, content: '✅ Call #2 was right.' },
      { authorName: 'kai', fromSelf: false, content: 'how?' },
    ]);
    expect(messages).toEqual([
      { role: 'system', content: 'The member is replying to your own earlier post (you, Ledger, wrote it):\n✅ Call #2 was right.' },
      { role: 'user', content: 'kai: how?' },
    ]);
  });

  it('fills in a bare ping', () => {
    expect(toChatMessages([{ authorName: 'kai', fromSelf: false, content: '' }])[0]?.content).toBe(
      'kai: (pinged you without a message)',
    );
  });
});

describe('readableContent', () => {
  const names = {
    selfId: '1',
    selfRoleId: '9',
    users: new Map([['2', 'kai']]),
    roles: new Map([['8', 'Whales']]),
    channels: new Map([['7', 'alpha']]),
  };

  it('swaps IDs for names and removes mentions of Ledger', () => {
    expect(readableContent('<@1> did <@!2> call it in <#7>? ask <@&8> <@&9>', names, 500)).toBe(
      'did @kai call it in #alpha? ask @Whales',
    );
  });

  it('shortens custom emoji and caps length', () => {
    expect(readableContent('gm <:pepe:123> <a:dance:456>', names, 500)).toBe('gm :pepe: :dance:');
    expect(readableContent('x'.repeat(20), names, 5)).toBe('xxxxx…');
  });

  it('labels unknown mentions generically', () => {
    expect(readableContent('<@3>', names, 500)).toBe('@someone');
  });
});

describe('roleMentionIds', () => {
  it('finds role tags in raw text, even ones Discord did not count as mentions', () => {
    expect(roleMentionIds('<@&1563181675586916474> I call BTC drops below 81k')).toEqual(['1563181675586916474']);
    expect(roleMentionIds('<@1> <#2> no roles')).toEqual([]);
  });
});

describe('postableReply', () => {
  it('strips a name prefix and defuses mass pings', () => {
    expect(postableReply('Ledger: Settled. @everyone saw it.')).toBe('Settled. @​everyone saw it.');
    expect(postableReply('**Ledger**: hi')).toBe('hi');
  });

  it('swaps "long shot" for "unlikely call"', () => {
    expect(postableReply('Being right on a long shot is harder. Long shots score more; a long-shot call; A longshot.')).toBe(
      'Being right on an unlikely call is harder. Unlikely calls score more; an unlikely call; An unlikely call.',
    );
    expect(postableReply('The board pays for accuracy. Not betting: nothing to pay out.')).toBe(
      'The board rewards accuracy. Not betting: nothing to pay out.',
    );
  });

  it('keeps replies within the Discord limit', () => {
    expect(postableReply('a'.repeat(2500))).toHaveLength(2000);
  });
});
