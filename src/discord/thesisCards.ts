import { ButtonBuilder, ButtonStyle, type ContainerBuilder } from 'discord.js';
import { discordTime, formatPrice, formatUsd } from '../format.js';
import { type ThesisSpec, measureLabel } from '../theses/spec.js';
import { timeLeft } from '../theses/moments.js';
import type { MomentKind, Record, Sides, Thesis, ThesisStatus } from '../theses/store.js';
import type { Verdict } from '../theses/measure.js';
import { myPageButton } from './pageCards.js';
import { CHART_NAME } from '../charts/maker.js';
import { ACCENT, card, cards, divider, heading, kicker, picture, row } from './ui.js';

export type ThesisAction = 'log' | 'drop' | 'with' | 'against' | 'progress' | 'timeframes' | 'retime' | 'sharpen' | 'sharpened' | 'duel';

/** `arg` carries a number some buttons need: the timeframe in days for "retime". */
export const thesisButtonId = (action: ThesisAction, id: number, arg?: number) => `thesis:${action}:${id}${arg !== undefined ? `:${arg}` : ''}`;

export function parseThesisButtonId(customId: string): { action: ThesisAction; id: number; arg?: number } | null {
  const m = /^thesis:(log|drop|with|against|progress|timeframes|retime|sharpen|sharpened|duel):(\d+)(?::(\d+))?$/.exec(customId);
  return m ? { action: m[1] as ThesisAction, id: Number(m[2]), ...(m[3] ? { arg: Number(m[3]) } : {}) } : null;
}

const button = (action: ThesisAction, id: number, label: string, style = ButtonStyle.Secondary, arg?: number) =>
  new ButtonBuilder().setCustomId(thesisButtonId(action, id, arg)).setLabel(label).setStyle(style);

const EDGE: { [S in ThesisStatus]: number } = {
  draft: ACCENT.amber,
  open: ACCENT.open,
  aged_well: ACCENT.right,
  aged_badly: ACCENT.wrong,
  void: ACCENT.muted,
  cancelled: ACCENT.muted,
};

const LEAN = { for: 'Evidence leans with the take.', against: 'Evidence leans against the take.', even: 'Evidence is split.' } as const;

/** A measure value in its own units: a price, a ratio, or a flow total. */
export function formatMeasure(spec: ThesisSpec, value: number): string {
  if (spec.kind === 'flows') return formatUsd(value, true);
  if (spec.kind === 'relative') return value.toPrecision(4);
  return formatPrice(value);
}

/** "31 Dec". */
const shortDate = (ms: number) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

const pct = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}%`;

function change(t: Thesis, end: number): string {
  if (t.spec.kind === 'flows' || t.startValue === null) return `**${formatMeasure(t.spec, end)}** net`;
  return `**${formatMeasure(t.spec, t.startValue)} → ${formatMeasure(t.spec, end)}** (${pct(end / t.startValue - 1)})`;
}

/** The stress-test card, which becomes the thesis on the record once logged and shows its result once checked. */
export function thesisContainer(t: Thesis, sides: Sides, opts: { chart?: boolean } = {}): ContainerBuilder {
  const a = t.analysis.argument;
  const status =
    t.status === 'draft'
      ? `⚖️ Stress test · <@${t.authorId}>`
      : t.status === 'open'
        ? `⚖️ Thesis #${t.id} · <@${t.authorId}> · on the record`
        : t.status === 'aged_well'
          ? `⚖️ Thesis #${t.id} · <@${t.authorId}> · aged well ✓`
          : t.status === 'aged_badly'
            ? `⚖️ Thesis #${t.id} · <@${t.authorId}> · aged badly ✗`
            : `⚖️ Thesis #${t.id} · <@${t.authorId}> · ${t.status === 'void' ? 'void' : 'not logged'}`;
  const readAs = t.analysis.assumptions.length ? ` · read as: ${t.analysis.assumptions.join('; ')}` : '';
  const take = `"${t.take.length > 140 ? `${t.take.slice(0, 139)}…` : t.take}"`;
  const timeline =
    t.status === 'open' && t.checkAt
      ? kicker(`Logged at ${measureLabel(t.spec)} ${formatMeasure(t.spec, t.startValue ?? 0)} · checks back ${discordTime(t.checkAt, 'R')}`)
      : (t.status === 'aged_well' || t.status === 'aged_badly') && t.endValue !== null
        ? `${measureLabel(t.spec)} ${change(t, t.endValue)}`
        : null;

  const buttons =
    t.status === 'draft'
      ? row(
          button('log', t.id, 'Log it', ButtonStyle.Primary),
          ...(t.spec.kind !== 'flows' ? [button('timeframes', t.id, 'Other timeframes'), button('sharpen', t.id, 'Make it sharper')] : []),
          button('drop', t.id, 'Not now'),
        )
      : t.status === 'open'
        ? row(button('with', t.id, "I'm with you"), button('against', t.id, "I'm against"), button('progress', t.id, "How's it doing?"))
        : null;
  const debate = sides.with.length + sides.against.length > 0;
  const duel = t.challengerId ? `⚔️ Duel: <@${t.authorId}> vs <@${t.challengerId}>` : null;

  return card(EDGE[t.status], [
    kicker(status),
    heading(t.claim),
    kicker(`${take}${readAs}`),
    timeline,
    opts.chart && picture(CHART_NAME, `Chart for ${t.claim}`),
    divider(),
    '**For**',
    ...a.for.map((p) => `· ${p.point}`),
    '**Against**',
    ...a.against.map((p) => `· ${p.point}`),
    divider(),
    a.kill && `**What would prove it wrong:** ${a.kill}`,
    a.history && `**History:** ${a.history}`,
    `**${LEAN[a.lean]}**${a.verdict ? ` _${a.verdict}_` : ''}`,
    (t.status !== 'draft' || debate) && divider(),
    t.status !== 'draft' && `With **${sides.with.length}** · Against **${sides.against.length}**`,
    duel,
    debate && kicker([...sides.with.map((u) => `<@${u}> with`), ...sides.against.map((u) => `<@${u}> against`)].slice(0, 20).join(' · ')),
    buttons,
    kicker(
      t.status === 'draft'
        ? `Log it to put it on the record and get a check-back ${t.spec.horizonDays === 1 ? 'tomorrow' : `in ${t.spec.horizonDays} days, around ${shortDate(t.createdAt + t.spec.horizonDays * 86_400_000)}`} · data: ${t.analysis.sources.join(', ')}`
        : `Data: ${t.analysis.sources.join(', ')} · evidence, not a forecast`,
    ),
  ]);
}

