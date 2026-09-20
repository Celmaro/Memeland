/**
 * rh-execution-core.ts
 *
 * Robinhood-Chain (EVM 4663) execution-core module — a deterministic,
 * zero-dependency port of SRC-180 robinhood-lp-bot concepts:
 *   - per-token transaction serializer (TxLock)
 *   - fast-submit to the RH sequencer (FastSubmitter)
 *   - Arbitrum-Nitro broadcast-feed tape reader (NitroFeedReader)
 *   - Quoter honeypot sellability check (assessSellability)
 *
 * ALL network access is injected via transports / call interfaces. This module
 * never opens a socket, never issues an RPC, and never constructs a provider.
 * Every function is pure + testable. Fail-closed by design: an error, a missing
 * receipt, or an empty quote is NEVER interpreted as success.
 */

/** A single normalized entry inside a Nitro broadcast-feed batch. */
export type NitroBatchItem = {
  txHash: string;
  tokenAddress: string | null;
  kind: 'buy' | 'sell' | 'unknown';
  amountUsd?: number;
  at: number;
};

/** A parsed Arbitrum-Nitro broadcast-feed message (one JSON line). */
export interface NitroFeedMessage {
  feedSequence: number;
  batchItems: Array<NitroBatchItem>;
}

/**
 * Global per-token transaction serializer. Concurrent acquires on the SAME
 * token queue up and run one at a time (FIFO); acquires on different tokens
 * never block each other. Fail-closed: a lock is only ever granted to one
 * caller at a time per token.
 */
export class TxLock {
  private readonly inflight = new Map<string, boolean>();
  private readonly queues = new Map<string, Array<() => void>>();

  /**
   * Acquire the per-token lock. Resolves to a release function once this
   * caller holds the lock. If another caller holds the token's lock, this
   * resolves only after that lock (and any earlier queued callers) release.
   */
  async acquire(tokenAddress: string): Promise<() => void> {
    if (!this.inflight.get(tokenAddress)) {
      this.inflight.set(tokenAddress, true);
      return this.buildRelease(tokenAddress);
    }
    return new Promise((resolve) => {
      const queue = this.queues.get(tokenAddress) ?? [];
      queue.push(() => resolve(this.buildRelease(tokenAddress)));
      this.queues.set(tokenAddress, queue);
    });
  }

  /** Number of locks currently held for a token: always 0 or 1. */
  inflightCount(tokenAddress: string): number {
    return this.inflight.get(tokenAddress) ? 1 : 0;
  }

  private buildRelease(tokenAddress: string): () => void {
    let released = false;
    return () => {
      if (released) return; // idempotent release: never double-grant
      released = true;
      const queue = this.queues.get(tokenAddress) ?? [];
      const next = queue.shift();
      if (next) {
        // hand the lock to the next queued caller (FIFO) without releasing it
        if (queue.length === 0) this.queues.delete(tokenAddress);
        else this.queues.set(tokenAddress, queue);
        next();
      } else {
        this.queues.delete(tokenAddress);
        this.inflight.delete(tokenAddress);
      }
    };
  }
}

/** A transport capable of submitting a raw signed transaction to the sequencer. */
export interface FastSubmitTransport {
  sendRawTransaction(rawTx: string): Promise<{ ok: boolean; txHash?: string; error?: string }>;
}

/**
 * Wraps a fast-submit transport. Fail-closed: if the transport throws, or
 * reports ok:true without a txHash (no receipt-verified ownership), the result
 * is ok:false. We never credit a submission without a real transaction hash.
 */
export class FastSubmitter {
  constructor(private readonly transport: FastSubmitTransport) {}

