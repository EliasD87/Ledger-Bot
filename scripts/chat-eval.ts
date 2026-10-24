/**
 * Plays scripted conversations through Ledger's real chat pipeline (persona, reply-chain formatting,
 * tools, DeepSeek, reply clean-up) without Discord, and writes the transcripts with every tool call.
 * Uses live DeepSeek, Binance and SoSoValue, so it costs a little (about $0.001 per reply, $0.005 per stress test).
 *
 *   npm run chat-eval -- scripts/chat-scenarios.json out.json [--db path/to/copy.db] [--only id1,id2] [--warm]
 *
 * Point --db at a COPY of the live database (theses get drafted and alerts set in it); without it the
 * records start empty. Catch-up and recall read the scenario's `channelLog` instead of Discord.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { AlertStore } from '../src/alerts/store.js';
import { EvidenceBuilder } from '../src/analysis/evidence.js';
import { MarketHistory } from '../src/analysis/history.js';
import { BinanceFeed } from '../src/calls/prices.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { DataDesk } from '../src/desk/desk.js';
import { buildRecap } from '../src/desk/recap.js';
import { TreasuryWatcher } from '../src/desk/treasuries.js';
import { postableReply } from '../src/discord/text.js';
import { type ThreadMessage, toChatMessages } from '../src/discord/thread.js';
import { DeepSeek, type Usage } from '../src/llm/deepseek.js';
import { Spend } from '../src/llm/guards.js';
import { answerChecked } from '../src/llm/replyCheck.js';
import { topicTerms } from '../src/memory/archive.js';
import { Activity, buildMyPage } from '../src/pages/myPage.js';
import { Members } from '../src/members.js';
import { PERSONA, PERSONA_EXAMPLES, contextLine } from '../src/persona.js';
import { CryptoQuotes, StockQuotes } from '../src/quotes.js';
import { SoSoValue } from '../src/sosovalue.js';
import { Measure } from '../src/theses/measure.js';
import { ThesisStore } from '../src/theses/store.js';
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
const members = new Members(db);
const theses = new ThesisStore(db);
const alerts = new AlertStore(db);
const activity = new Activity(db);
const spend = new Spend(db);
const feed = new BinanceFeed(config.priceFeedUrl);
const soso = config.sosovalueApiKey ? new SoSoValue(config.sosovalueApiKey) : null;
// Live SoSoValue here (production reads the refresher's stored tape); an eval run is a few dozen requests.
const desk = soso ? new DataDesk(soso, new TreasuryWatcher(soso)) : null;
const llm = new DeepSeek(config.llm);
const crypto = new CryptoQuotes(feed);
const stocks = new StockQuotes(null);
const history = new MarketHistory({ resolve: (asset) => crypto.resolve(asset), binance: feed });
const evidence = new EvidenceBuilder({ history, desk });
const measure = new Measure({ history, crypto, stocks, desk });

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
  await buildRecap(desk, { timeoutMs: 60_000 });
  console.log(`Desk warm in ${Math.round((Date.now() - started) / 1000)}s`);
}
const results = [];
let totalCost = 0;

for (const s of scenarios) {
  const tools = new ToolKit({
    members,
    theses,
    take: { llm, evidence, theses, spend },
    evidence,
    measure,
    feed,
    desk,
    alerts,
    memory: fakeMemory(s),
    myPage: (g, u) => buildMyPage({ theses, measure, alerts, activity }, g, u, Date.now()),
    quotes: { crypto, stocks },
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
    members.remember(userId(turn.from), turn.from);
    thread.push({ authorName: turn.from, fromSelf: false, content: turn.text });
    const chain = thread.slice(-config.threadMaxMessages);
    const prompt = [
      { role: 'system' as const, content: PERSONA },
      { role: 'system' as const, content: contextLine({ server: 'CybeReator', channel: s.channel ?? 'general', now: new Date() }) },
      ...toChatMessages(chain),
    ];
    const session = tools.session({ guildId: GUILD, channelId: 'eval', userId: userId(turn.from), name: turn.from });
    const spentBefore = spend.since(0);
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
    // Stress tests record their own spend (they run inside a tool).
    cost += spend.since(0) - spentBefore;
    totalCost += cost;
    const d = session.draft;
    const draft = d
      ? {
          id: d.id,
          claim: d.claim,
          readAs: d.analysis.assumptions,
          lean: d.analysis.argument.lean,
          verdict: d.analysis.argument.verdict,
          for: d.analysis.argument.for.map((p) => p.point),
          against: d.analysis.argument.against.map((p) => p.point),
          kill: d.analysis.argument.kill,
          history: d.analysis.argument.history,
        }
      : null;
    turns.push({ from: turn.from, text: turn.text, reply, tools: traces, draft, ...(corrected.length ? { corrected } : {}), ms: Date.now() - started, costUsd: Number(cost.toFixed(5)) });
    // In Discord the card rides under the reply, and the chain reads it back as one bracketed line.
    thread.push({ authorName: 'Ledger', fromSelf: true, content: d ? `${reply}\n[card attached: ⚖️ Stress test · thesis #${d.id} · ${d.claim} · lean ${d.analysis.argument.lean}: ${d.analysis.argument.verdict}]` : reply });
    console.log(`${s.id} · ${turn.from}: ${turn.text.slice(0, 60)}\n  → [${traces.map((t) => t.name).join(', ') || 'no tools'}]${corrected.length ? ' (redone)' : ''} ${reply.replace(/\n/g, ' ⏎ ').slice(0, 200)}`);
    if (d) console.log(`  ⚖️ #${d.id} ${d.claim} · lean ${d.analysis.argument.lean} · ${d.analysis.argument.verdict}`);
  }
  results.push({ id: s.id, note: s.note, turns });
}

writeFileSync(outPath, JSON.stringify({ ranAt: new Date().toISOString(), totalCostUsd: Number(totalCost.toFixed(4)), scenarios: results }, null, 2));
console.log(`\n${results.length} scenarios, $${totalCost.toFixed(4)} → ${outPath}`);
