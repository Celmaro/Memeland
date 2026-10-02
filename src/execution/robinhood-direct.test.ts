import { describe, it, expect, vi } from 'vitest';
import {
  clampRobinhoodGasLimit,
  RobinhoodDirectExecutor,
  DEFAULT_PONS_GAS_LIMIT,
} from './robinhood-direct.js';

describe('clampRobinhoodGasLimit', () => {
  it('clamps a requested gas above the default 280k cap', () => {
    expect(clampRobinhoodGasLimit(500_000)).toBe(DEFAULT_PONS_GAS_LIMIT);
  });

  it('keeps a request under the cap unchanged', () => {
    expect(clampRobinhoodGasLimit(150_000)).toBe(150_000);
  });

  it('honors an env override cap', () => {
    expect(clampRobinhoodGasLimit(500_000, DEFAULT_PONS_GAS_LIMIT, { ROBINHOOD_MAX_GAS_LIMIT: '200000' })).toBe(200_000);
  });
});

describe('RobinhoodDirectExecutor — direct-to-sequencer scaffold', () => {
  it('sends calldata to the sequencer and reports the clamped gas limit', async () => {
    const hash = ('0x' + '11'.repeat(32)) as `0x${string}`;
    const sendRawTransaction = vi.fn(async () => hash);
    const ex = new RobinhoodDirectExecutor({ ponsRouter: '0xpons', sendRawTransaction });
    const out = await ex.send({ calldata: '0xdeadbeef', from: '0xabc', value: 1n });
    expect(out.gasLimit).toBe(DEFAULT_PONS_GAS_LIMIT);
    expect(out.txHash).toBe(hash);
    expect(sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it('fails closed on empty calldata (no fabricated router interaction)', async () => {
    const ex = new RobinhoodDirectExecutor({ ponsRouter: '0xpons', sendRawTransaction: vi.fn() });
    await expect(ex.send({ calldata: '' as `0x${string}`, from: '0xabc', value: 0n })).rejects.toThrow(/calldata required/);
  });

  it('defaults to the official sequencer RPC', () => {
    const ex = new RobinhoodDirectExecutor();
    expect(ex.sequencerUrl()).toBe('https://rpc.mainnet.chain.robinhood.com');
  });
});
