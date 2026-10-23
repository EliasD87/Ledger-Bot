import type { Db } from '../db/index.js';
import type { Usage } from './deepseek.js';

const HOUR = 60 * 60 * 1000;

export type Verdict =
  | { ok: true }
  | { ok: false; reason: 'cooldown' | 'hourly'; retryInMs: number; /** true at most once per hour per user */ warn: boolean };

/** Per-user request limits, kept in memory (a restart resets them, which is fine). 0 switches a limit off. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly warnedAt = new Map<string, number>();

  constructor(
    private readonly opts: { cooldownMs: number; hourlyLimit: number },
    private readonly now: () => number = Date.now,
  ) {}

  check(userId: string): Verdict {
    const t = this.now();
    const recent = this.recentHits(userId, t);
    const last = recent.at(-1);
    if (last !== undefined && t - last < this.opts.cooldownMs) {
      return { ok: false, reason: 'cooldown', retryInMs: this.opts.cooldownMs - (t - last), warn: false };
    }
    if (this.opts.hourlyLimit > 0 && recent.length >= this.opts.hourlyLimit) {
      const warn = t - (this.warnedAt.get(userId) ?? -Infinity) >= HOUR;
      if (warn) this.warnedAt.set(userId, t);
      return { ok: false, reason: 'hourly', retryInMs: HOUR - (t - recent[0]!), warn };
    }
    return { ok: true };
  }

  /** Counts a request against the user's limits. */
  hit(userId: string): void {
    const t = this.now();
    this.recentHits(userId, t).push(t);
    if (this.hits.size > 5000) this.sweep(t);
  }

  private recentHits(userId: string, t: number): number[] {
    const recent = (this.hits.get(userId) ?? []).filter((ts) => t - ts < HOUR);
    this.hits.set(userId, recent);
    return recent;
  }

  private sweep(t: number): void {
    for (const [userId, times] of this.hits) {
      if (times.every((ts) => t - ts >= HOUR)) this.hits.delete(userId);
    }
  }
}

/** Records what each LLM call cost and answers "how much have we spent". */
export class Spend {
  private readonly insert;
  private readonly sumSince;

  constructor(db: Db, private readonly now: () => number = Date.now) {
    this.insert = db.prepare(
      `INSERT INTO llm_usage (ts, purpose, model, user_id, guild_id, cache_hit_tokens, cache_miss_tokens, output_tokens, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.sumSince = db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM llm_usage WHERE ts >= ?');
  }

  record(entry: { purpose: string; model: string; userId?: string; guildId?: string; usage: Usage }): void {
    const { usage } = entry;
    this.insert.run(
      this.now(), entry.purpose, entry.model, entry.userId ?? null, entry.guildId ?? null,
      usage.cacheHitTokens, usage.cacheMissTokens, usage.outputTokens, usage.costUsd,
    );
  }

  since(ms: number): number {
    return (this.sumSince.get(ms) as { usd: number }).usd;
  }

  /** Spend since 00:00 UTC today. */
  today(): number {
    return this.since(startOfUtcDay(this.now()));
  }
}

export function startOfUtcDay(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
