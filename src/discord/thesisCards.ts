import { ordinal } from './deskCards.js';
import { ButtonBuilder, ButtonStyle, type ContainerBuilder } from 'discord.js';
import { discordTime, formatPrice, formatUsd } from '../format.js';
import { type ThesisSpec, measureLabel } from '../theses/spec.js';
import { timeLeft } from '../theses/moments.js';
import type { Leader, MomentKind, Record, Sides, Thesis, ThesisStatus } from '../theses/store.js';
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

/** The fixed words on take cards: English, or Chinese when the member wrote the take in Chinese. */
const WORDS = {
  en: {
    lean: { for: 'Evidence leans with the take.', against: 'Evidence leans against the take.', even: 'Evidence is split.' },
    stressTest: 'Stress test',
    thesis: (id: number) => `Thesis #${id}`,
    onRecord: 'on the record',
    agedWell: 'aged well ✓',
    agedBadly: 'aged badly ✗',
    voided: 'void',
    notLogged: 'not logged',
    readAs: 'read as',
    loggedAt: (m: string, v: string, when: string) => `Logged at ${m} ${v} · checks back ${when}`,
    net: 'net',
    logIt: 'Log it',
    timeframes: 'Other timeframes',
    sharpen: 'Make it sharper',
    notNow: 'Not now',
    withYou: "I'm with you",
    against: "I'm against",
    progress: "How's it doing?",
    duel: (a: string, b: string) => `⚔️ Duel: ${a} vs ${b}`,
    for: 'For',
    againstHeading: 'Against',
    kill: 'What would prove it wrong',
    history: 'History',
    sides: (w: number, a: number) => `With **${w}** · Against **${a}**`,
    sideWith: 'with',
    sideAgainst: 'against',
    draftFooter: (when: string, data: string) => `Log it to put it on the record and get a check-back ${when} · data: ${data}`,
    checkIn: (days: number, date: string) => (days === 1 ? 'tomorrow' : `in ${days} days, around ${date}`),
    footer: (data: string) => `Data: ${data} · evidence, not a forecast`,
    checkBack: (id: number) => `Check-back · thesis #${id}`,
    duelWin: (winner: string, loser: string) => `⚔️ Duel: ${winner} wins against ${loser}.`,
    contrarian: (a: number, n: number) => `Contrarian win: ${a} of ${n} were against.`,
    readItRight: 'Read it right',
    missed: 'Missed',
    sinceLogged: 'since logged',
    littleTime: 'little time',
    theCheckBack: 'the check-back',
    reached: (where: string, left: string, by: string) => `**On the way.** ${where}: past the line with ${left} left. It still has to be there on ${by}.`,
    slipped: (where: string, left: string, by: string) => `**Gave it back.** ${where}: short of the line again, ${left} left before ${by}.`,
    pressure: (where: string, left: string) => `**Under pressure.** ${where}: further against the take than its usual range for the whole window, with ${left} left.`,
    days: (d: number) => (d % 30 === 0 && d >= 30 ? (d === 30 ? '1 month' : `${d / 30} months`) : d % 7 === 0 ? (d === 7 ? '1 week' : `${d / 7} weeks`) : `${d} days`),
    tfRow: (label: string, rate: number, windows: string) => `${label}: ${rate}% of ${windows} windows`,
    thisTake: 'this take',
    median: 'median',
    tfTitle: (claim: string) => `⏱ Same take, other timeframes · ${claim}`,
    tfIntro: 'How often the move it needs has happened before:',
    tfNote: 'History, not a forecast. Longer windows usually give a move more room to happen.',
    use: (label: string) => `Use ${label}`,
    sharperTitle: (id: number) => `🎯 A sharper version of #${id}`,
    testThis: 'Test this version',
    sharperNote: 'Testing it replaces the stress test on your card; nothing is logged until you press Log it.',
    cantRead: (m: string) => `Couldn't read ${m} right now. Try again in a minute.`,
    soon: 'soon',
    netSoFar: 'net so far',
    onTrack: (ok: boolean) => (ok ? 'On track so far' : 'Not there so far'),
    checksBack: (when: string) => `checks back ${when}`,
    measure: (s: ThesisSpec) => measureLabel(s),
    date: (ms: number) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }),
    left: (checkAt: number, now: number) => timeLeft(checkAt, now),
  },
  zh: {
    lean: { for: '证据更支持这个观点。', against: '证据更不支持这个观点。', even: '证据两边差不多。' },
    stressTest: '压力测试',
    thesis: (id: number) => `观点 #${id}`,
    onRecord: '已记录',
    agedWell: '应验了 ✓',
    agedBadly: '没应验 ✗',
    voided: '作废',
    notLogged: '未记录',
    readAs: '理解为',
    loggedAt: (m: string, v: string, when: string) => `记录时 ${m} ${v} · ${when}复盘`,
    net: '净',
    logIt: '记录',
    timeframes: '其他时间',
    sharpen: '更精确',
    notNow: '先不',
    withYou: '我支持',
    against: '我反对',
    progress: '进展如何？',
    duel: (a: string, b: string) => `⚔️ 对决：${a} vs ${b}`,
    for: '支持',
    againstHeading: '反对',
    kill: '什么情况说明它错了',
    history: '历史',
    sides: (w: number, a: number) => `支持 **${w}** · 反对 **${a}**`,
    sideWith: '支持',
    sideAgainst: '反对',
    draftFooter: (when: string, data: string) => `点「记录」把它记下来，${when}复盘 · 数据：${data}`,
    checkIn: (days: number, date: string) => (days === 1 ? '明天' : `${days} 天后（${date}左右）`),
    footer: (data: string) => `数据：${data} · 只是证据，不是预测`,
    checkBack: (id: number) => `复盘 · 观点 #${id}`,
    duelWin: (winner: string, loser: string) => `⚔️ 对决：${winner} 赢了 ${loser}。`,
    contrarian: (a: number, n: number) => `逆向胜利：${n} 人里有 ${a} 人反对。`,
    readItRight: '判断对了',
    missed: '判断错了',
    sinceLogged: '记录以来',
    littleTime: '不多',
    theCheckBack: '复盘日',
    reached: (where: string, left: string, by: string) => `**快到了。** ${where}：已经过线，还剩 ${left}。${by}那天还得在线上才算。`,
    slipped: (where: string, left: string, by: string) => `**又回去了。** ${where}：又跌回线下，离${by}还剩 ${left}。`,
    pressure: (where: string, left: string) => `**有压力了。** ${where}：反方向走得比整个周期的常见区间还远，还剩 ${left}。`,
    days: (d: number) => (d % 30 === 0 && d >= 30 ? (d === 30 ? '1 个月' : `${d / 30} 个月`) : d % 7 === 0 ? (d === 7 ? '1 周' : `${d / 7} 周`) : `${d} 天`),
    tfRow: (label: string, rate: number, windows: string) => `${label}：${windows} 个窗口里 ${rate}% 做到了`,
    thisTake: '当前观点',
    median: '中位数',
    tfTitle: (claim: string) => `⏱ 同一个观点，其他时间范围 · ${claim}`,
    tfIntro: '它需要的涨跌以前出现过多少次：',
    tfNote: '这是历史，不是预测。时间越长，通常越有机会。',
    use: (label: string) => `用 ${label}`,
    sharperTitle: (id: number) => `🎯 #${id} 的更精确版本`,
    testThis: '测试这个版本',
    sharperNote: '测试后会替换卡片上的压力测试；点「记录」之前不会记下来。',
    cantRead: (m: string) => `现在读不到 ${m}，过一分钟再试试。`,
    soon: '很快',
    netSoFar: '目前净额',
    onTrack: (ok: boolean) => (ok ? '目前在轨道上' : '目前还没到'),
    checksBack: (when: string) => `${when}复盘`,
    measure: (s: ThesisSpec) => (s.kind === 'relative' ? `${s.asset}/${s.versus}` : s.kind === 'flows' ? `${s.asset} ETF 净流量` : `${s.asset} 价格`),
    date: (ms: number) => `${new Date(ms).getUTCMonth() + 1}月${new Date(ms).getUTCDate()}日`,
    left: (checkAt: number, now: number) => {
      const days = (checkAt - now) / 86_400_000;
      return days < 1 ? '不到一天' : `${Math.round(days)} 天`;
    },
  },
};
type Words = (typeof WORDS)['en'];
const wordsFor = (t: Thesis): Words => WORDS[t.analysis?.lang ?? 'en'] as Words;

