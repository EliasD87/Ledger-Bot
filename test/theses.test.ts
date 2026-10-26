import { describe, expect, it } from 'vitest';
import type { Evidence } from '../src/analysis/evidence.js';
import { openDb } from '../src/db/index.js';
import type { ChatModel, CompleteOptions } from '../src/llm/deepseek.js';
import { dayCounts, stressTest, unsupported, verify } from '../src/reasoning/stressTest.js';
import { Measure, ThesisSettler } from '../src/theses/measure.js';
import { type ThesisSpec, claimText, held, specProblem } from '../src/theses/spec.js';
import { type Analysis, ThesisStore } from '../src/theses/store.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 24, 12);
const usage = { cacheHitTokens: 0, cacheMissTokens: 10, outputTokens: 5, costUsd: 0.001 };

const evidence: Evidence = {
  facts: [
    { id: 'F1', text: 'SOL/ETH ratio 0.0412, −8.3% over 30 days, in the 12th percentile of its 1-year range.' },
    { id: 'F2', text: 'SOL 30-day volatility 4.1% a day against a 1-year norm of 3.6%.' },
    { id: 'F3', text: 'Over 938 windows of 30 days, SOL beat ETH in 41% of them (median +1.2%).' },
  ],
  start: 0.0412,
  measure: 'SOL/ETH',
  baseRate: null,
  analogs: null,
  sources: ['Binance'],
  histories: [],
};
const argument = {
  for: [{ point: 'The ratio sits in the 12th percentile of its year: a lot of bad news is already in.', facts: ['F1'] }],
  against: [{ point: 'SOL beat ETH in only 41% of 30-day windows, and the trend is down 8.3%.', facts: ['F1', 'F3'] }],
  kill: 'The ratio losing another leg below 0.0412.',
  history: 'Beat ETH in 41% of 938 similar windows.',
  lean: 'against' as const,
  verdict: 'Cheap for a reason, until it is not.',
};
const analysis: Analysis = { assumptions: ['this month = 7 days'], argument, facts: evidence.facts, sources: ['Binance'] };
const spec: ThesisSpec = { kind: 'relative', asset: 'SOL', versus: 'ETH', direction: 'up', horizonDays: 30 };

describe('thesis specs', () => {
  it('writes the claim in code and checks it', () => {
    expect(claimText(spec)).toBe('SOL beats ETH over a month');
    expect(claimText({ kind: 'price', asset: 'BTC', direction: 'up', target: 100_000, horizonDays: 62 })).toBe('BTC above 100,000 in 62 days');
    expect(claimText({ kind: 'move', asset: 'NVDA', direction: 'up', pct: 0.1, horizonDays: 14 })).toBe('NVDA up 10%+ over 2 weeks');
    expect(claimText({ kind: 'flows', asset: 'ETH', direction: 'down', horizonDays: 7 })).toBe('ETH spot ETFs net outflows over a week');
    expect(specProblem({ ...spec, versus: 'SOL' })).toMatch(/itself/);
    expect(specProblem({ ...spec, horizonDays: 400 })).toMatch(/year/);
    expect(specProblem({ kind: 'price', asset: 'BTC', direction: 'up', horizonDays: 30 })).toMatch(/target/);
  });

  it('settles every kind both ways', () => {
    expect(held(spec, 0.04, 0.0401)).toBe(true);
    expect(held(spec, 0.04, 0.04)).toBe(false);
    expect(held({ ...spec, pct: 0.1 }, 0.04, 0.0439)).toBe(false);
    expect(held({ ...spec, direction: 'down', pct: 0.05 }, 0.04, 0.0379)).toBe(true);
    expect(held({ kind: 'price', asset: 'BTC', direction: 'up', target: 100_000, horizonDays: 30 }, 80_000, 100_000)).toBe(true);
    expect(held({ kind: 'price', asset: 'BTC', direction: 'down', target: 70_000, horizonDays: 30 }, 80_000, 70_001)).toBe(false);
    expect(held({ kind: 'flows', asset: 'BTC', direction: 'down', horizonDays: 7 }, 0, -1)).toBe(true);
  });

  it('gives the model day counts instead of letting it count', () => {
    const text = dayCounts(NOW); // Saturday 24 Oct 2026
    expect(text).toContain('Days to this Sunday: 1.');
    expect(text).toContain('To the end of this month: 7.');
    expect(text).toContain('To Christmas: 62.');
  });
});

