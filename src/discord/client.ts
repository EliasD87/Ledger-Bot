import {
  Client,
  GatewayIntentBits,
  OAuth2Routes,
  OAuth2Scopes,
  Options,
  PermissionFlagsBits,
  PermissionsBitField,
} from 'discord.js';

/**
 * @param readContent request the privileged Message Content intent. It must be switched on in the
 * Developer Portal (Bot → Privileged Gateway Intents), or Discord refuses the connection. Without
 * it, Ledger only sees the text of messages that ping it.
 */
export function createClient({ readContent }: { readContent: boolean }): Client {
  const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];
  if (readContent) intents.push(GatewayIntentBits.MessageContent);
  return new Client({
    intents,
    // Ledger never pings anyone except the member it replies to.
    allowedMentions: { parse: [], repliedUser: true },
    // Keep memory flat: reply chains are short and recent.
    makeCache: Options.cacheWithLimits({ ...Options.DefaultMakeCacheSettings, MessageManager: 200 }),
    sweepers: { ...Options.DefaultSweeperSettings, messages: { interval: 3600, lifetime: 6 * 3600 } },
  });
}

/** Link a server admin opens to add Ledger, with exactly the permissions it uses. */
export function inviteLink(appId: string): string {
  const url = new URL(OAuth2Routes.authorizationURL);
  url.searchParams.set('client_id', appId);
  url.searchParams.set('scope', [OAuth2Scopes.Bot, OAuth2Scopes.ApplicationsCommands].join(' '));
  url.searchParams.set(
    'permissions',
    new PermissionsBitField([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.SendMessagesInThreads,
      PermissionFlagsBits.EmbedLinks, // call cards are embeds
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.AddReactions,
    ]).bitfield.toString(),
  );
  return url.toString();
}
