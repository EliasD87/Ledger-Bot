/**
 * Ledger's charts, drawn as SVG by hand: one quiet style that matches the cards (dark panel, soft
 * colours, no red/green alarm). Sized for phones first: most members read Discord on one, where the
 * image shows at roughly half its width, so the text is large and the labels few. Pure functions;
 * render.ts turns them into PNGs.
 */

export const WIDTH = 640;
/** The plot's height; a key under it adds rows. */
export const HEIGHT = 360;

export const INK = {
  panel: '#1e1f23',
  grid: '#2c2e34',
  axis: '#8b8f98',
  title: '#e6e7ea',
  sub: '#9a9ea7',
  faint: '#5c6068',
  main: '#8ea2ff',
  second: '#c9a46a',
  avg50: '#c9a46a',
  avg200: '#6f8f78',
  target: '#f0b232',
  up: '#7e9c84',
  down: '#a8797a',
} as const;

/** Type sizes, in chart pixels (the PNG is drawn at twice this). */
const TYPE = { title: 22, sub: 15, axis: 14, tag: 14, small: 13, note: 12 } as const;
const PAD = { top: 82, right: 96, bottom: 40, left: 14 };
const KEY_ROW = 24;
/** Chinese labels fall back to Noto Sans SC (loaded only for charts that have them, see render.ts). */
const FONT = "'IBM Plex Sans', 'Noto Sans SC', sans-serif";

export interface Point {
  /** Milliseconds since the epoch. */
  t: number;
  v: number;
}

export interface Line {
  points: Point[];
  color: string;
  /** Written at the line's end, in its colour (averages: "50-day"). */
  label?: string;
  /** A value tag on the right axis instead of the default one (compare charts: "SOL −4.1%"). */
  tag?: string;
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
  /** Small print, top right: the source. */
  note?: string;
  /** Extend the time axis to here (e.g. a check-back date still ahead). */
  xEnd?: number;
  /** Numbered markers on the main line: the days an event map talks about. */
  dots?: { t: number; label: string }[];
  /** The typical range ahead: a soft wedge from a starting value to a low/high band at a later date. */
  cone?: { t0: number; v0: number; t1: number; lo: number; hi: number; label: string; short?: string };
  /** Scheduled events along the time axis (FOMC, CPI): small ticks with names. */
  events?: { t: number; label: string }[];
  /** The final value of a settled take: a check or a cross on the line. */
  finish?: { t: number; v: number; ok: boolean };
  /** Lines of text under the chart: an event key. */
  key?: string[];
  /** Axis dates in Chinese (10月28日) for a Chinese conversation. */
  lang?: 'en' | 'zh';
}

