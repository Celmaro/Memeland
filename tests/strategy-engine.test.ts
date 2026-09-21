import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { StrategyEngine } from '../src/orchestrator/strategy-engine.js';

const STRAT_DIR = path.resolve(process.cwd(), 'strategies');

const VALID_STRATEGY = `
export default {
  id: 'test-momentum',
  name: 'Test Momentum',
  version: '1.0.0',
  description: 'Test strategy',
  params: { minLiquidityUsd: 10000 },
  evaluate: (ctx) => {
    const confidence = ctx.liquidityUsd >= 10000 ? 85 : 40;
    return { confidence, recommendedAction: 'BUY', reason: 'test' };
  },
};
`;

const INVALID_STRATEGY = `export default { id: 'broken', evaluate: 'not-a-function' };`;

afterEach(() => {
  for (const f of ['test-momentum.mjs', 'broken.mjs', '.active.json']) {
    const p = path.join(STRAT_DIR, f);
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      // Ignore EBUSY on Windows where dynamic import holds the file lock
    }
  }
  const bak = path.join(STRAT_DIR, '.backup', 'test-momentum.mjs.bak');
  try {
    if (fs.existsSync(bak)) fs.unlinkSync(bak);
  } catch {
    // Ignore EBUSY on Windows
  }
});

describe('StrategyEngine', () => {
  it('runs file-backed strategies without inheriting parent secrets', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memeland-strategy-'));
    const strategiesDir = path.join(tempRoot, 'strategies');
    const indicatorsDir = path.join(tempRoot, 'indicators');
    fs.mkdirSync(strategiesDir, { recursive: true });
    fs.writeFileSync(path.join(strategiesDir, '.active.json'), JSON.stringify({ test: 'secret-reader' }));
    fs.writeFileSync(path.join(strategiesDir, 'secret-reader.mjs'), `
      export default {
        id: 'secret-reader',
        evaluate: () => ({ reason: process.env.SECRET_FOR_TEST || 'none' }),
      };
    `);
    const previous = process.env.SECRET_FOR_TEST;
    process.env.SECRET_FOR_TEST = 'parent-secret';
    try {
      const strategy = new StrategyEngine({ strategiesDir, indicatorsDir }).getActiveStrategy('test');
      expect(strategy?.evaluate({}).reason).toBe('none');
      expect(process.env.SECRET_FOR_TEST).toBe('parent-secret');
    } finally {
      if (previous === undefined) delete process.env.SECRET_FOR_TEST;
      else process.env.SECRET_FOR_TEST = previous;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('writes and validates a strategy module', () => {
    const engine = new StrategyEngine();
    const res = engine.writeStrategy('test-momentum', VALID_STRATEGY);
    expect(res.success).toBe(true);
    expect(fs.existsSync(path.join(STRAT_DIR, 'test-momentum.mjs'))).toBe(true);
  });

  it('rejects invalid strategy and removes the file', () => {
    const engine = new StrategyEngine();
    const res = engine.writeStrategy('broken', INVALID_STRATEGY);
    expect(res.success).toBe(false);
    expect(fs.existsSync(path.join(STRAT_DIR, 'broken.mjs'))).toBe(false);
  });

  it('lists strategies and activates one', () => {
    const engine = new StrategyEngine();
    engine.writeStrategy('test-momentum', VALID_STRATEGY);
    const list = engine.listStrategies();
    expect(list.some((s) => s.id === 'test-momentum')).toBe(true);

    const active = engine.setActiveStrategy('meme-robinhood', 'test-momentum');
    expect(active.success).toBe(true);

    const listAfter = engine.listStrategies();
    expect(listAfter.find((s) => s.id === 'test-momentum')?.active).toBe(true);
  });

  it('activates the default meme-robinhood strategy', () => {
    const engine = new StrategyEngine();
    const res = engine.setActiveStrategy('meme-robinhood', 'meme-robinhood-default');
    expect(res.success).toBe(true);
    const active = engine.getActiveStrategy('meme-robinhood');
    expect(active?.id).toBe('meme-robinhood-default');
  });

  it('per-domain activation: activating meme-robinhood does not deactivate whale-eth', () => {
    const engine = new StrategyEngine();
    engine.setActiveStrategy('meme-robinhood', 'meme-robinhood-default');
    engine.setActiveStrategy('whale-eth', 'whale-eth-default');
    expect(engine.getActiveStrategy('meme-robinhood')?.id).toBe('meme-robinhood-default');
    expect(engine.getActiveStrategy('whale-eth')?.id).toBe('whale-eth-default');
  });

  it('falls back to domain-default strategy without explicit activation', () => {
    const engine = new StrategyEngine();
    // No active map set — the shipped meme-robinhood-default must be active out-of-the-box
    const active = engine.getActiveStrategy('meme-robinhood');
    expect(active?.id).toBe('meme-robinhood-default');
    // Domain normalization: uppercase/underscore (swarm style) also resolves
    const swarmStyle = engine.getActiveStrategy('MEME_ROBINHOOD');
    expect(swarmStyle?.id).toBe('meme-robinhood-default');
  });

  it('falls back to whale-eth-default strategy without explicit activation', () => {
    const engine = new StrategyEngine();
    // No active map set — the shipped whale-eth-default must be active out-of-the-box
    const active = engine.getActiveStrategy('whale-eth');
    expect(active?.id).toBe('whale-eth-default');
  });

  it('returns null when no strategy exists for the domain', () => {
    const engine = new StrategyEngine();
    expect(engine.getActiveStrategy('bogus-domain')).toBeNull();
  });

  it('loads the meme-vol-spike indicator', () => {
    const engine = new StrategyEngine();
    const ind = engine.getIndicator('meme-vol-spike');
    expect(ind).not.toBeNull();
    expect(ind!.id).toBe('meme-vol-spike');
    const candles = Array.from({ length: 30 }, (_, i) => ({
      time: i * 3600,
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      volume: i % 4 === 0 ? 500 : 50,
    }));
    const out = ind!.calculate(candles);
    expect(out.length).toBe(30);
  });
});

describe('customizable presets', () => {
  const engine = new StrategyEngine();

  it('loads the loosened defaults for the meme and whale domains', () => {
    const meme = engine.getActiveStrategy('meme-robinhood');
    const whale = engine.getActiveStrategy('whale-eth');
    expect(meme?.params.minVolume24hUsd).toBe(25000);
    expect(meme?.params.minLiquidityUsd).toBe(5000);
    expect(whale?.params.minPerpsUsd).toBe(500000);
  });

  it('standard presets exist and keep the strict values', () => {
    const files = fs.readdirSync('strategies').filter((f) => f.endsWith('.mjs'));
    expect(files).toContain('meme-robinhood-standard.mjs');
    expect(files).toContain('whale-eth-standard.mjs');
  });
});
