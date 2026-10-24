import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  type ContainerBuilder,
} from 'discord.js';
import { describeAlert } from '../alerts/service.js';
import { type Board, type Call, seasonStart } from '../calls/store.js';
import { callHeadline } from '../calls/service.js';
import { dayLabel } from '../daily/questions.js';
import type { DailyStore, Question } from '../daily/store.js';
import { leadingFund } from '../desk/desk.js';
import { discordTime, formatPoints, formatUsd, monthLabel } from '../format.js';
import type { MyPage } from '../pages/myPage.js';
import { ACCENT, card, cards, divider, kicker, privateCards, row } from './ui.js';


export type PageAction = 'me' | 'receipts' | 'how' | 'catchup';

/** Button ids for Your Page. `guildId` rides along so the buttons also work from a DM. */
export function pageButtonId(action: PageAction, guildId = ''): string {
  return `page:${action}:${guildId}`;
}

export function parsePageButtonId(customId: string): { action: PageAction; guildId: string } | null {
  const match = /^page:(me|receipts|how|catchup):(\d*)$/.exec(customId);
  return match ? { action: match[1] as PageAction, guildId: match[2]! } : null;
}

/** A row with a single [My page] button: the way back into the loop from any reply. */
export function pageRow(guildId = ''): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(myPageButton(guildId));
}

export function myPageButton(guildId = ''): ButtonBuilder {
  return new ButtonBuilder().setCustomId(pageButtonId('me', guildId)).setLabel('My page').setEmoji('📒').setStyle(ButtonStyle.Secondary);
}

export function callLink(call: Call): string {
  return call.messageId ? `[#${call.id}](https://discord.com/channels/${call.guildId}/${call.channelId}/${call.messageId})` : `#${call.id}`;
}

function questionLink(q: Question): string | null {
  return q.messageId ? `https://discord.com/channels/${q.guildId}/${q.channelId}/${q.messageId}` : null;
}

function optionOf(q: Question, choice: 'a' | 'b' | undefined): string | undefined {
  return choice ? q.spec.options[choice === 'a' ? 0 : 1] : undefined;
}

/** When a closed question is expected to settle, in words. */
export function settlesWhen(q: Question): string {
  return q.spec.windowEnd ? `settles ${discordTime(q.spec.windowEnd + 60_000, 'R')}` : 'settles when SoSoValue posts the flows (T+1)';
}

/** Your Page: private, since the last visit. `inGuild` adds the catch-up picker (it needs a server). */
export function myPageMessage(page: MyPage, guildId: string, inGuild: boolean) {
  const r = page.record;
  const calls: string[] = [];
  for (const s of r.settled.slice(0, 5)) {
    const mark = s.position.result === 'won' ? '✓' : '✗';
    const verdict = s.position.result === 'won' ? 'right' : 'wrong';
    calls.push(
      s.asCaller
        ? `${mark} ${callLink(s.call)} ${callHeadline(s.call)} · ${verdict} · **${formatPoints(s.position.pnl ?? 0)}**`
        : `${mark} ${callLink(s.call)} ${callHeadline(s.call)} · you ${s.position.side === 'back' ? 'agreed' : 'disagreed'} · ${verdict}`,
    );
  }
  for (const o of r.open.slice(0, 5)) {
    const away = o.price ? ` · ${Math.abs((o.call.target / o.price - 1) * 100).toFixed(1)}% away` : '';
    const role = o.asCaller ? 'your call' : o.side === 'back' ? 'you agree' : 'you disagree';
    calls.push(`⏳ ${callLink(o.call)} ${callHeadline(o.call)} · ${role}${away} · ends ${discordTime(o.call.deadline, 'R')}`);
  }
  const leanTotal = r.leans.right + r.leans.wrong;
  const standing =
    `Season rep **${formatPoints(r.rep)}**${r.rank ? ` · #${r.rank} of ${r.ranked}` : ''}` +
    (leanTotal ? ` · agree/disagree ${r.leans.right} of ${leanTotal} right` : '');

  // The daily question, only where the server runs it; nobody is pushed into it.
  const q = page.question;
  const question: string[] = [];
  if (q.current) {
    const mine = optionOf(q.current.q, q.current.mine);
    question.push(`${q.current.q.spec.prompt} · ${mine ? `you said **${mine}**` : 'not answered yet'} · closes ${discordTime(q.current.q.closesAt, 'R')}`);
  }
  for (const p of q.pending.slice(0, 2)) {
    const mine = optionOf(p.q, p.mine);
    if (mine) question.push(`${dayLabel(p.q.spec.day)}: you said **${mine}** · ${settlesWhen(p.q)}`);
  }
  if (q.last && (q.last.q.resolvedAt ?? 0) >= page.since - 60_000) {
    const answer = optionOf(q.last.q, q.last.q.answer ?? undefined);
    const mine = optionOf(q.last.q, q.last.mine);
    question.push(`${dayLabel(q.last.q.spec.day)}: **${answer ?? 'no answer'}**${mine ? ` · you said ${mine} ${mine === answer ? '✓' : '✗'}` : ''}`);
  }
  if (question.length || q.streak) question.push(kicker(`Streak ${q.streak} day${q.streak === 1 ? '' : 's'}`));

  const w = page.watching;
  const watching = [
    ...w.fired.slice(0, 3).map((a) => `🔔 ${plainAlert(a)} · fired ${discordTime(a.firedAt!, 'R')}`),
    ...w.active.slice(0, 6).map((a) => `· ${plainAlert(a)}`),
  ];

  const tape = page.tape
    ? [
        ...page.tape.flows.map((f) => {
          const lead = leadingFund(f);
          return `${f.asset} ETFs ${dayLabel(f.latest.date)} **${formatUsd(f.latest.totalNetInflow!, true)}**${lead ? ` · ${lead.ticker} led` : ''}`;
        }),
        ...page.tape.macro.slice(0, 3).map((m) => `${m.event} **${m.actual}**${m.forecast ? ` · forecast ${m.forecast}` : ''}`),
      ]
    : [];

  const link = q.current && !q.current.mine ? questionLink(q.current.q) : null;
  const buttons = row(
    ...(link ? [new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(link).setLabel("Answer today's question")] : []),
    new ButtonBuilder().setCustomId(pageButtonId('receipts', guildId)).setLabel('Receipts').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(pageButtonId('how', guildId)).setLabel('How it works').setStyle(ButtonStyle.Secondary),
  );
  const picker = row(
    new ChannelSelectMenuBuilder()
      .setCustomId(pageButtonId('catchup', guildId))
      .setPlaceholder('Catch me up on a channel…')
      .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread),
  );

  return cards([
    card(ACCENT.page, [
      '## 📒 Your page',
      kicker(page.firstVisit ? 'First visit · from now on this shows what changed since you last looked' : `Since ${discordTime(page.since, 'R')}`),
      divider(),
      '**Calls**',
      ...(calls.length ? clip(calls) : [kicker('Nothing yet. Make one: @Ledger I call BTC hits 90k by Friday')]),
      kicker(standing),
      question.length > 0 && divider(),
      question.length > 0 && '**Daily question**',
      ...clip(question),
      watching.length > 0 && divider(),
      watching.length > 0 && '**Watching**',
      ...clip(watching),
      tape.length > 0 && divider(),
      tape.length > 0 && '**Since you looked**',
      ...clip(tape),
      buttons,
      inGuild && picker,
      kicker('Only you can see this · points are reputation, not money'),
    ]),
  ]);
}

