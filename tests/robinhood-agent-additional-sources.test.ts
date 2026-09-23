import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RobinhoodScreeningAgent } from '../src/agents/meme-robinhood/robinhood-screening-agent.js';
import type { RhFillTapeReader, FillTapeWindow } from '../src/adapters/rh-fill-tape.js';
import type { MarketDataProvider } from '../src/adapters/market-data-provider.js';
import { DexScreenerFeed } from '../src/adapters/dexscreener-feed.js';

/**
 * The GMGN rank endpoint must return a candidate whose volume is too low to pass
 * the prefilter (so no security-audit / strategy / voter code runs) but that is
 * STILL COUNTED in the funnel `scanned` figure — that count is our observable for
 * "which candidates were merged before prefilter".
 */
const RANK_TOKEN = {
  address: '0xRANK', symbol: 'RANK', name: 'Rank Token', price: '0', market_cap: 100000,
  volume: 0, liquidity: 100, buys: 0, sells: 0, swaps: 0, holder_count: 10,
  top_10_holder_rate: 0, dev_team_hold_rate: 0, creator_token_status: null,
  smart_degen_count: 0, renowned_count: 0, bundler_rate: 0, rat_trader_amount_rate: 0,
  rug_ratio: 0, is_wash_trading: 0, cto_flag: 0, is_honeypot: 0, buy_tax: '0', sell_tax: '0',
  renounced_mint: 1, renounced_freeze_account: 1, creation_timestamp: null, open_timestamp: null,
  price_change_percent1m: 0, price_change_percent5m: 0, price_change_percent1h: 10,
  visiting_count: 0, square_mentions: 0, twitter_rename_count: 0, twitter_del_post_token_count: 0,
  twitter_create_token_count: 0, total_fee: null, dexscr_boost_fee: 0, dexscr_ad: 0,
  exchange: 'pump_amm', launchpad_platform: 'Pump.fun', launchpad_status: '1', progress: 1,
};

const rankResponse = { code: 0, data: { data: { rank: [RANK_TOKEN] } } };
const emptyTrenches = { code: 0, data: { new_creation: [], pump: [], near_completion: [], completed: [] } };
const emptyHot = { code: 0, data: [{ tokens: [] }] };
const priceResponse = { ethereum: { usd: 1929.03, usd_24h_change: 1.5 } };

/** GMGN fetch stub: rank returns one low-volume candidate; everything destructured/unknown throws. */
function stubGmgnFetch() {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
    if (url.includes('openapi.gmgn.ai/v1/market/rank')) return { ok: true, status: 200, headers: { get: () => null }, json: async () => rankResponse };
    if (url.includes('openapi.gmgn.ai/v1/market/hot_searches')) return { ok: true, status: 200, headers: { get: () => null }, json: async () => emptyHot };
    if (url.includes('openapi.gmgn.ai/v1/trenches')) return { ok: true, status: 200, headers: { get: () => null }, json: async () => emptyTrenches };
    if (url.includes('coingecko')) return { ok: true, status: 200, headers: { get: () => null }, json: async () => priceResponse };
    throw new Error(`unexpected fetch: ${url}`);
  }));
}

function makeTape(addresses: string[]): RhFillTapeReader {
  const reader: Partial<RhFillTapeReader> = {
    async readFillTape(tokenAddress: string): Promise<FillTapeWindow> {
      const entry = { wallet: '0xA', side: 'buy' as const, amountUsd: 5000, timestamp: 1, chainId: 4663, tokenAddress };
      return { chainId: 4663, tokenAddress, entries: addresses.includes(tokenAddress) ? [entry] : [], truncated: false, failOpen: false };
    },
  };
  return reader as RhFillTapeReader;
}

const makeDex = (tokens: { address: string }[]): MarketDataProvider => ({
  id: 'dexscreener',
  async discover() {
    return tokens.map((t) => ({ address: t.address, chainId: 4663, symbol: 'NEW', priceUsd: 0, liquidityUsd: 0, volume24hUsd: 0 }));
  },
});

