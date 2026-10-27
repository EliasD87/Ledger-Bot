# Ledger: the sparring partner

> Bring a take. Ledger argues it out with real data, puts it on the record, and comes back to tell everyone how it aged.

CybeReator's members already throw takes around all day: "SOL flips ETH this cycle", "NVDA dip is a gift", "BTC ETFs bleed all week". Today those takes vanish into the scroll. Nobody checks them, nobody gets credit, and the arguments are vibes.

Ledger turns a take into a short, sharp debate, built on numbers people can check. It doesn't forecast. It stress-tests: the case **for**, the case **against**, **what would prove it wrong**, and what **history** says about setups like this. If the member stands by it, Ledger logs it as a thesis with a check-back date. Others take a side. On the date, Ledger replies in the same thread with the verdict and who read it right.

This replaces the old design (rated price calls, points, the leaderboard, the daily post), which members found generic.

## Why people engage

| Hook | How it shows up |
|---|---|
| **Being challenged** is fun, especially in public | Every take gets a for/against breakdown with real numbers, plus a one-line verdict with some bite |
| **Taking sides** is easy | One tap: *I'm with you* / *I'm against*. The card shows the split. |
| **Being proven right** | Check-backs reply in the original thread, ping the author, and name everyone who read it right |
| **Reputation** | Records: takes logged, how many aged well, best take, *contrarian wins* (aged well while most were against) |
| **A reason to come back** | *How's it doing?* shows live progress; `/ledger` shows what changed since you last looked |
| **Smart conversation** | Normal chat, but every market answer is backed by computed analysis, not just numbers read out |

No points, no odds, no stakes: a take ages well or badly, and the record says which.

## The reasoning layer

The language model never does maths and never sees raw feeds. Each stress test runs four steps:

1. **Understand**: the model turns the member's words into a testable claim, with the assets, the measure, the direction, any threshold and the horizon. A vague take ("SOL is the future") gets a testable version proposed ("SOL beats ETH over 90 days").
2. **Gather**: code builds an *evidence pack* of numbered facts from real data:
   - returns over 1, 7, 30 and 90 days and 1 year
   - position against the 50- and 200-day averages
   - volatility now against its year
   - how unusual today's move is
   - distance from the 52-week high and low
   - for two assets: the ratio and its percentile, and their correlation
   - the **base rate**: how often this kind of move has happened over this horizon in the available history
   - **analogs**: what happened next after similar setups
   - ETF flows and streaks, macro events inside the horizon, and the latest headlines
3. **Argue**: the model (in thinking mode) writes the debate from that pack only, citing the fact behind each point.
4. **Verify**: code checks every number in the argument against the pack. A point that cites nothing, or has a number the pack doesn't contain, is dropped and the argument rewritten once. What members see is never invented.

## Measuring a thesis

| Kind | Example | Judged on |
|---|---|---|
| Price | BTC above 100k by 31 Dec | price at the check-back vs the target |
| Move | NVDA up 10% in a month | % change from the logging price |
| Relative | SOL beats ETH over 30 days | change in the SOL/ETH ratio |
| Flows | BTC ETFs net inflows this week | sum of daily net flows over the window |

Assets: any crypto with a USDT market (Binance, with OKX and Bybit as backups) and US stocks and ETFs (Yahoo, with Nasdaq as backup). Horizons run from 1 day to 1 year; the default is 30 days.

## Where Ledger posts

- **Replies only**, to whoever asked. Nothing is scheduled to the channel.
- **Check-back verdicts** reply to the thesis card itself and ping only its author. A stress test nobody logs within a day loses its buttons.
- **Watch alerts** go by DM.

## Data budget

Only a background fetcher talks to SoSoValue (20 requests a minute, 100k a month). It refreshes ETF flows, macro, the market board, headlines and a batch of stock quotes on schedules, about 1,200 requests a day. Results are stored in the database, so restarts don't refetch, and the fetcher slows down past 80% of the month and stops at 96%. Chat and cards never call SoSoValue. Price history comes from Binance and Yahoo, cached.

## Before, during and after a take

- **Other timeframes** (button on the stress test): how often the same move happened over 1 week, 1 month, 3 months and 6 months, computed from history. The author can switch the take to one of them; Ledger re-tests it on the same card.
- **Make it sharper** (button): Ledger proposes a crisper version (an exact level or minimum move, a timeframe where the evidence is two-sided) with a one-line reason, checked for invented numbers. The author can test it instead.
- **Mid-take moments:** between logging and the check-back, Ledger replies on the card when the target is reached early, when it's given back, or when the take moves against its author by more than its usual range for the whole window. Each at most once, pinging only the author.
- **Duels:** someone who's against a logged take can make it a duel. One challenger per take; the check-back names the winner and pings both; duels and head-to-head results go on both records.
- **Records:** aged well and badly, a form chart of recent takes (how far past or short of the line each finished), bold takes (history said under 25%) and how many aged well, the asset someone reads best, contrarian wins, duels.

