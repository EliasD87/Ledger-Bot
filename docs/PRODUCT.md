# Ledger: The Book (one book, two pages)

> "I don't call the market. I keep score."

This is the product design behind Ledger v2: why each feature exists and how they connect. The rules for each feature are in [SPEC.md](SPEC.md).

## The problem it fixes

v1 had many features and no loop between them. There were 22 slash commands, 5 alert subcommands and 2 admin channels that were never set up (`guild_settings` had 0 rows, and no Daily Question had ever run). There were 18 chat tools, and every feature was a separate thing to discover. Calls also read like betting slips ("7.5% chance: +1,241 if right, −100 if wrong"), which the owner rejected.

The DeepSeek grant ($500/month) depends on engagement, which here means members coming back and using more than one part of Ledger.

## The idea

> **2026-10-23 update:** chat comes first. The owner asked for an interactive bot, not a forced daily post, so Today's Page is optional (off until an admin runs `/ledger-setup`) and Ledger no longer advertises it. Members get everything by asking: prices (crypto and US stocks), the tape, their page, calls, watches, catch-ups.

Ledger keeps **the server's book**. Every feature either **writes an entry** or **reads entries back**.

- **Tape entries** are what the market printed: ETF flow days and the fund that led, macro prints (actual vs forecast), corporate BTC buys, and ±5% days. They come from SoSoValue and Binance.
- **Member entries** are what members put on the record: daily answers, calls, and agree/disagree.
- **The tape settles the member entries**: Binance candles every minute, SoSoValue flow days at T+1.
- **Two pages** read the book back:
  - **Today's Page** is shared and posts once a day at 13:30 UTC in the Ledger channel.
  - **Your Page** is private, one tap away: `/ledger` or the [My page] button on any Ledger card.

The **watchlist** decides which tape entries reach which member, by DM and on their page.

```
            ┌──────────── THE TAPE (SoSoValue, Binance) ────────────┐
            │ flows · macro · BTC buys · ±5% days · 1m candles      │
            └───────┬───────────────────────┬───────────────────────┘
                    │ settles               │ filtered by
                    ▼                       ▼
   THE RECORD (answers, calls, leans)   THE WATCHLIST (your /watch rules)
                    │                       │ DMs
                    └──────────┬────────────┘
                               ▼
          TODAY'S PAGE (shared)   ·   YOUR PAGE (private)
                               │ buttons
                               └──► answer · watch · call · receipts · catch up
```

## The daily loop

1. **Trigger.** Today's Page posts at 13:30 UTC. It opens with yesterday's verdict ("Room said Inflow 11–4: missed. Room this month: 9 of 15"), then the tape, then the book (calls settled and due, top 3), then today's question. The only personal trigger is a DM about something the member chose to watch.
2. **One tap.** The member answers the question, or presses [My page].
3. **Something back.** The answer reply shows:
   - how many have answered (the split stays hidden until answers close, so nobody can copy the majority);
   - when the question settles;
   - the member's streak;
   - their open calls on that asset.

   Its buttons are [My page] and [Watch BTC flows] (or [Watch SOL ±5% days]).
4. **Invest.** A watch, a call or a lean each creates a future entry with the member's name on it.
5. **The tape settles.** Calls settle within the minute and questions settle from data. Results land in three places:
   - on Your Page;
   - by DM, if the member watches that asset;
   - in tomorrow's Today's Page, which is the next trigger.

Your Page is built from stored data and cached numbers, with **no LLM call**. DeepSeek is used where it adds something: chat as the front door to every pillar, channel catch-ups (the picker on Your Page) and drafting calls from plain English.

## Four pillars, each connected to the others

| Pillar | What a member gets | Connects to |
|---|---|---|
| **The Tape** | Yesterday's flows and the leading fund, BTC buys, the macro docket with actuals, FOMC odds and the market board, as numbers with a source and never why. `/tape` or ask in chat. | Settles the Record. Fills Today's Page and "tape since you looked" on Your Page. Its cards carry [Watch …] buttons. |
| **The Record** | Proof of what you said and how it went. Daily answers earn +25 if right. A call scores its result minus its rating. Agree/disagree is recorded right or wrong and scores nothing. | Feeds the verdict and the book on Today's Page, and your receipts on Your Page. Settlement posts link to /ledger. |
| **The Watchlist** | Set it once and you get a DM when something you follow happens: a price level, a ±% move, a ±X% day, each ETF flow day, a macro print, or a corporate BTC buy. | Decides which tape entries reach you. Every DM carries [My page] and [Stop this watch]. Everything you watch shows on Your Page. |
| **The Pages** | One place to look instead of 22 commands. | Every card ends in 2–3 buttons, at least one of which leads to another pillar. |

## Why the scoring changed

The old scoring (`100 × (1−q)/q` up to 2,000, −100 if wrong) was fair but read like odds and payouts.

