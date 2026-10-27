/**
 * Ledger's charts, drawn as SVG by hand: one quiet style that matches the cards (dark panel, soft
 * colours, no red/green alarm), sized for a Discord card. Pure functions; render.ts turns them into PNGs.
 */

export const WIDTH = 800;
export const HEIGHT = 300;

export const INK = {
  panel: '#1e1f23',
  grid: '#2c2e34',
  axis: '#8b8f98',
  title: '#e6e7ea',
  sub: '#9a9ea7',
  main: '#8ea2ff',
  avg50: '#c9a46a',
  avg200: '#6f8f78',
  target: '#f0b232',
  up: '#7e9c84',
  down: '#a8797a',
} as const;

const PAD = { top: 58, right: 74, bottom: 34, left: 18 };
const FONT = "'IBM Plex Sans', sans-serif";

export interface Point {
  /** Milliseconds since the epoch. */
  t: number;
  v: number;
}

export interface Line {
  points: Point[];
  color: string;
  label?: string;
  width?: number;
  dash?: boolean;
  /** A soft fill under the line (the main series only). */
  fill?: boolean;
}

export interface Level {
  v: number;
  label: string;
  color: string;
}

export interface Mark {
  t: number;
  label: string;
}

export interface LineChart {
  title: string;
  subtitle?: string;
  lines: Line[];
  levels?: Level[];
  marks?: Mark[];
  format: (v: number) => string;
  /** Small print, bottom right: the source. */
  note?: string;
  /** Extend the time axis to here (e.g. a check-back date still ahead). */
  xEnd?: number;
  /** Numbered markers on the main line: the days an event map talks about. */
  dots?: { t: number; label: string }[];
  /** The typical range ahead: a soft wedge from today's value to the low/high band at a future date. */
  cone?: { t0: number; v0: number; t1: number; lo: number; hi: number; label: string };
}

