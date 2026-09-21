import { MarketSentinel } from '../services/market-sentinel.js';

export interface ScreeningSchedulerOptions {
  runCycle: () => Promise<void>;
  marketSentinel?: MarketSentinel;
  intervalMs?: number;
  sentinelIntervalMs?: number;
}

/** Owns recurring scheduling state so boot composition does not own timer details. */
export function startScreeningScheduler(options: ScreeningSchedulerOptions): () => void {
  let running = false;
  let stopped = false;
  const intervalMs = options.intervalMs ?? 5 * 60 * 1000;
  const sentinelIntervalMs = options.sentinelIntervalMs ?? 60 * 1000;

  const tick = async (): Promise<void> => {
    if (stopped || running) {
      if (running) console.warn('[SCREENING] Previous cycle still running — skipping this tick (non-overlap lock).');
      return;
    }
    running = true;
    try { await options.runCycle(); }
    catch (err: any) { console.error('[SCREENING CYCLE BOOT ERROR]', err?.message || err); }
    finally { running = false; }
  };

  void tick();
  const cycleTimer = setInterval(() => { void tick(); }, intervalMs);
  const sentinelTimer = options.marketSentinel
    ? setInterval(() => {
        try { options.marketSentinel?.checkAndReact(); }
        catch (err: any) { console.warn(`[MARKET SENTINEL] pass error (${err.message}) — ignored.`); }
      }, sentinelIntervalMs)
    : undefined;

  return () => {
    stopped = true;
    clearInterval(cycleTimer);
    if (sentinelTimer) clearInterval(sentinelTimer);
  };
}
