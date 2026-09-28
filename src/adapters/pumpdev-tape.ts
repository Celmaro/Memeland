/**
 * PumpDev real-time WebSocket tape (provider-architecture v2: `pumpdev`).
 *
 * A long-lived, push-based transport for pump.fun / PumpSwap market events. Per
 * the research doc this is a TAPE / entropy layer and a **Sol pre-graduation
 * introducer**: `subscribeNewToken` surfaces the raw mint of every new pump.fun
 * launch (fresh-lane; still on the bonding curve), `subscribeTokenTrade` streams
 * buy/sell/migration ticks for tracked mints, and `subscribeAccountTrade`
 * streams whale/copy-trade wallet activity (recall intel).
 *
 * Free tier with a key: 25 live subscriptions, 50k trade msgs/mo; launches are
 * ALWAYS free. We keep a bounded ring buffer of recent launches + wallet trades
 * (drained on demand) and never let a socket error propagate — fail-soft with
 * exponential-backoff reconnect + per-connection re-auth, exactly as PumpDev
 * requires.
 *
 * The socket is injectable so tests can drive connect/auth/event/reconnect
 * without a live WS. Defaults to the global `WebSocket` (Node ≥22 undici).
 */

export interface PumpDevTapeEvent {
  signature?: string;
  mint?: string;
  traderPublicKey?: string;
  txType?: string;
  name?: string;
  symbol?: string;
  marketCapQuote?: number;
  quoteMint?: string;
  issuer?: string;
  [k: string]: unknown;
}

export interface PumpDevTapeOptions {
  /** Full WS URL, key embedded via query param or sent as an `auth` frame. */
  url: string;
  /** Optional API key sent via the `auth` message (preferred over URL key). */
  apiKey?: string;
  /** Called for every market event (control frames are filtered out). */
  onEvent?: (e: PumpDevTapeEvent) => void;
  /** Called when the socket connects/disconnects (with the new state). */
  onStatusChange?: (connected: boolean) => void;
  /** Max launches retained in the recent-launch ring. Default 1000. */
  maxLaunches?: number;
  /** Max wallet-trade events retained per tracked wallet. Default 200. */
  maxWalletTrades?: number;
  reconnectBaseMs?: number;
  maxReconnectMs?: number;
  /** Factory override for tests. Default: `(url) => new WebSocket(url)`. */
  createSocket?: (url: string) => PumpDevSocketLike;
  /** Control-message flood guard: max control frames written per 10s. */
  maxControlPer10s?: number;
  now?: () => number;
}

/** Minimal socket surface shared by undici WebSocket and test fakes. */
export interface PumpDevSocketLike {
  readyState?: number;
  addEventListener?(type: string, cb: (ev?: unknown) => void): void;
  on?(type: string, cb: (payload?: unknown) => void): void;
  send(data: string): void;
  close(): void;
  // optional on* handlers for hermetic test doubles
  onopen?: (() => void) | null;
  onmessage?: ((ev?: unknown) => void) | null;
  onclose?: (() => void) | null;
  onerror?: (() => void) | null;
}

export const DEFAULT_PUMPDEV_WS = 'wss://pumpdev.io/ws';

export class PumpDevTape {
  private readonly url: string;
  private readonly apiKey?: string;
  private readonly onEvent?: (e: PumpDevTapeEvent) => void;
  private readonly onStatusChange?: (connected: boolean) => void;
  private readonly maxLaunches: number;
  private readonly maxWalletTrades: number;
  private readonly reconnectBaseMs: number;
  private readonly maxReconnectMs: number;
  private readonly createSocket: (url: string) => PumpDevSocketLike;
  private readonly maxControlPer10s: number;
  private readonly now: () => number;

  private socket: PumpDevSocketLike | null = null;
  private connected = false;
  private closed = true;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** Recent launches (newest-first) — the tap / pre-graduation introducer. */
  private launches: PumpDevTapeEvent[] = [];
  /** Recent wallet trades keyed by wallet — recall intel. */
  private walletTrades = new Map<string, PumpDevTapeEvent[]>();
  /** Control-message flood guard (per 10s window). */
  private controlWindow = { start: 0, count: 0 };

