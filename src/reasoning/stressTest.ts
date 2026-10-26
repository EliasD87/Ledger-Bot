import type { Evidence, EvidenceBuilder } from '../analysis/evidence.js';
import { ETF_ASSETS } from '../desk/desk.js';
import type { ChatMessage, ChatModel, Usage } from '../llm/deepseek.js';
import { BETTING } from '../llm/replyCheck.js';
import { type ThesisSpec, claimText, specProblem } from '../theses/spec.js';

export interface Point {
  point: string;
  facts: string[];
}

/** The debate, as the card shows it. Every number in it is in the evidence. */
export interface Argument {
  for: Point[];
  against: Point[];
  /** What would prove the take wrong early. */
  kill: string;
  /** What the base rate and analogs say, in a sentence. */
  history: string;
  lean: 'for' | 'against' | 'even';
  /** One line with some bite. */
  verdict: string;
}

export interface StressTest {
  spec: ThesisSpec;
  claim: string;
  /** How a vague take was turned into something checkable, if it was. */
  assumptions: string[];
  evidence: Evidence;
  argument: Argument;
}

export type StressResult = { ok: true; test: StressTest } | { ok: false; reason: 'not-a-take' | 'needs-detail' | 'no-data' | 'failed'; message: string };

interface Deps {
  llm: ChatModel;
  evidence: EvidenceBuilder;
  onUsage: (u: Usage) => void;
  now?: () => number;
}

/**
 * The reasoning layer, in four steps: understand the take as a testable claim, gather evidence in
 * code, argue it out in thinking mode from that evidence only, and verify every number against the
 * evidence (one corrected retry, then anything unsupported is dropped).
 */
export async function stressTest(deps: Deps, take: string, author: string): Promise<StressResult> {
  const now = (deps.now ?? Date.now)();
  const parsed = await understand(deps, take, now);
  if (!parsed.ok) return parsed;
  const { assumptions } = parsed;

  const evidence = await deps.evidence.forThesis(parsed.spec);
  if ('error' in evidence) return { ok: false, reason: 'no-data', message: evidence.error };
  const [first, second] = evidence.histories;
  const spec: ThesisSpec =
    parsed.spec.kind === 'flows' || !first
      ? parsed.spec
      : {
          ...parsed.spec,
          asset: first.asset.symbol,
          assetKind: first.asset.kind,
          ...(parsed.spec.kind === 'relative' && second ? { versus: second.asset.symbol, versusKind: second.asset.kind } : {}),
        };

  const claim = claimText(spec);
  const argument = await argue(deps, { take, author, claim, assumptions, evidence });
  if (!argument) return { ok: false, reason: 'failed', message: "Couldn't build a clean argument from the data this time." };
  return { ok: true, test: { spec, claim, assumptions, evidence, argument } };
}

// --- 1. Understand ---

