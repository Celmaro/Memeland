import { afterEach, describe, expect, it, vi } from 'vitest';
import { startScreeningScheduler } from '../src/startup/screening-scheduler.js';

describe('screening scheduler', () => {
  afterEach(() => vi.useRealTimers());

  it('starts immediately, skips overlap, and cleans up timers', async () => {
    vi.useFakeTimers();
    let resolveCycle!: () => void;
    const cycle = new Promise<void>((resolve) => { resolveCycle = resolve; });
    const runCycle = vi.fn(() => cycle);
    const stop = startScreeningScheduler({ runCycle, intervalMs: 10 });
    await vi.waitFor(() => expect(runCycle).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(30);
    expect(runCycle).toHaveBeenCalledTimes(1);
    resolveCycle();
    await cycle;
    stop();
    await vi.advanceTimersByTimeAsync(30);
    expect(runCycle).toHaveBeenCalledTimes(1);
  });
});
