# Ledger

> Bring a take. Ledger argues it out with real data, puts it on the record, and comes back to tell everyone how it aged.

The sparring partner for the CybeReator Discord. Members bring their market takes; Ledger stress-tests them (the case for, the case against, what would prove it wrong, what history says), logs the ones people stand by, and checks back on the date. In between it's a sharp, chatty regular who's good at crypto and US stocks.
What it does and why: [docs/PRODUCT.md](docs/PRODUCT.md).

Stack: Node.js 22.13+ (built-in SQLite, no native modules), TypeScript, discord.js 14 (Components V2 cards), DeepSeek through the `openai` SDK. Market data: Binance (OKX and Bybit as backups), Yahoo (Nasdaq as backup), SoSoValue (ETF flows, macro, headlines, stock quotes).

## 1. What you need

- **The bot token.** That's all Ledger needs from Discord. It works out its own application ID, registers its slash commands in every server it's in, and prints an invite link when it starts.
- **A DeepSeek API key.** Optional but recommended: a **SoSoValue API key** for ETF flows, macro and headlines.
- **From whoever owns the bot app**, one switch: Developer Portal → the app → **Bot** → *Privileged Gateway Intents* → **Message Content Intent** on.
  Ledger runs without it, but it can only read messages that ping it: mentions, and replies with the @ ping left on. Once the switch is on, restart Ledger.

## 2. Run it locally

Put the token and the keys in `.env`. If there's no `.env` yet, copy `.env.example`. Then:

```bash
npm install
```

```bash
npm run dev
```

The log shows:

- `Logged in as Ledger#1234, in N server(s)`
- `Invite link: https://discord.com/oauth2/authorize?...`. If the bot isn't in your server yet, open this link. It needs someone with *Manage Server* there. Try a private test server before CybeReator.
- `Slash commands ready in <server>`, once per server.

Nothing needs switching on. Mention `@Ledger` in a channel and reply to its answer to keep the conversation going. Replying to any Ledger post asks about it. Try:

- `@Ledger SOL beats ETH this month`, or `/take`: a stress-test card. Press **Log it** to put it on the record; others press **I'm with you** or **I'm against**. On the date, Ledger replies to the card with how it aged and who read it right.
- `@Ledger is NVDA stretched?`, `@Ledger how's ETH looking vs SOL?`: analysis from computed facts, not just numbers read out.
- `/ledger`, or **My takes** on any card: your open theses with live progress, verdicts since you last looked, your record.
- `/takes`: the open debates and the best records, or one member's record.
- `@Ledger alert me if BTC drops below 80k`, or `/watch`. Hits arrive by DM.
- `/tape` for ETF flows, macro, BTC buys, headlines and the market board; `@Ledger catch me up`, `/recall topic`.

Optional: an admin can run `/ledger-setup channel:#some-channel` for big market prints (large ETF days, big BTC buys, major macro, ±5% days, at most two a day), and `archive:true` to keep 30 days of messages for server-wide `/recall`. `/ledger-admin stats` shows the habit numbers; `/ledger-admin void` voids a thesis with bad data.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Run from source, restarting on changes |
| `npm run build` / `npm start` | Compile to `dist/` and run the compiled bot |
| `npm test` | Unit tests |
| `npm run typecheck` | Type-check everything |
| `npm run check` | Check the Discord token, DeepSeek, SoSoValue and the price feed without going online |
| `npm run chat-eval -- scripts/chat-scenarios.json out.json --db copy.db [--only id1,id2]` | Play scripted conversations through the real chat pipeline (live DeepSeek and data) and save every reply with its tool calls and stress tests. Point `--db` at a copy of the database |
| `npm run preview -- <channelId> [--take "..."]` | Post one of every card (with a real stress test and its chart) to a channel, to judge the look |
| `npx tsx scripts/chart-samples.ts <folder>` | Render sample charts from live data into a folder, no Discord needed |

## Layout

