/**
 * Generic JSON-RPC-over-WebSocket realtime tape (provider-architecture v2).
 *
 * Houses a long-lived, push-based tape on any standard JSON-RPC WS endpoint
 * (e.g. ZAN / OnFinality / PublicNode / dRPC). It is the WS "housing" for the
 * transport layer: the same providers that back the HTTP RPC failover pool also
 * expose WS, and this adapter turns those into a realtime tape.
 *
 * Subscription model (chain-aware):
 * - EVM chains (eth/base/bsc/rh): `eth_subscribe` `newHeads` → a fresh-block
 *   tape. `params.result` is a block header object.
 * - Sol: `programSubscribe` to the pump.fun program → surfaces the pubkey of
 *   every account the program writes. For the `create` instruction the written
 *   account is the new token mint, so this is a pre-graduation introducer tape
 *   (same signal PumpDev streams, but over raw Sol WS — no key/credits).
 *
 * Fail-soft: never lets a socket error propagate; exponential-backoff reconnect,
 * re-auth via the JSON-RPC subscribe (idempotent), bounded ring buffer, injectable
 * socket + `now` for hermetic tests (exactly like `PumpDevTape`).
 */

export type JsonRpcWsChain = 'eth' | 'bsc' | 'base' | 'rh' | 'sol';

export interface JsonRpcWsTapeEvent {
  chain: JsonRpcWsChain;
  /** EVM: block number (hex). Sol: written-account pubkey (candidate mint). */
  id?: string;
  /** EVM: block hash. */
  hash?: string;
  /** EVM: unix seconds. */
  timestamp?: number;
  /** Sol: raw program notification (best-effort decode skipped → stored raw). */
  raw?: unknown;
  [k: string]: unknown;
}

export interface JsonRpcWsTapeOptions {
  /** Full WS URL (e.g. ZAN/OnFinality wss endpoint). */
  url: string;
  chain: JsonRpcWsChain;
  /** Optional key appended as an `auth` message for providers that require it. */
  apiKey?: string;
  /** Called for every market/tape event (control/subscription acks filtered). */
  onEvent?: (e: JsonRpcWsTapeEvent) => void;
  /** Called when the socket connects/disconnects. */
  onStatusChange?: (connected: boolean) => void;
  /** Sol: pump.fun program id for `programSubscribe`. Overridable via env. */
  pumpFunProgram?: string;
  /** Bound on the recent-event ring buffer. */
  maxEvents?: number;
  reconnectBaseMs?: number;
  maxReconnectMs?: number;
  /** Injectable socket factory (hermetic tests). */
  createSocket?: (url: string) => PumpDevSocketLike;
  now?: () => number;
}

export interface PumpDevSocketLike {
  addEventListener?(type: string, cb: (ev?: unknown) => void): void;
  on?(type: string, cb: (ev?: unknown) => void): void;
  send(data: string): void;
  close(): void;
  onopen?: (() => void) | null;
  onmessage?: ((ev?: unknown) => void) | null;
  onclose?: (() => void) | null;
  onerror?: (() => void) | null;
}

export const DEFAULT_PUMP_FUN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

export const CHAIN_TO_NETWORK: Record<JsonRpcWsChain, string> = {
  eth: 'eth',
  bsc: 'bsc',
  base: 'base',
  rh: 'robinhood',
  sol: 'solana',
};

function readMessageData(ev?: unknown): string {
  if (typeof ev === 'string') return ev;
  const data = (ev as { data?: unknown })?.data;
  if (typeof data === 'string') return data;
  return '';
}

export class JsonRpcWsTape {
  private readonly url: string;
  private readonly chain: JsonRpcWsChain;
  private readonly apiKey?: string;
  private readonly onEvent?: (e: JsonRpcWsTapeEvent) => void;
  private readonly onStatusChange?: (connected: boolean) => void;
  private readonly pumpFunProgram: string;
  private readonly maxEvents: number;
  private readonly reconnectBaseMs: number;
  private readonly maxReconnectMs: number;
  private readonly createSocket: (url: string) => PumpDevSocketLike;
  private readonly now: () => number;

  private socket: PumpDevSocketLike | null = null;
  private connected = false;
  private closed = true;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private subId: unknown = null;

  /** Recent events (newest-first), bounded at `maxEvents`. */
  private events: JsonRpcWsTapeEvent[] = [];

