# Ledger

> Bring a take. Ledger argues it out with real data, puts it on the record, and comes back to tell everyone how it aged.

Ledger is one of the bartenders at the CybeReator bar, the CybeReator Discord, working alongside the house bartenders Doji, Sumi and Zima. Members bring it their market takes. Ledger stress-tests each one: the case for, the case against, what would prove it wrong, and what history says. It logs the takes people stand by and checks back on the date. In between, it's good company for talk about crypto, US stocks and NFTs.

More on what it does and why: [docs/PRODUCT.md](docs/PRODUCT.md).

## What members can do

| Try | What happens |
|---|---|
| `@Ledger SOL beats ETH this month`, or `/take` | A stress-test card. **Log it** puts it on the record; others press **I'm with you** or **I'm against**. On the date, Ledger replies with how it aged. |
| `@Ledger is NVDA stretched?` | Analysis built from computed facts, not just numbers read out |
| `@Ledger CybeReator floor?`, `@Ledger pudgy penguins stats` | NFT floors, volume, owners and listings, including takes on floors |
| `@Ledger alert me if BTC drops below 80k`, or `/watch` | A DM when it happens |
| `/ledger` | Your open takes with live progress, results, and your record |
| `/takes` | The open debates, or one member's record |
| `/tape` | ETF flows, macro, corporate BTC buys, headlines and the market board |
| `@Ledger catch me up`, `/recall` | What the server has been saying |

To keep a conversation going, reply to Ledger's message. Replying to any Ledger post asks about that post.

For admins: `/ledger-setup` picks a channel for big market prints and turns on the archive behind `/recall`. `/ledger-admin stats` shows engagement numbers, and `/ledger-admin void` voids a take that was measured with bad data.

## Stack

- Node.js 22.13+ with built-in SQLite, TypeScript, and discord.js 14 (Components V2 cards).
- DeepSeek through the `openai` SDK. When DeepSeek is busy, Ledger waits and asks again before giving up.
- Market data: Binance (OKX and Bybit as backups), Yahoo (Nasdaq as backup), SoSoValue (ETF flows, macro, headlines, stock quotes), DripStack (newsletter and podcast analysts).
- NFT data: CoinGecko, Magic Eden, and ValueMint for CybeReator on ValueChain.
- All outside data is fetched by background syncs with rate limits. Chats read from the database.

## Setup

You need:

- **A Discord bot token.** Ledger works out its own application ID, registers its slash commands in every server it's in, and prints an invite link on start.
- **A DeepSeek API key.**
- **Optional keys:** SoSoValue, DripStack and CoinGecko. Without them, those features are left out or use the free limits.
- **Message Content Intent** turned on for the bot app in the Discord Developer Portal. Without it, Ledger can only read messages that ping it.

Copy `.env.example` to `.env`, fill it in, then:

```bash
npm install
```

```bash
npm run dev
```

The log shows `Logged in as Ledger#…`, an invite link, and `Slash commands ready in <server>` for each server.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Run from source, restarting on changes |
| `npm run build` / `npm start` | Compile to `dist/` and run the compiled bot |
| `npm test` | Unit tests |
| `npm run typecheck` | Type-check everything |
| `npm run check` | Check the token, DeepSeek, SoSoValue and the price feed without going online |
| `npm run chat-eval -- scripts/chat-scenarios.json out.json [--db copy.db] [--only id1,id2]` | Play scripted chats through the real pipeline (live DeepSeek and data) and save every reply with its tool calls |
| `npm run preview -- <channelId> [--take "..."]` | Post one of every card to a channel, to check how they look |

## Layout

```
src/
  index.ts          wiring: config, database, Discord client, background syncs
  persona.ts        Ledger's character, the bar, and its fixed lines
  tools.ts          what the model can call: stress tests, analysis, prices, NFTs, takes, watchlist, catch-up
  reasoning/        the stress test: understand → gather → argue → check every number
  analysis/         price history, statistics, evidence, market backdrop and events
  theses/           what a take measures, how it's stored, and how it settles
  nfts/             NFT sources, store and the background sync
  discord/          chat, slash commands, cards and buttons
  desk/             ETF flows, macro, BTC buys, news (the only code that calls SoSoValue)
  analysts/         newsletter and podcast analysts from DripStack
  charts/           charts drawn as SVG and rendered to PNG
  llm/              DeepSeek client, tool loop, and the check on every reply
  alerts/, memory/, pages/, metrics.ts, db/
scripts/            chat-eval, card preview, setup check
test/
```

## Deploying

Ledger runs 24/7 on a server as its own Linux user, as a systemd user service with memory and CPU limits. The server address stays out of this public repo; replace `<server-ip>` with it.

To ship an update, push to `main`, then:

```powershell
ssh root@<server-ip> "curl -fsSL https://raw.githubusercontent.com/EliasD87/Ledger-Bot/main/deploy/update.sh | bash"
```

`deploy/update.sh` pulls `main`, rebuilds and restarts Ledger, and keeps `.env` and the database. `deploy/setup.sh` and `deploy/start.sh` are for a first install or a changed `.env`.

To read the log:

```powershell
ssh root@<server-ip> "tail -n 50 /home/ledger/ledger.log"
```

Don't run `npm run dev` on another machine while the server copy is running. Both would answer every message.
