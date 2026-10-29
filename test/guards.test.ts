import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index.js';
import { costOf } from '../src/llm/deepseek.js';
import { RateLimiter, Spend, overBudget, startOfUtcDay } from '../src/llm/guards.js';
import { Metrics, ReplyIndex } from '../src/metrics.js';

const MIN = 60_000;

function clock(start: number) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

describe('RateLimiter', () => {
  it('enforces a cooldown between requests', () => {
    const c = clock(0);
    const limiter = new RateLimiter({ cooldownMs: 4000, hourlyLimit: 30 }, c.now);
    expect(limiter.check('u')).toEqual({ ok: true });
    limiter.hit('u');
    c.advance(1000);
    expect(limiter.check('u')).toMatchObject({ ok: false, reason: 'cooldown', retryInMs: 3000 });
    expect(limiter.check('other')).toEqual({ ok: true });
    c.advance(3000);
    expect(limiter.check('u')).toEqual({ ok: true });
  });

  it('caps requests per hour and warns once', () => {
    const c = clock(0);
    const limiter = new RateLimiter({ cooldownMs: 0, hourlyLimit: 3 }, c.now);
    for (let i = 0; i < 3; i++) {
      limiter.hit('u');
      c.advance(MIN);
    }
    expect(limiter.check('u')).toMatchObject({ ok: false, reason: 'hourly', warn: true, retryInMs: 57 * MIN });
    expect(limiter.check('u')).toMatchObject({ ok: false, reason: 'hourly', warn: false });
    c.advance(57 * MIN);
    expect(limiter.check('u')).toEqual({ ok: true });
  });

  it('treats 0 as no limit', () => {
    const limiter = new RateLimiter({ cooldownMs: 0, hourlyLimit: 0 }, () => 0);
    for (let i = 0; i < 100; i++) limiter.hit('u');
    expect(limiter.check('u')).toEqual({ ok: true });
  });
});

describe('costOf', () => {
  const prices = { inputHit: 0.006, inputMiss: 0.3, output: 1.2 };

  it('prices cached and uncached input separately', () => {
    const usage = costOf(
      { prompt_tokens: 3000, completion_tokens: 200, total_tokens: 3200, prompt_cache_hit_tokens: 2000, prompt_cache_miss_tokens: 1000 },
      prices,
    );
    expect(usage).toMatchObject({ cacheHitTokens: 2000, cacheMissTokens: 1000, outputTokens: 200 });
    expect(usage.costUsd).toBeCloseTo((2000 * 0.006 + 1000 * 0.3 + 200 * 1.2) / 1e6, 12);
  });

  it('treats input as uncached when the cache counters are missing', () => {
    expect(costOf({ prompt_tokens: 500, completion_tokens: 0, total_tokens: 500 }, prices).cacheMissTokens).toBe(500);
  });
});

describe('Spend', () => {
  it('sums spend since midnight UTC', () => {
    const c = clock(Date.UTC(2026, 9, 23, 23, 0));
    const spend = new Spend(openDb(':memory:'), c.now);
    const usage = { cacheHitTokens: 0, cacheMissTokens: 0, outputTokens: 0, costUsd: 0.25 };
    spend.record({ purpose: 'chat', model: 'deepseek-flash', usage });
    expect(spend.today()).toBeCloseTo(0.25);
    c.advance(2 * 60 * MIN); // past midnight
    spend.record({ purpose: 'chat', model: 'deepseek-flash', usage });
    expect(spend.today()).toBeCloseTo(0.25);
    expect(spend.since(0)).toBeCloseTo(0.5);
  });

  it('finds the start of the UTC day', () => {
    expect(startOfUtcDay(Date.UTC(2026, 9, 23, 17, 45))).toBe(Date.UTC(2026, 9, 23));
  });
});

describe('Metrics', () => {
  it('summarises engagement', () => {
    const metrics = new Metrics(openDb(':memory:'), () => 1000);
    metrics.record({ type: 'message', userId: 'a', rootId: 'r1' });
    metrics.record({ type: 'message', userId: 'b', rootId: 'r1' });
    metrics.record({ type: 'message', userId: 'a', rootId: 'r2' });
    metrics.record({ type: 'command', userId: 'c', meta: { name: 'odds' } });
    metrics.record({ type: 'limited', userId: 'a', meta: { reason: 'cooldown' } });
    expect(metrics.summary(0)).toEqual({
      messages: 3,
      members: 3,
      conversations: 2,
      groupConversations: 1,
      commands: 1,
      limited: 1,
    });
    expect(metrics.summary(2000).messages).toBe(0);
  });
});

describe('ReplyIndex', () => {
  it('maps Ledger messages to their conversation', () => {
    const replies = new ReplyIndex(openDb(':memory:'));
    replies.remember('bot1', 'root1', 'chan');
    expect(replies.rootOf('bot1')).toBe('root1');
    expect(replies.rootOf('nope')).toBeUndefined();
  });
});

describe('daily cap', () => {
  it('is off at 0, and stops replies once reached otherwise', () => {
    expect(overBudget(500, 0)).toBe(false);
    expect(overBudget(1.99, 2)).toBe(false);
    expect(overBudget(2, 2)).toBe(true);
  });
});
