import { describe, it, expect, vi } from 'vitest';
import { DecisionCache } from '../src/services/decision-cache.js';

describe('DecisionCache.getSticky (azimuth sticky conviction)', () => {
  it('returns the validated conviction and reuses the cached value inside the TTL', async () => {
    const validator = vi.fn().mockReturnValue(72);
    const dc = new DecisionCache();

    const first = await dc.getSticky('MEME', validator, { ttlMs: 60_000 });
    const second = await dc.getSticky('MEME', validator, { ttlMs: 60_000 });

    expect(first).toBe(72);
    expect(second).toBe(72);
    expect(validator).toHaveBeenCalledTimes(1);
  });

  it('re-evaluates after the TTL has elapsed', async () => {
    let t = 0;
    const validator = vi.fn().mockReturnValue(70);
    const dc = new DecisionCache({ now: () => t });

    await dc.getSticky('MEME', validator, { ttlMs: 1_000 });
    t = 1_001;

    await expect(dc.getSticky('MEME', validator, { ttlMs: 1_000 })).resolves.toBe(70);
    expect(validator).toHaveBeenCalledTimes(2);
  });

  it('re-evaluates when the price has moved past priceMovePct', async () => {
    const validator = vi.fn().mockReturnValue(80);
    const dc = new DecisionCache();

    await dc.getSticky('MEME', validator, { priceMovePct: 5, price: 1.0, ttlMs: 60_000 });

    await expect(
      dc.getSticky('MEME', validator, { priceMovePct: 5, price: 1.1, ttlMs: 60_000 })
    ).resolves.toBe(80);
    expect(validator).toHaveBeenCalledTimes(2);
  });

  it('keeps the cached conviction when the price move is inside the threshold', async () => {
    const validator = vi.fn().mockReturnValue(80);
    const dc = new DecisionCache();

    await dc.getSticky('MEME', validator, { priceMovePct: 5, price: 1.0, ttlMs: 60_000 });

    await expect(
      dc.getSticky('MEME', validator, { priceMovePct: 5, price: 1.04, ttlMs: 60_000 })
    ).resolves.toBe(80);
    expect(validator).toHaveBeenCalledTimes(1);
  });

  it('returns null when the validator throws (fail closed)', async () => {
    const dc = new DecisionCache();
    const validator = vi.fn().mockImplementation(() => {
      throw new Error('conviction unavailable');
    });

    await expect(dc.getSticky('MEME', validator, { ttlMs: 60_000 })).resolves.toBeNull();
    expect(validator).toHaveBeenCalledTimes(1);
  });
});

describe('DecisionCache.getImmutable (Million one-way-door)', () => {
  it('keeps the first cached immutable fact even if a later validator would change it', async () => {
    const validator = vi
      .fn()
      .mockResolvedValueOnce('renounced')
      .mockResolvedValue('active');
    const dc = new DecisionCache();

    expect(await dc.getImmutable('MEME', validator, 3_600_000)).toBe('renounced');
    expect(await dc.getImmutable('MEME', validator, 3_600_000)).toBe('renounced');
    expect(validator).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite the one-way door after the TTL window has passed', async () => {
    let t = 0;
    const validator = vi
      .fn()
      .mockResolvedValueOnce('renounced')
      .mockResolvedValue('active');
    const dc = new DecisionCache({ now: () => t });

    await dc.getImmutable('MEME', validator, 1_000);
    t = 2_000;

    expect(await dc.getImmutable('MEME', validator, 1_000)).toBe('renounced');
    expect(validator).toHaveBeenCalledTimes(1);
  });

  it('returns null on first failure and can recover on a later call', async () => {
    const validator = vi.fn().mockRejectedValueOnce(new Error('rpc down')).mockResolvedValue('0xMINT');
    const dc = new DecisionCache();

    expect(await dc.getImmutable('MEME', validator, 3_600_000)).toBeNull();
    expect(await dc.getImmutable('MEME', validator, 3_600_000)).toBe('0xMINT');
    expect(validator).toHaveBeenCalledTimes(2);
  });
});

