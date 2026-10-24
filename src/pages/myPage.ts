import type { Alert, AlertStore } from '../alerts/store.js';
import type { Db } from '../db/index.js';
import type { Measure } from '../theses/measure.js';
import { held } from '../theses/spec.js';
import type { Record, Side, Thesis, ThesisStore } from '../theses/store.js';

const DAY = 24 * 60 * 60 * 1000;

/** When each member last opened their page. Only page opens are recorded, never what anyone reads or says. */
export class Activity {
  constructor(private readonly db: Db) {}

  lastPageAt(guildId: string, userId: string): number | null {
    const row = this.db.prepare('SELECT last_page_at AS at FROM member_activity WHERE guild_id = ? AND user_id = ?').get(guildId, userId) as
      | { at: number | null }
      | undefined;
    return row?.at ?? null;
  }

  touch(guildId: string, userId: string, now: number): void {
    this.db
      .prepare(
        `INSERT INTO member_activity (guild_id, user_id, last_page_at) VALUES (?, ?, ?)
         ON CONFLICT (guild_id, user_id) DO UPDATE SET last_page_at = excluded.last_page_at`,
      )
      .run(guildId, userId, now);
  }
}

export interface MyPage {
  since: number;
  firstVisit: boolean;
  /** Their open theses, with where each stands right now. */
  open: { thesis: Thesis; value: number | null; holding: boolean | null }[];
  /** Their theses checked since the last visit. */
  results: Thesis[];
  /** Debates they took a side in: open, or checked since the last visit. */
  sided: { thesis: Thesis; side: Side }[];
  record: Record;
  watching: { active: Alert[]; fired: Alert[] };
}

export interface PageDeps {
  theses: ThesisStore;
  measure: Pick<Measure, 'now'>;
  alerts: AlertStore;
  activity: Activity;
}

/** Your page: your takes and what changed since you last looked. Live prices, no language model. */
export async function buildMyPage(deps: PageDeps, guildId: string, userId: string, now: number): Promise<MyPage> {
  const { theses, measure, alerts, activity } = deps;
  const last = activity.lastPageAt(guildId, userId);
  const since = Math.min(Math.max(last ?? now - DAY, now - 7 * DAY), now);
  const mine = theses.byAuthor(guildId, userId, since);
  const open = await Promise.all(
    mine
      .filter((t) => t.status === 'open')
      .slice(0, 5)
      .map(async (thesis) => {
        const value = await measure.now(thesis.spec, thesis.startAt ?? 0).catch(() => null);
        return { thesis, value, holding: value === null ? null : held(thesis.spec, thesis.startValue ?? 0, value) };
      }),
  );
  activity.touch(guildId, userId, now);
  return {
    since,
    firstVisit: last === null,
    open,
    results: mine.filter((t) => t.status === 'aged_well' || t.status === 'aged_badly'),
    sided: theses.sidedBy(guildId, userId, since).slice(0, 5),
    record: theses.record(guildId, userId),
    watching: { active: alerts.forUser(guildId, userId), fired: alerts.firedSince(guildId, userId, since) },
  };
}