/** A line chart: series, levels, markers and a value tag on the right; sized for phones. */
export function lineChart(c: LineChart): string {
  const all = c.lines.flatMap((l) => l.points);
  if (all.length < 2) return emptyChart(c.title, 'Not enough history to draw.');
  const t0 = Math.min(...all.map((p) => p.t));
  const t1 = Math.max(c.xEnd ?? 0, ...all.map((p) => p.t));
  const values = [...all.map((p) => p.v), ...(c.levels ?? []).map((l) => l.v), ...(c.cone ? [c.cone.lo, c.cone.hi] : [])];
  const [lo, hi] = niceRange(Math.min(...values), Math.max(...values));
  const plotRight = WIDTH - PAD.right;
  // Scheduled events get their own row under the plot, so they never sit on the lines.
  const events = (c.events ?? []).filter((e) => e.t >= t0 && e.t <= t1).sort((a, b) => a.t - b.t);
  const plotBottom = HEIGHT - PAD.bottom - (events.length ? 24 : 0);
  const x = (t: number) => PAD.left + ((t - t0) / Math.max(1, t1 - t0)) * (plotRight - PAD.left);
  const y = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * (plotBottom - PAD.top);

  // Value tags on the right axis: one per tagged line, or the main line's latest value. Kept apart.
  const tagged = c.lines.filter((l) => l.tag && l.points.length);
  const tags = spread(
    (tagged.length ? tagged : [c.lines[0]!])
      .filter((l) => l.points.length)
      .map((l) => ({ y: y(l.points.at(-1)!.v), label: l.tag ?? c.format(l.points.at(-1)!.v), color: l.color })),
    26,
  );

  const parts: string[] = [];
  for (const v of ticks(lo, hi)) {
    parts.push(`<line x1="${PAD.left}" x2="${plotRight}" y1="${f(y(v))}" y2="${f(y(v))}" stroke="${INK.grid}" stroke-width="1"/>`);
    if (tags.every((t) => Math.abs(y(v) - t.y) > 20)) parts.push(text(plotRight + 10, y(v) + 5, c.format(v), { size: TYPE.axis, color: INK.axis }));
  }
  for (const m of timeTicks(t0, t1, c.lang)) parts.push(text(x(m.t), HEIGHT - 12, m.label, { size: TYPE.axis, color: INK.axis, anchor: 'middle' }));
  for (const m of c.marks ?? []) {
    const mx = x(Math.min(Math.max(m.t, t0), t1));
    parts.push(`<line x1="${f(mx)}" x2="${f(mx)}" y1="${PAD.top - 6}" y2="${plotBottom}" stroke="${INK.sub}" stroke-width="1" stroke-dasharray="2 4"/>`);
    const fits = mx + 6 + textWidth(m.label, TYPE.small) < WIDTH - 8;
    parts.push(text(fits ? mx + 6 : mx - 6, PAD.top + 8, m.label, { size: TYPE.small, color: INK.sub, anchor: fits ? 'start' : 'end' }));
  }
  // Scheduled events: a tick up from the plot's floor, the name in the row beneath. Names that would
  // overlap lose their date first ("FOMC"), then their name (the tick stays).
  let freeFrom = PAD.left;
  for (const e of events) {
    const ex = x(e.t);
    parts.push(`<line x1="${f(ex)}" x2="${f(ex)}" y1="${f(plotBottom - 8)}" y2="${f(plotBottom + 4)}" stroke="${INK.target}" stroke-width="2"/>`);
    const short = e.label.replace(/ \d{1,2} \w+$| \d{1,2}月\d{1,2}日$/, '');
    const name = [e.label, short].find((n) => {
      const w = textWidth(n, TYPE.note);
      return Math.max(ex - w / 2, PAD.left) >= freeFrom && Math.min(ex + w / 2, WIDTH - 8) - Math.max(ex - w / 2, PAD.left) >= w - 1;
    });
    if (!name) continue;
    const w = textWidth(name, TYPE.note);
    const left = Math.max(ex - w / 2, PAD.left);
    parts.push(text(left, plotBottom + 19, name, { size: TYPE.note, color: INK.target }));
    freeFrom = left + w + 10;
  }
  let coneLabel = '';
  if (c.cone) {
    const k = c.cone;
    const [x0, y0, x1, yHi, yLo] = [x(k.t0), y(k.v0), x(k.t1), y(k.hi), y(k.lo)];
    parts.push(`<path d="M${f(x0)} ${f(y0)} L${f(x1)} ${f(yHi)} L${f(x1)} ${f(yLo)} Z" fill="${INK.main}" fill-opacity="0.10"/>`);
    parts.push(
      `<path d="M${f(x0)} ${f(y0)} L${f(x1)} ${f(yHi)} M${f(x0)} ${f(y0)} L${f(x1)} ${f(yLo)}" stroke="${INK.main}" stroke-opacity="0.5" stroke-width="1.2" stroke-dasharray="3 4" fill="none"/>`,
    );
    // The full label if it fits under the wedge, else the short one; on a backing so dashed lines don't cut through.
    const name = textWidth(k.label, TYPE.note) + 14 < x1 - x0 ? k.label : (k.short ?? 'typical range');
    const w = textWidth(name, TYPE.note) + 10;
    const ty = yLo + 20 < plotBottom - 20 ? yLo + 17 : yHi - 9;
    coneLabel =
      `<rect x="${f(x1 - w - 4)}" y="${f(ty - 13)}" width="${f(w)}" height="17" rx="4" fill="${INK.panel}"/>` +
      text(x1 - 9, ty, name, { size: TYPE.note, color: INK.sub, anchor: 'end' });
  }
  const labels: string[] = [];
  for (const l of c.levels ?? []) {
    parts.push(`<line x1="${PAD.left}" x2="${plotRight}" y1="${f(y(l.v))}" y2="${f(y(l.v))}" stroke="${l.color}" stroke-width="1.6" stroke-dasharray="7 5"/>`);
    labels.push(levelTag(PAD.left + 8, y(l.v), l.label, l.color));
  }
  // Secondary lines first, the main line last so it sits on top.
  for (const l of [...c.lines].reverse()) {
    if (l.points.length < 2) continue;
    const d = l.points.map((p, i) => `${i ? 'L' : 'M'}${f(x(p.t))} ${f(y(p.v))}`).join(' ');
    if (l.fill) {
      parts.push(`<path d="${d} L${f(x(l.points.at(-1)!.t))} ${plotBottom} L${f(x(l.points[0]!.t))} ${plotBottom} Z" fill="url(#fade)"/>`);
    }
    parts.push(
      `<path d="${d}" fill="none" stroke="${l.color}" stroke-width="${l.width ?? 1.8}" stroke-linejoin="round" stroke-linecap="round"${l.dash ? ' stroke-dasharray="6 4"' : ''}/>`,
    );
  }
  // Line names at their ends, in their colour: in the runway if there is one, else just above the end.
  const runway = (c.xEnd ?? 0) > Math.max(...all.map((p) => p.t));
  for (const l of c.lines) {
    if (!l.label || l.points.length < 2) continue;
    const end = l.points.at(-1)!;
    const ex = x(end.t);
    const ey = y(end.v);
    parts.push(runway ? text(ex + 8, ey + 5, l.label, { size: TYPE.note, color: l.color }) : text(ex - 6, ey - 8, l.label, { size: TYPE.note, color: l.color, anchor: 'end' }));
  }
  parts.push(...labels);
  if (coneLabel) parts.push(coneLabel);
  // Event markers sit on the main line at their day, numbered to match the key and the reply.
  for (const d of c.dots ?? []) {
    const line = c.lines[0]!.points;
    const p = line.reduce((best, q) => (Math.abs(q.t - d.t) < Math.abs(best.t - d.t) ? q : best), line[0]!);
    const cx = x(p.t);
    const cy = y(p.v);
    const ly = cy - 24 > PAD.top ? cy - 20 : cy + 20;
    parts.push(`<line x1="${f(cx)}" x2="${f(cx)}" y1="${f(cy)}" y2="${f(ly)}" stroke="${INK.target}" stroke-width="1.2"/>`);
    parts.push(`<circle cx="${f(cx)}" cy="${f(cy)}" r="3.5" fill="${INK.target}"/>`);
    parts.push(`<circle cx="${f(cx)}" cy="${f(ly)}" r="11" fill="${INK.panel}" stroke="${INK.target}" stroke-width="1.6"/>`);
    parts.push(text(cx, ly + 5, d.label, { size: TYPE.small, color: INK.target, weight: 600, anchor: 'middle' }));
  }
  for (const l of tagged.length ? tagged : [c.lines[0]!]) {
    const last = l.points.at(-1);
    if (last) parts.push(`<circle cx="${f(x(last.t))}" cy="${f(y(last.v))}" r="4.5" fill="${l.color}" stroke="${INK.panel}" stroke-width="2"/>`);
  }
  if (c.finish) parts.push(finishMark(x(c.finish.t), y(c.finish.v), c.finish.ok));
  // Clear of the check or cross when the line ends in one.
  for (const t of tags) parts.push(valueTag(plotRight + (c.finish ? 16 : 4), t.y, t.label, t.color));
  return frame(c.title, c.subtitle, parts, c.note, c.lines[0]!.color, c.key);
}

