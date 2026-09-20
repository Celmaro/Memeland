# Memeland - Implementation Queue (Adopt/Adapt, test-first)

Status: **tracker, test-first. Phases 1-5 implemented (Q01-Q16) + Solana copy-trade + RH execution-core landed, all tests green.**

Scope: turns the Adopt/Adapt verdicts from
[`docs/research/memeland-ecosystem-review.md`](./research/memeland-ecosystem-review.md)
section 14 (262-source deep-read) into a prioritized, **test-driven** queue
mapped to concrete modules. Each item is an independently executable chunk that
lands behind the existing Vitest suite.

> Guiding rules (from `AGENTS.md` + `docs/research/memeland-constraints.md`):
> one verifiable unit per item, **failing test first**, low-GMGN-coupling and
> chain-portable (green-label bar), fail-closed by default, personal-use scale
> (no gold-plating), never expose or persist secrets.
>
> **Verify after every item:** `npm test` (Vitest; currently **66 test files / 509 tests green**) and `npx tsc --noEmit` (0 errors). Push when the user asks.

## How to run the suite and contribute tests

- Run all: `npm test`
- Run one file: `npx vitest run tests/<file>.test.ts`
- Typecheck: `npx tsc --noEmit`
- Test convention: co-located `tests/*.test.ts` at repo root, plain `.js`
  imports into `src/**` (ESM). See `tests/risk-manager.test.ts` and
  `tests/opportunity-post-mortem.test.ts` for the style.
- TDD loop per item:
  1. Write the failing test(s) named for the behavior (e.g. `tests/fill-simulation.test.ts`).
  2. Confirm they fail for the right reason (a real gap, not a stub).
  3. Implement the smallest module change that turns them green.
  4. Re-run the full suite + `tsc --noEmit` before moving on.

## Priorities

Order is by **strategic value x dependency**. Foundation items that unblock
honest validation of later learning items come early. Each item is marked
P0 / P1 / P2.

---

## Phase 1 - SDK / GATE FOUNDATION (do first)

### Q01. Anti-overfit learning harness (P0) - *gate for all new learning*
- **SRC refs:** SRC-236 (`ai-quant-researcher`); supports SRC-143 (Q10) and any later learning feed.
- **Target module:** new `src/orchestrator/learning-harness.ts` (pure, zero-dep) + call site.
- **Why first:** SRC-236's harness (deflated Sharpe with honest trial count,
  purged CV + embargo, structural/correlation leakage detection, **latched
  kill-switch**, round-turn cost + sqrt-impact TCA) is the honest evaluator
  every later learning/calibration item must be validated against.
- **Change:** add a stateless TS harness: `deflatedSharpe(trials, ...)`,
  `purgedCV(returns, embargo)`, `leakageDetector(features, target)`,
  `latchedKillSwitch(cfg)` (persists killed state across restart), and
  `tca(fillPrice, midPrice, side, data)`.
- **Acceptance (failing first):** `tests/learning-harness.test.ts`
  - deflated Sharpe penalizes a low trial count vs. a naive Sharpe,
  - purged CV drops samples within the embargo gap of the test fold,
  - leakage detector flags a feature that embeds the target,
  - latched kill-switch stays engaged across a simulated restart,
  - TCA reports a negative basis vs. mid when the fill crosses.
- **Verify:** `npm test` + `npx tsc --noEmit`.

### Q02. Latched kill-switch hardening (P0) - *fail-closed across restart*
- **SRC refs:** SRC-236 (latched kill-switch); FARSIGHT audit section 2 gap
  (in-memory kill-switch is fail-open on restart).
- **Target module:** `src/orchestrator/risk-engine-v2.ts` (`RiskEngineV2`).
- **Change:** persist `isKillSwitchActive` (optionally via `StateStore`) so a
  restart cannot silently resume trading after a trip + cooldown; keep
  `resetKillSwitch()` explicit and actor-driven.
