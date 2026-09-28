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
});