/** "28 Oct", or "10月28日" for Chinese charts. */
function dayLabel(t: number, lang: 'en' | 'zh' = 'en'): string {
  const d = new Date(t);
  return lang === 'zh' ? `${d.getUTCMonth() + 1}月${d.getUTCDate()}日` : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
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
  lang?: 'en' | 'zh';
}

/** Daily bars around zero (ETF flows): inflows sage, outflows rose, the latest labelled. */
export function barChart(c: BarChart): string {
  if (!c.bars.length) return emptyChart(c.title, 'No sessions to draw yet.');
  const values = c.bars.map((b) => b.v);
  const [lo, hi] = niceRange(Math.min(0, ...values), Math.max(0, ...values));
  const plotRight = WIDTH - PAD.right;
  const plotBottom = HEIGHT - PAD.bottom;
  const step = (plotRight - PAD.left) / c.bars.length;
  const barW = Math.max(3, Math.min(22, step * 0.7));
  const y = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * (plotBottom - PAD.top);

  const parts: string[] = [];
  const tagY = y(c.bars.at(-1)!.v);
  for (const v of ticks(lo, hi)) {
    parts.push(`<line x1="${PAD.left}" x2="${plotRight}" y1="${f(y(v))}" y2="${f(y(v))}" stroke="${v === 0 ? INK.axis : INK.grid}" stroke-width="1"/>`);
    if (Math.abs(y(v) - tagY) > 20) parts.push(text(plotRight + 10, y(v) + 5, c.format(v), { size: TYPE.axis, color: INK.axis }));
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
  // Date labels: about four across, always the latest.
  const every = Math.max(1, Math.ceil(c.bars.length / 4));
  c.bars.forEach((b, i) => {
    if ((c.bars.length - 1 - i) % every !== 0) return;
    parts.push(text(PAD.left + step * (i + 0.5), HEIGHT - 12, dayLabel(b.t, c.lang), { size: TYPE.axis, color: INK.axis, anchor: 'middle' }));
  });
  const last = c.bars.at(-1)!;
  parts.push(valueTag(plotRight + 4, tagY, c.format(last.v), last.v >= 0 ? INK.up : INK.down));
  return frame(c.title, c.subtitle, parts, c.note, INK.main);
}

export function emptyChart(title: string, message: string): string {
  return frame(title, undefined, [text(WIDTH / 2, HEIGHT / 2 + 10, message, { size: TYPE.sub, color: INK.sub, anchor: 'middle' })], undefined, INK.main);
}

// --- pieces ---

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function frame(title: string, subtitle: string | undefined, body: string[], note: string | undefined, fade: string, key: string[] = []): string {
  const rows = key.map((k) => clip(k, TYPE.small, WIDTH - 28));
  const height = HEIGHT + (rows.length ? rows.length * KEY_ROW + 14 : 0);
  // Title and subtitle shortened to the width the source note leaves them.
  const noteW = note ? textWidth(note, TYPE.note) + 16 : 0;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" font-family="${FONT}">`,
    `<defs><linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${fade}" stop-opacity="0.22"/><stop offset="1" stop-color="${fade}" stop-opacity="0"/></linearGradient></defs>`,
    `<rect width="${WIDTH}" height="${height}" rx="16" fill="${INK.panel}"/>`,
    text(PAD.left + 2, 32, clip(title, TYPE.title * 1.04, WIDTH - PAD.left - 10 - noteW), { size: TYPE.title, color: INK.title, weight: 600 }),
    subtitle ? text(PAD.left + 2, 58, clip(subtitle, TYPE.sub, WIDTH - PAD.left - 10), { size: TYPE.sub, color: INK.sub }) : '',
    note ? text(WIDTH - 14, 30, note, { size: TYPE.note, color: INK.faint, anchor: 'end' }) : '',
    ...body,
    ...(rows.length ? [`<line x1="${PAD.left}" x2="${WIDTH - 14}" y1="${HEIGHT + 4}" y2="${HEIGHT + 4}" stroke="${INK.grid}" stroke-width="1"/>`] : []),
    ...rows.map((r, i) => text(PAD.left + 2, HEIGHT + 4 + KEY_ROW * (i + 1), r, { size: TYPE.small, color: INK.sub })),
    '</svg>',
  ].join('');
}

