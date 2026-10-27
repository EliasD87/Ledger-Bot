import type { MarketHistory } from '../analysis/history.js';
import { log } from '../log.js';
import { type DayRule, at, buildQuestion, iso, scoreVotes, settle, settlesAfter } from './rules.js';
import type { DayQuestion, DayStore } from './store.js';

/** Something the Discord side posts or updates. */
export type DayEvent = { kind: 'opened' | 'closed' | 'settled'; question: DayQuestion };

const HOUR = 3_600_000;
/** The question posts at 03:00 UTC (after yesterday's result is in) and votes lock at 13:00 UTC, before the US open. */
export const OPEN_HOUR = 3;
export const LOCK_HOUR = 13;

/**
 * The question of the day's clock, run once a minute: posts the day's question on every server that has it
 * on, locks votes at 13:00 UTC, and settles each question from closing prices once its day is over.
 */
export class DayRunner {
  private busy = false;
  /** One question per day, shared by every server. */
  private built = new Map<string, { rule: DayRule; ledger: number }>();
  private lastBuildTry = 0;
  /** When each question was last tried for its result, so missing data isn't fetched every minute. */
  private tried = new Map<number, number>();

  constructor(
    private readonly deps: {
      store: DayStore;
      history: Pick<MarketHistory, 'identify' | 'daily'>;
      now?: () => number;
    },
  ) {}

  private get now(): number {
    return (this.deps.now ?? Date.now)();
  }

  async tick(): Promise<DayEvent[]> {
    if (this.busy) return [];
    this.busy = true;
    try {
      const events: DayEvent[] = [];
      await this.openDue(events);
      for (const q of this.deps.store.toClose(this.now)) {
        if (this.deps.store.close(q.id)) events.push({ kind: 'closed', question: this.deps.store.get(q.id)! });
      }
      await this.settleDue(events);
      return events;
    } finally {
      this.busy = false;
    }
  }

  /**
   * Posts today's question on one server. On schedule that's 03:00 UTC; `force` (an admin trying it out)
   * opens it any time before late evening, with votes open for three hours.
   */
  async open(guildId: string, channelId: string, force = false): Promise<{ question: DayQuestion } | { error: string }> {
    const { store } = this.deps;
    const now = this.now;
    const day = iso(now);
    if (store.forDay(guildId, day)) return { error: "Today's question is already up." };
    let closesAt = at(day) + LOCK_HOUR * HOUR;
    if (now > closesAt - HOUR) {
      if (!force) return { error: "Too late for today's question; the next one comes at 03:00 UTC." };
      closesAt = Math.min(now + 3 * HOUR, at(day) + 23 * HOUR);
      if (closesAt - now < HOUR) return { error: "Too late in the day; the next question comes at 03:00 UTC." };
    }
    const built = await this.question(day);
    if (!built) return { error: "Couldn't load the prices for today's question. Try again in a few minutes." };
    // A stock question opened late would lock after the US open: keep it before 13:30 UTC.
    if (built.rule.stocks) closesAt = Math.min(closesAt, at(day) + 13.5 * HOUR);
    if (closesAt - now < 30 * 60_000) return { error: "Too late for today's market question; the next one comes at 03:00 UTC." };
    const question = store.create({ guildId, channelId, day, opensAt: now, closesAt }, built.rule, built.ledger);
    return question ? { question } : { error: "Today's question is already up." };
  }

  private async question(day: string): Promise<{ rule: DayRule; ledger: number } | null> {
    const cached = this.built.get(day);
    if (cached) return cached;
    const built = await buildQuestion(this.deps.history, day).catch((err: unknown) => (log.warn("Couldn't build today's question", err), null));
    if (built) {
      this.built.clear();
      this.built.set(day, built);
    }
    return built;
  }

  private async openDue(events: DayEvent[]): Promise<void> {
    const { store } = this.deps;
    const now = this.now;
    const day = iso(now);
    if (now < at(day) + OPEN_HOUR * HOUR || now > at(day) + (LOCK_HOUR - 1) * HOUR) return;
    const due = store.servers().filter((s) => !store.forDay(s.guildId, day));
    if (!due.length) return;
    // Missing prices: try again every 15 minutes, not every minute.
    if (!this.built.has(day) && now - this.lastBuildTry < 15 * 60_000) return;
    this.lastBuildTry = now;
    for (const s of due) {
      const opened = await this.open(s.guildId, s.channelId);
      if ('question' in opened) events.push({ kind: 'opened', question: opened.question });
    }
  }

  private async settleDue(events: DayEvent[]): Promise<void> {
    const { store, history } = this.deps;
    const now = this.now;
    for (const q of store.toSettle()) {
      if (now < settlesAfter(q.rule) || now - (this.tried.get(q.id) ?? 0) < 30 * 60_000) continue;
      this.tried.set(q.id, now);
      const outcome = await settle(history, q.rule, now).catch(() => null);
      if (outcome === null) continue;
      if (outcome === 'void') {
        log.warn(`Question ${q.id} voided: no ${q.rule.asset} close for ${q.rule.date}`);
        store.void(q.id, now);
      } else {
        store.settle(q.id, outcome, scoreVotes(outcome, store.votes(q.id)), now);
      }
      events.push({ kind: 'settled', question: store.get(q.id)! });
    }
  }
}
