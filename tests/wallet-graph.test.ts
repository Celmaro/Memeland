import { describe, it, expect } from 'vitest';
import { WalletGraph } from '../src/graph/wallet-graph.js';

describe('WalletGraph (#4 funding lineage + independence)', () => {
  it('links a wallet to its funder and detects shared-funder clusters', () => {
    const g = new WalletGraph();
    // Wallet X and Y are both funded by deployer D.
    g.registerFunding('D', 'X');
    g.registerFunding('D', 'Y');
    g.registerFunding('E', 'Z'); // unrelated funder
    expect(g.funderOf('X')).toBe('d'); // canonical lowercase
    expect(g.funderOf('Y')).toBe('d');
    // X and Y share a funder; Z does not.
    expect(g.sameCluster('X', 'Y')).toBe(true);
    expect(g.sameCluster('X', 'Z')).toBe(false);
  });

  it('flags correlated wallets so N funded-by-one do NOT count as N independent', () => {
    const g = new WalletGraph();
    // 4 'smart-money' wallets ALL funded by one deployer = 1 economic actor.
    ['A', 'B', 'C', 'D'].forEach((w) => g.registerFunding('DEPLOYER1', w));
    expect(g.independentCount(['A', 'B', 'C', 'D'])).toBe(1);
    // A genuinely independent wallet separate from the group.
    g.registerFunding('FUNDER2', 'E');
    expect(g.independentCount(['A', 'B', 'C', 'D', 'E'])).toBe(2);
  });

  it('tracks deployer reputation: rugs vs successful launches', () => {
    const g = new WalletGraph();
    g.recordDeployerOutcome('DEPLOYER1', 'rug');
    g.recordDeployerOutcome('DEPLOYER1', 'rug');
    g.recordDeployerOutcome('DEPLOYER1', 'success');
    g.recordDeployerOutcome('DEPLOYER2', 'success');
    const rep1 = g.deployerReputation('DEPLOYER1');
    expect(rep1.rugRate).toBeCloseTo(0.67, 1);
    expect(rep1.launchCount).toBe(3);
    const rep2 = g.deployerReputation('DEPLOYER2');
    expect(rep2.rugRate).toBe(0);
  });
});