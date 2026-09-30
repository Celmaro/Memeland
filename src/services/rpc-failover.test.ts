import { describe, it, expect } from 'vitest';
import { rpcCallWithFailover, type FailoverCallOptions } from './rpc-failover.js';

/** Ordered host sequence: returns hosts[i] for the i-th getActiveRPC call, then ''. */
function hostSeq(hosts: string[]): () => string {
  let i = 0;
  return () => (i < hosts.length ? hosts[i++]! : '');
}

/** Response-like stub. */
function okJson(body: unknown): { ok: true; json: () => Promise<unknown> } {
  return { ok: true, json: async () => body };
}
function err(status: number): { ok: false; json: () => Promise<unknown> } {
  return { ok: false, json: async () => ({}) };
}

function fetcherFor(perUrl: Record<string, unknown | 'HTTP_ERR'>) {
  return async (url: string): Promise<{ ok: boolean; json: () => Promise<unknown> }> => {
    const v = perUrl[url];
    if (v === 'HTTP_ERR') return err(500);
    return okJson(v);
  };
}

describe('rpcCallWithFailover (R1 failover round-trip + R4 chainId guard)', () => {
  it('rotates off a failing host and reports it (R1)', async () => {
    const reported: string[] = [];
    const opts: FailoverCallOptions = {
      getActiveRPC: hostSeq(['https://a.example', 'https://b.example']),
      fetcher: fetcherFor({ 'https://a.example': 'HTTP_ERR', 'https://b.example': { result: 'ok' } }),
      report: (_c, url) => reported.push(url),
    };
    const r = await rpcCallWithFailover('eth', 'eth_blockNumber', [], opts);
    expect(r).toEqual({ ok: true, result: 'ok' });
    expect(reported).toEqual(['https://a.example']); // failing host demoted
  });

  it('chainId guard (R4): a wrong-chain host is demoted and a correct one wins', async () => {
    const reported: string[] = [];
    // host A answers a WRONG chainId on the eth_chainId probe → demote + rotate.
    // host B answers the right chainId (0x1) and then the real eth_getCode result.
    const fetcher = async (url: string, init: { body: string }): Promise<{ ok: boolean; json: () => Promise<unknown> }> => {
      const body = JSON.parse(init.body) as { method?: string };
      if (body.method === 'eth_chainId') {
        return okJson({ result: url === 'https://right.example' ? '0x1' : '0x89' });
      }
      return okJson({ result: '0xdeadbeef' });
    };
    const opts: FailoverCallOptions = {
      getActiveRPC: hostSeq(['https://wrong.example', 'https://right.example']),
      fetcher: fetcher as never,
      report: (_c, url) => reported.push(url),
      expectedChainId: '0x1',
    };
    const r = await rpcCallWithFailover('eth', 'eth_getCode', ['0xabc'], opts);
    expect(r.ok).toBe(true);
    expect(r.result).toBe('0xdeadbeef');
    expect(reported).toEqual(['https://wrong.example']);
  });

  it('is fail-soft: returns { ok:false, error } when both hosts fail', async () => {
    const opts: FailoverCallOptions = {
      getActiveRPC: hostSeq(['https://a.example', 'https://b.example']),
      fetcher: fetcherFor({ 'https://a.example': 'HTTP_ERR', 'https://b.example': 'HTTP_ERR' }),
    };
    const r = await rpcCallWithFailover('bsc', 'eth_getLogs', [], opts);
    expect(r.ok).toBe(false);
    expect(r.error).toBeDefined();
  });

  it('is fail-soft: no host → { ok:false, error } without reporting', async () => {
    const reported: string[] = [];
    const opts: FailoverCallOptions = {
      getActiveRPC: () => '',
      report: (_c, url) => reported.push(url),
    };
    const r = await rpcCallWithFailover('rh', 'eth_chainId', [], opts);
    expect(r.ok).toBe(false);
    expect(reported).toEqual([]);
  });
});
