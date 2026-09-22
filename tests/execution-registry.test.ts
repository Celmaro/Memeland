import { describe, it, expect } from 'vitest';
import {
  EXECUTION_CHAIN_REGISTRY,
  normalizeExecutionChainKey,
  resolveExecutionChain,
  resolveFundingToken,
  executableChainsFromEnv,
  explorerUrlForChain,
} from '../src/config/execution-registry.js';

describe('execution-registry (LI.FI multi-chain source of truth)', () => {
  it('maps every canonical chain to its LI.FI chain id', () => {
    expect(EXECUTION_CHAIN_REGISTRY.robinhood.lifiChainId).toBe(4663);
    expect(EXECUTION_CHAIN_REGISTRY.eth.lifiChainId).toBe(1);
    expect(EXECUTION_CHAIN_REGISTRY.bsc.lifiChainId).toBe(56);
    expect(EXECUTION_CHAIN_REGISTRY.base.lifiChainId).toBe(8453);
    expect(EXECUTION_CHAIN_REGISTRY.sol.lifiChainId).toBe(1151111081099710);
  });

  it('normalizes aliases to canonical keys', () => {
    expect(normalizeExecutionChainKey('robinhood')).toBe('robinhood');
    expect(normalizeExecutionChainKey('hood')).toBe('robinhood');
    expect(normalizeExecutionChainKey('solana')).toBe('sol');
    expect(normalizeExecutionChainKey('BNB Chain')).toBe('bsc');
    expect(normalizeExecutionChainKey('Ethereum')).toBe('eth');
    expect(normalizeExecutionChainKey('aptos')).toBeNull();
    expect(normalizeExecutionChainKey('')).toBeNull();
  });

  it('resolves a chain config or fails closed on unknown chains', () => {
    expect(resolveExecutionChain('sol').nativeCoin).toBe('SOL');
    expect(() => resolveExecutionChain('polygon')).toThrow(/unknown execution chain 'polygon'/);
  });

  it('resolves stablecoin funding tokens and rejects native / unknown (fail-closed)', () => {
    expect(resolveFundingToken('robinhood').symbol).toBe('USDG');
    expect(resolveFundingToken('eth', 'USDC').address.toLowerCase()).toMatch(/^0xa0b86991/);
    expect(() => resolveFundingToken('eth', 'ETH')).toThrow(/not a stablecoin/);
    expect(() => resolveFundingToken('sol', 'SOL')).toThrow(/not a stablecoin/);
    expect(() => resolveFundingToken('bsc', 'NOPE')).toThrow(/no funding token 'NOPE'/);
  });

  it('derives the executable set from MULTICHAIN_CHAINS and ignores unknown entries', () => {
    expect(executableChainsFromEnv({ MULTICHAIN_CHAINS: 'robinhood,sol,aptos' } as NodeJS.ProcessEnv).has('sol')).toBe(true);
    expect(executableChainsFromEnv({ MULTICHAIN_CHAINS: 'robinhood,sol,aptos' } as NodeJS.ProcessEnv).has('aptos')).toBe(false);
    expect(executableChainsFromEnv({} as NodeJS.ProcessEnv).size).toBe(0);
  });

  it('builds explorer URLs from the per-chain template', () => {
    expect(explorerUrlForChain('base', '0xabc')).toBe('https://basescan.org/tx/0xabc');
    expect(explorerUrlForChain('sol', 'hash')).toBe('https://solscan.io/tx/hash');
  });
});
