/**
 * Q09 - Executor-DI + veto-with-reason + per-token serialization
 * (SRC-227/230 executor interface + veto filters, SRC-180 fast-submit/txlock).
 * A mockable `TransactionExecutor` sits behind the approval gates. A serialized
 * per-token queue enforces one in-flight tx per token; vetoes carry a reason
 * record; timed-out fills are marked failed and gated (no silent retry).
 */

export interface TransactionRequest {
  token: string;
  chainId: number;
  side: 'buy' | 'sell';
  amountUsd: number;
  timeoutMs?: number;
}

export type SubmitOutcome = 'confirmed' | 'failed' | 'timed_out';

export interface TransactionResult {
  outcome: SubmitOutcome;
  txHash?: string;
  reason?: string;
  at: number;
}

export interface TransactionExecutor {
  readonly id: string;
  submit(req: TransactionRequest): Promise<TransactionResult>;
}

export interface ExecutorVeto {
  vetoed: boolean;
  reason?: string;
}

export interface SerializedExecutorOptions {
  /** Consecutive failures allowed before the token is gated. Default 3. */
  maxConsecutiveFailures?: number;
}

/** Per-token serialization tail + consecutive-fail bookkeeping. */
class TokenSlot {
  private tail: Promise<unknown> = Promise.resolve();
  consecutiveFailures = 0;

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task);
    // Keep the chain alive on rejection so one failure blocks nothing after it.
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}

/**
 * Fail-closed executor facade: veto-with-reason, one in-flight tx per token,
 * a consecutive-fail gate, and timeout detection. `delegate` is the injectable
 * live/paper executor this facade serializes.
 */
export class SerializedExecutor {
  private slots = new Map<string, TokenSlot>();

  constructor(
    private readonly delegate: TransactionExecutor,
    private readonly veto: (req: TransactionRequest) => ExecutorVeto | Promise<ExecutorVeto>,
    private readonly opts: SerializedExecutorOptions = {}
  ) {}

  private slot(token: string): TokenSlot {
    let s = this.slots.get(token);
    if (!s) {
      s = new TokenSlot();
      this.slots.set(token, s);
    }
    return s;
  }

  private async submitSerialized(req: TransactionRequest, slot: TokenSlot): Promise<TransactionResult> {
    const maxFail = this.opts.maxConsecutiveFailures ?? 3;
    if (slot.consecutiveFailures >= maxFail) {
      return { outcome: 'failed', reason: `gated: ${slot.consecutiveFailures} consecutive failures`, at: Date.now() };
    }
    const v = await this.veto(req);
    if (v.vetoed) {
      return { outcome: 'failed', reason: v.reason ?? 'vetoed', at: Date.now() };
    }
    try {
      const res = await this.delegate.submit(req);
      if (res.outcome === 'failed' || res.outcome === 'timed_out') {
        slot.consecutiveFailures += 1;
      } else {
        slot.consecutiveFailures = 0;
      }
      return res;
    } catch {
      slot.consecutiveFailures += 1;
      return { outcome: 'failed', reason: 'delegate threw', at: Date.now() };
    }
  }

  /** Execute a fill under the per-token serialization + veto + fail gate. */
  async execute(req: TransactionRequest): Promise<TransactionResult> {
    const slot = this.slot(req.token);
    return slot.enqueue(() => this.submitSerialized(req, slot));
  }
}

/** Wrap an executor so a slow submission resolves to `timed_out` (no retry). */
export function withTimeout(executor: TransactionExecutor, defaultTimeoutMs = 10_000): TransactionExecutor {
  return {
    id: `timeout:${executor.id}`,
    async submit(req) {
      const timeoutMs = req.timeoutMs ?? defaultTimeoutMs;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      const result = await executor.submit(req);
      clearTimeout(timer);
      return timedOut
        ? { outcome: 'timed_out' as const, reason: 'submission exceeded timeout', at: Date.now() }
        : result;
    },
  };
}
