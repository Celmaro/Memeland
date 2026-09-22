export type AgentDomainId =
  | 'meme-robinhood'
  | 'alpha-robinhood'
  | 'whale-eth';

export type AgentCategory = 'MEME' | 'ALPHA' | 'WHALE';

export interface AgentDomainInfo {
  id: AgentDomainId;
  displayName: string;
  name: string;
  channel: string;
  aliases: string[];
  requiredKeys: string[];
  category: AgentCategory;
}

export const AGENT_DOMAINS: AgentDomainInfo[] = [
  {
    id: 'meme-robinhood',
    displayName: 'MEME-ROBINHOOD',
    name: 'Multi-Chain Meme Screening (sol/bsc/base/eth + robinhood venue)',
    channel: 'call-meme-robinhood',
    aliases: ['robinhood', 'evm', 'evm-meme', 'meme-evm', 'meme', 'sol', 'base', 'bsc'],
    // Screening and discovery are deterministic (GMGN/Gecko/GoPlus). AI_API_KEY is
    // only consumed by the critic/sentiment LLM voters, which fail open to a
    // neutral vote — a missing key must never halt the screening pass.
    requiredKeys: [],
    category: 'MEME',
  },
  {
    id: 'whale-eth',
    displayName: 'WHALE-ETH',
    name: 'Hyperliquid ETH Whale & Smart-Money Positioning',
    channel: 'call-whale-eth',
    aliases: ['whale', 'eth-whale', 'hyperliquid', 'whale-tracking', 'whale-eth'],
    requiredKeys: [],
    category: 'WHALE',
  },
];

function canonicalize(input: string): string {
  return input
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/^call-/, '')
    .replace(/-token$/, '');
}

export function getAgentDomain(idOrAlias: string): AgentDomainInfo | undefined {
  const key = canonicalize(idOrAlias);
  return AGENT_DOMAINS.find(
    (d) => d.id === key || d.aliases.some((a) => a === key) || d.channel === idOrAlias.toLowerCase()
  );
}

export function normalizeDomainKey(idOrAlias: string): string {
  return getAgentDomain(idOrAlias)?.id ?? canonicalize(idOrAlias);
}
