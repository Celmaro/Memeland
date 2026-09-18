# Memeland Architecture Comparison

## Purpose

This document compares the current Memeland implementation with the target architecture: a personal opportunity operating system that tracks opportunities from earliest discovery through research, decision, execution, holding, exit, and retrospective learning.

## Executive assessment

Memeland is currently approximately **30–40% aligned** with the target architecture.

> **Current Memeland:** multi-chain token discovery, filtering, 7-voter consensus, and basic position management.
>
> **Target architecture:** a complete opportunity lifecycle system from first discovery through execution, holding, attribution, and learning.

The current system has a solid discovery and screening foundation. The largest gaps are not more voters or data feeds; they are the missing opportunity ledger, identity graph, lifecycle state machine, and matched winner/failure learning loop.

## Capability comparison

| Target capability | Current Memeland | Completion |
|---|---|---:|
| Multi-chain, launchpads, social, trending, smart money, market signals | GMGN multi-chain, GeckoTerminal, X, Hyperliquid, DeFiLlama | 60% |
| Raw discovery layer | Rank, trenches, hot searches, and track feed | 40% |
| Global `first_seen` index | Dedupe and signal ledger exist, but no immutable global first-seen record | 10% |
| Unified producer | No central event-ingestion bus; agents produce signals directly | 20% |
| Discovery handoff | Prefilter, security audit, and consensus gate | 60% |
| Identity normalization / identity graph | Primarily chain + contract address; no project/entity graph | 15% |
| Nursery / continuous follow-through | No durable observation pool or candidate lifecycle | 15% |
| Research budget / action-first evaluation | ML, sentiment, and critic exist, but are mostly one-time assessments | 25% |
| Opportunity lifecycle state machine | Basic OPEN/TP/SL and scorecard only | 30% |
| Notification readiness / user interruption capacity | Dedupe and cooldown exist; no readiness/capacity layer | 30% |
| `REJECT` / `WATCH_TRIGGER` / `READY_SMALL_BET` states | Mostly passed/rejected; no complete decision-state model | 20% |
| Execution and capital decisions | Risk gate and EVM adapter exist, but multi-chain execution is inconsistent | 30% |
| Position monitoring, scaling, and exits | Wallet tracker and position manager exist | 45% |
| Outcome review | Scorecard and swarm-learning prototypes exist | 25% |
| Matched winner/failure samples | Not implemented | 0% |
| Miss attribution | Basic funnel counters only | 20% |
| Winner and failure-based learning | Not meaningfully implemented | 5% |

## Target architecture

```text
multi-chain sources
  -> raw discovery cache / global first_seen
  -> unified producer
  -> discovery handoff
  -> identity + risk + candidate selection
  -> nursery / continuous follow-through
  -> action-first research and odds evaluation
  -> lifecycle consumer
  -> readiness / notification capacity
  -> REJECT / WATCH_TRIGGER / READY_SMALL_BET / READY_FULL_REVIEW
  -> approval / execution / holding management
  -> winner + failure review
```

## What is already strong

### Multi-chain discovery foundation

The new architecture supports Solana, BSC, Base, Ethereum, and Robinhood, with integrations including:

- GMGN rank, trenches, and hot searches
- GeckoTerminal OHLCV
- X and on-chain social fields
- Smart-money and KOL activity
- Hyperliquid whale risk context
- DeFiLlama market-regime context

This is directionally aligned with multi-chain discovery, launchpad activity, social signals, trending lists, smart money, and market anomalies.

The limitation is that discovery is still mostly based on existing ranking and token endpoints. It is not yet a complete raw opportunity stream containing pool creation, launchpad, deployment, project, GitHub, official-event, and cross-source timeline data.

### Risk screening and consensus

The current runtime path is real:

```text
candidate
  -> liquidity / volume / market-cap prefilter
  -> GMGN security audit
  -> 7-voter swarm
  -> confidence >= 80
  -> risk engine
  -> signal
```

The seven voters are Quant, ML, Security, Sentiment, Whale, Regime, and Critic.

This is a useful risk and conviction layer. However, it mostly answers:

> Is this candidate worth posting right now?

The target system must also answer:

