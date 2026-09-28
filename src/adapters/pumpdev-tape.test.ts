import { describe, it, expect, vi, afterEach } from 'vitest';
import { PumpDevTape, type PumpDevTapeEvent as PumpDevEvent } from './pumpdev-tape.js';

interface FakeWS {
  sent: string[];
  addEventListener: (type: string, cb: (ev?: unknown) => void) => void;
  emit: (type: string, payload?: unknown) => void;
  send: (d: string) => void;
  close: () => void;
  closedBy: () => boolean;
}

function makeFake(): FakeWS {
  const handlers = new Map<string, (ev?: unknown) => void>();
  let gotClose = false;
  const sent: string[] = [];
  const obj: FakeWS = {
    sent,
    addEventListener: (t, cb) => handlers.set(t, cb),
    emit: (t, payload) => handlers.get(t)?.(payload),
    send: (d) => sent.push(String(d)),
    close: () => {
      gotClose = true;
      handlers.get('close')?.();
    },
    closedBy: () => gotClose,
  };
  return obj;
}

let f: FakeWS;

function tapeWith(callbacks: { onEvent?: (e: PumpDevEvent) => void; onStatus?: (c: boolean) => void } = {}) {
  f = makeFake();
  const tape = new PumpDevTape({
    url: 'wss://pumpdev.io/ws',
    apiKey: 'KEY',
    createSocket: () => f as unknown as PumpDevSocketLike,
    onEvent: callbacks.onEvent,
    onStatusChange: callbacks.onStatus,
    reconnectBaseMs: 50,
    maxReconnectMs: 200,
  });
  return tape;
}

import type { PumpDevSocketLike } from './pumpdev-tape.js';

describe('PumpDevTape (WS transport)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('auths and subscribes to new tokens on open', () => {
    const tape = tapeWith();
    tape.start();
    f.emit('open');
    const sent = f.sent.map((s) => JSON.parse(s));
    expect(sent.some((m) => m.method === 'auth' && m.key === 'KEY')).toBe(true);
    expect(sent.some((m) => m.method === 'subscribeNewToken')).toBe(true);
    expect(tape.isConnected()).toBe(true);
  });

  it('records a create launch and emits onEvent; ignores control frames', () => {
    const events: PumpDevEvent[] = [];
    const tape = new PumpDevTape({
      url: 'wss://pumpdev.io/ws',
      createSocket: () => f as unknown as PumpDevSocketLike,
      onEvent: (e) => events.push(e),
    });
    tape.start();
    f.emit('open');
    f.emit('message', {
      data: JSON.stringify({ signature: 'x', mint: 'Mint1', traderPublicKey: 'Wallet1', txType: 'create', symbol: 'TKN' }),
    });
    // control frame must be filtered
    f.emit('message', { data: JSON.stringify({ type: 'connected', connected: true }) });
    expect(tape.recentLaunches()).toHaveLength(1);
    expect(tape.recentLaunches(1)[0]).toMatchObject({ mint: 'Mint1', symbol: 'TKN' });
    expect(events).toHaveLength(1);
    expect(tape.recentWalletTrades('Wallet1')).toHaveLength(1);
  });

  it('accepts a raw string frame and a MessageEvent-like data accessor', () => {
    const events: PumpDevEvent[] = [];
    const tape = new PumpDevTape({
      url: 'wss://pumpdev.io/ws',
      createSocket: () => f as unknown as PumpDevSocketLike,
      onEvent: (e) => events.push(e),
    });
    tape.start();
    f.emit('open');
    f.emit('message', '{"mint":"B","traderPublicKey":"W2","txType":"sell"}');
    f.emit('message', { data: { toString: () => '{"mint":"C","traderPublicKey":"W3","txType":"buy"}' } });
    expect(events).toHaveLength(2);
    expect(events[0]?.txType).toBe('sell');
  });

  it('token trade events land on the trader wallet (recall intel)', () => {
    const tape = new PumpDevTape({
      url: 'wss://pumpdev.io/ws',
      createSocket: () => f as unknown as PumpDevSocketLike,
    });
    tape.start();
    f.emit('open');
    f.emit('message', { data: JSON.stringify({ mint: 'M', traderPublicKey: 'WalLet', txType: 'buy', marketCapQuote: 5 }) });
    expect(tape.recentWalletTrades('wallet')).toHaveLength(1);
    expect(tape.recentWalletTrades('wallet')[0]?.marketCapQuote).toBe(5);
  });

  it('malformed frames never crash the handler', () => {
    const tape = new PumpDevTape({
      url: 'wss://pumpdev.io/ws',
      createSocket: () => f as unknown as PumpDevSocketLike,
    });
    tape.start();
    f.emit('open');
    expect(() => f.emit('message', 'not json')).not.toThrow();
    expect(() => f.emit('message', undefined)).not.toThrow();
    expect(tape.recentLaunches()).toHaveLength(0);
  });

  it('reconnects with backoff after close and re-auths', () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeWS[] = [];
      const tape = new PumpDevTape({
        url: 'wss://pumpdev.io/ws',
        apiKey: 'KEY',
        createSocket: () => {
          const s = makeFake();
          sockets.push(s);
          return s as unknown as PumpDevSocketLike;
        },
        reconnectBaseMs: 50,
        maxReconnectMs: 200,
      });
      tape.start();
      sockets[0]!.emit('open');
      expect(sockets[0]!.sent.map((s) => JSON.parse(s))[0]).toMatchObject({ method: 'auth' });
      // simulate a drop (server closes)
      sockets[0]!.close();
      expect(tape.isConnected()).toBe(false);
      vi.advanceTimersByTime(60);
      expect(sockets.length).toBe(2); // second socket created
      sockets[1]!.emit('open');
      f = sockets[1]!;
      expect(f.sent.map((s) => JSON.parse(s)).some((m) => m.method === 'auth' && m.key === 'KEY')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});