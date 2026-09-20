import { describe, expect, it } from 'vitest';
import { WorkflowDirector, type AutoHedgeIdea } from '../src/orchestrator/scoring-calibration.js';

const idea: AutoHedgeIdea = { symbol: 'TOK', confidence: 0.8, signalScore: 70 };

describe('AutoHedge WorkflowDirector (SRC-208 division)', () => {
  it('runs Quant -> Risk -> Execution and returns a sized plan', () => {
    const stages: string[] = [];
    const d = new WorkflowDirector({
      quant: (i) => {
        stages.push('QUANT');
        return i;
      },
      risk: (i) => {
        stages.push('RISK');
        return { approved: true };
      },
      execution: (i) => {
        stages.push('EXECUTION');
        return { sizeFraction: i.confidence * 0.5 };
      },
    });
    const r = d.run(idea);
    expect(r.plan).not.toBeNull();
    expect((r.plan as { sizeFraction: number }).sizeFraction).toBeCloseTo(0.4, 5);
    expect(stages).toEqual(['QUANT', 'RISK', 'EXECUTION']);
  });

  it('fails closed when the Quant stage discards the idea', () => {
    const d = new WorkflowDirector({ quant: () => null });
    const r = d.run(idea);
    expect(r.plan).toBeNull();
    expect(r.refusedAt).toBe('QUANT');
  });

  it('fails closed when the Risk stage rejects', () => {
    const d = new WorkflowDirector({ risk: () => ({ approved: false, reason: 'regime abstain' }) });
    const r = d.run(idea);
    expect(r.plan).toBeNull();
    expect(r.refusedAt).toBe('RISK');
    expect(r.reason).toBe('regime abstain');
  });

  it('fails closed when the Execution stage throws', () => {
    const d = new WorkflowDirector({
      execution: () => {
        throw new Error('boom');
      },
    });
    const r = d.run(idea);
    expect(r.plan).toBeNull();
    expect(r.refusedAt).toBe('EXECUTION');
  });

  it('clamps the size fraction to [0, 1]', () => {
    const d = new WorkflowDirector({ execution: () => ({ sizeFraction: 5 }) });
    const r = d.run(idea);
    expect((r.plan as { sizeFraction: number }).sizeFraction).toBe(1);
  });

  it('records which stages actually ran', () => {
    const d = new WorkflowDirector({});
    const r = d.run(idea);
    expect((r.plan as { stagesRun: string[] }).stagesRun).toEqual(['QUANT', 'RISK', 'EXECUTION']);
  });
});
