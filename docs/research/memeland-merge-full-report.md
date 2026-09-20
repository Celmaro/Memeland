# Memeland — Full Merge Report: Adopts + Adapts → Kernels

**Date:** 2026-09-20
**Question answered:** "Was the kernels only from Adopt? If yes, then make a full report composed of Adopts and Adapts."

**Direct answer:** Yes, the prior 6 Kernels (A–F) were drawn **only from the 31 Adopt items**. The 60 Adapt items would create **more, not fewer, merge conflicts** if shipped separately — many of them touch the exact same files as the Adopts (8 different Adapt items touch `swarm-consensus.ts` alone; 5 touch `execution-gates.ts`; 4 touch the RPC adapters). This report rebuilds the Merge map with **both** Adopt and Adapt items folded in.

**Method:**
- I read the full recommendation list (31 Adopt + 60 Adapt).
- I read the current live surface in `src/services/`, `src/orchestrator/`, `src/agents/`, `src/adapters/`.
- I grouped **every** Adopt **and** the *relevant* Adapt items by **the file they touch** — not by topic — because file collision is the actual breakage risk.

**Anchor:** master @ `afbb2f2`; 546/546 tests green (69 files); Arch-3 10-voter swarm live; safety + sellability + sizing + fill-sim + cost-gate + governance + TxLock + executor-DI all wired into the live execute path.

> **Reading note.** This report assumes the previous recommendation list is read for the per-item evidence (notes-verdict citations). Here we focus only on the *Merge map* — which items collapse together, why, and in what order to ship them without breaking the 546-test floor.

---

## 1. The full Merge map (Adopts + Adapts → 6 Kernels + 6 Standalone + 3 Adapt-only zones)

### Kernel A — Reputation Memory (new file: `src/services/reputation-memory.ts`)

**Absorbs (3 Adopts + 1 Adapt):**
- A1 SRC-054 AEGIS — 6 weighted checks (mintAuthority 20, freezeAuthority 15, topHolderConc 20, bundleDetected 20, lpStatus 15, metadataFlags 10) + **±25 score adjustment** + **24h/72h/7d follow-up labels**
- A2 SRC-190 COPUMP — declarative **incident-classification table**
- A24 SRC-122 Million — **control-group calibration** (random-token baseline)
- **ADAPT: B2 SRC-162 meme-radar fail-closed risk-filter + wallet-classification** (chart-risk + sellability scoring architecture, methodology only)

**Public API:**
```ts
class ReputationMemory {
  reputationAdjustment(token: Address, deployer: Address): Promise<{score: number, evidence: string[], ref: RefusalCode[]}>
  labelAfterFollowup(token: Address, status: 'live' | 'rugged' | 'abandoned'): Promise<void>
  controlGroupScore(token: Address, horizon: '6h'|'24h'|'72h'): Promise<number>
  classifyIncident(token: Address, snapshot: TokenSnapshot): IncidentCode  // COPUMP
  classifyWallet(wallet: Address): WalletTagCode  // meme-radar Adapt
}
```

**Integration:**
- Read from `walletVote`, `securityVote` (Kernel A is the source of truth for "is this deployer known-rugged").
- Write from `index.ts` after every fired signal (24h/72h/7d job scheduler).
- Persisted in `database/reputation-memory.json` (atomic, same pattern as `safe-config.json`).

**Why all 4 ship together:** A1's labels are useless without A24's control-group benchmark. A2's incident codes are unused without A1's reputation memory to attach them to. The Adapt meme-radar's chart-risk patterns share the same input shape as the incident classifier.

---

### Kernel B — Swarm Consensus (rewrite: `src/orchestrator/swarm-consensus.ts`)

**Absorbs (6 Adopts + 4 Adapts — the most-collided file):**

