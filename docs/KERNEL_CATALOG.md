# Memeland — Kernel Catalogue

Where to find what. Every kernel is a named, tested unit with a single
responsibility. This catalogue is the operator/contributor map; keep it
in sync when kernels land.

Convention: kernels are named by letter. The 12-PR consolidation plan
([`implementation-plan-merge.md`](./implementation-plan-merge.md)) defined
A–G; the follow-up consolidation review
([`kernel-consolidation-opportunities.md`](./kernel-consolidation-opportunities.md))
added L–R. Files are listed with their primary public surface.

---

## Kernels (A–G, from the 12-PR plan)

| Kernel | Responsibility | File | Public surface | Key tests |
|---|---|---|---|---|
| **A** | Reputation Memory | `src/services/reputation-memory.ts` | reputation store/recall | `tests/reputation-memory.test.ts` |
| **B** | Swarm Consensus | `src/orchestrator/swarm-consensus.ts` | `SwarmConsensusEngine` (gate, votes, regime overlay) | `tests/swarm-consensus.test.ts`, `tests/swarm-voters.test.ts` |
| **C** | Decision Ledger | `src/services/decision-ledger.ts` | `globalDecisionLedger` (record/list) | `tests/decision-ledger.test.ts` |
| **D** | Sellability | `src/services/sellability/` | bytecode scanner + next-close simulator | `tests/sellability-*.test.ts` |
| **E** | Result\<T,E\> + EVM RPC two-lane | `src/adapters/result.ts`, `src/adapters/evm-adapter.ts`, `src/adapters/quoter-call-adapter.ts` | `Result` type, `call()` (read lane), quoter bridge | `tests/evm-adapter.v2.test.ts`, `tests/quoter-call-adapter.test.ts` |
| **F** | Decision Cache | `src/services/decision-cache.ts` | TTL decision cache | `tests/decision-cache.test.ts` |
| **G** | Discovery feeds | `src/adapters/codex-feed.ts`, `dexpaprika-feed.ts`, `dexscreener-feed.ts` | `MarketDataProvider` implementations | `tests/codex-feed.test.ts` + siblings |

## Kernels (L–R, from the consolidation review)

| Kernel | Responsibility | File | Public surface | Key tests |
|---|---|---|---|---|
| **L** | TtlCache | `src/cache/ttl-cache.ts` | `TtlCache<V>` (get/set/has/delete/clear, LRU cap, injectable clock) | `tests/ttl-cache.test.ts` |
| **M** | PacedHttpClient | `src/io/paced-http-client.ts` | `PacedHttpClient.pacedFetch()` (module-level queue + spacing) | `tests/paced-http-client.test.ts` |
| **N** | TryFetchJson | `src/io/try-fetch-json.ts` | `tryFetchJson<T>()` (fail-closed fetch→json) | `tests/try-fetch-json.test.ts` |
| **O** | StalenessClock | `src/clock/staleness-clock.ts` | `StalenessClock` (touch/isStale/ageMs) | `tests/staleness-clock.test.ts` |
| **P** | ChatNotifier | `src/notifications/chat-notifier.ts` | `ChatNotifier.post/snapshot/reset`, `discordChannelSink()` | `tests/chat-notifier.test.ts` |
| **Q** | ScreeningRunner | `src/runtime/screening-runner.ts` | `withScreeningTimeout()`, `ScreeningDeps` contract | `tests/screening-runner.test.ts` |
| **R** | WalletBalanceReader | `src/services/wallet-balance-reader.ts` | `WalletBalanceReader.getEvmBalance()`, `getEthEquivalentUsd()` | `tests/wallet-balance-reader.test.ts` |

## Standalone / cross-cutting (not letters)

| Unit | File | Notes |
|---|---|---|
| Operational funnel (7-stage) | `src/services/operational-funnel.ts` | `sourcesQueried → signalsEmitted → positionsMonitored` |
| Operational health (monitor-the-monitor) | `src/services/operational-health.ts` | provider/scheduler/delivery status, kill-switch, worker failures |
| Alert taxonomy | `src/notifications/alert-type.ts` | DISCOVERY / ENRICHMENT_CHANGE / CONSENSUS_PASS / RISK_WARNING / APPROVAL_REQUIRED / POSITION_EXIT |
| Task scheduler | `src/runtime/task-scheduler.ts` | overlap-protected runtime scheduler |
| Lifecycle state machine | `src/lifecycle/state-machine.ts` | position lifecycle transitions |
| Atomic file store | `src/storage/atomic-file-store.ts` | tmp+rename persistence (used by nonce store, ledger) |
| Call policy | `src/io/call-policy.ts` | rate-limit / retry policy helpers |
| API key pool | `src/services/api-key-pool.ts` | `fetchWithKeyPool` + rotation |
| RPC failover | `src/services/rpc-failover.ts` | `globalRPCFailoverManager.getActiveRPC('evm')` |
| Startup pipeline | `src/startup/{bootstrap,integrations,risk,shutdown,screening-scheduler}.ts` | boot wiring; `startRuntimeMonitoring` is the live loop entry |

## Invariants

- Every kernel ships with tests; a kernel with zero tests is a stub, not a kernel.
- **G1:** additive-only — kernels never change existing signatures.
- **G6 (cache/timeout kernels):** semantics preserved bit-for-bit across refactors.
- **G7 (ScreeningRunner):** the live screening-cycle extraction is shadow-mode only
  (`ScreeningDeps` contract in `src/runtime/screening-runner.ts`).
- Balance-reader default chain: `4663` (Robinhood Chain) — see
  `src/services/wallet-balance-reader.ts` `DEFAULT_BALANCE_CHAIN_ID`.
