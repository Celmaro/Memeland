import { MarketSentinel } from '../services/market-sentinel.js';
import { RuntimeTaskScheduler } from '../runtime/task-scheduler.js';

export interface ScreeningSchedulerOptions {
  runCycle: () => Promise<void>;
  marketSentinel?: MarketSentinel;
  intervalMs?: number;
  sentinelIntervalMs?: number;
}

export interface ScreeningSchedulerHandle {
  (): void;
  statuses: () => Array<{
    name: string;
    running: boolean;
    lastStartedAt?: number;
    lastCompletedAt?: number;
    lastError?: string;
  }>;
}

/** Owns recurring scheduling state so boot composition does not own timer details. */
export function startScreeningScheduler(options: ScreeningSchedulerOptions): ScreeningSchedulerHandle {
  const intervalMs = options.intervalMs ?? 5 * 60 * 1000;
  const sentinelIntervalMs = options.sentinelIntervalMs ?? 60 * 1000;
  const scheduler = new RuntimeTaskScheduler({
    defaultIntervalMs: intervalMs,
    onError: (err) => console.error('[SCREENING CYCLE BOOT ERROR]', err instanceof Error ? err.message : String(err)),
  });
  scheduler.register({
    name: 'screening',
    run: () => options.runCycle(),
    intervalMs,
    immediate: true,
  });
  scheduler.start();
  const sentinelTimer = options.marketSentinel
    ? setInterval(() => {
        try { options.marketSentinel?.checkAndReact(); }
        catch (err: any) { console.warn(`[MARKET SENTINEL] pass error (${err.message}) — ignored.`); }
      }, sentinelIntervalMs)
    : undefined;

  const stop = () => {
    scheduler.stop();
    if (sentinelTimer) clearInterval(sentinelTimer);
  };
  return Object.assign(stop, { statuses: () => scheduler.statuses() });
}
