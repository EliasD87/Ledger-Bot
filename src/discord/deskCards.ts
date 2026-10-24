import { type ContainerBuilder, EmbedBuilder } from 'discord.js';
import { callHeadline } from '../calls/service.js';
import type { PageBook } from '../daily/book.js';
import type { LedgerSummary } from '../daily/ledger.js';
import { dayLabel, signedPct } from '../daily/questions.js';
import { type FlowReport, type MacroReport, type MarketReport, leadingFund } from '../desk/desk.js';
import type { Purchase } from '../desk/treasuries.js';
import { discordTime, formatPoints, formatUsd } from '../format.js';
import { difficulty } from './callCards.js';
import { callLink } from './pageCards.js';
import type { NewsItem } from '../sosovalue.js';
import { ACCENT, type CardPart, card, divider, heading, kicker } from './ui.js';


/* The tape cards (/tape): the number first, the detail under it, the source in small print. */

export function flowsCard(r: FlowReport, buttons?: CardPart): ContainerBuilder {
  const funds = r.funds.length <= 6 ? r.funds : [...r.funds.slice(0, 4), ...r.funds.slice(-2)];
  const totals = [
    r.latest.cumNetInflow !== null && `since launch ${formatUsd(r.latest.cumNetInflow, true)}`,
    r.latest.totalNetAssets !== null && `net assets ${formatUsd(r.latest.totalNetAssets)}`,
  ].filter(Boolean);
  return card(ACCENT.tape, [
    kicker('📈 The tape · US spot ETF flows · SoSoValue'),
    heading(`${r.asset} ETFs · ${dayLabel(r.latest.date)}`),
    `**${formatUsd(r.latest.totalNetInflow!, true)}** net${r.streak.days >= 2 ? ` · ${streakLine(r)}` : ''}`,
    funds.length > 0 && divider(),
    funds.length > 0 && funds.map((f) => `${f.ticker} ${formatUsd(f.netInflow, true)}`).join(' · '),
    r.days.length > 1 && kicker(`Last ${Math.min(5, r.days.length)}: ${r.days.slice(0, 5).map((d) => `${dayLabel(d.date).split(' ')[0]} ${formatUsd(d.totalNetInflow!, true)}`).join(' · ')}`),
    kicker([...totals, 'flows settle the next day'].join(' · ')),
    buttons,
  ]);
}

export function macroCard(r: MacroReport, buttons?: CardPart): ContainerBuilder {
  const todayDate = r.today[0]?.date;
  const later = r.upcoming.filter((d) => d.date !== todayDate);
  return card(ACCENT.tape, [
    kicker('📅 The tape · macro · SoSoValue'),
    heading('Macro docket'),
    r.today.length > 0 && `**Today**\n${r.today.map(releaseLine).join('\n')}`,
    later.length > 0 && `**Next 7 days**\n${later.map((d) => `${dayLabel(d.date)} · ${d.events.slice(0, 5).join(', ')}`).join('\n')}`,
    r.fomc && divider(),
    r.fomc && `**FOMC · ${dayLabel(r.fomc.meetingDate)}**\n${fomcLine(r.fomc)}`,
    r.fomc && kicker('Market-implied chance of each target range after the meeting'),
    !r.today.length && !later.length && !r.fomc && 'Nothing on the docket this week.',
    buttons,
  ]);
}

export function treasuriesCard(purchases: Purchase[], ready: boolean, days: number, buttons?: CardPart): ContainerBuilder {
  return card(ACCENT.tape, [
    kicker('🏢 The tape · corporate BTC buys · SoSoValue'),
    heading(`BTC buys · last ${days} days`),
    !ready
      ? 'Still compiling the list. The first scan takes a few minutes after a restart.'
      : purchases.length
        ? purchases.slice(0, 10).map(purchaseLine).join('\n')
        : `No purchases reported in the last ${days} days.`,
    buttons,
  ]);
}

export function newsCard(news: { asset: string | null; items: NewsItem[] }, buttons?: CardPart): ContainerBuilder {
  const lines = news.items.slice(0, 6).map((n) => {
    const title = n.title.length > 110 ? `${n.title.slice(0, 109)}…` : n.title;
    return `${n.link ? `[${escapeLink(title)}](${n.link})` : title}${n.releasedAt ? ` · ${discordTime(n.releasedAt, 'R')}` : ''}`;
  });
  return card(ACCENT.tape, [
    kicker('📰 The tape · headlines · SoSoValue'),
    heading(news.asset ? `${news.asset} news` : 'Hot in crypto'),
    lines.length ? lines.join('\n') : 'Nothing new on the wire.',
    buttons,
  ]);
}

export function marketCard(r: MarketReport, buttons?: CardPart): ContainerBuilder {
  const up = r.sectors.slice(0, 3);
  const down = r.sectors.slice(-3).reverse();
  return card(ACCENT.tape, [
    kicker('📊 The tape · market board · SoSoValue'),
    heading('Market board'),
    marketLine(r) || 'No market numbers right now.',
    r.sectors.length > 0 && divider(),
    r.sectors.length > 0 && `**Leading** ${up.map((s) => `${s.name} ${signedPct(s.change24h)}`).join(' · ')}`,
    r.sectors.length > 0 && `**Lagging** ${down.map((s) => `${s.name} ${signedPct(s.change24h)}`).join(' · ')}`,
    kicker('Sectors over the last 24 hours'),
    buttons,
  ]);
}

/**
 * Today's Page: the shared daily post. How the room did, what the market printed (skipping anything
 * unchanged since the last page), and the calls settled and due. Posted with each new question.
 */
