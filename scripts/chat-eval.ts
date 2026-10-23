/**
 * Plays scripted conversations through Ledger's real chat pipeline (persona, reply-chain formatting,
 * tools, DeepSeek, reply clean-up) without Discord, and writes the transcripts with every tool call.
 * Uses live DeepSeek, Binance and SoSoValue, so it costs a little (about $0.001 per reply).
 *
 *   npm run chat-eval -- scripts/chat-scenarios.json out.json [--db path/to/copy.db] [--only id1,id2] [--warm]
 *
 * Point --db at a COPY of the live database (calls get drafted and alerts set in it); without it the
 * board starts empty. Catch-up and recall read the scenario's `channelLog` instead of Discord.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { AlertStore } from '../src/alerts/store.js';
import { BinanceFeed } from '../src/calls/prices.js';
import { callHeadline } from '../src/calls/service.js';
import { Board } from '../src/calls/store.js';
import { loadConfig } from '../src/config.js';
import { buildLedger } from '../src/daily/ledger.js';
import { DailyStore } from '../src/daily/store.js';
import { openDb } from '../src/db/index.js';
import { DataDesk } from '../src/desk/desk.js';
import { TreasuryWatcher } from '../src/desk/treasuries.js';
import { postableReply } from '../src/discord/text.js';
import { type ThreadMessage, toChatMessages } from '../src/discord/thread.js';
import { DeepSeek, type Usage } from '../src/llm/deepseek.js';
import { answerChecked } from '../src/llm/replyCheck.js';
import { topicTerms } from '../src/memory/archive.js';
import { Activity, buildMyPage } from '../src/pages/myPage.js';
import { PERSONA, PERSONA_EXAMPLES, contextLine } from '../src/persona.js';
import { SoSoValue } from '../src/sosovalue.js';
import { type MemoryTools, ToolKit } from '../src/tools.js';

/** One scripted conversation. A `ledger` turn is an earlier Ledger post (a card, a result) that the chain starts from. */
interface Scenario {
  id: string;
  note?: string;
  channel?: string;
  /** Lines for catch_up / recall, formatted like the real transcript: "[Oct 23 14:05] kai: text". */
  channelLog?: string[];
  turns: { from?: string; text?: string; ledger?: string }[];
}

interface ToolTrace {
  name: string;
  args: string;
  result: string;
}

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args.splice(i, 2)[1];
};
const dbPath = flag('--db') ?? ':memory:';
const only = flag('--only')?.split(',');
const warm = args.includes('--warm');
if (warm) args.splice(args.indexOf('--warm'), 1);
const [scenarioPath, outPath] = args;
if (!scenarioPath || !outPath) throw new Error('usage: chat-eval <scenarios.json> <out.json> [--db copy.db] [--only a,b]');

const config = loadConfig();
const db = openDb(dbPath);
const board = new Board(db);
const daily = new DailyStore(db);
const alerts = new AlertStore(db);
const activity = new Activity(db);
const feed = new BinanceFeed(config.priceFeedUrl);
const soso = config.sosovalueApiKey ? new SoSoValue(config.sosovalueApiKey) : null;
const desk = soso ? new DataDesk(soso, new TreasuryWatcher(soso)) : null;
const llm = new DeepSeek(config.llm);

// The owner's real ID, so their records in a copied database show up; everyone else gets a stable fake one.
const KNOWN: Record<string, string> = { elias: '1064109967025639496' };
const GUILD = '1069515997897293905';
const userId = (name: string) =>
  KNOWN[name.toLowerCase()] ?? `9${[...name.toLowerCase()].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 1e12, 7)}`;

function fakeMemory(s: Scenario): MemoryTools {
  const log = s.channelLog ?? [];
  const result = (lines: string[], what: string) =>
    lines.length
      ? { ok: true as const, channelName: s.channel ?? 'general', since: Date.now() - 24 * 3_600_000, count: lines.length, transcript: lines.join('\n') }
      : { ok: false as const, error: `Nothing ${what} in #${s.channel ?? 'general'} lately.` };
  return {
    catchUp: async () => result(log, 'new'),
    recall: async (_ctx, topic) => {
      const terms = topicTerms(topic);
      return result(log.filter((l) => terms.some((t) => l.toLowerCase().includes(t.toLowerCase()))), `about "${topic}"`);
    },
  };
}