describe('DecisionCache.dedupByOwner (Million owner-id dedup)', () => {
  it('collapses five wallets controlled by one actor into one confirmation', async () => {
    const resolveOwner = vi.fn(async (wallet: string) =>
      wallet.startsWith('0xA') ? 'owner-A' : wallet
    );
    const dc = new DecisionCache({ resolveOwner });

    const owners = await dc.dedupByOwner(['0xA1', '0xA2', '0xA3', '0xA4', '0xA5']);

    expect(owners).toEqual(['owner-A']);
    expect(resolveOwner).toHaveBeenCalledTimes(5);
  });

  it('returns distinct owner ids while collapsing duplicates within the batch', async () => {
    const resolveOwner = vi.fn((wallet: string) =>
      wallet.startsWith('0xB') ? 'owner-B' : 'owner-C'
    );
    const dc = new DecisionCache({ resolveOwner });

    const owners = await dc.dedupByOwner(['0xB1', '0xC1', '0xB2']);

    expect(owners).toEqual(['owner-B', 'owner-C']);
  });

  it('falls back to the wallet address when an owner cannot be resolved', async () => {
    const dc = new DecisionCache({ resolveOwner: vi.fn().mockResolvedValue(null) });

    expect(await dc.dedupByOwner(['0xAA', '0xAB'])).toEqual(['0xAA', '0xAB']);
  });
});

describe('DecisionCache.getVolTarget (GARCH walk-forward vol-target cache)', () => {
  it('fetches and caches a vol target', async () => {
    const fetchVolTarget = vi.fn().mockResolvedValue(0.025);
    const dc = new DecisionCache({ fetchVolTarget });

    expect(await dc.getVolTarget('0xTOKEN')).toBe(0.025);
    expect(await dc.getVolTarget('0xTOKEN')).toBe(0.025);
    expect(fetchVolTarget).toHaveBeenCalledTimes(1);
  });

  it('refetches after the three-week refit window', async () => {
    let t = 0;
    const fetchVolTarget = vi.fn().mockResolvedValue(0.025);
    const dc = new DecisionCache({ now: () => t, fetchVolTarget });

    await dc.getVolTarget('0xTOKEN');
    t = 21 * 24 * 60 * 60 * 1000 + 1;

    expect(await dc.getVolTarget('0xTOKEN')).toBe(0.025);
    expect(fetchVolTarget).toHaveBeenCalledTimes(2);
  });

  it('returns null when the vol-target fetcher fails or no fetcher is configured', async () => {
    expect(await new DecisionCache().getVolTarget('0xTOKEN')).toBeNull();

    const empty = new DecisionCache({ fetchVolTarget: vi.fn().mockResolvedValue(null) });
    expect(await empty.getVolTarget('0xTOKEN')).toBeNull();

    const boom = new DecisionCache({
      fetchVolTarget: vi.fn().mockRejectedValue(new Error('garch offline')),
    });
    expect(await boom.getVolTarget('0xTOKEN')).toBeNull();
  });
});

describe('DecisionCache.primeSticky (Kernel S dedup hydration)', () => {
  it('primes a sticky entry that getSticky returns within TTL without running the validator', async () => {
    let t = 1000;
    const cache = new DecisionCache({ now: () => t });
    cache.primeSticky('call-meme-robinhood:TOKEN:0xCA', 500);
    const validator = vi.fn(() => 9999);
    // Within the default 5-min TTL (primed at 500, now 1000) -> returns 500.
    const seen = await cache.getSticky<number>('call-meme-robinhood:TOKEN:0xCA', validator);
    expect(seen).toBe(500);
    expect(validator).not.toHaveBeenCalled();
  });

  it('a primed entry expires with the TTL: validator runs and a fresh value is stored', async () => {
    let t = 1000;
    const cache = new DecisionCache({ now: () => t });
    cache.primeSticky('k', 500, 500); // at=500; TTL 5min -> expired once t > 300500
    t = 400000;
    const seen = await cache.getSticky<number>('k', () => t, { ttlMs: 5 * 60 * 1000 });
    expect(seen).toBe(400000);
  });

  it('boot hydration + dedup: a hit returns the old timestamp (skip), a miss stores and returns now', async () => {
    let t = 1000;
    const cache = new DecisionCache({ now: () => t });
    // boot hydration from persisted state
    cache.primeSticky('sig:A:0x1', 100, 100);
    // same cycle: hit -> old ts (100) -> caller skips
    const hit = await cache.getSticky<number>('sig:A:0x1', () => t);
    expect(hit).toBe(100);
    // fresh key: miss -> validator runs -> returns now
    const fresh = await cache.getSticky<number>('sig:B:0x2', () => t);
    expect(fresh).toBe(1000);
  });
});
