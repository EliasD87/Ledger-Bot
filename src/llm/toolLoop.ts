import type { ChatMessage, ChatModel, Tool, ToolCall, Usage } from './deepseek.js';

export interface ToolLoopOptions {
  maxTokens: number;
  tools: Tool[];
  /** Runs one tool call and returns its result for the model (usually JSON). */
  runTool: (call: ToolCall) => Promise<string>;
  /** Called after every model request, so each one is billed. */
  onUsage: (usage: Usage) => void;
  /** Model requests per reply, including the final text answer. */
  maxRounds?: number;
}

export interface ToolLoopResult {
  text: string;
  toolsUsed: string[];
  /** What each tool returned, in order: the only data the reply may quote. */
  toolResults: string[];
  /** The messages sent plus the tool calls and results, ready to continue from. */
  transcript: ChatMessage[];
}

/**
 * Lets the model call tools (prices, odds, records) before answering: request → run the tools it
 * asked for → feed results back → repeat. The last round forbids tools so the loop always ends in text.
 */
export async function chatWithTools(model: ChatModel, messages: ChatMessage[], opts: ToolLoopOptions): Promise<ToolLoopResult> {
  const transcript = [...messages];
  const toolsUsed: string[] = [];
  const toolResults: string[] = [];
  const maxRounds = opts.maxRounds ?? 3;
  for (let round = 1; ; round++) {
    const lastRound = round >= maxRounds;
    const turn = await model.complete(transcript, {
      maxTokens: opts.maxTokens,
      tools: opts.tools,
      toolChoice: lastRound ? 'none' : 'auto',
    });
    opts.onUsage(turn.usage);
    if (turn.toolCalls.length === 0 || lastRound) {
      if (turn.text) return { text: turn.text, toolsUsed, toolResults, transcript };
      // Nothing left once tool-call markup is taken out: ask once more for the answer itself.
      const retry = await model.complete([...transcript, { role: 'system', content: 'Write your reply to the member now, in plain text, from the tool results above.' }], {
        maxTokens: opts.maxTokens,
        tools: opts.tools,
        toolChoice: 'none',
      });
      opts.onUsage(retry.usage);
      return { text: retry.text, toolsUsed, toolResults, transcript };
    }

    transcript.push({
      role: 'assistant',
      content: turn.text || null,
      tool_calls: turn.toolCalls.map((call) => ({
        id: call.id,
        type: 'function' as const,
        function: { name: call.name, arguments: call.arguments },
      })),
    });
    for (const call of turn.toolCalls) {
      const result = await opts.runTool(call);
      toolsUsed.push(call.name);
      toolResults.push(result);
      transcript.push({ role: 'tool', tool_call_id: call.id, content: result });
    }
  }
}
