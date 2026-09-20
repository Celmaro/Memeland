import { afterEach, describe, expect, it } from 'vitest';
import {
  TimeOnCurveFilter,
  classifyOrganicLift,
  rawPoolPrice,
  verifyRawPoolPrice,
} from '../src/services/time-on-curve.js';

const HOUR_MS = 60 * 60 * 1000;

interface SignaturePage {
  cursor?: string | null;
  signatures: Array<{ blockTimeMs?: number }>;
  truncated?: boolean;
}

function pageLoader(pages: SignaturePage[]) {
  return async (cursor: string | null) => {
    const index = cursor === null ? 0 : Number(cursor);
    const page = pages[index] ?? { signatures: [], cursor: null, truncated: false };
    return {
      signatures: page.signatures,
      nextCursor: page.cursor ?? null,
      truncated: page.truncated ?? false,
    };
  };
}

const sol = new TimeOnCurveFilter({ chains: ['sol'] });

describe('classifyOrganicLift (qlo 1.5x/2.4x thresholds)', () => {
  it('treats a fast fill as not organic with neutral lifts', () => {
    const r = classifyOrganicLift(0.5);
    expect(r.organic).toBe(false);
    expect(r.doubleRateLift).toBe(1);
    expect(r.fiveXRateLift).toBe(1);
  });

  it('applies the 1.5x double-rate lift once the curve took at least 2h to fill', () => {
    const r = classifyOrganicLift(2);
    expect(r.organic).toBe(true);
    expect(r.doubleRateLift).toBe(1.5);
    expect(r.fiveXRateLift).toBe(1);
  });

  it('applies the 2.4x five-x-rate lift once the curve took at least 5h to fill', () => {
    const r = classifyOrganicLift(5.5);
    expect(r.organic).toBe(true);
    expect(r.doubleRateLift).toBe(1.5);
    expect(r.fiveXRateLift).toBe(2.4);
  });
});

describe('TimeOnCurveFilter early-stop pagination (qlo)', () => {
  it('early-stops as soon as history proves the token is older than minAgeHours', async () => {
    const graduatedAtMs = 100_000;
    const loader = pageLoader([
      {
        cursor: '1',
        signatures: [{ blockTimeMs: graduatedAtMs - 10 * HOUR_MS }],
      },
      {
        cursor: null,
        signatures: [{ blockTimeMs: graduatedAtMs - 3 * HOUR_MS }],
      },
    ]);

    const r = await sol.assess({
      token: 'SOLTOK',
      chain: 'sol',
      graduatedAtMs,
      loader,
      minAgeHours: 2,
    });

    expect(r.enabled).toBe(true);
    expect(r.earlyStopped).toBe(true);
    expect(r.pagesRead).toBe(1);
    expect(r.organic).toBe(true);
    expect(r.timeOnCurveMs).toBe(10 * HOUR_MS);
  });

  it('pages to the first transaction when the fill is fast and never crosses the threshold', async () => {
    const graduatedAtMs = 100_000;
    const loader = pageLoader([
      {
        cursor: '1',
        signatures: [{ blockTimeMs: graduatedAtMs - 60 * 1000 }],
      },
      {
        cursor: null,
        signatures: [{ blockTimeMs: graduatedAtMs - 30 * 1000 }],
      },
    ]);

    const r = await sol.assess({
      token: 'FASTTOK',
      chain: 'sol',
      graduatedAtMs,
      loader,
      minAgeHours: 2,
    });

    expect(r.earlyStopped).toBe(false);
    expect(r.pagesRead).toBe(2);
    expect(r.organic).toBe(false);
    expect(r.timeOnCurveMs).toBe(60 * 1000);
  });

  it('fails closed with no organic signal when history is unreadable', async () => {
    const r = await sol.assess({
      token: 'GHOST',
      chain: 'sol',
      graduatedAtMs: 100_000,
      loader: async () => ({ signatures: [], nextCursor: null, truncated: false }),
    });
    expect(r.pagesRead).toBe(1);
    expect(r.organic).toBe(false);
    expect(r.evidence.some((e) => e.includes('unreadable'))).toBe(true);
  });
});

describe('verifyRawPoolPrice (raw-pool-state pricing verification)', () => {
  it('computes the true qlo price as quoteVaultBalance + virtualQuoteReserves over base', () => {
    const price = rawPoolPrice({
      quoteVaultBalance: 100,
      virtualQuoteReserves: 40,
      baseReserves: 50,
    });
    expect(price).toBeCloseTo((100 + 40) / 50, 10);
  });

  it('rejects a doc price that ignores the virtual quote reserves', () => {
    const pool = { quoteVaultBalance: 100, virtualQuoteReserves: 40, baseReserves: 50 };
    const v = verifyRawPoolPrice(pool, 2.0, 0.01);
    expect(v.verified).toBe(false);
    expect(v.rawPrice).toBeCloseTo(2.8, 10);
    expect(v.reason).toContain('mispricing');
  });

  it('fails closed when the raw pool state is unreadable', () => {
    const pool = { quoteVaultBalance: 100, virtualQuoteReserves: 40, baseReserves: 0 };
    expect(rawPoolPrice(pool)).toBeNull();
    const v = verifyRawPoolPrice(pool, 2.0);
    expect(v.verified).toBe(false);
    expect(v.reason).toContain('unreadable');
  });
});

describe('TimeOnCurveFilter SOL-only gate (MULTICHAIN_CHAINS)', () => {
  afterEach(() => {
    delete process.env.MULTICHAIN_CHAINS;
  });

  it('disables the filter for non-sol chains even when other chains are configured', async () => {
    const f = new TimeOnCurveFilter({ chains: ['bsc', 'base'] });
    const r = await f.assess({
      token: 'BSC',
      chain: 'bsc',
      graduatedAtMs: 100_000,
      loader: async () => ({ signatures: [], nextCursor: null, truncated: false }),
    });
    expect(r.enabled).toBe(false);
    expect(r.evidence.some((e) => e.includes('MULTICHAIN_CHAINS'))).toBe(true);
  });

  it('reads MULTICHAIN_CHAINS=sol as the enabling environment', () => {
    delete process.env.MULTICHAIN_CHAINS;
    expect(new TimeOnCurveFilter().isEnabled('sol')).toBe(false);
    process.env.MULTICHAIN_CHAINS = 'sol';
    expect(new TimeOnCurveFilter().isEnabled('sol')).toBe(true);
    expect(new TimeOnCurveFilter().isEnabled('robinhood')).toBe(false);
  });
});
