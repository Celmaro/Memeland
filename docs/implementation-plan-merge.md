# Memeland - Implementation Plan (Merge Full Report -> 12 PRs)

Status: **plan only. No code changed yet.** Derived from
[`docs/research/memeland-merge-full-report.md`](./research/memeland-merge-full-report.md)
which rebuilds the Adopt/Adapt map as **6 Kernels + 6 Standalone + 3 Adapt-only zones = 12 PRs**
(vs. 91 separate items) to avoid breaking consensus / adapter / execution surfaces.

Anchor: **master @ `989f69f`** (Q16 post-mortem dedup). **69 test files / 547 tests green**,
`npx tsc --noEmit` clean. Working tree clean. Phases 1-4 (Q01-Q14) + Q15/Q16 landed.

> **Re-verify before each PR.** The report was anchored at `afbb2f2` (546 tests).
> Phase 5 (Q15/Q16) landed since, so test-file names and line numbers cited in the
> report (e.g. `tests/swarm-voters.test.ts`) must be re-checked against the current
> tree before touching each module.

## How to run the suite and contribute tests

- Run all: `npm test`
- One file: `npx vitest run tests/<file>.test.ts`
- Typecheck: `npx tsc --noEmit`
- ESM: `.js` import extensions required in `tests/*.test.ts` into `src/**`.
- TDD loop per PR:
  1. Write the failing test(s) named for the behavior.
  2. Confirm they fail for the right reason (a real gap, not a stub).
  3. Implement the smallest module change that turns them green.
  4. Full suite + `tsc --noEmit` green, then commit the PR as one unit.

## Execution order (12 PRs, dependency-first)

Order prioritizes **lowest merge-collision / highest isolation first** (new files ship
before rewrites), then the consensus rewrite (golden-master), then risk/sizing (shadow-mode).

### PR 1 - Kernel C: Decision Ledger (new `src/services/decision-ledger.ts`)
- **Absorbs:** A6 tradingcodex (reservation + hash-locked receipt + deny-first RBAC + append-only audit), A11 NERVE (reconcile-by-nonce, `unknown` state), A29 FLYWHEEL (propose-vs-decide + six checks + resulting-weight sizing + two-sided liquidity band), A30 grok (fail-closed vetoes + pessimistic fallback), Million/tradingcodex audit Adapts.
- **Change:** `DecisionLedger` with `recordProposed/recordVeto/reserve/issueReceipt/reconcileByNonce/resultingWeight/vetoOnParseFailure/pessimisticFallback`. `reserve()` is called **first** in the execute pipeline (before gates); `recordProposed()` from `index.ts` AUTO + `interaction-buttons.ts` APPROVE.
- **Tests:** new `tests/decision-ledger.test.ts` (reservation exactly-once + hash-locked receipt + append-only ordering + reconcile-by-nonce states).
- **Verify:** `npm test` + `npx tsc --noEmit`. Commit PR 1.

### PR 2 - Kernel E: Two-Lane RPC + `Result<T,E>` (new `src/adapters/result.ts`, rewrite `src/adapters/evm-adapter.ts`)
- **Absorbs:** A7 PELLET (`Result<T,E>` + first-fail risk-gatechain), A8 RABIQ (read/submit two-lane throttle + `logsSplit`), A9 Stampede (portable failover + rotation weighting + per-host latency/error), LLM-TradeBot + FLYWHEEL Adapt (size clamp / fail-safe SKIP).
- **Change:** add `Result<T,E>` + `callLegacy` (Week 1); swap callers to `call()` (Week 2); remove `callLegacy` (Week 3). Independent submit-lane 429 budget. `overrideSize`/`getHealth`.
- **Tests:** new `tests/evm-adapter-result.test.ts` (result-throws-less + two-lane throttle + failover weighting + size clamp). **G2** deprecation keeps 547-test floor green.
- **Verify:** `npm test` + `npx tsc --noEmit`. Commit PR 2.