The new score is **result minus rating**. A call rated 20% scores +80 if it's right and −20 if it's wrong, so a call is worth at most ±100. The ratings come from the backtested fat-tailed volatility model (`npm run backtest`), so blind guessing averages zero in every 10% band, within ±2 points.

- No score is shown before lock, only the rating and a word for it ("a stretch", "even-ish", "the likelier side").
- Calls rated under 10% are refused as too far out to score fairly. Calls rated over 90% are refused too, because the board doesn't score weather reports.
- Agree/disagree is a free **lean**. It goes on your receipts as right or wrong and moves no points, so there's no "taking the other side" of anyone.
- Rep is call scores plus question points. Question points reward showing up (+25, never negative) and call scores reward skill. Receipts show them separately, so neither hides the other.

## What shipped (wave 1)

- **One setup step.** `/ledger-setup channel:#x` switches on Today's Page and server prints in one channel. `archive:true` turns on the 30-day recall archive.
- **Today's Page.** It replaces the Daily Ledger. Question results are edited into the question card, and the verdict leads the next page, so no fact is posted twice.
- **Your Page.** `/ledger` or [My page]. It covers what changed since your last look (at most 7 days back):
  - calls and leans that settled;
  - open calls with live prices;
  - rep and rank;
  - the question and your streak;
  - your watchlist and what fired;
  - the tape since you looked.

  It also has a "Catch me up on a channel…" picker.
- **Scoring and leans** as described above. Migration 5 rescored every existing position.
- **A smaller command surface.** Member commands: `/ledger`, `/call`, `/watch`, `/tape`, `/receipts`, `/board`, `/recall`. Admin commands: `/ledger-setup`, `/ledger-admin`. That is 9 in all, down from 22 + 5.
- **Watchlist.** It adds ±X% day watches. DMs are batched once per check and come with buttons. Hits are never posted publicly. Server prints are merged into one post per check and capped at 2 a day, in priority order macro > flows > buys > moves.
- **Habit metrics.** `/ledger-admin stats` shows:
  - weekly and monthly actives;
  - average daily actives;
  - returning members (3 of the last 8 days);
  - members using 2+ pillars;
  - page opens, button taps and answers;
  - calls, leans and watch adds;
  - chat messages, and how many used tools.

## Roadmap (only if wave-1 numbers climb for 2 weeks)

**Wave 2**

- **Watchlist proper.** A list of up to 20 coins and ETF assets with default rules, [Mute 24h], and anonymous "most watched" counts (5+ watchers only).
- **One price engine.** Watch levels and call targets settle on the same minute candles. Big prints gain server context ("today's question asks this").
- **Tape journal.** Every print is stored once with its value, so pages and weekly posts cite exact numbers without new SoSoValue calls.
- **Weekly Record** (Sunday 18:00 UTC) and **season close** (the 1st).
- **Receipts v2.** Calibration bands ("calls rated under 30%: 3 of 7 right; the ratings expected 1.6") and one banked rest day per streak.
- Context menus: "Receipts" on a member and "Log as call" on your own message.

**Wave 3**

- **Self-stamps.** Put any take of your own on the record with the prices in it, unscored, and see how it aged at 1, 7 and 30 days.
- **Stocks** on the watchlist and the tape. `stockQuotes` and `stockDailyCandles` already exist in `sosovalue.ts`. Stock calls come only if members ask.
- **Grant report.** CSV export, D1/D7/D30 cohorts and a Monday DM to the owner.

## What to watch

- Weekly active members out of ~150. This is the headline, always reported with **returning members** and the **2+ pillars share** so button taps alone can't inflate it.
- Your Page opens per day, question answers per day, and the longest streak.
- Room vs Tape monthly record. It is a shared stat that people talk about.
- DeepSeek cost per weekly active member (target under $0.02) and replies that used tools.
- SoSoValue requests against the 100k monthly quota.

## Known risks

- **Cold start.** Nothing proactive runs until an admin runs `/ledger-setup` once.
- **Gambling perception.** The structure is now a record, not just the words. If any rating-linked score still feels wrong, the one-line fallback is for calls to carry only W–L and calibration, with rep coming from the question alone.
- **"I don't call the market" next to a rating.** The rating is always described as coming from recent volatility, never as Ledger's view.
- **Small-room noise.** The room verdict needs 3+ answers and a strict majority. The tally always shows, and the record is monthly.
- **Shaming.** Only the caller is pinged on settlement. Wrong leans appear only as counts.
- **Privacy.**
  - Only page opens are tracked per member.
  - Catch-ups and recall cover only channels the member can read.
  - The archive is opt-in with 30-day retention.
  - Summaries send member text to DeepSeek.
- **Binance blocks US IPs.** The VPS must be outside the US, or price checks and settlement stop.
- **One SoSoValue key shared by dev and prod.** Both draw on the same 20/min limit. Use a second key, or keep the dev bot off while prod runs.
