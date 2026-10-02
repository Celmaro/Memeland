import { describe, it, expect, vi } from 'vitest';
import { LocalNonceManager, type NonceProvider } from './local-nonce-manager.js';

function provider(nonce: number): NonceProvider {
  return { getTransactionCount: vi.fn(async () => nonce) };
}

describe('LocalNonceManager — deterministic EVM nonce sequencing', () => {
  it('seeds once from the provider then increments locally', async () => {
    const p = provider(7);
    const m = new LocalNonceManager(p);
    expect(await m.getAndIncrement('0xabc')).toBe(7);
    expect(await m.getAndIncrement('0xabc')).toBe(8);
    expect(await m.getAndIncrement('0xabc')).toBe(9);
    expect(p.getTransactionCount).toHaveBeenCalledTimes(1); // seeded only once
  });

  it('reset() re-seeds on the next call', async () => {
    const p = provider(5);
    const m = new LocalNonceManager(p);
    expect(await m.getAndIncrement('0xabc')).toBe(5);
    m.reset();
    expect(await m.getAndIncrement('0xabc')).toBe(5); // re-seeded (same provider value)
    expect(p.getTransactionCount).toHaveBeenCalledTimes(2);
  });

  it('serializes concurrent grants so bursts never share a nonce', async () => {
    const p = provider(0);
    const m = new LocalNonceManager(p, 1);
    const [a, b, c] = await Promise.all([
      m.getAndIncrement('0xabc'),
      m.getAndIncrement('0xabc'),
      m.getAndIncrement('0xabc'),
    ]);
    expect([a, b, c].sort((x, y) => x - y)).toEqual([0, 1, 2]);
  });
});