### PR 3 - Kernel B: Swarm Consensus (rewrite `src/orchestrator/swarm-consensus.ts`) - *highest collision*
- **Absorbs:** A4 ContestTrade (outcome reward label + Sharpe voter alloc), A5 Decision Hub (consistency-gate + asymmetric conflict 1BUY+2SELL=0 + risk-mode dampening + regime-weighted voters + degradation multipliers), A14 loxley `RefusalCode`, A16 azimuth (lone-candidate floor + sticky conviction + PVP guard + escalating cooldown), A21 FlySwarm Jaccard voter, A27 zetryn (downgrade-only + CalibrationMap); Adapts: azimuth tenured sizing, prism regime floor, DeepEar ISQ, pump-scanner multi-layer + circuit-breaker.
- **Change:** rewrite `aggregateVoterScores` signature + `cohortVote/stickyConviction/regimeAwareFloor` exports.
- **Tests (G3 golden-master):** snapshot current outputs of `tests/swarm-consensus.test.ts` + `tests/swarm-voters.test.ts`; add B items **one commit at a time**, re-run golden-master after each. New `tests/swarm-regime-floor.test.ts` + `tests/swarm-circuit-breaker.test.ts`.
- **Verify:** golden-master + full suite + `npx tsc --noEmit` green. Commit PR 3.

### PR 4 - Kernel A: Reputation Memory (new `src/services/reputation-memory.ts`)
- **Absorbs:** A1 AEGIS (6 weighted checks + ±25 adjustment + 24h/72h/7d follow-ups), A2 COPUMP incident table, A24 Million control-group calibration, meme-radar Adapt (wallet classification).
- **Change:** `ReputationMemory` (`reputationAdjustment/labelAfterFollowup/controlGroupScore/classifyIncident/classifyWallet`). Reads `walletVote`/`securityVote`; writes from `index.ts` scheduler; persists `database/reputation-memory.json` (atomic, like `safe-config.json`).
- **Tests:** new `tests/reputation-memory.test.ts` + `tests/incident-classifier.test.ts`.
- **Verify:** `npm test` + `npx tsc --noEmit`. Commit PR 4.

### PR 5 - Kernel F: Decision Cache (new `src/services/decision-cache.ts`)
- **Absorbs:** A16 azimuth sticky conviction, A24 Million one-way-door immutable cache + owner-id dedup (5 wallets -> 1 confirmation), GARCH walk-forward vol-target cache Adapt.
- **Change:** `DecisionCache` (`getSticky/getImmutable/dedupByOwner/getVolTarget`).
- **Tests:** new `tests/decision-cache.test.ts`.
- **Verify:** `npm test` + `npx tsc --noEmit`. Commit PR 5.

### PR 6 - Kernel D: Sellability + Bytecode (new `src/services/sellability/`, `src/services/bytecode-scanner.ts`)
- **Absorbs:** A11 NERVE (`eth_simulateV1` round-trip sellability + PUSH4 bytecode scan + pinned-block staleness, sell false -> score 0), robinhood-lp-bot Adapt (volume-spike + stablecoin filter wrapping existing Quoter honeypot).
- **Change:** `SellabilitySimulator.check`, `BytecodeScanner.scan`, `VolumeSpikeDetector.detect`.
- **Tests:** new `tests/sellability-simulator.test.ts` + `tests/bytecode-scanner.test.ts`.
- **Verify:** `npm test` + `npx tsc --noEmit`. Commit PR 6.

### PR 7 - Standalone #1 + #2: adapters (new `src/adapters/codex-feed.ts`, `src/adapters/dexpaprika-feed.ts`)
- **Absorbs:** A15 Codex.io unified keyless-to-MPP GraphQL; DEXPaprika keyless multi-chain + drain-detection SSE; CoinCap + DEXPaprika reserve-streaming Adapts.
- **Change:** two independent adapters. **Do NOT merge #1/#2 together** (different auth/schema/rate limits).
- **Tests:** new `tests/codex-feed.test.ts` + `tests/dexpaprika-feed.test.ts`.
- **Verify:** `npm test` + `npx tsc --noEmit`. Commit PR 7.