/** Receipts: one builder for /receipts and the [Receipts] button, so the numbers always agree. */
export function receiptsContainer(board: Board, daily: DailyStore, guildId: string, member: { id: string; name: string }, now: number): ContainerBuilder {
  const r = board.receipts(guildId, member.id, seasonStart(now));
  const d = daily.stats(guildId, member.id, seasonStart(now));
  const title = `## 📒 Receipts · ${member.name}`;
  const settled = r.lifetime.wins + r.lifetime.losses;
  const leanTotal = r.leans.right + r.leans.wrong;
  if (!settled && !r.open.length && !d.answered && !leanTotal) {
    return card(ACCENT.page, [title, 'Nothing on the record yet.', kicker('Make a call: @Ledger I call BTC hits 90k by Friday')]);
  }
  const made = r.callsMade.open + r.callsMade.won + r.callsMade.lost;
  return card(ACCENT.page, [
    title,
    `Rep **${formatPoints(r.season.points + d.seasonPoints)}** in ${monthLabel(now)} · **${formatPoints(r.lifetime.points + d.points)}** lifetime`,
    d.answered > 0 && kicker(`Season: calls ${formatPoints(r.season.points)} · daily question ${formatPoints(d.seasonPoints)}`),
    divider(),
    `**Calls** ${made} made · ${r.callsMade.won} right · ${r.callsMade.lost} wrong · ${r.callsMade.open} open`,
    r.recent.length > 0 && `**Recent** ${r.recent.map((x) => (x === 'won' ? '✓' : '✗')).join(' ')}`,
    r.biggestHit && `**Best call** ${callLink(r.biggestHit.call)} ${callHeadline(r.biggestHit.call)} · ${formatPoints(r.biggestHit.points)}`,
    leanTotal > 0 && `**Agree / disagree** ${r.leans.right} of ${leanTotal} right`,
    d.answered > 0 && `**Daily question** ${d.right} of ${d.answered} right · ${d.streak}-day streak`,
    kicker('A call scores its result minus its rating · points are reputation, not money'),
  ]);
}

/** How it works, as a card. */
export function howItWorks() {
  return privateCards([
    card(ACCENT.page, [
      '## 📒 How Ledger works',
      divider(),
      '**Just ask.** Mention me or reply to me: "what moved yesterday?", "btc price?", "alert me if BTC drops below 80k", "catch me up", "what\'s kai\'s record?"',
      "**Calls.** `@Ledger I call BTC hits 90k by Friday` or `/call`. I rate it from recent volatility; lock it in and the market settles it. The less likely a call was, the more it counts when it lands. Others can agree or disagree; that goes on their receipts, not their rep.",
      '**Your page** `/ledger` shows what changed since you last looked. **Watchlist** `/watch` DMs you when a price moves, flows print or CPI drops.',
      kicker('Reply to any Ledger post to ask about it · optional daily post: /ledger-setup'),
    ]),
  ]);
}

function plainAlert(a: Parameters<typeof describeAlert>[0]): string {
  return describeAlert(a).replace(/^Alert #\d+: /, '');
}

/** Keeps a section's lines inside Discord's text limits. */
function clip(lines: string[]): string[] {
  const out: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length + 1 > 900) break;
    out.push(line);
    size += line.length + 1;
  }
  return out;
}