describe('the reasoning checks', () => {
  it('passes an argument whose numbers are all in its cited facts', () => {
    const out = verify(argument, evidence, 'SOL beats ETH over a month');
    expect(out.problems).toEqual([]);
    expect(out.argument).toMatchObject({ lean: 'against', for: [{ facts: ['F1'] }] });
  });

  it('drops invented numbers, uncited points and betting words', () => {
    const out = verify(
      {
        ...argument,
        for: [
          { point: 'SOL is up 55% this year.', facts: ['F1'] },
          { point: 'Feels strong.', facts: [] },
          { point: 'Good odds here at the 12th percentile.', facts: ['F1'] },
          { point: 'Volatility is 4.1% a day, above normal.', facts: ['F2'] },
        ],
        verdict: 'A 40% squeeze from here is likely.',
      },
      evidence,
      'SOL beats ETH over a month',
    );
    expect(out.argument?.for.map((p) => p.point)).toEqual(['Volatility is 4.1% a day, above normal.']);
    expect(out.argument?.verdict).toBe('');
    expect(out.problems.join(' ')).toMatch(/55/);
    expect(out.problems.join(' ')).toMatch(/verdict has numbers/);
    expect(out.problems.join(' ')).toMatch(/no valid fact/);
    expect(out.problems.join(' ')).toMatch(/betting/);
  });

  it('keeps fact ids and em dashes off the card', () => {
    const out = verify(
      {
        ...argument,
        for: [
          { point: 'The ratio is in the 12th percentile — a lot is priced in (F1).', facts: ['F1'] },
          { point: 'F2 shows volatility at 4.1% a day.', facts: ['F2'] },
        ],
        history: 'Beat ETH in 41% of 938 windows (F3).',
      },
      evidence,
      'x',
    );
    expect(out.argument?.for.map((p) => p.point)).toEqual(['The ratio is in the 12th percentile, a lot is priced in.']);
    expect(out.argument?.history).toBe('Beat ETH in 41% of 938 windows.');
    expect(out.problems.join(' ')).toMatch(/fact id/);
  });

  it("never guesses the member's gender", () => {
    const out = verify({ ...argument, verdict: 'The base rate is not on his side.' }, evidence, 'x');
    expect(out.argument?.verdict).toBe('');
    expect(out.problems.join(' ')).toMatch(/gender/);
    // "the" and "there" aren't pronouns.
    expect(verify({ ...argument, verdict: 'There is the base rate.' }, evidence, 'x').argument?.verdict).toBe('There is the base rate.');
  });

  it('needs at least one point on each side', () => {
    expect(verify({ ...argument, against: [] }, evidence, 'x').argument).toBeNull();
  });

  it('matches numbers within rounding and allows small counts', () => {
    expect(unsupported('ratio 0.0412, three of 5 days, 938 windows', evidence.facts.map((f) => f.text).join(' '))).toEqual([]);
    expect(unsupported('938,000 windows', '938 windows')).toEqual(['938000']);
  });

  it('runs understand → evidence → argue, and retries once with the problems', async () => {
    const sent: { opts: CompleteOptions; last: string }[] = [];
    const replies = [
      JSON.stringify({ type: 'thesis', spec: { kind: 'relative', asset: '$sol', versus: 'eth', direction: 'up', horizonDays: 8 }, assumptions: ['this month = 8 days'] }),
      JSON.stringify({ ...argument, for: [{ point: 'Up 70% somewhere.', facts: ['F1'] }] }),
      JSON.stringify(argument),
    ];
    const llm: ChatModel = {
      model: 'fake',
      async complete(messages, opts) {
        sent.push({ opts, last: String(messages.at(-1)!.content) });
        return { text: replies[sent.length - 1]!, toolCalls: [], usage };
      },
    };
    let spent = 0;
    const result = await stressTest(
      { llm, evidence: { forThesis: async () => evidence } as never, onUsage: (u) => (spent += u.costUsd), now: () => NOW },
      'sol flips eth this month',
      'kai',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.test.spec).toEqual({ kind: 'relative', asset: 'SOL', versus: 'ETH', direction: 'up', horizonDays: 8 });
    expect(result.test.claim).toBe('SOL beats ETH over 8 days');
    expect(result.test.argument.verdict).toBe(argument.verdict);
    expect(sent.map((s) => [s.opts.json, s.opts.thinking ?? false])).toEqual([[true, false], [true, true], [true, true]]);
    expect(sent[0]!.last).toContain('Days to this Sunday');
    expect(sent[2]!.last).toMatch(/Fix these[\s\S]*70/);
    expect(spent).toBeCloseTo(0.003);
  });

  it('turns small talk and vague takes away without arguing', async () => {
    const llmSaying = (text: string): ChatModel => ({ model: 'fake', complete: async () => ({ text, toolCalls: [], usage }) });
    const deps = (text: string) => ({ llm: llmSaying(text), evidence: {} as never, onUsage: () => {}, now: () => NOW });
    expect(await stressTest(deps('{"type":"not_a_take","why":"a greeting"}'), 'gm', 'kai')).toMatchObject({ ok: false, reason: 'not-a-take' });
    expect(await stressTest(deps('{"type":"needs_detail","question":"Which coin?"}'), 'it pumps', 'kai')).toMatchObject({
      ok: false,
      reason: 'needs-detail',
      message: 'Which coin?',
    });
    expect(await stressTest(deps('{"type":"thesis","spec":{"kind":"price","asset":"BTC","direction":"up","horizonDays":30}}'), 'btc up', 'kai')).toMatchObject({
      ok: false,
      reason: 'needs-detail',
    });
  });
});

