import { type AnalystCall, type AnalystStore, shortQuote, targetText } from './analysts/store.js';
import type { Lang } from './lang.js';
import type { MarketContext } from './analysis/context.js';
import type { WebNews } from './news/webNews.js';
import { type AlertDepsForCreate, type AlertRequest, createAlert, describeAlert } from './alerts/service.js';
import type { AlertStore } from './alerts/store.js';
import { isCommodity, marketOf } from './analysis/commodities.js';
import type { EvidenceBuilder } from './analysis/evidence.js';
import type { ChartFile, Charts } from './charts/maker.js';
import type { BinanceFeed, CryptoStats } from './calls/prices.js';
import { type Desk, ETF_ASSETS, leadingFund } from './desk/desk.js';
import { buildRecap } from './desk/recap.js';
import { dayLabel, discordTime, formatPrice, formatUsd, signedPct, utcLabel } from './format.js';
import type { MemoryResult } from './discord/memory.js';
import type { Tool, ToolCall } from './llm/deepseek.js';
import type { Members } from './members.js';
import type { MyPage } from './pages/myPage.js';
import type { SoSoValue, StockQuote } from './sosovalue.js';
import type { Measure } from './theses/measure.js';
import { type TakeDeps, draftTake } from './theses/service.js';
import { held, measureLabel } from './theses/spec.js';
import type { Thesis, ThesisStore } from './theses/store.js';

const HOUR = 60 * 60 * 1000;

