import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeTaskScheduler } from '../src/runtime/task-scheduler.js';

describe('RuntimeTaskScheduler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs immediately, skips overlap, and stops cleanly', async () => {
    vi.useFakeTimers();
    let resolveCycle!: () => void;
    const cycle = new Promise<void>((resolve) => { resolveCycle = resolve; });
    const run = vi.fn(() => cycle);
    const scheduler = new RuntimeTaskScheduler({ defaultIntervalMs: 10 });
    scheduler.register({ name: 'task', run, intervalMs: 10 });
    scheduler.start();

    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(30);
    expect(run).toHaveBeenCalledTimes(1);

    resolveCycle();
    await cycle;
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(30);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('records the last error on task status', async () => {
    vi.useFakeTimers();
    const run = vi.fn(() => Promise.reject(new Error('boom')));
    const scheduler = new RuntimeTaskScheduler({ defaultIntervalMs: 10 });
    scheduler.register({ name: 'failing', run });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(scheduler.statuses()[0]?.lastError).toBe('boom');
    scheduler.stop();
  });
});
