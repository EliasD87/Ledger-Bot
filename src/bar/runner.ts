import type { MarketHistory } from '../analysis/history.js';
import type { Lang } from '../lang.js';
import { log } from '../log.js';
import type { Measure } from '../theses/measure.js';
import { type BarRule, iso, ledgerSide, levelFor, outcomeOf, reachedLevel, ruleFor, specOf, touches } from './questions.js';
import type { BarChannel, BarQuestion, BarStore } from './store.js';

export type BarEvent = { kind: 'opened' | 'closed' | 'settled'; question: BarQuestion };

const HOUR = 3_600_000;
/**
 * It posts at 13:00 UTC, the hour the most different members are active on CybeReator: morning in Brazil
 * (10:00), evening in China and Japan (21:00, 22:00). Answers stay open for 8 hours, through the 17:00 to
 * 18:00 rush, and it settles 24 hours after posting, just before the next one goes up with the result.
 */
export const OPEN_HOUR = 13;
export const ANSWER_HOURS = 8;
const LATE_HOURS = 6;

/** The bar question's clock, run once a minute: settles yesterday's, closes answers, posts today's. */
export class BarRunner {
  private busy = false;
  private tried = new Map<string, number>();

  constructor(
    private readonly deps: {
      store: BarStore;
      measure: Pick<Measure, 'now'> & Partial<Pick<Measure, 'range'>>;
      history: Pick<MarketHistory, 'identify' | 'daily'> & Partial<Pick<MarketHistory, 'hourly'>>;
      now?: () => number;
    },
  ) {}

  private get now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** `defaults`: channels that get the question without being turned on (the server's chat channels). */
  async tick(defaults: (BarChannel & { guildId: string })[] = []): Promise<BarEvent[]> {
    if (this.busy) return [];
    this.busy = true;
    try {
      const events: BarEvent[] = [];
      const { store } = this.deps;
      await this.watchTouches(events);
      for (const q of store.toClose(this.now)) if (store.close(q.id)) events.push({ kind: 'closed', question: store.get(q.id)! });
      // Yesterday's result first, so today's question can say how it went.
      await this.settleDue(events);
      await this.openDue(events, defaults);
      return events;
    } finally {
      this.busy = false;
    }
  }

  /** Posts today's question in one channel; `force` (an admin trying it) posts it at any hour. */
  async open(guildId: string, channelId: string, lang: Lang, force = false): Promise<{ question: BarQuestion } | { error: string }> {
    const now = this.now;
    const day = iso(now);
    const { store } = this.deps;
    if (store.forDay(channelId, day)) return { error: "Today's question is already up in this channel." };
    if (!force && now < Date.parse(`${day}T00:00:00Z`) + OPEN_HOUR * HOUR) return { error: `It posts at ${OPEN_HOUR}:00 UTC.` };
    const base = ruleFor(day);
    const probe = await this.deps.measure.now(specOf({ ...base, level: 1 })).catch(() => null);
    if (probe === null) return { error: "Couldn't read the price for today's question. It tries again in a few minutes." };
    const level = levelFor(base, probe);
    const rule: BarRule = level !== undefined ? { ...base, level } : base;
    const side = await ledgerSide(this.deps.history, rule, probe).catch(() => null);
    const question = store.create({
      guildId,
      channelId,
      lang,
      day,
      rule,
      startValue: probe,
      ledger: side?.side ?? 1,
      ledgerShare: side?.share ?? 0.5,
      opensAt: now,
      closesAt: now + ANSWER_HOURS * HOUR,
      settlesAt: now + 24 * HOUR,
    });
    return question ? { question } : { error: "Today's question is already up in this channel." };
  }

  private async openDue(events: BarEvent[], defaults: (BarChannel & { guildId: string })[]): Promise<void> {
    const now = this.now;
    const day = iso(now);
    const start = Date.parse(`${day}T00:00:00Z`) + OPEN_HOUR * HOUR;
    // On time, or late by a few hours after a restart; not in the evening, when answers would barely open.
    if (now < start || now > start + LATE_HOURS * HOUR) return;
    // A channel whose last question settles in the next few minutes waits for it, so today's can show the result.
    const waiting = new Set(this.deps.store.toSettle(now + 10 * 60_000).map((q) => q.channelId));
    const turnedOn = this.deps.store.allChannels();
    const channels = [...turnedOn, ...defaults.filter((d) => !turnedOn.some((c) => c.channelId === d.channelId) && !this.deps.store.isOff(d.channelId))];
    for (const c of channels) {
      if (this.deps.store.forDay(c.channelId, day) || waiting.has(c.channelId)) continue;
      const key = `open:${c.channelId}:${day}`;
      if (now - (this.tried.get(key) ?? 0) < 5 * 60_000) continue;
      this.tried.set(key, now);
      const opened = await this.open(c.guildId, c.channelId, c.lang);
      if ('question' in opened) events.push({ kind: 'opened', question: opened.question });
    }
  }

  /**
   * Touch questions: the moment the price gets to the level it counts, so answers close at once (nobody can
   * answer after the fact) and the touch is remembered for the result. One price read per coin a minute.
   */
  private async watchTouches(events: BarEvent[]): Promise<void> {
    const { store, measure } = this.deps;
    const now = this.now;
    const prices = new Map<string, number | null>();
    for (const q of store.unsettled()) {
      if (!touches(q.rule) || now >= q.settlesAt) continue;
      if (!prices.has(q.rule.asset)) prices.set(q.rule.asset, await measure.now(specOf(q.rule)).catch(() => null));
      const price = prices.get(q.rule.asset);
      if (price === null || price === undefined || !reachedLevel(q.rule, price)) continue;
      store.touch(q.id, now);
      if (store.closeNow(q.id, now)) events.push({ kind: 'closed', question: store.get(q.id)! });
    }
  }

  /** Where a question ended up: the 24 hours' high or low for touch questions, else the price now. */
  private async endOf(q: BarQuestion): Promise<number | null> {
    const spec = specOf(q.rule);
    if (touches(q.rule) && this.deps.measure.range) {
      const range = await this.deps.measure.range(spec, q.opensAt, q.settlesAt).catch(() => null);
      if (range) {
        const extreme = q.rule.kind === 'reach' ? range.high : range.low;
        // A touch seen live counts even if the hourly candles round it off.
        return q.touchedAt && !reachedLevel(q.rule, extreme) ? q.rule.level! : extreme;
      }
    }
    const now = await this.deps.measure.now(spec).catch(() => null);
    if (now === null) return null;
    return q.touchedAt && touches(q.rule) && !reachedLevel(q.rule, now) ? q.rule.level! : now;
  }

  private async settleDue(events: BarEvent[]): Promise<void> {
    const { store, measure } = this.deps;
    const now = this.now;
    for (const q of store.toSettle(now)) {
      const key = `settle:${q.id}`;
      if (now - (this.tried.get(key) ?? 0) < 2 * 60_000) continue;
      this.tried.set(key, now);
      const end = await this.endOf(q);
      if (end === null) {
        if (now > q.settlesAt + LATE_HOURS * HOUR) {
          log.warn(`Bar question ${q.id} voided: no price for ${q.rule.asset}`);
          store.void(q.id);
          events.push({ kind: 'settled', question: store.get(q.id)! });
        }
        continue;
      }
      store.settle(q.id, end, outcomeOf(q.rule, q.startValue, end));
      events.push({ kind: 'settled', question: store.get(q.id)! });
    }
  }
}
