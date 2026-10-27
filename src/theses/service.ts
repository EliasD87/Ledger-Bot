import type { Lang } from '../lang.js';
import type { EvidenceBuilder } from '../analysis/evidence.js';
import type { ChartFile, Charts } from '../charts/maker.js';
import type { ChatModel } from '../llm/deepseek.js';
import type { Spend } from '../llm/guards.js';
import { type StressTest, stressTest, stressTestSpec, unsupported } from '../reasoning/stressTest.js';
import { type ThesisSpec, claimText, specProblem } from './spec.js';
import type { Analysis, Thesis, ThesisStore } from './store.js';

export interface TakeDeps {
  llm: ChatModel;
  evidence: EvidenceBuilder;
  theses: ThesisStore;
  spend: Spend;
  /** Draws the chart for the card; without it cards go out without one. */
  charts?: Charts;
  now?: () => number;
}

export type TakeResult = { ok: true; thesis: Thesis; chart: ChartFile | null } | { ok: false; reason: 'not-a-take' | 'needs-detail' | 'no-data' | 'failed'; message: string };

/**
 * A member's take, stress-tested and saved as a draft thesis (Log it puts it on the record). One path
 * for chat and /take, so both argue the same way.
 */
export async function draftTake(deps: TakeDeps, who: { guildId: string; channelId: string; userId: string; name: string }, take: string, lang?: Lang): Promise<TakeResult> {
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
    lang,
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
    analysis: analysisOf(test),
    now,
  });
  const chart = (await deps.charts?.forThesis(test.spec, test.evidence.histories, test.lang).catch(() => null)) ?? null;
  return { ok: true, thesis, chart };
}

function analysisOf(test: StressTest): Analysis {
  return {
    assumptions: test.assumptions,
    argument: test.argument,
    facts: test.evidence.facts,
    sources: test.evidence.sources,
    baseRate: test.evidence.baseRate?.rate ?? null,
    lang: test.lang,
  };
}

/**
 * Re-tests a draft with a different claim (another timeframe, a sharper version) and rewrites the draft in
 * place, so the same card and Log it button carry the new test.
 */
export async function redraftTake(deps: TakeDeps, t: Thesis, author: string, spec: ThesisSpec, note: string): Promise<TakeResult> {
  if (t.status !== 'draft') return { ok: false, reason: 'failed', message: 'Only a take that isn\'t logged yet can be changed.' };
  const now = (deps.now ?? Date.now)();
  // Keep how the words were read, except anything about the old timeframe.
  const kept = t.analysis.assumptions.filter((a) => !/=|\bdays?\b|\bweeks?\b|\bmonths?\b|\byear\b/i.test(a));
  const result = await stressTestSpec(
    {
      llm: deps.llm,
      evidence: deps.evidence,
      onUsage: (usage) => deps.spend.record({ purpose: 'stress-test', model: deps.llm.model, userId: t.authorId, guildId: t.guildId, usage }),
      now: () => now,
    },
    t.take,
    author,
    spec,
    [note, ...kept].slice(0, 2),
    t.analysis.lang ?? 'en',
  );
  if (!result.ok) return result;
  const { test } = result;
  if (!deps.theses.redraft(t.id, { claim: test.claim, spec: test.spec, analysis: analysisOf(test) })) {
    return { ok: false, reason: 'failed', message: 'That take was logged or closed in the meantime.' };
  }
  const chart = (await deps.charts?.forThesis(test.spec, test.evidence.histories, test.lang).catch(() => null)) ?? null;
  return { ok: true, thesis: deps.theses.get(t.id)!, chart };
}

const SHARPEN = `You help a member sharpen their market take before they put it on the record. Reply with one json object only.

Keep the spirit of the take (same asset or pair, same direction) but make it a real call: an exact level or a minimum move, and a timeframe where the evidence is genuinely two-sided. Prefer a version that history says happens roughly 25% to 60% of the time: bold enough to mean something, not a near-certainty or a lottery ticket. Use the timeframe table you're given. Don't flip the member's view.

Kinds: price {"kind":"price","asset":"BTC","direction":"up","target":90000,"horizonDays":30}; move {"kind":"move","asset":"NVDA","direction":"up","pct":0.08,"horizonDays":30}; relative {"kind":"relative","asset":"SOL","versus":"ETH","direction":"up","pct":0.05,"horizonDays":30}. pct is a fraction. horizonDays 1 to 365.

Reply: {"spec":{...},"why":"one short sentence on what changed and why it's a sharper call, no numbers you weren't given"}`;

/** A sharper version of a draft's claim, proposed by the model from the timeframe table. */
export async function sharpenTake(deps: TakeDeps, t: Thesis): Promise<{ spec: ThesisSpec; claim: string; why: string } | { error: string }> {
  const table = await deps.evidence.timeframes(t.spec, [7, 14, 30, 60, 90, 180, t.spec.horizonDays]);
  if ('error' in table) return { error: table.error };
  const lines = table.map((r) => `${r.days} days: ${Math.round(r.rate * 100)}% of ${r.windows} windows (median ${(r.median * 100).toFixed(1)}%)`);
  const turn = await deps.llm.complete(
    [
      { role: 'system', content: SHARPEN },
      {
        role: 'user',
        content: [
          `The member's words: ${JSON.stringify(t.take)}`,
          `Tested as: ${t.claim} (${JSON.stringify(t.spec)})`,
          `How often the current claim's move happened, by timeframe:`,
          ...lines,
          ...t.analysis.facts.slice(0, 6).map((f) => `Fact: ${f.text}`),
        ].join('\n'),
      },
    ],
    { maxTokens: 400, json: true, temperature: 0.4 },
  );
  deps.spend.record({ purpose: 'sharpen', model: deps.llm.model, userId: t.authorId, guildId: t.guildId, usage: turn.usage });
  let out: { spec?: Partial<ThesisSpec>; why?: string };
  try {
    out = JSON.parse(turn.text) as typeof out;
  } catch {
    return { error: "Couldn't come up with a sharper version this time." };
  }
  const s = out.spec ?? {};
  const spec: ThesisSpec = {
    ...t.spec,
    kind: s.kind === 'price' || s.kind === 'move' || s.kind === 'relative' ? s.kind : t.spec.kind,
    direction: s.direction === 'down' || s.direction === 'up' ? s.direction : t.spec.direction,
    horizonDays: Math.round(Number(s.horizonDays) || t.spec.horizonDays),
    target: typeof s.target === 'number' ? s.target : undefined,
    pct: typeof s.pct === 'number' && s.pct > 0 ? s.pct : undefined,
  };
  // Same asset (and pair) as the member's take: a sharper version never changes what it's about.
  if (spec.kind === 'relative' && !spec.versus) return { error: "Couldn't come up with a sharper version this time." };
  if (spec.kind !== 'relative') delete spec.versus;
  const problem = specProblem(spec);
  if (problem) return { error: "Couldn't come up with a sharper version this time." };
  const claim = claimText(spec, t.analysis.lang ?? 'en');
  if (claim === t.claim) return { error: 'It is already as sharp as the data allows: a clear level, direction and timeframe.' };
  // The reason is checked like any argument: every number has to be in what the model was shown.
  let why = typeof out.why === 'string' ? out.why.trim() : '';
  const shown = [...lines, ...t.analysis.facts.map((f) => f.text), claim].join('\n');
  if (unsupported(why, shown).length) why = '';
  if (why.length > 220) why = why.slice(0, 220).replace(/[^.]*$/, '').trim() || '';
  return { spec, claim, why: why || 'A clearer level and timeframe, so the check-back says something.' };
}
