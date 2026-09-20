import { describe, expect, it } from 'vitest';
import {
  highWaterMarkHardStop,
  profitLockFloor,
  RugBlacklist,
} from '../src/position/position-manager.js';

describe('highWaterMarkHardStop (SRC-067 fdv.lol HWM trailing hard-stop)', () => {
  it('binds the fixed hard stop when the trail is looser than protection', () => {
    const r = highWaterMarkHardStop(1, 1.02, 1.02, 0.3, 0.5);
    expect(r).not.toBeNull();
    const h = r as { stopPriceUsd: number; reason: string };
    expect(h.stopPriceUsd).toBeCloseTo(0.7, 5); // entry * (1 - 0.3)
    expect(h.reason).toBe('fixed hard stop');
  });

  it('trails tighter than the fixed stop once the high-water mark climbs', () => {
    const r = highWaterMarkHardStop(1, 3, 3, 0.3, 0.5);
    expect(r).not.toBeNull();
    const h = r as { stopPriceUsd: number; reason: string };
    expect(h.stopPriceUsd).toBeCloseTo(1.5, 5); // 3 * (1 - 0.5)
    expect(h.reason).toBe('high-water trail');
  });

  it('is fail-closed on invalid input', () => {
    expect(highWaterMarkHardStop(0, 1, 1)).toBeNull();
    expect(highWaterMarkHardStop(1, 2, 0.5)).toBeNull();
    expect(highWaterMarkHardStop(1, 2, 2, 1.5, 0.5)).toBeNull();
  });
});

describe('profitLockFloor (SRC-067 profit-lock floor)', () => {
  it('is inactive until price reaches the lock multiplier', () => {
    expect(profitLockFloor(1, 1.2, 1.5, 1.0).locked).toBe(false);
  });

  it('locks break-even once the lock multiplier is reached', () => {
    const r = profitLockFloor(1, 1.6, 1.5, 1.0);
    expect(r.locked).toBe(true);
    expect(r.floorUsd).toBeCloseTo(1.0, 5);
  });

  it('is fail-closed on invalid input', () => {
    expect(profitLockFloor(0, 1).locked).toBe(false);
    expect(profitLockFloor(1, 2, 0.5).locked).toBe(false);
  });
});

describe('RugBlacklist (SRC-067 rug blacklist)', () => {
  it('keys by chain:address case-insensitively', () => {
    const bl = new RugBlacklist();
    expect(bl.add('base', '0xAbC')).toBe(true);
    expect(bl.add('BASE', '0xabc')).toBe(false); // duplicate
    expect(bl.has('base', '0xABC')).toBe(true);
    expect(bl.has('eth', '0xAbC')).toBe(false);
    expect(bl.size).toBe(1);
  });

  it('is safe when queried with absent keys', () => {
    const bl = new RugBlacklist();
    expect(bl.has('eth', '0xnone')).toBe(false);
    expect(bl.size).toBe(0);
  });
});
