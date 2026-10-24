import type { EvidenceBuilder } from '../analysis/evidence.js';
import type { ChatModel } from '../llm/deepseek.js';
import type { Spend } from '../llm/guards.js';
import { stressTest } from '../reasoning/stressTest.js';
import type { Thesis, ThesisStore } from './store.js';

export interface TakeDeps {
  llm: ChatModel;
  evidence: EvidenceBuilder;
  theses: ThesisStore;
  spend: Spend;
  now?: () => number;
}

export type TakeResult = { ok: true; thesis: Thesis } | { ok: false; reason: 'not-a-take' | 'needs-detail' | 'no-data' | 'failed'; message: string };

/**
 * A member's take, stress-tested and saved as a draft thesis (Log it puts it on the record). One path
 * for chat and /take, so both argue the same way.
 */
export async function draftTake(deps: TakeDeps, who: { guildId: string; channelId: string; userId: string; name: string }, take: string): Promise<TakeResult> {
  const now = (deps.now ?? Date.now)();
  const result = await stressTest(
    {
      llm: deps.llm,
      evidence: deps.evidence,
      onUsage: (usage) => deps.spend.record({ purpose: 'stress-test', model: deps.llm.model, userId: who.userId, guildId: who.guildId, usage }),
      now: () => now,
    },
    take,
    who.name,
  );
  if (!result.ok) return result;
  const { test } = result;
  const thesis = deps.theses.createDraft({
    guildId: who.guildId,
    channelId: who.channelId,
    authorId: who.userId,
    take,
    claim: test.claim,
    spec: test.spec,
    analysis: { assumptions: test.assumptions, argument: test.argument, facts: test.evidence.facts, sources: test.evidence.sources },
    now,
  });
  return { ok: true, thesis };
}
