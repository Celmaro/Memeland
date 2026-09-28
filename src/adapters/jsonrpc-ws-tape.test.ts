import { describe, it, expect, vi } from 'vitest';
import { JsonRpcWsTape, DEFAULT_PUMP_FUN_PROGRAM } from './jsonrpc-ws-tape.js';

interface MockSocket {
  onopen: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  sent: string[];
  closed: boolean;
  send(data: string): void;
  close(): void;
}

function mockSocket(): MockSocket {
  return {
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    sent: [],
    closed: false,
    send(data: string) {
      this.sent.push(data);
    },
    close() {
      this.closed = true;
    },
  };
}

function connect(tape: JsonRpcWsTape, sock: MockSocket): void {
  sock.onopen?.();
}

describe('JsonRpcWsTape', () => {
  it('subscribes newHeads for EVM chains and emits block events', () => {
    const sock = mockSocket();
    const events: unknown[] = [];
    const tape = new JsonRpcWsTape({
      url: 'wss://zan/eth',
      chain: 'eth',
      createSocket: () => sock as never,
      onEvent: (e) => events.push(e),
    });
    tape.start();
    connect(tape, sock);
    expect(JSON.parse(sock.sent[0])).toMatchObject({ method: 'eth_subscribe', params: ['newHeads'] });
    // subscription ack
    sock.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: 'sub-newHeads', result: '0x1' }) });
    expect(events).toHaveLength(0); // ack is not an event
    // block notification
    sock.onmessage?.({
      data: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_subscription',
        params: { subscription: '0x1', result: { number: '0x10', hash: '0xabc', timestamp: 1700000000 } },
      }),
    });
    expect(events[0]).toMatchObject({ chain: 'eth', id: '0x10', hash: '0xabc', timestamp: 1700000000 });
    expect(tape.recentEvents(1)).toHaveLength(1);
    tape.stop();
    expect(sock.closed).toBe(true);
  });

  it('subscribes pump.fun program for Sol and surfaces written-account mints', () => {
    const sock = mockSocket();
    const events: unknown[] = [];
    const tape = new JsonRpcWsTape({
      url: 'wss://zan/sol',
      chain: 'sol',
      createSocket: () => sock as never,
      onEvent: (e) => events.push(e),
    });
    tape.start();
    connect(tape, sock);
    const sub = JSON.parse(sock.sent[0]);
    expect(sub).toMatchObject({ method: 'programSubscribe' });
    expect(sub.params[0]).toBe(DEFAULT_PUMP_FUN_PROGRAM);
    sock.onmessage?.({
      data: JSON.stringify({
        jsonrpc: '2.0',
        method: 'programNotification',
        params: { subscription: 1, result: { pubkey: 'NewMint111111111111111111111111', account: { lamports: 1 } } },
      }),
    });
    expect(events[0]).toMatchObject({ chain: 'sol', id: 'NewMint111111111111111111111111' });
    tape.stop();
  });

  it('reconnects with backoff after an unexpected close', async () => {
    let sockets: MockSocket[] = [];
    const tape = new JsonRpcWsTape({
      url: 'wss://onfinality/base',
      chain: 'base',
      reconnectBaseMs: 5,
      maxReconnectMs: 20,
      now: () => 0,
      createSocket: () => {
        const s = mockSocket();
        sockets.push(s);
        return s as never;
      },
    });
    tape.start();
    sockets[0].onopen?.();
    sockets[0].onclose?.(); // drops
    await new Promise((r) => setTimeout(r, 15)); // let the 5ms reconnect fire
    expect(sockets.length).toBeGreaterThanOrEqual(2); // reconnected
    tape.stop();
  });
});
