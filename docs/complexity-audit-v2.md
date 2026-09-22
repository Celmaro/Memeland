# Memeland complexity-reduction audit — v2

**Anchor:** master @ `21f35e7` (post-KC1–KC9 consolidation). **130 source files / 25,370 LOC src.** **124 test files / 912 tests green.** `npx tsc --noEmit` clean.

**Delta since v1** (`a9c1e34`, 102 files / 792 tests): **+23 src files, +6,557 LOC (~35% growth), +22 test files, +120 tests.** The codebase grew a lot — multi-chain execution, operational funnel/health, swarm expansion — so this audit re-measures where complexity *currently* concentrates, not where it was.

## Part 1 — 12-PR plan vs current state

**Verdict: 12/12 landed.** v1 flagged PR 2 (Kernel E) as the one outstanding gap; it has since been closed (G2 deprecation complete — `callLegacy` throw-shim removed, evm-adapter's `request()` returns `{ ok: false, error }` instead of throwing, `quoter-call-adapter.ts` bridges to the legacy contract).

| PR | Kernel / Standalone | Status (21f35e7) | Evidence |
|---|---|---|---|
| 1 | C: Decision Ledger | **DONE** | `services/decision-ledger.ts` + tests |
| 2 | E: `Result<T,E>` + EVM RPC two-lane | **DONE** (closed since v1) | `evm-adapter.ts:261` "G2 deprecation complete"; `callLegacy` removed; `quoter-call-adapter.ts` bridge |
| 3 | B: Swarm Consensus golden-master | **DONE** (additive) | `swarm-guards.ts`, `aggregateVoterScores` intact |
| 4 | A: Reputation Memory | **DONE** | `reputation-memory.ts` (now uses `atomic-file-store.ts`) |
| 5 | F: Decision Cache | **DONE** | `decision-cache.ts` — `getSticky`/`getImmutable` present |
| 6 | D: Sellability + Bytecode | **DONE** | `services/sellability/` + `bytecode-scanner.ts` |
| 7 | Standalone codex + dexpaprika feeds | **DONE** | both tested |
| 8 | Next-close simulator + backtest metrics | **DONE** | `next-close-simulator.ts`, `learning-harness.ts` |
| 9 | Risk profile + sizing (shadow-mode) | **DONE** (shadow-mode active) | `risk-profile` gates log, don't enforce |
| 10 | Wallet-tracker extensions | **DONE** | `wallet-tracker.ts` (760 LOC — see Part 3) |
| 11 | QLO time-on-curve + hesitation memory | **DONE** | `CopyTradeHesitation` (in wallet-tracker.ts) |
| 12 | 10 Adapt-only micro-PRs | **DONE** | figure-grounding, autohedge-division, garch, fdv-hwm-exit, etc. |

## Part 2 — Where complexity lives now

The v1 monolith list (`index.ts` 753 / `position-manager.ts` 606 / `hub.ts` 450 / `voters.ts` 293) is **stale in 3 of 4 files**:

| File | v1 LOC | v2 LOC | Δ |
|---|---|---|---|
| `src/index.ts` | 753 | **761** | +8 (still a monolith) |
| `src/position/position-manager.ts` | 606 | **431** | −175 (slimmed organically) |
| `src/orchestrator/hub.ts` | 450 | **261** | −189 (slimmed organically) |
| `src/orchestrator/voters.ts` | 293 | **475** | +182 (grew — see Part 7) |

**Top-15 heaviest files now:**

| File | LOC | Role |
|---|---|---|
| `src/adapters/gmgn-adapter.ts` | **882** | biggest file in repo: discovery/security/track/rank/signals + key-pool + pacing + cache |
| `src/index.ts` | 761 | boot monolith; screening-cycle closure still inline (lines 247–646, ~400 lines) |
| `src/services/wallet-tracker.ts` | **760** | **3 classes in one file**: WalletTracker, CopyTradeHesitation, BalanceBatchReader |
| `src/agents/meme-robinhood/robinhood-screening-agent.ts` | 718 | screening agent: discovery+enrich+audit+signal |
| `src/orchestrator/tool-registry.ts` | 697 | LLM tool surface |
| `src/adapters/lifi-executor.ts` | 629 | execution: quote/build/broadcast/status/nonce-store |
| `src/discord/handlers/command-handlers.ts` | 552 | slash-command surface |
| `src/services/ai-service.ts` | 528 | LLM calls |
| `src/agents/shared/gmgn-meme-helpers.ts` | 514 | GMGN helpers |
| `src/services/state-store.ts` | 502 | persistence |
| `src/adapters/evm-adapter.ts` | 478 | RPC two-lane |
| `src/orchestrator/voters.ts` | 475 | 10-voter swarm (was 7) |
| `src/orchestrator/learning-harness.ts` | 468 | backtests |
| `src/orchestrator/strategy-engine.ts` | 463 | strategy worker |
| `src/orchestrator/risk-engine-v2.ts` | 447 | risk |

The 15 heaviest files ≈ **~9,500 LOC ≈ 37% of the codebase**. The concentration shifted from *kernels* to the *adapter/data layer*: 6 of the top 15 are adapters/agents (GMGN, wallet-tracker, robinhood-agent, lifi, evm, gmgn-helpers).

## Part 3 — Kernel opportunities (v2)

### Kernel S — Boot composition (the remaining slice of v1's Kernel G)

KC6 shipped the **timeout primitive + `ScreeningDeps` contract** (`src/runtime/screening-runner.ts`) but deliberately **not** the closure extraction (G7 shadow-mode gate). The result: `runScreeningCycle` is still a ~400-line inline closure at `src/index.ts:247–646`, capturing ~15 module-scope variables — still the single hardest-to-test block in the repo.

**Now low-risk:** the dependency list is already documented in `ScreeningDeps`. The work is mechanical: move the closure body into `runScreeningCycle(deps)`, leave `index.ts` as the assembly point.

`src/index.ts` 761 → ~150 LOC. **Net −300+ LOC, one new testable surface.**

### Kernel T — WalletTracker split (760 LOC, 3 classes)

`wallet-tracker.ts` holds `WalletTracker` (line 53), `CopyTradeHesitation` (390), `BalanceBatchReader` (672) — three unrelated lifecycle/heuristic concerns sharing a file for no coupling reason. Each is independently testable:

```text
src/services/wallet-tracker.ts        — WalletTracker only (position mirroring)
src/services/copy-trade-hesitation.ts — CopyTradeHesitation (QLO time-on-curve)
src/services/balance-batch-reader.ts  — BalanceBatchReader
```

**Net −0 LOC, but 3 testable units instead of 1 class-that-is-also-a-file.**

### Kernel U — GMGN adapter split (882 LOC, biggest file)

`gmgn-adapter.ts` mixes: discovery (`fetchRank`/`fetchTrenches`), security (`fetchTokenSecurity`), track (`fetchTrackTrades`), single-token (`fetchTokenInfo`/`fetchTokenKlines`), signals (`fetchTokenSignals`/`fetchHotSearches`/`fetchTrendingSignals`), plus the key-pool rotation (`gmgnRequest`, 225–452 — ~230 lines of retry/pacing/key-rotation before the first public method even ends) and the TtlCache wiring. 15 public methods, one file.

```text
src/adapters/gmgn-adapter.ts        — implements MarketDataProvider.discover (rank/trenches/discovery)
src/adapters/gmgn-rest-client.ts    — gmgnRequest: key-pool, pacing, retry, 429 rotation
src/adapters/gmgn-security.ts       — fetchTokenSecurity + audit normalization
src/adapters/gmgn-track.ts          — fetchTrackTrades
src/adapters/gmgn-signals.ts        — klines/signals/hot/trending
```

**Net −0 LOC, biggest file in repo becomes 5 focused files; the REST client alone is reusable.**

### Kernel V — RobinhoodScreeningAgent split (718 LOC)

`robinhood-screening-agent.ts` chain: discovery → enrich → audit → funnel → signal emit, all in one class. v1's funnel work already produced `operational-funnel.ts` counters — the agent can be split into discovery/enrichment/audit passes without touching behavior.

### Kernel J (v1) — MOOT

v1 proposed extracting "legacy fallback paths" from `voters.ts` (293 LOC). Current `voters.ts` (475 LOC) has **zero legacy matches** — the growth is the swarm going 7 → **10 voters** (added `wallet`, `convergence`, `rubric`; see header comment lines 1–20). There is no cruft to extract; the file is the canonical weighted-average surface. **Drop Kernel J.**

## Part 4 — Quick wins (< 100 LOC each, verified open)

| Win | Where | Status |
|---|---|---|
| **Move `strategistSightingFrom` to opportunity-ledger.ts** | `src/index.ts:118` | still inline v1 → v2; domain mapping belongs next to the ledger |
| **Replace bespoke `recentSignals` Map with `DecisionCache.getSticky`** | `src/index.ts:237` | `getSticky` exists (decision-cache.ts:58) and is **unused in index.ts** — v1 flagged this; still open |
| **Route `state-store.ts` atomic writes through `atomic-file-store.ts`** | `state-store.ts` (502 LOC) | `opportunity-ledger` + `reputation-memory` already adopted the atomic-file-store primitive (6 importers); state-store still hand-rolls 2× writeFileSync-tmp/rename |
| ~~Collapse controlRoomNotifyCooldown~~ | — | **DONE** — KC5 ChatNotifier (`notifications/chat-notifier.ts`) |
| ~~Move withScreeningTimeout~~ | — | **DONE** — KC6 (`runtime/screening-runner.ts`) |
| ~~Retain scheduler stop handle~~ | `index.ts:651,751,758` | **DONE** — `runtimeStop` assigned and called on shutdown via `shutdown.ts` hooks stop() |

## Part 5 — Recommended execution order

1. **Quick wins** (Part 4) — single PR, no risk, all verified open today.
2. **Kernel S — boot composition** — deps already contracted by KC6; the largest remaining single-file reduction.
3. **Kernel T — wallet-tracker split** — pure file split, no behavior change.
4. **Kernel U — GMGN split** — biggest-file-in-repo reduction; REST-client extraction is the high-value seam.
5. **Kernel V — robinhood-screening-agent split** — last; touches the discovery hot path.

**Estimated reduction if S + T + U land:**

| Metric | Current | After | Δ |
|---|---|---|---|
| `index.ts` | 761 | ~150 | −80% |
| `wallet-tracker.ts` | 760 | ~330 | −57% |
| `gmgn-adapter.ts` | 882 | ~250 | −72% |
| Biggest file in repo | 882 | ~430 | −51% |

## Part 6 — Risks

- **Kernel S (boot)** — the only live production loop (screening cycle). G7 applies: move the closure verbatim, no restructuring; shadow-mode smoke one deploy cycle. This is the risk v1 called "PR 9 shadow-mode" — now it lands as a *plain extraction* because KC6 already froze the contract.
- **Kernel U (GMGN)** — the `gmgnRequest` retry/rotation block (lines 225–452) is the most behavior-dense code in the adapter. Extract it byte-for-byte first (REST client), then split public methods. 429-rotation and key-pool semantics must not change.
- **Kernel V** — discovery hot path; keep `MarketDataProvider` contract (`discover`) stable.

## Part 7 — What v1 got wrong (and right)

- **Wrong — the monolith list.** 3 of 4 flagged files are no longer the story: `position-manager.ts` slimmed 606→431 without the proposed `exit-plan.ts`/`exposure.ts` split (those files don't exist — it slimmed organically), `hub.ts` slimmed 450→261 without `domain-state.ts`, and `voters.ts` **grew** 293→475 because the swarm went 7→10 voters. The proposed Kernel G/H/I/J modules (`startup/screening-cycle.ts`, `exit-plan.ts`, `exposure.ts`, `domain-state.ts`, `voter-legacy.ts`, `security-voter.ts`) **were never created** — yet 3 of the 4 files shrank anyway, and the one that grew is not cruft.
- **Wrong — "PR 2 is the outstanding gap."** PR 2 (Kernel E) has since closed completely; the plan is 12/12.
- **Missed — the adapter/data layer.** v1 sized kernels and missed where complexity was flowing: 6 of the top-15 files today are adapters (GMGN 882, wallet-tracker 760, robinhood-agent 718, lifi 629, evm 478, gmgn-helpers 514). The consolidation lens needs to point at data-layer seams now, not orchestration.
- **Right — Kernel K (PersistentJSON).** v1 predicted a shared atomic-persistence primitive; it landed as `src/storage/atomic-file-store.ts` and is already adopted by 6 modules (ledger, reputation-memory, cron-scheduler, execution-gates, strategy-engine, swarm-learning). The remaining gap is `state-store.ts` still hand-rolling its own writes.
- **Right — golden-master discipline.** The plan's G3 (verify-before-move) is exactly why KC1–KC9 and the 12 PRs shipped without regressions through +120 tests of growth.

**TL;DR:** The plan is 12/12 landed and v1's four-monolith thesis is mostly resolved by the codebase itself. Remaining complexity lives in the **data-adapter layer** (GMGN 882, wallet-tracker 760, robinhood-agent 718) plus the **boot monolith** (index.ts 761, screening-cycle closure still inline at lines 247–646). Four new additive kernels (S/T/U/V) with ~5 quick wins could cut the biggest file by half and the boot monolith by 80%, with Kernel S now low-risk because KC6 already froze the screening-cycle contract.