/** Value tags spread apart vertically so two near each other stay readable. */
function spread<T extends { y: number }>(items: T[], gap: number): T[] {
  const sorted = [...items].sort((a, b) => a.y - b.y);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.y - sorted[i - 1]!.y < gap) sorted[i] = { ...sorted[i]!, y: sorted[i - 1]!.y + gap };
  }
  return sorted;
}

/** A level's label sitting on its line, on a panel-coloured backing so lines behind it don't cut through. */
function levelTag(xLeft: number, yLine: number, label: string, color: string): string {
  const w = textWidth(label, TYPE.tag) + 12;
  return (
    `<rect x="${f(xLeft)}" y="${f(yLine - 11)}" width="${f(w)}" height="22" rx="6" fill="${INK.panel}" stroke="${color}" stroke-opacity="0.55"/>` +
    text(xLeft + 6, yLine + 5, label, { size: TYPE.tag, color })
  );
}

/** A value in a rounded tag on the right axis. */
function valueTag(xLeft: number, yMid: number, label: string, color: string): string {
  const w = textWidth(label, TYPE.tag) + 14;
  const top = Math.min(Math.max(yMid - 12, PAD.top - 14), HEIGHT - PAD.bottom - 12);
  return (
    `<rect x="${f(xLeft)}" y="${f(top)}" width="${f(w)}" height="24" rx="7" fill="${color}"/>` +
    text(xLeft + 7, top + 17, label, { size: TYPE.tag, color: INK.panel, weight: 600 })
  );
}