## Context and events

Every analysis and stress test also carries the wider picture, computed from data:

- **The backdrop:** what the dollar index, the 10-year yield, the VIX, the S&P 500, gold, oil and bitcoin did over 30 days, and which of them the asset actually moves with (correlation of daily moves over 90 days).
- **Event mapping:** the asset's biggest recent days, each matched to the headlines published that day (Google News). Asked directly ("what happened to oil this summer?"), Ledger draws the chart with each event numbered.
- **Fed days:** how the asset moved around every FOMC decision since late 2021, against a normal two-day move, and when the next one is.
- **World news:** recent headlines for stocks, commodities, the Fed and geopolitics, cited with the outlet.

Ledger reasons in a fixed order: what moved, what was reported then, what else moved with it, what's scheduled next, what would change the view; and it says which parts are data and which are its read.

## Charts

Ledger draws its own charts (no AI involved, no extra API calls). A take's chart is scaled to the take: about three times its length of recent history (hourly for short takes), then the runway to the check-back drawn to scale, the line it has to cross, and the typical range by the check-back date (one standard deviation of recent moves), so you can see whether the target sits inside normal movement. FOMC days and big macro releases (CPI, PCE, GDP, jobs) inside the runway are marked under it. Two-asset takes ("SOL beats ETH") show both assets rebased to 100 instead of a ratio. The check-back chart shows where the take finished against the typical range it had when it was logged, with a check or a cross. Event maps carry a numbered key under the chart, so a shared screenshot explains itself. Every chart is laid out for phones first (large text, few labels). Also: daily ETF flow bars, a progress chart for *How's it doing?* (logged level, where it stands, the runway to the check-back), the same at the check-back, and a price or ratio chart for analysis questions. Members can also just ask: "pull up the 7-day", "chart SOL vs ETH this month", "how has SPCX moved since it listed" (hourly prices for windows under a month). Names work as well as tickers (nvidia, spacex, ripple, ton → GRAM). Same quiet palette as the cards. If a chart can't be drawn, the card goes out without it.

## Surfaces

- **@Ledger \<a take\>**, or `/take`: a stress-test card with **Log it**.
- **A logged thesis card**: *I'm with you*, *I'm against* and *How's it doing?*
- **`/ledger`**: your page, with open theses and live progress, recent verdicts and the debates you joined.
- **`/takes [member]`**: someone's record, or the server's open debates and best records.
- **`/tape`**: ETF flows, macro, corporate BTC buys, headlines, the market board.
- **Chat**: prices, analysis, explanations, catch-up and watch alerts, like a sharp friend.

## Guardrails and cost

- Model: `deepseek-flash`. Chat runs with thinking off (fast, cheap). The stress test's argue step runs with thinking on and JSON output; a stress test costs about half a cent.
- Budget: a global daily cap (default $2.00/day) also guards against bugs like a reply loop. Per-user cooldown and hourly limits exist but are off for the closed group.
- The model never computes or remembers numbers. Analysis is code (`src/analysis/`); the model gets numbered facts and must cite them, and `verify()` drops any point with a number not in its facts.
- **Reply check** (`src/llm/replyCheck.ts`): every chat reply is checked against the tool results it was written from. Invented market figures, actions claimed but not done, and betting words (even in denials) trigger one redo.
- A thesis is only settled on a real, finite measure. If the data never shows up, it's voided 5 days after its date.
- Chat quality is tested with `npm run chat-eval` against `scripts/chat-scenarios.json`: takes, analysis, bait (odds, payouts, forecasts), injections, memory and everyday chat.

## Engagement metrics (for the DeepSeek grant)

`/ledger-admin stats` shows, per server: weekly and monthly active members (chat, command, button or page open), average daily actives, **returning** members (active 3+ of the last 8 days), members using **2+ parts** (takes, tape, watchlist, memory), takes stress-tested, logged, sides taken, page opens, button taps, watch adds, chat messages and how many used tools, LLM spend and SoSoValue usage. Weekly actives are always read next to returning members, so button taps alone can't inflate it.

## Non-goals

Price forecasts and trade advice, real money of any kind, trade execution, portfolio tracking, scheduled channel posts.
