import { afterEach, describe, expect, it, vi } from 'vitest';
import { callWithRetry, failureValue, isRetryableStatus } from '../src/io/call-policy.js';

describe('I/O call policy', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('classifies retryable HTTP statuses', () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
  });

  it('retries retryable errors then succeeds', async () => {
    const execute = vi.fn()
      .mockRejectedValueOnce({ status: 429 })
      .mockResolvedValueOnce('ok');

    const result = await callWithRetry(execute, { attempts: 3, baseDelayMs: 1 });
    expect(result).toBe('ok');
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('throws when retries are exhausted', async () => {
    const execute = vi.fn().mockRejectedValue({ status: 503 });
    await expect(callWithRetry(execute, { attempts: 2, baseDelayMs: 1 })).rejects.toMatchObject({ status: 503 });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('applies the requested failure mode', () => {
    expect(failureValue('fail-open-empty', [], new Error('nope'))).toEqual([]);
    expect(() => failureValue('fail-closed', [], new Error('nope'))).toThrow('nope');
  });
});
