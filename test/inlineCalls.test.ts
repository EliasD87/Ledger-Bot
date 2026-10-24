import { describe, expect, it } from 'vitest';
import { postableReply } from '../src/discord/text.js';
import { extractInlineCalls, stripMarkup } from '../src/llm/inlineCalls.js';

// What DeepSeek wrote into a reply on 2026-10-24 instead of calling get_price.
const LEAKED = [
  '<｜DSML｜function_calls>',
  '<｜DSML｜invoke name="get_price">',
  '<｜DSML｜parameter name="symbols" string="false">["TONUSDT"]</｜DSML｜parameter>',
  '</｜DSML｜invoke>',
  '</｜DSML｜function_calls>',
].join('\n');

describe('tool calls written as text', () => {
  it('reads them back as real calls and leaves no markup', () => {
    const out = extractInlineCalls(LEAKED);
    expect(out.text).toBe('');
    expect(out.calls).toEqual([{ id: 'inline_0', name: 'get_price', arguments: '{"symbols":["TONUSDT"]}' }]);
  });

  it('keeps the text around them and handles string parameters and several calls', () => {
    const text = `Checking.\n<｜DSML｜function_calls>\n<｜DSML｜invoke name="stress_test">\n<｜DSML｜parameter name="take" string="true">ton at 1.5 by december</｜DSML｜parameter>\n</｜DSML｜invoke>\n<｜DSML｜invoke name="show_chart">\n<｜DSML｜parameter name="assets" string="false">["GRAM"]</｜DSML｜parameter>\n<｜DSML｜parameter name="days" string="false">7</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜function_calls>`;
    const out = extractInlineCalls(text);
    expect(out.text).toBe('Checking.');
    expect(out.calls.map((c) => [c.name, JSON.parse(c.arguments)])).toEqual([
      ['stress_test', { take: 'ton at 1.5 by december' }],
      ['show_chart', { assets: ['GRAM'], days: 7 }],
    ]);
  });

  it('never lets markup reach a post', () => {
    expect(postableReply(`Here you go.\n${LEAKED}`)).toBe('Here you go.');
    expect(stripMarkup('plain text')).toBe('plain text');
  });
});
