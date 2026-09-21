import { MarketSentinel, marketSentinelProbe } from '../services/market-sentinel.js';
import { globalBotRiskWindow } from '../services/bot-detection.js';
import { globalMarketRegimeFilter } from '../services/market-regime.js';
import { startScreeningScheduler, type ScreeningSchedulerHandle } from './screening-scheduler.js';

/** Build the independent market-risk monitor owned by startup/risk. */
export function createMarketRiskMonitor(): MarketSentinel {
  return new MarketSentinel(marketSentinelProbe(globalBotRiskWindow, globalMarketRegimeFilter));
}

/** Start runtime monitoring while preserving the previous non-overlapping scheduler semantics. */
export function startRuntimeMonitoring(options: { runCycle: () => Promise<void>; marketSentinel?: MarketSentinel }): ScreeningSchedulerHandle {
  return startScreeningScheduler({
    runCycle: options.runCycle,
    marketSentinel: options.marketSentinel,
  });
}
