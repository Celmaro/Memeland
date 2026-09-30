import type { PositionRegime } from '../../position/position-manager.js';

export type CallDomain = 'MEME_ROBINHOOD' | 'ALPHA_ROBINHOOD';

/** Whale tracking: a single open position >= threshold belonging to one smart trader. */
export interface WhaleTraderEntry {
  address: string;
  sizeUsd: number;
  entryPx: number;
  returnPct: number;
}

/** Whale tracking: spot flow (fills >= threshold) per market within a 5-minute window. */
export interface WhaleSpotEntry {
  market: string;
  buyUsd: number;
  sellUsd: number;
  fillCount: number;
}

/** Whale tracking: smart trader position report per asset (BTC/ETH). */
export interface WhaleReport {
  coin: string;
  totalLongUsd: number;
  totalShortUsd: number;
  netUsd: number;
  longCount: number;
  shortCount: number;
  longTraders: WhaleTraderEntry[];
  shortTraders: WhaleTraderEntry[];
  spotFlow: WhaleSpotEntry[];
}

export interface CallCardPayload {
  domain: CallDomain;
  title: string;
  symbol: string;
  contractAddress?: string;
  network: string;
  tokenAge?: string;
  priceUsd?: string;
  marketCap?: string;
  liquidity?: string;
  volume5m?: string;
  volume1h?: string;
  volume24h?: string;
  txRatio?: string;
  top10Pct?: string;
  devHoldingPct?: string;
  sniperPct?: string;
  bundlerPct?: string;
  dexPaidStatus?: string;
  smartMoneyInfo?: string;
  tokenVerified?: boolean;
  confidenceScore?: number;
  securityScore?: string;
  aiThesis: string;
  dexScreenerUrl?: string;
  gmgnUrl?: string;
  goplusUrl?: string;
  poolUrl?: string;
  token0Address?: string;
  token1Address?: string;
  token0Symbol?: string;
  token1Symbol?: string;
  token0ChartUrl?: string;
  token1ChartUrl?: string;
  token0PriceUsd?: number;
  token0MarketCapUsd?: number;
  token0Volume24hUsd?: number;
  token0Holders?: number;
  token0AgeHours?: number;
  token0SmartDegenCount?: number;
  token0Verified?: boolean;
  securityAuditPassed: boolean;
  socialHypeScore: number;
  liquidityUsd: number;
  volume1hUsd: number;
  /** P0.2 — actual detected regime (FAST_MOMENTUM/REVIVAL/CTO/SMART_MONEY). Populated
   *  from the real detection path so paper trades record a true regime instead of
   *  'UNKNOWN'; the 3-regime paper-unlock gate (B#1) depends on real regime coverage. */
  regime?: PositionRegime;
  /** Arch-3 voter swarm scores (quant/ml/security/sentiment/whale/critic), when collected. */
  voterScores?: Partial<Record<string, number>>;
  whaleReport?: WhaleReport;
  cexRadar?: any[];
}

export interface AgentReport<TSignal = unknown> {
  passed: boolean;
  signal: TSignal;
  reason: string;
  confidence: number;
  payload?: CallCardPayload;
}

export interface ScreeningAgent<TSignal = unknown> {
  readonly domain: string;
  runScreeningPass(): Promise<AgentReport<TSignal>[]>;
}
