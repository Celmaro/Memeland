export type AgentDomainId =
  | 'meme-robinhood'
  | 'alpha-robinhood';

export type AgentCategory = 'MEME' | 'ALPHA';

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
    // P1.2 — the screening cycle derives a PER-CHAIN AUTO domain (`meme-${chain}`)
    // so a signal on sol/bsc/base/eth can execute independently. Those keys must
    // normalize to THIS domain, otherwise hub.isAutoExecuteEnabled('meme-sol')
    // misses the map the operator actually toggles and silently returns
    // {enabled:false} — making every non-robinhood chain structurally unable to
    // auto-execute no matter what the operator set. Bare chain aliases
    // ('sol','base','bsc') are kept, and 'eth'/'ethereum' added for symmetry.
    aliases: [
      'robinhood', 'evm', 'evm-meme', 'meme-evm', 'meme',
      'sol', 'solana', 'base', 'bsc', 'bnb', 'eth', 'ethereum',
      'meme-robinhood', 'meme-sol', 'meme-solana', 'meme-bsc', 'meme-bnb',
      'meme-base', 'meme-eth', 'meme-ethereum',
    ],
    // Screening and discovery are deterministic (GMGN/Gecko/GoPlus). AI_API_KEY is
    // only consumed by the critic/sentiment LLM voters, which fail open to a
    // neutral vote — a missing key must never halt the screening pass.
    requiredKeys: [],
    category: 'MEME',
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
