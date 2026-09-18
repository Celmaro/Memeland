import { describe, it, expect } from 'vitest';
import { getAgentDomain, normalizeDomainKey, AGENT_DOMAINS } from '../src/orchestrator/agent-registry.js';

describe('agent registry', () => {
  it('contains all active agent domains with channels', () => {
      expect(AGENT_DOMAINS.map((d) => d.id).sort()).toEqual(
        ['meme-robinhood', 'whale-eth'].sort()
      );
    });

    it('getAgentDomain resolves canonical id, aliases, and channel names', () => {
      expect(getAgentDomain('meme-robinhood')?.channel).toBe('call-meme-robinhood');
      expect(getAgentDomain('evm-meme')?.id).toBe('meme-robinhood');
      expect(getAgentDomain('sol')?.id).toBe('meme-robinhood');
      expect(getAgentDomain('call-whale-eth')?.id).toBe('whale-eth');
      expect(getAgentDomain('unknown-agent')).toBeUndefined();
    });

  it('normalizeDomainKey strips prefixes consistently', () => {
    expect(normalizeDomainKey('MEME_ROBINHOOD')).toBe('meme-robinhood');
    expect(normalizeDomainKey('call-meme-robinhood')).toBe('meme-robinhood');
    expect(normalizeDomainKey('meme-evm')).toBe('meme-robinhood');
  });
});
