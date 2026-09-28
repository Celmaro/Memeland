/**
 * P0.1 — FomoTokenBoardProvider (provider-architecture v2: candidate emitter).
 *
 * Wraps FomoApiClient.tokenBoard(...) behind the shared MarketDataProvider
 * interface so it flows through the SAME env-gated, deduped, DISCOVERY_INTRODUCERS
 * pipeline as the other keyless feeds (`collectProviderCandidates`). Emits
 * CandidateHint-worthy candidates (trending / most-held / graduated tokens),
 * tagged source 'fomo'. Recall-without-authority: these are what the social app
 * *looks* interesting — on-chain verification gates promotion upstream.
 */

import type { MarketDataProvider, MarketToken, MarketDiscoveryOptions } from './market-data-provider.js';
import { FomoApiClient, type FomoTokenBoard, type FomoChain } from './fomo-api.js';
import { chainIdFor } from './market-data-provider.js';

const BOARDS: FomoTokenBoard[] = ['trending', 'most-held', 'graduated'];

export class FomoTokenBoardProvider implements MarketDataProvider {
  readonly id = 'fomo';

  constructor(private readonly client: FomoApiClient) {}

  async discover(options: MarketDiscoveryOptions = {}): Promise<MarketToken[]> {
    const chainIds = options.chainIds ?? [];
    const chain = chainIds.length > 0 ? (chainNameForId(chainIds[0]!) as FomoChain | undefined) : undefined;
    const out: MarketToken[] = [];
    const seen = new Set<string>();
    for (const board of BOARDS) {
      const rows = await this.client.tokenBoard(board, chain);
      for (const r of rows) {
        const key = `${r.address.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          address: r.address,
          liquidityUsd: 0,
          chainId: chainIdFor(r.chain) ?? 0,
          symbol: r.symbol,
          name: r.name,
          priceUsd: r.priceUsd,
          volume24hUsd: r.volumeUsd,
          change24hPct: r.change24hPct,
          // A token board is a *hint*, not a verified on-chain fact → mark
          // fresh-lane so the prefilter uses the fresh floor, never a zero.
          freshLane: true,
          dex: `fomo-${board}`,
        });
      }
    }
    return out;
  }
}

function chainNameForId(id: number): string | undefined {
  const map: Record<number, string> = {
    4663: 'robinhood',
    101: 'solana',
    1: 'ethereum',
    8453: 'base',
    56: 'bsc',
  };
  return map[id];
}