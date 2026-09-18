import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SwarmLearningEngine } from '../src/orchestrator/swarm-learning.js';

describe('SwarmLearningEngine verbal reflector mode', () => {
  let dir: string;
  let engine: SwarmLearningEngine;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-reflector-'));
    engine = new SwarmLearningEngine(path.join(dir, 'swarm_learning.json'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('updates weights by default (live mode)', () => {
    const before = engine.getWeights();
    engine.recordAttributedOutcome(true);
    const after = engine.getWeights();
    expect(after.smartMoneyWeight).toBeGreaterThan(before.smartMoneyWeight);
  });

  it('freezes weights in verbal-reflector mode (no-update)', () => {
    engine.setVerbalReflector(true);
    expect(engine.isVerbalReflector()).toBe(true);
    const frozen = engine.getWeights();
    engine.recordAttributedOutcome(true);
    engine.recordAttributedOutcome(false);
    expect(engine.getWeights()).toEqual(frozen);
  });

  it('reflectOnOutcome emits narrative without mutating weights', () => {
    const before = engine.getWeights();
    const line = engine.reflectOnOutcome(true, 'dry-run');
    expect(line).toContain('SWARM REFLECTOR');
    expect(line).toContain('frozen');
    expect(engine.getWeights()).toEqual(before);
  });

  it('re-enabling live mode resumes recalibration', () => {
    engine.setVerbalReflector(true);
    engine.setVerbalReflector(false);
    const before = engine.getWeights();
    engine.recordAttributedOutcome(true);
    expect(engine.getWeights().smartMoneyWeight).toBeGreaterThan(before.smartMoneyWeight);
  });
});
