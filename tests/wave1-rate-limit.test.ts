import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProviderRateLimiter } from '../src/services/provider-rate-limiter.js';
import { MulticallBalanceReader } from '../src/services/multicall-balance-reader.js';
import { preFilterToken } from '../src/agents/shared/gmgn-meme-helpers.js';
import { normalizeDexToken } from '../src/agents/meme-robinhood/robinhood-discovery.js';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down (test stub)')));
});
afterEach(() => vi.unstubAllGlobals());

describe('ProviderRateLimiter (I1-1)', () => {
  it('429s count toward opening the circuit, but not as per-token failures', () => {
    const rl = new ProviderRateLimiter({ failureThreshold: 3, baseBackoffMs: 1000 });
    rl.recordFailure('hostA', '429');
    rl.recordFailure('hostA', '429');
    rl.recordFailure('hostA', '429');
    expect(rl.isOpen('hostA')).toBe(true);
    expect(rl.retryInSec('hostA')).toBeGreaterThan(0);
  });

  it('a network failure is distinct from a 429 (does not necessarily open)', () => {
    const rl = new ProviderRateLimiter({ failureThreshold: 5, baseBackoffMs: 1000 });
    rl.recordFailure('hostB', 'network');
    rl.recordFailure('hostB', 'network');
    expect(rl.isOpen('hostB')).toBe(false);
  });

  it('half-open: after backoff elapses, allows a probe (recovery)', () => {
    const rl = new ProviderRateLimiter({ failureThreshold: 1, baseBackoffMs: 1000 });
    rl.recordFailure('hostC', '429');
    // force backoff to have elapsed
    const now = Date.now() + 5000;
    expect(rl.isOpen('hostC', now)).toBe(false);
  });

  it('budget + concurrency gates deny when exceeded', () => {
    const rl = new ProviderRateLimiter({ maxConcurrent: 1, minIntervalMs: 0, maxRequests: 10 });
    expect(rl.canRequest().ok).toBe(true);
    rl.acquire();
    expect(rl.canRequest().ok).toBe(false); // concurrency
    rl.release();
    expect(rl.canRequest().ok).toBe(true);
  });
});

describe('MulticallBalanceReader (I1-2) fallback', () => {
  it('falls back to individual reads when the chain has no multicall address', async () => {
    const m = new MulticallBalanceReader({ skipProbe: true } as never);
    // Unknown chain 'unknown' → multicallAddressFor returns undefined → fallback.
    const fallback = vi.fn(async (c: string, t: string, o: string) => 123n);
    const res = await m.readMany([{ chain: 'unknown', token: '0xT', owner: '0xO' }], fallback);
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(res.get('unknown:0xt:0xo')).toBe(123n);
  });
});

describe('I1-4 UNAVAILABLE ≠ 0', () => {
  const baseConfig = { minVolume1hUsd: 50000 } as unknown as Parameters<typeof preFilterToken>[1];

  it('normalizeDexToken carries sourceUnavailable through', () => {
    const token = normalizeDexToken('bsc', { address: '0xA', chainId: 56, symbol: 'A', priceUsd: 0, liquidityUsd: 0, volume24hUsd: 0, sourceUnavailable: true }, 'dexscreener');
    expect(token.sourceUnavailable).toBe(true);
  });

  it('prefilter reports an unavailable feed distinctly from a low-volume token', () => {
    const token = normalizeDexToken('bsc', { address: '0xA', chainId: 56, symbol: 'A', priceUsd: 0, liquidityUsd: 0, volume24hUsd: 0, sourceUnavailable: true }, 'dexscreener');
    const r = preFilterToken(token, baseConfig);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('feed down');
    expect(r.reason).not.toContain('volume 1h');
  });

  it('a real zero-volume token (no unavailable flag) is still the normal volume rejection', () => {
    const token = normalizeDexToken('bsc', { address: '0xA', chainId: 56, symbol: 'A', priceUsd: 0, liquidityUsd: 0, volume24hUsd: 0 }, 'dexscreener');
    const r = preFilterToken(token, baseConfig);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('volume 1h');
  });
});