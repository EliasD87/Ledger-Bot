/**
 * Renders sample charts from live data into a folder, to judge the look without Discord.
 *
 *   npx tsx scripts/chart-samples.ts <outDir>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MarketHistory } from '../src/analysis/history.js';
import { BinanceFeed } from '../src/calls/prices.js';
import { assetsChart, flowsChart, progressChart, thesisChart } from '../src/charts/charts.js';
import { toPng } from '../src/charts/render.js';
import { loadConfig } from '../src/config.js';
import { DataDesk } from '../src/desk/desk.js';
import { TreasuryWatcher } from '../src/desk/treasuries.js';
import { CryptoQuotes } from '../src/quotes.js';
import { SoSoValue } from '../src/sosovalue.js';
import type { ThesisSpec } from '../src/theses/spec.js';
import { claimText } from '../src/theses/spec.js';
import type { Thesis } from '../src/theses/store.js';

const out = process.argv[2] ?? 'chart-samples';
mkdirSync(out, { recursive: true });
const config = loadConfig();
const feed = new BinanceFeed(config.priceFeedUrl);
const crypto = new CryptoQuotes(feed);
const history = new MarketHistory({ resolve: (a) => crypto.resolve(a), binance: feed });
const load = async (s: string) => (await history.daily((await history.identify(s))!))!;
const save = (name: string, svg: string) => {
  const started = Date.now();
  writeFileSync(join(out, name), toPng(svg));
  console.log(`${name} (${Date.now() - started} ms)`);
};

const btc = await load('BTC');
const sol = await load('SOL');
const eth = await load('ETH');
const nvda = await load('NVDA');

save('1-take-btc-100k.png', thesisChart({ kind: 'price', asset: 'BTC', direction: 'up', target: 100_000, horizonDays: 62 }, [btc]));
save('2-take-sol-vs-eth.png', thesisChart({ kind: 'relative', asset: 'SOL', versus: 'ETH', direction: 'up', horizonDays: 7 }, [sol, eth]));
save('3-take-nvda-10pct.png', thesisChart({ kind: 'move', asset: 'NVDA', direction: 'up', pct: 0.1, horizonDays: 38 }, [nvda]));
save('4-analysis-eth-vs-sol.png', assetsChart([eth, sol]));

const spec: ThesisSpec = { kind: 'price', asset: 'BTC', direction: 'up', target: 100_000, horizonDays: 62 };
const now = Date.now();
const logged = now - 20 * 86_400_000;
const startValue = btc.closes.find((c) => Date.parse(`${c.date}T00:00:00Z`) >= logged)?.close ?? btc.closes.at(-1)!.close;
const thesis = {
  id: 12, claim: claimText(spec), spec, status: 'open', startValue, startAt: logged, checkAt: logged + 62 * 86_400_000,
} as Thesis;
save('5-progress-btc.png', progressChart(thesis, [btc], btc.closes.at(-1)!.close, now));

if (config.sosovalueApiKey) {
  const soso = new SoSoValue(config.sosovalueApiKey);
  const desk = new DataDesk(soso, new TreasuryWatcher(soso));
  const flows = await desk.flows('BTC');
  if (flows) save('6-flows-btc.png', flowsChart(flows));
}
