import { describe, it, expect, vi } from 'vitest';
import { tryFetchJson } from '../src/io/try-fetch-json.js';

describe('KC3 / Kernel N — tryFetchJson', () => {
  it('returns null on network error and logs the failure', async () => {
    const log = vi.fn();
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    const r = await tryFetchJson('http://x', {}, { fetchImpl, logger: log });
    expect(r).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/network error/));
  });

  it('returns null on non-ok HTTP and logs the status', async () => {
    const log = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }) as unknown as typeof fetch;
    const r = await tryFetchJson('http://x', {}, { fetchImpl, logger: log });
    expect(r).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/HTTP 500/));
  });

  it('returns the parsed body on a 200', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ a: 1, b: 'x' }),
    }) as unknown as typeof fetch;
    const r = await tryFetchJson<{ a: number; b: string }>('http://x', {}, { fetchImpl });
    expect(r).toEqual({ a: 1, b: 'x' });
  });

  it('returns null when json() throws (malformed body)', async () => {
    const log = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => { throw new SyntaxError('Unexpected token'); },
    }) as unknown as typeof fetch;
    const r = await tryFetchJson('http://x', {}, { fetchImpl, logger: log });
    expect(r).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/json parse error/));
  });

  it('threads an explicit signal into the fetch call', async () => {
    const signal = new AbortController().signal;
    let seen: AbortSignal | null = null;
    const fetchImpl = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      seen = (init?.signal ?? null) as AbortSignal | null;
      return { ok: true, status: 200, json: async () => ({}) };
    }) as unknown as typeof fetch;
    await tryFetchJson('http://x', {}, { fetchImpl, signal });
    expect(seen).toBe(signal);
  });

  it('uses the caller-supplied init body when present', async () => {
    let seenBody: string | undefined;
    const fetchImpl = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      seenBody = init?.body as string | undefined;
      return { ok: true, status: 200, json: async () => ({}) };
    }) as unknown as typeof fetch;
    await tryFetchJson('http://x', { method: 'POST', body: '{"q":1}' }, { fetchImpl });
    expect(seenBody).toBe('{"q":1}');
  });

  it('includeErrorBody includes the body slice in the log message', async () => {
    const log = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false, status: 422,
      text: async () => '{"code":-1,"message":"invalid token"}',
      json: async () => ({ code: -1 }),
    }) as unknown as typeof fetch;
    const r = await tryFetchJson('http://x', {}, { fetchImpl, logger: log, includeErrorBody: true });
    expect(r).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/HTTP 422.*invalid token/));
  });
});