  async submit(rawTx: string): Promise<{ ok: boolean; txHash?: string; error?: string }> {
    try {
      const res = await this.transport.sendRawTransaction(rawTx);
      if (!res || res.ok !== true) {
        return { ok: false, error: res?.error ?? 'sequencer rejected raw transaction' };
      }
      if (!res.txHash) {
        // ok:true with no hash => ownership cannot be proven; fail-closed.
        return { ok: false, error: 'sequencer returned ok without txHash — cannot credit' };
      }
      return { ok: true, txHash: res.txHash };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

function normalizeNitroItem(raw: unknown): NitroBatchItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const it = raw as Record<string, unknown>;
  if (typeof it.txHash !== 'string' || it.txHash.length === 0) return null;

  let tokenAddress: string | null = null;
  if (typeof it.tokenAddress === 'string' && it.tokenAddress.length > 0) {
    tokenAddress = it.tokenAddress;
  }

  let kind: NitroBatchItem['kind'] = 'unknown';
  if (it.kind === 'buy') kind = 'buy';
  else if (it.kind === 'sell') kind = 'sell';

  const amountUsd =
    typeof it.amountUsd === 'number' && Number.isFinite(it.amountUsd) ? it.amountUsd : undefined;
  const at = typeof it.at === 'number' && Number.isFinite(it.at) ? it.at : 0;

  return { txHash: it.txHash, tokenAddress, kind, amountUsd, at };
}

/**
 * Parse one Arbitrum-Nitro broadcast-feed JSON line (RH Nitro feed
 * `wss://feed.mainnet.chain.robinhood.com/feed`, header
 * `Arbitrum-Feed-Client-Version: 2`). Unknown/extra fields are tolerated and
 * malformed fields are normalized; the line never throws. When filterToken is
 * given, returns null unless the message contains at least one matching item.
 * Returns null for unparseable input.
 */
export function parseNitroFeedLine(line: string, filterToken?: string | null): NitroFeedMessage | null {
  if (typeof line !== 'string') return null;
  const trimmed = line.trim();
  if (!trimmed) return null;

  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

  const rec = obj as Record<string, unknown>;
  const feedSequence = rec.feedSequence;
  if (typeof feedSequence !== 'number' || !Number.isFinite(feedSequence)) return null;

  const rawItems = rec.batchItems;
  if (!Array.isArray(rawItems)) return null;

  const batchItems: NitroBatchItem[] = [];
  for (const raw of rawItems) {
    const item = normalizeNitroItem(raw);
    if (item !== null) batchItems.push(item);
  }
  if (batchItems.length === 0) return null;

  if (filterToken != null && filterToken.length > 0) {
    if (!batchItems.some((item) => item.tokenAddress === filterToken)) return null;
  }

  return { feedSequence, batchItems };
}

/** Injected source of raw feed lines. onLine must return an unsubscribe fn. */
export interface NitroFeedLineTransport {
  onLine(cb: (line: string) => void): () => void;
}

/**
 * Pull iterator over parsed + filtered Nitro feed messages. Lines are pushed
 * into an internal queue by the injected transport; `next()` pulls the next
 * matching message or null when none remain / the stream has ended.
 */
export class NitroFeedReader {
  constructor(private readonly transport: NitroFeedLineTransport) {}

  subscribe(filterToken: string | null): {
    next: () => Promise<NitroFeedMessage | null>;
    stop: () => void;
  } {
    const queue: NitroFeedMessage[] = [];
    let stopped = false;

    const onLine = (line: string) => {
      if (stopped) return;
      const msg = parseNitroFeedLine(line, filterToken);
      if (msg !== null) queue.push(msg);
    };

    const off = this.transport.onLine(onLine);

    const next = async (): Promise<NitroFeedMessage | null> => {
      if (queue.length > 0) return queue.shift() as NitroFeedMessage;
      return null; // no more matching lines available right now
    };

    const stop = () => {
      if (stopped) return;
      stopped = true;
      off();
      queue.length = 0; // no further delivery after stop
    };

    return { next, stop };
  }
}

/** Injected eth_call provider for the Quoter honeypot check. */
export interface QuoterCall {
  callContract(payload: string): Promise<{ ok: boolean; output?: string }>;
}

/**
 * Quoter honeypot: invoke `quoteExactInputSingle` via the injected eth_call.
 * Only a successful call that returns a non-empty output proves real
 * on-chain liquidity / sellability (EVM 4663). Anything else — a failed call,
 * an empty output, or a thrown error — is treated as NOT sellable (fail-closed).
 */
export async function assessSellability(
  call: QuoterCall,
  quotePayload: string,
): Promise<{ sellable: boolean; reason: string }> {
  let res: { ok: boolean; output?: string };
  try {
    res = await call.callContract(quotePayload);
  } catch {
    return { sellable: false, reason: 'cannot sell — fail-closed' };
  }
  if (res && res.ok === true && typeof res.output === 'string' && res.output.length > 0) {
    return { sellable: true, reason: 'confirmed on-chain liquidity' };
  }
  return { sellable: false, reason: 'cannot sell — fail-closed' };
}

export interface ExecutionSubmitMeta {
  /** Per-token identity used to serialize concurrent submits for the same token. */
  tokenAddress?: string;
  tokenSymbol?: string;
}

export interface ExecutionSubmitResult {
  ok: boolean;
  txHash?: string;
  error?: string;
}

/**
 * PR12.e (SRC-227/230 warp-id solana-trading-bot): the TransactionExecutor
 * interface. Every execution path depends on this abstraction rather than a
 * concrete submitter, so transports can be swapped/mocked behind one seam.
 */
export interface TransactionExecutor {
  submit(rawTx: string, meta?: ExecutionSubmitMeta): Promise<ExecutionSubmitResult>;
}

/**
 * PR12.e: a TransactionExecutor decorator that serializes submissions per
 * token via TxLock (one in-flight submit per token) and turns any throw into a
 * fail-closed `ok:false` result. Without a tokenAddress it passes straight
 * through. This makes concurrent callers impossible to double-fire on one token.
 */
export class TxLockedExecutor implements TransactionExecutor {
  constructor(
    private readonly base: TransactionExecutor,
    private readonly lock: TxLock = new TxLock(),
  ) {}

  async submit(rawTx: string, meta?: ExecutionSubmitMeta): Promise<ExecutionSubmitResult> {
    const tokenAddress = meta?.tokenAddress;
    if (!tokenAddress || tokenAddress.length === 0) {
      return this.invoke(rawTx, meta);
    }
    const release = await this.lock.acquire(tokenAddress);
    try {
      return await this.invoke(rawTx, meta);
    } finally {
      release();
    }
  }

  private async invoke(rawTx: string, meta?: ExecutionSubmitMeta): Promise<ExecutionSubmitResult> {
    try {
      return await this.base.submit(rawTx, meta);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

/**
 * PR12.e: builds a TransactionExecutor that composes ingestion with veto-with-
 * reason. A `veto` returning a reason string blocks the submit, fail-closed.
 */
export function vetoingExecutor(
  inner: TransactionExecutor,
  veto: (rawTx: string, meta?: ExecutionSubmitMeta) => string | null,
): TransactionExecutor {
  return {
    async submit(rawTx, meta) {
      let reason: string | null = null;
      try {
        reason = veto(rawTx, meta);
      } catch {
        reason = 'veto check threw — fail-closed';
      }
      if (reason) return { ok: false, error: `vetoed: ${reason}` };
      return inner.submit(rawTx, meta);
    },
  };
}