describe('the thesis record', () => {
  function setup() {
    const store = new ThesisStore(openDb(':memory:'));
    const draft = (authorId = 'alice', s: ThesisSpec = spec) =>
      store.createDraft({ guildId: 'g', channelId: 'c', authorId, take: 'sol flips eth', claim: claimText(s), spec: s, analysis, now: NOW });
    return { store, draft };
  }

  it('logs a draft once, then checks back after the horizon', () => {
    const { store, draft } = setup();
    const t = draft();
    expect(t).toMatchObject({ status: 'draft', analysis: { argument: { lean: 'against' } } });
    expect(store.log(t.id, 0.0412, NOW)).toBe(true);
    expect(store.log(t.id, 0.05, NOW)).toBe(false);
    expect(store.get(t.id)).toMatchObject({ status: 'open', startValue: 0.0412, checkAt: NOW + 30 * DAY });
    expect(store.due(NOW + 29 * DAY)).toEqual([]);
    expect(store.due(NOW + 30 * DAY).map((x) => x.id)).toEqual([t.id]);
  });

  it('takes sides: not on your own, switching allowed, closed after the check-back', () => {
    const { store, draft } = setup();
    const t = draft();
    expect(store.side(t.id, 'bob', 'with', NOW)).toBe('closed'); // still a draft
    store.log(t.id, 0.0412, NOW);
    expect(store.side(t.id, 'alice', 'against', NOW)).toBe('own');
    expect(store.side(t.id, 'bob', 'with', NOW)).toBe('ok');
    expect(store.side(t.id, 'bob', 'with', NOW)).toBe('same');
    expect(store.side(t.id, 'bob', 'against', NOW + 1)).toBe('switched');
    expect(store.side(t.id, 'cy', 'against', NOW + 2)).toBe('ok');
    expect(store.sides(t.id)).toEqual({ with: [], against: ['bob', 'cy'] });
    store.settle(t.id, 0.045, true, NOW + 30 * DAY);
    expect(store.side(t.id, 'dee', 'with', NOW)).toBe('closed');
  });

  it('keeps records: aged well and badly, contrarian wins, sides read right, best take, leaders', () => {
    const { store, draft } = setup();
    const won = draft();
    store.log(won.id, 0.04, NOW);
    store.side(won.id, 'bob', 'against', NOW);
    store.settle(won.id, 0.046, true, NOW + DAY);
    const lost = draft();
    store.log(lost.id, 0.04, NOW);
    store.side(lost.id, 'bob', 'against', NOW);
    store.settle(lost.id, 0.039, false, NOW + DAY);
    const open = draft();
    store.log(open.id, 0.04, NOW);
    draft(); // a draft never logged doesn't count

    expect(store.record('g', 'alice')).toMatchObject({ logged: 3, agedWell: 1, agedBadly: 1, open: 1, contrarianWins: 1, best: { id: won.id } });
    expect(store.record('g', 'bob')).toMatchObject({ logged: 0, sidesRight: 1, sidesSettled: 2 });
    expect(store.leaders('g', 0)).toEqual([{ userId: 'alice', agedWell: 1, settled: 2 }]);
    expect(store.open('g').map((t) => t.id)).toEqual([open.id]);
    expect(store.sidedBy('g', 'bob').map((s) => s.side)).toEqual(['against', 'against']);
  });

  it('expires unlogged drafts and lets an admin void', () => {
    const { store, draft } = setup();
    const t = draft();
    expect(store.staleDrafts(NOW + 1).map((x) => x.id)).toEqual([t.id]);
    expect(store.cancel(t.id, 'not logged within a day')).toBe(true);
    const u = draft();
    store.log(u.id, 0.04, NOW);
    expect(store.void(u.id, 'bad print', NOW)).toBe(true);
    expect(store.void(u.id, 'again', NOW)).toBe(false);
    expect(store.get(u.id)).toMatchObject({ status: 'void', note: 'bad print' });
  });
});

