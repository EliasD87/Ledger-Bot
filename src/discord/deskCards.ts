import { EmbedBuilder } from 'discord.js';
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

const BLUE = 0x5865f2;
const SOURCE = 'Data: SoSoValue. Entries, not opinions.';

export function flowsEmbed(r: FlowReport): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(BLUE)
    .setTitle(`📒 ${r.asset} spot ETF flows (US)`)
    .setDescription(`**${dayLabel(r.latest.date)}: ${formatUsd(r.latest.totalNetInflow!, true)} net**\n${streakLine(r)}`)
    .addFields({
      name: 'Recent sessions',
      value: r.days.slice(0, 5).map((d) => `${dayLabel(d.date)}: ${formatUsd(d.totalNetInflow!, true)}`).join('\n'),
      inline: true,
    });
  const totals = [
    r.latest.cumNetInflow !== null && `Since launch: ${formatUsd(r.latest.cumNetInflow, true)}`,
    r.latest.totalNetAssets !== null && `Net assets: ${formatUsd(r.latest.totalNetAssets)}`,
    r.latest.totalValueTraded !== null && `Traded: ${formatUsd(r.latest.totalValueTraded)}`,
  ].filter(Boolean);
  if (totals.length) embed.addFields({ name: 'Totals', value: totals.join('\n'), inline: true });
  if (r.funds.length) {
    const shown = r.funds.length <= 8 ? r.funds : [...r.funds.slice(0, 5), ...r.funds.slice(-3)];
    embed.addFields({ name: 'By fund', value: shown.map((f) => `${f.ticker}: ${formatUsd(f.netInflow, true)}`).join('\n') });
  }
  return embed.setFooter({ text: `${SOURCE} Flows settle the next day.` });
}

export function macroEmbed(r: MacroReport): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(BLUE).setTitle('📒 Macro docket');
  if (r.today.length) embed.addFields({ name: 'Today', value: r.today.map(releaseLine).join('\n') });
  const todayDate = r.today[0]?.date;
  const later = r.upcoming.filter((d) => d.date !== todayDate);
  if (later.length) {
    embed.addFields({
      name: 'Next 7 days',
      value: later.map((d) => `**${dayLabel(d.date)}**: ${d.events.slice(0, 6).join(', ')}`).join('\n').slice(0, 1024),
    });
  }
  if (r.fomc) embed.addFields({ name: `FOMC ${dayLabel(r.fomc.meetingDate)}`, value: fomcLine(r.fomc) });
  if (!r.today.length && !later.length && !r.fomc) embed.setDescription('Nothing on the docket this week.');
  return embed.setFooter({ text: SOURCE });
}

export function treasuriesEmbed(purchases: Purchase[], ready: boolean, days: number): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(BLUE).setTitle(`📒 Corporate BTC buys · last ${days} days`);
  if (!ready) return embed.setDescription('Still compiling the list. The first scan takes a few minutes after a restart.');
  if (!purchases.length) return embed.setDescription(`No purchases reported in the last ${days} days.`).setFooter({ text: SOURCE });
  return embed.setDescription(purchases.slice(0, 12).map(purchaseLine).join('\n')).setFooter({ text: SOURCE });
}

export function newsEmbed(news: { asset: string | null; items: NewsItem[] }): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(BLUE).setTitle(news.asset ? `📒 ${news.asset} news` : '📒 Hot in crypto');
  if (!news.items.length) return embed.setDescription('Nothing new on the wire.');
  const lines = news.items.slice(0, 6).map((n) => {
    const title = n.title.length > 110 ? `${n.title.slice(0, 109)}…` : n.title;
    return `${n.link ? `[${escapeLink(title)}](${n.link})` : title}${n.releasedAt ? ` · ${discordTime(n.releasedAt, 'R')}` : ''}`;
  });
  return embed.setDescription(lines.join('\n')).setFooter({ text: 'Headlines: SoSoValue.' });
}

export function marketEmbed(r: MarketReport): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(BLUE).setTitle('📒 Market board').setDescription(marketLine(r) || 'No market numbers right now.');
  if (r.sectors.length) {
    const up = r.sectors.slice(0, 3);
    const down = r.sectors.slice(-3).reverse();
    embed.addFields(
      { name: 'Leading sectors (24h)', value: up.map((s) => `${s.name}: ${signedPct(s.change24h)}`).join('\n'), inline: true },
      { name: 'Lagging sectors (24h)', value: down.map((s) => `${s.name}: ${signedPct(s.change24h)}`).join('\n'), inline: true },
    );
  }
  return embed.setFooter({ text: SOURCE });
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
      ...book.settled.map((c) => `${c.status === 'won' ? '✅' : '❌'} ${callLink(c)} ${callHeadline(c)} · <@${c.callerId}> (${difficulty(c.chance)})`),
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
  return `${ordinal(r.streak.days)} straight day of ${kind}: ${formatUsd(r.streak.total, true)} over the run.`;
}

function releaseLine(r: { event: string; actual: string; forecast: string; previous: string }): string {
  const parts = [r.actual ? `**${r.actual}**` : 'not out yet', r.forecast && `forecast ${r.forecast}`, r.previous && `previous ${r.previous}`];
  return `${r.event}: ${parts.filter(Boolean).join(' · ')}`;
}

function fomcLine(f: NonNullable<MacroReport['fomc']>): string {
  return f.ranges.map((r) => `${r.range}: ${r.pct.toFixed(1)}%`).join(' · ') || 'No probabilities published.';
}

function purchaseLine(p: Purchase): string {
  return `${p.company} (${p.ticker}): +${p.btcAcquired.toLocaleString('en-US')} BTC${p.costUsd ? ` for ${formatUsd(p.costUsd)}` : ''} · ${dayLabel(p.date)}`;
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
