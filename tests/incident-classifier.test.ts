import { describe, it, expect } from 'vitest';
import {
  classifyIncident,
} from '../src/orchestrator/incident-classifier.js';
import {
  classifyWallet,
  type TokenSnapshot,
} from '../src/services/reputation-memory.js';

const baseSnapshot: TokenSnapshot = {
  totalSupply: 1_000_000,
  heldByTopWalletsPct: 5,
  holdingWallets: 200,
  deployerWalletAgeDays: 60,
  deployerHistoryCount: 12,
  liquidityLocked: true,
  bundleTransactions: 0,
};

describe('classifyIncident (A2 COPUMP declarative incident table)', () => {
  it('classifies a healthy token as CLEAN', () => {
    expect(classifyIncident('0x1', baseSnapshot)).toBe('CLEAN');
  });

  it('flags a bundle attack when bundle txs spike across a narrow hold set', () => {
    const snap: TokenSnapshot = {
      ...baseSnapshot,
      bundleTransactions: 9,
      heldByTopWalletsPct: 78,
      holdingWallets: 14,
    };
    expect(classifyIncident('0x1', snap)).toBe('BUNDLE_PUMP');
  });

  it('flags a honeypot when liquidity is not locked', () => {
    const snap: TokenSnapshot = { ...baseSnapshot, liquidityLocked: false };
    expect(classifyIncident('0x1', snap)).toBe('HONEYPOT');
  });

  it('flags sequential pump when top-wallet concentration is very high', () => {
    const snap: TokenSnapshot = { ...baseSnapshot, heldByTopWalletsPct: 92 };
    expect(classifyIncident('0x1', snap)).toBe('SEQUENTIAL_PUMP');
  });

  it('a single suspect signal without a sharp pattern stays CLEAN', () => {
    const snap: TokenSnapshot = { ...baseSnapshot, holdingWallets: 8 };
    expect(classifyIncident('0x1', snap)).toBe('CLEAN');
  });
});

describe('classifyWallet (meme-radar fail-closed wallet classification)', () => {
  it('flags a known-rugged deployer by history', () => {
    expect(classifyWallet({ ageDays: 3, historyCount: 7 })).toBe('KNOWN_RUGGER');
  });

  it('flags a fresh wallet with no track record as SUSPICIOUS', () => {
    expect(classifyWallet({ ageDays: 1, historyCount: 1 })).toBe('FRESH_WALLET');
  });

  it('treats an established multi-trade wallet as ESTABLISHED', () => {
    expect(classifyWallet({ ageDays: 400, historyCount: 50 })).toBe('ESTABLISHED');
  });

  it('defaults to UNKNOWN rather than trusting an unknown shape', () => {
    expect(classifyWallet({ ageDays: 30, historyCount: 5 })).toBe('UNKNOWN');
  });
});