```
src/
  index.ts              wiring: config, DB, Discord client, handlers, the minute tick
  config.ts             .env → typed config
  persona.ts            Ledger's system prompt and fixed lines
  tools.ts              what the model can call: stress tests, analysis, theses, records, prices, tape, watchlist, catch-up
  reasoning/
    stressTest.ts       the reasoning layer: understand → gather → argue (thinking mode) → verify every number
  analysis/
    stats.ts            returns, averages, volatility, drawdowns, ratios, correlation, base rates, analogs (pure, tested)
    history.ts          daily price history: Binance → Bybit for crypto, Yahoo → Nasdaq for stocks
    evidence.ts         builds the numbered facts a stress test argues from
  theses/
    spec.ts             what a thesis measures, its claim text, and whether it held
    store.ts            theses, sides, records (SQLite)
    measure.ts          live measures and the check-back settler
    service.ts          one path from a take to a draft thesis, for chat and /take
  discord/
    conversation.ts     mention / reply-chain chat; attaches the stress-test card
    thread.ts, text.ts  reply-chain → model messages (pure, tested)
    commands.ts         all slash commands and button routing
    thesisCards.ts      stress-test, thesis, check-back, record and debate cards
    thesisButtons.ts    Log it / I'm with you / I'm against / How's it doing?; check-back posts; draft expiry
    pageCards.ts, pageButtons.ts   your takes, catch-up picker
    deskCards.ts        tape cards
    watchButtons.ts     one-tap [Watch] and [Stop this watch]
    alertNotifier.ts    watch DMs and capped server prints
    ui.ts               card building blocks (soft colors, no red/green)
  desk/
    tape.ts             the background SoSoValue fetcher and its stored results (the only code that calls SoSoValue)
    desk.ts             flows, macro, treasuries, news, market
    recap.ts            "what moved yesterday"
    treasuries.ts       background scan for corporate BTC purchases
  charts/               chart drawings (SVG by hand) turned into PNGs with resvg; fonts in assets/fonts (IBM Plex Sans, OFL)
  analysis/context.ts   the backdrop (dollar, yields, VIX, S&P 500, gold, oil, BTC) and event maps
  analysis/events.ts    FOMC calendar, reactions around events, biggest moves
  news/webNews.ts       world news (Google News, Yahoo Finance backup) for stocks, commodities, macro, geopolitics
  quotes.ts             live prices with backups
  calls/prices.ts       Binance market data
  sosovalue.ts          SoSoValue API client (rate-limited lanes)
  llm/
    deepseek.ts         DeepSeek client + cost accounting
    toolLoop.ts         model ↔ tools loop
    inlineCalls.ts      tool calls DeepSeek writes as text: run them, never post the markup
    replyCheck.ts       checks each reply against its tool results; one redo for invented figures, undone actions or betting words
    guards.ts           daily spend, optional per-user rate limits
  pages/myPage.ts       builds your page (since your last look)
  members.ts            display names for records and lookups
  alerts/               watchlist store, rules and the minute watcher
  memory/               opt-in message archive for /recall
  metrics.ts            engagement events and habit numbers (/ledger-admin stats)
  db/                   SQLite + migrations
scripts/chat-eval.ts, scripts/chat-scenarios.json   chat regression run
scripts/preview-cards.ts                            card preview
test/
```

## Running on the shared VPS

Ledger runs 24/7 on the shared VPS as the Linux user `ledger` (replace `<server-ip>` below with its address; it is kept out of this public repo):

- App in `/home/ledger/app`, database in `data/ledger.db`, log in `~/ledger.log`.
- Node 24 is installed via nvm in that user's home.
- It runs as the systemd user service `ledger` (1 GB memory cap for the bot and its chart helper, one core, restarts on crash and reboot).
- Everything is done from the laptop in PowerShell. `deploy/setup.sh` and `deploy/start.sh` do the server-side work as root, including switching to `ledger`.

**Shipping an update.** Push to `main` on GitHub, then in PowerShell on the laptop:

```powershell
ssh root@<server-ip> "curl -fsSL https://raw.githubusercontent.com/EliasD87/Ledger-Bot/main/deploy/update.sh | bash"
```

`deploy/update.sh` pulls the latest `main`, rebuilds and restarts Ledger as the `ledger` user, leaving `.env` and `data/` alone. `deploy/setup.sh` and `deploy/start.sh` are for a first install (or changing `.env`): they take an uploaded bundle with the code and `.env`. Never run `npm run dev` on the laptop while the server copy is up: both would answer every message.

**Status and logs:**

```powershell
ssh root@<server-ip> "tail -n 50 /home/ledger/ledger.log"
```

### The host's rules

These are the host's rules, which the deploy has to follow:

- Run Ledger as its **own Linux user**: not root, and not `collector`.
- Install Node in that user's home directory, e.g. via nvm. Never install system-wide.
- Run it as a systemd *user* service with resource limits, e.g. `MemoryMax=512M` and `CPUQuota=100%`.
- Never touch the trading bots, the SoDEX collector/publisher, or anything system-wide.

User services need "lingering" for that user (`loginctl enable-linger ledger`, already done by `setup.sh`).

Expected footprint: about 150–300 MB of RAM (bot plus chart helper), a small fraction of one core, and a few tens of MB of disk.