const UNDERSTAND = `You turn a Discord member's market take into a testable thesis. Reply with one json object only.

Kinds:
- price: an asset ends above or below a target price at the end of the horizon. {"kind":"price","asset":"BTC","direction":"up","target":100000,"horizonDays":60}
- move: an asset rises or falls, optionally by at least pct (a fraction: 0.1 = 10%). {"kind":"move","asset":"NVDA","direction":"up","pct":0.1,"horizonDays":30}
- relative: one asset beats (up) or trails (down) another, optionally by at least pct. {"kind":"relative","asset":"SOL","versus":"ETH","direction":"up","horizonDays":30}
- flows: US spot ETFs for an asset see net inflows (up) or outflows (down) over the horizon. Only for: ${ETF_ASSETS.join(', ')}. {"kind":"flows","asset":"BTC","direction":"up","horizonDays":7}

Assets are tickers: crypto (BTC, ETH, SOL, PEPE...) or US stocks and ETFs (NVDA, MSTR, COIN, SPY...). "bitcoin" is BTC, "microstrategy"/"strategy" is MSTR, "the nasdaq" is QQQ. If you aren't sure of a ticker (new listings, smaller names), write the name as the member did ("spacex"); it gets looked up.
Commodities use these symbols: WTI (oil, crude, CL), BRENT, GOLD, SILVER, NATGAS, COPPER.
Horizon in days from now (1 to 365): use the day counts given with the take, never count yourself. "this week" = days to this Sunday, or to next Sunday when that is under 3. "next week" = days to next Sunday. "this month" = days to month end (at least 7). "next month" = days to the end of next month. "this cycle", "long term" = 180. No timeframe = 30. Put any guess in assumptions.
Vague takes ("SOL is the future", "ETH is dead", "MSTR is a scam") still get the closest checkable version: usually relative against the natural benchmark (alts vs ETH or BTC, crypto stocks vs BTC, stocks vs QQQ) or a move. Say what you chose in assumptions.
Conditional takes ("if X happens, Y"): test Y only, and add the assumption "judged on Y alone, the 'if' isn't checked" in your own short words.
Assumptions: at most 2, each a short phrase under 10 words, plain English ("'this month' = 8 days", "'flips' = outperforms, not market cap").

Reply:
{"type":"thesis","spec":{...},"assumptions":["..."]}
or {"type":"needs_detail","question":"one short question"} when the asset is unclear
or {"type":"not_a_take","why":"..."} when it isn't a claim about where markets go (a question, small talk).`;

async function understand(
  deps: Deps,
  take: string,
  now: number,
): Promise<{ ok: true; spec: ThesisSpec; assumptions: string[] } | Extract<StressResult, { ok: false }>> {
  const turn = await deps.llm.complete(
    [
      { role: 'system', content: UNDERSTAND },
      { role: 'user', content: `${dayCounts(now)}\nThe take: ${JSON.stringify(take)}` },
    ],
    { maxTokens: 400, json: true, temperature: 0.2 },
  );
  deps.onUsage(turn.usage);
  const out = parseJson(turn.text) as { type?: string; spec?: Partial<ThesisSpec>; assumptions?: unknown; question?: string; why?: string } | null;
  if (!out || out.type === 'not_a_take') return { ok: false, reason: 'not-a-take', message: out?.why ?? "That doesn't read as a take on where a market goes." };
  if (out.type === 'needs_detail') return { ok: false, reason: 'needs-detail', message: out.question ?? 'Which asset do you mean?' };
  const s = out.spec ?? {};
  const spec: ThesisSpec = {
    kind: (['price', 'move', 'relative', 'flows'] as const).find((k) => k === s.kind) ?? 'move',
    asset: String(s.asset ?? '').toUpperCase().replace(/^\$/, ''),
    ...(s.versus ? { versus: String(s.versus).toUpperCase().replace(/^\$/, '') } : {}),
    direction: s.direction === 'down' ? 'down' : 'up',
    ...(typeof s.target === 'number' ? { target: s.target } : {}),
    ...(typeof s.pct === 'number' && s.pct > 0 ? { pct: s.pct } : {}),
    horizonDays: Math.round(Number(s.horizonDays) || 30),
  };
  const problem = specProblem(spec);
  if (problem) return { ok: false, reason: 'needs-detail', message: problem };
  const assumptions = Array.isArray(out.assumptions)
    ? out.assumptions.map((a) => String(a).trim()).filter(Boolean).slice(0, 2).map((a) => (a.length > 90 ? `${a.slice(0, 89)}…` : a))
    : [];
  return { ok: true, spec, assumptions };
}

