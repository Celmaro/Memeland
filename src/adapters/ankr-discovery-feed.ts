/**
 * B4 — Ankr-style sub-indexer discovery feed (SRC-PairCreated).
 *
 * Discovers brand-new pairs via on-chain `PairCreated` logs on the canonical
 * DEX factory for each EVM chain, resolved through the RPC failover pool —
 * keyless, no Ankr account needed (freemium-compatible). This closes the
 * discovery-freshness gap: pairs appear the moment the factory emits, before
 * any paprika/gecko/screener/gmgn indexer has picked them up.
 *
 * Fail-soft by design: any transport error yields [] — discovery is additive,
 * never a gate. Volume/liquidity are unknown at birth (they are market-depth
 * facts the indexers provide later); the feed only supplies address/chain/pair
 * metadata with priceUsd=0 and liquidityUsd=0 so downstream prefiltering
 * decides whether a raw pair is worth following up.
 */

import type { MarketDataProvider, MarketToken, MarketDiscoveryOptions } from './market-data-provider.js';
import { globalRPCFailoverManager } from '../services/rpc-failover.js';

/** Uniswap V2 factory PairCreated topic0 (keccak256("PairCreated(address,address,address,uint256)")). */
export const PAIR_CREATED_TOPIC0 = '0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9';

/** Per-chain canonical DEX factory addresses (Uniswap V2-style PairCreated). */
export const FACTORY_ADDRESSES: Record<string, string> = {
  eth: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f', // Uniswap V2
  bsc: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73', // PancakeSwap V2
  base: '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6', // Uniswap V2 on Base (canonical)
  // robinhood deliberately ABSENT: 0x5C69bEe… is the Ethereum factory, NOT an
  // RH factory. An unverified guess returns empty forever, silently. Add the
  // RH factory address only once confirmed on-chain.
};

const CHAIN_TO_POOL: Record<string, 'rh' | 'eth' | 'bsc' | 'base'> = {
  eth: 'eth',
  ethereum: 'eth',
  bsc: 'bsc',
  binance: 'bsc',
  base: 'base',
};

const CHAIN_ID: Record<string, number> = { eth: 1, bsc: 56, base: 8453 };

interface PairCreatedLog {
  address: string; // factory that emitted
  topics: string[];
  data: string;
}

/** Extract a 20-byte address from a 32-byte left-padded word (topic or data word). */
function addressFromWord(word: string): string {
  return `0x${word.slice(-40).toLowerCase()}`;
}

/**
 * Decode a PairCreated log. token0/token1 are INDEXED args in topics[1..2]
 * (32-byte left-padded); the pair contract is a NON-indexed arg in `data`
 * (first 32-byte word). Returns null on malformed logs.
 */
export function decodePairCreated(log: PairCreatedLog): { token0: string; token1: string; pair: string } | null {
  const token0 = log.topics[1] ? addressFromWord(log.topics[1]) : '';
  const token1 = log.topics[2] ? addressFromWord(log.topics[2]) : '';
  const dataHex = log.data.startsWith('0x') ? log.data.slice(2) : log.data;
  const pair = dataHex.length >= 64 ? addressFromWord(dataHex.slice(0, 64)) : '';
  if (
    !/^0x[0-9a-f]{40}$/.test(token0) ||
    !/^0x[0-9a-f]{40}$/.test(token1) ||
    !/^0x[0-9a-f]{40}$/.test(pair)
  ) {
    return null;
  }
  return { token0, token1, pair };
}

export class AnkrDiscoveryFeed implements MarketDataProvider {
  readonly id = 'ankr-pair-created';

  /**
   * Discover pairs created since the given block (default: last 300 blocks ≈
   * recent window on fast chains; caller may raise for slower chains).
   * Fail-soft: transport errors → [].
   */
  async discover(options: MarketDiscoveryOptions = {}): Promise<MarketToken[]> {
    const chainIds = options.chainIds ?? Object.keys(FACTORY_ADDRESSES).map((c) => CHAIN_ID[c]);
    const results: MarketToken[] = [];
    for (const chainId of chainIds) {
      const chain = Object.keys(CHAIN_ID).find((c) => CHAIN_ID[c] === chainId && FACTORY_ADDRESSES[c]);
      if (!chain) continue;
      const factory = FACTORY_ADDRESSES[chain];
      const poolKey = CHAIN_TO_POOL[chain];
      const rpc = globalRPCFailoverManager.getActiveRPC(poolKey);
      if (!rpc) continue;
      try {
        const logs = await this.fetchPairCreated(rpc, factory, chainId);
        for (const log of logs) {
          const decoded = decodePairCreated(log);
          if (!decoded) continue;
          const meta = {
            chainId,
            pairAddress: decoded.pair,
            dex: factory.toLowerCase(),
          };
          // Emit BOTH sides — token0 is frequently WETH/WBNB; the merge dedupes
          // by address and prefilter rejects the base side on volume/liquidity.
          results.push({
            address: decoded.token0,
            symbol: '',
            priceUsd: 0,
            liquidityUsd: 0,
            volume24hUsd: 0,
            ...meta,
          });
          results.push({
            address: decoded.token1,
            symbol: '',
            priceUsd: 0,
            liquidityUsd: 0,
            volume24hUsd: 0,
            ...meta,
          });
        }
      } catch {
        // fail-soft: one chain's RPC hiccup must not drop the whole discovery
      }
    }
    return results;
  }

  /** eth_getLogs for PairCreated on the factory, last 300 blocks. */
  private async fetchPairCreated(rpc: string, factory: string, chainId: number): Promise<PairCreatedLog[]> {
    const head = (await this.rpcCall(rpc, 'eth_blockNumber', [])) as string;
    const latest = BigInt(head);
    const fromBlock = `0x${(latest - 300n).toString(16)}`;
    const payload = {
      fromBlock,
      toBlock: 'latest',
      address: factory,
      topics: [PAIR_CREATED_TOPIC0],
    };
    const res = await this.rpcCall(rpc, 'eth_getLogs', [payload]);
    return (res ?? []) as PairCreatedLog[];
  }

  private async rpcCall(rpc: string, method: string, params: unknown[]): Promise<unknown> {
    const res = await fetch(rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
    });
    if (!res.ok) throw new Error(`${method} HTTP ${res.status}`);
    const data = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (data.error) throw new Error(`${method}: ${data.error.message}`);
    return data.result;
  }
}
