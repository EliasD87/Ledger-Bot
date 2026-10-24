import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType } from 'discord.js';
import { describeAlert } from '../alerts/service.js';
import { discordTime } from '../format.js';
import type { MyPage } from '../pages/myPage.js';
import { measureLabel } from '../theses/spec.js';
import type { Thesis } from '../theses/store.js';
import { formatMeasure } from './thesisCards.js';
import { ACCENT, card, cards, divider, kicker, privateCards, row } from './ui.js';

export type PageAction = 'me' | 'record' | 'how' | 'catchup';

/** Button ids for Your Page. `guildId` rides along so the buttons also work from a DM. */
export function pageButtonId(action: PageAction, guildId = ''): string {
  return `page:${action}:${guildId}`;
}

export function parsePageButtonId(customId: string): { action: PageAction; guildId: string } | null {
  const match = /^page:(me|record|receipts|how|catchup):(\d*)$/.exec(customId);
  if (!match) return null;
  // Buttons on older messages still say "receipts".
  return { action: (match[1] === 'receipts' ? 'record' : match[1]) as PageAction, guildId: match[2]! };
}

/** A row with a single [My takes] button: the way back from any reply. */
export function pageRow(guildId = ''): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(myPageButton(guildId));
}

export function myPageButton(guildId = ''): ButtonBuilder {
  return new ButtonBuilder().setCustomId(pageButtonId('me', guildId)).setLabel('My takes').setStyle(ButtonStyle.Secondary);
}

/** "#12" linking to the thesis card when there is one. */
export function thesisLink(t: Thesis): string {
  return t.messageId ? `[#${t.id}](https://discord.com/channels/${t.guildId}/${t.channelId}/${t.messageId})` : `#${t.id}`;
}

const pct = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}%`;

/** Your page: private, since the last visit. `inGuild` adds the catch-up picker (it needs a server). */
export function myPageMessage(page: MyPage, guildId: string, inGuild: boolean) {
  const r = page.record;
  const settled = r.agedWell + r.agedBadly;
  const open = page.open.map(({ thesis: t, value, holding }) => {
    const where =
      value === null
        ? ''
        : t.spec.kind === 'flows'
          ? ` · ${formatMeasure(t.spec, value)} so far`
          : ` · ${measureLabel(t.spec)} ${pct(value / (t.startValue ?? value) - 1)} since logged`;
    return `${holding ? '▲' : holding === false ? '▽' : '·'} ${thesisLink(t)} ${t.claim}${where} · ${discordTime(t.checkAt!, 'R')}`;
  });
  const results = page.results.map((t) => `${t.status === 'aged_well' ? '✓' : '✗'} ${thesisLink(t)} ${t.claim} · ${t.status === 'aged_well' ? 'aged well' : 'aged badly'}`);
  const sided = page.sided.map(({ thesis: t, side }) => {
    const outcome = t.status === 'open' ? discordTime(t.checkAt!, 'R') : (side === 'with') === (t.status === 'aged_well') ? 'you read it right ✓' : 'you missed ✗';
    return `${thesisLink(t)} ${t.claim} · you're ${side} <@${t.authorId}> · ${outcome}`;
  });
  const watching = [
    ...page.watching.fired.slice(0, 3).map((a) => `🔔 ${plainAlert(a)} · fired ${discordTime(a.firedAt!, 'R')}`),
    ...page.watching.active.slice(0, 6).map((a) => `· ${plainAlert(a)}`),
  ];
  const picker = row(
    new ChannelSelectMenuBuilder()
      .setCustomId(pageButtonId('catchup', guildId))
      .setPlaceholder('Catch me up on a channel…')
      .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread),
  );

  return cards([
    card(ACCENT.page, [
      '## ⚖️ Your takes',
      kicker(page.firstVisit ? 'First visit · from now on this shows what changed since you last looked' : `Since ${discordTime(page.since, 'R')}`),
      settled || r.open
        ? `**${r.agedWell}** aged well · **${r.agedBadly}** aged badly · **${r.open}** open${r.contrarianWins ? ` · ${r.contrarianWins} contrarian win${r.contrarianWins === 1 ? '' : 's'}` : ''}`
        : 'Nothing on the record yet. Tell me what you think will happen: @Ledger sol beats eth this month',
      results.length > 0 && divider(),
      results.length > 0 && '**Checked since you looked**',
      ...clip(results),
      open.length > 0 && divider(),
      open.length > 0 && '**Open**',
      ...clip(open),
      sided.length > 0 && divider(),
      sided.length > 0 && '**Debates you joined**',
      ...clip(sided),
      watching.length > 0 && divider(),
      watching.length > 0 && '**Watching**',
      ...clip(watching),
      row(
        new ButtonBuilder().setCustomId(pageButtonId('record', guildId)).setLabel('My record').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(pageButtonId('how', guildId)).setLabel('How it works').setStyle(ButtonStyle.Secondary),
      ),
      inGuild && picker,
      kicker('Only you can see this · ▲ on track · ▽ not there yet'),
    ]),
  ]);
}

/** How it works, as a card. */
export function howItWorks() {
  return privateCards([
    card(ACCENT.page, [
      '## ⚖️ How Ledger works',
      kicker('Bring a take. Get the evidence. See how it ages.'),
      divider(),
      '**Bring a take.** "@Ledger sol beats eth this month", "nvda dip is a gift", "btc 100k by christmas", or `/take`. I pull the data and argue it out: the case for, the case against, what would prove you wrong, and what history says.',
      "**Log it.** Press *Log it* and it goes on the record with a check-back date. Others press *I'm with you* or *I'm against*.",
      '**See how it aged.** On the date I reply in the same thread: aged well or aged badly, and who read it right. Your record keeps score of takes, not money.',
      '**Just ask, too.** Prices, "what moved yesterday?", "how\'s SOL looking vs ETH?", "alert me if BTC drops below 80k", "catch me up".',
      kicker('Evidence, not forecasts · numbers from Binance, Yahoo and SoSoValue'),
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
