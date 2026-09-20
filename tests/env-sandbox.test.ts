import { describe, it, expect } from 'vitest';
import { withClearedEnv } from '../src/services/env-sandbox.js';
import { StrategyEngine } from '../src/orchestrator/strategy-engine.js';

describe('withClearedEnv', () => {
  it('empties the env for the duration of fn and restores it afterwards', () => {
    process.env.MEMELAND_PROBE = 'secret-value';
    let seenInside: string | undefined;
    withClearedEnv(() => {
      seenInside = process.env.MEMELAND_PROBE;
      process.env.STRAY = 'should-be-wiped';
    });
    expect(seenInside).toBeUndefined();
    // Stray key written inside the cleared window is wiped on restore.
    expect(process.env.STRAY).toBeUndefined();
    expect(process.env.MEMELAND_PROBE).toBe('secret-value');
    delete process.env.MEMELAND_PROBE;
  });

  it('restores even when fn throws', () => {
    process.env.MEMELAND_THROW = 'keep-me';
    expect(() => withClearedEnv(() => { throw new Error('boom'); })).toThrow('boom');
    expect(process.env.MEMELAND_THROW).toBe('keep-me');
    delete process.env.MEMELAND_THROW;
  });
});

describe('strategy env isolation', () => {
  const engine = new StrategyEngine();

  it("runStrategySafely runs evaluate with an empty env (secrets hidden)", () => {
    process.env.MEMELAND_PRIVATE_KEY = '0xdeadbeef';
    const strat = {
      evaluate: () => ({
        confidence: 10,
        recommendedAction: 'SKIP',
        reason: `env-seen=${String(process.env.MEMELAND_PRIVATE_KEY ?? 'none')}`,
      }),
    };
    const res = engine.runStrategySafely(strat, 'evaluate', {});
    expect(res.reason).toBe('env-seen=none');
    expect(process.env.MEMELAND_PRIVATE_KEY).toBe('0xdeadbeef');
    delete process.env.MEMELAND_PRIVATE_KEY;
  });
});
