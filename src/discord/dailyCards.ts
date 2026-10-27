import { ButtonBuilder, ButtonStyle } from 'discord.js';
import { LEDGER_ID } from '../daily/rules.js';
import type { BoardRow, DayQuestion, Vote } from '../daily/store.js';
import { ACCENT, card, heading, kicker, picture, row } from './ui.js';

/**
 * The question of the day's cards: the question everyone votes on (open, locked, settled) and the
 * leaderboard. Plain words; it's a record of who reads the market well, so no betting talk.
 */

export type DayAction = 'with' | 'against' | 'board';
export const dayButtonId = (action: DayAction, id: number | string) => `qotd:${action}:${id}`;
export function parseDayButtonId(customId: string): { action: DayAction; id: string } | null {
  const m = /^qotd:(with|against|board):(.+)$/.exec(customId);
  return m ? { action: m[1] as DayAction, id: m[2]! } : null;
}

const money = (v: number) => (v >= 1000 ? Math.round(v).toLocaleString('en-US') : Number(v.toFixed(2)).toString());
const time = (ms: number) => `${new Date(ms).toISOString().slice(11, 16)} UTC`;
const dayLabel = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
export const side = (value: number) => (value === 1 ? 'with' : 'against');

const boardButton = (guildId: string) => new ButtonBuilder().setCustomId(dayButtonId('board', guildId)).setLabel('Leaderboard').setStyle(ButtonStyle.Secondary);

/** "9 of 15 got it right", from the votes of a settled question. */
export function rightLine(q: DayQuestion, votes: Vote[]): string {
  const people = votes.filter((v) => v.userId !== LEDGER_ID);
  const right = people.filter((v) => v.value === q.outcome).length;
  return people.length ? `${right} of ${people.length} got it right` : 'nobody voted';
}

/** The result in a few words. */
export function resultText(q: DayQuestion): string {
  if (q.status === 'void') return "no close that day, so it doesn't count";
  return q.outcome === 1 ? 'it happened' : "it didn't happen";
}

/**
 * The question as the channel sees it. Open: the With and Against buttons, Ledger's side kept hidden.
 * Locked: how the votes split and Ledger's side. Settled: what happened and who got it right.
 */
export function questionContainer(q: DayQuestion, votes: Vote[], now: number, opts: { yesterday?: string } = {}) {
  const open = q.status === 'open' && now < q.closesAt;
  const people = votes.filter((v) => v.userId !== LEDGER_ID);
  const withCount = people.filter((v) => v.value === 1).length;
  const closeWord = q.rule.stocks ? "today's US close" : "today's close (00:00 UTC tonight)";
  const settled = q.status === 'settled' || q.status === 'void';
  const parts = [
    kicker(`Question of the day · ${dayLabel(q.day)}`),
    heading(q.rule.text.en),
    open
      ? `With or against? Votes lock at **${time(q.closesAt)}**, and it settles on ${closeWord}. Ledger has voted too; you'll see its side when votes lock.`
      : settled
        ? `**Result: ${resultText(q)}.**${q.status === 'settled' ? ` ${rightLine(q, votes)}. Ledger was ${q.ledger === q.outcome ? 'right' : 'wrong'}.` : ''}`
        : `Votes are locked: ${withCount} with, ${people.length - withCount} against. Ledger is ${side(q.ledger)}. Result after ${closeWord.replace(' (00:00 UTC tonight)', '')}.`,
    open
      ? kicker(
          `${people.length} ${people.length === 1 ? 'vote' : 'votes'} so far · ${q.rule.kind !== 'beats' ? `Last close ${money(q.rule.ref)} · ` : ''}A right call few people made scores up to 100; one most people made, 50.`,
        )
      : settled
        ? kicker(`${withCount} voted with, ${people.length - withCount} against.`)
        : null,
    opts.yesterday ? kicker(opts.yesterday) : null,
    open
      ? row(
          new ButtonBuilder().setCustomId(dayButtonId('with', q.id)).setLabel('With').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(dayButtonId('against', q.id)).setLabel('Against').setStyle(ButtonStyle.Secondary),
          boardButton(q.guildId),
        )
      : row(boardButton(q.guildId)),
  ];
  return card(open ? ACCENT.amber : settled ? (q.status === 'void' ? ACCENT.muted : ACCENT.page) : ACCENT.open, parts);
}

export function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${s}`;
}

/** The leaderboard card, with its image; `viewer` adds where the member who asked stands. */
export function boardContainer(title: string, rows: BoardRow[], opts: { chart: boolean; viewer?: { userId: string; streak: number } }) {
  const people = rows.filter((r) => r.userId !== LEDGER_ID);
  const ledger = rows.find((r) => r.userId === LEDGER_ID);
  const ahead = ledger ? people.filter((r) => r.score > ledger.score).length : 0;
  const mine = opts.viewer ? people.findIndex((r) => r.userId === opts.viewer!.userId) : -1;
  return card(ACCENT.page, [
    kicker('Question of the day'),
    heading(`Leaderboard · ${title}`),
    people.length ? null : 'No points yet. They land when the first question settles.',
    opts.chart && picture('chart.png', `Leaderboard, ${title}`),
    people
      .slice(0, 3)
      .map((r, i) => `${i + 1}. <@${r.userId}> · ${r.score} points · ${r.right} of ${r.played} right`)
      .join('\n') || null,
    ledger && people.length ? kicker(ahead ? `${ahead} ${ahead === 1 ? 'member is' : 'members are'} ahead of Ledger.` : 'Nobody is ahead of Ledger yet.') : null,
    opts.viewer
      ? kicker(
          mine >= 0
            ? `You: ${ordinal(mine + 1)} of ${people.length}, ${people[mine]!.score} points${opts.viewer.streak > 1 ? `, ${opts.viewer.streak} right in a row` : ''}.`
            : 'You have no points here yet. Vote on the next question.',
        )
      : null,
    kicker('Right calls score 50 to 100; the fewer people who got it, the more. Nothing to win, just the record.'),
  ]);
}