/** A measure value in its own units: a price, a ratio, or a flow total. */
export function formatMeasure(spec: ThesisSpec, value: number): string {
  if (spec.kind === 'flows') return formatUsd(value, true);
  if (spec.kind === 'relative') return value.toPrecision(4);
  return formatPrice(value);
}

const pct = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}%`;

function change(t: Thesis, end: number, w: Words = wordsFor(t)): string {
  if (t.spec.kind === 'flows' || t.startValue === null) return `**${formatMeasure(t.spec, end)}** ${w.net}`;
  return `**${formatMeasure(t.spec, t.startValue)} → ${formatMeasure(t.spec, end)}** (${pct(end / t.startValue - 1)})`;
}

/** The stress-test card, which becomes the thesis on the record once logged and shows its result once checked. */
export function thesisContainer(t: Thesis, sides: Sides, opts: { chart?: boolean } = {}): ContainerBuilder {
  const w = wordsFor(t);
  const a = t.analysis.argument;
  const who = `<@${t.authorId}>`;
  const status =
    t.status === 'draft'
      ? `⚖️ ${w.stressTest} · ${who}`
      : `⚖️ ${w.thesis(t.id)} · ${who} · ${
          t.status === 'open' ? w.onRecord : t.status === 'aged_well' ? w.agedWell : t.status === 'aged_badly' ? w.agedBadly : t.status === 'void' ? w.voided : w.notLogged
        }`;
  const readAs = t.analysis.assumptions.length ? ` · ${w.readAs}: ${t.analysis.assumptions.join('; ')}` : '';
  const take = `"${t.take.length > 140 ? `${t.take.slice(0, 139)}…` : t.take}"`;
  const timeline =
    t.status === 'open' && t.checkAt
      ? kicker(w.loggedAt(w.measure(t.spec), formatMeasure(t.spec, t.startValue ?? 0), discordTime(t.checkAt, 'R')))
      : (t.status === 'aged_well' || t.status === 'aged_badly') && t.endValue !== null
        ? `${w.measure(t.spec)} ${change(t, t.endValue, w)}`
        : null;

  const buttons =
    t.status === 'draft'
      ? row(
          button('log', t.id, w.logIt, ButtonStyle.Primary),
          ...(t.spec.kind !== 'flows' ? [button('timeframes', t.id, w.timeframes), button('sharpen', t.id, w.sharpen)] : []),
          button('drop', t.id, w.notNow),
        )
      : t.status === 'open'
        ? row(button('with', t.id, w.withYou), button('against', t.id, w.against), button('progress', t.id, w.progress))
        : null;
  const debate = sides.with.length + sides.against.length > 0;
  const duel = t.challengerId ? w.duel(who, `<@${t.challengerId}>`) : null;

  return card(EDGE[t.status], [
    kicker(status),
    heading(t.claim),
    kicker(`${take}${readAs}`),
    timeline,
    opts.chart && picture(CHART_NAME, t.claim),
    divider(),
    `**${w.for}**`,
    ...a.for.map((p) => `· ${p.point}`),
    `**${w.againstHeading}**`,
    ...a.against.map((p) => `· ${p.point}`),
    divider(),
    a.kill && `**${w.kill}:** ${a.kill}`,
    a.history && `**${w.history}:** ${a.history}`,
    `**${w.lean[a.lean]}**${a.verdict ? ` _${a.verdict}_` : ''}`,
    (t.status !== 'draft' || debate) && divider(),
    t.status !== 'draft' && w.sides(sides.with.length, sides.against.length),
    duel,
    debate && kicker([...sides.with.map((u) => `<@${u}> ${w.sideWith}`), ...sides.against.map((u) => `<@${u}> ${w.sideAgainst}`)].slice(0, 20).join(' · ')),
    buttons,
    kicker(
      t.status === 'draft'
        ? w.draftFooter(w.checkIn(t.spec.horizonDays, w.date(t.createdAt + t.spec.horizonDays * 86_400_000)), t.analysis.sources.join(', '))
        : w.footer(t.analysis.sources.join(', ')),
    ),
  ]);
}

export function thesisCard(t: Thesis, sides: Sides, opts: { chart?: boolean } = {}) {
  return cards([thesisContainer(t, sides, opts)]);
}

/** The check-back, posted as a reply to the thesis card: how it aged and who read it right. Pings the author only. */
export function verdictPost(v: Verdict, sides: Sides, opts: { chart?: boolean } = {}) {
  const t = v.thesis;
  const w = wordsFor(t);
  const right = v.held ? sides.with : sides.against;
  const missed = v.held ? sides.against : sides.with;
  const contrarian = v.held && sides.against.length > sides.with.length;
  const challenger = t.challengerId;
  const duel = challenger ? w.duelWin(`<@${v.held ? t.authorId : challenger}>`, `<@${v.held ? challenger : t.authorId}>`) : null;
  return cards(
    [
      card(v.held ? ACCENT.right : ACCENT.wrong, [
        kicker(`⚖️ ${w.checkBack(t.id)} · <@${t.authorId}>`),
        heading(`${t.claim} · ${v.held ? w.agedWell : w.agedBadly}`),
        `${w.measure(t.spec)} ${change(t, v.endValue, w)}`,
        opts.chart && picture(CHART_NAME, t.claim),
        duel,
        contrarian && w.contrarian(sides.against.length, sides.with.length + sides.against.length),
        right.length > 0 && kicker(`${w.readItRight}: ${right.slice(0, 15).map((u) => `<@${u}>`).join(' ')}`),
        missed.length > 0 && kicker(`${w.missed}: ${missed.slice(0, 15).map((u) => `<@${u}>`).join(' ')}`),
        row(myPageButton(t.guildId)),
      ]),
    ],
    // The author, and the challenger of a duel: both have a stake in the result.
    { ping: [t.authorId, ...(challenger ? [challenger] : [])] },
  );
}

/** A mid-take moment, posted as a reply to the thesis card. Pings the author only. */
export function momentPost(t: Thesis, kind: MomentKind, value: number, now: number) {
  const w = wordsFor(t);
  const left = t.checkAt ? w.left(t.checkAt, now) : w.littleTime;
  const by = t.checkAt ? w.date(t.checkAt) : w.theCheckBack;
  const where = `${w.measure(t.spec)} ${formatMeasure(t.spec, value)}${t.startValue ? ` (${w.sinceLogged} ${pct(value / t.startValue - 1)})` : ''}`;
  const line = kind === 'reached' ? w.reached(where, left, by) : kind === 'slipped' ? w.slipped(where, left, by) : w.pressure(where, left);
  return cards(
    [
      card(kind === 'pressure' ? ACCENT.muted : ACCENT.open, [
        kicker(`⚖️ ${w.thesis(t.id)} · <@${t.authorId}>`),
        `${t.claim}\n${line}`,
        row(button('progress', t.id, w.progress)),
      ]),
    ],
    { ping: [t.authorId] },
  );
}

/** "Other timeframes": how often the same move happened over other windows, with a way to switch (author only). */
export function timeframesContainer(t: Thesis, rows: { days: number; rate: number; windows: number; median: number }[], canSwitch: boolean) {
  const w = wordsFor(t);
  const lines = rows.map((r) => {
    const mine = r.days === t.spec.horizonDays;
    const line = w.tfRow(w.days(r.days), Math.round(r.rate * 100), r.windows.toLocaleString('en-US'));
    return `${mine ? `**${line} · ${w.thisTake}**` : line} · ${w.median} ${pct(r.median)}`;
  });
  const options = rows.filter((r) => r.days !== t.spec.horizonDays).slice(0, 4);
  return card(ACCENT.amber, [
    kicker(w.tfTitle(t.claim)),
    w.tfIntro,
    lines.join('\n'),
    kicker(w.tfNote),
    canSwitch && options.length > 0 && row(...options.map((r) => button('retime', t.id, w.use(w.days(r.days)), ButtonStyle.Secondary, r.days))),
  ]);
}

/** "Make it sharper": the proposed version, with a button to test it instead. */
export function sharpenContainer(t: Thesis, proposal: { claim: string; why: string }): ContainerBuilder {
  const w = wordsFor(t);
  return card(ACCENT.amber, [
    kicker(w.sharperTitle(t.id)),
    `~~${t.claim}~~\n**${proposal.claim}**`,
    proposal.why,
    row(button('sharpened', t.id, w.testThis, ButtonStyle.Primary)),
    kicker(w.sharperNote),
  ]);
}

/** Live progress for "How's it doing?". */
export function progressText(t: Thesis, now: number, value: number | null, holding: boolean | null): string {
  const w = wordsFor(t);
  if (value === null) return w.cantRead(w.measure(t.spec));
  const left = t.checkAt ? discordTime(t.checkAt, 'R') : w.soon;
  return [
    `**${w.thesis(t.id)}:** ${t.claim}`,
    `${w.measure(t.spec)} ${t.spec.kind === 'flows' ? `**${formatMeasure(t.spec, value)}** ${w.netSoFar}` : change(t, value, w)}`,
    `${w.onTrack(!!holding)} · ${w.checksBack(left)}`,
  ].join('\n');
}

/** A member's record of takes: /takes @member and the record view. With a chart of their recent form. */
export function recordContainer(name: string, r: Record, opts: { chart?: boolean; rank?: { rank: number; of: number; leader: Leader } | null } = {}): ContainerBuilder {
  const settled = r.agedWell + r.agedBadly;
  const duels = r.duels.won + r.duels.lost;
  const rival = r.duels.against[0];
  return card(ACCENT.page, [
    `## ⚖️ ${name}'s takes`,
    settled || r.open
      ? `**${r.agedWell}** aged well · **${r.agedBadly}** aged badly · **${r.open}** open${settled ? ` · ${Math.round((r.agedWell / settled) * 100)}% hit rate` : ''}`
      : 'Nothing on the record yet.',
    opts.rank && `**Leaderboard:** ${ordinal(opts.rank.rank)} of ${opts.rank.of} · ${opts.rank.leader.right} right calls (${leaderDetail(opts.rank.leader)})`,
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
/** "4 of 6 takes, 9 of 12 sides": what a leaderboard row is made of. */
export function leaderDetail(l: Leader): string {
  return [l.takes ? `${l.takesRight} of ${l.takes} ${l.takes === 1 ? 'take' : 'takes'}` : null, l.sides ? `${l.sidesRight} of ${l.sides} ${l.sides === 1 ? 'side' : 'sides'}` : null]
    .filter(Boolean)
    .join(', ');
}

