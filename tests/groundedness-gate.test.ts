import { describe, expect, it } from 'vitest';
import { extractClaims, groundednessGate } from '../src/services/groundedness-gate.js';

describe('extractClaims', () => {
  it('splits a message into assertion sentences', () => {
    expect(extractClaims('Liquidity is thin. Volume spiked!')).toEqual([
      'Liquidity is thin',
      'Volume spiked',
    ]);
  });

  it('returns [] for empty input', () => {
    expect(extractClaims('')).toEqual([]);
  });
});

describe('groundednessGate (SRC-185 claimchain)', () => {
  it('accepts a claim fully grounded in evidence', () => {
    const r = groundednessGate(
      'The token liquidity is below 100k USD',
      ['token liquidity observed below 100k USD'],
    );
    expect(r.accepted).toBe(true);
    expect(r.grounded).toBe(true);
  });

  it('rejects a claim with no overlapping evidence', () => {
    const r = groundednessGate(
      'The developer team is doxxed',
      ['pool liquidity 50k USD observed'],
    );
    expect(r.accepted).toBe(false);
    expect(r.grounded).toBe(false);
  });

  it('fails closed on empty claim text or evidence', () => {
    expect(groundednessGate('', ['fact']).accepted).toBe(false);
    expect(groundednessGate('some claim here', []).accepted).toBe(false);
  });

  it('requires every claim grounded under the strict default ratio', () => {
    const r = groundednessGate(
      'Liquidity is strong. The roadmap is missing.',
      ['liquidity 400k observed'],
    );
    expect(r.grounded).toBe(false);
    expect(r.verdicts.some((v) => !v.grounded)).toBe(true);
  });

  it('honors a relaxed requiredRatio for whole-message acceptance', () => {
    const r = groundednessGate(
      'Liquidity is strong. Alien crypto vibes.',
      ['liquidity 400k observed'],
      { requiredRatio: 0.5 },
    );
    expect(r.accepted).toBe(true);
    expect(r.grounded).toBe(false);
  });
});