/** A line chart: the measured series, its averages, a target and markers, with a label on the latest value. */
export function lineChart(c: LineChart): string {
  const all = c.lines.flatMap((l) => l.points);
  if (all.length < 2) return emptyChart(c.title, 'Not enough history to draw.');
  const t0 = Math.min(...all.map((p) => p.t));
  const t1 = Math.max(c.xEnd ?? 0, ...all.map((p) => p.t));
  const values = [...all.map((p) => p.v), ...(c.levels ?? []).map((l) => l.v), ...(c.cone ? [c.cone.lo, c.cone.hi] : [])];
  const [lo, hi] = niceRange(Math.min(...values), Math.max(...values));
  const x = (t: number) => PAD.left + ((t - t0) / Math.max(1, t1 - t0)) * (WIDTH - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * (HEIGHT - PAD.top - PAD.bottom);

  const parts: string[] = [];
  const tagY = y(c.lines[0]!.points.at(-1)?.v ?? lo);
  for (const v of ticks(lo, hi)) {
    parts.push(`<line x1="${PAD.left}" x2="${WIDTH - PAD.right}" y1="${f(y(v))}" y2="${f(y(v))}" stroke="${INK.grid}" stroke-width="1"/>`);
    if (Math.abs(y(v) - tagY) > 16) parts.push(text(WIDTH - PAD.right + 8, y(v) + 4, c.format(v), { size: 11, color: INK.axis }));
  }
  for (const m of timeTicks(t0, t1)) {
    parts.push(text(x(m.t), HEIGHT - 12, m.label, { size: 11, color: INK.axis, anchor: 'middle' }));
  }
  for (const m of c.marks ?? []) {
    const mx = x(Math.min(Math.max(m.t, t0), t1));
    parts.push(`<line x1="${f(mx)}" x2="${f(mx)}" y1="${PAD.top - 4}" y2="${HEIGHT - PAD.bottom}" stroke="${INK.sub}" stroke-width="1" stroke-dasharray="2 4"/>`);
    const fits = mx + 5 + textWidth(m.label, 11) < WIDTH - 8;
    parts.push(text(fits ? mx + 5 : mx - 5, PAD.top + 8, m.label, { size: 11, color: INK.sub, anchor: fits ? 'start' : 'end' }));
  }
  let coneLabel = '';
  if (c.cone) {
    const k = c.cone;
    const [x0, y0, x1, yHi, yLo] = [x(k.t0), y(k.v0), x(k.t1), y(k.hi), y(k.lo)];
    parts.push(`<path d="M${f(x0)} ${f(y0)} L${f(x1)} ${f(yHi)} L${f(x1)} ${f(yLo)} Z" fill="${INK.main}" fill-opacity="0.10"/>`);
    parts.push(`<path d="M${f(x0)} ${f(y0)} L${f(x1)} ${f(yHi)} M${f(x0)} ${f(y0)} L${f(x1)} ${f(yLo)}" stroke="${INK.main}" stroke-opacity="0.45" stroke-width="1" stroke-dasharray="3 4" fill="none"/>`);
    const w = textWidth(k.label, 10) + 8;
    if (x1 - w - 4 > x0) {
      // Under the band if there's room, else above it; on a backing so dashed lines don't cut through.
      const ty = yLo + 16 < HEIGHT - PAD.bottom ? yLo + 14 : yHi - 8;
      coneLabel = `<rect x="${f(x1 - w - 4)}" y="${f(ty - 11)}" width="${f(w)}" height="15" rx="4" fill="${INK.panel}"/>` + text(x1 - 8, ty, k.label, { size: 10, color: INK.sub, anchor: 'end' });
    }
  }
  const labels: string[] = [];
  for (const l of c.levels ?? []) {
    parts.push(`<line x1="${PAD.left}" x2="${WIDTH - PAD.right}" y1="${f(y(l.v))}" y2="${f(y(l.v))}" stroke="${l.color}" stroke-width="1.5" stroke-dasharray="6 5"/>`);
    labels.push(tag(PAD.left + 8, y(l.v), l.label, l.color));
  }
  // Averages first, the main line last so it sits on top.
  for (const l of [...c.lines].reverse()) {
    if (l.points.length < 2) continue;
    const d = l.points.map((p, i) => `${i ? 'L' : 'M'}${f(x(p.t))} ${f(y(p.v))}`).join(' ');
    if (l.fill) {
      const base = f(HEIGHT - PAD.bottom);
      parts.push(`<path d="${d} L${f(x(l.points.at(-1)!.t))} ${base} L${f(x(l.points[0]!.t))} ${base} Z" fill="url(#fade)"/>`);
    }
    parts.push(
      `<path d="${d}" fill="none" stroke="${l.color}" stroke-width="${l.width ?? 1.5}" stroke-linejoin="round" stroke-linecap="round"${l.dash ? ' stroke-dasharray="5 4"' : ''}/>`,
    );
  }
  parts.push(...labels);
  if (coneLabel) parts.push(coneLabel);
  // Event markers sit on the main line at their day, numbered to match the reply.
  for (const d of c.dots ?? []) {
    const line = c.lines[0]!.points;
    const p = line.reduce((best, q) => (Math.abs(q.t - d.t) < Math.abs(best.t - d.t) ? q : best), line[0]!);
    const cx = x(p.t);
    const cy = y(p.v);
    const above = cy - 18 > PAD.top;
    const ly = above ? cy - 16 : cy + 16;
    parts.push(`<line x1="${f(cx)}" x2="${f(cx)}" y1="${f(cy)}" y2="${f(ly)}" stroke="${INK.target}" stroke-width="1"/>`);
    parts.push(`<circle cx="${f(cx)}" cy="${f(cy)}" r="3" fill="${INK.target}"/>`);
    parts.push(`<circle cx="${f(cx)}" cy="${f(ly)}" r="9" fill="${INK.panel}" stroke="${INK.target}" stroke-width="1.5"/>`);
    parts.push(text(cx, ly + 4, d.label, { size: 11, color: INK.target, weight: 600, anchor: 'middle' }));
  }
  const main = c.lines[0]!;
  const last = main.points.at(-1)!;
  parts.push(`<circle cx="${f(x(last.t))}" cy="${f(y(last.v))}" r="4" fill="${main.color}" stroke="${INK.panel}" stroke-width="2"/>`);
  parts.push(pill(WIDTH - PAD.right + 4, y(last.v), c.format(last.v), main.color));

  const legend = c.lines.filter((l) => l.label).map((l) => ({ label: l.label!, color: l.color, dash: l.dash }));
  return frame(c.title, c.subtitle, [...parts, ...legendItems(legend)], c.note, main.color);
}

export interface Bar {
  t: number;
  v: number;
}

export interface BarChart {
  title: string;
  subtitle?: string;
  bars: Bar[];
  format: (v: number) => string;
  note?: string;
}

/** Daily bars around zero (ETF flows): inflows sage, outflows rose, the latest labelled. */
export function barChart(c: BarChart): string {
  if (!c.bars.length) return emptyChart(c.title, 'No sessions to draw yet.');
  const values = c.bars.map((b) => b.v);
  const [lo, hi] = niceRange(Math.min(0, ...values), Math.max(0, ...values));
  const innerW = WIDTH - PAD.left - PAD.right;
  const step = innerW / c.bars.length;
  const barW = Math.max(3, Math.min(26, step * 0.68));
  const y = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * (HEIGHT - PAD.top - PAD.bottom);

  const parts: string[] = [];
  const tagY = y(c.bars.at(-1)!.v);
  for (const v of ticks(lo, hi)) {
    parts.push(`<line x1="${PAD.left}" x2="${WIDTH - PAD.right}" y1="${f(y(v))}" y2="${f(y(v))}" stroke="${v === 0 ? INK.axis : INK.grid}" stroke-width="1"/>`);
    if (Math.abs(y(v) - tagY) > 16) parts.push(text(WIDTH - PAD.right + 8, y(v) + 4, c.format(v), { size: 11, color: INK.axis }));
  }
  c.bars.forEach((b, i) => {
    const cx = PAD.left + step * (i + 0.5);
    const top = y(Math.max(0, b.v));
    const h = Math.max(1, Math.abs(y(b.v) - y(0)));
    const latest = i === c.bars.length - 1;
    parts.push(
      `<rect x="${f(cx - barW / 2)}" y="${f(top)}" width="${f(barW)}" height="${f(h)}" rx="2" fill="${b.v >= 0 ? INK.up : INK.down}"${latest ? '' : ' fill-opacity="0.8"'}/>`,
    );
  });
  // Date labels: about six across, always the latest.
  const every = Math.max(1, Math.ceil(c.bars.length / 6));
  c.bars.forEach((b, i) => {
    if ((c.bars.length - 1 - i) % every !== 0) return;
    const d = new Date(b.t);
    parts.push(text(PAD.left + step * (i + 0.5), HEIGHT - 12, `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`, { size: 11, color: INK.axis, anchor: 'middle' }));
  });
  const last = c.bars.at(-1)!;
  parts.push(pill(WIDTH - PAD.right + 4, y(last.v), c.format(last.v), last.v >= 0 ? INK.up : INK.down));
  return frame(c.title, c.subtitle, parts, c.note, INK.main);
}

export function emptyChart(title: string, message: string): string {
  return frame(title, undefined, [text(WIDTH / 2, HEIGHT / 2 + 10, message, { size: 14, color: INK.sub, anchor: 'middle' })], undefined, INK.main);
}

// --- pieces ---

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function frame(title: string, subtitle: string | undefined, body: string[], note: string | undefined, fade: string): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" font-family="${FONT}">`,
    `<defs><linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${fade}" stop-opacity="0.22"/><stop offset="1" stop-color="${fade}" stop-opacity="0"/></linearGradient></defs>`,
    `<rect width="${WIDTH}" height="${HEIGHT}" rx="14" fill="${INK.panel}"/>`,
    text(PAD.left + 2, 26, title, { size: 16, color: INK.title, weight: 600 }),
    subtitle ? text(PAD.left + 2, 45, subtitle, { size: 12, color: INK.sub }) : '',
    ...body,
    note ? text(WIDTH - 12, HEIGHT - 12, note, { size: 10, color: INK.grid === '#2c2e34' ? '#5c6068' : INK.sub, anchor: 'end' }) : '',
    '</svg>',
  ].join('');
}

