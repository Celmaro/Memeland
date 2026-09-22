import { afterEach, describe, expect, it } from 'vitest';
import { gateSellability, quoteSinglePayload, sellabilityConfigured } from '../src/services/execution-gates.js';

describe('gateSellability (DuckAI P0-2)', () => {
  const OLD_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...OLD_ENV };
    delete process.env.SELLABILITY_QUOTER_ADDRESS;
    delete process.env.SELLABILITY_QUOTER_RPC_URL;
    delete process.env.SELLABILITY_QUOTER_TOKEN_IN;
  });

  it('fails CLOSED when no Quoter transport is configured (was: sellable=true no-op)', async () => {
    process.env.SELLABILITY_QUOTER_ADDRESS = '';
    process.env.SELLABILITY_QUOTER_RPC_URL = '';
    expect(sellabilityConfigured()).toBe(false);
    const gate = gateSellability();
    const res = await gate.check('0xToken');
    expect(res.sellable).toBe(false);
    expect(res.reason).toContain('not configured');
    expect(res.reason).toContain('fail-closed');
  });

  it('reports configured only when both address and RPC are set', () => {
    expect(sellabilityConfigured()).toBe(false);
    process.env.SELLABILITY_QUOTER_RPC_URL = 'https://rpc.example.com';
    expect(sellabilityConfigured()).toBe(false);
    process.env.SELLABILITY_QUOTER_ADDRESS = '0xQuoter';
    expect(sellabilityConfigured()).toBe(true);
  });
});

describe('quoteSinglePayload encoding (verified against viem)', () => {
  it('produces the exact Uniswap V3 Quoter quoteExactInputSingle calldata', () => {
    // Golden value generated with viem:
    // keccak256("quoteExactInputSingle(address,address,uint256,uint24,uint160)")[0:4] = 0x1296323f
    // tokenIn = 0x1111.., tokenOut = 0x2222.., amountIn = 1_000_000, fee = 3000, sqrtPriceLimit = 0
    process.env.SELLABILITY_QUOTER_TOKEN_IN = '0x1111111111111111111111111111111111111111';
    const calldata = quoteSinglePayload('0x2222222222222222222222222222222222222222');
    expect(calldata.startsWith('0x1296323f')).toBe(true);
    // 4-byte selector + 5 packed ABI words of 32 bytes each => 4 + 160 bytes of hex
    expect(calldata.length).toBe(2 + 8 + 64 * 5);
    // tokenIn word
    expect(calldata.slice(10, 74)).toBe('0000000000000000000000001111111111111111111111111111111111111111');
    // tokenOut word
    expect(calldata.slice(74, 138)).toBe('0000000000000000000000002222222222222222222222222222222222222222');
    // amountIn = 1_000_000 = 0x0f4240, fee = 3000 = 0x0bb8, sqrtPriceLimitX96 = 0
    expect(calldata.slice(138, 202)).toBe('00000000000000000000000000000000000000000000000000000000000f4240');
    expect(calldata.slice(202, 266)).toBe('0000000000000000000000000000000000000000000000000000000000000bb8');
    expect(calldata.slice(266, 330)).toBe('0000000000000000000000000000000000000000000000000000000000000000');
  });

  it('defaults tokenIn to the zero address when not overridden', () => {
    delete process.env.SELLABILITY_QUOTER_TOKEN_IN;
    const calldata = quoteSinglePayload('0x2222222222222222222222222222222222222222');
    expect(calldata.slice(10, 74)).toBe('0'.repeat(64));
  });
});