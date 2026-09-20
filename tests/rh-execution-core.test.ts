import { describe, it, expect, vi } from 'vitest';
import {
  TxLock,
  FastSubmitter,
  NitroFeedReader,
  parseNitroFeedLine,
  assessSellability,
  type FastSubmitTransport,
  type NitroFeedMessage,
  type QuoterCall,
} from '../src/services/rh-execution-core.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------- TxLock ---
describe('TxLock (per-token tx serializer)', () => {
  it('queues a second concurrent acquire on the same token (FIFO: second waits)', async () => {
    const lock = new TxLock();
    let released = false;

    const first = await lock.acquire('0xTOKEN');
    expect(lock.inflightCount('0xTOKEN')).toBe(1);

    const second = lock.acquire('0xTOKEN');
    let secondHeld = false;
    second.then(() => {
      secondHeld = true;
    });

    await delay(10);
    expect(secondHeld).toBe(false); // second must wait
    expect(lock.inflightCount('0xTOKEN')).toBe(1); // still exactly one in flight

    first();
    expect(released).toBe(false);
    await second;
    expect(secondHeld).toBe(true);
    expect(lock.inflightCount('0xTOKEN')).toBe(1);
  });

  it('different tokens acquire immediately without blocking each other', async () => {
    const lock = new TxLock();
    const a = await lock.acquire('0xAAA');
    const b = await lock.acquire('0xBBB'); // resolves immediately
    expect(lock.inflightCount('0xAAA')).toBe(1);
    expect(lock.inflightCount('0xBBB')).toBe(1);
    a();
    b();
    expect(lock.inflightCount('0xAAA')).toBe(0);
    expect(lock.inflightCount('0xBBB')).toBe(0);
  });

  it('release allows the next queued caller, and inflightCount is strictly 0/1', async () => {
    const lock = new TxLock();
    const order: number[] = [];
    const held: Array<() => void> = [];

    const holder1 = await lock.acquire('0xTOKEN');
    order.push(1);

    const holder2Promise = lock.acquire('0xTOKEN').then((release) => {
      order.push(2);
      held.push(release);
    });
    const holder3Promise = lock.acquire('0xTOKEN').then((release) => {
      order.push(3);
      held.push(release);
    });

    expect(lock.inflightCount('0xTOKEN')).toBe(1);

    holder1(); // release 1 -> hands to 2 (FIFO)
    await holder2Promise;
    expect(order).toEqual([1, 2]);
    expect(lock.inflightCount('0xTOKEN')).toBe(1); // still exactly one held, by #2

    held[0](); // release 2 -> hands to 3
    await holder3Promise;
    expect(order).toEqual([1, 2, 3]);
    expect(lock.inflightCount('0xTOKEN')).toBe(1); // now held by #3

    held[1](); // release 3 -> nothing queued
    expect(lock.inflightCount('0xTOKEN')).toBe(0);
  });

  it('inflightCount is exactly 0 then 1, and a lock is never granted while held', async () => {
    const lock = new TxLock();
    expect(lock.inflightCount('0xTOKEN')).toBe(0);

    const rel = await lock.acquire('0xTOKEN');
    expect(lock.inflightCount('0xTOKEN')).toBe(1);

    // A pile of concurrent acquires must ALL be granted, one at a time, never overlapping.
    const acquired = new Set<string>();
    const run = (id: string) =>
      lock.acquire('0xTOKEN').then((release) => {
        expect(lock.inflightCount('0xTOKEN')).toBe(1);
        expect(acquired.size).toBe(0); // only one holder at a time before we add
        acquired.add(id);
        expect(acquired.size).toBe(1);
        release();
        acquired.delete(id);
      });

    rel(); // hand the lock to the first queued caller (x)
    await Promise.all([run('x'), run('y'), run('z')]);
    expect(lock.inflightCount('0xTOKEN')).toBe(0);
  });

  it('release is idempotent — double release never double-grants', async () => {
    const lock = new TxLock();
    const rel = await lock.acquire('0xTOKEN');
    let secondHeld = false;
    lock.acquire('0xTOKEN').then(() => {
      secondHeld = true;
    });
    rel();
    rel(); // second release is a no-op
    await delay(0);
    expect(secondHeld).toBe(true); // granted exactly once
    expect(lock.inflightCount('0xTOKEN')).toBe(1);
  });
});

