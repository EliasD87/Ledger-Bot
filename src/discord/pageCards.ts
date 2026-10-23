import {
  ActionRowBuilder,
  type BaseMessageOptions,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
} from 'discord.js';
import { describeAlert } from '../alerts/service.js';
import { type Board, type Call, seasonStart } from '../calls/store.js';
import { callHeadline } from '../calls/service.js';
import { dayLabel } from '../daily/questions.js';
import type { DailyStore, Question } from '../daily/store.js';
import { leadingFund } from '../desk/desk.js';
import { discordTime, formatPoints, formatPrice, formatUsd, monthLabel } from '../format.js';
import type { MyPage } from '../pages/myPage.js';

const BLUE = 0x5865f2;

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
export function myPageMessage(page: MyPage, guildId: string, inGuild: boolean): BaseMessageOptions {
  const embed = new EmbedBuilder()
    .setColor(BLUE)
    .setTitle('📒 Your page')
    .setDescription(page.firstVisit ? 'First visit. From now on this shows what changed since you last looked.' : `Since ${discordTime(page.since, 'R')}.`);

  // Receipts
  const r = page.record;
  const lines: string[] = [];
  for (const s of r.settled.slice(0, 5)) {
    const mark = s.position.result === 'won' ? '✅' : '❌';
    lines.push(
      s.asCaller
        ? `${mark} ${callLink(s.call)} ${callHeadline(s.call)}: ${s.position.result === 'won' ? 'right' : 'wrong'} · ${formatPoints(s.position.pnl ?? 0)}`
        : `${mark} you ${s.position.side === 'back' ? 'agreed with' : 'disagreed with'} ${callLink(s.call)}: ${s.position.result === 'won' ? 'right' : 'wrong'}`,
    );
  }
  for (const o of r.open.slice(0, 5)) {
    const distance = o.price ? ` · now ${formatPrice(o.price)} (${Math.abs((o.call.target / o.price - 1) * 100).toFixed(1)}% away)` : '';
    const role = o.asCaller ? 'your call' : o.side === 'back' ? 'you agreed' : 'you disagreed';
    lines.push(`⏳ ${callLink(o.call)} ${callHeadline(o.call)} · ${role}${distance} · ends ${discordTime(o.call.deadline, 'R')}`);
  }
  const leanTotal = r.leans.right + r.leans.wrong;
  lines.push(
    `Season rep ${formatPoints(r.rep)}${r.rank ? ` · #${r.rank} of ${r.ranked}` : ''}` +
      (leanTotal ? ` · agree/disagree ${r.leans.right} of ${leanTotal} right` : ''),
  );
  embed.addFields({ name: 'Receipts', value: clip(lines) });

  // Question
  const q = page.question;
  const qLines: string[] = [];
  if (q.current) {
    const mine = optionOf(q.current.q, q.current.mine);
    qLines.push(`**${q.current.q.spec.prompt}** ${mine ? `You said **${mine}**.` : 'Not answered yet.'} Closes ${discordTime(q.current.q.closesAt, 'R')}.`);
  }
  for (const p of q.pending.slice(0, 2)) {
    const mine = optionOf(p.q, p.mine);
    if (mine) qLines.push(`${dayLabel(p.q.spec.day)}: you said **${mine}**, ${settlesWhen(p.q)}.`);
  }
  if (q.last && (q.last.q.resolvedAt ?? 0) >= page.since - 60_000) {
    const answer = optionOf(q.last.q, q.last.q.answer ?? undefined);
    const mine = optionOf(q.last.q, q.last.mine);
    qLines.push(
      `${dayLabel(q.last.q.spec.day)}: **${answer ?? 'no answer'}**. ${q.last.q.resultText ?? ''}${mine ? ` You said ${mine} ${mine === answer ? '✅' : '❌'}.` : ''}`,
    );
  }
  // Only where the server runs the daily question; nobody is pushed into it.
  if (qLines.length || q.streak) {
    qLines.push(`Streak: ${q.streak} day${q.streak === 1 ? '' : 's'}.`);
    embed.addFields({ name: 'Question', value: clip(qLines) });
  }

  // Watching
  const w = page.watching;
  if (w.active.length || w.fired.length) {
    const wLines = w.fired.slice(0, 3).map((a) => `🔔 fired ${discordTime(a.firedAt!, 'R')}: ${describeAlert(a).replace(/^Alert #\d+: /, '')}`);
    if (w.active.length) wLines.push(`Watching: ${w.active.map((a) => describeAlert(a).replace(/^Alert #\d+: /, '')).join(' · ')}`);
    embed.addFields({ name: 'Watchlist', value: clip(wLines) });
  }

  // Tape since
  if (page.tape) {
    const tLines = page.tape.flows.map((f) => {
      const lead = leadingFund(f);
      return `${f.asset} spot ETFs ${dayLabel(f.latest.date)}: ${formatUsd(f.latest.totalNetInflow!, true)}${lead ? `, led by ${lead.ticker}` : ''}`;
    });
    for (const m of page.tape.macro.slice(0, 3)) tLines.push(`${m.event}: ${m.actual}${m.forecast ? ` (forecast ${m.forecast})` : ''}`);
    if (tLines.length) embed.addFields({ name: 'Tape since', value: clip(tLines) });
  }
  embed.setFooter({ text: 'Only you can see this. Reply-to-ask works on any Ledger post. Points are reputation, not money.' });

  const buttons = new ActionRowBuilder<ButtonBuilder>();
  const link = q.current && !q.current.mine ? questionLink(q.current.q) : null;
  if (link) buttons.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(link).setLabel("Answer today's question"));
  buttons.addComponents(
    new ButtonBuilder().setCustomId(pageButtonId('receipts', guildId)).setLabel('Receipts').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(pageButtonId('how', guildId)).setLabel('How it works').setStyle(ButtonStyle.Secondary),
  );
  const picker = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId(pageButtonId('catchup', guildId))
      .setPlaceholder('Catch me up on a channel…')
      .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread),
  );
  return { embeds: [embed], components: inGuild ? [buttons, picker] : [buttons] };
}

