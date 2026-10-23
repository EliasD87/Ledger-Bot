/**
 * Checks that the scoring can't be farmed. For every day in ~2.3 years of history, it prices
 * hypothetical touch calls (several targets and windows) the way Ledger would, then checks
 * whether price really got there. Each bucket shows the average points per call a member would
 * earn by blindly making every call in it (score = result minus rating). Healthy: every bucket within ±2.
 *
 *   npm run backtest
 */
import { RULES, dailyVolatility, recordTerms, winChance } from '../src/calls/odds.js';
import { BinanceFeed } from '../src/calls/prices.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'DOGEUSDT', 'BNBUSDT', 'XRPUSDT', 'LINKUSDT', 'AVAXUSDT'];
const WINDOWS_DAYS = [1, 3, 7, 14, 30];
const MOVES = [0.02, 0.05, 0.1, 0.2, 0.35, -0.05, -0.1, -0.2];
const BUCKETS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];

const feed = new BinanceFeed(process.env.PRICE_FEED_URL ?? 'https://data-api.binance.vision');
const stats = BUCKETS.map(() => ({ n: 0, predicted: 0, hits: 0, points: 0 }));

for (const symbol of SYMBOLS) {
  const days = await feed.candles(symbol, '1d', { limit: 1000 });
  const closes = days.map((c) => c.close);
  for (let i = 180; i < days.length - 31; i++) {
    // Same volatility rule as BinanceFeed.dailyVol, using only data available on day i.
    const dailyVol = Math.max(dailyVolatility(closes.slice(i - 30, i + 1)), dailyVolatility(closes.slice(i - 180, i + 1)));
    for (const windowDays of WINDOWS_DAYS) {
      for (const move of MOVES) {
        const spot = closes[i]!;
        const target = spot * (1 + move);
        const direction = move > 0 ? 'above' : 'below';
        const chance = winChance({ spot, target, direction, kind: 'touch', dailyVol, days: windowDays });
        if (chance > RULES.maxWinChance || chance < RULES.minWinChance) continue;
        const ahead = days.slice(i + 1, i + 1 + windowDays);
        const hit = direction === 'above' ? ahead.some((c) => c.high >= target) : ahead.some((c) => c.low <= target);
        const bucket = stats[BUCKETS.findLastIndex((b) => chance >= b)]!;
        bucket.n++;
        bucket.predicted += chance;
        bucket.hits += hit ? 1 : 0;
        const terms = recordTerms(chance);
        bucket.points += hit ? terms.payout : -terms.stake;
      }
    }
  }
}

console.log(`chance bucket      calls  predicted   actual   avg points per call`);
stats.forEach((s, i) => {
  if (!s.n) return;
  const label = `${(BUCKETS[i]! * 100).toFixed(0)}%–${((BUCKETS[i + 1] ?? RULES.maxWinChance) * 100).toFixed(0)}%`;
  console.log(
    `${label.padEnd(15)} ${String(s.n).padStart(8)}  ${((s.predicted / s.n) * 100).toFixed(1).padStart(8)}%` +
      ` ${((s.hits / s.n) * 100).toFixed(1).padStart(7)}%  ${(s.points / s.n).toFixed(1).padStart(8)}`,
  );
});