- **Acceptance (failing first):** `tests/risk-engine-v2-latched.test.ts` - after
  `activateKillSwitch(reason)`, a new engine built over the same store still
  reports the kill-switch engaged until `resetKillSwitch()`.
- **Verify:** `npm test` + `npx tsc --noEmit`.

---

## Phase 2 - DISCOVERY & CHAIN-INDEPENDENCE (green-label levers)

### Q03. GMGN wallet-scoring -> whale-voter uplift (P0) - *fastest lever*
- **SRC refs:** SRC-001/002/100/101; SRC-081 (weighted scoring, smart-wallet participation, holder concentration).
- **Target module:** `src/services/wallet-tracker.ts` / `wallet-service.ts`,
  `src/orchestrator/voters.ts` (`whaleVote`).
- **Change:** port GMGN smart-money ranking fields (alpha, concentration, tag,
  track-trade flows) into a deterministic per-token wallet-score fed into
  `whaleVote`, with fail-closed handling of missing fields.
- **Acceptance (failing first):** `tests/whale-scoring.test.ts`
  - a higher GMGN wallet-score raises the whale voter score monotonically,
  - missing/NaN wallet fields degrade to a neutral baseline (never a false win),
  - concentration/hold-duration inputs move the score as documented.
- **Verify:** `npm test` + `npx tsc --noEmit`.

### Q04. RH-native RPC fill tape + wallet resolution (P1) - *independent confirmation path*
- **SRC refs:** SRC-070/076/117 (RH chain tape); SRC-072 (batch RPC holdings +
  chain/alias config, cache/in-flight dedupe).
- **Target module:** `src/adapters/evm-adapter.ts` + new `src/adapters/rh-fill-tape.ts`.
- **Change:** add a Robinhood-Chain (4663) fill-tape reader + wallet address
  resolution that confirms GMGN track-trade data over local RPC (batch balance
  reads, address-to-label mapping, cache + in-flight dedupe) as an
  **independent** confirmation signal, not a replacement.
- **Acceptance (failing first):** `tests/rh-fill-tape.test.ts`
  - tape returns a bounded, ordered fill window with chain/address scoping,
  - wallet resolution caches and dedupes concurrent lookups (one in-flight),
  - a tape gap behaves fail-open (unknown, never a false confirmation).
- **Verify:** `npm test` + `npx tsc --noEmit`.

### Q05. Accumulation + convergence heuristic (P1) - *organic-flow edge*
- **SRC refs:** SRC-038 (wallet-convergence-alert), SRC-080 (rugchecker),
  SRC-210 (timed N-wallet convergence signal, WS balance-delta buys).
- **Target module:** new `src/services/flow-convergence.ts` + voter inputs in
  `src/orchestrator/voters.ts`.
- **Change:** a deterministic, chain-portable accumulation/convergence scorer
  (N wallets accumulating within a window, balance-delta buys) feeding voters;
  fail-closed and config-capped.
- **Acceptance (failing first):** `tests/flow-convergence.test.ts`
  - N distributed buys within the window raise the convergence score,
  - a single high-balance whale does not independently count as convergence,
  - stale or sparse windows score neutral (never a false positive).
- **Verify:** `npm test` + `npx tsc --noEmit`.

### Q06. Keyless DexScreener multi-chain feed (P1) - *reduce GMGN coupling*
- **SRC refs:** SRC-222 (dexscraper), SRC-025 (DexScreener docs), SRC-010 (dexpaprika), SRC-023 (codex.io GraphQL).
- **Target module:** new `src/adapters/dexscreener-feed.ts` + a shared
  `src/adapters/market-data-provider.ts` interface.
- **Change:** a keyless multi-chain DexScreener client (filter/rank param
  encoding, discovery presets, rate-tier + batch-aware fetch, TTL cache)
  behind a small provider interface so GMGN is one of several interchangeable
  paths.
