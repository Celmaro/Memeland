import { describe, expect, it } from 'vitest';
import { allowDecision, isAllowed, refuseDecision } from '../src/decision/decision-result.js';
import { RefusalCode } from '../src/decision/refusal-code.js';

describe('decision result', () => {
  it('shapes an allowed result', () => {
    const result = allowDecision({ sizeUsd: 10 }, 'decision-1', [{ id: 'risk', passed: true }]);
    expect(isAllowed(result)).toBe(true);
    expect(result.allowed).toBe(true);
    if (result.allowed) expect(result.value).toEqual({ sizeUsd: 10 });
  });

  it('shapes a refusal with a stable code', () => {
    const result = refuseDecision('decision-2', RefusalCode.RISK, 'drawdown cap hit');
    expect(isAllowed(result)).toBe(false);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.refusal).toBe('RISK');
      expect(result.reason).toBe('drawdown cap hit');
    }
  });
});