### PR 8 - Standalone #3 + Adapt-Only #1: Next-close simulator + backtest metrics
- **Absorbs:** A22 lookahead-free (DAG + decision-availability + P0/P1 severity), A23 fly-high (gap-cancelling fills + depth-capped equity/fitness + conservative fees/slippage + cold-out holdout + drawdown penalty), LLM-Trading-Lab Peak Capture Ratio + FIFO lots; pybroker (BCa CI / jackknife / Decimal ledger), QuantGPT anti-overfit battery, agent-arena gross-net split.
- **Change:** new `src/services/next-close-simulator.ts` + extend `src/orchestrator/learning-harness.ts`.
- **Tests:** new `tests/next-close-simulator.test.ts`, `tests/backtest-metrics.test.ts`, extend `tests/learning-harness.test.ts`.
- **Verify:** `npm test` + `npx tsc --noEmit`. Commit PR 8.

### PR 9 - Standalone #4 + Adapt-Only #3: Risk engine + sizing math - *shadow-mode*
- **Absorbs:** trade-agent `RiskProfileInterface` (confidence-scaled min/max sizing + daily-loss/max-position + fractional-Kelly + trailing-stop + rule-builder DSL + kill-switch defaults), LLM-TradeBot veto/downgrade-with-reason; GARCH vol-target math, alpha-arena ATR-regime TP/SL, tradememory worst-status-wins + outcome-weighted recall-to-Kelly, fly-high gap-cancelling fills, ccxt `Precise` bigint-decimal + leaky-bucket Throttler.
- **Change:** rewrite `src/orchestrator/risk-engine-v2.ts` + extend `src/services/position-sizing.ts`.
- **Tests:** new `tests/risk-profile.test.ts`, `tests/position-sizing-math.test.ts`, extend `tests/risk-engine.test.ts`. **G4** shadow-mode: new gates log-only for 7 days, then enforce.
- **Verify:** `npm test` + `npx tsc --noEmit`. Commit PR 9.

### PR 10 - Adapt-Only #2: Whale tracker extensions (`src/services/wallet-tracker.ts`)
- **Absorbs:** Vybe realized-PnL-ranked trader-following + concentration + bundle discovery (public RPC), gmgn batch-RPC `balanceOf`/% + in-flight dedupe, kol-quest retry/429-backoff + idempotent poll+ingest + dedup-merge.
- **Tests:** new `tests/wallet-tracker-extended.test.ts`.
- **Verify:** `npm test` + `npx tsc --noEmit`. Commit PR 10.

### PR 11 - Standalone #5 + #6: QLO time-on-curve + hesitation memory
- **Absorbs:** qlo time-on-curve organic-demand filter (1.5x/2.4x + early-stop + raw-pool price verify; SOL-only gated by `MULTICHAIN_CHAINS=sol`), memanto memory-lifecycle/conflict-resolution.
- **Change:** new `src/services/time-on-curve.ts` + `src/services/hesitation-memory.ts`.
- **Tests:** new `tests/time-on-curve.test.ts` + `tests/hesitation-memory.test.ts`.
- **Verify:** `npm test` + `npx tsc --noEmit`. Commit PR 11.