- **Acceptance (failing first):** `tests/dexscreener-feed.test.ts`
  - returns normalized tokens for RH/BSC/Base/Solana,
  - respects a TTL cache (no duplicate fetch within TTL),
  - a stub provider can replace DexScreener (proves decoupling).
- **Verify:** `npm test` + `npx tsc --noEmit`.

---

## Phase 3 - RISK / SIZING / EXEC

### Q07. Multi-constraint sizing + layered risk gate (P0)
- **SRC refs:** SRC-190 (COPUMP layered risk-gate + multi-constraint sizing,
  zero-dep, chain-agnostic), SRC-189 (daily-loss halt/cooldown, fail-closed rules).
- **Target module:** `src/orchestrator/risk-engine-v2.ts`,
  `src/orchestrator/risk-manager.ts`, wiring in `src/services/approval-execution.ts`.
- **Change:** add a pure `sizePosition` multi-constraint floor-min gate
  (maxNotional, daily-loss headroom, min/max range) and a `RuleGate`
  fail-closed chain (`UNKNOWN` refusal) reused by approval auto-execution;
  rework notional caps to RH 4663.
- **Acceptance (failing first):** `tests/position-sizing.test.ts`
  - size collapses to the most restrictive constraint,
  - a single failed gate refuses execution (fail-closed), UNKNOWN never auto-approves,
  - cooldown/daily-loss halts suppress new sizing for the window.
- **Verify:** `npm test` + `npx tsc --noEmit`.

### Q08. Fill-simulation (pool-depth impact) (P1)
- **SRC refs:** SRC-213 (slippage-impact fill simulation), SRC-187 (bonding-curve/AMM simulate + curve quote math).
- **Target module:** new `src/services/fill-simulation.ts`.
- **Change:** a pure splash model computing price impact + expected slippage
  from on-chain depth, plus a simple paper-broker fill engine behind the
  approval gates (mark fill, log slip, never submits).
- **Acceptance (failing first):** `tests/fill-simulation.test.ts`
  - larger notional -> larger impact and worse fill, monotonically,
  - zero/illiquid depth -> refusal (fail-closed), not best-effort,
  - paper fill records slip vs. mid and never touches a live executor.
- **Verify:** `npm test` + `npx tsc --noEmit`.

### Q09. Executor-DI + veto-with-reason + serialization (P1)
- **SRC refs:** SRC-227/230 (executor-interface DI, veto-with-reason filters,
  fail-closed TP/SL+timeout, one-token serialization), SRC-180 (fast-submit seq, txlock).
- **Target module:** new `src/position/executor.ts` + refactor of
  `src/services/approval-execution.ts`.
- **Change:** introduce a `TransactionExecutor` interface (mockable) with
  veto-with-reason checks (per-token concurrency, consecutive-fail gate,
  timeout) and a serialized per-token queue; route fills through it.
- **Acceptance (failing first):** `tests/executor.test.ts`
  - veto carries a reason record and blocks the fill,
  - only one in-flight tx per token (serialization),
  - a timed-out fill is marked failed and gated (no silent retry).
- **Verify:** `npm test` + `npx tsc --noEmit`.

### Q10. Scoring-calibration (IC + Platt + regime/abstain + walk-forward) (P1)
- **SRC refs:** SRC-143 (scoring-calibration); validated through Q01.
- **Target module:** `src/orchestrator/swarm-learning.ts` (currently outcome-only
  `recalibrateWeights`), `src/orchestrator/swarm-consensus.ts`.
- **Change:** add IC-weight learning per voter, Platt calibration to map raw
  scores to probabilities, regime-conditioned abstain gating, and a walk-forward
  split for validation; feed results through the Q01 harness.
- **Acceptance (failing first):** `tests/swarm-calibration.test.ts`
  - higher-IC voters get proportionally larger weight deltas,
  - Platt-calibrated confidence stays in [0,1] and is rank-preserving,
  - an abstain regime returns a neutral vote (does not raise consensus),
  - the walk-forward split keeps the validation fold leak-free.
