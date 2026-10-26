/**
 * Commodities, priced from their front-month futures on Yahoo. Members say "oil", "crude", "CL" or "gold";
 * Ledger shows a plain name (WTI, GOLD) and fetches the futures symbol behind it. They're treated like
 * stocks (traded on weekdays), so the stock windows and history apply.
 */
interface Commodity {
  /** What Ledger shows and stores. */
  symbol: string;
  /** Yahoo's front-month futures symbol. */
  yahoo: string;
  name: string;
}

const LIST: (Commodity & { says: string[] })[] = [
  { symbol: 'WTI', yahoo: 'CL=F', name: 'WTI crude oil', says: ['WTI', 'CL', 'OIL', 'CRUDE', 'CRUDE OIL', 'WTI CRUDE', 'US OIL', 'USOIL'] },
  { symbol: 'BRENT', yahoo: 'BZ=F', name: 'Brent crude oil', says: ['BRENT', 'BRENT CRUDE', 'BRENT OIL', 'UKOIL'] },
  { symbol: 'GOLD', yahoo: 'GC=F', name: 'gold', says: ['GOLD', 'XAU', 'XAUUSD', 'GC'] },
  { symbol: 'SILVER', yahoo: 'SI=F', name: 'silver', says: ['SILVER', 'XAG', 'XAGUSD', 'SI'] },
  { symbol: 'NATGAS', yahoo: 'NG=F', name: 'natural gas', says: ['NATGAS', 'NATURAL GAS', 'NAT GAS', 'NG'] },
  { symbol: 'COPPER', yahoo: 'HG=F', name: 'copper', says: ['COPPER', 'HG'] },
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

export function isCommodity(symbol: string): boolean {
  return BY_SYMBOL.has(symbol);
}

/** "WTI (WTI crude oil, front-month futures)" for the model; plain symbol otherwise. */
export function describeSymbol(symbol: string): string {
  const c = BY_SYMBOL.get(symbol);
  return c ? `${c.symbol} (${c.name}, front-month futures)` : symbol;
}