describe('check-backs', () => {
  function setup(price: Record<string, number | null>, flows: { date: string; totalNetInflow: number }[] = []) {
    const store = new ThesisStore(openDb(':memory:'));
    const history = { identify: async (s: string) => ({ symbol: s, kind: s === 'NVDA' ? 'stock' : 'crypto', pair: `${s}USDT` }) };
    const crypto = { stats24h: async ([pair]: string[]) => ({ [pair!]: { price: price[pair!.replace('USDT', '')] ?? NaN } }) };
    const stocks = { stockQuotes: async ([t]: string[]) => (price[t!] ? { [t!]: { last: price[t!] } } : {}) };
    const desk = { flows: async () => ({ days: flows, latest: flows[0] ?? { date: '2000-01-01' } }) };
    const measure = new Measure({ history: history as never, crypto: crypto as never, stocks: stocks as never, desk: desk as never });
    let now = NOW;
    const settler = new ThesisSettler({ store, measure, now: () => now });
    const logged = (s: ThesisSpec, start: number) => {
      const t = store.createDraft({ guildId: 'g', channelId: 'c', authorId: 'alice', take: 'x', claim: claimText(s), spec: s, analysis, now: NOW });
      store.log(t.id, start, NOW);
      return t.id;
    };
    return { store, measure, settler, logged, at: (ms: number) => (now = ms) };
  }

  it('measures prices and ratios live, crypto and stocks', async () => {
    const { measure } = setup({ SOL: 180, ETH: 4000, NVDA: 212 });
    expect(await measure.now(spec)).toBeCloseTo(0.045);
    expect(await measure.price('NVDA')).toBe(212);
  });

  it('settles on the date and posts nothing early', async () => {
    const { store, settler, logged, at } = setup({ SOL: 180, ETH: 4000 });
    const id = logged(spec, 0.04);
    at(NOW + 29 * DAY);
    expect((await settler.tick()).settled).toEqual([]);
    at(NOW + 30 * DAY + 60_000);
    const { settled } = await settler.tick();
    expect(settled).toMatchObject([{ held: true, endValue: 0.045, thesis: { id, status: 'aged_well' } }]);
    expect(store.get(id)!.endValue).toBeCloseTo(0.045);
    expect((await settler.tick()).settled).toEqual([]);
  });

  it('waits for missing data, then voids after 5 days', async () => {
    const { store, settler, logged, at } = setup({ SOL: null, ETH: 4000 });
    const id = logged(spec, 0.04);
    at(NOW + 31 * DAY);
    expect(await settler.tick()).toEqual({ settled: [], voided: [] });
    at(NOW + 36 * DAY);
    expect((await settler.tick()).voided.map((t) => t.id)).toEqual([id]);
    expect(store.get(id)!.status).toBe('void');
  });

  it('sums ETF flows over the window once the last session is published', async () => {
    const day = (d: number, v: number) => ({ date: `2026-10-${d}`, totalNetInflow: v });
    const flowSpec: ThesisSpec = { kind: 'flows', asset: 'BTC', direction: 'up', horizonDays: 7 }; // logged Sat 24 Oct, checks Sat 31 Oct
    const early = setup({}, [day(29, 50e6), day(28, -20e6), day(27, 40e6), day(23, -999e6)]);
    early.logged(flowSpec, 0);
    early.at(NOW + 7 * DAY);
    expect((await early.settler.tick()).settled).toEqual([]); // Fri 30 Oct not published yet
    const ready = setup({}, [day(30, -10e6), day(29, 50e6), day(28, -20e6), day(27, 40e6), day(23, -999e6)]);
    ready.logged(flowSpec, 0);
    ready.at(NOW + 7 * DAY);
    expect((await ready.settler.tick()).settled).toMatchObject([{ held: true, endValue: 60e6 }]);
  });
});