- **Verify:** `npm test` + `npx tsc --noEmit`.

---

## Phase 4 - EXECUTION-GOVERNANCE & RISK RUBRIC

### Q11. Execution-governance (idempotent reservation, hash-locked receipt, deny-first RBAC) (P1)
- **SRC refs:** SRC-154 (tradingcodex), SRC-153 (paper-first/kill-switch/audit loop).
- **Target module:** `src/services/approval-queue-service.ts`,
  `src/services/approval-execution.ts`.
- **Change:** idempotent order reservation (same payload cannot double-approve
  or execute), payload-hash-locked approval receipts (a receipt is valid only
  for its exact order), append-only audit events, and deny-first capability RBAC.
- **Acceptance (failing first):** `tests/exec-governance.test.ts`
  - re-approving the same nonce/payload is a no-op (idempotent),
  - a receipt hash mismatched against the order payload is rejected,
  - an unlisted capability is refused by default (deny-first).
- **Verify:** `npm test` + `npx tsc --noEmit`.

### Q12. Portable risk rubric + security-voter uplift (P1)
- **SRC refs:** SRC-084 (portable risk rubric), SRC-166 (weighted safety-score,
  missing-data-never-clean), SRC-105 (concentration/spike/volatility/liquidity metrics).
- **Target module:** `src/services/rug-scoring.ts`, `src/orchestrator/voters.ts`
  (`securityVote`).
- **Change:** add an explicit, explainable risk-rubric record (weighted factors +
  per-factor deductions + overall + `expiresAt`) and fold SRC-105 metrics into
  the security voter, all deterministic and missing-data-fail-open-to-caution.
- **Acceptance (failing first):** `tests/security-rubric.test.ts`
  - rubric lists per-factor deductions and an overall score,
  - a missing required factor cannot yield a clean score,
  - concentration/spike/volatility inputs move the security verdict as documented.
- **Verify:** `npm test` + `npx tsc --noEmit`.

### Q13. Cost-gated throttling + cross-market sizing (P1) - *wave-5*
- **SRC refs:** SRC-262 (grok-trading-desk: fail-closed vetoes, cross-market
  sizing, cost-gated throttling), SRC-261 (FLYWHEEL propose-vs-decide risk arch).
- **Target module:** `src/services/approval-execution.ts`, `src/orchestrator/risk-manager.ts`.
- **Change:** a fee/cost budget that throttles auto-execution when cumulative
  fill cost exceeds a config cap, and sizing that considers correlated
  cross-market exposure rather than per-token only.
