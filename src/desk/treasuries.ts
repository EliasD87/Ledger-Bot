import { log } from '../log.js';
import type { SoSoValue, TreasuryPurchase } from '../sosovalue.js';

const DAY = 24 * 60 * 60 * 1000;

export interface Purchase extends TreasuryPurchase {
  company: string;
}

/**
 * Keeps a list of recent corporate BTC purchases. SoSoValue has no "latest purchases" endpoint,
 * only per-company history, so this walks every company in the background lane (slowly, so
 * chat lookups never wait) and keeps the last 90 days.
 */
export class TreasuryWatcher {
  private purchases: Purchase[] = [];
  private refreshedAt = 0;
  private running = false;

  constructor(
    private readonly soso: SoSoValue,
    private readonly now: () => number = Date.now,
  ) {}

  get ready(): boolean {
    return this.refreshedAt > 0;
  }

  /** Re-scans every company if the last scan is older than `maxAgeMs`. Never throws. */
  async refreshIfStale(maxAgeMs = 12 * 60 * 60 * 1000): Promise<void> {
    if (this.running || this.now() - this.refreshedAt < maxAgeMs) return;
    this.running = true;
    try {
      const companies = await this.soso.treasuryCompanies();
      const cutoff = isoDate(this.now() - 90 * DAY);
      const found: Purchase[] = [];
      for (const company of companies) {
        try {
          const history = await this.soso.treasuryPurchases(company.ticker, 3, 'background');
          for (const p of history) {
            if (p.date >= cutoff && p.btcAcquired > 0) found.push({ ...p, company: company.name || company.ticker });
          }
        } catch (err) {
          log.debug(`Treasury history for ${company.ticker} failed`, err);
        }
      }
      this.purchases = found.sort((a, b) => b.date.localeCompare(a.date) || b.btcAcquired - a.btcAcquired);
      this.refreshedAt = this.now();
      log.info(`Treasury scan done: ${companies.length} companies, ${found.length} purchases in the last 90 days`);
    } catch (err) {
      log.warn('Treasury scan failed; will retry later', err);
    } finally {
      this.running = false;
    }
  }

  /** Purchases dated within the last `days` days, newest first. */
  recent(days: number): Purchase[] {
    const cutoff = isoDate(this.now() - days * DAY);
    return this.purchases.filter((p) => p.date >= cutoff);
  }
}

export function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