const scenarios = (JSON.parse(readFileSync(scenarioPath, 'utf8')) as Scenario[]).filter((s) => !only || only.includes(s.id));

// Production warms the SoSoValue cache at startup; --warm does the same, so replies aren't graded on a cold cache.
if (warm && desk) {
  const started = Date.now();
  await buildLedger(desk);
  console.log(`Desk warm in ${Math.round((Date.now() - started) / 1000)}s`);
}
const results = [];
let totalCost = 0;

for (const s of scenarios) {
  const tools = new ToolKit({
    feed,
    board,
    daily,
    desk,
    alerts,
    memory: fakeMemory(s),
    myPage: (g, u) => buildMyPage({ board, daily, alerts, activity, prices: feed, desk }, g, u, Date.now()),
    quotes: { crypto: feed, stocks: soso },
  });
  const thread: ThreadMessage[] = [];
  const turns = [];
  for (const t of s.turns) {
    if (t.ledger) {
      thread.push({ authorName: 'Ledger', fromSelf: true, content: t.ledger });
      turns.push({ ledgerPost: t.ledger });
      continue;
    }
    const turn = { from: t.from || 'member', text: t.text ?? '' };
    board.remember(userId(turn.from), turn.from);
    thread.push({ authorName: turn.from, fromSelf: false, content: turn.text });
    const chain = thread.slice(-config.threadMaxMessages);
    const prompt = [
      { role: 'system' as const, content: PERSONA },
      { role: 'system' as const, content: contextLine({ server: 'CybeReator', channel: s.channel ?? 'general', now: new Date() }) },
      ...toChatMessages(chain),
    ];
    const session = tools.session({ guildId: GUILD, channelId: 'eval', userId: userId(turn.from) });
    const traces: ToolTrace[] = [];
    let cost = 0;
    const started = Date.now();
    let reply: string;
    let corrected: string[] = [];
    try {
      const answer = await answerChecked(llm, prompt, {
        maxTokens: config.llm.maxReplyTokens,
        tools: tools.definitions,
        runTool: async (call) => {
          const out = await session.run(call);
          traces.push({ name: call.name, args: call.arguments, result: out.length > 2000 ? `${out.slice(0, 2000)}…` : out });
          return out;
        },
        onUsage: (u: Usage) => (cost += u.costUsd),
      }, PERSONA_EXAMPLES);
      reply = postableReply(answer.text);
      corrected = answer.problems;
    } catch (err) {
      reply = `[ERROR: ${err instanceof Error ? err.message : String(err)}]`;
    }
    totalCost += cost;
    const draft = session.draft ? `draft #${session.draft.id}: ${callHeadline(session.draft)} (Lock it in button attached)` : null;
    turns.push({ from: turn.from, text: turn.text, reply, tools: traces, draft, ...(corrected.length ? { corrected } : {}), ms: Date.now() - started, costUsd: Number(cost.toFixed(5)) });
    thread.push({ authorName: 'Ledger', fromSelf: true, content: reply });
    console.log(`${s.id} · ${turn.from}: ${turn.text.slice(0, 60)}\n  → [${traces.map((t) => t.name).join(', ') || 'no tools'}]${corrected.length ? ' (redone)' : ''} ${reply.replace(/\n/g, ' ⏎ ').slice(0, 200)}`);
  }
  results.push({ id: s.id, note: s.note, turns });
}

writeFileSync(outPath, JSON.stringify({ ranAt: new Date().toISOString(), totalCostUsd: Number(totalCost.toFixed(4)), scenarios: results }, null, 2));
console.log(`\n${results.length} scenarios, $${totalCost.toFixed(4)} → ${outPath}`);