export function thesisCard(t: Thesis, sides: Sides, opts: { chart?: boolean } = {}) {
  return cards([thesisContainer(t, sides, opts)]);
}

/** The check-back, posted as a reply to the thesis card: how it aged and who read it right. Pings the author only. */
export function verdictPost(v: Verdict, sides: Sides, opts: { chart?: boolean } = {}) {
  const t = v.thesis;
  const right = v.held ? sides.with : sides.against;
  const missed = v.held ? sides.against : sides.with;
  const contrarian = v.held && sides.against.length > sides.with.length;
  const challenger = t.challengerId;
  const duel = challenger
    ? `⚔️ Duel: <@${v.held ? t.authorId : challenger}> wins against <@${v.held ? challenger : t.authorId}>.`
    : null;
  return cards(
    [
      card(v.held ? ACCENT.right : ACCENT.wrong, [
        kicker(`⚖️ Check-back · thesis #${t.id} · <@${t.authorId}>`),
        heading(`${t.claim} · ${v.held ? 'aged well ✓' : 'aged badly ✗'}`),
        `${measureLabel(t.spec)} ${change(t, v.endValue)}`,
        opts.chart && picture(CHART_NAME, `How #${t.id} aged`),
        duel,
        contrarian && `Contrarian win: ${sides.against.length} of ${sides.with.length + sides.against.length} were against.`,
        right.length > 0 && kicker(`Read it right: ${right.slice(0, 15).map((u) => `<@${u}>`).join(' ')}`),
        missed.length > 0 && kicker(`Missed: ${missed.slice(0, 15).map((u) => `<@${u}>`).join(' ')}`),
        row(myPageButton(t.guildId)),
      ]),
    ],
    // The author, and the challenger of a duel: both have a stake in the result.
    { ping: [t.authorId, ...(challenger ? [challenger] : [])] },
  );
}

/** A mid-take moment, posted as a reply to the thesis card. Pings the author only. */
export function momentPost(t: Thesis, kind: MomentKind, value: number, now: number) {
  const left = t.checkAt ? timeLeft(t.checkAt, now) : 'little time';
  const by = t.checkAt ? shortDate(t.checkAt) : 'the check-back';
  const where = `${measureLabel(t.spec)} ${formatMeasure(t.spec, value)}${t.startValue ? ` (${pct(value / t.startValue - 1)} since logged)` : ''}`;
  const line =
    kind === 'reached'
      ? `**On the way.** ${where}: past the line with ${left} left. It still has to be there on ${by}.`
      : kind === 'slipped'
        ? `**Gave it back.** ${where}: short of the line again, ${left} left before ${by}.`
        : `**Under pressure.** ${where}: further against the take than its usual range for the whole window, with ${left} left.`;
  return cards(
    [
      card(kind === 'pressure' ? ACCENT.muted : ACCENT.open, [
        kicker(`⚖️ Thesis #${t.id} · <@${t.authorId}>`),
        `${t.claim}\n${line}`,
        row(button('progress', t.id, "How's it doing?")),
      ]),
    ],
    { ping: [t.authorId] },
  );
}

