/**
 * Commodities (front-month futures) and macro gauges (dollar index, 10-year yield, VIX, S&P 500), priced
 * on Yahoo. Members say "oil", "CL", "gold", "the dollar", "10 year yield"; Ledger shows a plain name
 * (WTI, DXY) and fetches the Yahoo symbol behind it. They trade on weekdays, so the stock windows apply.
 */
interface Commodity {
  /** What Ledger shows and stores. */
  symbol: string;
  /** Yahoo's symbol: front-month futures, or the index. */
  yahoo: string;
  name: string;
  kind: 'commodity' | 'index';
  /** Yields are already percentages: their moves are read in points, not percent. */
  rate?: boolean;
}

const LIST: (Commodity & { says: string[] })[] = [
  { symbol: 'DXY', yahoo: 'DX-Y.NYB', name: 'US dollar index', kind: 'index', says: ['DXY', 'DOLLAR', 'THE DOLLAR', 'US DOLLAR', 'DOLLAR INDEX', 'USD INDEX'] },
  { symbol: 'US10Y', yahoo: '^TNX', name: 'US 10-year Treasury yield', kind: 'index', rate: true, says: ['US10Y', '10Y', 'TNX', '10 YEAR', '10-YEAR', '10 YEAR YIELD', '10-YEAR YIELD', 'TEN YEAR', 'TREASURY YIELD', 'BOND YIELDS', 'YIELDS'] },
  { symbol: 'VIX', yahoo: '^VIX', name: 'VIX volatility index', kind: 'index', says: ['VIX', 'FEAR INDEX', 'VOLATILITY INDEX'] },
  // Not "SPX": on a crypto server that's the SPX6900 coin.
  { symbol: 'SP500', yahoo: '^GSPC', name: 'S&P 500 index', kind: 'index', says: ['SP500', 'S&P', 'S&P 500', 'S&P500', 'SPX500', 'GSPC', 'THE S&P'] },
  { symbol: 'WTI', yahoo: 'CL=F', name: 'WTI crude oil', kind: 'commodity', says: ['WTI', 'CL', 'OIL', 'CRUDE', 'CRUDE OIL', 'WTI CRUDE', 'US OIL', 'USOIL'] },
  { symbol: 'BRENT', yahoo: 'BZ=F', name: 'Brent crude oil', kind: 'commodity', says: ['BRENT', 'BRENT CRUDE', 'BRENT OIL', 'UKOIL'] },
  { symbol: 'GOLD', yahoo: 'GC=F', name: 'gold', kind: 'commodity', says: ['GOLD', 'XAU', 'XAUUSD', 'GC'] },
  { symbol: 'SILVER', yahoo: 'SI=F', name: 'silver', kind: 'commodity', says: ['SILVER', 'XAG', 'XAGUSD', 'SI'] },
  { symbol: 'NATGAS', yahoo: 'NG=F', name: 'natural gas', kind: 'commodity', says: ['NATGAS', 'NATURAL GAS', 'NAT GAS', 'NG'] },
  { symbol: 'COPPER', yahoo: 'HG=F', name: 'copper', kind: 'commodity', says: ['COPPER', 'HG'] },
];

const BY_NAME = new Map(LIST.flatMap((c) => c.says.map((s) => [s, c] as const)));
const BY_SYMBOL = new Map(LIST.map((c) => [c.symbol, c] as const));

/** The commodity a member means by "oil", "crude oil", "CL", "gold"…, or null. */
export function commodity(raw: string): Commodity | null {
  return BY_NAME.get(raw.trim().replace(/^\$/, '').toUpperCase().replace(/\s+/g, ' ')) ?? null;
}

/** The symbol to ask Yahoo for: the futures symbol for a commodity, else the ticker itself. */
export function yahooSymbol(symbol: string): string {
  return BY_SYMBOL.get(symbol)?.yahoo ?? symbol;
}

/** A commodity or a macro gauge (both priced on Yahoo under another symbol). */
export function isCommodity(symbol: string): boolean {
  return BY_SYMBOL.has(symbol);
}

export function marketOf(symbol: string): Commodity | null {
  return BY_SYMBOL.get(symbol) ?? null;
}

/** "WTI (WTI crude oil, front-month futures)" for the model; plain symbol otherwise. */
export function describeSymbol(symbol: string): string {
  const c = BY_SYMBOL.get(symbol);
  return c ? `${c.symbol} (${c.name}${c.kind === 'commodity' ? ', front-month futures' : ''})` : symbol;
}