  constructor(opts: JsonRpcWsTapeOptions) {
    this.url = opts.url;
    this.chain = opts.chain;
    this.apiKey = opts.apiKey;
    this.onEvent = opts.onEvent;
    this.onStatusChange = opts.onStatusChange;
    this.pumpFunProgram = opts.pumpFunProgram ?? DEFAULT_PUMP_FUN_PROGRAM;
    this.maxEvents = opts.maxEvents ?? 1_000;
    this.reconnectBaseMs = opts.reconnectBaseMs ?? 1_000;
    this.maxReconnectMs = opts.maxReconnectMs ?? 30_000;
    this.now = opts.now ?? (() => Date.now());
    this.createSocket =
      opts.createSocket ?? ((url) => new WebSocket(url) as unknown as PumpDevSocketLike);
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public isClosed(): boolean {
    return this.closed;
  }

  /** Bound recent tape events (read-only view of current activity). */
  public recentEvents(limit = 50): JsonRpcWsTapeEvent[] {
    return this.events.slice(0, Math.max(0, limit));
  }

  public start(): void {
    if (this.socket) return;
    this.closed = false;
    this.open();
  }

  public stop(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        /* fail-soft */
      }
      this.socket = null;
    }
    this.setConnected(false);
  }

  // ---- internals ----

  private open(): void {
    if (this.closed) return;
    let socket: PumpDevSocketLike;
    try {
      socket = this.createSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    const onOpen = () => {
      if (this.closed) return;
      this.reconnectAttempt = 0;
      this.subId = null;
      this.setConnected(true);
      if (this.apiKey) this.sendFrame({ jsonrpc: '2.0', id: 'auth', method: 'auth', params: [this.apiKey] });
      this.subscribe();
    };
    const onMessage = (ev?: unknown) => {
      this.handleFrame(readMessageData(ev));
    };
    const onClose = () => {
      this.socket = null;
      this.setConnected(false);
      this.scheduleReconnect();
    };
    const onError = () => {
      try {
        socket.close();
      } catch {
        /* noop */
      }
    };

    if (typeof socket.addEventListener === 'function') {
      socket.addEventListener('open', onOpen);
      socket.addEventListener('message', onMessage);
      socket.addEventListener('close', onClose);
      socket.addEventListener('error', onError);
    } else if (socket.on) {
      socket.on('open', onOpen);
      socket.on('message', onMessage);
      socket.on('close', onClose);
      socket.on('error', onError);
    } else {
      socket.onopen = onOpen;
      socket.onmessage = onMessage;
      socket.onclose = onClose;
      socket.onerror = onError;
    }
  }

  private subscribe(): void {
    if (this.chain === 'sol') {
      this.sendFrame({
        jsonrpc: '2.0',
        id: 'sub-program',
        method: 'programSubscribe',
        params: [this.pumpFunProgram, { encoding: 'base64', commitment: 'finalized' }],
      });
    } else {
      this.sendFrame({ jsonrpc: '2.0', id: 'sub-newHeads', method: 'eth_subscribe', params: ['newHeads'] });
    }
  }

  private sendFrame(obj: Record<string, unknown>): void {
    if (!this.socket) return;
    try {
      this.socket.send(JSON.stringify(obj));
    } catch {
      /* fail-soft */
    }
  }

  private handleFrame(raw: string): void {
    if (!raw) return;
    let msg: { method?: string; params?: { result?: unknown; subscription?: unknown } };
    try {
      msg = JSON.parse(raw) as typeof msg;
    } catch {
      return; // malformed frame — never crash
    }
    // Subscription ACK (id === our sub request) → remember subId, no event.
    if (msg && !msg.method && (msg as { result?: unknown }).result !== undefined) {
      const res = (msg as { result?: unknown }).result;
      if (typeof res === 'string' || typeof res === 'number') this.subId = res;
      return;
    }
    const params = msg?.params;
    const result = params?.result;
    if (result === undefined || result === null) return; // control/ack
    const evt = this.parseEvent(result);
    if (!evt) return;
    this.events.unshift(evt);
    if (this.events.length > this.maxEvents) this.events.length = this.maxEvents;
    this.onEvent?.(evt);
  }

  private parseEvent(result: unknown): JsonRpcWsTapeEvent | null {
    if (this.chain === 'sol') {
      // programSubscribe notification: { pubkey, account: { ... } } | { account, pubkey }
      const r = result as { pubkey?: unknown; account?: { pubkey?: unknown } };
      const mint = typeof r.pubkey === 'string' ? r.pubkey : (typeof r.account?.pubkey === 'string' ? r.account.pubkey : undefined);
      if (!mint) return null;
      return { chain: 'sol', id: mint, raw: result };
    }
    // EVM newHeads: { number, hash, timestamp, ... }
    const r = result as { number?: unknown; hash?: unknown; timestamp?: unknown };
    if (r.number === undefined && r.hash === undefined) return null;
    return {
      chain: this.chain,
      id: typeof r.number === 'string' ? r.number : String(r.number ?? ''),
      hash: typeof r.hash === 'string' ? r.hash : undefined,
      timestamp: typeof r.timestamp === 'number' ? r.timestamp : undefined,
    };
  }

  private setConnected(c: boolean): void {
    if (this.connected === c) return;
    this.connected = c;
    this.onStatusChange?.(c);
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const delay = Math.min(this.reconnectBaseMs * 2 ** this.reconnectAttempt, this.maxReconnectMs);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }
}