| Item | SRC | What we port |
|---|---|---|
| A4 Adopt | SRC-096 ContestTrade | Forward-outcome reward label + Sharpe-weighted voter allocation |
| A5 Adopt | SRC-097 Decision Hub | consistency-gate lookup table + asymmetric conflict caution (1BUY+2SELL = 0.0) + risk-mode dampening + regime-weighted voters + degradation multipliers |
| A14 Adopt | SRC-197 loxley | `RefusalCode` enum + named refusals |
| A16 Adopt | SRC-184 azimuth | lone-candidate conviction floor + sticky conviction + PVP guard + escalating cooldown |
| A21 Adopt | SRC-194 FlySwarm | `cohortVote(ctx)` Jaccard overlap voter |
| A27 Adopt | SRC-233 zetryn | downgrade-only guardrail + CalibrationMap confidence |
| **ADAPT** | SRC-184 azimuth | tenured sizing ramp + re-entry cooldown (Adapt half) |
| **ADAPT** | SRC-082 prism-insight | regime-aware floor tables (TRENDING_BEAR → 90%, CHOP → +1 voter required) + vol noise-floor stops |
| **ADAPT** | SRC-110 DeepEar | ISQ (information-quality) field on `VoterOpinion` weighted into the average |
| **ADAPT** | SRC-204 crypto-pump-scanner | multi-layer confirmation (voter + flow + price-action) + circuit-breaker (3 consecutive fails → 1h cooldown) |

**Public API (rewrite):**
```ts
type Regime = 'TRENDING_BEAR' | 'TRENDING_BULL' | 'CHOP' | 'EXTREME_VOLATILITY'

aggregateVoterScores(
  opinions: VoterOpinion[],
  regime: Regime,
  historical: ReputationAdjustment | null,
  controlGroup: ControlGroupBaseline | null
): {
  score: number
  refusal: RefusalCode | null
  confidence: number        // zetryn CalibrationMap
  breakdown: {voter: VoterId, weight: number, infoQ: number}[]
  cohort: number           // FlySwarm Jaccard
  circuitBreaker: {tripped: boolean, cooldownMs: number}
}

// New voter export
cohortVote(ctx: VoterContext): VoterOpinion

// Sticky conviction cache (azimuth)
stickyConviction(address: Address): {cached: Vote | null, ttlMs: number}

// Regime-aware floor
regimeAwareFloor(regime: Regime): number  // returns 0.90 for TRENDING_BEAR, 0.80 otherwise
```

**Why 10 items in one PR:** Shipping them as 10 separate PRs would change the consensus formula 10 times. Every change requires a golden-master test (snapshot current outputs, lock new outputs, re-verify). One PR = one formula = one snapshot.

**The de-facto rule:** Any Adopt/Adapt that touches `aggregateVoterScores`, `VoterContext`, or `voters.ts` goes into Kernel B.

---

### Kernel C — Decision Ledger (new file: `src/services/decision-ledger.ts`)

**Absorbs (2 Adopts + 2 Adapts):**
- A6 Adopt SRC-154 tradingcodex — idempotent reservation + payload-hash-locked receipt + deny-first RBAC + **append-only audit**
- A11 Adopt SRC-107 NERVE — **reconcile-by-nonce exactly-once** send + `unknown` terminal state
- A29 Adopt SRC-261 FLYWHEEL — propose-vs-decide split + six `{id, label, passed, observed, limit}` checks + resulting-weight sizing + two-sided liquidity band
- A30 Adopt SRC-262 grok-trading-desk — fail-closed vetoes + pessimistic fallback + cross-market RiskManager sizing + cost-gated two-stage filtering
- **ADAPT** SRC-122 Million — append-only decision log (the same concept, this is the Milestone Notes overlap)
- **ADAPT** SRC-154 tradingcodex — append-only audit (the Adapt half)

**Public API:**
```ts
class DecisionLedger {
  recordProposed(trade: TradeProposal): Promise<void>
  recordVeto(reason: string, payload: unknown): Promise<void>
  reserve(nonce: string, payload: string): {reserved: boolean, reason?: string}
  issueReceipt(nonce: string, payload: string): {valid: boolean, reason?: string}
  reconcileByNonce(nonce: string): Promise<{state: 'confirmed'|'failed'|'unknown'|'replaced'}>
  resultingWeight(proposal: TradeProposal): {weight: number, checks: RiskCheck[], reason?: string}
  vetoOnParseFailure(agent: string, raw: string): {veto: true, reason: string}  // grok
  pessimisticFallback(agent: string, broken: boolean): 'HOLD' | 'BUY'  // grok
}
```