export function boardContainer(open: { t: Thesis; sides: Sides }[], leaders: Leader[], opts: { chart?: boolean } = {}): ContainerBuilder {
  const hottest = [...open].sort((a, b) => b.sides.with.length + b.sides.against.length - (a.sides.with.length + a.sides.against.length)).slice(0, 6);
  return card(ACCENT.page, [
    '## ⚖️ The takes',
    '**Open debates**',
    hottest.length
      ? hottest.map(({ t, sides }) => `#${t.id} ${t.claim} · <@${t.authorId}> · with ${sides.with.length}, against ${sides.against.length} · ${discordTime(t.checkAt!, 'R')}`).join('\n')
      : kicker('None yet. Bring one: @Ledger and say what you think will happen'),
    leaders.length > 0 && divider(),
    leaders.length > 0 && '**Leaderboard**',
    leaders.length > 0 && kicker('Right calls: your own takes that aged well, plus the sides you took that turned out right.'),
    opts.chart && picture(CHART_NAME, 'Leaderboard'),
    leaders.length > 0 && leaders.slice(0, 10).map((l, i) => `${i + 1}. <@${l.userId}> · ${l.right} right (${leaderDetail(l)})`).join('\n'),
    leaders.length > 0 && kicker('Ask me "what\'s my rank?" for your exact place.'),
  ]);
}
