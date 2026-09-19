import { describe, it, expect, vi } from 'vitest';
import { SerializedExecutor, withTimeout, type TransactionExecutor, type TransactionRequest } from '../src/position/executor.js';

function recordingExecutor() {
  let inFlight = 0;
  let maxInFlight = 0;
  const submit = vi.fn(async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    return { outcome: 'confirmed' as const, txHash: '0xTX', at: Date.now() };
  });
  return { exec: { id: 'rec', submit }, stats: () => ({ maxInFlight, calls: submit.mock.calls.length }) };
}

describe('SerializedExecutor (Q09)', () => {
  it('veto carries a reason record and blocks the fill', async () => {
    const { exec, stats } = recordingExecutor();
    const s = new SerializedExecutor(exec, () => ({ vetoed: true, reason: 'over 40% chain exposure' }));
    const r = await s.execute({ token: 'T', chainId: 4663, side: 'buy', amountUsd: 100 });
    expect(r.outcome).toBe('failed');
    expect(r.reason).toContain('over 40%');
    expect(stats().calls).toBe(0);
  });

  it('allows only one in-flight tx per token (serialization)', async () => {
    const { exec, stats } = recordingExecutor();
    const s = new SerializedExecutor(exec, () => ({ vetoed: false }));
    const req: TransactionRequest = { token: 'T', chainId: 4663, side: 'buy', amountUsd: 100 };
    await Promise.all([s.execute(req), s.execute(req), s.execute(req)]);
    expect(stats().maxInFlight).toBe(1);
    expect(stats().calls).toBe(3);
  });

  it('different tokens run independently (not serialized together)', async () => {
    const { exec, stats } = recordingExecutor();
    const s = new SerializedExecutor(exec, () => ({ vetoed: false }));
    await Promise.all([s.execute({ token: 'A', chainId: 56, side: 'buy', amountUsd: 1 }), s.execute({ token: 'B', chainId: 56, side: 'buy', amountUsd: 1 })]);
    expect(stats().calls).toBe(2);
  });
});

describe('withTimeout (Q09)', () => {
  it('marks a timed-out fill failed and gates a silent retry', async () => {
    const slow: TransactionExecutor = {
      id: 'slow',
      async submit() {
        await new Promise((r) => setTimeout(r, 15));
        return { outcome: 'confirmed', txHash: '0xLATE', at: Date.now() };
      },
    };
    const timed = withTimeout(slow, 5);
    const s = new SerializedExecutor(timed, () => ({ vetoed: false }), { maxConsecutiveFailures: 2 });
    const req: TransactionRequest = { token: 'T', chainId: 4663, side: 'buy', amountUsd: 100, timeoutMs: 5 };
    const first = await s.execute(req);
    expect(first.outcome).toBe('timed_out');
    const second = await s.execute(req);
    expect(second.outcome).toBe('timed_out');
    // After 2 consecutive timeouts the token is gated — no silent retry.
    const gated = await s.execute(req);
    expect(gated.outcome).toBe('failed');
    expect(gated.reason).toContain('gated');
  });
});