  constructor(opts: PumpDevTapeOptions) {
    this.url = opts.url || DEFAULT_PUMPDEV_WS;
    this.apiKey = opts.apiKey;
    this.onEvent = opts.onEvent;
    this.onStatusChange = opts.onStatusChange;
    this.maxLaunches = opts.maxLaunches ?? 1_000;
    this.maxWalletTrades = opts.maxWalletTrades ?? 200;
    this.reconnectBaseMs = opts.reconnectBaseMs ?? 1_000;
    this.maxReconnectMs = opts.maxReconnectMs ?? 30_000;
    this.maxControlPer10s = opts.maxControlPer10s ?? 40;
    this.now = opts.now ?? (() => Date.now());
    this.createSocket = opts.createSocket ?? ((url) => new WebSocket(url) as unknown as PumpDevSocketLike);
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public isClosed(): boolean {
    return this.closed;
  }

  /** Bound the recent-launch buffer (for a READ of current activity). */
  public recentLaunches(limit = 20): PumpDevTapeEvent[] {
    return this.launches.slice(0, Math.max(0, limit));
  }

  /** Bound recent wallet trade events for a wallet (recall intel). */
  public recentWalletTrades(wallet: string, limit = 20): PumpDevTapeEvent[] {
    return (this.walletTrades.get(String(wallet).toLowerCase()) ?? []).slice(0, Math.max(0, limit));
  }

  public start(): void {
    if (this.socket) return; // already running
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
      this.setConnected(true);
      this.sendControl({ method: 'auth', key: this.apiKey ?? '' });
      this.sendControl({ method: 'subscribeNewToken' });
    };
    const onMessage = (ev?: unknown) => {
      const raw = readMessageData(ev);
      this.handleFrame(raw);
    };
    const onClose = () => {
      this.socket = null;
      this.setConnected(false);
      this.scheduleReconnect();
    };
    const onError = () => {
      // close() follows on most stacks; if not, force reconnect.
      try {
        socket.close();
      } catch {
        /* noop */
      }
    };

    if (typeof socket.addEventListener === 'function') {
      socket.addEventListener('open', onOpen);
      socket.addEventListener('message', onMessage as (ev: unknown) => void);
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

  private handleFrame(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let msg: PumpDevTapeEvent;
    try {
      msg = JSON.parse(raw) as PumpDevTapeEvent;
    } catch {
      return; // malformed frame — never crash
    }
    // Control frames carry `type`. Filter them (auth/subscribed/connected/etc).
    if (typeof msg.type === 'string') return;
    // Market event → record + sink.
    this.record(msg);
    this.onEvent?.(msg);
  }

  private record(ev: PumpDevTapeEvent): void {
    const mint = typeof ev.mint === 'string' ? ev.mint : '';
    if (ev.txType === 'create') {
      this.launches.unshift(ev);
      if (this.launches.length > this.maxLaunches) this.launches.pop();
    }
    if (mint || typeof ev.traderPublicKey === 'string') {
      const wallet = typeof ev.traderPublicKey === 'string' ? ev.traderPublicKey.toLowerCase() : '';
      if (wallet) {
        const arr = this.walletTrades.get(wallet) ?? [];
        arr.unshift(ev);
        if (arr.length > this.maxWalletTrades) arr.pop();
        this.walletTrades.set(wallet, arr);
      }
    }
  }

  private sendControl(msg: Record<string, unknown>): void {
    const now = this.now();
    if (now - this.controlWindow.start >= 10_000) {
      this.controlWindow = { start: now, count: 0 };
    }
    if (this.controlWindow.count >= this.maxControlPer10s) return; // flood guard
    this.controlWindow.count += 1;
    if (!this.socket) return;
    try {
      this.socket.send(JSON.stringify(msg));
    } catch {
      /* fail-soft: ignore send errors */
    }
  }

  private setConnected(v: boolean): void {
    if (this.connected === v) return;
    this.connected = v;
    try {
      this.onStatusChange?.(v);
    } catch {
      /* fail-soft */
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const attempt = this.reconnectAttempt;
    this.reconnectAttempt += 1;
    const delay = Math.min(this.reconnectBaseMs * 2 ** attempt, this.maxReconnectMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
    this.reconnectTimer.unref?.();
  }
}

function readMessageData(ev?: unknown): unknown {
  if (!ev) return undefined;
  if (typeof ev === 'string') return ev;
  const o = ev as Record<string, unknown>;
  // undici MessageEvent → ev.data
  const d = (o.data ?? o) as unknown;
  if (typeof d === 'string') return d;
  if (d && typeof d === 'object' && 'toString' in (d as object)) {
    try {
      return String(d);
    } catch {
      return undefined;
    }
  }
  return undefined;
}