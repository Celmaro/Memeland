export interface RuntimeTask {
  name: string;
  run: (signal: AbortSignal) => Promise<void> | void;
  intervalMs?: number;
  immediate?: boolean;
  onError?: (error: unknown, taskName: string) => void;
}

export interface RuntimeTaskSchedulerOptions {
  defaultIntervalMs?: number;
  onError?: (error: unknown, taskName: string) => void;
}

interface RegisteredTask {
  task: RuntimeTask;
  running: boolean;
  stopped: boolean;
  timer: ReturnType<typeof setInterval> | null;
  lastStartedAt?: number;
  lastCompletedAt?: number;
  lastError?: string;
}

/** Single-flight recurring task runner with an immediate first pass by default. */
export class RuntimeTaskScheduler {
  private readonly defaultIntervalMs: number;
  private readonly onError: (error: unknown, taskName: string) => void;
  private readonly tasks = new Map<string, RegisteredTask>();
  private readonly abortController = new AbortController();
  private started = false;

  constructor(options: RuntimeTaskSchedulerOptions = {}) {
    this.defaultIntervalMs = options.defaultIntervalMs ?? 5 * 60 * 1000;
    this.onError = options.onError ?? ((error, taskName) => {
      console.error(`[RUNTIME SCHEDULER] ${taskName} failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  register(task: RuntimeTask): this {
    if (this.started) throw new Error('Cannot register a task after the scheduler has started');
    this.tasks.set(task.name, {
      task,
      running: false,
      stopped: false,
      timer: null,
    });
    return this;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const name of this.tasks.keys()) {
      const entry = this.tasks.get(name);
      if (!entry) continue;
      const intervalMs = entry.task.intervalMs ?? this.defaultIntervalMs;
      if (intervalMs > 0) {
        entry.timer = setInterval(() => void this.tick(name), intervalMs);
      }
      if (entry.task.immediate ?? true) void this.tick(name);
    }
  }

  stop(): void {
    this.started = false;
    this.abortController.abort();
    for (const entry of this.tasks.values()) {
      entry.stopped = true;
      if (entry.timer) {
        clearInterval(entry.timer);
        entry.timer = null;
      }
    }
  }

  statuses(): Array<{
    name: string;
    running: boolean;
    lastStartedAt?: number;
    lastCompletedAt?: number;
    lastError?: string;
  }> {
    return Array.from(this.tasks.entries()).map(([name, entry]) => ({
      name,
      running: entry.running,
      lastStartedAt: entry.lastStartedAt,
      lastCompletedAt: entry.lastCompletedAt,
      lastError: entry.lastError,
    }));
  }

  private async tick(name: string): Promise<void> {
    const entry = this.tasks.get(name);
    if (!entry || entry.stopped || entry.running) {
      if (entry?.running) {
        console.warn(`[RUNTIME SCHEDULER] ${name} skipped because the previous run is still active.`);
      }
      return;
    }

    entry.running = true;
    entry.lastStartedAt = Date.now();
    try {
      await entry.task.run(this.abortController.signal);
      entry.lastError = undefined;
    } catch (error) {
      entry.lastError = error instanceof Error ? error.message : String(error);
      (entry.task.onError ?? this.onError)(error, name);
    } finally {
      entry.lastCompletedAt = Date.now();
      entry.running = false;
    }
  }
}
