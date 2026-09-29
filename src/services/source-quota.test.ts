import { describe, it, expect } from 'vitest';
import { SourceQuota, classifyHttpFailure, statusOf } from './source-quota.js';

describe('classifyHttpFailure', () => {
  it('classifies 400/402/429 as quota (paywall/rate-limit)', () => {
    for (const s of [400, 402, 429]) expect(classifyHttpFailure(s)).toBe('quota');
  });
  it('classifies 5xx and network errors as transient, others as unknown', () => {
    expect(classifyHttpFailure(503)).toBe('transient');
    expect(classifyHttpFailure(undefined, new Error('net'))).toBe('transient');
    expect(classifyHttpFailure(404)).toBe('unknown');
  });
  it('statusOf pulls status from nested provider errors', () => {
    expect(statusOf({ status: 429 })).toBe(429);
    expect(statusOf({ response: { status: 402 } })).toBe(402);
    expect(statusOf('boom')).toBeUndefined();
  });
});

describe('SourceQuota — best-effort demotion', () => {
  const now = 1_000_000;
  const q = new SourceQuota(1000, () => now);

  it('quota failure triggers a cooldown window during which the source is skipped', () => {
    q.clear();
    expect(q.backoff('gmgn', 'quota', now)).toBe(true); // first → log-worthy
    expect(q.backoff('gmgn', 'quota', now)).toBe(false); // repeat → silent
    expect(q.isCooling('gmgn', now)).toBe(true);
    expect(q.isCooling('gmgn', now + 1500)).toBe(false); // cooldown expired
  });

  it('cooldown summary reports active cooldowns with remaining ms', () => {
    q.clear();
    q.backoff('dexpaprika', 'quota', now);
    const active = q.cooling();
    expect(active).toHaveLength(1);
    expect(active[0].source).toBe('dexpaprika');
    expect(active[0].cooldownMs).toBeGreaterThan(0);
  });
});
