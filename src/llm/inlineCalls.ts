import type { ToolCall } from './deepseek.js';

/**
 * DeepSeek sometimes writes a tool call into its text, in its own markup, instead of making the call:
 *
 *   <｜DSML｜function_calls>
 *   <｜DSML｜invoke name="get_price">
 *   <｜DSML｜parameter name="symbols" string="false">["TONUSDT"]</｜DSML｜parameter>
 *   </｜DSML｜invoke>
 *   </｜DSML｜function_calls>
 *
 * This reads those calls back out and returns the text without the markup, so the loop can run them
 * and nothing like it is ever posted.
 */
export function extractInlineCalls(text: string): { text: string; calls: ToolCall[] } {
  if (!/DSML/.test(text)) return { text, calls: [] };
  const calls: ToolCall[] = [];
  const invoke = /<[^>\n]*DSML[^>\n]*invoke\s+name="([^"]+)"[^>\n]*>([\s\S]*?)(?=<[^>\n]*DSML[^>\n]*invoke[^>\n]*>|$)/g;
  const param = /<[^>\n]*DSML[^>\n]*parameter\s+name="([^"]+)"(?:\s+string="(true|false)")?[^>\n]*>([\s\S]*?)<[^>\n]*DSML[^>\n]*parameter[^>\n]*>/g;
  for (const m of text.matchAll(invoke)) {
    const args: Record<string, unknown> = {};
    for (const p of m[2]!.matchAll(param)) {
      const raw = p[3]!.trim();
      if (p[2] === 'true') args[p[1]!] = raw;
      else {
        try {
          args[p[1]!] = JSON.parse(raw);
        } catch {
          args[p[1]!] = raw;
        }
      }
    }
    calls.push({ id: `inline_${calls.length}`, name: m[1]!, arguments: JSON.stringify(args) });
  }
  return { text: stripMarkup(text), calls };
}

/** The text with any tool-call markup removed: whole call blocks, then stray tags. */
export function stripMarkup(text: string): string {
  return text
    .replace(/<[^>\n]*DSML[^>\n]*function_calls[^>\n]*>[\s\S]*?(?:<[^>\n]*DSML[^>\n]*function_calls[^>\n]*>|$)/g, '')
    .replace(/<[^>\n]*DSML[^>\n]*>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