describe('RobinhoodScreeningAgent — Q04 tape + Q06 DexScreener additional sources', () => {
  // Memeland fork defaults MULTICHAIN_CHAINS to all 5 chains. These tests were
  // authored single-chain; pin robinhood so the existing mocks stay valid.
  beforeEach(() => { process.env.MULTICHAIN_CHAINS = 'robinhood'; });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.RH_TAPE_ENABLED;
    delete process.env.DEXSCREENER_FEED_ENABLED;
    delete process.env.GMGN_API_KEY;
    delete process.env.MULTICHAIN_CHAINS;
  });

  it('(a) flags off → pass returns exactly the prior candidates (no change)', async () => {
    process.env.GMGN_API_KEY = 'test-key';
    stubGmgnFetch();
    const agent = new RobinhoodScreeningAgent(undefined, undefined, {
      tape: makeTape(['0xRANK', '0XTAPE']),
      tapeTokenAddresses: ['0xRANK', '0XTAPE'],
      dexscreener: makeDex([{ address: '0xRANK' }, { address: '0xNEW' }]),
    });
    const reports = await agent.runScreeningPass();
    expect(reports.length).toBe(0);
    // Only the single rank candidate is scanned — tape/dexscreener ignored while flags are off.
    expect(agent.getLastFunnelStats().scanned).toBe(1);
  });

  it('(b) flags on → tape + dexscreener appended and address-deduped against rank candidates', async () => {
    process.env.GMGN_API_KEY = 'test-key';
    stubGmgnFetch();
    process.env.RH_TAPE_ENABLED = 'true';
    process.env.DEXSCREENER_FEED_ENABLED = 'true';
    const agent = new RobinhoodScreeningAgent(undefined, undefined, {
      tape: makeTape(['0xRANK', '0XTAPE']),
      tapeTokenAddresses: ['0xRANK', '0XTAPE'],
      dexscreener: makeDex([{ address: '0xRANK' }, { address: '0xNEW' }]),
    });
    await agent.runScreeningPass();
    // rank(0xRANK) + tape unique (0XTAPE) + dexscreener unique (0xNEW); 0xRANK deduped across all three.
    expect(agent.getLastFunnelStats().scanned).toBe(3);
  });

  it('(c) throwing tape/dexscreener sources yield empty contribution without failing the pass', async () => {
    process.env.GMGN_API_KEY = 'test-key';
    stubGmgnFetch();
    process.env.RH_TAPE_ENABLED = 'true';
    process.env.DEXSCREENER_FEED_ENABLED = 'true';
    const throwingTape = { readFillTape: vi.fn().mockRejectedValue(new Error('tape down')) } as unknown as RhFillTapeReader;
    const throwingDex: MarketDataProvider = { id: 'dexscreener', discover: vi.fn().mockRejectedValue(new Error('dex down')) };
    const agent = new RobinhoodScreeningAgent(undefined, undefined, {
      tape: throwingTape,
      tapeTokenAddresses: ['0xRANK'],
      dexscreener: throwingDex,
    });
    const reports = await agent.runScreeningPass(); // must NOT throw
    expect(Array.isArray(reports)).toBe(true);
    // Both sources failed open → only the single rank candidate scanned.
    expect(agent.getLastFunnelStats().scanned).toBe(1);
  });

  it('(d) real DexScreenerFeed injected into the agent yields normalized candidates (composition-root wire)', async () => {
    process.env.DEXSCREENER_FEED_ENABLED = 'true';
    const feed = new DexScreenerFeed({
      fetch: (async () => ({
        ok: true,
        json: async () => ({
          tokenProfiles: [{ chainId: 'robinhood', tokenAddress: '0xREAL', symbol: 'REAL' }],
        }),
      })) as never,
    });
    const agent = new RobinhoodScreeningAgent(undefined, undefined, { dexscreener: feed });
    const candidates = await agent.collectDexscreenerCandidates('robinhood');
    expect(candidates.length).toBe(1);
    expect(candidates[0]!.address).toBe('0xREAL');
    expect(candidates[0]!.source).toBe('dexscreener');
  });
});
