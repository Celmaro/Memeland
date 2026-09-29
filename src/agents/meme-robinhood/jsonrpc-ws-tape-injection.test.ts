import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ScreeningAgent } from './robinhood-screening-agent.js';
import { JsonRpcWsTape } from '../../adapters/jsonrpc-ws-tape.js';

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

describe('ScreeningAgent — own-tape (JsonRpcWsTape) → discovery injection', () => {
  beforeEach(() => {
    process.env.JSONRPC_WS_TAPE_ENABLED = 'true';
  });
  afterEach(() => {
    delete process.env.JSONRPC_WS_TAPE_ENABLED;
  });

  it('drains pump.fun mints from an injected Sol WS tape into candidates (dedup, sol-only)', async () => {
    const sock = mockSocket();
    const tape = new JsonRpcWsTape({
      url: 'wss://zan/sol',
      chain: 'sol',
      createSocket: () => sock as never,
    });
    tape.start();
    sock.onopen?.();
    // two notifications — same mint twice (must dedup into one candidate), plus one other mint
    const mk = (pubkey: string) =>
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'programNotification',
        params: { subscription: 1, result: { pubkey, account: { lamports: 1 } } },
      });
    sock.onmessage?.({ data: mk('MintA') });
    sock.onmessage?.({ data: mk('MintA') });
    sock.onmessage?.({ data: mk('MintB') });

    const agent = new ScreeningAgent();
    agent.injectJsonRpcWsTapes([tape]);
    const candidates = await agent.collectJsonRpcWsTapeCandidates('sol');
    const addrs = candidates.map((c) => c.address).sort();
    expect(addrs).toEqual(['MintA', 'MintB']);
    expect(candidates.every((c) => c.source === 'solana-rpc')).toBe(true);
    tape.stop();
  });

  it('yields nothing on non-Sol chains or when the tape gate is off', async () => {
    const sock = mockSocket();
    const tape = new JsonRpcWsTape({
      url: 'wss://zan/eth',
      chain: 'eth',
      createSocket: () => sock as never,
    });
    const agent = new ScreeningAgent();
    agent.injectJsonRpcWsTapes([tape]);
    // non-sol chain → no drain
    expect(await agent.collectJsonRpcWsTapeCandidates('eth')).toHaveLength(0);
    // gate off → no drain
    process.env.JSONRPC_WS_TAPE_ENABLED = 'false';
    expect(await agent.collectJsonRpcWsTapeCandidates('sol')).toHaveLength(0);
  });
});