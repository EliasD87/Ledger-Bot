const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const UNITS: Record<string, number> = { m: MINUTE, h: HOUR, d: DAY, w: 7 * DAY };

/** Parses windows like "45m", "6h", "3d", "2w", "1.5 days" into milliseconds; null if unreadable. */
export function parseDuration(input: string): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(m|mins?|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?)\s*$/i.exec(input);
  if (!match) return null;
  return Number(match[1]) * UNITS[match[2]!.toLowerCase()[0]!]!;
}

/** "3d", "6h", "1d 6h", "45m". */
export function formatDuration(ms: number): string {
  const days = Math.floor(ms / DAY);
  const hours = Math.floor((ms % DAY) / HOUR);
  const minutes = Math.round((ms % HOUR) / MINUTE);
  const parts = [days && `${days}d`, hours && `${hours}h`, !days && minutes && `${minutes}m`].filter(Boolean);
  return parts.join(' ') || '0m';
}

const wholeFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const centsFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const smallFormat = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 6 });

/** "81,862" for BTC-sized prices, "2,404.72" for ETH-sized, "0.0000123457" for tiny ones. */
export function formatPrice(n: number): string {
  if (n >= 10_000) return wholeFormat.format(n);
  return n >= 1000 ? centsFormat.format(n) : smallFormat.format(n);
}

/** Discord timestamp markup: renders in each viewer's own timezone. f = date and time, R = "in 3 days". */
export function discordTime(ms: number, style: 'f' | 'R' | 't' = 'f'): string {
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

/** "Fri 24 Oct 23:59 UTC", for text the model reads. */
export function utcLabel(ms: number): string {
  const d = new Date(ms);
  const day = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  return `${day.replace(',', '')} ${d.toISOString().slice(11, 16)} UTC`;
}

/** "October 2026". */
export function monthLabel(ms: number): string {
  return new Date(ms).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** "+1,241", "−100", "0". */
export function formatPoints(n: number): string {
  if (n === 0) return '0';
  return `${n > 0 ? '+' : '−'}${Math.abs(n).toLocaleString('en-US')}`;
}

/** "$412.3M", "$2.28T", "$950K"; with `signed`, "+$412.3M" / "−$18.2M". */
export function formatUsd(n: number, signed = false): string {
  const abs = Math.abs(n);
  const [value, unit] =
    abs >= 1e12 ? [abs / 1e12, 'T'] : abs >= 1e9 ? [abs / 1e9, 'B'] : abs >= 1e6 ? [abs / 1e6, 'M'] : abs >= 1e3 ? [abs / 1e3, 'K'] : [abs, ''];
  const digits = unit === 'T' || unit === 'B' ? 2 : 1;
  const body = `$${unit ? value.toFixed(digits) : Math.round(value).toLocaleString('en-US')}${unit}`;
  if (!signed || n === 0) return body;
  return `${n > 0 ? '+' : '−'}${body}`;
}

/** "1 member", "3 members". */
export function count(n: number, noun: string): string {
  return `${n} ${n === 1 ? noun : `${noun}s`}`;
}

export function formatChance(p: number): string {
  if (p < 0.001) return '<0.1%';
  return `${(p * 100).toFixed(p < 0.1 ? 1 : 0)}%`;
}
