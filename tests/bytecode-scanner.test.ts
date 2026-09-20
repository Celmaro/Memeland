import { describe, it, expect } from 'vitest';
import { BytecodeScanner, PUSH4_OPCODE } from '../src/services/bytecode-scanner.js';

describe('BytecodeScanner (Kernel D)', () => {
  it('flags crafted hex that PUSH4s a deny-listed selector', () => {
    const scan = new BytecodeScanner();
    const result = scan.scan(`0x600080604052${PUSH4_OPCODE}42966c686080606600`);
    expect(result.flagged).toBe(true);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings.join(' ').toLowerCase()).toContain('42966c68');
  });

  it('flags each deny-listed selector that appears as PUSH4', () => {
    const scan = new BytecodeScanner();
    const result = scan.scan(`${PUSH4_OPCODE}bc197c81${PUSH4_OPCODE}42966c68`);
    expect(result.flagged).toBe(true);
    expect(result.findings).toHaveLength(2);
  });

  it('does not flag a word packed without the PUSH4 prefix', () => {
    const scan = new BytecodeScanner();
    const result = scan.scan('0x42966c6842966c6842966c68');
    expect(result.flagged).toBe(false);
    expect(result.findings).toEqual([]);
  });

  it('empty bytecode is not flagged', () => {
    const scan = new BytecodeScanner();
    const empty = scan.scan('');
    expect(empty.flagged).toBe(false);
    expect(empty.findings).toEqual([]);

    const prefixOnly = scan.scan('0x');
    expect(prefixOnly.flagged).toBe(false);
  });

  it('benign bytecode returns no findings', () => {
    const scan = new BytecodeScanner();
    const result = scan.scan('0x608060405234801561001057600080fd5b5060');
    expect(result.flagged).toBe(false);
  });

  it('is case-insensitive over the bytecode input', () => {
    const scan = new BytecodeScanner();
    const upper = scan.scan(`${PUSH4_OPCODE}42966C68`);
    const lower = scan.scan(`${PUSH4_OPCODE}42966c68`);
    expect(upper.flagged).toBe(true);
    expect(lower.flagged).toBe(true);
  });
});
