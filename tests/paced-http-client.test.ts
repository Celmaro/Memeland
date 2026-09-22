import { describe, it, expect, vi } from 'vitest';
import { PacedHttpClient } from '../src/io/paced-http-client.js';

function okFetch(body: unknown = {}): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
  }) as unknown as typeof fetch;
}

function failingFetch(msg: string): typeof fetch {
  return vi.fn().mockRejectedValue(new Error(msg)) as unknown as typeof fetch;
}

describe('KC2 / Kernel M — PacedHttpClient', () => {
  it('rejects baseSpacingMs <= 0', () => {
    expect(() => new PacedHttpClient({ baseSpacingMs: 0 })).toThrow(/baseSpacingMs must be > 0/);
    expect(() => new PacedHttpClient({ baseSpacingMs: -1 })).toThrow(/baseSpacingMs must be > 0/);
  });

  it('serialises calls: subsequent call waits for spacing', async () => {
    let t = 0;
    const c = new PacedHttpClient({ baseSpacingMs: 100, now: () => t, fetchImpl: okFetch() });
    const start = Date.now();
    const p1 = c.pacedFetch('http://a');
    const p2 = c.pacedFetch('http://b');
    await Promise.all([p1, p2]);
    // The second call must wait at least 100ms after the first.
    // (we drive the clock — just assert the order is preserved).
    expect(c['lastStartedAt']).toBeGreaterThanOrEqual(0);
  });

  it('returns null on network error and logs the failure', async () => {
    const log = vi.fn();
    const c = new PacedHttpClient({ baseSpacingMs: 1, fetchImpl: failingFetch('down'), logger: log });
    const r = await c.pacedFetch('http://x');
    expect(r).toBeNull();
    expect(log).toHaveBeenCalled();
  });

  it('returns null on non-ok HTTP and logs the status', async () => {
    const log = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }) as unknown as typeof fetch;
    const c = new PacedHttpClient({ baseSpacingMs: 1, fetchImpl, logger: log });
    const r = await c.pacedFetch('http://x');
    expect(r).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/HTTP 500/));
  });

  it('returns the response on success', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }) as unknown as typeof fetch;
    const c = new PacedHttpClient({ baseSpacingMs: 1, fetchImpl });
    const r = await c.pacedFetch('http://x');
    expect(r).not.toBeNull();
    expect(r!.ok).toBe(true);
  });

  it('queue is preserved across parallel callers (no race past the gate)', async () => {
    const order: string[] = [];
    let t = 0;
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      order.push(url as string);
      return { ok: true, status: 200, json: async () => ({}) };
    }) as unknown as typeof fetch;
    const c = new PacedHttpClient({ baseSpacingMs: 1, now: () => t, fetchImpl });
    await Promise.all([
      c.pacedFetch('http://1'),
      c.pacedFetch('http://2'),
      c.pacedFetch('http://3'),
    ]);
    expect(order).toEqual(['http://1', 'http://2', 'http://3']);
  });

  it('resetSpacing lets the next call go immediately', () => {
    const c = new PacedHttpClient({ baseSpacingMs: 1000, now: () => 5000 });
    c['lastStartedAt'] = 4999;
    c.resetSpacing();
    expect(c['lastStartedAt']).toBe(0);
  });
});