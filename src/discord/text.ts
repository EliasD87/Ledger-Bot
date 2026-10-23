/** Names to swap in for Discord's raw `<@id>` / `<@&id>` / `<#id>` mention syntax. */
export interface MentionNames {
  selfId: string;
  selfRoleId: string | undefined;
  users: ReadonlyMap<string, string>;
  roles: ReadonlyMap<string, string>;
  channels: ReadonlyMap<string, string>;
}

/** Makes a Discord message readable for the model: names instead of IDs, no self-mentions, capped length. */
export function readableContent(raw: string, names: MentionNames, maxChars: number): string {
  const text = raw
    .replace(/<@!?(\d+)>/g, (_, id: string) => (id === names.selfId ? '' : `@${names.users.get(id) ?? 'someone'}`))
    .replace(/<@&(\d+)>/g, (_, id: string) => (id === names.selfRoleId ? '' : `@${names.roles.get(id) ?? 'role'}`))
    .replace(/<#(\d+)>/g, (_, id: string) => `#${names.channels.get(id) ?? 'channel'}`)
    .replace(/<a?:(\w+):\d+>/g, ':$1:')
    .replace(/[ \t]+/g, ' ')
    .trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/** IDs of roles tagged in raw message text (`<@&id>`), whether or not Discord counted them as mentions. */
export function roleMentionIds(raw: string): string[] {
  return [...raw.matchAll(/<@&(\d+)>/g)].map((m) => m[1]!);
}

const DISCORD_LIMIT = 2000;

/**
 * Tidies a model reply for posting: no name prefix, no live @everyone/@here, within Discord's
 * length limit. Also swaps the betting phrases the model still reaches for now and then ("long shot",
 * "pays for") with ones that mean the same thing. Denials like "Not betting" are left alone.
 */
export function postableReply(text: string): string {
  const cleaned = text
    .replace(/^\s*\**ledger\**\s*:\s*/i, '')
    .replace(/@(everyone|here)/g, '@​$1')
    .replace(/\b(a )?long[- ]?shot(s)?( call(s)?)?\b/gi, (match, article, plural, _call, plural2) => {
      const phrase = `${article ? 'an ' : ''}unlikely call${plural || plural2 ? 's' : ''}`;
      return /^[A-Z]/.test(match) ? phrase[0]!.toUpperCase() + phrase.slice(1) : phrase;
    })
    .replace(/\bpays for\b/g, 'rewards')
    .replace(/\bpay for\b/g, 'reward')
    .trim();
  return cleaned.length > DISCORD_LIMIT ? `${cleaned.slice(0, DISCORD_LIMIT - 1)}…` : cleaned;
}