/** Day counts the model would otherwise get wrong: to Sunday, month ends, the year end and common dates. */
export function dayCounts(now: number): string {
  const d = new Date(now);
  const day = 86_400_000;
  const until = (y: number, m: number, dd: number) => Math.max(1, Math.floor((Date.UTC(y, m, dd, 23, 59) - now) / day));
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const toSunday = (7 - d.getUTCDay()) % 7 || 7;
  const christmas = Date.UTC(y, 11, 25) >= now ? until(y, 11, 25) : until(y + 1, 11, 25);
  return [
    `Today is ${d.toUTCString().slice(0, 16)} (UTC).`,
    `Days to this Sunday: ${toSunday}. To next Sunday: ${toSunday + 7}. To the end of this month: ${until(y, m + 1, 0)}. To the end of next month: ${until(y, m + 2, 0)}.`,
    `To 31 Dec: ${until(y, 11, 31)}. To Christmas: ${christmas}. To the end of next quarter: ${until(y, Math.floor(m / 3) * 3 + 6, 0)}.`,
  ].join('\n');
}

// --- 3. Argue, 4. Verify ---

const ARGUE = `You are Ledger, the sharpest skeptic in a crypto and stocks Discord. A member put a take on the table. Stress-test it fairly, like a smart friend who respects them enough to argue.

Use ONLY the numbered facts. Each point cites the fact ids it rests on in its facts list; never mention fact ids (F1, F2) in the text itself, members never see them. Never write a number that isn't in a cited fact (copy figures exactly). No em dashes. Don't predict prices or say what will happen; weigh the evidence.
- for: 2 or 3 strongest points supporting the take. against: 2 or 3 strongest points against. Each point one sentence, max 28 words, concrete, no filler.
- kill: the one thing that would show the take is wrong early (measurable where the facts allow), one sentence.
- history: one sentence on what the base rate and analogs say, if those facts exist; otherwise on the trend.
- lean: "for", "against" or "even": which side the evidence favours, honestly.
- verdict: one punchy line, max 14 words, dry wit, no emojis, no forecast.
Never use the words odds, bet, stake, payout, wager, gamble. Refer to the member by name or "they", never he/she/his/her.
Reply with one json object:
{"for":[{"point":"...","facts":["F1"]}],"against":[{"point":"...","facts":["F2"]}],"kill":"...","history":"...","lean":"against","verdict":"..."}`;

async function argue(
  deps: Deps,
  input: { take: string; author: string; claim: string; assumptions: string[]; evidence: Evidence },
): Promise<Argument | null> {
  const { evidence } = input;
  const messages: ChatMessage[] = [
    { role: 'system', content: ARGUE },
    {
      role: 'user',
      content: [
        `${input.author}'s take: ${JSON.stringify(input.take)}`,
        `Testable claim: ${input.claim}${input.assumptions.length ? ` (read as: ${input.assumptions.join('; ')})` : ''}`,
        'Facts:',
        ...evidence.facts.map((f) => `${f.id}: ${f.text}`),
      ].join('\n'),
    },
  ];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const turn = await deps.llm.complete(messages, { maxTokens: 4000, thinking: true, json: true, temperature: 0.7 });
    deps.onUsage(turn.usage);
    const raw = parseJson(turn.text);
    const { argument, problems } = verify(raw, evidence, input.claim);
    if (argument && (!problems.length || attempt === 2)) return argument;
    messages.push(
      { role: 'assistant', content: turn.text },
      { role: 'user', content: `Fix these and reply with the whole json again:\n- ${problems.join('\n- ')}` },
    );
  }
  return null;
}

/**
 * Checks an argument against the evidence: every point cites real facts, every number appears in the
 * evidence, no betting words. Bad points are dropped; the problems go back to the model for a retry.
 */
