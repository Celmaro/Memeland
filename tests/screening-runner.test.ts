import { describe, it, expect, vi } from 'vitest';
import { withScreeningTimeout, DEFAULT_SCREENING_TIMEOUT_MS } from '../src/runtime/screening-runner.js';

describe('KC6 / Kernel Q — withScreeningTimeout', () => {
  it('defaults to 60s timeout', () => {
    expect(DEFAULT_SCREENING_TIMEOUT_MS).toBe(60_000);
  });

  it('resolves the value when the pass finishes fast', async () => {
    const p = Promise.resolve(['signal-a']);
    const out = await withScreeningTimeout(p, 'meme-robinhood', 1000);
    expect(out).toEqual(['signal-a']);
  });

  it('fail-closed: resolves [] when the pass exceeds the timeout', async () => {
    const log = vi.fn();
    const never = new Promise<never[]>(() => {});
    const out = await withScreeningTimeout(never, 'meme-robinhood', 20, log);
    expect(out).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/SCREENING TIMEOUT.*MEME-ROBINHOOD/));
  });

  it('rejects on pass error', async () => {
    const p = Promise.reject(new Error('boom'));
    await expect(withScreeningTimeout(p, 'meme-robinhood', 1000)).rejects.toThrow('boom');
  });

  it('clearTimeout prevents a late timeout from settling after resolve', async () => {
    vi.useFakeTimers();
    try {
      const log = vi.fn();
      const p = Promise.resolve('ok');
      const promise = withScreeningTimeout(p, 'meme-robinhood', 1000, log);
      const result = await promise;
      expect(result).toBe('ok');
      // Advance past the timeout window — timer was cleared, nothing fires.
      vi.advanceTimersByTime(2000);
      expect(log).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('custom timeout respects the passed ms', async () => {
    const log = vi.fn();
    const never = new Promise<never[]>(() => {});
    const start = Date.now();
    const out = await withScreeningTimeout(never, 'x', 10, log);
    expect(Date.now() - start).toBeLessThan(2000);
    expect(out).toEqual([]);
  });
});