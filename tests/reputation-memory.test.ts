import { describe, it, expect } from 'vitest';
import { ReputationMemory, type AegisSnapshot } from '../src/services/reputation-memory.js';

/** A perfectly clean token — every AEGIS check passes. */
const clean: AegisSnapshot = {
  mintAuthority: false,
  freezeAuthority: false,
  topHolderConcPct: 0,
  bundleDetected: false,
  lpStatus: 'locked',
  metadataFlags: false,
};

describe('ReputationMemory.reputationAdjustment (A1 AEGIS six weighted checks)', () => {
  it('returns the full 100 score with empty evidence on a clean snapshot', () => {
    const rm = new ReputationMemory();
    const r = rm.reputationAdjustment('0x1', '0xDEP', clean);
    expect(r.score).toBe(100);
    expect(r.evidence).toEqual([]);
    expect(r.ref).toEqual([]);
  });

  it('deducts each failed check by its weight (mintAuthority 20, freezeAuthority 15, lpStatus 15)', () => {
    const rm = new ReputationMemory();
    const r = rm.reputationAdjustment('0x1', '0xDEP', {
      ...clean,
      mintAuthority: true,
      freezeAuthority: true,
      lpStatus: 'none',
    });
    expect(r.score).toBe(100 - 20 - 15 - 15);
    expect(r.evidence).toContain('mintAuthority');
    expect(r.evidence).toContain('freezeAuthority');
    expect(r.evidence).toContain('lpStatus');
  });

  it('bundleDetected (20) and topHolderConc>20 (20) and metadataFlags (10) also deduct', () => {
    const rm = new ReputationMemory();
    const r = rm.reputationAdjustment('0x1', '0xDEP', {
      ...clean,
      bundleDetected: true,
      topHolderConcPct: 55,
      metadataFlags: true,
    });
    expect(r.score).toBe(100 - 20 - 20 - 10);
  });

  it('applies the +25 known-good deployer adjustment', () => {
    const rm = new ReputationMemory();
    rm.setDeployerKnown('0xDEP', 'good');
    // Base 55 (three penalties) +25 = 80, observable below the 100 cap.
    const r = rm.reputationAdjustment('0x1', '0xDEP', {
      ...clean,
      mintAuthority: true,
      bundleDetected: true,
      metadataFlags: true,
    });
    expect(r.score).toBe(100 - 20 - 20 - 10 + 25);
    expect(r.evidence).toContain('known-good deployer +25');
  });

  it('applies the -25 known-rugged deployer adjustment', () => {
    const rm = new ReputationMemory();
    rm.setDeployerKnown('0xDEP', 'rugged');
    const r = rm.reputationAdjustment('0x1', '0xDEP', clean);
    expect(r.score).toBe(100 - 25);
    expect(r.evidence).toContain('known-rugged deployer -25');
  });

  it('emits a LOW_CONFIDENCE refusal when the score falls below the 60 floor', () => {
    const rm = new ReputationMemory();
    const r = rm.reputationAdjustment('0x1', '0xDEP', {
      ...clean,
      mintAuthority: true,
      freezeAuthority: true,
      bundleDetected: true,
      topHolderConcPct: 90,
    });
    expect(r.score).toBeLessThan(60);
    expect(r.ref).toContain('LOW_CONFIDENCE');
  });

  it('never emits a refusal at or above the floor', () => {
    const rm = new ReputationMemory();
    const r = rm.reputationAdjustment('0x1', '0xDEP', { ...clean, lpStatus: 'renounced' });
    expect(r.score).toBe(100 - 15);
    expect(r.ref).toEqual([]);
  });

  it('clamps the score into 0-100 even with stacked adjustments', () => {
    const rm = new ReputationMemory();
    rm.setDeployerKnown('0xDEP', 'rugged');
    const r = rm.reputationAdjustment('0x1', '0xDEP', {
      ...clean,
      mintAuthority: true,
      freezeAuthority: true,
      bundleDetected: true,
      topHolderConcPct: 100,
      lpStatus: 'none',
      metadataFlags: true,
    });
    expect(r.score).toBe(0);
  });
});

describe('ReputationMemory.labelAfterFollowup (A1 24h/72h/7d follow-up labels)', () => {
  it('records a status with a timestamp and returns the label', () => {
    let t = 1_000;
    const rm = new ReputationMemory(undefined, () => t);
    rm.labelAfterFollowup('0x1', 'rugged');
    expect(rm.followUpStatus('0x1')).toBe('rugged');
    expect(rm.followUpAgeMs('0x1')).toBe(0);
    t = 1_000 + 24 * 3_600_000;
    expect(rm.followUpAgeMs('0x1')).toBe(24 * 3_600_000);
  });

  it('returns null for an unlabelled token', () => {
    const rm = new ReputationMemory();
    expect(rm.followUpStatus('0xunseen')).toBeNull();
  });
});

describe('ReputationMemory.controlGroupScore (A24 Million control-group baseline)', () => {
  it('defaults to a neutral 50 per horizon', () => {
    const rm = new ReputationMemory();
    expect(rm.controlGroupScore('0x1', '6h')).toBe(50);
    expect(rm.controlGroupScore('0x1', '24h')).toBe(50);
    expect(rm.controlGroupScore('0x1', '72h')).toBe(50);
  });

  it('returns the calibrated baseline when set', () => {
    const rm = new ReputationMemory();
    rm.setControlGroupBaseline('24h', 62);
    expect(rm.controlGroupScore('0x1', '24h')).toBe(62);
  });
});

describe('ReputationMemory persistence (atomic read/write, same as safe-config)', () => {
  it('round-trips labels and deployer knowledge through injected io', () => {
    let persisted = '';
    const io = {
      read: () => persisted,
      write: (json: string) => {
        persisted = json;
      },
    };
    const rm = new ReputationMemory(io);
    rm.labelAfterFollowup('0x1', 'rugged');
    rm.setDeployerKnown('0xDEP', 'good');
    rm.setControlGroupBaseline('72h', 55);
    rm.flush();

    const rm2 = new ReputationMemory(io);
    expect(rm2.followUpStatus('0x1')).toBe('rugged');
    expect(rm2.deployerKnown('0xDEP')).toBe('good');
    expect(rm2.controlGroupScore('0x1', '72h')).toBe(55);
  });

  it('fail-closed on corrupt payload (never honors partial data)', () => {
    const io = { read: () => '{not valid json', write: () => {} };
    const rm = new ReputationMemory(io);
    expect(rm.followUpStatus('0x1')).toBeNull();
  });
});
