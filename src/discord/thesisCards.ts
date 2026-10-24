import { ButtonBuilder, ButtonStyle, type ContainerBuilder } from 'discord.js';
import { discordTime, formatPrice, formatUsd } from '../format.js';
import { type ThesisSpec, measureLabel } from '../theses/spec.js';
import type { Record, Sides, Thesis, ThesisStatus } from '../theses/store.js';
import type { Verdict } from '../theses/measure.js';
import { myPageButton } from './pageCards.js';
import { ACCENT, card, cards, divider, heading, kicker, row } from './ui.js';

export type ThesisAction = 'log' | 'drop' | 'with' | 'against' | 'progress';

export const thesisButtonId = (action: ThesisAction, id: number) => `thesis:${action}:${id}`;

export function parseThesisButtonId(customId: string): { action: ThesisAction; id: number } | null {
  const m = /^thesis:(log|drop|with|against|progress):(\d+)$/.exec(customId);
  return m ? { action: m[1] as ThesisAction, id: Number(m[2]) } : null;
}

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

const pct = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}%`;

function change(t: Thesis, end: number): string {
  if (t.spec.kind === 'flows' || t.startValue === null) return `**${formatMeasure(t.spec, end)}** net`;
  return `**${formatMeasure(t.spec, t.startValue)} → ${formatMeasure(t.spec, end)}** (${pct(end / t.startValue - 1)})`;
}

/** The stress-test card, which becomes the thesis on the record once logged and shows its result once checked. */
export function thesisContainer(t: Thesis, sides: Sides): ContainerBuilder {
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
          new ButtonBuilder().setCustomId(thesisButtonId('log', t.id)).setLabel('Log it').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(thesisButtonId('drop', t.id)).setLabel('Not now').setStyle(ButtonStyle.Secondary),
        )
      : t.status === 'open'
        ? row(
            new ButtonBuilder().setCustomId(thesisButtonId('with', t.id)).setLabel("I'm with you").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(thesisButtonId('against', t.id)).setLabel("I'm against").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(thesisButtonId('progress', t.id)).setLabel("How's it doing?").setStyle(ButtonStyle.Secondary),
          )
        : null;
  const debate = sides.with.length + sides.against.length > 0;

  return card(EDGE[t.status], [
    kicker(status),
    heading(t.claim),
    kicker(`${take}${readAs}`),
    timeline,
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
    debate && kicker([...sides.with.map((u) => `<@${u}> with`), ...sides.against.map((u) => `<@${u}> against`)].slice(0, 20).join(' · ')),
    buttons,
    kicker(
      t.status === 'draft'
        ? `Log it to put it on the record and get a check-back ${t.spec.horizonDays === 1 ? 'tomorrow' : `in ${t.spec.horizonDays} days`} · data: ${t.analysis.sources.join(', ')}`
        : `Data: ${t.analysis.sources.join(', ')} · evidence, not a forecast`,
    ),
  ]);
}

export function thesisCard(t: Thesis, sides: Sides) {
  return cards([thesisContainer(t, sides)]);
}

/** The check-back, posted as a reply to the thesis card: how it aged and who read it right. Pings the author only. */
export function verdictPost(v: Verdict, sides: Sides) {
  const t = v.thesis;
  const right = v.held ? sides.with : sides.against;
  const missed = v.held ? sides.against : sides.with;
  const contrarian = v.held && sides.against.length > sides.with.length;
  return cards(
    [
      card(v.held ? ACCENT.right : ACCENT.wrong, [
        kicker(`⚖️ Check-back · thesis #${t.id} · <@${t.authorId}>`),
        heading(`${t.claim} · ${v.held ? 'aged well ✓' : 'aged badly ✗'}`),
        `${measureLabel(t.spec)} ${change(t, v.endValue)}`,
        contrarian && `Contrarian win: ${sides.against.length} of ${sides.with.length + sides.against.length} were against.`,
        right.length > 0 && kicker(`Read it right: ${right.slice(0, 15).map((u) => `<@${u}>`).join(' ')}`),
        missed.length > 0 && kicker(`Missed: ${missed.slice(0, 15).map((u) => `<@${u}>`).join(' ')}`),
        row(myPageButton(t.guildId)),
      ]),
    ],
    { ping: [t.authorId] },
  );
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

/** A member's record of takes: /takes @member and the Receipts view. */
export function recordContainer(name: string, r: Record): ContainerBuilder {
  const settled = r.agedWell + r.agedBadly;
  return card(ACCENT.page, [
    `## ⚖️ ${name}'s takes`,
    settled || r.open
      ? `**${r.agedWell}** aged well · **${r.agedBadly}** aged badly · **${r.open}** open${settled ? ` · ${Math.round((r.agedWell / settled) * 100)}% hit rate` : ''}`
      : 'Nothing on the record yet.',
    r.contrarianWins > 0 && `**Contrarian wins:** ${r.contrarianWins}`,
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
