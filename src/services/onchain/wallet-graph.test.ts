import { describe, it, expect } from 'vitest';
import { WalletGraph } from './wallet-graph.js';

describe('WalletGraph', () => {
  it('adds nodes and undirected edges idempotently', () => {
    const g = new WalletGraph();
    g.addNode('0xA', { handle: 'alice' });
    g.addEdge('0xA', '0xB');
    g.addEdge('0xA', '0xB'); // idempotent
    expect(g.size()).toBe(2);
    expect(g.neighbours('0xA')).toEqual(['0xb']);
    expect(g.metaOf('0xA')?.handle).toBe('alice');
  });

  it('finds the connected cluster of a wallet (co-active cohort)', () => {
    const g = new WalletGraph();
    g.addEdge('0xA', '0xB');
    g.addEdge('0xB', '0xC');
    g.addEdge('0xD', '0xE'); // separate component
    const cluster = g.connectedCluster('0xA');
    expect(cluster.sort()).toEqual(['0xa', '0xb', '0xc']);
  });

  it('links a handle\'s sol+evm wallets as one entity', () => {
    const g = new WalletGraph();
    g.linkHandleWallets('solX', '0xEVMy');
    expect(g.neighbours('solX')).toEqual(['0xevmy']);
  });

  it('registers handle→wallet identity and links all wallets of a handle (multi-chain)', () => {
    const g = new WalletGraph();
    g.registerHandle('Alpha', { chain: 'solana', provider: 'fomo', wallets: ['solAlpha', '0xEVMA'] });
    g.registerHandle('Alpha', { chain: 'bsc', provider: 'fomo', wallets: ['0xEVMA', '0xBNBA'] });
    expect(g.walletsOfHandle('Alpha').sort()).toEqual(['0xbnba', '0xevma', 'solalpha']);
    expect(g.handlesOfWallet('0xEVMA')).toContain('alpha');
    // All three wallets of Alpha are one connected entity.
    expect(g.connectedCluster('solAlpha').sort()).toEqual(['0xbnba', '0xevma', 'solalpha']);
    expect(g.metaOf('solAlpha')?.chain).toBe('solana');
    expect(g.metaOf('0xbnba')?.provider).toBe('fomo');
  });

  it('resolves a canonical trader from a handle or any wallet (collapses providers)', () => {
    const g = new WalletGraph();
    // Two provider handles that share a wallet → same physical trader.
    g.registerHandle('alice', { chain: 'solana', provider: 'fomo', wallets: ['solA', '0xEVMA'] });
    g.registerHandle('alice_fomo2', { chain: 'bsc', provider: 'gmgn', wallets: ['0xEVMA', '0xBNBA'] });
    const byWallet = g.resolveTrader('0xEVMA');
    expect(byWallet?.canonicalId).toBe('alice');
    expect(byWallet?.handles.sort()).toEqual(['alice', 'alice_fomo2']);
    expect(byWallet?.wallets.sort()).toEqual(['0xbnba', '0xevma', 'sola']);
    expect(byWallet?.chains.sort()).toEqual(['bsc', 'solana']);
    expect(byWallet?.providers.sort()).toEqual(['fomo', 'gmgn']);
    // Resolving by the OTHER handle yields the same canonical id.
    const byHandle = g.resolveTrader('alice_fomo2');
    expect(byHandle?.canonicalId).toBe('alice');
  });

  it('returns wallet-native cohorts: provider handles sharing a cluster collapse into one', () => {
    const g = new WalletGraph();
    g.registerHandle('alice', { chain: 'solana', provider: 'fomo', wallets: ['solA', '0xEVMA'] });
    g.registerHandle('alice_gmgn', { chain: 'bsc', provider: 'gmgn', wallets: ['0xEVMA', '0xBNBA'] });
    g.registerHandle('bob', { chain: 'solana', provider: 'fomo', wallets: ['solB'] });
    const cohorts = g.walletCohorts();
    expect(cohorts).toHaveLength(2); // alice cluster + bob singleton
    const aliceCohort = cohorts.find((c) => c.handles.includes('alice'));
    expect(aliceCohort?.handles.sort()).toEqual(['alice', 'alice_gmgn']); // collapsed
    expect(aliceCohort?.providers.sort()).toEqual(['fomo', 'gmgn']);
  });

  it('resolveTrader returns undefined for an unknown identity', () => {
    const g = new WalletGraph();
    expect(g.resolveTrader('nobody')).toBeUndefined();
  });
});

describe('WalletGraph P9 — identity-edge provenance + durability', () => {
  it('records handle provenance on identity edges from registerHandle', () => {
    const g = new WalletGraph();
    g.registerHandle('alice', { wallets: ['0xSOL', '0xEVM'] });
    expect(g.provenanceFor('0xsol', '0xevm')).toBe('handle:alice');
    g.addEdge('0xsol', '0xOTHER', 'co-trade');
    expect(g.provenanceFor('0xsol', '0xother')).toBe('co-trade');
    // linkHandleWallets provenance
    const h = new WalletGraph();
    h.linkHandleWallets('W1', 'W2');
    expect(h.provenanceFor('W1', 'W2')).toBe('identity-resolve');
  });

  it('hydrate replays edge + handle events (with provenance) and resolves clusters', () => {
    const g = new WalletGraph();
    g.hydrate([
      { type: 'handle', handle: 'alice', chain: 'sol', provider: 'fomo', wallets: ['WA', 'WB'] },
      { type: 'edge', a: 'WB', b: 'WC', provenance: 'co-trade' },
    ]);
    expect(g.provenanceFor('wa', 'wb')).toBe('handle:alice');
    expect(g.provenanceFor('wb', 'wc')).toBe('co-trade');
    expect(g.walletsOfHandle('alice')).toEqual(expect.arrayContaining(['wa', 'wb']));
    const r = g.resolveTrader('alice');
    expect(r?.wallets).toEqual(expect.arrayContaining(['wa', 'wb', 'wc'])); // WB bridges alice + co-trade edge
    expect(g.neighbours('wa')).toContain('wb');
  });

  it('hydrate refuses to clobber a graph that already has data this process', () => {
    const g = new WalletGraph();
    g.addEdge('A', 'B');
    g.hydrate([{ type: 'handle', handle: 'ghost', wallets: ['C', 'D'] }]);
    expect(g.resolveTrader('ghost')).toBeUndefined(); // not applied
    expect(g.neighbours('a')).toContain('b'); // live data intact
  });
});