export function todaysPageEmbed(s: LedgerSummary | null, now: number, book: PageBook | null): EmbedBuilder | null {
  const today = new Date(now).toISOString().slice(0, 10);
  const embed = new EmbedBuilder().setColor(0x2b2d31).setTitle(`📒 Today's Page · ${dayLabel(today)}`);

  const v = book?.verdict;
  if (v) {
    const [a, b] = v.q.spec.options;
    const answer = v.q.answer === 'a' ? a : b;
    const room =
      v.roomRight === null
        ? `${v.counts.a + v.counts.b} answered (${a} ${v.counts.a} · ${b} ${v.counts.b}).`
        : `Room said ${v.counts.a > v.counts.b ? a : b} ${Math.max(v.counts.a, v.counts.b)}–${Math.min(v.counts.a, v.counts.b)}: ${v.roomRight ? 'right' : 'missed'}.`;
    const season = book.roomSeason.total ? ` Room this month: ${book.roomSeason.right} of ${book.roomSeason.total}.` : '';
    embed.addFields({ name: `Room vs tape · ${dayLabel(v.q.spec.day)}`, value: `${v.q.spec.prompt} **${answer}**. ${v.q.resultText ?? ''}\n${room}${season}` });
  }

  if (s?.flows.length) {
    const session = s.flows[0]!.latest.date;
    const yesterday = new Date(now - 86_400_000).toISOString().slice(0, 10);
    if (session < yesterday) {
      embed.addFields({ name: 'Spot ETF flows', value: `No new US session since ${dayLabel(session)}.` });
    } else {
      const lines = s.flows.map((f) => {
        const lead = leadingFund(f);
        const streak = f.streak.days >= 2 ? ` · ${ordinal(f.streak.days)} day of ${f.latest.totalNetInflow! > 0 ? 'inflows' : 'outflows'}` : '';
        return `**${f.asset}** ${formatUsd(f.latest.totalNetInflow!, true)}${streak}${lead ? ` · led by ${lead.ticker} ${formatUsd(lead.netInflow, true)}` : ''}`;
      });
      embed.addFields({ name: `Spot ETF flows · ${dayLabel(session)}`, value: lines.join('\n') });
    }
  }
  // Until the first treasury scan finishes, "none reported" would be wrong, so leave the section out.
  if (s?.treasuriesReady && s.treasuryBuys.length) {
    embed.addFields({ name: 'Corporate BTC buys · last 7 days', value: s.treasuryBuys.slice(0, 4).map(purchaseLine).join('\n') });
  }
  if (s?.macro?.today.length) embed.addFields({ name: 'Macro today', value: s.macro.today.map(releaseLine).join('\n') });
  if (s?.macro?.fomc) embed.addFields({ name: `FOMC ${dayLabel(s.macro.fomc.meetingDate)}`, value: fomcLine(s.macro.fomc) });
  const market = s?.market && marketLine(s.market);
  if (market) embed.addFields({ name: 'Market', value: market });

  if (book && (book.settled.length || book.due.length || book.leaders.length)) {
    const lines = [
      ...book.settled.map((c) => `${c.status === 'won' ? '✓' : '✗'} ${callLink(c)} ${callHeadline(c)} · <@${c.callerId}> (${difficulty(c.chance)})`),
      ...book.due.map((c) => `⏳ ${callLink(c)} ${callHeadline(c)} · <@${c.callerId}> · ends ${discordTime(c.deadline, 'R')}`),
    ];
    const medals = ['🥇', '🥈', '🥉'];
    if (book.leaders.length) lines.push(`Season: ${book.leaders.map((l, i) => `${medals[i]} <@${l.userId}> ${formatPoints(l.points)}`).join(' · ')}`);
    embed.addFields({ name: 'Calls', value: lines.join('\n').slice(0, 1024) });
  }
  if (!embed.data.fields?.length) return null;
  return embed.setFooter({ text: `${s ? 'Market data: SoSoValue. ' : ''}Reply to this post to ask about it. Points are reputation, not money.` });
}

function streakLine(r: FlowReport): string {
  if (r.streak.days < 2) return '';
  const kind = r.latest.totalNetInflow! > 0 ? 'inflows' : 'outflows';
  return `${ordinal(r.streak.days)} straight day of ${kind}, ${formatUsd(r.streak.total, true)} over the run`;
}

function releaseLine(r: { event: string; actual: string; forecast: string; previous: string }): string {
  const parts = [r.actual ? `**${r.actual}**` : 'not out yet', r.forecast && `forecast ${r.forecast}`, r.previous && `previous ${r.previous}`];
  return `${r.event} · ${parts.filter(Boolean).join(' · ')}`;
}

function fomcLine(f: NonNullable<MacroReport['fomc']>): string {
  return f.ranges.map((r) => `${r.range} **${r.pct.toFixed(1)}%**`).join(' · ') || 'No probabilities published.';
}

function purchaseLine(p: Purchase): string {
  return `**${p.company}** (${p.ticker}) +${p.btcAcquired.toLocaleString('en-US')} BTC${p.costUsd ? ` · ${formatUsd(p.costUsd)}` : ''} · ${dayLabel(p.date)}`;
}

function marketLine(r: MarketReport): string {
  return [
    r.totalMarketCap !== null &&
      `Total cap ${formatUsd(r.totalMarketCap)}${r.marketCapChangePct !== null ? ` (${signedPct(r.marketCapChangePct / 100)} 24h)` : ''}`,
    r.volume24h !== null && `24h volume ${formatUsd(r.volume24h)}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function ordinal(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${n}${suffix}`;
}

function escapeLink(text: string): string {
  return text.replace(/[[\]]/g, '');
}
