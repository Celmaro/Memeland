import { describe, it, expect } from 'vitest';
import { BytecodeScanner } from '../src/services/bytecode-scanner.js';

/** Deployed code containing the burn-restrict PUSH4 selector (0x42966c68 → `63 42 96 6c 68`). */
const DENY_CODE = '0x' + '6080604052' + '6342966c68' + '00aa00';
const CLEAN_CODE = '0x' + '6080604052' + '00aa00';

describe('BytecodeScanner — B#3 bytecode-hash cache', () => {
  it('scan flags deny-listed selectors and ignores clean code', () => {
    const s = new BytecodeScanner();
    expect(s.scan(DENY_CODE).flagged).toBe(true);
    expect(s.scan(CLEAN_CODE).flagged).toBe(false);
    expect(s.scan('0x').flagged).toBe(false);
  });

  it('scanContract caches per address: reuses the scan and skips the eth_getCode call', async () => {
    let fetches = 0;
    const fetcher = async () => {
      fetches += 1;
      return DENY_CODE;
    };
    const s = new BytecodeScanner();
    const first = await s.scanContract('eth', '0xabc', fetcher);
    expect(first.flagged).toBe(true);
    expect(fetches).toBe(1);
    const second = await s.scanContract('eth', '0xabc', fetcher);
    expect(second).toEqual(first);
    expect(fetches).toBe(1); // cached — eth_getCode not called again
  });

  it('a different address with identical code still fetches (its own hash) and flags', async () => {
    let fetches = 0;
    const fetcher = async () => {
      fetches += 1;
      return DENY_CODE;
    };
    const s = new BytecodeScanner();
    await s.scanContract('eth', '0xabc', fetcher);
    await s.scanContract('eth', '0xdef', fetcher); // different address → own fetch
    expect(fetches).toBe(2);
    const r = await s.scanContract('eth', '0xdef', fetcher);
    expect(r.flagged).toBe(true);
  });

  it('scanContract is fail-open: a fetch error yields an unflagged scan and caches nothing', async () => {
    const s = new BytecodeScanner();
    let calls = 0;
    const boom = async () => {
      calls += 1;
      throw new Error('rpc down');
    };
    const r = await s.scanContract('bsc', '0x1', boom);
    expect(r).toEqual({ flagged: false, findings: [] });
    // Failure is not cached — a later healthy call still scans.
    const ok = await s.scanContract('bsc', '0x1', async () => DENY_CODE);
    expect(ok.flagged).toBe(true);
    expect(calls).toBe(1);
  });
});
