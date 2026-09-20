import { describe, it, expect } from 'vitest';
import { EvmAdapter, type RpcTransport, type RpcHost } from '../src/adapters/evm-adapter.js';

function okTransport(hosts: string[]): RpcTransport {
  return {
    async request(host: string) {
      return { ok: true, result: { host, calls: 1 } };
    },
  };
}

describe('EvmAdapter two-lane RPC (PR 2 / Kernel E — RABIQ + Stampede)', () => {
  it('call returns the transport result and records per-host health', async () => {
    const hosts: RpcHost[] = [{ url: 'http://a', rotationWeight: 1 }];
    const dl = new EvmAdapter({ hosts, transport: okTransport(hosts.map((h) => h.url)) });
    const r = await dl.call({ to: '0x0', data: '0x', chain: 'robinhood' });
    expect(r.ok).toBe(true);
    const health = dl.getHealth();
    expect(health).toHaveLength(1);
    expect(typeof health[0]!.latencyMs).toBe('number');
    expect(health[0]!.errors).toBe(0);
  });

  it('read lane throttles independently of the submit lane (two-lane)', async () => {
    let t = 0;
    const hosts: RpcHost[] = [{ url: 'http://a', rotationWeight: 1 }];
    const calls: string[] = [];
    const transport: RpcTransport = {
      async request(host, method) {
        calls.push(method);
        return { ok: true, result: '0x1' };
      },
    };
    // capacity 2, no refill -> read lane dries after 2 calls, submit lane stays usable.
    const dl = new EvmAdapter({
      hosts,
      transport,
      now: () => t,
      laneTokensPerSec: 0,
      readLaneCapacity: 2,
      submitLaneCapacity: 2,
    });
    expect((await dl.call({ to: '0x0', data: '0x', chain: 'robinhood' })).ok).toBe(true);
    expect((await dl.call({ to: '0x0', data: '0x', chain: 'robinhood' })).ok).toBe(true);
    const third = await dl.call({ to: '0x0', data: '0x', chain: 'robinhood' });
    expect(third.ok).toBe(false); // read lane dry
    const submit = await dl.sendRawTx({ chain: 'robinhood', raw: '0xraw' });
    expect(submit.ok).toBe(true); // submit lane unaffected
  });

  it('fails over to a healthy host and applies cooldown to the failed one', async () => {
    const hosts: RpcHost[] = [
      { url: 'http://a', rotationWeight: 1 },
      { url: 'http://b', rotationWeight: 1 },
    ];
    const transport: RpcTransport = {
      async request(host) {
        if (host === 'http://a') return { ok: false, error: 'boom' };
        return { ok: true, result: { served: 'b' } };
      },
    };
    const dl = new EvmAdapter({ hosts, transport, cooldownMs: 60_000 });
    // first call hits a (fails) -> a cools down; second call rotates to b.
    const first = await dl.call({ to: '0x0', data: '0x', chain: 'robinhood' });
    expect(first.ok).toBe(false);
    const second = await dl.call({ to: '0x0', data: '0x', chain: 'robinhood' });
    expect(second.ok).toBe(true);
    const health = dl.getHealth();
    const ha = health.find((h) => h.host === 'http://a')!;
    expect(ha.errors).toBeGreaterThan(0);
    expect(ha.cooldownMs).toBeGreaterThan(0);
  });

  it('callLegacy throws the adapter error (G2 deprecation shim)', async () => {
    const hosts: RpcHost[] = [{ url: 'http://a', rotationWeight: 1 }];
    const transport: RpcTransport = {
      async request() {
        return { ok: false, error: 'downstream down' };
      },
    };
    const dl = new EvmAdapter({ hosts, transport });
    await expect(dl.callLegacy({ to: '0x0', data: '0x', chain: 'robinhood' })).rejects.toThrow('downstream down');
  });

  it('overrideSize clamps a model-returned over-max size', async () => {
    const hosts: RpcHost[] = [{ url: 'http://a', rotationWeight: 1 }];
    const dl = new EvmAdapter({ hosts, transport: okTransport(['http://a']) });
    const r = dl.overrideSize(5, 2);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(2);
  });
});
