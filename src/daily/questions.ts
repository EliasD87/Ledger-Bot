/**
 * The Daily Question: one tap a day, decided by data.
 *
 * Each question is about one UTC day D. It opens when the previous one closes, and answers close
 * at the daily close time on D (default 13:30 UTC, the US market open). What it measures starts
 * at that moment, so nobody can answer with the result already in view:
 * - etf-flow: the US spot ETF session on D, net inflow or outflow (SoSoValue data, published T+1)
 * - up-down:  an asset from the close time to 00:00 UTC on D+1
 * - versus:   which of two assets gains more over that same window
 */

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** Points for a right answer. A wrong answer costs nothing: this is about showing up and reading the day. */
export const DAILY_POINTS = 25;

export type QuestionKind = 'etf-flow' | 'up-down' | 'versus';
export type Choice = 'a' | 'b';

export interface QuestionSpec {
  kind: QuestionKind;
  day: string;
  /** Assets involved: one for etf-flow and up-down, two for versus. */
  assets: string[];
  prompt: string;
  detail: string;
  options: [string, string];
  closesAt: number;
  /** Price window for up-down and versus. */
  windowEnd: number | null;
}

type Template = { kind: 'etf-flow' | 'up-down'; asset: string } | { kind: 'versus'; a: string; b: string };

/** The week's rotation, by UTC weekday of the day asked about (0 = Sunday). ETF questions only on US trading days. */
const ROTATION: Record<number, Template> = {
  0: { kind: 'versus', a: 'BTC', b: 'ETH' },
  1: { kind: 'etf-flow', asset: 'BTC' },
  2: { kind: 'up-down', asset: 'BTC' },
  3: { kind: 'etf-flow', asset: 'ETH' },
  4: { kind: 'versus', a: 'ETH', b: 'SOL' },
  5: { kind: 'etf-flow', asset: 'BTC' },
  6: { kind: 'up-down', asset: 'SOL' },
};

/** The day the next question should be about: today if its answers close at least an hour from now, else tomorrow. */
export function nextQuestionDay(now: number, closeMinute: number): string {
  const todayClose = startOfDay(now) + closeMinute * MINUTE;
  return isoDay(now < todayClose - 60 * MINUTE ? now : now + DAY);
}

/** Builds the question for a day. Without ETF data, ETF days fall back to up/down on the same asset. */
export function questionFor(day: string, closeMinute: number, etfDataAvailable: boolean): QuestionSpec {
  const dayStart = Date.parse(`${day}T00:00:00Z`);
  const closesAt = dayStart + closeMinute * MINUTE;
  const windowEnd = dayStart + DAY;
  let template = ROTATION[new Date(dayStart).getUTCDay()]!;
  if (template.kind === 'etf-flow' && !etfDataAvailable) template = { kind: 'up-down', asset: template.asset };

  const label = dayLabel(day);
  const close = clockLabel(closeMinute);
  switch (template.kind) {
    case 'etf-flow':
      return {
        kind: 'etf-flow',
        day,
        assets: [template.asset],
        prompt: `${template.asset} spot ETFs on ${label}: net inflow or net outflow?`,
        detail:
          `All US-listed spot ${template.asset} ETFs combined, for the US session on ${label}. ` +
          `Answers close at the opening bell; resolved with SoSoValue's daily flow numbers once they're published.`,
        options: ['Inflow', 'Outflow'],
        closesAt,
        windowEnd: null,
      };
    case 'up-down':
      return {
        kind: 'up-down',
        day,
        assets: [template.asset],
        prompt: `${template.asset} from ${close} to 00:00 UTC on ${label}: up or down?`,
        detail: `Measured from the price when answers close to the UTC daily close.`,
        options: ['Up', 'Down'],
        closesAt,
        windowEnd,
      };
    case 'versus':
      return {
        kind: 'versus',
        day,
        assets: [template.a, template.b],
        prompt: `${template.a} or ${template.b}: which gains more from ${close} to 00:00 UTC on ${label}?`,
        detail: `Percentage change from the moment answers close to the UTC daily close.`,
        options: [template.a, template.b],
        closesAt,
        windowEnd,
      };
  }
}

export type Outcome = { answer: Choice | null; result: string };

/** ETF question: inflow wins on a positive net flow, outflow on a negative one; exactly zero is no answer. */
export function etfOutcome(spec: QuestionSpec, netInflow: number, formatUsd: (n: number) => string): Outcome {
  const answer = netInflow > 0 ? 'a' : netInflow < 0 ? 'b' : null;
  return { answer, result: `${spec.assets[0]} spot ETFs: ${formatUsd(netInflow)} net (SoSoValue).` };
}

/** Up/down question: a flat finish is no answer. */
export function upDownOutcome(spec: QuestionSpec, start: number, end: number, formatPrice: (n: number) => string): Outcome {
  const change = (end - start) / start;
  const answer = end > start ? 'a' : end < start ? 'b' : null;
  return { answer, result: `${spec.assets[0]} ${formatPrice(start)} → ${formatPrice(end)} (${signedPct(change)}).` };
}

/** Versus question: the bigger percentage gain wins; a dead heat is no answer. */
export function versusOutcome(spec: QuestionSpec, changeA: number, changeB: number): Outcome {
  const answer = changeA > changeB ? 'a' : changeB > changeA ? 'b' : null;
  return { answer, result: `${spec.assets[0]} ${signedPct(changeA)} vs ${spec.assets[1]} ${signedPct(changeB)}.` };
}

export function signedPct(fraction: number): string {
  const pct = (fraction * 100).toFixed(2);
  return fraction > 0 ? `+${pct}%` : fraction < 0 ? `−${pct.slice(1)}%` : '0.00%';
}

function startOfDay(ms: number): number {
  return Math.floor(ms / DAY) * DAY;
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** "Fri 24 Oct". */
export function dayLabel(day: string): string {
  return new Date(`${day}T12:00:00Z`)
    .toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
    .replace(',', '');
}

function clockLabel(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}
