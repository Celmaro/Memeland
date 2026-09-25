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

export interface AnkrDiscoveryOptions extends MarketDiscoveryOptions {
  /** Blocks to scan back from head (default 300). Scanned in chunks. */
  lookbackBlocks?: number;
  /** Initial chunk size (blocks per eth_getLogs). Default 100. */
  chunkBlocks?: number;
  /** Min chunk before giving up on range-too-wide (default 5). */
  minChunkBlocks?: number;
  /** Confirmation depth: never scan the last N blocks (default 12). */
  confirmations?: number;
}

export interface AnkrDiscoveryResult {
  tokens: MarketToken[];
  /** True only when every chunk in the window completed; false on partial. */
  isComplete: boolean;
  /** Per-chain scan report for diagnostics (blocks covered / chunk backoffs). */
  chains: Record<string, { fromBlock: number; toBlock: number; chunks: number; isComplete: boolean }>;
}

export class AnkrDiscoveryFeed implements MarketDataProvider {
  readonly id = 'ankr-pair-created';

  /**
   * Scan PairCreated over a bounded lookback window in CHUNKS, because free
   * RPCs reject wide eth_getLogs ranges. On a provider range-too-wide error the
   * chunk halves (down to minChunkBlocks); each chunk is one eth_getLogs call.
   * `isComplete` is honest: false when a chunk could not be scanned.
   */
  async discover(options: AnkrDiscoveryOptions = {}): Promise<MarketToken[]> {
    return (await this.discoverDetailed(options)).tokens;
  }

  async discoverDetailed(options: AnkrDiscoveryOptions = {}): Promise<AnkrDiscoveryResult> {
    const chainIds = options.chainIds ?? Object.keys(FACTORY_ADDRESSES).map((c) => CHAIN_ID[c]);
    const lookback = options.lookbackBlocks ?? 300;
    const confirmations = options.confirmations ?? 12;
    const startChunk = options.chunkBlocks ?? 100;
    const minChunk = options.minChunkBlocks ?? 5;
    const tokens: MarketToken[] = [];
    const chains: AnkrDiscoveryResult['chains'] = {};

    for (const chainId of chainIds) {
      const chain = Object.keys(CHAIN_ID).find((c) => CHAIN_ID[c] === chainId && FACTORY_ADDRESSES[c]);
      if (!chain) continue;
      const factory = FACTORY_ADDRESSES[chain];
      const poolKey = CHAIN_TO_POOL[chain];
      const rpc = globalRPCFailoverManager.getActiveRPC(poolKey);
      if (!rpc) continue;

      let coveredFrom = 0;
      let coveredTo = 0;
      let chunks = 0;
      let done = false;
      try {
        const headHex = (await this.rpcCall(rpc, 'eth_blockNumber', [])) as string;
        let to = BigInt(headHex) - BigInt(confirmations);
        if (to < 1n) continue;
        let from = to - BigInt(lookback);
        if (from < 1n) from = 1n;
        let chunk = BigInt(startChunk);
        coveredFrom = Number(from);
        coveredTo = Number(to);

        while (from < to) {
          chunks += 1;
          const chunkEndExcl = from + chunk;
          const toBlock = chunkEndExcl > to ? to : chunkEndExcl;
          try {
            const logs = await this.fetchPairCreated(rpc, factory, from, toBlock);
            for (const log of logs) {
              const decoded = decodePairCreated(log);
              if (!decoded) continue;
              const meta = { chainId, pairAddress: decoded.pair, dex: factory.toLowerCase() };
              // freshLane: raw on-chain pairs have zero market data at birth —
              // they pass the LOW fresh floor so new launches are actually seen
              // by the funnel (recency fix), then re-checked on later cycles.
              tokens.push({ address: decoded.token0, symbol: '', priceUsd: 0, liquidityUsd: 0, volume24hUsd: 0, freshLane: true, ...meta });
              tokens.push({ address: decoded.token1, symbol: '', priceUsd: 0, liquidityUsd: 0, volume24hUsd: 0, freshLane: true, ...meta });
            }
            from = toBlock; // advance on success
          } catch (err) {
            // Range-too-wide → halve, then retry same window; floor at minChunk.
            if (chunk > BigInt(minChunk)) {
              chunk /= 2n;
              if (chunk < BigInt(minChunk)) chunk = BigInt(minChunk);
              continue;
            }
            // Below min chunk and still failing → mark incomplete, stop this chain.
            break;
          }
        }
        done = from >= to;
      } catch {
        // fail-soft: a transport error on head fetch leaves this chain empty but
        // does not drop the other chains.
        done = false;
      }
      chains[chain] = { fromBlock: coveredFrom, toBlock: coveredTo, chunks, isComplete: done };
    }

    const allComplete = Object.keys(chains).every((c) => chains[c]!.isComplete);
    return { tokens, isComplete: allComplete, chains };
  }

  /** eth_getLogs for PairCreated on the factory over [fromBlock, toBlock] (chunk). */
  private async fetchPairCreated(rpc: string, factory: string, fromBlock: bigint, toBlock: bigint): Promise<PairCreatedLog[]> {
    const payload = {
      fromBlock: `0x${fromBlock.toString(16)}`,
      toBlock: `0x${toBlock.toString(16)}`,
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
