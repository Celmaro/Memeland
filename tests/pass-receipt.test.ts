import { describe, it, expect } from 'vitest';
import { PassReceiptLedger, filePassReceiptIO, readPassReceipts, type PassReceipt } from '../src/services/pass-receipt.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const receipt = (over: Partial<PassReceipt> = {}): PassReceipt => ({
  at: '2026-09-30T00:00:00.000Z',
  domains: ['meme-robinhood'],
  chains: ['rh'],
  candidateCountBySource: { discovery: 100 },
  candidatesNormalized: 50,
  gate: { beforeGate: 10, afterGate: 2, rejectedByGate: 8, fired: ['call-meme-robinhood'] },
  ...over,
});

describe('PassReceiptLedger (6.1 — audit, not log-grep)', () => {
  it('records a receipt durably and reads it back (file IO)', async () => {
    const file = path.join(os.tmpdir(), `memeland-pr-${Date.now()}.jsonl`);
    try {
      const ledger = new PassReceiptLedger(filePassReceiptIO(file));
      ledger.record(receipt());
      ledger.record(receipt({ gate: { beforeGate: 5, afterGate: 0, rejectedByGate: 5, fired: [] } }));
      const all = await readPassReceipts({ file });
      expect(all).toHaveLength(2);
      expect(all[0]!.gate.fired).toEqual(['call-meme-robinhood']);
      expect(all[1]!.gate.afterGate).toBe(0);
    } finally {
      await fs.promises.rm(file, { force: true });
    }
  });

  it('lastFired reflects the most recent pass and null when empty', async () => {
    const file = path.join(os.tmpdir(), `memeland-pr2-${Date.now()}.jsonl`);
    try {
      const ledger = new PassReceiptLedger(filePassReceiptIO(file));
      expect(await ledger.lastFired({ file })).toBeNull();
      ledger.record(receipt());
      expect(await ledger.lastFired({ file })).toBe(true);
      ledger.record(receipt({ gate: { beforeGate: 3, afterGate: 0, rejectedByGate: 3, fired: [] } }));
      expect(await ledger.lastFired({ file })).toBe(false);
    } finally {
      await fs.promises.rm(file, { force: true });
    }
  });

  it('record is fail-open (a broken io never throws into the pass)', () => {
    const ledger = new PassReceiptLedger({ append: () => { throw new Error('disk full'); } });
    expect(() => ledger.record(receipt())).not.toThrow();
  });
});