function legendItems(items: { label: string; color: string; dash?: boolean }[]): string[] {
  const out: string[] = [];
  let right = WIDTH - 14;
  for (const item of [...items].reverse()) {
    const w = textWidth(item.label, 11);
    out.push(text(right, 26, item.label, { size: 11, color: INK.sub, anchor: 'end' }));
    right -= w + 6;
    out.push(`<line x1="${f(right - 16)}" x2="${f(right)}" y1="22" y2="22" stroke="${item.color}" stroke-width="2"${item.dash ? ' stroke-dasharray="4 3"' : ''}/>`);
    right -= 30;
  }
  return out;
}

/** A level's label sitting on its line, on a panel-coloured backing so lines behind it don't cut through. */
function tag(xLeft: number, yLine: number, label: string, color: string): string {
  const w = textWidth(label, 11) + 10;
  return (
    `<rect x="${f(xLeft)}" y="${f(yLine - 9)}" width="${f(w)}" height="18" rx="5" fill="${INK.panel}" stroke="${color}" stroke-opacity="0.5"/>` +
    text(xLeft + 5, yLine + 4, label, { size: 11, color })
  );
}

/** The latest value in a rounded tag on the right axis. */
function pill(xLeft: number, yMid: number, label: string, color: string): string {
  const w = textWidth(label, 11) + 12;
  const top = Math.min(Math.max(yMid - 10, PAD.top - 12), HEIGHT - PAD.bottom - 10);
  return (
    `<rect x="${f(xLeft)}" y="${f(top)}" width="${f(w)}" height="20" rx="6" fill="${color}"/>` +
    text(xLeft + 6, top + 14, label, { size: 11, color: INK.panel, weight: 600 })
  );
}

