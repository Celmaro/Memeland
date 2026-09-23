import { MarketSentinel, marketSentinelProbe } from '../services/market-sentinel.js';
import { globalBotRiskWindow } from '../services/bot-detection.js';
import { globalMarketRegimeFilter } from '../services/market-regime.js';
import { startScreeningScheduler, type ScreeningSchedulerHandle } from './screening-scheduler.js';

/** Env knob: allow a macro risk-off regime (BTC/ETH bear/extreme) to trip the kill-switch.
 * Default off — the regime already votes inside the swarm; bot-risk tripping is always on.
 * Re-enable for live AUTO_EXECUTE if you want the macro veto back: MARKET_SENTINEL_REGIME_TRIPS=true. */
export function sentinelRegimeTripsEnabled(): boolean {
  return process.env.MARKET_SENTINEL_REGIME_TRIPS === 'true';
}

/** Build the independent market-risk monitor owned by startup/risk. */
export function createMarketRiskMonitor(): MarketSentinel {
  return new MarketSentinel(
    marketSentinelProbe(globalBotRiskWindow, globalMarketRegimeFilter),
    undefined,
    { regimeRiskOffTrips: sentinelRegimeTripsEnabled() }
  );
}

/** Start runtime monitoring while preserving the previous non-overlapping scheduler semantics. */
export function startRuntimeMonitoring(options: { runCycle: () => Promise<void>; marketSentinel?: MarketSentinel }): ScreeningSchedulerHandle {
  return startScreeningScheduler({
    runCycle: options.runCycle,
    marketSentinel: options.marketSentinel,
  });
}
