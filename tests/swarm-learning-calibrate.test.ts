import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SwarmLearningEngine, type SignalOutcome } from '../src/orchestrator/swarm-learning.js';

function outcome(id: string, result: SignalOutcome['result'], conf: number): SignalOutcome {
  return {
    id,
    agentId: 'quant',
    symbol: 'TEST',
    contractAddress: '0x0000000000000000000000000000000000000001',
    initialPriceUsd: 1,
    maxPriceReachedUsd: result.startsWith('TAKE_PROFIT') ? 2 : 1,
    lowestPriceReachedUsd: result === 'STOP_LOSS' ? 0.5 : 1,
    result,
    confidenceScore: conf,
    timestampIso: new Date().toISOString(),
  };
}

describe('SwarmLearningEngine calibrate (anti-overfit + scoring calibration)', () => {
  let dir: string;
  let engine: SwarmLearningEngine;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-calibrate-'));
    engine = new SwarmLearningEngine(path.join(dir, 'swarm_learning.json'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('(a) applies calibration on a high-trial positive stream', () => {
    const stream: SignalOutcome[] = [];
    for (let i = 0; i < 22; i++) stream.push(outcome(`win-${i}`, 'TAKE_PROFIT_2X', 90));
    for (let i = 0; i < 8; i++) stream.push(outcome(`loss-${i}`, 'STOP_LOSS', 10));

    const before = engine.getWeights();
    engine.calibrate(stream);
    const after = engine.getWeights();

    // 30 trials ≥ 25, win-rate 73% → deflated > 0, high-IC wins → positive deltas.
    expect(after.smartMoneyWeight).toBeGreaterThan(before.smartMoneyWeight);
    expect(engine.getLastCalibrationReason()).toMatch(/^calibration applied/);
  });

  it('(a) applies NOTHING on a low-trial stream and records a reason', () => {
    const stream: SignalOutcome[] = [outcome('w1', 'TAKE_PROFIT_2X', 90), outcome('w2', 'TAKE_PROFIT_2X', 90), outcome('w3', 'TAKE_PROFIT_2X', 90)];

    const before = engine.getWeights();
    engine.calibrate(stream);
    const after = engine.getWeights();

    expect(after).toEqual(before);
    expect(engine.getLastCalibrationReason()).toMatch(/low trial count/);
  });

  it('(a) applies NOTHING on a suspicious (non-positive) high-trial stream', () => {
    const stream: SignalOutcome[] = [];
    for (let i = 0; i < 20; i++) stream.push(outcome(`win-${i}`, 'TAKE_PROFIT_1_5X', 90));
    for (let i = 0; i < 20; i++) stream.push(outcome(`loss-${i}`, 'STOP_LOSS', 90));

    const before = engine.getWeights();
    engine.calibrate(stream);
    const after = engine.getWeights();

    // 40 trials but win-rate exactly 50% → deflated signal ≤ 0 → suspicious.
    expect(after).toEqual(before);
    expect(engine.getLastCalibrationReason()).toMatch(/suspicious stream/);
  });

  it('(b) updateSignalPrice still moves weights', () => {
    const { id } = engine.recordSignalCall('quant', 'TEST', '0xabc', 100, 80);
    const before = engine.getWeights();
    engine.updateSignalPrice(id, 250); // 2.5x initial → TAKE_PROFIT_2X
    const after = engine.getWeights();
    expect(after.smartMoneyWeight).toBeGreaterThan(before.smartMoneyWeight);
  });

  it('(c) getLastCalibrationReason returns a reason after calibrate', () => {
    expect(engine.getLastCalibrationReason()).toBeNull();
    engine.calibrate([outcome('x1', 'TAKE_PROFIT_2X', 90)]);
    expect(engine.getLastCalibrationReason()).toBeTruthy();
    expect(typeof engine.getLastCalibrationReason()).toBe('string');
  });

  it('(d) calibrate twice on the same stream is idempotent', () => {
    const stream: SignalOutcome[] = [];
    for (let i = 0; i < 22; i++) stream.push(outcome(`win-${i}`, 'TAKE_PROFIT_2X', 90));
    for (let i = 0; i < 8; i++) stream.push(outcome(`loss-${i}`, 'STOP_LOSS', 10));

    engine.calibrate(stream);
    const afterFirst = engine.getWeights();
    engine.calibrate(stream); // same streams, same ids → already consumed
    const afterSecond = engine.getWeights();

    expect(afterSecond).toEqual(afterFirst);
    expect(engine.getLastCalibrationReason()).toMatch(/no new terminal outcomes/);
  });
});