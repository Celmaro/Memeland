import { describe, it, expect } from 'vitest';
import { ProviderGovernor } from './provider-governor.js';

function ok<T>(data: T, status = 200): Promise<{ data: T; status: number }> {
  return Promise.resolve({ data, status });
}

describe('ProviderGovernor', () => {
  it('serves a call from cache without charging twice', async () => {
    const g = new ProviderGovernor(() => 1_000);
    const cfg = { id: 'x', dailyCap: 10, ttlMs: 60_000, assumedCostPerCall: 1 };
    let calls = 0;
    const fn = () => { calls += 1; return ok({ v: 1 }); };
    const a = await g.run('x', cfg, 'k', fn);
    expect(a.ok).toBe(true);
    expect(a.fromCache).toBe(false);
    const b = await g.run('x', cfg, 'k', fn);
    expect(b.ok).toBe(true);
    expect(b.fromCache).toBe(true);
    expect(calls).toBe(1);
    expect(g.spendToday('x')).toBe(1);
  });

  it('freezes a provider once the daily cap is reached', async () => {
    const g = new ProviderGovernor(() => 1_000);
    const cfg = { id: 'x', dailyCap: 3, assumedCostPerCall: 1 };
    const fn = () => ok({ v: 1 });
    await g.run('x', cfg, null, fn);
    await g.run('x', cfg, null, fn);
    await g.run('x', cfg, null, fn);
    const fourth = await g.run('x', cfg, null, fn);
    expect(fourth.ok).toBe(false);
    expect(fourth.reason).toBe('daily-cap');
    const again = await g.run('x', cfg, null, fn);
    expect(again.ok).toBe(false);
    expect(again.reason).toBe('frozen'); // cap freeze = backoff window
  });

  it('paces bursts under the rpm bucket', async () => {
    const g = new ProviderGovernor(() => 5_000);
    const cfg = { id: 'x', rpm: 2, assumedCostPerCall: 1 };
    const fn = () => ok({ v: 1 });
    await g.run('x', cfg, null, fn);
    await g.run('x', cfg, null, fn);
    const third = await g.run('x', cfg, null, fn);
    expect(third.ok).toBe(false);
    expect(third.reason).toBe('rate-limited');
  });

  it('backs off on 402 and counts it as an exhaustion signal, not data', async () => {
    const g = new ProviderGovernor(() => 1_000);
    const cfg = { id: 'x', dailyCap: 100, assumedCostPerCall: 1 };
    const fn = () => Promise.resolve({ data: null, status: 402 });
    const a = await g.run('x', cfg, null, fn);
    expect(a.ok).toBe(false);
    expect(a.reason).toBe('daily-cap');
    // frozen -> subsequent call refuses without hitting the network
    const b = await g.run('x', cfg, null, fn);
    expect(b.ok).toBe(false);
    expect(b.reason).toBe('frozen');
  });

  it('treats 5xx as transient and does not spend credits', async () => {
    const g = new ProviderGovernor(() => 1_000);
    const cfg = { id: 'x', dailyCap: 100, assumedCostPerCall: 1 };
    const fn = () => Promise.resolve({ data: null, status: 503 });
    const a = await g.run('x', cfg, null, fn);
    expect(a.ok).toBe(false);
    expect(a.reason).toBe('http');
    expect(g.spendToday('x')).toBe(0);
  });
});