### PR 12 - All 10 Adapt-only micro-PRs (#8.a-#8.j) (~600 LOC, 10 test files)
- **PR8.a** tradingview-mcp walk-forward (learning-harness); **PR8.b** copytrading t-stat + bot features (wallet-scoring); **PR8.c** vegapunk TP/SL (position/manager); **PR8.d** uerax two-candle-above-entry (manager); **PR8.e** warp-id TransactionExecutor DI (rh-execution-core, partial via Q09); **PR8.f** autogen VaR/ES (position-sizing); **PR8.g** claimchain groundedness-gate (new `src/services/groundedness-gate.ts`); **PR8.h** fdv.lol HWM trailing hard-stop + profit-lock + rug blacklist (manager); **PR8.i** AutoHedge Director/Quant/Risk division (scoring-calibration); **PR8.j** Vibe-Trading figure-grounding gate (Study-later).
- **Tests:** one new test file per micro-PR.
- **Verify:** `npm test` + `npx tsc --noEmit` after each micro-PR, then commit each.

## The "no break" guarantees

- **G1 - Additive-only:** Kernels A, C, D, F + Standalones #1-6 + Adapt-Only zones #1-3 never change existing signatures -> 547-test floor stays green.
- **G2 - Kernel E deprecation:** `callLegacy` Week1 -> swap Week2 -> remove Week3; floor stays green throughout.
- **G3 - Kernel B golden-master:** snapshot current consensus outputs first; add B items one commit at a time; red test names the offending commit.
- **G4 - Standalone #4 shadow-mode:** new risk gates log-only 7 days, then enforce.
- **G5 - Merge-don't-split:** any item touching `swarm-consensus.ts`, `risk-engine-v2.ts`, `execution-gates.ts`, `approval-execution.ts`, `evm-adapter.ts`, `position-sizing.ts`, or `wallet-tracker.ts` ships in its Kernel PR, never as a micro-feature.
- **G0 (existing):** never persist secrets; no single proprietary source without a fallback (green-label bar).

## Dependency diagram

```text
PR1 Kernel C (ledger)           PR3 Kernel B (consensus)  <- golden-master
   |                                  |
   +-> PR4 Kernel A (reputation) <- writes RefusalCode (reads Kernel B)
   |                                  |
   +-> PR5 Kernel F (decision cache)  +-> PR2 Kernel E (RPC, independent)
   |                                  |
   +-> PR6 Kernel D (sellability, uses evm-adapter after PR2)
        |
PR7 adapters (independent)       PR8 sim+metrics (independent, extends learning-harness)
PR9 risk+sizing (shadow-mode)    PR10 wallet-tracker
PR11 qlo+hesitation              PR12 micro-PRs (safest last, touch manager/calibration)
```

## Do-NOT-Merge (from report section 6)

- **Codex.io vs DEXPaprika adapters** - different auth/schema/rate limits; separate files.
- **Execution gates (Kernel C/A) vs loxley named refusals (Kernel B)** - writer vs reader; don't conflate.
- **Pons-sniper curve (rh-execution-core) vs Pumpdotfun SDK curve (solana-copy-trade)** - wrong-chain abstraction.

## Open flags

- Re-verify every report line/test name against current master before each PR (report anchored at `afbb2f2`/546 tests; current `989f69f`/547).
- Totals: ~3,170 LOC, 30 new test files, 12 PRs. Single golden-master risk is PR 3; single shadow-mode risk is PR 9.

## Status: closed

All 12 PRs shipped (PR 1–PR 12) plus the PR 2 wrap-up and the LI.FI multi-chain
audit fixes (R1–R10, commit `9d5b4c5`). This plan is **complete**; the
follow-up consolidation review lives in
[`docs/kernel-consolidation-opportunities.md`](./kernel-consolidation-opportunities.md)
(KC1–KC9).

- Anchor moved from `afbb2f2`/546 tests to `9d5b4c5`/859 tests at plan-close.
- Golden-master risk (PR 3): shipped additively; consensus numbers preserved
  (swarm-consensus + swarm-voters tests unchanged, green).
- Shadow-mode risk (PR 9): the screening-scheduler + risk hooks shipped; the
  follow-up KC6 (ScreeningRunner) keeps the full-cycle extraction behind a
  shadow-mode contract (`ScreeningDeps` in `src/runtime/screening-runner.ts`).

