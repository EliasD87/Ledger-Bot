import { createHash } from 'node:crypto';
import type { Db } from '../db/index.js';
import type { DripPick } from './dripstack.js';

export type Stance = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

/** One stored analyst call. */
export interface AnalystCall {
  day: string;
  ticker: string;
  kind: string | null;
  name: string | null;
  author: string;
  publication: string | null;
  /** The publication's host, e.g. zastocks.com: the link Ledger shows. */
  source: string | null;
  sentiment: Stance;
  action: string | null;
  conviction: number | null;
  convictionLabel: string | null;
  quote: string | null;
  timeframe: string | null;
  target: { kind?: string; value?: number | null; valueHigh?: number | null } | null;
  publishedAt: number;
}

/**
 * What the analysts think of one ticker over a window, counted in code: each analyst once, by their
 * latest call. Podcast guests are left out (they aren't the publication's own coverage).
 */
export interface AnalystView {
  ticker: string;
  name: string | null;
  days: number;
  calls: number;
  analysts: number;
  bullish: number;
  bearish: number;
  neutral: number;
  /** Each analyst's latest call, most confident first. */
  latest: AnalystCall[];
}

/** The split saved with a take when it's tested, for its card (and later for "you vs the analysts"). */
export interface AnalystSnapshot {
  ticker: string;
  days: number;
  analysts: number;
  bullish: number;
  bearish: number;
  neutral: number;
}

/**
 * Ledger's names for commodities and indexes, and the tickers analysts use for them: the ETFs and futures
 * that track them. A bullish call on GLD is a bullish call on gold. Yields aren't mapped: a bond ETF moves
 * the opposite way to its yield.
 */
const ALIASES: Record<string, string[]> = {
  GOLD: ['GLD', 'GC=F', 'IAU'],
  SILVER: ['SLV', 'SI=F'],
  WTI: ['CL=F', 'USO'],
  BRENT: ['BZ=F', 'BNO'],
  NATGAS: ['NG=F', 'UNG'],
  COPPER: ['HG=F', 'CPER'],
  SP500: ['SPX', 'SPY', '^GSPC'],
  VIX: ['VIX', '^VIX'],
  DXY: ['DXY', 'UUP'],
};

/** The tickers whose calls count for one of Ledger's symbols. */
export function analystTickers(symbol: string): string[] {
  const s = symbol.toUpperCase();
  return ALIASES[s] ?? [s];
}

const DAY = 86_400_000;
/** Older calls are dropped: views look back 90 days at most. */
const KEEP_DAYS = 120;
const STANCES = new Set(['BULLISH', 'BEARISH', 'NEUTRAL']);

const COLUMNS = `day, ticker, kind, name, author, publication, source, sentiment, action, conviction, conviction_label AS convictionLabel,
  quote, timeframe, target, published_at AS publishedAt`;

function parse(row: Record<string, unknown>): AnalystCall {
  return { ...(row as unknown as AnalystCall), target: row.target ? (JSON.parse(row.target as string) as AnalystCall['target']) : null };
}

/** Analyst calls synced from DripStack, and the views computed from them. */
export class AnalystStore {
  constructor(private readonly db: Db) {}