// --------------------------------------------------------- FastSubmitter ---
describe('FastSubmitter (fast-submit to sequencer, fail-closed)', () => {
  it('returns ok:true with txHash when the transport reports ok:true + hash', async () => {
    const transport: FastSubmitTransport = {
      sendRawTransaction: vi.fn(async () => ({ ok: true, txHash: '0xHASH1' })),
    };
    const sub = new FastSubmitter(transport);
    const res = await sub.submit('0xRAW');
    expect(res).toEqual({ ok: true, txHash: '0xHASH1' });
  });

  it('returns ok:false when the transport throws (never a false success)', async () => {
    const transport: FastSubmitTransport = {
      sendRawTransaction: vi.fn(async () => {
        throw new Error('connection reset');
      }),
    };
    const sub = new FastSubmitter(transport);
    const res = await sub.submit('0xRAW');
    expect(res.ok).toBe(false);
    expect(res.txHash).toBeUndefined();
    expect(res.error).toMatch(/connection reset/);
  });

  it('returns ok:false when transport says ok:true but omits txHash (receipt-verified)', async () => {
    const transport: FastSubmitTransport = {
      sendRawTransaction: vi.fn(async () => ({ ok: true })),
    };
    const sub = new FastSubmitter(transport);
    const res = await sub.submit('0xRAW');
    expect(res.ok).toBe(false);
    expect(res.txHash).toBeUndefined();
    expect(res.error).toMatch(/txHash/);
  });

  it('returns ok:false when the transport explicitly rejects', async () => {
    const transport: FastSubmitTransport = {
      sendRawTransaction: vi.fn(async () => ({ ok: false, error: 'nonce too low' })),
    };
    const sub = new FastSubmitter(transport);
    const res = await sub.submit('0xRAW');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/nonce too low/);
  });
});

// ------------------------------------------------------- parseNitroFeedLine ---
describe('parseNitroFeedLine (Arbitrum-Nitro broadcast tape)', () => {
  const line = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      feedSequence: 42,
      batchItems: [
        { txHash: '0xAB', tokenAddress: '0xTOKEN', kind: 'buy', amountUsd: 1200, at: 100 },
        { txHash: '0xCD', tokenAddress: '0xOTHER', kind: 'sell', amountUsd: 300, at: 150 },
      ],
      ...over,
    });

  it('parses a valid RH Nitro line and extracts buy/sell items', () => {
    const msg = parseNitroFeedLine(line());
    expect(msg).not.toBeNull();
    expect(msg!.feedSequence).toBe(42);
    expect(msg!.batchItems).toHaveLength(2);
    expect(msg!.batchItems[0]).toMatchObject({ txHash: '0xAB', kind: 'buy', amountUsd: 1200, at: 100 });
    expect(msg!.batchItems[1]).toMatchObject({ txHash: '0xCD', kind: 'sell', amountUsd: 300, at: 150 });
  });

  it('filters by tokenAddress when provided', () => {
    const filtered = parseNitroFeedLine(line(), '0xTOKEN');
    expect(filtered).not.toBeNull();
    expect(filtered!.batchItems.some((i) => i.tokenAddress === '0xTOKEN')).toBe(true);

    const other = parseNitroFeedLine(line(), '0xOTHER');
    expect(other).not.toBeNull();
    expect(other!.batchItems.some((i) => i.tokenAddress === '0xOTHER')).toBe(true);
  });

  it('returns null for a line with no matching token', () => {
    expect(parseNitroFeedLine(line(), '0xUNKNOWN')).toBeNull();
  });

  it('returns null for unparseable input without throwing', () => {
    expect(parseNitroFeedLine('not json at all')).toBeNull();
    expect(parseNitroFeedLine('')).toBeNull();
    expect(parseNitroFeedLine('{"no feedSequence": 1}')).toBeNull();
    expect(parseNitroFeedLine('{"feedSequence": 1, "batchItems": []}')).toBeNull();
    // @ts-expect-error non-string input is rejected, not thrown
    expect(parseNitroFeedLine(null)).toBeNull();
    expect(() => parseNitroFeedLine('{broken json')).not.toThrow();
  });

  it('tolerates unknown field shapes and normalizes malformed kinds', () => {
    const weird = JSON.stringify({
      feedSequence: 7,
      unexpected: { nested: true },
      batchItems: [
        { txHash: '0xX1', kind: 'SURPRISE', tokenAddress: 12345 }, // bad kind + bad token
        { txHash: '0xX2', tokenAddress: '0xTOKEN', kind: 'sell' }, // no amountUsd/at
      ],
    });
    const msg = parseNitroFeedLine(weird);
    expect(msg).not.toBeNull();
    expect(msg!.batchItems[0]).toMatchObject({ txHash: '0xX1', kind: 'unknown', tokenAddress: null });
    expect(msg!.batchItems[1]).toMatchObject({ txHash: '0xX2', kind: 'sell', tokenAddress: '0xTOKEN' });
  });
});

