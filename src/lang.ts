/**
 * The two languages Ledger's takes, cards and charts come in. Chat replies follow whatever language the
 * member writes in (the model handles that); the fixed text on cards and charts is English unless the
 * member wrote in Chinese.
 */
export type Lang = 'en' | 'zh';

const HAN = /[㐀-䶿一-鿿豈-﫿]/g;

/** Chinese when the text is mostly Chinese characters (tickers and numbers mixed in are fine). */
export function langOf(text: string): Lang {
  const han = text.match(HAN)?.length ?? 0;
  const latin = text.match(/[A-Za-z]/g)?.length ?? 0;
  // Tickers ("BTC", "ETH") and an English word or two don't make a Chinese message English.
  return han >= 2 && han * 2 >= latin ? 'zh' : 'en';
}

/** Whether a string has any Chinese characters (for picking fonts). */
export function hasHan(text: string): boolean {
  return /[㐀-䶿一-鿿豈-﫿]/.test(text);
}