> When did the opportunity first appear, what changed, why did it become actionable now, and why was it not actionable earlier?

That requires lifecycle tracking in addition to scoring.

### Scorecard foundation

The current system records fired signals, entry price, current price, TP/SL state, win rate, and funnel counters. This is the beginning of outcome analysis.

The scorecard is currently a price-outcome tracker:

```text
signal fired
  -> price refreshed
  -> +50% = TP
  -> -20% = SL
```

It does not yet record the full opportunity decision chain: first discovery, source, state changes, voter changes, nursery entry, research decisions, notification decisions, execution availability, capital constraints, or the reason for a missed opportunity.

## Major architectural gaps

### 1. No global immutable `first_seen` layer

Dedupe, cooldowns, and the signal ledger are not equivalent to a global first-seen record.

The system needs a durable identity such as:

```ts
interface OpportunityIdentity {
  opportunityId: string;
  chain: string;
  contractAddress: string;
  firstSeenAt: string;
  firstSeenSource: string;
  firstSeenPriceUsd?: number;
  firstSeenMarketCapUsd?: number;
  firstSeenLiquidityUsd?: number;
}
```

An asset appearing later through GMGN, GeckoTerminal, smart-money feeds, social mentions, launchpad events, or official announcements should attach to the same `opportunityId`.

The current `chain + contractAddress` identity is enough for token deduplication, but not for an identity graph connecting tokens, projects, pools, wallets, launchpads, social accounts, and related contracts.

### 2. No nursery or continuous follow-through layer

The target flow is:

```text
discovery
  -> nursery
  -> continuous tracking
  -> additional research
  -> state upgrade
```

The current flow is closer to:

```text
discovery
  -> immediate filtering
  -> immediate scoring
  -> signal
```

A token may initially lack sufficient liquidity, volume, smart-money clustering, complete security data, or social traction. The target should preserve it and track state transitions such as:

```text
SEEN
  -> IDENTITY_RESOLVED
  -> RISK_SCREENED
  -> WATCHING
  -> ACCELERATING
  -> RESEARCH_READY
  -> ACTIONABLE
```

### 3. No complete lifecycle state machine

Current states are mainly `passed`/`rejected` and `OPEN`/`TP`/`SL`. The target needs separate discovery, opportunity, and capital states.

```text
Discovery:
  FIRST_SEEN, IDENTITY_PENDING, IDENTITY_CONFIRMED,
  RISK_PENDING, RISK_REJECTED, WATCHING

Opportunity:
  NO_EDGE, EARLY_SIGNAL, ACCELERATING, RESEARCH_REQUIRED,
  WATCH_TRIGGER, READY_SMALL_BET, READY_FULL_REVIEW, EXPIRED, MISSED

Capital / position:
  NO_POSITION, PENDING_APPROVAL, APPROVED, ENTRY_PENDING,
  OPEN, ADD_ALLOWED, REDUCE, EXIT_TRIGGERED, EXITED,
  RECONCILIATION_FAILED
```

These states should be changed by explicit lifecycle events rather than being scattered across agents, scorecards, messages, and position services.

### 4. No complete miss-attribution system

The system must distinguish whether an opportunity was not discovered, discovered late, identity-mismatched, filtered, not researched, not notified, not approved, not executed, or mishandled after entry.

Suggested outcome reasons:

```ts
type OpportunityOutcomeReason =
  | 'NOT_DISCOVERED'
  | 'DISCOVERED_LATE'
  | 'IDENTITY_UNRESOLVED'
  | 'RISK_REJECTED'
  | 'LIQUIDITY_REJECTED'
  | 'VOLUME_REJECTED'
  | 'CONSENSUS_REJECTED'
  | 'RESEARCH_BUDGET_EXHAUSTED'
  | 'NOT_NOTIFIED'
  | 'NOT_APPROVED'
  | 'EXECUTION_FAILED'
  | 'POSITION_EXIT_FAILED'
  | 'PROFITABLE_MISS'
  | 'CORRECT_REJECTION';
```

Without this layer, learning can become post-hoc storytelling based only on assets that later won.

### 5. No matched failure cohort

Current outcome tracking mainly records:

```text
fired signal -> later TP or SL
```

