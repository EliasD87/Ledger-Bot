import { type AlertDepsForCreate, type AlertRequest, createAlert, describeAlert } from './alerts/service.js';
import type { AlertStore } from './alerts/store.js';
import { difficulty } from './discord/callCards.js';
import {
  type CallRequest,
  DRAFT_TTL_MS,
  type PriceSource,
  type PricedCall,
  callHeadline,
  describeCall,
  draftCall,
  priceCall,
  refusalText,
  scoreableTarget,
} from './calls/service.js';
import { type Board, type Call, ceilMinute, seasonStart } from './calls/store.js';
import { dayLabel, signedPct } from './daily/questions.js';
import type { DailyStore, Question } from './daily/store.js';
import { buildLedger } from './daily/ledger.js';
import { type DataDesk, ETF_ASSETS, leadingFund } from './desk/desk.js';
import { formatChance, formatPoints, formatPrice, formatUsd, monthLabel, utcLabel } from './format.js';
import type { MemoryResult } from './discord/memory.js';
import type { MyPage } from './pages/myPage.js';
import type { Tool, ToolCall } from './llm/deepseek.js';
import type { BinanceFeed, CryptoStats } from './calls/prices.js';
import type { SoSoValue, StockQuote } from './sosovalue.js';

const HOUR = 60 * 60 * 1000;

const CALL_PARAMETERS = {
  type: 'object',
  properties: {
    asset: { type: 'string', description: 'Crypto ticker, e.g. BTC, ETH, SOL, PEPE' },
    direction: { type: 'string', enum: ['above', 'below'] },
    target: { type: 'number', description: 'Target price in USD' },
    deadline_utc: {
      type: 'string',
      description:
        'When the call ends, in UTC, as "YYYY-MM-DD HH:MM". Use it for days and dates: "by Friday" is that Friday 23:59, ' +
        '"this week" is Sunday 23:59, "end of the month" is its last day 23:59. Leave empty when using window_hours.',
    },
    window_hours: {
      type: 'number',
      description: 'Or a window relative to now, in hours, for phrases like "in 6 hours" or "within 3 days". 0 when using deadline_utc.',
    },
    kind: {
      type: 'string',
      enum: ['touch', 'close'],
      description:
        'touch: price reaches the target any time before the deadline ("hit", "reach", "by"). ' +
        'close: price is past the target at the deadline ("at", "close", "end the week above"). Default touch.',
    },
  },
  required: ['asset', 'direction', 'target', 'kind'],
  additionalProperties: false,
};

