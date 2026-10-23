import type { ChatMessage, ChatModel } from './deepseek.js';
import { type ToolLoopOptions, chatWithTools } from './toolLoop.js';

/**
 * Figures that look like market data: anything with a decimal point, 100 or more, or money with a
 * unit. Small whole numbers (counts, days, hours, ratings) and times, ids, years and links are left alone.
 */
const FIGURE = /(?<![\w#:.\/])[+−-]?\$?\d(?:[\d,]*\d)?(?:\.\d+)?(?:[kK](?![a-zA-Z]))?(?![\d:])/g;
const URL = /https?:\/\/\S+/g;

/** Betting words, and a rating followed by signed points ("rated 13% … +87"): a betting slip either way. */
const BETTING = /\b(payouts?|odds|bets?|betting|wager(?:s|ed)?|stakes?|staked|jackpot|long ?shots?)\b/i;
const RATING_THEN_POINTS = /\d{1,2}(?:\.\d+)?%[^\n]{0,60}?(?<![\w.$])[+−]\d{1,3}(?![\d.,%])/;

// Alert changes: only checked when the member asked for one, so "ETH dropped 2%" is never mistaken for a claim.
const CANCEL_ASK = /\b(cancel|drop|remove|delete|kill|stop|unwatch|turn off)\b/i;
const CANCEL_CLAIM = /\b(cancell?ed|dropped|removed|deleted|killed|stopped|off the (?:book|list))\b/i;
const SET_ASK = /\b(alert|ping|watch|notify|tell me|dm me|let me know|set|new one)\b/i;
const SET_CLAIM = /\b(?:on watch|now watching|watching (?:it|that|for)|(?:alert|watch)(?: #?\d+)? (?:is )?set|armed)\b|\bset[:,]/i;

function figures(text: string): { raw: string; value: number }[] {
  const out: { raw: string; value: number }[] = [];
  for (const match of text.replace(URL, ' ').matchAll(FIGURE)) {
    const raw = match[0];
    const thousands = /[kK]$/.test(raw);
    const digits = raw.replace(/[^\d.]/g, '');
    const value = Number(digits) * (thousands ? 1000 : 1);
    if (!Number.isFinite(value)) continue;
    out.push({ raw, value });
  }
  return out;
}

function looksLikeData(f: { raw: string; value: number }): boolean {
  const plain = f.raw.replace(/^[+−-]/, '');
  if (/^\d{4}$/.test(plain) && f.value >= 2020 && f.value <= 2035) return false; // a year
  return plain.includes('.') || f.value >= 100;
}

/**
 * What's wrong with a reply, as notes for the model: figures that appear in no tool result of this
 * reply and in no message of the thread (invented, or remembered from an earlier reply whose data is
 * gone), alert changes claimed without the alert tool, and betting-slip wording. Empty when it's fine.
 */
export function replyProblems(reply: string, evidence: { request: string; toolsUsed: string[]; sources: string[] }): string[] {
  const problems: string[] = [];
  const known = evidence.sources.flatMap((s) => figures(s).map((f) => f.value));
  const grounded = (v: number) => known.some((k) => (k === 0 ? v === 0 : Math.abs(v - k) / Math.abs(k) <= 0.005));
  const loose = [...new Set(figures(reply).filter((f) => looksLikeData(f) && !grounded(f.value)).map((f) => f.raw))];
  if (loose.length) {
    problems.push(
      `These figures appear in no tool result from this reply and in no message of the thread: ${loose.join(', ')}. ` +
        "Tool results from your earlier replies are gone, so call the tool again (get_price for prices), or leave the figures out. Don't work out new figures yourself.",
    );
  }
  const used = new Set(evidence.toolsUsed);
  if (CANCEL_ASK.test(evidence.request) && CANCEL_CLAIM.test(reply) && !used.has('cancel_alert')) {
    problems.push("You wrote that something was cancelled or dropped, but cancel_alert didn't run in this reply. Call list_alerts and cancel_alert now, or say it isn't done.");
  }
  if (SET_ASK.test(evidence.request) && SET_CLAIM.test(reply) && !used.has('set_alert') && !used.has('list_alerts')) {
    problems.push("You wrote that a watch is set, but set_alert didn't run in this reply. Call set_alert now, or say it isn't set.");
  }
  const word = BETTING.exec(reply)?.[0];
  if (word) problems.push(`Don't use the word "${word}", not even to deny it. Points are a public record; nothing goes in or out.`);
  if (RATING_THEN_POINTS.test(reply)) problems.push('Never put a rating next to points ("13%… +87"). Give the rating alone; points live on the member\'s own page.');
  return problems;
}

/**
 * Answers with tools, then checks the reply against what the tools returned. If something is off,
 * the model gets one more try with its own tool results still in view and a note on what to fix.
 * `messages[0]` must be the system prompt: figures in its examples don't count as evidence, except
 * the `examples` it tells the model to quote (like the sample call in an introduction).
 */
export async function answerChecked(
  model: ChatModel,
  messages: ChatMessage[],
  opts: ToolLoopOptions,
  examples: string[] = [],
): Promise<{ text: string; toolsUsed: string[]; problems: string[] }> {
  const first = await chatWithTools(model, messages, opts);
  const sources = (rest: ChatMessage[], results: string[]) => [...rest.map((m) => (typeof m.content === 'string' ? m.content : '')), ...results];
  const last = messages.at(-1);
  const request = last?.role === 'user' && typeof last.content === 'string' ? last.content : '';
  const problems = replyProblems(first.text, { request, toolsUsed: first.toolsUsed, sources: [...sources(messages.slice(1), first.toolResults), ...examples] });
  if (!problems.length || !first.text) return { text: first.text, toolsUsed: first.toolsUsed, problems };

  const retry = await chatWithTools(
    model,
    [
      ...first.transcript,
      { role: 'assistant', content: first.text },
      { role: 'system', content: `Your reply above has problems:\n- ${problems.join('\n- ')}\nWrite the whole reply again for the member, fixed. Don't mention this note, tools or tool results.` },
    ],
    opts,
  );
  return { text: retry.text || first.text, toolsUsed: [...first.toolsUsed, ...retry.toolsUsed], problems };
}
