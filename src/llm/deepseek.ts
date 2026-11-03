import OpenAI from 'openai';
import type { Prices } from '../config.js';
import { extractInlineCalls } from './inlineCalls.js';

export type ChatMessage = OpenAI.Chat.ChatCompletionMessageParam;
export type Tool = OpenAI.Chat.ChatCompletionFunctionTool;

export interface Usage {
  cacheHitTokens: number;
  cacheMissTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface ToolCall {
  id: string;
  name: string;
  /** JSON text, as the model wrote it; may be malformed. */
  arguments: string;
}

/** One model response: either text for the member, or tool calls to run first. */
export interface ModelTurn {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
}

export interface CompleteOptions {
  maxTokens: number;
  tools?: Tool[];
  /** 'none' forces a text answer even though tools are listed. */
  toolChoice?: 'auto' | 'none';
  /** Think before answering (slower, bills reasoning as output): for the stress-test argument. */
  thinking?: boolean;
  /** Answer with one JSON object (the prompt must say "json"). */
  json?: boolean;
  temperature?: number;
}

export interface ChatModel {
  readonly model: string;
  complete(messages: ChatMessage[], opts: CompleteOptions): Promise<ModelTurn>;
}

/** DeepSeek adds prompt-cache counters to OpenAI's usage object. */
interface DeepSeekUsage extends OpenAI.CompletionUsage {
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}

export interface DeepSeekOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  prices: Prices;
  /** Pauses before asking again while DeepSeek says it's too busy (tests pass zeros). */
  busyWaitsMs?: number[];
}

/**
 * DeepSeek turns requests away with 503 "too busy" in spells that last a few minutes. The SDK's own
 * retries come within a second or two, so before giving up, wait a little longer and ask again.
 */
const BUSY_WAITS_MS = [4_000, 12_000];

export async function patiently<T>(request: () => Promise<T>, waits = BUSY_WAITS_MS): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await request();
    } catch (err) {
      if (!busy(err) || i >= waits.length) throw err;
      await new Promise((r) => setTimeout(r, waits[i]));
    }
  }
}

/** DeepSeek is overloaded or rate limiting us, as opposed to the request being wrong. */
export function busy(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return status === 503 || status === 429;
}

/** DeepSeek's chat API through the OpenAI SDK (the API is OpenAI-compatible). */
export class DeepSeek implements ChatModel {
  private readonly client: OpenAI;

  constructor(private readonly opts: DeepSeekOptions) {
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseUrl, timeout: 30_000, maxRetries: 2 });
  }

  get model(): string {
    return this.opts.model;
  }

  async complete(messages: ChatMessage[], opts: CompleteOptions): Promise<ModelTurn> {
    const params = {
      model: this.opts.model,
      messages,
      max_tokens: opts.maxTokens,
      temperature: opts.temperature ?? 1.0,
      ...(opts.tools?.length ? { tools: opts.tools, tool_choice: opts.toolChoice ?? 'auto' } : {}),
      ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
      // DeepSeek-specific: thinking mode is on by default. Chat replies don't need it (it's slower and
      // bills reasoning tokens as output); the stress-test argument does.
      thinking: { type: opts.thinking ? 'enabled' : 'disabled' },
    } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;
    const res = await patiently(() => this.client.chat.completions.create(params), this.opts.busyWaitsMs);
    const message = res.choices[0]?.message;
    const native = (message?.tool_calls ?? []).flatMap((call) =>
      call.type === 'function' ? [{ id: call.id, name: call.function.name, arguments: call.function.arguments }] : [],
    );
    // Tool calls written into the text instead of made: run them if tools are allowed this round, and never
    // let the markup reach a reply.
    const inline = extractInlineCalls(message?.content?.trim() ?? '');
    const toolsAllowed = Boolean(opts.tools?.length) && opts.toolChoice !== 'none';
    return {
      text: inline.text,
      toolCalls: native.length ? native : toolsAllowed ? inline.calls : [],
      usage: costOf(res.usage as DeepSeekUsage | undefined, this.opts.prices),
    };
  }
}

export function costOf(usage: DeepSeekUsage | undefined, prices: Prices): Usage {
  const hit = usage?.prompt_cache_hit_tokens ?? 0;
  const miss = usage?.prompt_cache_miss_tokens ?? (usage?.prompt_tokens ?? 0) - hit;
  const out = usage?.completion_tokens ?? 0;
  return {
    cacheHitTokens: hit,
    cacheMissTokens: miss,
    outputTokens: out,
    costUsd: (hit * prices.inputHit + miss * prices.inputMiss + out * prices.output) / 1_000_000,
  };
}
