import { describe, it, expect } from 'vitest';
import {
  RpcHealthMonitor,
  verifyBlockLag,
  withLagQuarantine,
  DEFAULT_LAG_THRESHOLD_BLOCKS,
} from './rpc-health.js';

describe('RpcHealthMonitor — penalty boxing', () => {
  it('returns the healthiest non-quarantined endpoint', () => {
    const m = new RpcHealthMonitor(['https://a.example', 'https://b.example']);
    expect(m.getActiveEndpoint()).toBe('https://a.example');
  });

  it('markFailure quarantines with exponential backoff; returns another host', () => {
    const m = new RpcHealthMonitor(['https://a.example', 'https://b.example']);
    m.markFailure('https://a.example');
    // a.example is quarantined → active flips to b.example
    expect(m.getActiveEndpoint()).toBe('https://b.example');
  });

  it('markSuccess decays failure count and restores availability', () => {
    const m = new RpcHealthMonitor(['https://a.example']);
    m.markFailure('https://a.example');
    m.markSuccess('https://a.example');
    expect(m.getActiveEndpoint()).toBe('https://a.example');
  });

  it('recovers after backoff elapses (ticking clock)', () => {
    let t = 0;
    const m = new RpcHealthMonitor(['https://a.example'], () => t);
    m.markFailure('https://a.example');
    expect(m.status()[0]!.quarantinedUntil).toBeGreaterThan(0);
    t = 5000; // past 1s backoff (2^1)
    expect(m.status()[0]!.quarantinedUntil).toBeLessThanOrEqual(t);
    expect(m.getActiveEndpoint()).toBe('https://a.example');
  });

  it('emergency resets all quarantines when every node is out (no full halt)', () => {
    let t = 0;
    const m = new RpcHealthMonitor(['https://a.example', 'https://b.example'], () => t);
    m.markFailure('https://a.example');
    m.markFailure('https://b.example');
    // Both quarantined → getActiveEndpoint resets quarantines and returns first.
    expect(m.getActiveEndpoint()).toBe('https://a.example');
  });

  it('empty node list → empty active endpoint, no throw', () => {
    const m = new RpcHealthMonitor([]);
    expect(m.getActiveEndpoint()).toBe('');
  });
});

describe('verifyBlockLag — cross-RPC lag quarantine', () => {
  it('quarantines a host lagging more than the threshold', async () => {
    const m = new RpcHealthMonitor(['https://fresh.example', 'https://stale.example']);
    const heights: Record<string, number> = {
      'https://fresh.example': 1000,
      'https://stale.example': 996, // lags by 4 > threshold 3
    };
    const r = await awaitBlockLag(m, heights);
    expect(r['https://stale.example']).toBe(996); // raw observed height
    expect(m.status().find((n) => n.url === 'https://stale.example')!.laggingBlocks).toBe(4);
    expect(m.status().find((n) => n.url === 'https://stale.example')!.quarantinedUntil).toBeGreaterThan(0);
  });

  it('does NOT quarantine a host within threshold', async () => {
    const m = new RpcHealthMonitor(['https://a.example', 'https://b.example']);
    const heights = { 'https://a.example': 1000, 'https://b.example': 999 };
    await awaitBlockLag(m, heights);
    expect(m.status().find((n) => n.url === 'https://b.example')!.quarantinedUntil).toBe(0);
  });

  it('reports a failing host via reportFailure without throwing the batch', async () => {
    const m = new RpcHealthMonitor(['https://down.example', 'https://up.example']);
    const reported: string[] = [];
    await verifyBlockLag(
      ['https://down.example', 'https://up.example'],
      async (url) => {
        if (url === 'https://down.example') throw new Error('down');
        return 100;
      },
      m,
      { reportFailure: (url) => reported.push(url) },
    );
    expect(reported).toEqual(['https://down.example']);
    expect(m.status().find((n) => n.url === 'https://up.example')!.quarantinedUntil).toBe(0);
  });
});

describe('withLagQuarantine — fail-open selector wrapper', () => {
  it('passes through when the node is not quarantined', () => {
    const m = new RpcHealthMonitor(['https://a.example']);
    const sel = withLagQuarantine(m, () => 'https://a.example');
    expect(sel('rh')).toBe('https://a.example');
  });

  it('skips a quarantined node (returns "")', () => {
    let t = 0;
    const m = new RpcHealthMonitor(['https://a.example'], () => t);
    m.markFailure('https://a.example');
    const sel = withLagQuarantine(m, () => 'https://a.example', () => t);
    expect(sel('rh')).toBe('');
    t = 5000;
    expect(sel('rh')).toBe('https://a.example');
  });

  it('is fail-open on empty selection and empty node list', () => {
    const m = new RpcHealthMonitor([]);
    expect(withLagQuarantine(m, () => '')('rh')).toBe('');
  });
});

// Small helper wrapping verifyBlockLag for the sync-looking assertions above.
async function awaitBlockLag(
  monitor: RpcHealthMonitor,
  heights: Record<string, number>,
): Promise<Record<string, number>> {
  return verifyBlockLag(Object.keys(heights), async (url) => heights[url]!, monitor, {
    threshold: DEFAULT_LAG_THRESHOLD_BLOCKS,
  });
}
