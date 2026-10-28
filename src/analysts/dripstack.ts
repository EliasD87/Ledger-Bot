import { log } from '../log.js';

/** One analyst call as the DripStack feed sends it (the fields Ledger uses). */
export interface DripPick {
  date: string;
  ticker: string;
  instrumentType?: string | null;
  asset?: { kind?: string | null; name?: string | null } | null;
  action?: string | null;
  author: string;
  publicationSlug?: string | null;
  publicationTitle?: string | null;
  conviction?: number | null;
  convictionLabel?: string | null;
  evidenceQuote?: string | null;
  speakerIsGuest?: boolean | null;
  sentiment: string;
  timeframe?: string | null;
  priceTarget?: { kind?: string; value?: number | null; valueHigh?: number | null } | null;
  publishedAt: string;
}

/** Plans whose calls are included: anything else would spend credits, so Ledger stays off. */
const INCLUDED_PLANS = new Set(['PRO', 'EXPERT']);
const BASE = 'https://dripstack.com';

/**
 * DripStack's API, read-only and only the parts the plan includes. Requests are spaced so there are never
 * more than 20 a minute (the plans allow 60 or 600). Paid routes (article unlocks, transcripts) are never
 * called. A plan or payment error switches it off until the next restart.
 */
export class DripStack {
  private nextSlot = 0;
  private disabled: string | null = null;

  constructor(
    private readonly deps: {
      apiKey: string;
      fetch?: typeof fetch;
      /** Gap between requests; 3 seconds keeps it at 20 a minute. */
      gapMs?: number;
      now?: () => number;
      sleep?: (ms: number) => Promise<void>;
    },
  ) {}

  get enabled(): boolean {
    return this.disabled === null;
  }

  /** Every call on one or more UTC days, `from` to `to` inclusive (up to 30 days per request). */
  async picks(from: string, to: string): Promise<DripPick[]> {
    const out: DripPick[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const query = new URLSearchParams({ from, to, limitDays: '30', limit: '500' });
      if (cursor) query.set('cursor', cursor);
      const body = (await this.get(`/api/v2/stock-picks?${query}`)) as {
        meta?: { plan?: string };
        picks?: DripPick[];
        pagination?: { nextCursor?: string | null };
      };
      // The response says which plan served it; outside an included plan, stop before anything is spent.
      if (body.meta?.plan && !INCLUDED_PLANS.has(body.meta.plan)) {
        this.disable(`plan ${body.meta.plan} doesn't include analyst calls`);
        throw new Error(this.disabled!);
      }
      out.push(...(body.picks ?? []));
      cursor = body.pagination?.nextCursor ?? null;
      if (!cursor) break;
    }
    return out;
  }

  private async get(path: string): Promise<unknown> {
    if (this.disabled) throw new Error(`DripStack is off: ${this.disabled}`);
    await this.waitTurn();
    const res = await (this.deps.fetch ?? fetch)(`${BASE}${path}`, {
      headers: { Authorization: `Bearer ${this.deps.apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 401 || res.status === 402 || res.status === 403) {
      const body = (await res.json().catch(() => ({}))) as { code?: string };
      this.disable(`${res.status} ${body.code ?? ''}`.trim());
      throw new Error(`DripStack refused the request (${this.disabled})`);
    }
    if (!res.ok) throw new Error(`DripStack ${res.status} for ${path.split('?')[0]}`);
    return res.json();
  }

  /** Spaces requests out: at most one per gap, however many callers there are. */
  private async waitTurn(): Promise<void> {
    const now = (this.deps.now ?? Date.now)();
    const at = Math.max(now, this.nextSlot);
    this.nextSlot = at + (this.deps.gapMs ?? 3_000);
    if (at > now) await (this.deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(at - now);
  }

  private disable(reason: string): void {
    if (!this.disabled) log.warn(`DripStack switched off: ${reason}. Analyst views use what's already stored.`);
    this.disabled = reason;
  }
}
