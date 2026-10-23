import type { Alert, AlertStore } from '../alerts/store.js';
import type { Side } from '../calls/odds.js';
import { type Board, type Call, type Position, seasonStart } from '../calls/store.js';
import type { Choice } from '../daily/questions.js';
import type { DailyStore, Question } from '../daily/store.js';
import type { DataDesk, FlowReport } from '../desk/desk.js';
import type { Db } from '../db/index.js';
import type { MacroRelease } from '../sosovalue.js';

const DAY = 24 * 60 * 60 * 1000;
const TAPE_WAIT_MS = 5_000;

/** The value if it arrives within TAPE_WAIT_MS, else null (the request keeps going and fills the cache). */
async function soon<T>(load: Promise<T>): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), TAPE_WAIT_MS)));
  try {
    return await Promise.race([load.catch(() => null), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** When each member last opened their page. Only page opens are recorded, never what anyone reads or says. */
export class Activity {
  constructor(private readonly db: Db) {}

  lastPageAt(guildId: string, userId: string): number | null {
    const row = this.db.prepare('SELECT last_page_at AS at FROM member_activity WHERE guild_id = ? AND user_id = ?').get(guildId, userId) as
      | { at: number | null }
      | undefined;
    return row?.at ?? null;
  }

  touch(guildId: string, userId: string, now: number): void {
    this.db
      .prepare(
        `INSERT INTO member_activity (guild_id, user_id, last_page_at) VALUES (?, ?, ?)
         ON CONFLICT (guild_id, user_id) DO UPDATE SET last_page_at = excluded.last_page_at`,
      )
      .run(guildId, userId, now);
  }
}

export interface MyPage {
  since: number;
  firstVisit: boolean;
  record: {
    /** Own calls and agree/disagree that resolved since the last visit. */
    settled: { call: Call; position: Position; asCaller: boolean }[];
    /** Open calls they made or took a side on, with live distance to the target. */
    open: { call: Call; side: Side; asCaller: boolean; price: number | null }[];
    rep: number;
    rank: number | null;
    ranked: number;
    leans: { right: number; wrong: number };
  };
  question: {
    current: { q: Question; mine: Choice | undefined } | null;
    /** Closed, waiting for data. */
    pending: { q: Question; mine: Choice | undefined }[];
    last: { q: Question; mine: Choice | undefined } | null;
    streak: number;
  };
  watching: { active: Alert[]; fired: Alert[] };
  tape: { flows: FlowReport[]; macro: (MacroRelease & { event: string })[] } | null;
}

export interface PageDeps {
  board: Board;
  daily: DailyStore;
  alerts: AlertStore;
  activity: Activity;
  /** Live prices for open calls (Binance 24h ticker, one batched request). */
  prices: { change24h(symbols: string[]): Promise<Record<string, { price: number; change: number }>> };
  desk: DataDesk | null;
}

/**
 * Your Page: everything that changed for one member since they last looked, from the book itself.
 * Built from stored data and cached market numbers; no LLM call.
 */
export async function buildMyPage(deps: PageDeps, guildId: string, userId: string, now: number): Promise<MyPage> {
  const { board, daily, alerts, activity, prices, desk } = deps;
  const last = activity.lastPageAt(guildId, userId);
  const since = Math.min(Math.max(last ?? now - DAY, now - 7 * DAY), now);

  // --- record ---
  const settled = board
    .resultsSince(guildId, userId, since)
    .map(({ call, position }) => ({ call, position, asCaller: call.callerId === userId }));
  const receipts = board.receipts(guildId, userId, seasonStart(now));
  const standings = board.leaderboard(guildId, seasonStart(now));
  const rankIndex = standings.findIndex((s) => s.userId === userId);
  const openSymbols = [...new Set(receipts.open.map((o) => o.call.symbol))];
  const live = openSymbols.length ? await prices.change24h(openSymbols).catch(() => ({}) as Record<string, { price: number }>) : {};
  const open = receipts.open.map((o) => ({
    call: o.call,
    side: o.side,
    asCaller: o.call.callerId === userId,
    price: live[o.call.symbol]?.price ?? null,
  }));

  // --- question ---
  const answerOf = (q: Question) => ({ q, mine: daily.answerOf(q.id, userId) });
  const current = daily.current(guildId);
  const pending = daily.withStatus('closed').filter((q) => q.guildId === guildId).map(answerOf);
  const lastResolved = daily.lastResolved(guildId);

  // --- tape since the last visit (cached numbers; usually no new requests) ---
  // Usually cached. On a cold cache SoSoValue's rate limit can take minutes, so the page goes out without the tape.
  let tape: MyPage['tape'] = null;
  if (desk) {
    const sinceDay = new Date(since).toISOString().slice(0, 10);
    const [reports, macroReport] = await Promise.all([
      Promise.all(['BTC', 'ETH'].map((a) => soon(desk.flows(a)))),
      soon(desk.macro()),
    ]);
    const flows = reports.filter((f): f is FlowReport => !!f && f.latest.date >= sinceDay);
    const macro = macroReport?.today.filter((m) => m.actual) ?? [];
    tape = flows.length || macro.length ? { flows, macro } : null;
  }

  activity.touch(guildId, userId, now);
  return {
    since,
    firstVisit: last === null,
    record: {
      settled,
      open,
      rep: rankIndex >= 0 ? standings[rankIndex]!.points : 0,
      rank: rankIndex >= 0 ? rankIndex + 1 : null,
      ranked: standings.length,
      leans: { right: receipts.leans.right, wrong: receipts.leans.wrong },
    },
    question: {
      current: current ? answerOf(current) : null,
      pending,
      last: lastResolved ? answerOf(lastResolved) : null,
      streak: daily.stats(guildId, userId).streak,
    },
    watching: { active: alerts.forUser(guildId, userId), fired: alerts.firedSince(guildId, userId, since) },
    tape,
  };
}