/** "Other timeframes": how often the same move happened over other windows, with a way to switch (author only). */
export function timeframesContainer(t: Thesis, rows: { days: number; rate: number; windows: number; median: number }[], canSwitch: boolean) {
  const label = (d: number) => (d % 30 === 0 && d >= 30 ? (d === 30 ? '1 month' : `${d / 30} months`) : d % 7 === 0 ? (d === 7 ? '1 week' : `${d / 7} weeks`) : `${d} days`);
  const lines = rows.map(
    (r) =>
      `${r.days === t.spec.horizonDays ? '**' : ''}${label(r.days)}: ${Math.round(r.rate * 100)}% of ${r.windows.toLocaleString('en-US')} windows` +
      `${r.days === t.spec.horizonDays ? ' · this take**' : ''} ${kicker(`median ${pct(r.median)}`).replace('-# ', '· ')}`,
  );
  const options = rows.filter((r) => r.days !== t.spec.horizonDays).slice(0, 4);
  return card(ACCENT.amber, [
      kicker(`⏱ Same take, other timeframes · ${t.claim}`),
      'How often the move it needs has happened before:',
      lines.join('\n'),
      kicker('History, not a forecast. Longer windows usually give a move more room to happen.'),
    canSwitch && options.length > 0 && row(...options.map((r) => button('retime', t.id, `Use ${label(r.days)}`, ButtonStyle.Secondary, r.days))),
  ]);
}

/** "Make it sharper": the proposed version, with a button to test it instead. */
export function sharpenContainer(t: Thesis, proposal: { claim: string; why: string }): ContainerBuilder {
  return card(ACCENT.amber, [
      kicker(`🎯 A sharper version of #${t.id}`),
      `~~${t.claim}~~\n**${proposal.claim}**`,
      proposal.why,
      row(button('sharpened', t.id, 'Test this version', ButtonStyle.Primary)),
    kicker('Testing it replaces the stress test on your card; nothing is logged until you press Log it.'),
  ]);
}

/** Live progress for "How's it doing?". */
export function progressText(t: Thesis, now: number, value: number | null, holding: boolean | null): string {
  if (value === null) return `Couldn't read ${measureLabel(t.spec)} right now. Try again in a minute.`;
  const left = t.checkAt ? discordTime(t.checkAt, 'R') : 'soon';
  return [
    `**Thesis #${t.id}:** ${t.claim}`,
    `${measureLabel(t.spec)} ${t.spec.kind === 'flows' ? `**${formatMeasure(t.spec, value)}** net so far` : change(t, value)}`,
    `${holding ? 'On track so far' : 'Not there so far'} · checks back ${left}`,
  ].join('\n');
}

/** A member's record of takes: /takes @member and the record view. With a chart of their recent form. */
export function recordContainer(name: string, r: Record, opts: { chart?: boolean } = {}): ContainerBuilder {
  const settled = r.agedWell + r.agedBadly;
  const duels = r.duels.won + r.duels.lost;
  const rival = r.duels.against[0];
  return card(ACCENT.page, [
    `## ⚖️ ${name}'s takes`,
    settled || r.open
      ? `**${r.agedWell}** aged well · **${r.agedBadly}** aged badly · **${r.open}** open${settled ? ` · ${Math.round((r.agedWell / settled) * 100)}% hit rate` : ''}`
      : 'Nothing on the record yet.',
    opts.chart && picture(CHART_NAME, `${name}'s recent takes`),
    r.bold.total > 0 && `**Bold takes** (history said under 25%): ${r.bold.right} of ${r.bold.total} aged well`,
    r.bestAsset && `**Reads ${r.bestAsset.asset} best:** ${r.bestAsset.right} of ${r.bestAsset.total}`,
    r.contrarianWins > 0 && `**Contrarian wins:** ${r.contrarianWins}`,
    duels > 0 && `**Duels:** ${r.duels.won}–${r.duels.lost}${rival ? ` · vs <@${rival.userId}> ${rival.won}–${rival.lost}` : ''}`,
    r.best && `**Best take:** #${r.best.id} ${r.best.claim}`,
    r.sidesSettled > 0 && `**Sides taken:** read ${r.sidesRight} of ${r.sidesSettled} right`,
    kicker('Bring a take: @Ledger and say what you think will happen'),
  ]);
}

/** The server's debates and records: /takes with no member. */
export function boardContainer(open: { t: Thesis; sides: Sides }[], leaders: { userId: string; agedWell: number; settled: number }[]): ContainerBuilder {
  const hottest = [...open].sort((a, b) => b.sides.with.length + b.sides.against.length - (a.sides.with.length + a.sides.against.length)).slice(0, 6);
  return card(ACCENT.page, [
    '## ⚖️ The takes',
    '**Open debates**',
    hottest.length
      ? hottest.map(({ t, sides }) => `#${t.id} ${t.claim} · <@${t.authorId}> · with ${sides.with.length}, against ${sides.against.length} · ${discordTime(t.checkAt!, 'R')}`).join('\n')
      : kicker('None yet. Bring one: @Ledger and say what you think will happen'),
    leaders.length > 0 && divider(),
    leaders.length > 0 && '**Best records**',
    leaders.length > 0 && leaders.map((l, i) => `${i + 1}. <@${l.userId}> ${l.agedWell} of ${l.settled} aged well`).join('\n'),
  ]);
}
