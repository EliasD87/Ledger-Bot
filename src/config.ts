export interface Prices {
  /** USD per 1M input tokens served from DeepSeek's prompt cache. */
  inputHit: number;
  /** USD per 1M input tokens not in the cache. */
  inputMiss: number;
  /** USD per 1M output tokens. */
  output: number;
}

export interface Config {
  discord: {
    token: string;
    /** Empty = answer mentions in every channel Ledger can read. */
    allowedChannelIds: Set<string>;
  };
  llm: {
    apiKey: string;
    baseUrl: string;
    model: string;
    prices: Prices;
    maxReplyTokens: number;
  };
  guards: {
    dailyBudgetUsd: number;
    /** Per-user limits; 0 = off. */
    cooldownMs: number;
    hourlyLimit: number;
  };
  threadMaxMessages: number;
  /** Without a key, the data desk and the ETF-flow daily questions are off. */
  sosovalueApiKey: string | undefined;
  /** When each Daily Question closes and the next opens, as minutes after 00:00 UTC. */
  dailyCloseMinuteUtc: number;
  priceFeedUrl: string;
  dbPath: string;
  logLevel: string;
}

type Env = Record<string, string | undefined>;

/** Loads `.env` from the working directory if present, then reads and validates the config. */
export function loadConfig(env: Env = loadDotEnv()): Config {
  const read = reader(env);
  return {
    discord: {
      token: read.required('DISCORD_TOKEN'),
      allowedChannelIds: new Set(read.list('ALLOWED_CHANNEL_IDS')),
    },
    llm: {
      apiKey: read.required('DEEPSEEK_API_KEY'),
      baseUrl: read.optional('DEEPSEEK_BASE_URL') ?? 'https://api.deepseek.com',
      model: read.optional('DEEPSEEK_MODEL') ?? 'deepseek-flash',
      prices: {
        inputHit: read.number('DEEPSEEK_PRICE_INPUT_HIT', 0.006),
        inputMiss: read.number('DEEPSEEK_PRICE_INPUT_MISS', 0.3),
        output: read.number('DEEPSEEK_PRICE_OUTPUT', 1.2),
      },
      maxReplyTokens: read.number('LLM_MAX_REPLY_TOKENS', 700),
    },
    guards: {
      dailyBudgetUsd: read.number('LLM_DAILY_BUDGET_USD', 2),
      cooldownMs: read.number('USER_COOLDOWN_SECONDS', 0) * 1000,
      hourlyLimit: read.number('USER_HOURLY_LIMIT', 0),
    },
    threadMaxMessages: read.number('THREAD_MAX_MESSAGES', 12),
    sosovalueApiKey: read.optional('SOSOVALUE_API_KEY'),
    dailyCloseMinuteUtc: read.clock('DAILY_QUESTION_CLOSE_UTC', '13:30'),
    priceFeedUrl: read.optional('PRICE_FEED_URL') ?? 'https://data-api.binance.vision',
    dbPath: read.optional('DB_PATH') ?? './data/ledger.db',
    logLevel: read.optional('LOG_LEVEL') ?? 'info',
  };
}

function loadDotEnv(): Env {
  try {
    process.loadEnvFile();
  } catch {
    // No .env file: rely on the real environment (e.g. systemd EnvironmentFile).
  }
  return process.env;
}

function reader(env: Env) {
  const optional = (name: string): string | undefined => env[name]?.trim() || undefined;
  return {
    optional,
    required(name: string): string {
      const value = optional(name);
      if (!value) throw new Error(`Missing required setting ${name} (see .env.example)`);
      return value;
    },
    number(name: string, fallback: number): number {
      const raw = optional(name);
      if (raw === undefined) return fallback;
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`Setting ${name} must be a non-negative number, got "${raw}"`);
      }
      return value;
    },
    /** "HH:MM" → minutes after midnight. */
    clock(name: string, fallback: string): number {
      const raw = optional(name) ?? fallback;
      const match = /^(\d{1,2}):(\d{2})$/.exec(raw);
      if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
        throw new Error(`Setting ${name} must look like "13:30", got "${raw}"`);
      }
      return Number(match[1]) * 60 + Number(match[2]);
    },
    list(name: string): string[] {
      return (optional(name) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    },
  };
}
