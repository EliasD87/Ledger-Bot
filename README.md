# Ledger

> "I don't call the market. I keep score."

The scorekeeper bot for the Cybereator Discord. It sits next to Doji (analyst) and Zima (bartender).
What it does and why: [docs/SPEC.md](docs/SPEC.md).

Stack: Node.js 22.13+ (built-in SQLite, no native modules), TypeScript, discord.js 14, DeepSeek through the `openai` SDK, Binance public market data.

## 1. What you need

- **The bot token.** That's all Ledger needs from Discord. It works out its own application ID, registers its slash commands in every server it's in, and prints an invite link when it starts.
- **A DeepSeek API key.**
- **From whoever owns the bot app**, one switch: Developer Portal → the app → **Bot** → *Privileged Gateway Intents* → **Message Content Intent** on.
  Ledger runs without it, but it can only read messages that ping it: mentions, and replies with the @ ping left on. Once the switch is on, restart Ledger.

## 2. Run it locally

Put the token and the DeepSeek key in `.env`. If there's no `.env` yet, copy `.env.example`. Then:

```bash
npm install
```

```bash
npm run dev
```

The log shows:

- `Logged in as Ledger#1234, in N server(s)`
- `Invite link: https://discord.com/oauth2/authorize?...`. If the bot isn't in your server yet, open this link. It needs someone with *Manage Server* there. Try a private test server before Cybereator.
- `Slash commands ready in <server>`, once per server.

**Switch it on (once per server):** an admin runs `/ledger-setup channel:#some-channel`. Within a minute Ledger posts the first **Today's Page** there: the tape (ETF flows, BTC buys, macro), the book (calls settled and due, top 3) and a one-tap question. After that a new one goes up every day at 13:30 UTC, and big prints (large ETF days, big BTC buys, major macro releases, ±5% days) post in the same channel, at most twice a day. Add `archive:true` to keep 30 days of messages for server-wide `/recall`.

Then mention `@Ledger` in a channel and reply to its answer to keep the conversation going. Replying to any Ledger post asks about it. Try:

- `/ledger`, or **My page** on any card: what changed for you since you last looked.
- `@Ledger I call BTC hits 90k by Friday`, then press **Lock it in** on the card. Others can **Agree** or **Disagree** (recorded, not scored).
- `@Ledger alert me if BTC drops below 80k`, or `/watch`. Hits arrive by DM.
- `@Ledger what moved yesterday?`, or `/tape` (needs `SOSOVALUE_API_KEY` in `.env`).
- `@Ledger catch me up`, `/recall topic`, `/receipts`, `/board`.

Calls resolve on their own; Ledger checks prices every minute. If bad price data ever resolves one wrongly, a server admin can undo it with `/ledger-admin void`. `/ledger-admin stats` shows the habit numbers.

How it all fits together: [docs/PRODUCT.md](docs/PRODUCT.md).

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Run from source, restarting on changes |
| `npm run build` / `npm start` | Compile to `dist/` and run the compiled bot |
| `npm test` | Unit tests |
| `npm run typecheck` | Type-check everything |
| `npm run backtest` | Check against ~2.3 years of prices that the scoring can't be farmed |
| `npm run check` | Check the Discord token, DeepSeek, SoSoValue and the price feed without going online |
| `npm run chat-eval -- scripts/chat-scenarios.json out.json --db copy.db` | Play 48 scripted conversations through the real chat pipeline (live DeepSeek and data, about $0.03 a run) and save every reply with its tool calls. Point `--db` at a copy of the database |

## Layout

```
src/
  index.ts              wiring: config, DB, Discord client, handlers, command registration
  config.ts             .env → typed config
  persona.ts            Ledger's system prompt and fixed lines
  discord/
    client.ts           Discord client and invite link
    conversation.ts     mention / reply-chain chat
    thread.ts, text.ts  reply-chain → model messages (pure, tested)
    commands.ts         all slash commands
    callCards.ts        call card embeds and buttons, result posts
    callButtons.ts      Lock it in / Cancel / Agree / Disagree
    announcer.ts        posts results, expires stale drafts
    deskCards.ts        tape cards and Today's Page
    pageCards.ts, pageButtons.ts   Your Page, receipts, catch-up picker
    watchButtons.ts     one-tap [Watch] and [Stop this watch]
    alertNotifier.ts    watch DMs and capped server prints
    dailyCards.ts, dailyButtons.ts, dailyPoster.ts   question card, taps, posting Today's Page
  tools.ts              what the model can call: prices, your page, calls, receipts, board, question, tape, watchlist, catch-up
  sosovalue.ts          SoSoValue API client (rate-limited lanes, caching)
  desk/
    desk.ts             data desk: flows, macro, treasuries, news, market
    treasuries.ts       background scan for corporate BTC purchases
  daily/
    questions.ts        Daily Question rotation and outcomes (pure, tested)
    store.ts            questions, answers, streaks (SQLite)
    runner.ts           opens, closes and resolves questions each minute
    ledger.ts           gathers the tape for Today's Page
    book.ts             the member side of Today's Page: verdict, settled, due, leaders
  llm/
    deepseek.ts         DeepSeek client + cost accounting
    toolLoop.ts         model ↔ tools loop
    replyCheck.ts       checks each reply against its tool results; one redo for invented figures, undone actions or betting words
    guards.ts           daily spend, optional per-user rate limits
  calls/
    odds.ts             chance model and scoring rules (tested, backtested)
    prices.ts           Binance market data
    store.ts            the board: calls, positions, receipts, leaderboard (SQLite)
    settle.ts           resolution engine (tested against real candles)
    service.ts          pricing and drafting shared by chat and slash commands
  pages/myPage.ts       builds Your Page (since your last look)
  alerts/               watchlist store, rules and the minute watcher
  memory/               opt-in message archive for /recall
  metrics.ts            engagement events and habit numbers (/ledger-admin stats)
  db/                   SQLite + migrations
scripts/backtest-odds.ts
scripts/chat-eval.ts, scripts/chat-scenarios.json   chat regression run
test/
```

## Deploying to the shared VPS (later)

These are the host's rules, which the deploy has to follow:

- Run Ledger as its **own Linux user**: not root, and not `collector`.
- Install Node in that user's home directory, e.g. via nvm. Never install system-wide.
- Run it as a systemd *user* service with resource limits, e.g. `MemoryMax=512M` and `CPUQuota=100%`.
- Never touch the trading bots, the SoDEX collector/publisher, or anything system-wide.

User services need "lingering" for that user. That is a one-time `loginctl enable-linger <user>`, which the server admin has to run.

Expected footprint: about 100–200 MB of RAM, a small fraction of one core, and a few MB of disk.