/** A check (aged well) or a cross (aged badly) on the final point, drawn as shapes. */
function finishMark(cx: number, cy: number, ok: boolean): string {
  const color = ok ? INK.up : INK.down;
  const glyph = ok
    ? `<path d="M${f(cx - 5)} ${f(cy)} L${f(cx - 1.5)} ${f(cy + 4)} L${f(cx + 6)} ${f(cy - 5)}" stroke="${INK.panel}" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`
    : `<path d="M${f(cx - 4.5)} ${f(cy - 4.5)} L${f(cx + 4.5)} ${f(cy + 4.5)} M${f(cx + 4.5)} ${f(cy - 4.5)} L${f(cx - 4.5)} ${f(cy + 4.5)}" stroke="${INK.panel}" stroke-width="2.6" stroke-linecap="round"/>`;
  return `<circle cx="${f(cx)}" cy="${f(cy)}" r="12" fill="${color}" stroke="${INK.panel}" stroke-width="2"/>${glyph}`;
}

function text(x: number, y: number, s: string, o: { size: number; color: string; weight?: number; anchor?: 'start' | 'middle' | 'end' }): string {
  return `<text x="${f(x)}" y="${f(y)}" font-size="${o.size}" fill="${o.color}"${o.weight ? ` font-weight="${o.weight}"` : ''}${o.anchor ? ` text-anchor="${o.anchor}"` : ''}>${escape(s)}</text>`;
}

/** Rough width of a label, enough to place tags and keep text inside the panel: Chinese characters are about twice as wide. */
function textWidth(s: string, size: number): number {
  let w = 0;
  for (const ch of s) w += /[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? size : size * 0.56;
  return w;
}

/** Text cut to fit a width, with an ellipsis. */
function clip(s: string, size: number, maxW: number): string {
  if (textWidth(s, size) <= maxW) return s;
  let out = '';
  for (const ch of s) {
    if (textWidth(`${out}${ch}…`, size) > maxW) break;
    out += ch;
  }
  return `${out}…`;
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

/** Axis labels that suit the span, about five across: hours, days, or months. */
function timeTicks(t0: number, t1: number, lang: 'en' | 'zh' = 'en'): { t: number; label: string }[] {
  const days = (t1 - t0) / 86_400_000;
  if (days > 75) return monthTicks(t0, t1, lang);
  const step = days <= 1.5 ? 0.25 : days <= 3 ? 0.5 : [1, 2, 3, 5, 7, 10, 14].find((s) => days / s <= 5) ?? 14;
  const out: { t: number; label: string }[] = [];
  const first = Math.ceil(t0 / (step * 86_400_000)) * step * 86_400_000;
  for (let t = first; t <= t1; t += step * 86_400_000) {
    const share = (t - t0) / (t1 - t0);
    if (share < 0.06 || share > 0.94) continue;
    const d = new Date(t);
    out.push({ t, label: step < 1 ? `${String(d.getUTCHours()).padStart(2, '0')}:00` : dayLabel(t, lang) });
  }
  return out;
}

/** Month starts across the range: monthly for short spans, every 2nd, 3rd or 6th for longer ones. */
function monthTicks(t0: number, t1: number, lang: 'en' | 'zh' = 'en'): { t: number; label: string }[] {
  const months = (t1 - t0) / (30 * 86_400_000);
  const every = months > 30 ? 6 : months > 14 ? 3 : months > 6 ? 2 : 1;
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
    const name = lang === 'zh' ? (m === 0 ? `${y}年1月` : `${m + 1}月`) : m === 0 ? `${MONTHS[m]} '${String(y).slice(2)}` : MONTHS[m]!;
    if (share > 0.05 && share < 0.95 && m % every === 0) out.push({ t, label: name });
    m++;
  }
  return out;
}