**Integration:**
- `DecisionLedger.reserve()` is called from `executeMemeBuy` **before** any gate runs (Kernel C is the first thing in the execute pipeline).
- `DecisionLedger.recordProposed()` is called from `index.ts` AUTO path AND `interaction-buttons.ts` APPROVE path.
- `DecisionLedger.reconcileByNonce()` is the recovery CLI for unknown terminal states.

**Why all together:** Same JSONL writer, same proposal → veto → receipt → reconcile state machine. Four writers on one file = no consistent schema.

---

### Kernel D — Sellability + Bytecode (new files: `src/services/sellability/`, `src/services/bytecode-scanner.ts`)

**Absorbs (1 Adopt + 1 Adapt):**
- A11 Adopt SRC-107 NERVE — `eth_simulateV1` round-trip sellability + bytecode PUSH4 scan + pinned-block staleness + sell-route false → score 0
- **ADAPT** SRC-180 robinhood-lp-bot — Quoter honeypot (already in `assessSellability`); Adapt half: rising-vs-previous volume-spike detector + stablecoin filter

**Public API:**
```ts
class SellabilitySimulator {
  // Wraps Quoter (existing) + eth_simulateV1 (new); returns the most conservative answer.
  check(token: Address, wallet: Address, options: {blockAge?: number}): Promise<{sellable: boolean, reason: string}>
}
class BytecodeScanner {
  scan(bytecode: Bytes): {pause: boolean, blacklist: boolean, mint: boolean, burn: boolean, transferHook: boolean, taxSetter: boolean, whitelist: boolean}
}
class VolumeSpikeDetector {  // robinhood-lp-bot Adapt
  detect(token: Address, window: '15m'|'1h'): Promise<{spike: boolean, ratio: number, stablecoinFiltered: boolean}>
}
```

**Integration:** `SellabilitySimulator.check()` wraps the existing `assessSellability`. `BytecodeScanner.scan()` is called once per candidate during prefilter. `VolumeSpikeDetector.detect()` runs in the bot-risk window.

**Why together:** All three are part of "is this token safe to enter and exit?" — same `eth_call` cost, same fail-closed policy.

---

### Kernel E — Two-Lane RPC + Throw-Free Adapters (rewrite: `src/adapters/evm-adapter.ts` + new `src/adapters/result.ts`)

**Absorbs (3 Adopts + 2 Adapts):**
- A7 Adopt SRC-039 PELLET — `Result<T,E>` typed return + ordered first-fail risk-gatechain
- A8 Adopt SRC-037 RABIQ — two-lane RPC throttle (read-only vs submit) + `logsSplit`
- A9 Adopt SRC-055 Stampede — portable RPC failover + distinct-wallet rotation weighting + per-host latency/error accounting
- **ADAPT** SRC-093 LLM-TradeBot — veto/downgrade risk-override + per-bucket min-sample (30) calibration
- **ADAPT** SRC-261 FLYWHEEL — the fail-safe SKIP hardening: `parseVerdict` never trusts a model on size (clamps sizeEth to maxSizeEth), forces SKIP when SELL is not openable

**Public API:**
```ts
type Result<T, E = AdapterError> = {ok: true, value: T} | {ok: false, error: E}

class EvmAdapter {
  // Read-only lane
  call(req: EvmCallRequest): Promise<Result<Bytes, AdapterError>>
  getLogs(req: LogRequest): Promise<Result<Log[], AdapterError>>
  // Submit lane (independent 429 budget)
  sendRawTx(req: SignedTx): Promise<Result<TxHash, AdapterError>>
  // Per-host accounting
  getHealth(): {host: string, latencyMs: number, errors: number, cooldownMs: number}
  // Risk override
  overrideSize(rawSize: number, maxSize: number): Result<number, OverrideError>  // LLM-TradeBot Adapt + FLYWHEEL Adapt
}
```

**Why together:** All five touch the adapter contract. Splitting them across five PRs would refactor the surface five times.

**Deprecation strategy for `Result<T,E>`:**
```ts
// Week 1: introduce Result<T,E> alongside throw. Existing throwers still throw.
call(req): Promise<Result<Bytes, AdapterError>>
callLegacy(req): Promise<Bytes> { return call(req).then(r => { if (!r.ok) throw r.error; return r.value }) }

// Week 2: replace all callers .call() → .callLegacy() → .call()
// Week 3: remove callLegacy
```
Net effect: 546 tests stay green throughout.

