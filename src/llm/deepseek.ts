import OpenAI from 'openai';
import type { Prices } from '../config.js';

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
      temperature: 1.0,
      ...(opts.tools?.length ? { tools: opts.tools, tool_choice: opts.toolChoice ?? 'auto' } : {}),
      // DeepSeek-specific: thinking mode is on by default. Chat replies don't need it, and it is
      // slower and bills reasoning tokens as output.
      thinking: { type: 'disabled' },
    } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;
    const res = await this.client.chat.completions.create(params);
    const message = res.choices[0]?.message;
    return {
      text: message?.content?.trim() ?? '',
      toolCalls: (message?.tool_calls ?? []).flatMap((call) =>
        call.type === 'function' ? [{ id: call.id, name: call.function.name, arguments: call.function.arguments }] : [],
      ),
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
