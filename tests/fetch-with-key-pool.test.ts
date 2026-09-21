import { describe, it, expect, vi, afterEach } from 'vitest';
import { createApiKeyPool, fetchWithKeyPool } from '../src/services/api-key-pool.js';

describe('fetchWithKeyPool', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  const ok = () => new Response('{}', { status: 200 });
  const http = (status: number) => new Response('{}', { status });

  it('returns null when the pool is empty (fail-closed)', async () => {
    const pool = createApiKeyPool('TESTPOOL_API_KEY', []);
    const fn = vi.fn();
    await expect(fetchWithKeyPool(pool, fn as never, { label: '[T]' })).resolves.toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });

  it('allowEmptyPool issues a single keyless request when the pool is empty', async () => {
    const pool = createApiKeyPool('TESTPOOL_API_KEY', []);
    const fn = vi.fn(async (key: string) => {
      expect(key).toBe('');
      return ok();
    });
    const res = await fetchWithKeyPool(pool, fn, { label: '[T]', allowEmptyPool: true });
    expect(res?.status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('returns the ok response from the primary key', async () => {
    const pool = createApiKeyPool('TESTPOOL_API_KEY', ['k1']);
    const fn = vi.fn().mockResolvedValue(ok());
    const res = await fetchWithKeyPool(pool, fn, { label: '[T]' });
    expect(res?.status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('k1');
  });

  it('rotates to the backup key on 401 and succeeds', async () => {
    const pool = createApiKeyPool('TESTPOOL_API_KEY', ['k1', 'k2']);
    const keys: string[] = [];
    const fn = vi.fn(async (key: string) => {
      keys.push(key);
      return key === 'k1' ? http(401) : ok();
    });
    const res = await fetchWithKeyPool(pool, fn, { label: '[T]' });
    expect(res?.status).toBe(200);
    expect(keys).toEqual(['k1', 'k2']);
    expect(pool.get()).toBe('k2');
  });

  it('rotates on 402 and 429 too', async () => {
    const pool = createApiKeyPool('TESTPOOL_API_KEY', ['k1', 'k2']);
    const fn = vi.fn(async (key: string) => (key === 'k1' ? http(402) : ok()));
    const res = await fetchWithKeyPool(pool, fn, { label: '[T]' });
    expect(res?.status).toBe(200);
    expect(pool.get()).toBe('k2');
  });

  it('returns the non-ok response unchanged for a non-retryable status', async () => {
    const pool = createApiKeyPool('TESTPOOL_API_KEY', ['k1', 'k2']);
    const fn = vi.fn().mockResolvedValue(http(500));
    const res = await fetchWithKeyPool(pool, fn, { label: '[T]' });
    expect(res?.status).toBe(500);
    expect(fn).toHaveBeenCalledTimes(1); // no rotation on 500
  });

  it('single-key pool never rotates on retryable status', async () => {
    const pool = createApiKeyPool('TESTPOOL_API_KEY', ['only']);
    const fn = vi.fn().mockResolvedValue(http(429));
    const res = await fetchWithKeyPool(pool, fn, { label: '[T]' });
    expect(res?.status).toBe(429);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(pool.get()).toBe('only');
  });

  it('respects a custom maxAttempts (all-retryable exhausts then returns last)', async () => {
    const pool = createApiKeyPool('TESTPOOL_API_KEY', ['a', 'b']);
    const fn = vi.fn().mockResolvedValue(http(429));
    const res = await fetchWithKeyPool(pool, fn, { label: '[T]', maxAttempts: 1 });
    expect(res?.status).toBe(429);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('returns null on fetch network error (fail-closed)', async () => {
    const pool = createApiKeyPool('TESTPOOL_API_KEY', ['k1']);
    const fn = vi.fn().mockRejectedValue(new Error('down'));
    await expect(fetchWithKeyPool(pool, fn, { label: '[T]' })).resolves.toBeNull();
  });

  it('uses custom retryStatuses and reasonFor', async () => {
    const pool = createApiKeyPool('TESTPOOL_API_KEY', ['k1', 'k2']);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fn = vi.fn(async (key: string) => (key === 'k1' ? http(403) : ok()));
    const res = await fetchWithKeyPool(pool, fn, {
      label: '[T]',
      retryStatuses: [403],
      reasonFor: () => 'custom',
    });
    expect(res?.status).toBe(200);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('custom'));
    warn.mockRestore();
  });
});
