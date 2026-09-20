import { describe, expect, it } from 'vitest';
import {
  TxLockedExecutor,
  vetoingExecutor,
  type TransactionExecutor,
} from '../src/services/rh-execution-core.js';

function stubExecutor(result?: { ok: boolean; txHash?: string; error?: string }): {
  exec: TransactionExecutor;
  calls: string[];
  inflight: number;
  maxInflight: number;
  release: () => void;
} {
  const calls: string[] = [];
  let inflight = 0;
  let maxInflight = 0;
  const blockers: Array<() => void> = [];
  const exec: TransactionExecutor = {
    async submit(rawTx, meta) {
      calls.push(meta?.tokenAddress ?? '?');
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      // Block until this specific submit is released so tests can observe order.
      await new Promise<void>((r) => blockers.push(r));
      inflight--;
      return result ?? { ok: true, txHash: '0x' + calls.length };
    },
  };
  return {
    exec,
    calls,
    get inflight() {
      return inflight;
    },
    get maxInflight() {
      return maxInflight;
    },
    release: () => {
      const next = blockers.shift();
      next?.();
    },
  };
}

describe('TxLockedExecutor (SRC-227/230 executor DI)', () => {
  it('passes through submits without a tokenAddress', async () => {
    const s = stubExecutor({ ok: true, txHash: '0x1' });
    const ex = new TxLockedExecutor(s.exec);
    const p = ex.submit('raw');
    s.release();
    const r = await p;
    expect(r.ok).toBe(true);
    expect(s.calls).toEqual(['?']);
  });

  it('serializes concurrent submits for the same token', async () => {
    const s = stubExecutor({ ok: true, txHash: '0x1' });
    const ex = new TxLockedExecutor(s.exec);
    const p1 = ex.submit('raw1', { tokenAddress: '0xTOK' });
    const p2 = ex.submit('raw2', { tokenAddress: '0xTOK' });
    // Let the scheduler run the first submit.
    await new Promise((r) => setTimeout(r, 0));
    expect(s.maxInflight).toBe(1);
    // Release the first; only then may the second start.
    s.release();
    await p1;
    await new Promise((r) => setTimeout(r, 0));
    expect(s.maxInflight).toBe(1); // still never two in-flight
    s.release();
    await p2;
    expect(s.calls.filter((c) => c === '0xTOK').length).toBe(2);
  });

  it('converts a throwing executor into a fail-closed result', async () => {
    const bad: TransactionExecutor = {
      async submit() {
        throw new Error('transport down');
      },
    };
    const ex = new TxLockedExecutor(bad);
    const r = await ex.submit('raw', { tokenAddress: '0xTOK' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('transport down');
  });
});

describe('vetoingExecutor (veto-with-reason)', () => {
  it('blocks a submit when the veto returns a reason', async () => {
    let submitted = false;
    const inner: TransactionExecutor = {
      async submit() {
        submitted = true;
        return { ok: true, txHash: '0x1' };
      },
    };
    const ex = vetoingExecutor(inner, () => 'honeypot flagged');
    const r = await ex.submit('raw', { tokenAddress: '0xTOK' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('honeypot flagged');
    expect(submitted).toBe(false);
  });

  it('fails closed when the veto itself throws', async () => {
    const ex = vetoingExecutor(
      {
        async submit() {
          return { ok: true, txHash: '0x1' };
        },
      },
      () => {
        throw new Error('boom');
      },
    );
    const r = await ex.submit('raw');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('fail-closed');
  });

  it('allows the submit when there is no veto', async () => {
    const inner: TransactionExecutor = {
      async submit() {
        return { ok: true, txHash: '0x1' };
      },
    };
    const ex = vetoingExecutor(inner, () => null);
    expect((await ex.submit('raw')).ok).toBe(true);
  });
});
