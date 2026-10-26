import { log } from '../log.js';

export interface Headline {
  title: string;
  /** The outlet: Reuters, WSJ, CNBC… */
  source: string;
  link: string;
  publishedAt: number;
}

const MINUTE = 60_000;
const UA = { 'user-agent': 'Mozilla/5.0 (Ledger Discord bot)' };

/**
 * World news for anything SoSoValue's crypto feed doesn't cover: stocks, oil, gold, the Fed, geopolitics.
 * Google News search (current, many outlets), with Yahoo Finance's news search as the backup. Cached for
 * 15 minutes per query.
 */
export class WebNews {
  private readonly cache = new Map<string, { items: Headline[]; at: number }>();

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** Recent headlines for a search, newest first. */
  async search(query: string, opts: { days?: number; limit?: number } = {}): Promise<Headline[]> {
    const days = Math.min(30, Math.max(1, Math.round(opts.days ?? 3)));
    const limit = opts.limit ?? 8;
    const key = `${query.toLowerCase().trim()}|${days}`;
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.at < 15 * MINUTE) return cached.items.slice(0, limit);
    let items: Headline[] = [];
    for (const source of [() => this.google(query, days), () => this.yahoo(query, days)]) {
      try {
        items = await source();
        if (items.length) break;
      } catch (err) {
        log.debug(`News search for "${query}" failed on one source`, err);
      }
    }
    // Same story from several outlets: keep the first of each title.
    const seen = new Set<string>();
    items = items
      .filter((h) => {
        const k = h.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').slice(0, 60);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .sort((a, b) => b.publishedAt - a.publishedAt);
    if (items.length) this.cache.set(key, { items, at: this.now() });
    return items.slice(0, limit);
  }

  /** Headlines published on one day (or the day after, for late moves), for matching news to a move. */
  async onDay(query: string, isoDate: string, limit = 3): Promise<Headline[]> {
    const day = Date.parse(`${isoDate}T00:00:00Z`);
    const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const key = `day:${query.toLowerCase().trim()}|${isoDate}`;
    const cached = this.cache.get(key);
    // Past days don't change: keep them for a day.
    if (cached && this.now() - cached.at < 24 * 60 * MINUTE) return cached.items.slice(0, limit);
    let items: Headline[] = [];
    try {
      items = (await this.google(`${query} after:${iso(day - 86_400_000)} before:${iso(day + 2 * 86_400_000)}`, 0)).filter(
        (h) => h.publishedAt >= day - 6 * 3_600_000 && h.publishedAt < day + 2 * 86_400_000,
      );
    } catch (err) {
      log.debug(`News for "${query}" on ${isoDate} failed`, err);
      return [];
    }
    // Price-relevant first: headlines that mention the market moving.
    const moving = /price|rall|surg|jump|soar|climb|gain|rise|fall|drop|slid|slump|plung|tumbl|sink|rebound|sell-?off|crash|spike|record/i;
    items.sort((a, b) => Number(moving.test(b.title)) - Number(moving.test(a.title)) || a.publishedAt - b.publishedAt);
    this.cache.set(key, { items, at: this.now() });
    return items.slice(0, limit);
  }

  private async google(query: string, days: number): Promise<Headline[]> {
    // days = 0: the query carries its own date range (after:/before:).
    const q = days > 0 ? `${query} when:${days}d` : query;
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
    const res = await this.fetchImpl(url, { headers: UA, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Google News returned HTTP ${res.status}`);
    const xml = await res.text();
    return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].flatMap((m) => {
      const item = m[1]!;
      const tag = (name: string) => unescape(item.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[1] ?? '');
      const raw = tag('source');
      const source = /^https?:\/\//.test(raw) ? raw.replace(/^https?:\/\/(www\.)?/, '').replace(/\/.*$/, '') : raw;
      // Google appends " - Outlet" to every title.
      const title = tag('title').replace(new RegExp(`\\s+-\\s+${escapeRegExp(source)}$`), '').trim();
      const publishedAt = Date.parse(tag('pubDate'));
      return title && Number.isFinite(publishedAt) ? [{ title, source, link: tag('link'), publishedAt }] : [];
    });
  }

  private async yahoo(query: string, days: number): Promise<Headline[]> {
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=0&newsCount=10`;
    const res = await this.fetchImpl(url, { headers: { ...UA, accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Yahoo news returned HTTP ${res.status}`);
    const body = (await res.json()) as { news?: { title?: string; publisher?: string; link?: string; providerPublishTime?: number }[] };
    const since = this.now() - days * 24 * 60 * MINUTE;
    return (body.news ?? []).flatMap((n) =>
      n.title && n.providerPublishTime && n.providerPublishTime * 1000 >= since
        ? [{ title: n.title, source: n.publisher ?? 'Yahoo Finance', link: n.link ?? '', publishedAt: n.providerPublishTime * 1000 }]
        : [],
    );
  }
}

/** What to search for an asset: plain names for commodities and indexes, "<ticker> stock" for companies. */
export function newsQuery(symbol: string, crypto = false): string {
  const named: Record<string, string> = {
    WTI: 'crude oil',
    BRENT: 'Brent crude oil',
    GOLD: 'gold price',
    SILVER: 'silver price',
    NATGAS: 'natural gas prices',
    COPPER: 'copper price',
    SPY: 'S&P 500',
    QQQ: 'Nasdaq 100',
    SP500: 'S&P 500',
    DXY: 'US dollar index',
    US10Y: '10-year Treasury yield',
    VIX: 'VIX volatility',
  };
  const coins: Record<string, string> = { BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', XRP: 'XRP crypto', DOGE: 'dogecoin', GRAM: 'Toncoin GRAM' };
  return named[symbol] ?? coins[symbol] ?? (crypto ? `${symbol} crypto` : `${symbol} stock`);
}

function unescape(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
