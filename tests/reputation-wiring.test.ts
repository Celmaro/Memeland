import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  ReputationMemory,
  fileReputationIO,
  type AegisSnapshot,
  type WalletProfile,
} from '../src/services/reputation-memory.js';
import {
  reputationAwareSecurityVote,
  reputationAwareWalletVote,
  type VoterContext,
} from '../src/orchestrator/voters.js';

const cleanSnapshot: AegisSnapshot = {
  mintAuthority: false,
  freezeAuthority: false,
  topHolderConcPct: 0,
  bundleDetected: false,
  lpStatus: 'locked',
  metadataFlags: false,
};

const establishedProfile: WalletProfile = { ageDays: 200, historyCount: 40 };

function baseCtx(overrides: Partial<VoterContext> = {}): VoterContext {
  return {
    token: { address: '0xTOKEN', symbol: 'TOKEN', name: 'Token', chain: 'base' } as never,
    chain: 'base',
    nativePriceUsd: 1,
    securityAuditPassed: true,
    signalConfidence: 80,
    walletMetrics: { netFlowRatio: 0.8, top10HolderRate: 0.2, distinctMakers: 6 },
    ...overrides,
  };
}

describe('reputation-aware voters (Kernel A wiring)', () => {
  it('blends wallet and reputation scores when both are trustworthy', () => {
    const memory = new ReputationMemory();
    const vote = reputationAwareWalletVote(
      baseCtx({
        reputation: {
          memory,
          deployer: '0xDEP',
          profile: establishedProfile,
          snapshot: cleanSnapshot,
        },
      }),
    );
    expect(vote.voter).toBe('wallet');
    expect(vote.score).toBeGreaterThan(50);
    expect(vote.reasons.some((r) => r.includes('wallet tag'))).toBe(true);
  });

  it('stays neutral when wallet inputs degrade even if reputation is clean', () => {
    const memory = new ReputationMemory();
    const vote = reputationAwareWalletVote(
      baseCtx({
        walletMetrics: { top10HolderRate: 0.1, distinctMakers: 6 },
        reputation: {
          memory,
          deployer: '0xDEP',
          profile: establishedProfile,
          snapshot: cleanSnapshot,
        },
      }),
    );
    expect(vote.score).toBe(50);
    expect(vote.reasons.some((r) => r.includes('fail-closed'))).toBe(true);
  });

  it('never trusts a known-rugged deployer (neutral 50, not a false win)', () => {
    const memory = new ReputationMemory();
    memory.setDeployerKnown('0xRUG', 'rugged');
    const vote = reputationAwareWalletVote(
      baseCtx({
        reputation: {
          memory,
          deployer: '0xRUG',
          profile: establishedProfile,
          snapshot: cleanSnapshot,
        },
      }),
    );
    expect(vote.score).toBe(50);
    expect(vote.reasons.some((r) => r.includes('KNOWN_RUGGER'))).toBe(true);
  });

  it('security vote is fail-closed on a known-rugged deployer even when audit passes', () => {
    const memory = new ReputationMemory();
    memory.setDeployerKnown('0xRUG', 'rugged');
    const vote = reputationAwareSecurityVote(true, memory, 'TOKEN', '0xRUG', cleanSnapshot);
    expect(vote.voter).toBe('security');
    expect(vote.score).toBe(0);
    expect(vote.reasons.some((r) => r.includes('known-rugged'))).toBe(true);
  });

  it('security vote keeps its normal score when reputation is clean', () => {
    const memory = new ReputationMemory();
    const vote = reputationAwareSecurityVote(true, memory, 'TOKEN', '0xDEP', cleanSnapshot);
    expect(vote.score).toBe(100);
  });
});

describe('reputation memory atomic-file persistence (Kernel A wiring)', () => {
  it('round-trips labels through atomic-file-store IO', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reputation-io-'));
    const filePath = path.join(dir, 'reputation-memory.json');
    try {
      const io = fileReputationIO(filePath);
      const memory = new ReputationMemory(io);
      memory.setDeployerKnown('0xDEP', 'good');
      memory.labelAfterFollowup('0xTOKEN', 'rugged');
      memory.flush();

      const reloaded = new ReputationMemory(fileReputationIO(filePath));
      expect(reloaded.deployerKnown('0xDEP')).toBe('good');
      expect(reloaded.followUpStatus('0xTOKEN')).toBe('rugged');
      expect(fs.existsSync(filePath)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