/** Tools the model may call in chat. Every number it reads out comes from one of these. */
export const TOOLS: Tool[] = [
  {
    type: 'function',
    function: {
      name: 'check_call',
      description:
        'Check a hypothetical crypto price call against live market data: how likely it is and what it would score. Use it when a ' +
        'member asks how likely a price move is. Nothing gets locked in.',
      parameters: CALL_PARAMETERS,
    },
  },
  {
    type: 'function',
    function: {
      name: 'draft_call',
      description:
        'Draft a price call for the member who is speaking, rated with live data. Use it when they make a call ' +
        '("I call BTC 90k by Friday", "put me down for ETH under 2k this week", or a /call command pasted as text). ' +
        'A "Lock it in" button is attached to your reply; the call only goes on the record when they press it, within 10 minutes. ' +
        'One call per message. You cannot make calls for other members.',
      parameters: CALL_PARAMETERS,
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_receipts',
      description:
        "A member's track record on this server: season and lifetime points, right and wrong calls, best call, recent results, " +
        'and calls they currently agree or disagree with.',
      parameters: {
        type: 'object',
        properties: {
          member: { type: 'string', description: 'Display name of the member, or "me" for the member who is speaking.' },
        },
        required: ['member'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_leaderboard',
      description: "The server's standings by points: this month's season, or all time.",
      parameters: {
        type: 'object',
        properties: { period: { type: 'string', enum: ['season', 'all-time'] } },
        required: ['period'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_open_calls',
      description: 'Calls on this server that are locked in and not resolved yet, soonest deadline first.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
];

const NO_ARGS = { type: 'object', properties: {}, additionalProperties: false };

/** Live quotes: crypto from Binance, US stocks from SoSoValue. */
const PRICE_TOOLS: Tool[] = [
  {
    type: 'function',
    function: {
      name: 'get_price',
      description:
        'Live price and change for crypto (Binance, last 24h) and US stocks (SoSoValue, on the day), up to 10 tickers at once. ' +
        'Use it for any price question: "btc price?", "how is nvda doing", "sol vs eth today", "mstr up or down". ' +
        'Read the numbers out; never say why something moved.',
      parameters: {
        type: 'object',
        properties: {
          symbols: { type: 'array', items: { type: 'string' }, description: 'Tickers, e.g. ["BTC", "ETH", "NVDA"]' },
          market: {
            type: 'string',
            enum: ['auto', 'crypto', 'stock'],
            description: 'auto (default) tries crypto first, then US stocks. Use stock when the member means a company (e.g. "COIN stock").',
          },
        },
        required: ['symbols'],
        additionalProperties: false,
      },
    },
  },
];

/** Where get_price reads from. Stocks need a SoSoValue key. */
export interface MarketQuotes {
  crypto: Pick<BinanceFeed, 'resolve' | 'stats24h'>;
  stocks: Pick<SoSoValue, 'stockQuotes'> | null;
}

/** The Daily Question. */
const DAILY_TOOLS: Tool[] = [
  {
    type: 'function',
    function: {
      name: 'get_daily_question',
      description: "Today's Daily Question on this server (prompt, options, when answers close, how many answered, the speaker's answer) and the last decided one.",
      parameters: NO_ARGS,
    },
  },
];

/** The data desk: SoSoValue numbers, reported as entries. Only offered when a SoSoValue key is configured. */
const DESK_TOOLS: Tool[] = [
  {
    type: 'function',
    function: {
      name: 'get_recap',
      description:
        'A recap of the latest session: spot ETF flows for BTC, ETH, SOL and XRP with the fund that led each, corporate BTC buys this week, ' +
        "today's macro releases, the next FOMC meeting, and the market board with leading and lagging sectors. Use it for broad questions: " +
        '"what moved yesterday?", "morning recap", "what happened in the market?", "anything I should know?".',
      parameters: NO_ARGS,
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_etf_flows',
      description: `US spot ETF net flows for one asset: latest settled session, recent sessions, streak, and per-fund split. Assets: ${ETF_ASSETS.join(', ')}.`,
      parameters: {
        type: 'object',
        properties: { asset: { type: 'string', enum: [...ETF_ASSETS] } },
        required: ['asset'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_macro',
      description: "Macro docket: today's releases (actual, forecast, previous), events in the next 7 days, and the next FOMC meeting's rate probabilities.",
      parameters: NO_ARGS,
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_treasury_buys',
      description: 'Recent corporate BTC purchases (company, BTC bought, cost, date).',
      parameters: {
        type: 'object',
        properties: { days: { type: 'number', description: 'How far back, 1 to 90. Default 14.' } },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_news',
      description: 'Latest crypto headlines with links: for one coin if given, otherwise the hottest news.',
      parameters: {
        type: 'object',
        properties: { asset: { type: 'string', description: 'Coin ticker, e.g. SOL. Leave empty for the hottest news.' } },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_market',
      description: 'Total crypto market cap and 24h change, 24h volume, and sector moves over 24h.',
      parameters: NO_ARGS,
    },
  },
];

/** Alerts: always available (price and move alerts need no SoSoValue key). */
const ALERT_TOOLS: Tool[] = [
  {
    type: 'function',
    function: {
      name: 'set_alert',
      description:
        'Set an alert for the member who is speaking; they get a DM when it triggers. Kinds: ' +
        'price = an asset crosses a level ("alert me if BTC drops below 80k" → direction below, price 80000); ' +
        'move = an asset moves a percent either way from now (once); daily_move = any day an asset moves a percent over 24h (repeats; default 5); ' +
        'etf_flows = every new US spot ETF flow day for an asset; ' +
        'macro = when a release is out (event like "CPI", "PCE", "Nonfarm Payrolls"); ' +
        'treasury_buys = every new corporate BTC purchase. You cannot set alerts for other members.',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['price', 'move', 'daily_move', 'etf_flows', 'macro', 'treasury_buys'] },
          asset: { type: 'string', description: 'Ticker for price, move and etf_flows, e.g. BTC' },
          direction: { type: 'string', enum: ['above', 'below'], description: 'For price alerts' },
          price: { type: 'number', description: 'For price alerts, in USD' },
          percent: { type: 'number', description: 'For move alerts, 1 to 50' },
          event: { type: 'string', description: 'For macro alerts, e.g. "CPI"' },
        },
        required: ['kind'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_alerts',
      description: "The speaking member's active alerts with their numbers, and the ones that fired in the last 7 days. Call it before cancelling by description (\"the btc one\").",
      parameters: NO_ARGS,
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_alert',
      description: 'Cancel one of the speaking member\'s alerts by its number.',
      parameters: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'], additionalProperties: false },
    },
  },
];

/** Server memory. */
const MEMORY_TOOLS: Tool[] = [
  {
    type: 'function',
    function: {
      name: 'catch_up',
      description:
        'What the speaking member missed in a channel (default: this one), since their last message there, or over the last N hours. ' +
        "Returns a transcript. Summarize it faithfully in up to 10 short bullets: who said what, calls, numbers, links, anything aimed at them. Only channels they can read.",
      parameters: {
        type: 'object',
        properties: {
          channel: { type: 'string', description: 'Channel name, e.g. "alpha". Leave empty for this channel.' },
          hours: { type: 'number', description: 'Look back this many hours (1 to 72) instead of since their last message.' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recall',
      description:
        'What people in the server said about a topic recently ("what did people say about SOL this week?"). Returns matching messages; ' +
        'summarize them faithfully in up to 10 short bullets with names. Only channels the member can read.',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string' },
          days: { type: 'number', description: 'How far back, 1 to 30. Default 7.' },
        },
        required: ['topic'],
        additionalProperties: false,
      },
    },
  },
];

/** Your Page, for "what did I miss?" in chat. */
const PAGE_TOOLS: Tool[] = [
  {
    type: 'function',
    function: {
      name: 'get_my_page',
      description:
        "Everything that changed for the speaking member since they last looked: their calls and agree/disagree results, open calls " +
        "with live distance to target, the question and their answer and streak, what they watch and what fired, and market prints since. " +
        'Use for "what did I miss?", "my page", "how am I doing?". Their own points may be mentioned here (it is about them).',
      parameters: NO_ARGS,
    },
  },
];

/** What the memory tools need from the Discord side. */
export interface MemoryTools {
  catchUp(ctx: ToolContext, opts: { channel?: string; hours?: number }): Promise<MemoryResult>;
  recall(ctx: ToolContext, topic: string, days?: number): Promise<MemoryResult>;
}

export interface ToolContext {
  guildId: string;
  channelId: string;
  /** The member who is speaking. */
  userId: string;
}

/** Tool calls for one reply. Remembers a drafted call so the reply can carry its Lock it in button. */
export interface ToolSession {
  run(call: ToolCall): Promise<string>;
  readonly draft: Call | undefined;
}

export class ToolKit {
  constructor(
    private readonly deps: {
      feed: PriceSource;
      board: Board;
      daily?: DailyStore;
      desk?: DataDesk | null;
      alerts?: AlertStore;
      memory?: MemoryTools;
      /** Builds a member's page (and marks it as seen). */
      myPage?: (guildId: string, userId: string) => Promise<MyPage>;
      /** Live quotes for get_price. */
      quotes?: MarketQuotes;
      now?: () => number;
    },
  ) {}

  /** The tools this setup can actually serve. */
  get definitions(): Tool[] {
    const { daily, desk, alerts, memory, myPage, quotes } = this.deps;
    return [
      ...TOOLS,
      ...(quotes ? PRICE_TOOLS : []),
      ...(daily ? DAILY_TOOLS : []),
      ...(desk ? DESK_TOOLS : []),
      ...(alerts ? ALERT_TOOLS : []),
      ...(memory ? MEMORY_TOOLS : []),
      ...(myPage ? PAGE_TOOLS : []),
    ];
  }

  session(ctx: ToolContext): ToolSession {
    const { feed, board, daily, desk, alerts, memory, myPage, quotes } = this.deps;
    const now = this.deps.now ?? Date.now;
    let draft: Call | undefined;

    const handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown> | unknown> = {
      ...(quotes ? { get_price: (args) => priceForModel(quotes, args) } : {}),
      ...(daily ? { get_daily_question: () => dailyForModel(daily, ctx) } : {}),
      ...(desk ? deskHandlers(desk) : {}),
      ...(alerts ? alertHandlers({ store: alerts, feed, desk: desk ?? null }, ctx, now) : {}),
      ...(memory ? memoryHandlers(memory, ctx) : {}),
      ...(myPage ? { get_my_page: async () => pageForModel(await myPage(ctx.guildId, ctx.userId)) } : {}),
      check_call: async (args) => {
        const request = parseCallArgs(args, now());
        return typeof request === 'string' ? { error: request } : checkCall(feed, request, now());
      },
      draft_call: async (args) => {
        if (draft) return { error: 'One call per message. This message already has a draft.' };
        const t = now(); // one clock reading, so a 23:59 deadline stays 23:59
        const request = parseCallArgs(args, t);
        if (typeof request === 'string') return { error: request };
        let result;
        try {
          result = await draftCall(feed, board, { guildId: ctx.guildId, channelId: ctx.channelId, callerId: ctx.userId }, request, t);
        } catch {
          return { error: 'The price feed is not answering, or the asset is too new to price. Suggest trying later.' };
        }
        if (!result.call) return refusal(result.priced, request, t);
        draft = result.call;
        return {
          drafted: { ...callForModel(board, draft), spot: formatPrice(draft.entryPrice), ...terms(draft.chance) },
          next: `A "Lock it in" button is attached to your reply. Tell them to press it within ${DRAFT_TTL_MS / 60_000} minutes; it is not on the record until they do.`,
        };
      },
      get_receipts: (args) => {
        const member = typeof args.member === 'string' ? args.member.trim() : '';
        const userId = !member || /^(me|myself|i)$/i.test(member) ? ctx.userId : board.findMember(member);
        if (!userId) return { error: `Nobody called "${member}" on the record yet.` };
        const receipts = receiptsForModel(board, board.receipts(ctx.guildId, userId, seasonStart(now())), now());
        if (!daily) return receipts;
        const d = daily.stats(ctx.guildId, userId, seasonStart(now()));
        return { ...receipts, daily_question: { right: d.right, answered: d.answered, streak_days: d.streak, points: formatPoints(d.points) } };
      },
      get_leaderboard: (args) => {
        const allTime = args.period === 'all-time';
        const standings = board.leaderboard(ctx.guildId, allTime ? 0 : seasonStart(now()));
        const rank = standings.findIndex((s) => s.userId === ctx.userId);
        return {
          period: allTime ? 'all time' : `${monthLabel(now())} season`,
          standings: standings.slice(0, 10).map((s, i) => ({
            rank: i + 1,
            member: s.name,
            points: formatPoints(s.points),
            record: `${s.wins}–${s.losses}`,
          })),
          speaker_rank: rank === -1 ? 'not on the board yet' : rank + 1,
          total_ranked: standings.length,
        };
      },
      list_open_calls: () => {
        const open = board.openCalls(ctx.guildId);
        return {
          open_calls: open.slice(0, 15).map((call) => {
            const positions = board.positions(call.id);
            return {
              ...callForModel(board, call),
              agree: positions.filter((p) => p.side === 'back').length,
              disagree: positions.filter((p) => p.side === 'fade').length,
            };
          }),
          total: open.length,
        };
      },
    };

    return {
      get draft() {
        return draft;
      },
      async run(call) {
        const handler = handlers[call.name];
        if (!handler) return JSON.stringify({ error: `Unknown tool ${call.name}` });
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(call.arguments || '{}') as Record<string, unknown>;
        } catch {
          return JSON.stringify({ error: 'Arguments were not valid JSON.' });
        }
        return JSON.stringify(await handler(args));
      },
    };
  }
}

function parseCallArgs(args: Record<string, unknown>, now: number): CallRequest | string {
  const { asset, direction, target, deadline_utc: deadline, window_hours: hours, kind = 'touch' } = args;
  if (typeof asset !== 'string' || !asset) return 'asset must be a ticker.';
  if (direction !== 'above' && direction !== 'below') return 'direction must be "above" or "below".';
  if (typeof target !== 'number' || !(target > 0)) return 'target must be a positive price.';
  if (kind !== 'touch' && kind !== 'close') return 'kind must be "touch" or "close".';
  let windowMs: number;
  if (typeof deadline === 'string' && deadline.trim()) {
    const at = parseUtc(deadline);
    if (at === null) return 'deadline_utc must look like "2026-10-24 23:59".';
    if (at <= now) return 'That deadline is already in the past.';
    windowMs = at - now;
  } else if (typeof hours === 'number' && hours > 0) {
    windowMs = hours * HOUR;
  } else {
    return 'Give a deadline_utc or a positive window_hours.';
  }
  return { asset, direction, target, windowMs, kind };
}

/** "2026-10-24 23:59" (or with a T, seconds or Z) → unix ms. A bare date means 23:59 that day. */
export function parseUtc(text: string): number | null {
  const m = /^\s*(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(text);
  if (!m) return null;
  const [, y, mo, d, h = '23', mi = '59'] = m;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
  return Number.isNaN(ms) ? null : ms;
}

async function checkCall(feed: PriceSource, request: CallRequest, now: number): Promise<Record<string, unknown>> {
  let priced: PricedCall | null;
  try {
    priced = await priceCall(feed, request);
  } catch {
    return { error: 'The price feed is not answering, or the asset is too new to price. Suggest trying later.' };
  }
  if (!priced?.quote.ok) return refusal(priced, request, now);
  return {
    call: `${describeCall(priced.base, request).replaceAll('**', '')} (${request.kind})`,
    deadline: utcLabel(ceilMinute(now + request.windowMs)),
    spot: formatPrice(priced.spot),
    ...terms(priced.quote.chance),
    note: 'Just a check: nothing is on the record. To put their name on it, they make the call.',
  };
}

function refusal(priced: PricedCall | null, request: CallRequest, now: number): Record<string, unknown> {
  if (!priced) {
    return { refused: 'unknown-asset', why: `No live USDT market for ${request.asset}. Calls are crypto only for now; stock calls come later.` };
  }
  if (priced.quote.ok) throw new Error('refusal() called for an accepted quote');
  const deadline = ceilMinute(now + request.windowMs);
  const alternative = scoreableTarget(request, priced);
  const why = refusalText(priced.quote, priced.base, priced.spot);
  return {
    refused: priced.quote.reason,
    // With a concrete alternative on offer, the generic "pick a closer target" advice is noise.
    why: alternative ? why.replace(/ Pick a closer target or a longer window\.$/, '') : why,
    spot: formatPrice(priced.spot),
    deadline: utcLabel(deadline),
    ...(alternative
      ? {
          try_instead: `${callHeadline({ base: priced.base, direction: request.direction, target: alternative.target })} ${request.kind === 'touch' ? 'any time before' : 'at'} ${utcLabel(deadline)} (${request.kind}), ${terms(alternative.chance).rated}`,
        }
      : {}),
  };
}

/** A call's rating for the model. Points stay off public replies: a rating next to a reward reads like a betting slip. */
function terms(chance: number) {
  return { rated: `${formatChance(chance)} (${difficulty(chance)})` };
}

function callForModel(board: Board, call: Call) {
  return {
    id: call.id,
    call: `${callHeadline(call)} ${call.kind === 'touch' ? 'any time before' : 'at'} ${utcLabel(call.deadline)} (${call.kind})`,
    caller: board.nameOf(call.callerId),
    status: call.status,
  };
}

function receiptsForModel(board: Board, r: ReturnType<Board['receipts']>, now: number) {
  const settled = r.lifetime.wins + r.lifetime.losses;
  const leans = r.leans.right + r.leans.wrong + r.leans.open;
  if (settled === 0 && r.open.length === 0 && leans === 0) return { member: r.name, note: 'Nothing on the record yet.' };
  return {
    member: r.name,
    season: { label: monthLabel(now), points: formatPoints(r.season.points), record: `${r.season.wins}–${r.season.losses}` },
    lifetime: {
      points: formatPoints(r.lifetime.points),
      record: `${r.lifetime.wins}–${r.lifetime.losses}`,
      hit_rate: settled ? `${Math.round((r.lifetime.wins / settled) * 100)}%` : 'n/a',
    },
    calls_made: r.callsMade,
    agreed_or_disagreed: { ...r.leans, note: 'Recorded right or wrong; scores no points.' },
    best_call: r.biggestHit ? { ...callForModel(board, r.biggestHit.call), points: formatPoints(r.biggestHit.points) } : null,
    recent_results: r.recent.map((x) => (x === 'won' ? 'right' : 'wrong')).join(', ') || 'none resolved yet',
    open: r.open.map((o) => ({ ...callForModel(board, o.call), stance: o.side === 'back' ? 'agrees' : 'disagrees' })),
  };
}

function dailyForModel(daily: DailyStore, ctx: ToolContext) {
  const describe = (q: Question) => ({
    question: q.spec.prompt,
    options: q.spec.options,
    answers_close: utcLabel(q.closesAt),
    status: q.status,
    answered: (({ a, b }) => a + b)(daily.counts(q.id)),
  });
  const current = daily.current(ctx.guildId);
  const last = daily.lastResolved(ctx.guildId);
  if (!current && !last) return { note: 'The Daily Question is not running on this server. An admin can switch it on with /ledger-setup.' };
  const mine = current ? daily.answerOf(current.id, ctx.userId) : undefined;
  return {
    today: current ? { ...describe(current), speaker_answer: mine ? current.spec.options[mine === 'a' ? 0 : 1] : 'not answered yet' } : null,
    last_decided: last
      ? { ...describe(last), answer: last.answer ? last.spec.options[last.answer === 'a' ? 0 : 1] : 'none (void)', what_happened: last.resultText }
      : null,
    how_to_answer: "Tap a button on the question under Today's Page; /ledger links to it.",
  };
}

async function priceForModel(quotes: MarketQuotes, args: Record<string, unknown>) {
  const wanted = Array.isArray(args.symbols) ? args.symbols.filter((s): s is string => typeof s === 'string') : [];
  const symbols = [...new Set(wanted.map((s) => s.trim().replace(/^\$/, '').toUpperCase()).filter(Boolean))].slice(0, 10);
  if (!symbols.length) return { error: 'Which ticker? e.g. BTC, ETH, NVDA.' };
  const market = args.market === 'crypto' || args.market === 'stock' ? args.market : 'auto';

  const crypto = new Map<string, string>(); // ticker → Binance symbol
  if (market !== 'stock') {
    for (const s of symbols) {
      const pair = await quotes.crypto.resolve(s).catch(() => null);
      if (pair) crypto.set(s, pair);
    }
  }
  const stockTickers = market === 'crypto' ? [] : symbols.filter((s) => !crypto.has(s));
  const [cryptoStats, stockQuotes] = await Promise.all([
    crypto.size ? quotes.crypto.stats24h([...crypto.values()]).catch(() => null) : ({} as Record<string, CryptoStats>),
    stockTickers.length && quotes.stocks
      ? within(SLOW_MS, quotes.stocks.stockQuotes(stockTickers), null).catch(() => null)
      : ({} as Record<string, StockQuote>),
  ]);

  const prices: Record<string, unknown>[] = [];
  const notFound: string[] = [];
  for (const s of symbols) {
    const c = crypto.has(s) ? cryptoStats?.[crypto.get(s)!] : undefined;
    const q = stockQuotes?.[s];
    if (c) {
      prices.push({
        ticker: s,
        market: 'crypto',
        price: formatPrice(c.price),
        change_24h: signedPct(c.change),
        range_24h: `${formatPrice(c.low)}–${formatPrice(c.high)}`,
        volume_24h: formatUsd(c.volumeUsd),
        source: 'Binance',
      });
    } else if (q) {
      prices.push({
        ticker: s,
        market: 'US stock',
        price: `$${formatPrice(q.last)}`,
        change_today: q.changePct !== null ? signedPct(q.changePct / 100) : null,
        market_status: q.marketStatus.toLowerCase().replace(/_/g, ' '),
        range_52w: q.low52w !== null && q.high52w !== null ? `$${formatPrice(q.low52w)}–$${formatPrice(q.high52w)}` : null,
        market_cap: q.marketCap !== null ? formatUsd(q.marketCap) : null,
        as_of: utcLabel(Date.parse(q.asOf)),
        source: 'SoSoValue',
      });
    } else {
      notFound.push(s);
    }
  }
  if (!prices.length && (cryptoStats === null || stockQuotes === null)) return { error: 'The price feed is not answering. Suggest trying again in a minute.' };
  return {
    prices,
    ...(notFound.length
      ? { not_found: `${notFound.join(', ')}: not a Binance USDT pair${quotes.stocks ? ' or a US stock ticker' : ' (stock quotes are off: no SoSoValue key)'}` }
      : {}),
  };
}

/** SoSoValue allows 20 requests a minute; past this, a member gets "slow, ask again" instead of a long silence. */
const SLOW_MS = 12_000;

/** `load()`, or `late` if it takes longer than `ms`. The request keeps running (and fills the cache) either way. */
async function within<T, L>(ms: number, load: Promise<T>, late: L): Promise<T | L> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<L>((resolve) => (timer = setTimeout(() => resolve(late), ms)));
  try {
    return await Promise.race([load, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function deskHandlers(desk: DataDesk): Record<string, (args: Record<string, unknown>) => Promise<unknown> | unknown> {
  const unavailable = { error: "SoSoValue isn't answering right now. Suggest trying again in a minute." };
  const slow = { error: 'SoSoValue is slow right now (rate limit). Say so in one line and suggest asking again in a minute.' };
  const guard = async (load: () => Promise<unknown>) => {
    try {
      return await within(SLOW_MS, load(), slow);
    } catch {
      return unavailable;
    }
  };
  return {
    get_recap: () =>
      guard(async () => {
        const s = await buildLedger(desk, { timeoutMs: 8_000 }); // inside SLOW_MS, so a cold cache still gives a partial recap
        return {
          etf_flows: s.flows.map((f) => {
            const lead = leadingFund(f);
            return {
              asset: f.asset,
              session: dayLabel(f.latest.date),
              net_flow: formatUsd(f.latest.totalNetInflow!, true),
              led_by: lead ? `${lead.ticker} ${formatUsd(lead.netInflow, true)}` : null,
              streak: f.streak.days >= 2 ? `${f.streak.days} sessions of ${f.latest.totalNetInflow! > 0 ? 'inflows' : 'outflows'}` : null,
            };
          }),
          corporate_btc_buys_7d: s.treasuriesReady
            ? s.treasuryBuys.slice(0, 5).map((p) => `${p.company}: +${p.btcAcquired.toLocaleString('en-US')} BTC on ${dayLabel(p.date)}`)
            : 'still compiling',
          macro_today: s.macro?.today.map((t) => `${t.event}: ${t.actual || 'not out yet'}${t.forecast ? ` (forecast ${t.forecast})` : ''}`) ?? [],
          fomc_next: s.macro?.fomc
            ? {
                meeting: dayLabel(s.macro.fomc.meetingDate),
                target_range_chances: s.macro.fomc.ranges.map((r) => `${r.range}: ${r.pct.toFixed(1)}%`),
                note: 'Market-implied chance of each target range after the meeting. The current range is not in this data, so never call one of them a cut, a hold or a hike.',
              }
            : null,
          market: s.market
            ? {
                total_cap: s.market.totalMarketCap !== null ? formatUsd(s.market.totalMarketCap) : null,
                change_24h: s.market.marketCapChangePct !== null ? signedPct(s.market.marketCapChangePct / 100) : null,
                leading_sectors: s.market.sectors.slice(0, 3).map((x) => `${x.name} ${signedPct(x.change24h)}`),
                lagging_sectors: s.market.sectors.slice(-3).reverse().map((x) => `${x.name} ${signedPct(x.change24h)}`),
              }
            : null,
          ...(s.pending.length ? { still_loading: `${s.pending.join(', ')}: SoSoValue is slow right now; say so and suggest asking again in a minute.` } : {}),
          source: 'SoSoValue',
        };
      }),
    get_etf_flows: (args) =>
      guard(async () => {
        const r = await desk.flows(String(args.asset ?? 'BTC'));
        if (!r) return { error: `No US spot ETF flow data for ${String(args.asset)}.` };
        return {
          asset: r.asset,
          latest_session: { date: dayLabel(r.latest.date), net_flow: formatUsd(r.latest.totalNetInflow!, true) },
          led_by: (({ lead }) => (lead ? `${lead.ticker} ${formatUsd(lead.netInflow, true)}` : null))({ lead: leadingFund(r) }),
          streak: r.streak.days >= 2 ? `${r.streak.days} sessions of ${r.latest.totalNetInflow! > 0 ? 'inflows' : 'outflows'}, ${formatUsd(r.streak.total, true)} total` : null,
          recent_sessions: r.days.slice(0, 5).map((d) => `${dayLabel(d.date)}: ${formatUsd(d.totalNetInflow!, true)}`),
          by_fund: r.funds.slice(0, 6).map((f) => `${f.ticker}: ${formatUsd(f.netInflow, true)}`),
          cumulative_since_launch: r.latest.cumNetInflow !== null ? formatUsd(r.latest.cumNetInflow, true) : null,
          total_net_assets: r.latest.totalNetAssets !== null ? formatUsd(r.latest.totalNetAssets) : null,
          source: 'SoSoValue (flows settle the next day)',
        };
      }),
    get_macro: () =>
      guard(async () => {
        const r = await desk.macro();
        return {
          today: r.today.map((t) => ({ event: t.event, actual: t.actual || 'not out yet', forecast: t.forecast || null, previous: t.previous || null })),
          next_7_days: r.upcoming.map((d) => `${dayLabel(d.date)}: ${d.events.join(', ')}`),
          fomc: r.fomc
            ? {
                meeting: dayLabel(r.fomc.meetingDate),
                target_range_chances: r.fomc.ranges.map((x) => `${x.range}: ${x.pct.toFixed(1)}%`),
                note: 'Market-implied chance of each target range after the meeting. The current range is not in this data, so never call one of them a cut, a hold or a hike.',
              }
            : null,
          source: 'SoSoValue',
        };
      }),
    get_treasury_buys: (args) => {
      const days = Math.min(90, Math.max(1, Number(args.days) || 14));
      if (!desk.treasuries.ready) return { note: 'Still compiling the purchase list (takes a few minutes after a restart).' };
      const buys = desk.treasuryBuys(days);
      return {
        days,
        purchases: buys.slice(0, 12).map((p) => `${p.company} (${p.ticker}): +${p.btcAcquired.toLocaleString('en-US')} BTC${p.costUsd ? ` for ${formatUsd(p.costUsd)}` : ''} on ${dayLabel(p.date)}`),
        total: buys.length,
        source: 'SoSoValue',
      };
    },
    get_news: (args) =>
      guard(async () => {
        const asset = typeof args.asset === 'string' && args.asset.trim() ? args.asset.trim() : undefined;
        const n = await desk.news(asset);
        return { about: n.asset ?? 'hottest crypto news', headlines: n.items.slice(0, 5).map((i) => ({ title: i.title, link: i.link })), source: 'SoSoValue' };
      }),
    get_market: () =>
      guard(async () => {
        const r = await desk.market();
        return {
          total_market_cap: r.totalMarketCap !== null ? formatUsd(r.totalMarketCap) : null,
          change_24h: r.marketCapChangePct !== null ? signedPct(r.marketCapChangePct / 100) : null,
          volume_24h: r.volume24h !== null ? formatUsd(r.volume24h) : null,
          leading_sectors: r.sectors.slice(0, 3).map((s) => `${s.name} ${signedPct(s.change24h)}`),
          lagging_sectors: r.sectors.slice(-3).reverse().map((s) => `${s.name} ${signedPct(s.change24h)}`),
          source: 'SoSoValue',
        };
      }),
  };
}

function alertHandlers(
  deps: AlertDepsForCreate,
  ctx: ToolContext,
  now: () => number,
): Record<string, (args: Record<string, unknown>) => Promise<unknown> | unknown> {
  return {
    set_alert: async (args) => {
      const asset = typeof args.asset === 'string' ? args.asset : '';
      const request: AlertRequest | string = (() => {
        switch (args.kind) {
          case 'price':
            if (args.direction !== 'above' && args.direction !== 'below') return 'Say whether it is above or below the price.';
            return { kind: 'price', asset, direction: args.direction, price: Number(args.price) };
          case 'move':
            return { kind: 'move', asset, percent: Number(args.percent) };
          case 'daily_move':
            return { kind: 'day-move', asset, percent: Number(args.percent) || 5 };
          case 'etf_flows':
            return { kind: 'etf-flow', asset };
          case 'macro':
            return { kind: 'macro', event: typeof args.event === 'string' ? args.event : asset };
          case 'treasury_buys':
            return { kind: 'treasury' };
          default:
            return 'Unknown alert kind.';
        }
      })();
      if (typeof request === 'string') return { error: request };
      try {
        const result = await createAlert(deps, ctx, request, now());
        return result.ok
          ? {
              set: result.summary,
              note: 'The # is the alert id (for cancelling), not a count.',
              delivery: 'By DM, never posted publicly; it also shows on their page. /watch list and /watch stop manage it.',
            }
          : { error: result.error };
      } catch {
        return { error: "The price feed isn't answering. Suggest trying again in a minute." };
      }
    },
    list_alerts: () => {
      const active = deps.store.forUser(ctx.guildId, ctx.userId);
      const fired = deps.store.firedSince(ctx.guildId, ctx.userId, now() - 7 * 24 * HOUR);
      return {
        active: active.length ? active.map(describeAlert) : 'none',
        ...(fired.length ? { fired_last_7_days: fired.map((a) => `${describeAlert(a)} (fired ${utcLabel(a.firedAt!)})`) } : {}),
      };
    },
    cancel_alert: (args) =>
      deps.store.cancel(Number(args.id), ctx.userId) ? { cancelled: Number(args.id) } : { error: `No active alert #${String(args.id)} of theirs.` },
  };
}

function memoryHandlers(memory: MemoryTools, ctx: ToolContext): Record<string, (args: Record<string, unknown>) => Promise<unknown>> {
  const run = async (load: () => Promise<MemoryResult>) => {
    try {
      const r = await load();
      return r.ok
        ? { channel: r.channelName, since: utcLabel(r.since), messages: r.count, transcript: r.transcript }
        : { error: r.error, hint: "That's only this channel's chat. For the member's own calls, alerts and the tape, use get_my_page." };
    } catch {
      return { error: "Couldn't read the channel history right now." };
    }
  };
  return {
    catch_up: (args) =>
      run(() =>
        memory.catchUp(ctx, {
          channel: typeof args.channel === 'string' && args.channel.trim() ? args.channel : undefined,
          hours: typeof args.hours === 'number' && args.hours > 0 ? args.hours : undefined,
        }),
      ),
    recall: (args) => run(() => memory.recall(ctx, String(args.topic ?? ''), typeof args.days === 'number' ? args.days : 7)),
  };
}

function pageForModel(p: MyPage) {
  const opt = (q: Question, c: 'a' | 'b' | undefined | null) => (c ? q.spec.options[c === 'a' ? 0 : 1] : null);
  return {
    since: p.firstVisit ? 'first visit' : utcLabel(p.since),
    settled: p.record.settled.map((s) => ({
      call: `#${s.call.id} ${callHeadline(s.call)}`,
      role: s.asCaller ? 'their call' : s.position.side === 'back' ? 'they agreed' : 'they disagreed',
      result: s.position.result === 'won' ? 'right' : 'wrong',
      points: s.asCaller ? formatPoints(s.position.pnl ?? 0) : 'none (agree/disagree is recorded, not scored)',
    })),
    open_calls: p.record.open.map((o) => ({
      call: `#${o.call.id} ${callHeadline(o.call)}`,
      role: o.asCaller ? 'their call' : o.side === 'back' ? 'they agreed' : 'they disagreed',
      now: o.price ? formatPrice(o.price) : 'price unavailable',
      ends: utcLabel(o.call.deadline),
    })),
    season_rep: formatPoints(p.record.rep),
    rank: p.record.rank ? `${p.record.rank} of ${p.record.ranked}` : 'not ranked yet',
    question: p.question.current
      ? { asks: p.question.current.q.spec.prompt, their_answer: opt(p.question.current.q, p.question.current.mine) ?? 'not answered yet', closes: utcLabel(p.question.current.q.closesAt) }
      : null,
    waiting_to_settle: p.question.pending.filter((x) => x.mine).map((x) => `${x.q.spec.prompt} They said ${opt(x.q, x.mine)}.`),
    last_question: p.question.last
      ? { asked: p.question.last.q.spec.prompt, answer: opt(p.question.last.q, p.question.last.q.answer), what_happened: p.question.last.q.resultText, they_said: opt(p.question.last.q, p.question.last.mine) }
      : null,
    streak_days: p.question.streak,
    watching: p.watching.active.map(describeAlert),
    fired_since: p.watching.fired.map(describeAlert),
    tape_since: p.tape
      ? [
          ...p.tape.flows.map((f) => `${f.asset} spot ETFs ${dayLabel(f.latest.date)}: ${formatUsd(f.latest.totalNetInflow!, true)}`),
          ...p.tape.macro.map((m) => `${m.event}: ${m.actual}`),
        ]
      : [],
  };
}
