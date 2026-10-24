/**
 * Schema migrations, applied in order. The database's `user_version` records how many have run.
 * Never edit a migration once it has run on the server; append a new one instead.
 */
export const migrations: string[] = [
  // 1: conversation bookkeeping, engagement events, LLM spend.
  `
  CREATE TABLE bot_replies (
    message_id  TEXT PRIMARY KEY,   -- a message Ledger sent
    root_id     TEXT NOT NULL,      -- first message of the conversation it belongs to
    channel_id  TEXT NOT NULL,
    ts          INTEGER NOT NULL
  );

  CREATE TABLE events (
    id          INTEGER PRIMARY KEY,
    ts          INTEGER NOT NULL,   -- unix ms
    type        TEXT NOT NULL,      -- 'message' | 'command' | 'limited' | ...
    guild_id    TEXT,
    channel_id  TEXT,
    user_id     TEXT,
    root_id     TEXT,               -- conversation root, for 'message' events
    meta        TEXT                -- JSON
  );
  CREATE INDEX events_type_ts ON events (type, ts);

  CREATE TABLE llm_usage (
    id                INTEGER PRIMARY KEY,
    ts                INTEGER NOT NULL,
    purpose           TEXT NOT NULL,
    model             TEXT NOT NULL,
    user_id           TEXT,
    guild_id          TEXT,
    cache_hit_tokens  INTEGER NOT NULL,
    cache_miss_tokens INTEGER NOT NULL,
    output_tokens     INTEGER NOT NULL,
    cost_usd          REAL NOT NULL
  );
  CREATE INDEX llm_usage_ts ON llm_usage (ts);
  `,

  // 2: the board: calls, positions on them, and members' display names.
  `
  CREATE TABLE members (
    user_id     TEXT PRIMARY KEY,
    name        TEXT NOT NULL,      -- latest display name seen
    updated_at  INTEGER NOT NULL
  );

  CREATE TABLE calls (
    id             INTEGER PRIMARY KEY,
    guild_id       TEXT NOT NULL,
    channel_id     TEXT NOT NULL,
    message_id     TEXT,             -- the call card
    caller_id      TEXT NOT NULL,
    symbol         TEXT NOT NULL,    -- e.g. BTCUSDT
    base           TEXT NOT NULL,    -- e.g. BTC
    direction      TEXT NOT NULL CHECK (direction IN ('above', 'below')),
    kind           TEXT NOT NULL CHECK (kind IN ('touch', 'close')),
    target         REAL NOT NULL,
    deadline       INTEGER NOT NULL, -- unix ms, on a minute boundary
    status         TEXT NOT NULL CHECK (status IN ('draft', 'open', 'won', 'lost', 'void', 'cancelled')),
    created_at     INTEGER NOT NULL,
    entry_price    REAL NOT NULL,    -- spot when drafted, then when locked
    chance         REAL NOT NULL,    -- the caller's win chance, same timing
    payout         INTEGER NOT NULL, -- the caller's points if right
    locked_at      INTEGER,
    checked_until  INTEGER,          -- minute candles before this time have been checked
    settled_at     INTEGER,
    settle_price   REAL,
    settle_time    INTEGER,          -- when the target was reached, or the deadline
    note           TEXT              -- why it was voided or cancelled
  );
  CREATE INDEX calls_status ON calls (status, guild_id);
  CREATE INDEX calls_caller ON calls (caller_id);

  CREATE TABLE positions (
    id          INTEGER PRIMARY KEY,
    call_id     INTEGER NOT NULL REFERENCES calls (id),
    user_id     TEXT NOT NULL,
    side        TEXT NOT NULL CHECK (side IN ('back', 'fade')),
    stake       INTEGER NOT NULL,
    chance      REAL NOT NULL,      -- this position's win chance when taken
    payout      INTEGER NOT NULL,   -- points if right
    created_at  INTEGER NOT NULL,
    result      TEXT CHECK (result IN ('won', 'lost', 'void')),
    pnl         INTEGER,
    settled_at  INTEGER,
    UNIQUE (call_id, user_id)
  );
  CREATE INDEX positions_user ON positions (user_id);
  CREATE INDEX positions_settled ON positions (settled_at);
  `,

  // 3: the Daily Question, and per-server settings.
  `
  CREATE TABLE guild_settings (
    guild_id          TEXT PRIMARY KEY,
    daily_channel_id  TEXT,            -- where the Daily Question and Daily Ledger post; NULL = off
    updated_at        INTEGER NOT NULL
  );

  CREATE TABLE daily_questions (
    id            INTEGER PRIMARY KEY,
    guild_id      TEXT NOT NULL,
    channel_id    TEXT NOT NULL,
    message_id    TEXT,
    day           TEXT NOT NULL,        -- UTC date the question is about, yyyy-MM-dd
    kind          TEXT NOT NULL,        -- 'etf-flow' | 'up-down' | 'versus'
    spec          TEXT NOT NULL,        -- JSON: prompt, options, assets, measuring window
    closes_at     INTEGER NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('open', 'closed', 'resolved', 'void')),
    answer        TEXT CHECK (answer IN ('a', 'b')),
    result_text   TEXT,                 -- what happened, e.g. "BTC spot ETFs: +$412.3M net"
    start_prices  TEXT,                 -- JSON, captured when answers close (price questions)
    created_at    INTEGER NOT NULL,
    last_check    INTEGER,
    resolved_at   INTEGER,
    UNIQUE (guild_id, day)
  );
  CREATE INDEX daily_questions_status ON daily_questions (status);

  CREATE TABLE daily_answers (
    question_id  INTEGER NOT NULL REFERENCES daily_questions (id),
    user_id      TEXT NOT NULL,
    choice       TEXT NOT NULL CHECK (choice IN ('a', 'b')),
    answered_at  INTEGER NOT NULL,
    correct      INTEGER,
    points       INTEGER,
    PRIMARY KEY (question_id, user_id)
  );
  `,

  // 4: alerts, and the opt-in message archive behind server memory.
  `
  ALTER TABLE guild_settings ADD COLUMN alerts_channel_id TEXT;      -- server alerts; NULL = off
  ALTER TABLE guild_settings ADD COLUMN memory_enabled INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE alerts (
    id          INTEGER PRIMARY KEY,
    guild_id    TEXT NOT NULL,
    channel_id  TEXT NOT NULL,          -- where it was set; used if the member's DMs are closed
    user_id     TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('price', 'move', 'etf-flow', 'macro', 'treasury')),
    asset       TEXT,                   -- BTC, SOL…; for macro, the event to watch for (e.g. "CPI")
    direction   TEXT CHECK (direction IN ('above', 'below')),
    target      REAL,                   -- price level, or move size as a fraction (0.05)
    ref_price   REAL,                   -- price when a move alert was set
    repeat      INTEGER NOT NULL,       -- 1 = keeps firing (flows, BTC buys); 0 = fires once
    status      TEXT NOT NULL CHECK (status IN ('active', 'fired', 'cancelled')),
    created_at  INTEGER NOT NULL,
    fired_at    INTEGER
  );
  CREATE INDEX alerts_status ON alerts (status, kind);

  -- Events already announced (an ETF day, a macro release, a BTC purchase), so nothing fires twice.
  CREATE TABLE seen_events (
    key      TEXT PRIMARY KEY,
    seen_at  INTEGER NOT NULL
  );

  CREATE TABLE archive (
    message_id   TEXT PRIMARY KEY,
    guild_id     TEXT NOT NULL,
    channel_id   TEXT NOT NULL,
    author_id    TEXT NOT NULL,
    author_name  TEXT NOT NULL,
    content      TEXT NOT NULL,
    ts           INTEGER NOT NULL
  );
  CREATE INDEX archive_guild_ts ON archive (guild_id, ts);
  CREATE VIRTUAL TABLE archive_fts USING fts5(content, content = 'archive', content_rowid = 'rowid');
  CREATE TRIGGER archive_ai AFTER INSERT ON archive BEGIN
    INSERT INTO archive_fts (rowid, content) VALUES (new.rowid, new.content);
  END;
  CREATE TRIGGER archive_ad AFTER DELETE ON archive BEGIN
    INSERT INTO archive_fts (archive_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  END;
  `,

  // 5: "The Book". Calls score their result minus their rating (stake = what a wrong call costs,
  // payout = what a right one earns); agree/disagree ("leans") are records that move no points;
  // Your Page remembers when each member last opened it; watches gain a daily ±% kind.
  `
  UPDATE positions SET
    stake = CAST(ROUND(100 * chance) AS INTEGER),
    payout = CAST(ROUND(100 * (1 - chance)) AS INTEGER)
  WHERE user_id = (SELECT caller_id FROM calls WHERE calls.id = positions.call_id);
  UPDATE positions SET stake = 0, payout = 0
  WHERE user_id <> (SELECT caller_id FROM calls WHERE calls.id = positions.call_id);
  UPDATE positions SET pnl = CASE result WHEN 'won' THEN payout WHEN 'lost' THEN -stake ELSE pnl END
  WHERE result IN ('won', 'lost');
  UPDATE calls SET payout = CAST(ROUND(100 * (1 - chance)) AS INTEGER);

  CREATE TABLE member_activity (
    guild_id      TEXT NOT NULL,
    user_id       TEXT NOT NULL,
    last_page_at  INTEGER,             -- when they last opened Your Page
    PRIMARY KEY (guild_id, user_id)
  );

  CREATE TABLE alerts_v5 (
    id          INTEGER PRIMARY KEY,
    guild_id    TEXT NOT NULL,
    channel_id  TEXT NOT NULL,
    user_id     TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('price', 'move', 'day-move', 'etf-flow', 'macro', 'treasury')),
    asset       TEXT,
    direction   TEXT CHECK (direction IN ('above', 'below')),
    target      REAL,
    ref_price   REAL,
    repeat      INTEGER NOT NULL,
    status      TEXT NOT NULL CHECK (status IN ('active', 'fired', 'cancelled')),
    created_at  INTEGER NOT NULL,
    fired_at    INTEGER
  );
  INSERT INTO alerts_v5 SELECT id, guild_id, channel_id, user_id, kind, asset, direction, target, ref_price, repeat, status, created_at, fired_at FROM alerts;
  DROP TABLE alerts;
  ALTER TABLE alerts_v5 RENAME TO alerts;
  CREATE INDEX alerts_status ON alerts (status, kind);
  `,
  // 6: the stored tape. A background fetcher keeps SoSoValue results here (and counts its requests
  // against the monthly cap); chat, cards and alerts read from it and never call SoSoValue themselves.
  `
  CREATE TABLE kv (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  // 7: the sparring partner. A take is stress-tested (a draft), the author can log it as a thesis with
  // a check-back date, others take a side, and at the date it's measured: aged well or aged badly.
  // The old calls, positions and daily-question tables stay, unused, so nothing is lost.
  `
  CREATE TABLE theses (
    id          INTEGER PRIMARY KEY,
    guild_id    TEXT NOT NULL,
    channel_id  TEXT NOT NULL,
    message_id  TEXT,
    author_id   TEXT NOT NULL,
    take        TEXT NOT NULL,            -- the member's own words
    claim       TEXT NOT NULL,            -- what will be checked, in plain words
    spec        TEXT NOT NULL,            -- JSON ThesisSpec
    analysis    TEXT NOT NULL,            -- JSON: assumptions, argument, facts, sources
    status      TEXT NOT NULL CHECK (status IN ('draft', 'open', 'aged_well', 'aged_badly', 'void', 'cancelled')),
    start_value REAL,
    start_at    INTEGER,
    check_at    INTEGER,
    end_value   REAL,
    settled_at  INTEGER,
    note        TEXT,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX theses_due ON theses (status, check_at);
  CREATE INDEX theses_author ON theses (guild_id, author_id);
  CREATE TABLE thesis_sides (
    thesis_id  INTEGER NOT NULL REFERENCES theses (id),
    user_id    TEXT NOT NULL,
    side       TEXT NOT NULL CHECK (side IN ('with', 'against')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (thesis_id, user_id)
  );
  `,
];