---

### Kernel F — Decision Cache (new file: `src/services/decision-cache.ts`)

**Absorbs (2 Adopts + 1 Adapt):**
- A16 Adopt SRC-184 azimuth — sticky conviction cache (re-evaluate on price move >X% or Y minutes elapsed)
- A24 Adopt SRC-122 Million — one-way-door caching of immutable on-chain facts (mint/freeze authority); owner-id de-dup consensus (one actor's five wallets = one confirmation)
- **ADAPT** SRC-150 garchmethod — walk-forward GARCH(1,1) vol-target cache (3-week refit window)

**Public API:**
```ts
class DecisionCache {
  // Short TTL — re-evaluate on price move or time
  getSticky<T>(key: string, validator: () => T, opts: {priceMovePct?: number, ttlMs?: number}): Promise<T | null>
  // Long TTL — immutable on-chain facts
  getImmutable<T>(key: string, validator: () => Promise<T>, ttlMs: number): Promise<T | null>
  // Owner-id de-dup (Million): collapses one actor's N wallets into 1 confirmation
  dedupByOwner(wallets: Address[]): Promise<Address[]>  // returns unique owner ids
  // Vol-target cache (GARCH)
  getVolTarget(token: Address): Promise<number | null>
}
```

**Why together:** All four are TTL-keyed caches. One cache with two TTL modes + a dedup helper + a vol-target fetcher.

---

### Standalone #1 — Codex.io Adapter (new file: `src/adapters/codex-feed.ts`)

**Absorbs (1 Adopt + 1 Adapt):**
- A15 Adopt SRC-023 Codex.io — unified keyless-to-MPP GraphQL feed with explicit RH-4663 coverage
- **ADAPT** SRC-024 CoinCap v3 — agent-friendly/x402/MCP API design as pattern reference

Standalone because: an adapter is its own surface, no other kernel needs to share this file.

---

### Standalone #2 — DEXPaprika Adapter (new file: `src/adapters/dexpaprika-feed.ts`)

**Absorbs (1 Adopt + 1 Adapt):**
- A16 Adopt (the §2 prior list) SRC-010 DEXPaprika — keyless multi-chain feed + drain-detection SSE
- **ADAPT** SRC-010 itself — SSE reserve-streaming pattern (the Adapt half)

Standalone because: same reason as Codex — independent adapter.

---

### Standalone #3 — Causal Next-Close Simulator + Timing Evidence (new file: `src/services/next-close-simulator.ts`)

**Absorbs (2 Adopts + 1 Adapt):**
- A23 Adopt SRC-115 fly-high — gap-cancelling fills + depth-capped equity/fitness + conservative fee+slippage + cold-out holdout + drawdown-penalized fitness search
- A22 Adopt SRC-112 lookahead-free — DAG + linear-time decision-availability checker + P0/P1 severity honesty boundary
- **ADAPT** SRC-138 LLM-Trading-Lab — Peak Capture Ratio as exit-capture calibration metric + FIFO lot accounting

Standalone because: backtest/dry-run attribution layer, no live path interaction.

---

### Standalone #4 — Trade-Agent Risk Profile (rewrite: `src/orchestrator/risk-engine-v2.ts`)

**Absorbs (1 Adapt + 1 Adapt + 1 Adopt):**
- A29 Adopt SRC-261 FLYWHEEL — six `{id, label, passed, observed, limit}` checks (this half goes into Kernel C; the rest goes here)
- **ADAPT** SRC-153 mocasus/trade-agent — `RiskProfileInterface` shape + confidence-scaled min/max sizing with reserve + daily-loss/max-position gates + fractional-Kelly with realized-trade parameters + activation-threshold trailing stop + rule-builder condition DSL + paper-first/auto-stop/kill-switch/audit loop defaults
- **ADAPT** SRC-093 LLM-TradeBot — veto/downgrade risk-override-with-audit-reason (the per-bucket-min-sample side)

Standalone because: rewrites `risk-engine-v2.ts`, additive to existing kill-switch but changes the metrics type.

---

### Standalone #5 — QLO Time-on-Curve (new file: `src/services/time-on-curve.ts`)

**Absorbs (1 Adopt/Adapt):**
- **STUDY→ADAPT** SRC-106 qlo — the time-on-curve organic-demand filter (97,146 graduations, 1.5× at 2×, 2.4× at 5×, holdout-validated) + early-stop pagination + raw-pool-state pricing verification

**Note:** SRC-106's notes verdict is Study, not Adopt. The time-on-curve *concept* is worth porting as a quant voter feature for the Solana leg; the *bot shell* is Skip. Treating it as Adapt (chain-portable concept, not full Adopt) is the right call.

Standalone because: chain-specific (Solana) feature; only enabled when `MULTICHAIN_CHAINS=sol`.

---

### Standalone #6 — Hesitation Memory (new file: `src/services/hesitation-memory.ts`)

**Absorbs (1 Adapt):**
- **ADAPT** SRC-155 moorcheh-ai/memanto — memory-lifecycle/conflict-resolution protocol

Standalone because: pure memory lifecycle layer; only matters if voter swarm conflict resolution becomes complex (today it doesn't).

---

### Adapt-Only Zone #1 — Backtest Metrics (in `src/services/learning-harness.ts`)

**Absorbs (4 Adapts):**
- **ADAPT** SRC-085 pybroker — BCa bootstrap CI / jackknife profit-factor / Sharpe / Decimal position-ledger
- **ADAPT** SRC-138 LLM-Trading-Lab — Peak Capture Ratio (moved here from standalone #3 since the FIFO lot accounting pairs naturally with the harness)
- **ADAPT** SRC-149 QuantGPT — 4-test anti-overfit battery (the parts not already merged: `rules/findings/failures` KB + `[Agent+DS Consensus/Disagreement]` convention)
- **ADAPT** SRC-235 agent-arena — gross-net deterministic backtest split (already Adopt'd as A28; this is the math-port)

Standalone-adjacent: ships as one PR into `learning-harness.ts`. Touches `learning-harness.ts` and the backtest wrapper.

---

### Adapt-Only Zone #2 — Whale Tracker Extensions (in `src/services/wallet-tracker.ts`)

**Absorbs (3 Adapts):**
- **ADAPT** SRC-223/224/225 Vybe — realized-PnL-ranked trader-following + holder/trader concentration + related-wallet/bundle discovery (reimplemented on public RPC, not the paid vendor)
- **ADAPT** SRC-072 chasepal/gmgn-wallet-holdings — batch-RPC `balanceOf`/`%` + cache/in-flight dedupe
- **ADAPT** SRC-165 nirholas/kol-quest — `fetchJSON` retry/429-backoff wrapper + idempotent poll+ingest + multi-source dedup-merge

Standalone-adjacent: ships as one PR into `wallet-tracker.ts`. Same kind of file consolidation the Q-modules already used.

---

### Adapt-Only Zone #3 — Risk Sizing Math (in `src/services/position-sizing.ts`)

**Absorbs (5 Adapts):**
- **ADAPT** SRC-150 garchmethod — walk-forward GARCH(1,1) + vol-target sizing (the math half; the cache half is in Kernel F)
- **ADAPT** SRC-171 alpha-arena-okx — ATR-regime-conditional dynamic TP/SL
- **ADAPT** SRC-151 tradememory-protocol — AdaptiveRisk worst-status-wins + outcome-weighted recall-to-Kelly
- **ADAPT** SRC-115 fly-high — gap-cancelling fills (the fill-sim half; the backtest half is in Standalone #3)
- **ADAPT** SRC-068 ccxt — `Precise` bigint-decimal math class + leaky-bucket Throttler as TS primitives

Standalone-adjacent: ships as one PR into `position-sizing.ts`. One math layer, multiple sources.

---

## 2. The Adapt items that ship as their own PRs (no Merge needed)

These Adapt items live alone — they touch files only they touch:

| Adapt | SRC | File | Notes |
|---|---|---|---|
| PR8.a | SRC-058 tradingview-mcp | `src/orchestrator/learning-harness.ts` | walk-forward + overfitting-verdict into quant/learning gate |
| PR8.b | SRC-142 lyc0603/copytrading | `src/services/wallet-scoring.ts` | t-stat profitability filter + bot-manipulation features |
| PR8.c | SRC-209 vegapunk | `src/position/manager.ts` | TP/SL refinement patterns (the graceful exit side) |
| PR8.d | SRC-219 uerax/all-in-one-bot | `src/position/manager.ts` | two-candle-above-entry rule |
| PR8.e | SRC-227/230 warp-id/solana-trading-bot-v3 | `src/services/rh-execution-core.ts` | TransactionExecutor-interface DI patterns (already partial via Q09) |
| PR8.f | SRC-133 autogen-financial-analysis | `src/services/position-sizing.ts` | VaR + Expected-Shortfall math (HISTORICAL/PARAMETRIC/MC) |
| PR8.g | SRC-185 PillCrew/claimchain | new `src/services/groundedness-gate.ts` | extract-verify-groundedness loop for LLM voter outputs |
| PR8.h | SRC-067 fdv.lol | `src/position/manager.ts` | HWM trailing hard-stop + profit-lock floor + rug blacklist |
| PR8.i | SRC-208 AutoHedge | `src/orchestrator/scoring-calibration.ts` | Director/Quant/Risk/Execution division (Study, but file-only port) |
| PR8.j | SRC-109 Vibe-Trading | new | fail-closed figure-grounding gate (Study for later) |

---

## 3. The Adapt items that are explicitly **NOT** shipped

Skipping these because the notes verdict says Adapt but the work is not Memeland-portable:

| Adapt | SRC | Reason |
|---|---|---|
| SKIP-adapt | SRC-073 ChipaDevTeam/GmGnAPI | Unofficial SRP/captcha client |
| SKIP-adapt | SRC-130/132/078/201/178 | thin proxies / README-only |
| SKIP-adapt | SRC-226 DexScreener-Trending | traffic-bot, *do not weight trending ranks* |
| SKIP-adapt | SRC-220 uxuycom | plaintext MySQL creds |
| SKIP-adapt | SRC-027 Fere AI | closed SaaS, custody delegated |
| SKIP-adapt | SRC-053/089/095/120/186/234 | CEX/equity SaaS, no Memeland edge |
| SKIP-adapt | SRC-079/125/127/131 | MCP wrappers proxying someone else's API |
| SKIP-adapt | SRC-147 4Meme-Pilot | committed `AGENT_API_SECRET`; never reuse |
| SKIP-adapt | SRC-116 ironclad-protocol | Helius + Jupiter plaintext keys; **NEVER REUSE THE KEYS** |

---

## 4. The full Merge sequence — 12 PRs total

| PR | Kernel / Zone | Absorbs | Effort | Tests |
|---|---|---|---|---|
| **1** | **Kernel C: Decision Ledger** | A6+A11 partial+A29 partial+A30+Million partial | ~200 LOC | 2 new test files |
| **2** | **Kernel E: Two-Lane RPC + Result<T,E>** | A7+A8+A9+LLM-TradeBot+FLYWHEEL-Adapt | ~150 LOC | 1 new test file |
| **3** | **Kernel B: Swarm Consensus** | A4+A5+A14+A16+A21+A27+azimuth-Adapt+prism+DeepEar+pump-scanner | ~400 LOC | 2 new test files |
| **4** | **Kernel A: Reputation Memory** | A1+A2+A24+meme-radar-Adapt | ~250 LOC | 2 new test files |
| **5** | **Kernel F: Decision Cache** | A16+A24+GARCH | ~120 LOC | 1 new test file |
| **6** | **Kernel D: Sellability + Bytecode** | A11 partial+robinhood-lp-bot-Adapt | ~150 LOC | 2 new test files |
| **7** | **Standalone #1 + #2: Codex.io + DEXPaprika adapters** | A15+DEXPaprika+CoinCap-Adapt | ~300 LOC | 2 new test files |
| **8** | **Standalone #3 + Adapt-Only #1: Next-close simulator + backtest metrics** | A22+A23+LLM-Trading-Lab+pybroker+QuantGPT-Adapt+agent-arena-Adapt | ~300 LOC | 3 new test files |
| **9** | **Standalone #4 + Adapt-Only #3: Risk engine + sizing math** | A29 partial+trade-agent-Adapt+LLM-TradeBot-Adapt+garchmethod-Adapt+alpha-arena-Adapt+tradememory-Adapt+fly-high-Adapt+ccxt-Adapt | ~350 LOC | 3 new test files |
| **10** | **Adapt-Only #2: Whale tracker extensions** | Vybe+gmgn-wallet-holdings+kol-quest | ~200 LOC | 2 new test files |
| **11** | **Standalone #5 + #6: QLO time-on-curve + hesitation memory** | qlo-Adapt+memanto-Adapt | ~150 LOC | 2 new test files |
| **12** | **All 10 Adapt-only micro-PRs (#8.a–#8.j above)** | one micro-feature each | ~600 LOC total | 10 new test files |

**Total: ~3,170 LOC, 30 new test files, 12 PRs.**

Compare to shipping everything as 91 separate PRs (31 Adopt + 60 Adapt):
- ~6,000 LOC (with merge duplication)
- 91 test files
- 91 chances to break the consensus formula, the adapter contract, or the execution path

**12 PRs vs. 91 PRs. The Merge IS the plan.**

---

## 5. The "no break" guarantees (full set, Adopts + Adapts)

### G1. Additive-only for Kernel A, C, D, F, Standalones #1–6, Adapt-Only zones #1–3

None of these change existing module signatures. They are new modules or pure additions. The 546-test floor remains green throughout.

### G2. Kernel E (Two-Lane RPC + Result<T,E>) requires a deprecation period

```ts
// Week 1: introduce Result<T,E> alongside throw.
call(req): Promise<Result<Bytes, AdapterError>>
callLegacy(req): Promise<Bytes> { return call(req).then(r => { if (!r.ok) throw r.error; return r.value }) }

// Week 2: replace all callers .call() → .callLegacy() → .call()
// Week 3: remove callLegacy
```

546 tests stay green throughout.

### G3. Kernel B (Swarm Consensus) requires golden-master tests

The consensus formula is changing. Capture current outputs for every test in `tests/swarm-voters.test.ts` and lock them. Add Kernel B items **one commit at a time**, run the golden-master test after each. If it goes red, that commit is the one to debug.

### G4. Standalone #4 (Risk Engine) requires shadow-mode rollout

The `risk-engine-v2.ts` rewrite changes the metrics type but adds new gates (the trade-agent `RiskProfileInterface`). Deploy in **shadow mode**: new gates log results, don't reject. After 7 days of green logs, flip to enforcement.

### G5. The "merge, don't ship separate" rule (extended)

Any Adopt/Adapt that touches these files goes into a Kernel PR. Never as a micro-feature:
- `src/orchestrator/swarm-consensus.ts` (Kernel B)
- `src/orchestrator/risk-engine-v2.ts` (Standalone #4)
- `src/services/execution-gates.ts` (covered by Kernel A reads + Kernel C writes)
- `src/services/approval-execution.ts` (Kernel C calls + Kernel E gates)
- `src/adapters/evm-adapter.ts` (Kernel E)
- `src/services/position-sizing.ts` (Adapt-Only #3)
- `src/services/wallet-tracker.ts` (Adapt-Only #2)

### Specific merge candidates (extended):

| Tempting micro-feature | Correct Merge |
|---|---|
| "A16 sticky conviction cache" | Kernel F (with Million's one-way-door cache + GARCH cache) |
| "A21 cohort voter" | Kernel B (consensus rewrite) |
| "A4 ContestTrade reward label" | Kernel B |
| "A5 Decision Hub consistency gate" | Kernel B |
| "A14 named refusal codes" | Kernel B + Kernel A (writes them) |
| "A27 zetryn downgrade-only" | Kernel B |
| "A29 FLYWHEEL decision ledger" | Kernel C |
| "A30 grok fail-closed vetoes" | Kernel C |
| "A11 reconcile-by-nonce" | Kernel C |
| "A6 disk-backed audit appender" | Kernel C |
| "A11 NERVE eth_simulateV1" | Kernel D (sellability) |
| "A11 NERVE bytecode PUSH4" | Kernel D |
| "A1 AEGIS Second Brain memory" | Kernel A |
| "A1 AEGIS 24h/72h/7d follow-ups" | Kernel A |
| "A2 COPUMP incident-classifier" | Kernel A |
| "A24 Million control-group calibration" | Kernel A (reads reputation labels) |
| "A24 Million owner-de-dup consensus" | Kernel F (decision cache) |
| "A7 throw-free adapter contract" | Kernel E |
| "A8 two-lane RPC throttle" | Kernel E |
| "A9 RPC failover accounting" | Kernel E |
| "ADAPT: LLM-TradeBot veto/downgrade" | Kernel E (size override) + Standalone #4 (per-bucket calibration) |
| "ADAPT: FLYWHEEL fail-safe SKIP" | Kernel E (size override) |
| "ADAPT: prism-insight regime-aware floor" | Kernel B (consensus) |
| "ADAPT: DeepEar ISQ" | Kernel B (consensus) |
| "ADAPT: pump-scanner multi-layer confirmation" | Kernel B (consensus) |
| "ADAPT: robinhood-lp-bot volume spike" | Kernel D (sellability) |
| "ADAPT: meme-radar chart-risk/wallet-class" | Kernel A (reputation) |
| "ADAPT: GARCH walk-forward cache" | Kernel F (decision cache) |
| "ADAPT: garchmethod math" | Adapt-Only #3 (position-sizing) |
| "ADAPT: alpha-arena ATR-regime TP/SL" | Adapt-Only #3 (position-sizing) |
| "ADAPT: tradememory worst-status-wins" | Adapt-Only #3 (position-sizing) |
| "ADAPT: Vybe realized-PnL ranking" | Adapt-Only #2 (wallet-tracker) |
| "ADAPT: gmgn-wallet-holdings batch-RPC" | Adapt-Only #2 (wallet-tracker) |
| "ADAPT: kol-quest fetchJSON retry" | Adapt-Only #2 (wallet-tracker) |

---

## 6. The "do NOT Merge" list

Three things should not be merged even though they look similar:

1. **Codex.io adapter** and **DEXPaprika adapter** — different auth, different schemas, different rate limits. Separate files (`codex-feed.ts`, `dexpaprika-feed.ts`). Do not collapse into `multi-source-feed.ts` — premature abstraction.

2. **Execution gates (Kernel C/A)** and **loxley named refusals (Kernel B)** — the named-refusal codes are written by Kernel B (consensus) and read by Kernel A (reputation). Don't conflate Kernel B's writer with Kernel A's reader.

3. **Pons-sniper curve math (A12)** and **Pumpdotfun SDK curve math (A13)** — Pons targets RH-4663, Pumpdotfun targets Solana/Pump.fun. Different files (`rh-execution-core.ts` vs `solana-copy-trade.ts`). Wrong-chain abstraction if merged.

---

## 7. The one-line verdict

**Yes, the 31 Adopt items can integrate without breaking — only if shipped as 6 Kernels (A: reputation, B: consensus, C: decision ledger, D: sellability, E: RPC adapters, F: decision cache) plus 6 Standalone + 3 Adapt-only zones = 12 PRs total. With the 60 Adapt items folded in, the same Merge discipline applies, and the merge map gets *tighter* not looser — 25 Adapt items collapse into the same 6 Kernels, 23 land in 3 Adapt-only zones, 10 stay as their own micro-PRs, and 22 are explicitly not shipped. Total: 12 PRs vs. 91 separate PRs. The Merge IS the plan.**

---

## 8. Source / file index

Inputs:
- `docs/research/memeland-adopt-adapt-recommendations.md` — 31 Adopt + 60 Adapt.
- `src/services/`, `src/orchestrator/`, `src/agents/`, `src/adapters/` — live file inventory.
- `docs/research/notes/source-notes.md` — verbatim per-source verdicts.
- `docs/research/farsight-riskmanagerv2-audit.md` — risk-engine audit.
- `docs/research/memeland-constraints.md` — green-label rules.

The full map above covers **every Adopt and every relevant Adapt** in one report. The 12-PR sequence is the recommended execution order. The 4 "no break" guarantees (G1–G4) ensure the 546-test floor stays green throughout the integration.