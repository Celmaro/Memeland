import { describe, it, expect } from 'vitest';
import { PositionManager } from '../src/position/position-manager.js';

const mkPosition = () => ({
  id: 'POS_1',
  symbol: 'TOKX',
  contractAddress: 'MINTX',
  entryPriceUsd: 1.0,
  currentPriceUsd: 1.0,
  amount: 1000,
  highWaterMarkUsd: 1.0,
});

describe('PositionManager.updateMemePosition — stop-loss enforcement', () => {
  it('fires CRITICAL at -50% by default (stopLossPct unset)', () => {
    const pm = new PositionManager();
    pm.addPosition(mkPosition());

    // -40% is above the default -50% SL → no critical alert.
    expect(pm.updateMemePosition('POS_1', 0.6).triggerAlert).toBe(false);
    // -50% hits the default SL.
    const res = pm.updateMemePosition('POS_1', 0.5);
    expect(res.triggerAlert).toBe(true);
    expect(res.type).toBe('CRITICAL');
    expect(res.reason).toContain('-50%');
  });

  it('a tightened SL (stopLossPct=0.2) fires CRITICAL earlier at -20%, not -50%', () => {
    const pm = new PositionManager();
    pm.addPosition(mkPosition());
    expect(pm.tightenStopLoss('MINTX', 0.2)).toBe(true);

    // -40% is well past the tightened -20% SL → critical fires.
    const res = pm.updateMemePosition('POS_1', 0.6);
    expect(res.triggerAlert).toBe(true);
    expect(res.type).toBe('CRITICAL');
    expect(res.reason).toContain('-20%');
  });

  it('tightenStopLoss only narrows the SL — never widens it back', () => {
    const pm = new PositionManager();
    pm.addPosition(mkPosition());
    pm.tightenStopLoss('MINTX', 0.2);
    // A later, looser value must not widen the already-tightened SL.
    pm.tightenStopLoss('MINTX', 0.5);
    const pos = pm.getActivePositions().find((p) => p.contractAddress === 'MINTX');
    expect(pos?.stopLossPct).toBe(0.2);
  });
});