/** World news: anything beyond the crypto feed. */
const NEWS_TOOLS: Tool[] = [
  {
    type: 'function',
    function: {
      name: 'search_news',
      description:
        'Searches recent world news (Google News: Reuters, WSJ, Bloomberg, CNBC…) for anything beyond crypto: stocks, oil and other commodities, ' +
        'the Fed and macro, geopolitics ("iran oil", "strait of hormuz", "opec", "fed rate decision", "nvidia earnings"). Use it whenever someone asks why ' +
        'something moved, what is going on with a stock or commodity, or about current events. Returns headlines with outlet and date.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to search, in plain words, e.g. "crude oil iran"' },
          days: { type: 'number', description: 'How far back, 1 to 30 (default 3)' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
];

/** Event mapping: what moved, when, what was reported, what else moved with it. */
const CONTEXT_TOOLS: Tool[] = [
  {
    type: 'function',
    function: {
      name: 'map_events',
      description:
        "Maps an asset's biggest moves over a window to that day's headlines, shows how it behaves on FOMC days (from past decisions), " +
        'and what the dollar, yields, VIX, S&P 500, gold, oil and bitcoin did and which of them it moves with. Attaches a chart with each event numbered. ' +
        'Use it for "what happened to X", "why did X move like that", "what drove the run", "how does the Fed usually hit X", "what is X trading with".',
      parameters: {
        type: 'object',
        properties: {
          asset: { type: 'string', description: 'One ticker or name, e.g. "oil", "BTC", "NVDA"' },
          days: { type: 'number', description: 'Window in days, 14 to 365 (default 90)' },
        },
        required: ['asset'],
        additionalProperties: false,
      },
    },
  },
];

/** Charts on request. */
const CHART_TOOLS: Tool[] = [
  {
    type: 'function',
    function: {
      name: 'show_chart',
      description:
        'Attaches a price chart (one asset) or a ratio chart (two assets) over a window, and returns the numbers it shows (start, now, change, high, low). ' +
        'Use it whenever someone asks to see, pull up or show a chart, the "7-day", "last month", "since it listed", or "how has X moved", and for "how\'s X looking" alongside your read. ' +
        'Works for crypto, US stocks and ETFs, and commodities (oil/WTI, Brent, gold, silver, natural gas, copper); names are fine ("nvidia", "spacex", "crude").',
      parameters: {
        type: 'object',
        properties: {
          assets: { type: 'array', items: { type: 'string' }, description: 'One ticker or name, or two for a ratio, e.g. ["SOL", "ETH"]' },
          days: { type: 'number', description: 'Window in days: 1 = 24h, 7, 30, 90, 365 (default), up to 1825' },
        },
        required: ['assets'],
        additionalProperties: false,
      },
    },
  },
];

/** The heart of Ledger: takes, stress tests, theses and records. */
const TAKE_TOOLS: Tool[] = [
  {
    type: 'function',
    function: {
      name: 'stress_test',
      description:
        'Stress-test a member\'s take with real data. Use it whenever the speaker states a view on where a market goes or how assets compare ' +
        '("sol flips eth this cycle", "nvda dip is a gift", "btc 100k by christmas", "eth is dead", "btc etfs bleed all week"), or asks you to ' +
        'argue with / test / roast their take. Pass their words. It builds the full analysis card (for, against, what kills it, history) with a ' +
        '"Log it" button; your own text should then be one short line. One per message.',
      parameters: {
        type: 'object',
        properties: { take: { type: 'string', description: "The speaker's take, in their own words and language (never translate; fix obvious typos only)" } },
        required: ['take'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'analyze',
      description:
        'Computed analysis for one or two assets (crypto or US stocks): returns over 1d/7d/30d/90d/1y, vs 50/200-day averages, distance ' +
        'from the 1-year high and low, volatility vs normal, unusual moves, drawdowns, and for two assets their ratio, its percentile and ' +
        'correlation; plus ETF flows, macro coming up and headlines. Use it for "how\'s SOL looking?", "is ETH lagging SOL?", "why is MSTR ' +
        'weak vs BTC?", "is NVDA stretched?". Reason from the facts it returns.',
      parameters: {
        type: 'object',
        properties: { assets: { type: 'array', items: { type: 'string' }, description: 'One or two tickers, e.g. ["SOL", "ETH"]' } },
        required: ['assets'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_thesis',
      description: 'One thesis by number: the claim, the analysis, who sided with and against, and how it stands right now. Use for "how\'s #12 doing?" or when someone replies about a thesis card.',
      parameters: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'], additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_takes',
      description:
        'A member\'s record of takes: aged well, aged badly, open, contrarian wins, best take, sides they read right, and their open theses. ' +
        'member: a display name, or "me" for the speaker.',
      parameters: { type: 'object', properties: { member: { type: 'string' } }, required: ['member'], additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_debates',
      description: "The server's open theses (the live debates), with sides and duels, and the leaderboard (right calls from own takes and sides). Use for \"what's being argued?\", \"who's top?\", \"who's got the best record?\".",
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
        'Live price and change for crypto, US stocks and ETFs, commodities and macro gauges, up to 10 at once. ' +
        'Use it for any price question: "btc price?", "how is nvda doing", "sol vs eth today", "mstr up or down". ' +
        'Macro and commodities have their own symbols, use them rather than ETF proxies: DXY (the dollar index), US10Y (the 10-year yield, in %), ' +
        'VIX, SP500 (the S&P 500), WTI and BRENT (oil), GOLD, SILVER, NATGAS, COPPER. Names work too ("the dollar", "10 year yield", "crude"). ' +
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

/** Where get_price reads from: crypto with exchange backups, stocks from the stored tape with web backups (see quotes.ts). */
export interface MarketQuotes {
  crypto: Pick<BinanceFeed, 'resolve' | 'stats24h'>;
  stocks: { stockQuotes(tickers: string[]): Promise<Record<string, StockQuote & { source?: string }>> } | null;
  /** Turns names and unknown tickers ("nvidia", "spacex") into tickers; see MarketHistory.identify. */
  identify?: (raw: string, kind?: 'crypto' | 'stock') => Promise<{ symbol: string; kind: 'crypto' | 'stock'; pair?: string } | null>;
}


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


/** "What did I miss?" in chat. */
const PAGE_TOOLS: Tool[] = [
  {
    type: 'function',
    function: {
      name: 'get_my_page',
      description:
        "The speaking member's page: their open theses with where each stands now, theses checked since they last looked, debates they joined, " +
        'their record, and their watchlist (with what fired). Use for "what did I miss?", "my page", "how are my takes doing?".',
      parameters: NO_ARGS,
    },
  },
];

const ANALYST_TOOLS: Tool[] = [
  {
    type: 'function',
    function: {
      name: 'analyst_views',
      description:
        'What newsletter writers and podcast hosts (tracked by DripStack) said about a stock, ETF or coin: how many covered it, how they split ' +
        '(each one counted once, by their latest call), and the most confident calls with writer, newsletter, date, a short quote and any target. ' +
        'Leave out asset for what analysts talked about most lately. Use for "what are analysts / newsletters / the pros saying about X?", ' +
        '"is anyone bearish on PLTR?", "what are newsletters talking about this week?". Oil, gold, silver, the S&P 500 and the VIX count through their ETFs and futures; yields are not covered.',
      parameters: {
        type: 'object',
        properties: {
          asset: { type: 'string', description: 'Ticker or name, e.g. NVDA, "robinhood", BTC. Omit for what analysts talk about most.' },
          days: { type: 'number', description: 'Look-back in days: default 30 for one asset, 7 for the most-talked-about list; up to 90.' },
        },
        additionalProperties: false,
      },
    },
  },
];

/** Data the stress-test card already shows, so it isn't fetched again for the line above the card. */
const CARD_COVERS = new Set(['analyze', 'get_price', 'get_etf_flows', 'get_macro', 'get_news', 'get_market', 'get_recap', 'get_treasury_buys']);

/** Tool calls for one reply. Remembers a stress test so the reply can carry its card. */
export interface ToolSession {
  run(call: ToolCall): Promise<string>;
  readonly draft: Thesis | undefined;
  /** Charts to attach to the reply: the stress test's (for its card) or an analysis chart. */
  readonly charts: ChartFile[];
}

export interface ToolKitDeps {
  members: Members;
  theses: ThesisStore;
  /** The reasoning pipeline (stress tests). */
  take: TakeDeps;
  evidence: EvidenceBuilder;
  measure: Pick<Measure, 'now'>;
  /** For alerts: resolving tickers and their spot price. */
  feed: AlertDepsForCreate['feed'];
  desk?: Desk | null;
  alerts?: AlertStore;
  memory?: MemoryTools;
  /** Builds a member's page (and marks it as seen). */
  myPage?: (guildId: string, userId: string) => Promise<MyPage>;
  /** Live quotes for get_price. */
  quotes?: MarketQuotes;
  /** Draws charts for analysis replies. */
  charts?: Charts;
  /** World news beyond the crypto feed. */
  news?: WebNews;
  /** Event mapping and the macro backdrop. */
  context?: MarketContext;
  /** Analyst calls synced from DripStack (read only). */
  analysts?: AnalystStore;
  now?: () => number;
}

export class ToolKit {
  constructor(private readonly deps: ToolKitDeps) {}

  /** The tools this setup can actually serve. */
  get definitions(): Tool[] {
    const { desk, alerts, memory, myPage, quotes } = this.deps;
    return [
      ...TAKE_TOOLS,
      ...(this.deps.charts ? CHART_TOOLS : []),
      ...(this.deps.news ? NEWS_TOOLS : []),
      ...(this.deps.context ? CONTEXT_TOOLS : []),
      ...(quotes ? PRICE_TOOLS : []),
      ...(desk ? DESK_TOOLS : []),
      ...(alerts ? ALERT_TOOLS : []),
      ...(memory ? MEMORY_TOOLS : []),
      ...(myPage ? PAGE_TOOLS : []),
      ...(this.deps.analysts ? ANALYST_TOOLS : []),
    ];
  }

  session(ctx: ToolContext & { name?: string }): ToolSession {
    const { members, theses, take, evidence, measure, feed, desk, alerts, memory, myPage, quotes } = this.deps;
    const now = this.deps.now ?? Date.now;
    let draft: Thesis | undefined;
    const charts: ChartFile[] = [];
    // One chart per reply. The most specific one wins: an event map over a chart on request over an analysis chart.
    let chartRank = 0;
    const offerChart = (chart: ChartFile, rank: number) => {
      if (rank < chartRank) return;
      chartRank = rank;
      charts.splice(0, charts.length, chart);
    };

    const handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown> | unknown> = {
      ...(quotes ? { get_price: (args) => priceForModel(quotes, args) } : {}),
      ...(desk ? deskHandlers(desk) : {}),
      ...(alerts ? alertHandlers({ store: alerts, feed, desk: desk ?? null }, ctx, now) : {}),
      ...(memory ? memoryHandlers(memory, ctx) : {}),
      ...(myPage ? { get_my_page: async () => pageForModel(await myPage(ctx.guildId, ctx.userId)) } : {}),
      ...(this.deps.analysts ? { analyst_views: (args: Record<string, unknown>) => analystViewsForModel(this.deps.analysts!, args, quotes, now()) } : {}),
      stress_test: async (args) => {
        if (draft) return { error: 'One stress test per message; this one already has a card.' };
        const text = typeof args.take === 'string' ? args.take.trim() : '';
        if (!text) return { error: 'What is the take?' };
        // The card follows the conversation's language, even if the model translated the take.
        const result = await draftTake(take, { ...ctx, name: ctx.name ?? members.nameOf(ctx.userId) }, text, ctx.lang === 'zh' ? 'zh' : undefined);
        if (!result.ok) {
          return result.reason === 'not-a-take'
            ? { not_a_take: result.message, note: 'Answer them normally instead.' }
            : result.reason === 'needs-detail'
              ? { ask: result.message }
              : { error: result.message };
        }
        draft = result.thesis;
        charts.splice(0, charts.length, ...(result.chart ? [result.chart] : []));
        const a = draft.analysis.argument;
        return {
          card: `Stress test drafted for: ${draft.claim}`,
          read_as: draft.analysis.assumptions,
          checks_back_if_logged_now: utcLabel(now() + draft.spec.horizonDays * 86_400_000),
          lean: a.lean,
          verdict: a.verdict,
          note: 'The card with the full analysis and a "Log it" button is attached under your reply. Your whole reply is ONE or two short sentences (under 35 words): react to the verdict in your voice, no numbers, no repeating the card, no other tools. Invite them to log it if they stand by it. If you mention timing, use checks_back_if_logged_now.',
        };
      },
      map_events: async (args) => {
        const asset = typeof args.asset === 'string' ? args.asset.trim() : '';
        if (!asset) return { error: 'Which asset?' };
        const days = Math.min(365, Math.max(14, Math.round(typeof args.days === 'number' ? args.days : 90)));
        const found = await this.deps.context!.forAsset(asset, days);
        if ('error' in found) return { error: found.error };
        const { main, drivers, map } = found;
        const dots = map.moves.map((m, i) => ({ date: m.date, label: String(i + 1) }));
        // The key under the chart, so it explains itself when it's shared on its own.
        const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
        const key = map.moves.map((m, i) => {
          const h = m.headlines[0];
          return `${i + 1} · ${day(m.date)} · ${signedPct(m.move).replace(/(\.\d)\d%/, '$1%')} · ${h ? `${h.title} (${h.source})` : 'no clear news that day'}`;
        });
        if (!draft && this.deps.charts) {
          const drawn = await this.deps.charts.window([main.asset.symbol], days, dots, key, ctx.lang ?? 'en').catch(() => null);
          if (drawn && !('error' in drawn)) offerChart(drawn.chart, 3);
        }
        return {
          asset: main.asset.symbol,
          window_days: days,
          events: map.moves.map((m, i) => ({
            marker: i + 1,
            date: m.date,
            move: signedPct(m.move),
            size: `${Math.abs(m.sigma).toFixed(1)}x a normal day`,
            headlines_that_day: m.headlines.map((h) => `${h.title} (${h.source})`),
          })),
          fomc: map.fomc ? this.deps.context!.eventFacts({ ...map, moves: [] })[0] : 'Not enough history around FOMC decisions.',
          backdrop: drivers,
          note:
            'The chart is attached with each event numbered. Walk through what moved and what was reported that day, say plainly when a move had no clear news, ' +
            'and connect it to the backdrop. Headlines are reports, not proof of cause. Quote numbers exactly.',
        };
      },
      search_news: async (args) => {
        const query = typeof args.query === 'string' ? args.query.trim() : '';
        if (!query) return { error: 'Search for what?' };
        const items = await this.deps.news!.search(query, { days: typeof args.days === 'number' ? args.days : 3, limit: 8 }).catch(() => []);
        if (!items.length) return { note: `No recent headlines found for "${query}".` };
        return {
          headlines: items.map((h) => ({ title: h.title, outlet: h.source, when: utcLabel(h.publishedAt), link: h.link })),
          note: 'Say what the headlines report and who reported it; a headline is a report, not proof of why a price moved.',
        };
      },
      show_chart: async (args) => {
        const assets = Array.isArray(args.assets) ? args.assets.map(String).filter(Boolean).slice(0, 2) : [];
        if (!assets.length) return { error: 'Which asset?' };
        if (draft) return { skipped: 'The stress-test card already has its chart.' };
        const result = await this.deps.charts!.window(assets, typeof args.days === 'number' ? args.days : 365, undefined, undefined, ctx.lang ?? 'en');
        if ('error' in result) return { error: result.error };
        offerChart(result.chart, 2);
        return { attached: 'The chart is attached under your reply. Talk about what it shows in a line or two; quote these numbers exactly.', ...result.summary };
      },
      analyze: async (args) => {
        const assets = Array.isArray(args.assets) ? args.assets.map(String).filter(Boolean).slice(0, 2) : [];
        if (!assets.length) return { error: 'Which asset?' };
        const e = await evidence.forAssets(assets);
        if ('error' in e) return { error: e.error };
        if (!draft && !charts.length) {
          const chart = await this.deps.charts?.forAssets(e.histories, ctx.lang ?? 'en').catch(() => null);
          if (chart) offerChart(chart, 1);
        }
        return { facts: e.facts.map((f) => f.text), sources: e.sources.join(', '), note: 'Reason from these facts; quote numbers exactly; no price predictions.' };
      },
      get_thesis: async (args) => {
        const t = theses.get(Number(args.id));
        if (!t || t.guildId !== ctx.guildId) return { error: `No thesis #${String(args.id)} here.` };
        const sides = theses.sides(t.id);
        const value = t.status === 'open' ? await measure.now(t.spec, t.startAt ?? 0).catch(() => null) : null;
        return {
          ...thesisForModel(t, members),
          with: sides.with.map((u) => members.nameOf(u)),
          against: sides.against.map((u) => members.nameOf(u)),
          for: t.analysis.argument.for.map((p) => p.point),
          against_points: t.analysis.argument.against.map((p) => p.point),
          ...(value !== null ? { now: progress(t, value) } : {}),
        };
      },
      get_takes: (args) => {
        const who = typeof args.member === 'string' ? args.member.trim() : '';
        const userId = !who || /^(me|myself|i)$/i.test(who) ? ctx.userId : members.find(who);
        if (!userId) return { error: `Nobody called "${who}" has a take on the record yet.` };
        const r = theses.record(ctx.guildId, userId);
        const place = theses.rankOf(ctx.guildId, userId);
        return {
          member: members.nameOf(userId),
          leaderboard_rank: place
            ? `${place.rank} of ${place.of} (${place.leader.right} right calls: ${place.leader.takesRight} of ${place.leader.takes} own takes, ${place.leader.sidesRight} of ${place.leader.sides} sides)`
            : 'not on the leaderboard yet: no checked take or side',
          aged_well: r.agedWell,
          aged_badly: r.agedBadly,
          open: r.open,
          contrarian_wins: r.contrarianWins,
          sides_read_right: `${r.sidesRight} of ${r.sidesSettled}`,
          best_take: r.best ? `#${r.best.id} ${r.best.claim}` : null,
          bold_takes_aged_well: `${r.bold.right} of ${r.bold.total} (takes history said were under 25% likely)`,
          reads_best: r.bestAsset ? `${r.bestAsset.asset}: ${r.bestAsset.right} of ${r.bestAsset.total}` : null,
          duels: `${r.duels.won}-${r.duels.lost}`,
          head_to_head: r.duels.against.slice(0, 3).map((d) => `vs ${members.nameOf(d.userId)}: ${d.won}-${d.lost}`),
          recent_form: r.form.slice(-8).map((f) => (f.ok ? 'aged well' : 'aged badly')),
          open_theses: theses.byAuthor(ctx.guildId, userId).filter((t) => t.status === 'open').slice(0, 5).map((t) => thesisForModel(t, members)),
        };
      },
      list_debates: () => {
        const open = theses.open(ctx.guildId);
        return {
          open: open.slice(0, 10).map((t) => {
            const s = theses.sides(t.id);
            return { ...thesisForModel(t, members), with: s.with.length, against: s.against.length, ...(t.challengerId ? { duel: `${members.nameOf(t.authorId)} vs ${members.nameOf(t.challengerId)}` } : {}) };
          }),
          total_open: open.length,
          leaderboard: theses
            .leaders(ctx.guildId, 0)
            .map((l, i) => `${i + 1}. ${members.nameOf(l.userId)}: ${l.right} right calls (${l.takesRight} of ${l.takes} own takes aged well, ${l.sidesRight} of ${l.sides} sides read right)`),
        };
      },
    };

    return {
      get draft() {
        return draft;
      },
      charts,
      async run(call) {
        const handler = handlers[call.name];
        if (!handler) return JSON.stringify({ error: `Unknown tool ${call.name}` });
        // Once the card exists it carries the analysis; more data here only turns the caption into a second card.
        if (draft && CARD_COVERS.has(call.name)) {
          return JSON.stringify({ skipped: 'The stress-test card under your reply already covers this. Write your one short line now.' });
        }
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(call.arguments || '{}') as Record<string, unknown>;
        } catch {
          return JSON.stringify({ error: 'Arguments were not valid JSON.' });
        }
        return JSON.stringify(withRetryHint(await handler(args)));
      },
    };
  }
}

/** Results that mean "no such asset", as opposed to a feed being down. */
const NOT_FOUND = /no price history|couldn't find|not found|no live|not a binance|no newsletter|no market/i;

/**
 * A second chance for names: when a lookup finds nothing, the model is told to try again with the ticker it
 * knows (Hyperliquid is HYPE) or its best reading of a typo, and to ask the member only if it can't tell.
 */
function withRetryHint(result: unknown): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const r = result as Record<string, unknown>;
  const miss = [r.error, r.not_found, r.note].some((v) => typeof v === 'string' && NOT_FOUND.test(v));
  return miss
    ? {
        ...r,
        retry:
          'If the member meant a coin or stock you know by another name, or misspelled it (Hyperliquid or "hyperliwui" is HYPE, Chainlink is LINK), call this tool again now with the ticker. Only if you cannot tell which asset they mean, ask them.',
      }
    : result;
}

function thesisForModel(t: Thesis, members: Members) {
  return {
    id: t.id,
    by: members.nameOf(t.authorId),
    claim: t.claim,
    take: t.take,
    status: t.status === 'aged_well' ? 'aged well' : t.status === 'aged_badly' ? 'aged badly' : t.status === 'open' ? 'open' : t.status,
    ...(t.checkAt ? { checks_back: utcLabel(t.checkAt) } : {}),
    ...(t.startValue !== null && t.status !== 'draft' ? { logged_at: `${measureLabel(t.spec)} ${formatValue(t, t.startValue)}` } : {}),
    ...(t.endValue !== null ? { ended_at: `${measureLabel(t.spec)} ${formatValue(t, t.endValue)}` } : {}),
  };
}

function formatValue(t: Thesis, v: number): string {
  return t.spec.kind === 'flows' ? formatUsd(v, true) : t.spec.kind === 'relative' ? v.toPrecision(4) : formatPrice(v);
}

function progress(t: Thesis, value: number) {
  const holding = held(t.spec, t.startValue ?? 0, value);
  return {
    measure: `${measureLabel(t.spec)} ${formatValue(t, value)}`,
    ...(t.spec.kind !== 'flows' && t.startValue ? { change_since_logged: signedPct(value / t.startValue - 1) } : {}),
    on_track: holding,
    checks_back: t.checkAt ? discordTime(t.checkAt, 'R') : null,
  };
}

const ACTION_WORDS: Record<string, string> = {
  NEW_POSITION: 'bought',
  ADD: 'added',
  HOLD: 'holds',
  RECOMMENDATION: 'recommends',
  REDUCE: 'trimmed',
  EXIT: 'sold',
  OPINION: 'view only',
};

/** An analyst view for the model: the split, then a few named calls. Read from the synced store only. */
async function analystViewsForModel(store: AnalystStore, args: Record<string, unknown>, quotes: MarketQuotes | undefined, now: number) {
  // An empty store means the background sync hasn't loaded anything yet: that's not the same as nobody covering it.
  if (store.status().calls === 0) {
    return { not_loaded: 'Analyst data has not loaded yet on this server. Say that in one line; do not say nobody covered it, and do not guess why.' };
  }
  const raw = typeof args.asset === 'string' ? args.asset.trim().replace(/^\$/, '') : '';
  const call = (c: AnalystCall) => ({
    who: c.publication && c.publication !== c.author ? `${c.author} (${c.publication})` : c.author,
    stance: c.sentiment.toLowerCase(),
    did: ACTION_WORDS[c.action ?? ''] ?? 'view only',
    conviction: (c.convictionLabel ?? 'unstated').replace('_', ' '),
    date: utcLabel(c.publishedAt),
    ...(shortQuote(c.quote) ? { quote: shortQuote(c.quote) } : {}),
    ...(targetText(c.target) ? { target: targetText(c.target) } : {}),
    ...(c.timeframe ? { timeframe: c.timeframe } : {}),
    ...(c.source ? { newsletter: `https://${c.source}` } : {}),
  });
  if (!raw) {
    const days = Math.min(90, Math.max(1, Math.round(typeof args.days === 'number' ? args.days : 7)));
    const top = store.trending(days, now);
    if (!top.length) return { note: `No analyst calls stored for the last ${days} days.` };
    return {
      window: `last ${days} days`,
      most_talked_about: top.map((v) => ({ asset: v.name ? `${v.ticker} (${v.name})` : v.ticker, analysts: v.analysts, bullish: v.bullish, bearish: v.bearish, neutral: v.neutral })),
      note: 'Each analyst counted once per asset, by their latest call. Source: DripStack.',
    };
  }
  const days = Math.min(90, Math.max(1, Math.round(typeof args.days === 'number' ? args.days : 30)));
  let ticker = raw.toUpperCase();
  let v = store.view(ticker, days, now);
  if (!v && quotes?.identify) {
    // A name ("robinhood", "nvidia") becomes its ticker.
    const asset = await quotes.identify(raw).catch(() => null);
    if (asset) {
      ticker = asset.symbol;
      v = store.view(ticker, days, now);
    }
  }
  if (!v) return { asset: ticker, note: `No newsletter or podcast analyst tracked by DripStack covered ${ticker} in the last ${days} days.` };
  const pick = [...v.latest.filter((c) => c.sentiment === 'BULLISH').slice(0, 2), ...v.latest.filter((c) => c.sentiment === 'BEARISH').slice(0, 2)];
  const calls = (pick.length ? pick : v.latest.slice(0, 3)).sort((a, b) => b.publishedAt - a.publishedAt);
  return {
    asset: v.name ? `${v.ticker} (${v.name})` : v.ticker,
    window: `last ${days} days`,
    analysts: v.analysts,
    split_by_latest_call: { bullish: v.bullish, bearish: v.bearish, neutral: v.neutral },
    total_calls: v.calls,
    strongest_calls: calls.map(call),
    note: 'Source: DripStack. Name the writer and newsletter; quote at most one short line; these are views, not advice.',
  };
}

function pageForModel(p: MyPage) {
  return {
    since: p.firstVisit ? 'first visit' : utcLabel(p.since),
    record: { aged_well: p.record.agedWell, aged_badly: p.record.agedBadly, open: p.record.open, contrarian_wins: p.record.contrarianWins },
    checked_since_last_look: p.results.map((t) => ({ id: t.id, claim: t.claim, result: t.status === 'aged_well' ? 'aged well' : 'aged badly' })),
    open: p.open.map(({ thesis: t, value, holding }) => ({
      id: t.id,
      claim: t.claim,
      ...(value !== null ? { now: `${measureLabel(t.spec)} ${formatValue(t, value)}`, on_track: holding } : {}),
      checks_back: t.checkAt ? utcLabel(t.checkAt) : null,
    })),
    debates_joined: p.sided.map(({ thesis: t, side }) => ({ id: t.id, claim: t.claim, side, status: t.status })),
    watching: p.watching.active.map(describeAlert),
    fired_since: p.watching.fired.map(describeAlert),
  };
}

/** What the memory tools need from the Discord side. */
export interface MemoryTools {
  catchUp(ctx: ToolContext, opts: { channel?: string; hours?: number }): Promise<MemoryResult>;
  recall(ctx: ToolContext, topic: string, days?: number): Promise<MemoryResult>;
}

export interface ToolContext {
  guildId: string;
  channelId: string;
  /** The language the member wrote in: charts drawn for this reply use it. */
  lang?: Lang;
  /** The member who is speaking. */
  userId: string;
}


async function priceForModel(quotes: MarketQuotes, args: Record<string, unknown>) {
  const wanted = Array.isArray(args.symbols) ? args.symbols.filter((s): s is string => typeof s === 'string') : [];
  const asked = [...new Set(wanted.map((s) => s.trim().replace(/^\$/, '')).filter(Boolean))].slice(0, 10);
  if (!asked.length) return { error: 'Which ticker? e.g. BTC, ETH, NVDA.' };
  const market = args.market === 'crypto' || args.market === 'stock' ? args.market : 'auto';

  const crypto = new Map<string, string>(); // ticker → Binance symbol
  const symbols: string[] = [];
  const askedAs = new Map<string, string>(); // ticker → the name it was asked by, when they differ
  for (const raw of asked) {
    let ticker = raw.toUpperCase();
    if (quotes.identify) {
      const found = await quotes.identify(raw, market === 'auto' ? undefined : market).catch(() => null);
      if (found) {
        ticker = found.symbol;
        if (found.kind === 'crypto' && found.pair) crypto.set(ticker, found.pair);
      }
    } else if (market !== 'stock') {
      const pair = await quotes.crypto.resolve(ticker).catch(() => null);
      if (pair) crypto.set(ticker, pair);
    }
    if (ticker !== raw.toUpperCase()) askedAs.set(ticker, raw);
    if (!symbols.includes(ticker)) symbols.push(ticker);
  }
  const stockTickers = market === 'crypto' ? [] : symbols.filter((s) => !crypto.has(s));
  const [cryptoStats, stockQuotes] = await Promise.all([
    crypto.size ? quotes.crypto.stats24h([...crypto.values()]).catch(() => null) : ({} as Record<string, CryptoStats>),
    stockTickers.length && quotes.stocks
      ? within(SLOW_MS, quotes.stocks.stockQuotes(stockTickers), null).catch(() => null)
      : ({} as Record<string, StockQuote & { source?: string }>),
  ]);

  const prices: Record<string, unknown>[] = [];
  const notFound: string[] = [];
  for (const s of symbols) {
    const c = crypto.has(s) ? cryptoStats?.[crypto.get(s)!] : undefined;
    const q = stockQuotes?.[s];
    if (c?.priceOnly) {
      prices.push({
        ticker: s,
        ...(askedAs.has(s) ? { asked_as: askedAs.get(s) } : {}),
        market: 'crypto',
        price: formatPrice(c.price),
        source: c.source,
        note: 'Only the price is available for this coin: no 24h change, range or volume.',
      });
    } else if (c) {
      prices.push({
        ticker: s,
        ...(askedAs.has(s) ? { asked_as: askedAs.get(s) } : {}),
        market: 'crypto',
        price: formatPrice(c.price),
        change_24h: signedPct(c.change),
        range_24h: `${formatPrice(c.low)}–${formatPrice(c.high)}`,
        volume_24h: formatUsd(c.volumeUsd),
        source: c.source ?? 'Binance',
      });
    } else if (q) {
      prices.push({
        ticker: s,
        ...(askedAs.has(s) ? { asked_as: askedAs.get(s) } : {}),
        market: marketOf(s) ? (marketOf(s)!.kind === 'commodity' ? 'commodity (front-month futures, USD)' : marketOf(s)!.name) : 'US stock',
        price: `$${formatPrice(q.last)}`,
        change_today: q.changePct !== null ? signedPct(q.changePct / 100) : null,
        market_status: q.marketStatus.toLowerCase().replace(/_/g, ' '),
        range_52w: !isCommodity(s) && q.low52w !== null && q.high52w !== null ? `$${formatPrice(q.low52w)}–$${formatPrice(q.high52w)}` : null,
        market_cap: q.marketCap !== null ? formatUsd(q.marketCap) : null,
        as_of: utcLabel(Date.parse(q.asOf)),
        source: q.source ?? 'SoSoValue',
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

function deskHandlers(desk: Desk): Record<string, (args: Record<string, unknown>) => Promise<unknown> | unknown> {
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
        const s = await buildRecap(desk, { timeoutMs: 8_000 }); // inside SLOW_MS, so a cold cache still gives a partial recap
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

