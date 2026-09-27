import { describe, it, expect } from 'vitest';
import { JevRouter, type JevOutput } from '../src/ai/jev-router.js';
import { validateJevOutput } from '../src/ai/jev-schema.js';

const valid: JevOutput = {
  regime: 'MOMENTUM',
  continuationProb: 0.81,
  flowQuality: 0.88,
  walletIndependence: 0.94,
  exhaustion: 0.19,
  executionQuality: 0.86,
  nextAction: 'ENRICH_GMGN',
};

describe('Jev schema (P5.2 typed decision output)', () => {
  it('validates a well-formed typed decision', () => {
    expect(validateJevOutput(valid).ok).toBe(true);
  });

  it('rejects out-of-range probabilities (fail-closed — no fabricated odds)', () => {
    expect(validateJevOutput({ ...valid, continuationProb: 1.5 }).ok).toBe(false);
    expect(validateJevOutput({ ...valid, exhaustion: -0.1 }).ok).toBe(false);
  });

  it('rejects unknown regimes / actions (no hallucinated branches)', () => {
    expect(validateJevOutput({ ...valid, regime: 'MOON' }).ok).toBe(false);
    expect(validateJevOutput({ ...valid, nextAction: 'BUY_NOW' }).ok).toBe(false);
  });
});

describe('JevRouter (P5.2 cost-aware routing)', () => {
  it('routes to swarm fallback when Jev is disabled (JEV_ENABLED != true)', async () => {
    delete process.env.JEV_ENABLED;
    const router = new JevRouter({ swarmConfidence: 87 });
    const r = await router.decide({ rawScore: 87 });
    expect(r.source).toBe('swarm');
    expect(r.confidence).toBe(87);
  });

  it('uses Jev decision when enabled and the client returns valid output', async () => {
    process.env.JEV_ENABLED = 'true';
    const router = new JevRouter({
      swarmConfidence: 50,
      client: { call: async () => valid },
    });
    const r = await router.decide({ rawScore: 88 });
    expect(r.source).toBe('jev');
    expect(r.regime).toBe('MOMENTUM');
    expect(r.nextAction).toBe('ENRICH_GMGN');
    delete process.env.JEV_ENABLED;
  });

  it('falls back to swarm on Jev error or invalid output (never fabricates)', async () => {
    process.env.JEV_ENABLED = 'true';
    const router = new JevRouter({
      swarmConfidence: 72,
      client: { call: async () => ({ ...valid, regime: 'BROKEN' }) },
    });
    const r = await router.decide({ rawScore: 88 });
    expect(r.source).toBe('swarm');
    expect(r.confidence).toBe(72);
    delete process.env.JEV_ENABLED;
  });
});
