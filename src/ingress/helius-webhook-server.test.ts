import { describe, it, expect, vi } from 'vitest';
import { createHeliusIngressHandler, type IngressWriter } from './helius-webhook-server.js';

const SECRET = 'test-secret';

/** Fake response capturing status + body. */
function fakeRes() {
  const res = {
    statusCode: 0,
    body: '',
    end: vi.fn((data?: unknown) => {
      res.body = String(data ?? '');
      return res as never;
    }),
  };
  return res;
}

function fakeReq(method: string, headers: Record<string, string | undefined>) {
  return { method, headers } as never;
}

function handler(writer: IngressWriter, over: Record<string, unknown> = {}) {
  return createHeliusIngressHandler({
    webhookSecret: SECRET,
    writer,
    readBody: async () => (over.body as string) ?? '[]',
    now: () => 1234,
  } as never);
}

const pumpTx = {
  meta: { err: null },
  feePayer: 'deployerA',
  signature: 'sig1',
  slot: 42,
  instructions: [
    {
      programId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
      accounts: ['mint1', 'x', 'curve1'],
    },
  ],
};

describe('Helius ingress handler', () => {
  it('rejects non-POST with 405', async () => {
    const res = fakeRes();
    await handler({ xadd: vi.fn() })(fakeReq('GET', { authorization: SECRET }), res as never);
    expect(res.statusCode).toBe(405);
  });

  it('rejects missing/wrong auth with 401', async () => {
    const res = fakeRes();
    await handler({ xadd: vi.fn() })(fakeReq('POST', { authorization: 'nope' }), res as never);
    expect(res.statusCode).toBe(401);
  });

  it('rejects malformed JSON and non-array payloads with 400', async () => {
    const res1 = fakeRes();
    await handler({ xadd: vi.fn() }, { body: '{bad' })(fakeReq('POST', { authorization: SECRET }), res1 as never);
    expect(res1.statusCode).toBe(400);

    const res2 = fakeRes();
    await handler({ xadd: vi.fn() }, { body: '{"a":1}' })(fakeReq('POST', { authorization: SECRET }), res2 as never);
    expect(res2.statusCode).toBe(400);
  });

  it('acks 200 with written=0 for an empty batch', async () => {
    const res = fakeRes();
    await handler({ xadd: vi.fn() })(fakeReq('POST', { authorization: SECRET }), res as never);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'acknowledged', written: 0 });
  });

  it('writes a pump.fun discovery record to the stream', async () => {
    const xadd = vi.fn(async () => 'stream-id');
    const res = fakeRes();
    await handler({ xadd }, { body: JSON.stringify([pumpTx]) })(fakeReq('POST', { authorization: SECRET }), res as never);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).written).toBe(1);
    expect(xadd).toHaveBeenCalledTimes(1);
    const args = xadd.mock.calls[0] as unknown[];
    expect(args[0]).toBe('solana:discovery:stream');
    const record = JSON.parse(args[args.length - 1] as string);
    expect(record).toMatchObject({ chain: 'sol', mint: 'mint1', bondingCurve: 'curve1', deployer: 'deployerA', signature: 'sig1', slot: 42, firstSeenTimestamp: 1234 });
  });

  it('skips errored transactions (meta.err !== null)', async () => {
    const xadd = vi.fn();
    const errTx = { ...pumpTx, meta: { err: 'simulation failed' } };
    const res = fakeRes();
    await handler({ xadd }, { body: JSON.stringify([errTx, pumpTx]) })(
      fakeReq('POST', { authorization: SECRET }),
      res as never,
    );
    expect(JSON.parse(res.body).written).toBe(1);
    expect(xadd).toHaveBeenCalledTimes(1);
  });

  it('skips non-pump.fun program ids', async () => {
    const xadd = vi.fn();
    const otherTx = { ...pumpTx, instructions: [{ programId: 'SomeOtherProgram', accounts: ['a', 'b', 'c'] }] };
    const res = fakeRes();
    await handler({ xadd }, { body: JSON.stringify([otherTx]) })(fakeReq('POST', { authorization: SECRET }), res as never);
    expect(JSON.parse(res.body).written).toBe(0);
    expect(xadd).not.toHaveBeenCalled();
  });

  it('is fail-open: a throwing writer still returns 200 ack', async () => {
    const throwing: IngressWriter = { xadd: vi.fn(async () => { throw new Error('redis down'); }) };
    const res = fakeRes();
    await handler(throwing, { body: JSON.stringify([pumpTx]) })(fakeReq('POST', { authorization: SECRET }), res as never);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).written).toBe(0); // dropped, not errored
  });
});