function text(x: number, y: number, s: string, o: { size: number; color: string; weight?: number; anchor?: 'start' | 'middle' | 'end' }): string {
  return `<text x="${f(x)}" y="${f(y)}" font-size="${o.size}" fill="${o.color}"${o.weight ? ` font-weight="${o.weight}"` : ''}${o.anchor ? ` text-anchor="${o.anchor}"` : ''}>${escape(s)}</text>`;
}

/** Rough width of a label in IBM Plex Sans, enough to place legends and tags. */
function textWidth(s: string, size: number): number {
  return s.length * size * 0.56;
}

function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const f = (n: number) => (Math.round(n * 10) / 10).toString();

/** Bounds with a little air, snapped to round steps. */
export function niceRange(min: number, max: number): [number, number] {
  if (min === max) {
    const pad = Math.abs(min) * 0.05 || 1;
    return [min - pad, max + pad];
  }
  const step = niceStep((max - min) / 4);
  const lo = Math.floor((min - (max - min) * 0.04) / step) * step;
  const hi = Math.ceil((max + (max - min) * 0.04) / step) * step;
  return [lo, hi];
}

function niceStep(raw: number): number {
  const p = 10 ** Math.floor(Math.log10(raw));
  const n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

export function ticks(lo: number, hi: number): number[] {
  const step = niceStep((hi - lo) / 4);
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

/** Axis labels that suit the span: days (and hours) for short windows, months for long ones. */
function timeTicks(t0: number, t1: number): { t: number; label: string }[] {
  const days = (t1 - t0) / 86_400_000;
  if (days > 50) return monthTicks(t0, t1);
  const step = days <= 2 ? 0.25 : days <= 8 ? 1 : days <= 16 ? 2 : days <= 32 ? 5 : 7;
  const out: { t: number; label: string }[] = [];
  const first = Math.ceil(t0 / (step * 86_400_000)) * step * 86_400_000;
  for (let t = first; t <= t1; t += step * 86_400_000) {
    const share = (t - t0) / (t1 - t0);
    if (share < 0.04 || share > 0.96) continue;
    const d = new Date(t);
    out.push({ t, label: step < 1 ? `${String(d.getUTCHours()).padStart(2, '0')}:00` : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}` });
  }
  return out;
}

/** Month starts across the range: every month for short spans, every 2nd or 3rd for longer ones. */
function monthTicks(t0: number, t1: number): { t: number; label: string }[] {
  const months = (t1 - t0) / (30 * 86_400_000);
  const every = months > 8 ? 2 : 1;
  const out: { t: number; label: string }[] = [];
  const d = new Date(t0);
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth() + 1;
  for (;;) {
    if (m > 11) {
      m = 0;
      y++;
    }
    const t = Date.UTC(y, m, 1);
    if (t > t1) break;
    // Keep labels clear of the edges.
    const share = (t - t0) / (t1 - t0);
    if (share > 0.03 && share < 0.97 && m % every === 0) out.push({ t, label: m === 0 ? `${MONTHS[m]} '${String(y).slice(2)}` : MONTHS[m]! });
    m++;
  }
  return out;
}