It does not compare winners with similar assets that failed. Every winner should eventually be compared with a cohort using the same chain, time window, market-cap bucket, liquidity bucket, discovery source, and similar risk profile.

This is necessary to determine why one asset succeeded while a comparable asset failed, which features were genuinely predictive, whether smart-money activity was accumulation or exit liquidity, and whether a filter removed good opportunities.

## Runtime issues that still need correction

### Approval architecture is not wired

The approval service and state-store structures exist, but the runtime still lacks:

- An `APPROVAL` execution mode
- Enqueue calls from the signal path
- Discord approval commands or buttons
- API approval endpoints
- Telegram approval callbacks
- An approved-fill ledger
- A caller for `canAutoExecute()`

The capital-decision layer is not yet present in the production flow.

### Discovery chain and execution chain are inconsistent

The system can discover assets across multiple chains, but the execution path still uses a hardcoded Robinhood chain. Multi-chain support currently means multi-chain signal input, not multi-chain execution.

If a chain has no execution adapter, the system should explicitly produce:

```text
DISCOVERED_ONLY
NOT_EXECUTABLE_ON_CURRENT_VENUE
```

It must not route that opportunity into a default Robinhood EVM execution path.

### Research is not yet continuous research

ML, sentiment, critic, and regime analysis are mostly evaluated during screening. The target needs research budgets and escalation policies:

```text
WATCHING:
  price / liquidity / smart-money updates

ACCELERATING:
  holder / pool / social / developer enrichment

RESEARCH_READY:
  critic and deeper LLM analysis

ACTIONABLE:
  capital decision
```

A research assessment should explain not only its score, but also the evidence it has, the evidence that is missing, and the next research action.

## Recommended implementation sequence

### Phase 1: Opportunity Ledger

Create immutable records for:

```text
opportunity
opportunity_observation
opportunity_event
opportunity_state_transition
```

Record the opportunity ID, chain, canonical address, first-seen timestamp, source, price, market cap, liquidity, raw observation, lifecycle state, rejection reason, and next review time.

### Phase 2: Identity and Lifecycle

Implement the lifecycle states above and require scanners, voters, and position managers to change state through lifecycle events.

### Phase 3: Discovery Handoff

Split the current screening agent into:

```text
raw discovery adapters
  -> unified producer
  -> discovery handoff
  -> identity / risk / dedupe
  -> nursery
```

`robinhood-screening-agent.ts` currently handles discovery, filtering, research, voting, thesis creation, lifecycle decisions, and dispatch. Those responsibilities should be separated.

### Phase 4: Research Budget and Readiness

Change voter output from only a score to an assessment containing score, confidence, evidence, missing evidence, next action, and expiry.

The key output should be:

> Why can’t we decide yet, and what evidence is needed next?

### Phase 5: Capital Decision and Execution

Implement explicit `READY_SMALL_BET`, `READY_FULL_REVIEW`, `APPROVAL_PENDING`, `APPROVED`, `EXECUTION_PENDING`, and `OPEN` states.

Strictly separate discovery chains from execution chains. A chain without an execution adapter must remain `SIGNAL_ONLY` or `DISCOVERY_ONLY` and must never default to Robinhood EVM.

### Phase 6: Counterfactual Review

Give every fired signal a comparable cohort based on chain, time window, market-cap bucket, liquidity bucket, discovery source, and risk profile. Review why winners succeeded, why matched failures failed, which gates helped or hurt, whether the opportunity was discovered early enough, and whether execution was actually possible.

## Final assessment

Memeland is moving in the right direction, but it is still primarily a:

```text
multi-chain screening and scoring engine
```

The target is a:

```text
personal opportunity operating system
```

The highest-value missing foundations are:

1. Global immutable `first_seen` ledger
2. Identity graph
3. Opportunity lifecycle state machine
4. Winner plus matched-failure attribution loop

Once these exist, the current GMGN, ML, sentiment, critic, regime, and smart-money modules can become components of a true opportunity operating system rather than isolated scoring modules.

## Verification basis

This comparison was based on the current repository architecture and runtime review. At review time, the repository test suite reported **295 passing tests across 38 test files**. The comparison intentionally documents architectural gaps; it does not claim that the target architecture is already implemented.