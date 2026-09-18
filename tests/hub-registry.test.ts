import { describe, it, expect, vi } from 'vitest';
import { OpenCatzHub } from '../src/orchestrator/hub.js';
import type { AgentReport, ScreeningAgent } from '../src/agents/shared/agent-contract.js';
import type { KrystalCloudAdapter, KrystalPoolSignal } from '../src/adapters/krystal-cloud-adapter.js';
import type { GMGNAdapter, GMGNSecurityAudit } from '../src/adapters/gmgn-adapter.js';

// ── Fixtures ──────────────────────────────────────────────────────────────

const mkReport = (symbol: string): AgentReport => ({
  passed: true,
  signal: { symbol },
  reason: 'test reason',
  confidence: 85,
});

const mkStubAgent = (domain: string, reports: AgentReport[] = []) => ({
  domain,
  runScreeningPass: vi.fn(async () => reports),
} as unknown as ScreeningAgent);

const mkKrystalPool = (over: Partial<KrystalPoolSignal> = {}): KrystalPoolSignal => ({
  poolAddress: '0xpool1',
  pairName: 'WETH-USDC',
  feeTier: 3000,
  tvlUsd: 150000,
  activeTvlUsd: 3000,
  volume1hUsd: 5000,
  fee1hUsd: 20,
  volume24hUsd: 120000,
  fee24hUsd: 360,
  feesToTvlRatio24h: 0.0024,
  volumeToTvlRatio1h: 0.033,
  volumeToActiveTvlRatio1h: 1.67,
  feeAprPercentage: 87.6,
  apr24h: 28.4,
  farmApr24h: 0,
  token0Symbol: 'WETH',
  token1Symbol: 'USDC',
  token0Address: '0xweth',
  token1Address: '0xusdc',
  aiRecommendation: 'Live Uniswap V3 pool WETH-USDC (Robinhood Chain)',
  ...over,
});

const mkKrystalStub = (pools: KrystalPoolSignal[]) => ({
  fetchTopRobinhoodPools: vi.fn(async () => pools),
  filterHighYieldPools: vi.fn((p: KrystalPoolSignal[]) => p),
} as unknown as KrystalCloudAdapter);

/** Default GMGN security audit (safe — passes fail-closed gate). */
const mkSafeAudit = (over: Partial<GMGNSecurityAudit> = {}): GMGNSecurityAudit => ({
  chain: 'sol',
  address: 'tokX123',
  isHoneypot: false,
  isBlacklist: false,
  isRenounced: true,
  renouncedMint: false,
  renouncedFreeze: false,
  canNotSell: false,
  buyTaxPct: 0,
  sellTaxPct: 0,
  averageTaxPct: 0,
  highTaxPct: 0,
  isOpenSource: true,
  burnRatioPct: 0,
  isLocked: false,
  isShowAlert: false,
  flags: [],
  ...over,
});

const mkGmgnStub = (infos: Record<string, any>, security: Record<string, GMGNSecurityAudit | null> = {}) => ({
  fetchTokenInfo: vi.fn(async (_chain: string, address: string) => infos[address] ?? null),
  fetchTokenSecurity: vi.fn(async (_chain: string, address: string) =>
    address in security ? security[address] : mkSafeAudit()
  ),
} as unknown as GMGNAdapter);

/** Default GMGN token info (safe — all security fields null/clean). */
const mkGmgnToken = (over: Record<string, any> = {}): any => ({
  priceUsd: 0.0001,
  marketCapUsd: 500000,
  volume24hUsd: 250000,
  volume1hUsd: 12000,
  liquidityUsd: 60000,
  buys: 100,
  sells: 50,
  swaps: 150,
  holderCount: 800,
  top10HolderRate: null,
  devTeamHoldRate: null,
  creatorClose: false,
  creatorTokenStatus: null,
  smartDegenCount: 3,
  renownedCount: 1,
  bundlerRate: null,
  ratTraderAmountRate: null,
  rugRatio: null,
  isWashTrading: false,
  isHoneypot: null,
  ctoFlag: false,
  renouncedMint: false,
  renouncedFreeze: false,
  creationTimestamp: Date.now() / 1000 - 7200,
  openTimestamp: null,
  priceChange1m: null,
  priceChange5m: null,
  priceChange1h: null,
  visitingCount: 0,
  squareMentions: 0,
  twitterRenameCount: 0,
  twitterDelPostCount: 0,
  twitterCreateTokenCount: 0,
  buyTax: null,
  sellTax: null,
  dexscrBoostFee: 0,
  dexscrAd: 0,
  totalFeeNative: null,
  exchange: 'raydium',
  launchpadPlatform: 'pump',
  launchpadStatus: '1',
  progress: null,
  source: 'gmgn',
  chain: 'sol',
  address: 'tokX123',
  symbol: 'CHIIKAWA',
  name: 'Chiikawa',
  ...over,
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe('OpenCatzHub registry-driven triggerAgentPass', () => {
  it('unknown domain returns [] without throwing (fail-closed)', async () => {
    const hub = new OpenCatzHub();
    const results = await hub.triggerAgentPass('does-not-exist');
    expect(results).toEqual([]);
  });

  it('alias "evm" resolves to meme-robinhood', async () => {
    const stub = mkStubAgent('meme-robinhood', [mkReport('PEPE')]);
    const hub = new OpenCatzHub({ agentFactories: { 'meme-robinhood': () => stub } });
    expect(await hub.triggerAgentPass('evm')).toHaveLength(1);
    expect(stub.runScreeningPass).toHaveBeenCalledTimes(1);
  });

  it('all active registered domains are triggerable via factories (meme-robinhood + whale-eth)', async () => {
    const ids = ['meme-robinhood', 'whale-eth'] as const;
    for (const id of ids) {
      const stub = mkStubAgent(id, [mkReport(id.toUpperCase())]);
      const hub = new OpenCatzHub({ agentFactories: { [id]: () => stub } });
      const results = await hub.triggerAgentPass(id);
      expect(results, `domain ${id}`).toHaveLength(1);
    }
  });

  it('factory exception is caught and returns [] (fail-closed)', async () => {
    const hub = new OpenCatzHub({
      agentFactories: {
        'whale-eth': () => {
          throw new Error('boom');
        },
      },
    });
    expect(await hub.triggerAgentPass('whale-eth')).toEqual([]);
  });
});