- **Acceptance (failing first):** `tests/cost-gating.test.ts`
  - exceeding the cumulative cost cap blocks further auto-execution,
  - correlated exposures sum against a shared cap (cross-market),
  - the reset is explicit (matching the risk layer's explicit-reset convention).
- **Verify:** `npm test` + `npx tsc --noEmit`.

### Q14. Walk-forward GARCH(1,1) + vol-target sizing (P2) - *wave-5*
- **SRC refs:** SRC-150 (garchmethod -> walk-forward GARCH(1,1) + vol-target sizing).
- **Target module:** `src/services/technical-indicators.ts`,
  `src/orchestrator/risk-engine-v2.ts` (uses ATR today).
- **Change:** optional add (only if the harness shows value) of a walk-forward-fit
  GARCH(1,1) vol estimate and a vol-target sizing override, validated through Q01
  before any live gate.
- **Acceptance (failing first):** `tests/garch-sizing.test.ts`
  - vol forecast is bounded and walk-forward (no look-ahead),
  - vol-target sizing reduces notional as forecast vol rises,
  - the harness validates it honestly before it can gate a fill.
- **Verify:** `npm test` + `npx tsc --noEmit`.

---

## Phase 5 - SAFETY-JOURNAL / PAPER BACKING

### Q15. Safety-registry + honest replay journal (P1)
- **SRC refs:** SRC-173 (MCP safety architecture: read-only/demo gates,
  capability snapshot, remediation-write veto, atomic safe-file), SRC-124
  (event-sourced paper journal + replay-anchored scorecard), SRC-065/177
  (idempotent fill/PnL reconciliation).
- **Target module:** new `src/services/safety-registry.ts` +
  `src/services/trade-journal-service.ts`.
- **Change:** a versioned, atomic safe-config registry (plumbed to Q11 RBAC)
  and a replay-anchored journal that reconciles idempotent fills/PnL so the
  post-mortem reads honest numbers only.
- **Acceptance (failing first):** `tests/safety-registry.test.ts`
  - safe-file writes are atomic (a corrupt partial is never read),
  - remediation requires an explicit write (read-only default),
  - journal replays a recorded sequence and reconciles fills without double-counting PnL.
- **Verify:** `npm test` + `npx tsc --noEmit`.

### Q16. Opportunity post-mortem learning-feed soundness (P0) - *regression guard*
- **SRC refs:** internal review of commit `7c80573`; SRC-124 honest scorecard.
- **Target module:** `src/services/opportunity-post-mortem.ts`,
  `src/position/position-manager.ts`, `src/orchestrator/swarm-learning.ts`.
- **Change:** close the two live soundness findings so the ledger feeds the
  swarm exactly once and only for outcomes tied to the bot's actual evaluation:
  - dedupe against `PositionManager` TP/SL recalibration (one recalibration per
    realized outcome, centralized),
  - exclude "bot never held a live trade" classes from positive feeding
    (`PROFITABLE_MISS` = neutral/negative, not success),
  - measure the trajectory from the relevant evaluation window, not first-ever tick.
- **Acceptance (failing first):** update `tests/opportunity-post-mortem.test.ts`
  (the assertion near line 52 that enshrines the double-count) + add
  `tests/learning-feed-dedup.test.ts`
  - a position that reached `EXITED` feeds the swarm exactly once in total,
  - a `PROFITABLE_MISS` never increments a success weight,
  - an evaluation-window entry produces the documented classification.
- **Verify:** `npm test` + `npx tsc --noEmit`.

---

## Dependency diagram

```text
Q01 harness --> Q10 calibration
   |
   +----> Q02 latched kill-switch (independent hardening)

Q03/04/05/06   discovery + chain-independence (independent of Q01)

Q07 sizing --> Q08 fill-sim --> Q09 executor --> Q11 exec-governance
   |                |                 |
   +----------------+-----> Q13 cost-gating

Q12 risk rubric (independent)
Q14 GARCH (gated by Q01)
Q15 safety-registry / journal
Q16 post-mortem dedup (independent regression guard)
```

## Anti-patterns to skip (deliberately, per section 14 item 8)

- **SRC-226** - traffic/rank-manipulation bot: do not adopt; do not weight
  DexScreener/Dextools trending ranks heavily.
- Full platforms, agent swarms, scrapers, unofficial GMGN clients, and anything
  that persists secrets (plaintext keys, credential-from-file).
- Anything that couples trading to a single proprietary data source without a
  fallback (violates the green-label bar).

## Appendix - decision log

- Q01 lands first per section 14 item 9 ("adopt the anti-overfit harness first
  so new callers are validated honestly"); Q03 leads the discovery items per
  item 1 ("fastest green-label lever").
- Wave-5 items (SRC-261 FLYWHEEL, SRC-262 grok-trading-desk) fold into Q13;
  SRC-150 GARCH into Q14.
- Q16 is carried from the `7c80573` code review (not part of the 262-source
  report) and kept as a regression guard against a live double-count.
- Every item is an **atomic, independently testable unit**; no item requires
  end-to-end infrastructure beyond what the existing suite already stubs.