export function verify(raw: unknown, evidence: Evidence, claim: string): { argument: Argument | null; problems: string[] } {
  const problems: string[] = [];
  const o = (raw ?? {}) as Partial<Record<keyof Argument, unknown>>;
  const factText = new Map(evidence.facts.map((f) => [f.id, f.text]));
  const allText = `${claim}\n${evidence.facts.map((f) => f.text).join('\n')}`;

  const clean = (side: 'for' | 'against'): Point[] => {
    const list = Array.isArray(o[side]) ? (o[side] as unknown[]) : [];
    return list.flatMap((item, i) => {
      const p = item as Partial<Point>;
      const point = typeof p.point === 'string' ? tidy(p.point) : '';
      const facts = Array.isArray(p.facts) ? p.facts.map(String).filter((id) => factText.has(id)) : [];
      if (!point) return [];
      if (!facts.length) {
        problems.push(`${side} point ${i + 1} cites no valid fact id.`);
        return [];
      }
      const cited = facts.map((id) => factText.get(id)!).join('\n');
      const loose = unsupported(point, `${cited}\n${claim}`);
      if (loose.length) {
        problems.push(`${side} point ${i + 1} has numbers not in its cited facts: ${loose.join(', ')}.`);
        return [];
      }
      if (BETTING.test(point)) {
        problems.push(`${side} point ${i + 1} uses a betting word.`);
        return [];
      }
      if (PRONOUN.test(point)) {
        problems.push(`${side} point ${i + 1} guesses the member's gender; use their name or "they".`);
        return [];
      }
      if (FACT_ID.test(point)) {
        problems.push(`${side} point ${i + 1} mentions a fact id in its text; members can't see ids, say what the fact says.`);
        return [];
      }
      return [{ point, facts }];
    });
  };
  const pros = clean('for').slice(0, 3);
  const cons = clean('against').slice(0, 3);
  if (!pros.length) problems.push('Need at least one supported point for the take.');
  if (!cons.length) problems.push('Need at least one supported point against the take.');

  const text = (key: 'kill' | 'history' | 'verdict'): string => {
    const value = typeof o[key] === 'string' ? tidy(o[key] as string) : '';
    const loose = unsupported(value, allText);
    if (loose.length) {
      problems.push(`${key} has numbers not in the facts: ${loose.join(', ')}.`);
      return '';
    }
    if (BETTING.test(value)) {
      problems.push(`${key} uses a betting word.`);
      return '';
    }
    if (PRONOUN.test(value)) {
      problems.push(`${key} guesses the member's gender; use their name or "they".`);
      return '';
    }
    if (FACT_ID.test(value)) {
      problems.push(`${key} mentions a fact id; say what the fact says instead.`);
      return '';
    }
    return value;
  };
  const kill = text('kill');
  const history = text('history');
  const verdict = text('verdict').slice(0, 140);
  const lean = o.lean === 'for' || o.lean === 'against' || o.lean === 'even' ? o.lean : 'even';
  if (!pros.length || !cons.length) return { argument: null, problems };
  return { argument: { for: pros, against: cons, kill, history, lean, verdict }, problems };
}

/** He/she about the member: never guessed. */
const PRONOUN = /\b(he|she|him|his|her|hers)\b/i;
const FACT_ID = /\bF\d{1,2}\b/;

/** Drops cited ids in brackets ("(F2, F6)") and swaps em dashes for commas: house style on every card. */
function tidy(text: string): string {
  return text
    .replace(/\s*\((?:facts?\s*)?F\d{1,2}(?:\s*,\s*F\d{1,2})*\)/g, '')
    .replace(/\s*—\s*/g, ', ')
    .trim();
}

/** Numbers in `text` that don't appear in `source` (small counts up to 12 are allowed). */
export function unsupported(text: string, source: string): string[] {
  const known = numbersIn(source);
  return [...new Set(numbersIn(text).filter((n) => !(Math.abs(n) <= 12 && Number.isInteger(n)) && !known.some((k) => close(n, k))).map(String))];
}

function numbersIn(text: string): number[] {
  return [...text.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => Number(m[0].replace(/,/g, ''))).filter(Number.isFinite);
}

const close = (a: number, b: number) => (b === 0 ? a === 0 : Math.abs(a - b) / Math.abs(b) <= 0.005);

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const match = /\{[\s\S]*\}/.exec(text);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}