// ---------------------------------------------------------- NitroFeedReader ---
describe('NitroFeedReader (injected tape transport)', () => {
  function liveTransport() {
    let handler: ((line: string) => void) | null = null;
    const transport = {
      onLine(cb: (line: string) => void) {
        handler = cb;
        return () => {
          handler = null;
        };
      },
    };
    const emit = (line: string) => handler?.(line);
    return { transport, emit };
  }

  it('returns matching filtered messages in order via next()', async () => {
    const { transport, emit } = liveTransport();
    const reader = new NitroFeedReader(transport);
    const sub = reader.subscribe('0xTOKEN');

    const mk = (seq: number, token: string, kind: 'buy' | 'sell') =>
      JSON.stringify({
        feedSequence: seq,
        batchItems: [{ txHash: `0xH${seq}`, tokenAddress: token, kind, amountUsd: seq, at: seq }],
      });

    emit(mk(1, '0xTOKEN', 'buy'));
    emit(mk(2, '0xOTHER', 'sell')); // filtered out
    emit(mk(3, '0xTOKEN', 'sell'));

    const m1 = await sub.next();
    const m2 = await sub.next();
    const done = await sub.next();

    expect(m1).not.toBeNull();
    expect(m1!.feedSequence).toBe(1);
    expect(m1!.batchItems[0].kind).toBe('buy');

    expect(m2).not.toBeNull();
    expect(m2!.feedSequence).toBe(3);
    expect(m2!.batchItems[0].kind).toBe('sell');

    expect(done).toBeNull(); // tape drained of matching lines
  });

  it('stop() prevents further delivery', async () => {
    const { transport, emit } = liveTransport();
    const reader = new NitroFeedReader(transport);
    const sub = reader.subscribe('0xTOKEN');

    emit(JSON.stringify({ feedSequence: 1, batchItems: [{ txHash: '0xA', tokenAddress: '0xTOKEN', kind: 'buy' }] }));
    const m = await sub.next();
    expect(m!.feedSequence).toBe(1);

    sub.stop();
    emit(JSON.stringify({ feedSequence: 2, batchItems: [{ txHash: '0xB', tokenAddress: '0xTOKEN', kind: 'buy' }] }));
    const afterStop = await sub.next();
    expect(afterStop).toBeNull();
  });

  it('returns null for an empty stream (no matching lines ever)', async () => {
    const { transport } = liveTransport(); // never emits
    const reader = new NitroFeedReader(transport);
    const sub = reader.subscribe('0xTOKEN');
    expect(await sub.next()).toBeNull();
  });
});

// -------------------------------------------------------- assessSellability ---
describe('assessSellability (Quoter honeypot)', () => {
  const payload = '0xquoteExactInputSingle';

  it('returns sellable:true when the call succeeds with a non-empty output', async () => {
    const call: QuoterCall = { callContract: vi.fn(async () => ({ ok: true, output: '0x0000000000000000000000000000000000000000000000000000000000000064' })) };
    const res = await assessSellability(call, payload);
    expect(res.sellable).toBe(true);
    expect(call.callContract).toHaveBeenCalledWith(payload);
  });

  it('returns sellable:false when the call fails (fail-closed)', async () => {
    const call: QuoterCall = { callContract: vi.fn(async () => ({ ok: false, error: 'revert' })) };
    const res = await assessSellability(call, payload);
    expect(res.sellable).toBe(false);
    expect(res.reason).toBe('cannot sell — fail-closed');
  });

  it('returns sellable:false when the call throws (fail-closed)', async () => {
    const call: QuoterCall = {
      callContract: vi.fn(async () => {
        throw new Error('rpc down');
      }),
    };
    const res = await assessSellability(call, payload);
    expect(res.sellable).toBe(false);
    expect(res.reason).toBe('cannot sell — fail-closed');
  });

  it('returns sellable:false when output is empty / missing (never assume liquidity)', async () => {
    const empty: QuoterCall = { callContract: vi.fn(async () => ({ ok: true, output: '' })) };
    expect((await assessSellability(empty, payload)).sellable).toBe(false);

    const missing: QuoterCall = { callContract: vi.fn(async () => ({ ok: true })) };
    expect((await assessSellability(missing, payload)).sellable).toBe(false);

    const nullish: QuoterCall = { callContract: vi.fn(async () => ({ ok: true, output: null as unknown as string })) };
    expect((await assessSellability(nullish, payload)).sellable).toBe(false);
  });
});