  /** Stores calls from the feed; the same call twice is stored once. Returns how many were new. */
  upsert(picks: DripPick[], now: number): number {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO analyst_calls (key, day, ticker, kind, name, author, publication, source, sentiment, action, conviction,
         conviction_label, quote, timeframe, target, guest, published_at, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let added = 0;
    for (const p of picks) {
      const sentiment = p.sentiment?.toUpperCase();
      const published = Date.parse(p.publishedAt);
      if (!p.ticker || !p.author || !STANCES.has(sentiment) || !Number.isFinite(published)) continue;
      const key = createHash('sha1').update([p.publishedAt, p.author, p.ticker, p.publicationSlug, sentiment, p.action, p.evidenceQuote].join('|')).digest('hex');
      const run = insert.run(
        key,
        p.date,
        p.ticker.toUpperCase(),
        p.asset?.kind ?? p.instrumentType ?? null,
        p.asset?.name ?? null,
        p.author,
        p.publicationTitle ?? null,
        p.publicationSlug ?? null,
        sentiment,
        p.action ?? null,
        typeof p.conviction === 'number' ? p.conviction : null,
        p.convictionLabel ?? null,
        p.evidenceQuote ?? null,
        p.timeframe ?? null,
        p.priceTarget && typeof p.priceTarget.value === 'number' ? JSON.stringify(p.priceTarget) : null,
        p.speakerIsGuest ? 1 : 0,
        published,
        now,
      );
      added += Number(run.changes);
    }
    return added;
  }

  prune(now: number): void {
    this.db.prepare('DELETE FROM analyst_calls WHERE published_at < ?').run(now - KEEP_DAYS * DAY);
  }

  /** How many calls are stored, and the newest one. */
  status(): { calls: number; newest: number | null } {
    const row = this.db.prepare('SELECT COUNT(*) AS calls, MAX(published_at) AS newest FROM analyst_calls').get() as { calls: number; newest: number | null };
    return row;
  }

  /** The analysts' view of one ticker (or commodity, through its ETFs and futures) over the last `days` days, or null if nobody covered it. */
  view(ticker: string, days: number, now: number): AnalystView | null {
    const tickers = analystTickers(ticker);
    const rows = (
      this.db
        .prepare(
          `SELECT ${COLUMNS} FROM analyst_calls WHERE ticker IN (${tickers.map(() => '?').join(', ')}) AND guest = 0 AND published_at >= ? ORDER BY published_at DESC`,
        )
        .all(...tickers, now - days * DAY) as Record<string, unknown>[]
    ).map(parse);
    if (!rows.length) return null;
    const latestByAuthor = new Map<string, AnalystCall>();
    for (const r of rows) if (!latestByAuthor.has(r.author)) latestByAuthor.set(r.author, r);
    const latest = [...latestByAuthor.values()].sort((a, b) => (b.conviction ?? 0) - (a.conviction ?? 0) || b.publishedAt - a.publishedAt);
    const count = (s: Stance) => latest.filter((c) => c.sentiment === s).length;
    return {
      ticker: ticker.toUpperCase(),
      // Coins sometimes come with a wrong company name attached (LINK as "Interlink Electronics"): names only for stocks and ETFs.
      name: tickers.length === 1 && (rows[0]!.kind === 'EQUITY' || rows[0]!.kind === 'ETF') ? rows[0]!.name : null,
      days,
      calls: rows.length,
      analysts: latest.length,
      bullish: count('BULLISH'),
      bearish: count('BEARISH'),
      neutral: count('NEUTRAL'),
      latest,
    };
  }

  /** The tickers most analysts talked about over the last `days` days, with their split. */
  trending(days: number, now: number, limit = 8): AnalystView[] {
    const tickers = this.db
      .prepare(
        `SELECT ticker FROM analyst_calls WHERE guest = 0 AND published_at >= ?
         GROUP BY ticker ORDER BY COUNT(DISTINCT author) DESC, COUNT(*) DESC LIMIT ?`,
      )
      .all(now - days * DAY, limit) as { ticker: string }[];
    return tickers.flatMap(({ ticker }) => this.view(ticker, days, now) ?? []);
  }
}

export function snapshotOf(v: AnalystView): AnalystSnapshot {
  return { ticker: v.ticker, days: v.days, analysts: v.analysts, bullish: v.bullish, bearish: v.bearish, neutral: v.neutral };
}

/** A short quote: the first sentence or so, at most `words` words. */
export function shortQuote(quote: string | null, words = 25): string | null {
  if (!quote) return null;
  const clean = quote.replace(/\s+/g, ' ').trim();
  const first = clean.match(/^.{20,}?[.!?](\s|$)/)?.[0]?.trim() ?? clean;
  const parts = first.split(' ');
  return parts.length > words ? `${parts.slice(0, words).join(' ')}…` : first;
}

/** "above 387", "100–199", "around 150": a price target in words. */
export function targetText(t: AnalystCall['target']): string | null {
  if (!t || typeof t.value !== 'number') return null;
  const n = (v: number) => (v >= 1000 ? Math.round(v).toLocaleString('en-US') : Number(v.toFixed(2)).toString());
  if (t.kind === 'range' && typeof t.valueHigh === 'number') return `${n(t.value)}–${n(t.valueHigh)}`;
  if (t.kind === 'above') return `above ${n(t.value)}`;
  if (t.kind === 'below') return `below ${n(t.value)}`;
  return `around ${n(t.value)}`;
}
