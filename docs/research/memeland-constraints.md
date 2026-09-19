# Memeland End-to-End Constraints

This is the baseline used to judge every external repository, API, tool, or
architecture. A source is green only when it improves the personal bot's edge
without creating disproportionate operational, dependency, or safety risk.

## Product and operating model

- Personal-use autonomous crypto intelligence and trading bot.
- Primary objective: improve opportunity discovery, signal quality, execution
  quality, risk control, and learning speed; not maximize feature count.
- Primary venue: Robinhood Chain EVM, chain ID `4663`, native ETH; multi-chain
  feeds exist for Solana, BSC, Base, and Ethereum.
- Human control surfaces: Discord, Telegram, terminal TUI, and loopback REST.
- Live trading is possible, but dry-run and fail-closed behavior are required
  for anything that can submit a transaction.

## Current technical shape

- Node.js `>=20`, TypeScript, ESM, npm, `tsc`, and Vitest.
- Five specialist domains plus shared orchestration: meme, LP, NFT, alpha/
  sentiment, and ETH whale tracking.
- Seven-voter consensus: quant, ML, security, sentiment, whale, regime, and
  critic; consensus gate is normally `>=80`.
- Risk layers: `RiskManager`, `RiskEngineV2`, exposure/correlation checks,
  approval queue, kill-switch, and the decoupled `MarketSentinel`.
- Persistent state: signal ledger, opportunity ledger, trade journal, wallet
  tracker, and swarm-learning weights.
- Shared services include price feeds, market regime, bot detection, rug
  scoring, RPC failover, API-key pools, health watcher, alerts, and scheduling.

## Data and dependency constraints

- GMGN is currently the primary source for token ranking, trenches, token
  metadata, smart-money/KOL flows, and token security fields.
- GMGN has explicit pacing, caching, key rotation, and rate-limit behavior;
  any new GMGN consumer must use the shared adapter or preserve equivalent
  controls.
- GoPlus, GeckoTerminal, DeFiLlama, Hyperliquid, DexScreener, OpenSea,
  Krystal, X, Uniswap, Relay, and RPC providers are complementary sources.
- Provider independence is valuable: a source that confirms GMGN data or works
  during GMGN outages has higher strategic value than another GMGN wrapper.
- API keys, RPC URLs, private keys, webhooks, and bot credentials are live
  operational dependencies. Copied code must not expose or persist them.

## Edge requirements

An improvement should measurably help at least one of:

1. Earlier detection of new, high-quality opportunities.
2. Better distinction between organic flow and bots, bundles, rugs, or wash
   trading.
3. Better wallet/whale attribution and copy-trade timing.
4. Better execution price, fill reliability, or chain-specific routing.
5. Faster reaction to regime changes or flash crashes.
6. More reliable post-trade attribution and learning without double counting.
7. Independent data coverage that reduces correlated blind spots.

“More AI” or “more agents” is not an edge by itself.

## Placement and migration constraints

- A service may move from an agent to another agent only when its data ownership,
  latency, lifecycle, and failure behavior become clearer—not merely to make a
  diagram look cleaner.
- Cross-agent capabilities should become shared services when multiple domains
  need the same normalized data, cache, rate limit, or safety decision.
- Discovery belongs near market-data adapters; security belongs before
  consensus; execution belongs behind approval/risk gates; learning belongs
  after a verified outcome.
- Moving a service must preserve auditability, testability, and the existing
  fail-closed execution gate.

## Complexity and resource limits

- The bot runs as a practical personal deployment, not a distributed platform.
- New services must justify memory, CPU, startup, network, and maintenance
  cost. Heavy frameworks are not automatically better than focused modules.
- Prefer deterministic local calculations and cached/batched reads over adding
  an LLM or high-frequency provider call.
- Avoid duplicate schedulers, duplicate caches, uncontrolled fan-out, and
  another orchestration layer unless it removes more complexity than it adds.
- Research cloning is bounded to small batches; external repositories are
  temporary inputs and must be deleted after extraction.

## Security and safety constraints

- Never copy private-key handling blindly. Treat every transaction, wallet,
  subprocess, shell command, and remote tool as high risk.
- Untrusted market text, social posts, repository content, and LLM output must
  never directly control execution or configuration.
- New data sources fail soft for intelligence but fail closed for security and
  execution decisions.
- Kill-switches must operate outside individual signal optimism and must remain
  observable and testable.
- Personal use permits practical code copying for this review, but copied
  code still receives a security audit before it can run with keys.

## Green-label definition

### Adopt — green

Copy or integrate now when the component has clear edge value, is small enough
to operate, fits the current safety model, and can be validated offline or in
dry-run.

### Adapt — green with work

Copy the implementation or pattern after porting, hardening, chain adaptation,
or moving it behind a Memeland boundary. It must have a concrete integration
owner and validation plan.

### Study — yellow

Keep the idea, algorithm, architecture, or research finding for later. It is
not yet justified for the live bot or its evidence is incomplete.

### Skip — red

Do not spend integration effort: duplicate, too heavy, stale, unsafe, too
provider-dependent, operationally expensive, irrelevant, or not demonstrably
better than current code.

Each finding will additionally answer: **copy what, where does it belong, what
does it cost, what dependency does it add/remove, and how will we measure the
edge?**
