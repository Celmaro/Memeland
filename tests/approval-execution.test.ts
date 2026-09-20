import { describe, it, expect, vi, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { StateStore } from '../src/services/state-store.js';
import { TradeJournalService } from '../src/services/trade-journal-service.js';
import { executeMemeBuy } from '../src/services/approval-execution.js';
import type { EVMTradeAdapter } from '../src/adapters/evm-adapter.js';
import type { WalletService } from '../src/services/wallet-service.js';

const dbPaths: string[] = [];

describe('executeMemeBuy (shared approve / AUTO fill path)', () => {
  afterAll(() => {
    for (const p of dbPaths) {
      for (const f of [p, `${p}.tmp`]) {
        try { fs.unlinkSync(f); } catch { /* already gone */ }
      }
    }
  });

  function makeDeps() {
    const p = path.join(process.cwd(), 'database', `test_exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`);
    dbPaths.push(p);
    const store = new StateStore(p);
    const journal = new TradeJournalService();
    journal.attachStateStore(store);
    const evm = {
      executeBuyToken: vi.fn().mockResolvedValue({
        success: true,
        simulated: true,
        chain: 'robinhood',
        inputEth: 0.1,
        outputTokens: 12345,
        dexUsed: 'Uniswap API (Robinhood L2)',
      }),
    } as unknown as EVMTradeAdapter;
    const wallet = {} as unknown as WalletService;
    return { store, journal, evm, wallet };
  }

  it('executes a buy, records an OPEN journal entry, and fires onExecuted', async () => {
    const { journal, evm, wallet } = makeDeps();
    const onExecuted = vi.fn();
    const res = await executeMemeBuy({
      evm,
      wallet,
      journal,
      onExecuted,
      symbol: 'TEST',
      contractAddress: '0xabc',
      entryPriceUsd: 0.5,
      amountEth: 0.1,
      confidence: 85,
      thesis: 'approved by operator',
    });

    expect(evm.executeBuyToken).toHaveBeenCalledTimes(1);
    expect(evm.executeBuyToken).toHaveBeenCalledWith(
      expect.objectContaining({ chain: 'robinhood', tokenAddress: '0xabc', amountEth: 0.1, slippagePercentage: 1.5 }),
      wallet
    );
    expect(res.success).toBe(true);
    expect(res.simulated).toBe(true);
    expect(onExecuted).toHaveBeenCalledTimes(1);

    const [entry] = journal.listTrades();
    expect(entry).toBeTruthy();
    expect(entry.symbol).toBe('TEST');
    expect(entry.chain).toBe('robinhood');
    expect(entry.status).toBe('OPEN');
    expect(entry.strategyUsed).toBe('approval-approved');
    expect(entry.positionSizeUsd).toBeCloseTo(0.05); // 0.1 ETH * $0.5
  });

  it('still journals and bumps the funnel even when the EVM fill reports failure (audit trail)', async () => {
    const { journal, evm, wallet } = makeDeps();
    (evm.executeBuyToken as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      simulated: true,
      chain: 'robinhood',
      inputEth: 0.1,
      outputTokens: 0,
      dexUsed: 'Uniswap API (Robinhood L2)',
      error: 'quote failed',
    });
    const onExecuted = vi.fn();
    const res = await executeMemeBuy({
      evm,
      wallet,
      journal,
      onExecuted,
      symbol: 'TEST',
      contractAddress: '0xabc',
      entryPriceUsd: 0.5,
      amountEth: 0.1,
      confidence: 85,
      thesis: '',
    });
    expect(res.success).toBe(false);
    expect(res.error).toBe('quote failed');
    expect(onExecuted).toHaveBeenCalledTimes(1);
    expect(journal.listTrades()).toHaveLength(1);
  });

  it.each([
    'sol', 'Solana', 'bsc', 'BNB Chain', 'base', 'eth', 'Ethereum',
  ])('fail-closed: %s never reaches the EVM adapter, journal, or funnel', async (chain) => {
    const { journal, evm, wallet } = makeDeps();
    const onExecuted = vi.fn();
    const res = await executeMemeBuy({
      evm,
      wallet,
      journal,
      onExecuted,
      chain,
      symbol: 'TOKEN',
      contractAddress: '0x/abc-not-an-evm-address',
      entryPriceUsd: 1,
      amountEth: 0.1,
      confidence: 80,
      thesis: 'cross-chain signal',
    });

    expect(res.success).toBe(false);
    expect(res.simulated).toBe(false);
    expect(res.error).toMatch(/fail-closed/);
    expect(res.error).toMatch(/no execution adapter/);
    expect(evm.executeBuyToken).not.toHaveBeenCalled();
    expect(onExecuted).not.toHaveBeenCalled();
    expect(journal.listTrades()).toHaveLength(0);
  });

  it('executes on the canonical robinhood chain when a label is passed (Robinhood)', async () => {
    const { journal, evm, wallet } = makeDeps();
    const onExecuted = vi.fn();
    const res = await executeMemeBuy({
      evm,
      wallet,
      journal,
      onExecuted,
      chain: 'Robinhood',
      symbol: 'TEST',
      contractAddress: '0xabc',
      entryPriceUsd: 0.5,
      amountEth: 0.1,
      confidence: 85,
      thesis: 'robinhood label',
    });
    expect(res.success).toBe(true);
        expect(evm.executeBuyToken).toHaveBeenCalledTimes(1);
        expect(evm.executeBuyToken).toHaveBeenCalledWith(
          expect.objectContaining({ chain: 'robinhood' }),
          wallet
        );
        expect(onExecuted).toHaveBeenCalledTimes(1);
      });

      // ── Phase-2 wiring: fail-closed execution gates (Q15 safety, Quoter sellability, TxLock) ──

      it('refuses the fill before EVM/journal/funnel when the safety gate is NOT safe (Q15)', async () => {
        const { journal, evm, wallet } = makeDeps();
        const onExecuted = vi.fn();
        const res = await executeMemeBuy({
          evm, wallet, journal, onExecuted,
          symbol: 'TEST', contractAddress: '0xabc', entryPriceUsd: 0.5, amountEth: 0.1, confidence: 85, thesis: '',
          safety: { isSafe: () => ({ safe: false, reason: 'no safe-config — fail-closed' }) },
        });
        expect(res.success).toBe(false);
        expect(res.error).toMatch(/safety gate refused/);
        expect(res.error).toMatch(/no safe-config/);
        expect(evm.executeBuyToken).not.toHaveBeenCalled();
        expect(onExecuted).not.toHaveBeenCalled();
        expect(journal.listTrades()).toHaveLength(0);
      });

      it('executes when the safety gate is explicitly safe', async () => {
        const { journal, evm, wallet } = makeDeps();
        const res = await executeMemeBuy({
          evm, wallet, journal, onExecuted: () => {},
          symbol: 'TEST', contractAddress: '0xabc', entryPriceUsd: 0.5, amountEth: 0.1, confidence: 85, thesis: '',
          safety: { isSafe: () => ({ safe: true, reason: 'safe v1' }) },
        });
        expect(res.success).toBe(true);
        expect(evm.executeBuyToken).toHaveBeenCalledTimes(1);
      });

      it('refuses when the Quoter honeypot can NOT prove sellability (fail-closed)', async () => {
        const { journal, evm, wallet } = makeDeps();
        const onExecuted = vi.fn();
        const res = await executeMemeBuy({
          evm, wallet, journal, onExecuted,
          symbol: 'TEST', contractAddress: '0xhnypot', entryPriceUsd: 0.5, amountEth: 0.1, confidence: 85, thesis: '',
          sellability: { check: async () => ({ sellable: false, reason: 'cannot sell — fail-closed' }) },
        });
        expect(res.success).toBe(false);
        expect(res.error).toMatch(/sellability gate refused/);
        expect(evm.executeBuyToken).not.toHaveBeenCalled();
        expect(onExecuted).not.toHaveBeenCalled();
      });

      it('executes when sellability is proven', async () => {
        const { journal, evm, wallet } = makeDeps();
        const res = await executeMemeBuy({
          evm, wallet, journal, onExecuted: () => {},
          symbol: 'TEST', contractAddress: '0xabc', entryPriceUsd: 0.5, amountEth: 0.1, confidence: 85, thesis: '',
          sellability: { check: async () => ({ sellable: true, reason: 'quote ok' }) },
        });
        expect(res.success).toBe(true);
        expect(evm.executeBuyToken).toHaveBeenCalledTimes(1);
      });

      it('TxLock: wraps the fill, releases exactly once, and serializes per token', async () => {
        const { journal, evm, wallet } = makeDeps();
        const releases: number[] = [];
        const txLock = {
          acquire: vi.fn(async () => {
            releases.push(0);
            return () => { releases.push(1); };
          }),
        };
        const res = await executeMemeBuy({
          evm, wallet, journal, onExecuted: () => {},
          symbol: 'TEST', contractAddress: '0xabc', entryPriceUsd: 0.5, amountEth: 0.1, confidence: 85, thesis: '',
          txLock,
        });
        expect(res.success).toBe(true);
        expect(txLock.acquire).toHaveBeenCalledWith('0xabc');
        // lock acquired then released exactly once each, even though the EVM path succeeded
        expect(releases.filter((r) => r === 0)).toHaveLength(1);
        expect(releases.filter((r) => r === 1)).toHaveLength(1);
      });

      it('TxLock is still released when the EVM fill throws (no leaked lock)', async () => {
        const { journal, evm, wallet } = makeDeps();
        (evm.executeBuyToken as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('rpc down'));
        let released = 0;
        const txLock = { acquire: vi.fn(async () => () => { released += 1; }) };
        await expect(executeMemeBuy({
          evm, wallet, journal, onExecuted: () => {},
          symbol: 'TEST', contractAddress: '0xabc', entryPriceUsd: 0.5, amountEth: 0.1, confidence: 85, thesis: '',
          txLock,
        })).rejects.toThrow('rpc down');
        expect(released).toBe(1);
      });
    });
