import { describe, expect, it, vi } from 'vitest';
import { busy, patiently } from '../src/llm/deepseek.js';

const status = (code: number) => Object.assign(new Error(`${code}`), { status: code });

describe('waiting out a busy DeepSeek', () => {
  it('asks again while DeepSeek is too busy, then answers', async () => {
    const request = vi.fn().mockRejectedValueOnce(status(503)).mockRejectedValueOnce(status(429)).mockResolvedValue('ok');
    await expect(patiently(request, [0, 0])).resolves.toBe('ok');
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('gives up after its waits, with the busy error', async () => {
    const request = vi.fn().mockRejectedValue(status(503));
    await expect(patiently(request, [0, 0])).rejects.toMatchObject({ status: 503 });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("doesn't retry a request that is simply wrong", async () => {
    const request = vi.fn().mockRejectedValue(status(400));
    await expect(patiently(request, [0, 0])).rejects.toMatchObject({ status: 400 });
    expect(request).toHaveBeenCalledTimes(1);
    expect(busy(status(400))).toBe(false);
    expect(busy(new Error('network'))).toBe(false);
  });
});