/** Receipts: one builder for /receipts, the [Receipts] button and chat, so the numbers always agree. */
export function receiptsEmbed(board: Board, daily: DailyStore, guildId: string, member: { id: string; name: string }, now: number): EmbedBuilder {
  const r = board.receipts(guildId, member.id, seasonStart(now));
  const d = daily.stats(guildId, member.id, seasonStart(now));
  const embed = new EmbedBuilder().setColor(BLUE).setTitle(`📒 Receipts · ${member.name}`);
  const calls = r.lifetime.wins + r.lifetime.losses;
  const leanTotal = r.leans.right + r.leans.wrong;
  if (!calls && !r.open.length && !d.answered && !leanTotal) return embed.setDescription('Nothing on the record yet.');
  const made = r.callsMade.open + r.callsMade.won + r.callsMade.lost;
  embed.addFields(
    {
      name: `${monthLabel(now)} season`,
      value: `Rep ${formatPoints(r.season.points + d.seasonPoints)} (calls ${formatPoints(r.season.points)} · daily ${formatPoints(d.seasonPoints)})`,
      inline: true,
    },
    { name: 'Lifetime rep', value: formatPoints(r.lifetime.points + d.points), inline: true },
    { name: 'Calls', value: `${made} made · ${r.callsMade.won} right · ${r.callsMade.lost} wrong · ${r.callsMade.open} open`, inline: true },
    { name: 'Agree / disagree', value: leanTotal ? `${r.leans.right} of ${leanTotal} right` : 'none yet', inline: true },
  );
  if (d.answered) embed.addFields({ name: 'Daily Question', value: `${d.right} right of ${d.answered} · ${d.streak}-day streak`, inline: true });
  if (r.biggestHit) embed.addFields({ name: 'Best call', value: `${callLink(r.biggestHit.call)} ${callHeadline(r.biggestHit.call)} · ${formatPoints(r.biggestHit.points)}` });
  if (r.recent.length) embed.addFields({ name: 'Recent calls', value: r.recent.map((x) => (x === 'won' ? '✅' : '❌')).join(' ') });
  return embed.setFooter({ text: 'A call scores its result minus its rating. Points are reputation, not money.' });
}

export const HOW_IT_WORKS = [
  "📒 **How Ledger works.** I don't call the market. I keep score.",
  '**Just ask.** Mention me or reply to me: "what moved yesterday?", "alert me if BTC drops below 80k", "catch me up", "what\'s kai\'s record?".',
  '**Calls**: `@Ledger I call BTC hits 90k by Friday` or `/call`. I rate it from recent volatility; lock it in and the market settles it. A call scores its result minus its rating (right on a 20% call: +80; wrong: −20). Others can agree or disagree; that goes on their receipts, not their rep.',
  '**Your page** (`/ledger`): what changed for you since you last looked. **Watchlist** (`/watch`): DMs when your assets move, flows print or CPI drops.',
  "Optional: an admin can turn on **Today's Page** (`/ledger-setup`), a daily post with a one-tap question.",
  'Reply to any Ledger post to ask about it. Forecasts: Doji. Drinks: Zima.',
].join('\n');

function clip(lines: string[]): string {
  const out: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length + 1 > 1000) break;
    out.push(line);
    size += line.length + 1;
  }
  return out.join('\n') || '—';
}
