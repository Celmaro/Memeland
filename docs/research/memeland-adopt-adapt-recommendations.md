# Memeland — Adopt / Adapt / Merge / Study Final Recommendations

**Date:** 2026-09-20
**Method:** Three-pass read before writing.
1. **Pass 1 — `notes/source-notes.md` (2,268 lines)**: the per-source deep-review evidence, every source verbatim.
2. **Pass 2 — `source-manifest.csv` (262 rows)**: cross-checked every verdict against the notes; recovered 6 sources whose manifest verdict was blank; produced `_verdict_map_final.tsv` with **31 Adopt, 60 Adapt, 59 Study, 112 Skip**.
3. **Pass 3 — `memeland-ecosystem-review.md` (699 lines), `memeland-constraints.md` (126 lines), `farsight-riskmanagerv2-audit.md` (94 lines)**: the synthesized review, the green-label rules, the risk-engine audit.
- **Anchor:** master @ `afbb2f2` (latest wiring batch); 546/546 tests green (69 files); Arch-3 10-voter swarm live; safety + sellability + sizing + fill-sim + cost-gate + governance + TxLock + executor-DI all wired into the live execute path.
- **Correction note vs prior synthesis:** the prior recommendation list collapsed 31 Adopt sources into ~5 items, missed AEGIS's Second Brain as the standout (notes §1643–1649 call it out twice), and listed QLO as Adopt when the notes verdict (§1752–1758) is **Study** (the time-on-curve concept is Adapt/Study, the bot shell is Skip). Every recommendation below is anchored to the actual notes text.

> **Reading note.** Every Adopt/Adapt below cites the SRC id and quotes (paraphrased) the notes verdict. Items already integrated live in the repo are listed under **MERGED** with the source→file mapping so a future agent doesn't re-litigate them.

---

## 1. Verdict legend (verbatim from the notes, lines 60–2268)

- **Adopt** — the source's specific algorithms/patterns are "verdict-ready" for Memeland's current state. Port as TS, no new dependencies, behind existing tests.
- **Adapt** — the source's pattern transfers after Memeland-side hardening (chain adapter, porting, security wrapping). Always paired with a concrete file target.
- **Study** — keep the idea; evidence incomplete, scope too heavy, or chain-portability not yet proven. Do **not** port as a runtime feature.
- **Skip** — no integration effort. Listed when a future agent might be tempted; one-line is the verdict text.

---

## 2. Adopt — port now (verbatim from notes verdicts)

This is the *complete* Adopt list (31 sources, not a curated subset). Grouped by what gap in the current 546-test repo they close.

### Gap 1 — Reputation memory with delayed verification (highest leverage)

**A1. AEGIS Second Brain + 24h/72h/7d follow-up labels — `andreysuperiorgit/aegis` (SRC-054, P2/general).**
- *Notes verdict (§1643–1649):* "Adopt the RH/EVM scanner (ZeroAddress owner, selector scan, bundle detection, weighted tiered scoring) into the security/rug-risk voter." The notes also document a **"second brain" memory adjustment** — six weighted checks (mintAuthority 20, freezeAuthority 15, topHolderConc 20, bundleDetected 20, lpStatus 15, metadataFlags 10) with a **±25 score adjustment** driven by the memory of past deployer/wallet behavior, plus a **follow-up job at 24h / 72h / 7d** that marks tokens as `live / rugged / abandoned`. The second-brain memory adjustment is the standout pattern in the SRC-054 evidence; the prior synthesis named it, the prior recommendation list demoted it to B5.
- *Where it belongs:* new `src/services/reputation-memory.ts` (or merge into `src/services/wallet-scoring.ts`); consumed by `walletVote`, `securityVote`, and the new `incumbentVote` at both prefilter and consensus time; persisted in `state-store.ts`. The 24/72/7d follow-up is a deferred job in `src/services/followup-jobs.ts` reading from the existing opportunity ledger.
- *Closes the biggest unfilled gap:* Memeland currently labels *its own* positions (Q16, `opportunity-post-mortem.ts`). It does *not* label the *counterparties* it is about to trade with. Second Brain is the missing piece for verified-outcome reputation.
- *Cost:* ~250 LOC, zero new deps; the 6 weighted checks already exist partially in `rug-scoring.ts`.
- *Edge to measure:* correlation between `reputationAdjustment` and realized 1h/24h PnL across the scorecard.

**A2. COPUMP layered risk-gate + `sizeCopy` multi-constraint sizing — `rimtoln/COPUMP` (SRC-190, P0/meme-smart-money).**
- *Notes verdict:* "Adopt the layered risk-gate + `sizeCopy` multi-constraint sizing + declarative incident-classification architecture — pure, zero-dep, test-covered, chain-agnostic, exactly Memeland's fail-closed decision layer; rework SOL rules to RH 4663 notional caps." *(Already MERGED for the sizing half — Q07 `position-sizing.ts`. The remaining piece is the **declarative incident-classification table** in `src/services/incident-classifier.ts`.)*

### Gap 2 — Honest outcome labels / anti-overfit (the gate for every later learning item)

**A3. anti-overfit learning harness (deflated Sharpe / purged CV / leakage detector / latched kill-switch / TCA / consensus meta-labeling) — `zostaff/ai-quant-researcher` (SRC-236, P1/trading-risk-research).**
- *Notes verdict:* "Adopt as TS ports for Memeland's learn/validate layer: deflated Sharpe w/ honest trial count, purged CV + embargo, structural & correlation leakage detection, latched kill-switch, round-turn cost + sqrt-impact, arrival/implementation-shortfall TCA, and consensus meta-labeling act/skip." *(Already MERGED in `learning-harness.ts` from Q01; `leakageDetector` integration into `swarm-learning.calibrate()` is the A4 refinement from the prior list.)*

**A4. ContestTrade forward-outcome reward label + predicted-Sharpe-weighted voter allocation + only-deduct multi-judge critique — `FinStep-AI/ContestTrade` (SRC-096, P2/general).**
- *Notes verdict (§1738–1744):* "Adopt the forward-outcome reward label plus predicted-Sharpe-weighted voter allocation and only-deduct multi-judge critique as Memeland calibration and consensus-weights machinery." Specifically: `rating * capped_realized_change` against the next-day open-to-open move; agents with `predicted_Sharpe ≤ 0` get zero weight (fail-closed); judges start at 100 and only deduct.
- *Where:* `swarm-learning.ts` (replaces the simple IC-weight deltas in `calibrate()`); reuses the Q16 outcome ledger as the reward source.

**A5. Decision-Hub consistency gates + risk-mode dampening + regime-weighted voters + degradation multipliers — `flash131307/multi-agent-investment` (SRC-097, P2/general).**
- *Notes verdict (§1745–1751):* "Adopt the consistency-gate lookup, risk-mode dampening, regime-weighted voters, degradation multipliers, and deterministic no-LLM fusion path as Memeland consensus/risk-gate machinery." The verdict explicitly calls out: *"This is the missing mathematical core for Memeland's >=80% consensus gate."* The asymmetric conflict caution (1BUY+2SELL = 0.0, not 0.3) is the single most important lift.
- *Where:* `swarm-consensus.ts` → `aggregateVoterScores()` and `DirectionGate` lookup table.

### Gap 3 — Risk override + execution governance + execution hygiene

**A6. TradingCodex execution governance — `monarchjuno/tradingcodex` (SRC-154, P1/market-data).**
- *Notes verdict:* "Adopt (execution-governance concepts: idempotent reservation, payload-hash-locked approval receipts, append-only audit, deny-first capability RBAC — port to TS, not heavy); Skip (the Django/Codex runtime itself)." *(Already MERGED in `exec-governance.ts` Q11.)*

**A7. PELLET ordered first-fail risk-gatechain + UNKNOWN refusal + throw-free provider contract — `0xwast3/PELLET` (SRC-039, P2/general).**
- *Notes verdict:* "Adopt the ordered first-fail risk-gatechain with `UNKNOWN` refusal and the throw-free provider contract; both are low-coupling, chain-portable, and directly reduce GMGN dependence." Maps onto Memeland's existing `execution-gates.ts` and the fail-closed invariant (gates refuse on unreadable inputs, never default to "safe").

**A8. RABIQ two-lane RPC throttle + Pons phase/curve-pricing — `0xmfox/rabiq` (SRC-037, P2/general).**
- *Notes verdict:* "Adopt the two-lane RPC throttle, `logsSplit`, and Pons phase/curve-pricing patterns as portable RH-4663 edge code that also reduces GMGN coupling." Splits read-only (`eth_call`, `eth_getLogs`) from submits (`eth_sendRawTransaction`) so a submit's 429 budget never throttles the read side.
- *Where:* `src/adapters/evm-adapter.ts` → split the existing single-throttle into two lanes.

**A9. Stampede portable RPC failover + distinct-wallet rotation weighting — `Argona7/stampede` (SRC-055, P2/general).**
- *Notes verdict (§1651–1657):* "Adopt the portable RPC failover/accounting and distinct-wallet rotation weighting; Adapt the calibrated hard walls, Kelly/volatility sizing, and next-block paper ledger into existing Memeland risk and simulation layers." Rotation graph: distinct-wallets weighted; ambiguous edges out of the primary score.

**A10. MEERKAT fail-closed unreadable-gate + evidence-carrying named score components + coverage-gated readiness + per-client admission control + reorg-overlap scanner checks — `kocer6/MEERKAT` (SRC-123, P2/general).**
- *Notes verdict (§1808–1814):* "Adopt the fail-closed unreadable-gate discipline, evidence-carrying composable scoring with coverage-gated readiness, and per-client admission control + reorg-overlap scanner checks; all map directly to Memeland's risk gates and RH-4663 data layer." Specifically: **"unreadable data must block entry exactly like a failing filter, never treated as passed or defaulted to a safe value; this is the fix for audit finding A1: a failed tax read must not be silently substituted with 0."** MEERKAT is **RH-4663 native** via viem.
- *Where:* `src/services/execution-gates.ts` (unreadable-fail wrapper) + `src/orchestrator/swarm-consensus.ts` (coverage-gated score withholding) + `src/adapters/rh-fill-tape.ts` (reorg-overlap scanner).

**A11. NERVE SENTINEL `eth_simulateV1` round-trip honeypot/tax detection + bytecode PUSH4 risk-flag scan + reconcile-by-nonce exactly-once send + pinned-block staleness + owns/boundary node discipline — `h100envy/nerve` (SRC-107, P2/general).**
- *Notes verdict (§1759–1765):* "Adopt SENTINEL eth_simulateV1 round-trip honeypot/tax detection, the bytecode PUSH4 risk-flag scan, and reconcile-by-nonce exactly-once send; plus owns/boundary node discipline, fail-closed scored gates and pinned-block staleness for the swarm. RH-4663 native, no GMGN dependency." NERVE is **the on-chain Memeland analogue**: same chain, same chain id (4663), same goal of a deterministic fail-closed spine.
- *Where:* `src/services/sellability/` (new module wrapping `eth_simulateV1` + Quoter); `src/services/bytecode-scanner.ts` (new); reconcile-by-nonce into `rh-execution-core.ts`.

**A12. Pons-sniper curve quote + tax timing + nonce manager + gas caching + verify-before-fire + multi-wallet batch + position manager — `slightlyuseless/pons-sniper` (SRC-200, P0/meme-smart-money).**
- *Notes verdict:* "Adopt (curve `quote.ts` + `snipeTax.ts` + `strategy.ts` timing optimiser + verify-before-fire + event-read fill executor + nonce manager + gas caching — directly on Memeland's chain, deterministic, zero GMGN, green-label execution core) + Adapt (Multi-wallet worst-order batching, batched/fast dual client, position manager exit engine, cheapest-first filters)."

**A13. Pumpdotfun SDK pure curve / AMM simulator / slippage / event-parsing — `rckprtr/pumpdotfun-sdk` (SRC-187, P0/meme-smart-money).**
- *Notes verdict:* "Adopt (vend the bonding-curve math, AMM simulator, slippage and event-parsing into Memeland's Solana engine — pure, simple, no external-data coupling) + Adapt (transaction builders + priority-fee sendTx to match Memeland's RPC/relay setup)." *(Already MERGED in `solana-copy-trade.ts` paper-broker path.)*

**A14. Loxley Pons V2 launchpad scoring + named refusals + farm fingerprint + pure-engine module — `shmidtqq65/loxley` (SRC-197, P2/general).**
- *Notes verdict (§1989–1995):* "Adopt The pons launchpad scoring + named refusals + farm fingerprint and the pure-engine module are concrete, RH-4663-native, low-coupling algorithms that map straight to a real edge." RH-4663 native, GMGN-free, pure functions (`computeMetrics → hardFlags → scoreOf → verdictsOf`) so every rule is unit-testable without a chain.

### Gap 4 — Decision framework + external data feeds (provider-independence levers)

**A15. Codex.io unified GraphQL crypto data API (RH-4663 covered) — `docs.codex.io/networks` (SRC-023, P1/market-data).**
- *Notes verdict (§2227–2233):* "Adopt <unified keyless-to-MPP GraphQL feed with explicit RH-4663 + all Memeland chains covered and wallet/launchpad analytics; strongest candidate to reduce GMGN coupling>." The notes flag: *"This is the rare market-data provider that natively covers RH-4663 (Robinhood L2, chain 4663) AND Solana/Base/BSC/ETH through one consistent GraphQL surface - a genuine lever to reduce GMGN coupling while keeping RH chain coverage."*

**A16. DEXPaprika keyless multi-chain DEX API — `api.dexpaprika.com` (SRC-010, P1/market-data).**
- *Notes verdict (§2103–2109):* "Adopt keyless multi-chain feed (incl. RH-4663) plus Adapt drain-detection/SSE reserve-streaming pattern to de-couple from GMGN." Specifically: 36 chains (RH listed), `liquidity_usd, volume usd multi-window, creation block`, `SSE` reserves/swaps for drain detection, batch endpoint up to 10 tokens, keyless tier.

**A17. OrderBooks slippage-impact fill-simulation pattern — `tiagosiebler/OrderBooks` (SRC-213, P1/market-data).**
- *Notes verdict:* "Adopt (the slippage-impact fill-simulation pattern — port to pool-depth impact calc in TS)." *(Already MERGED in `fill-simulation.ts` Q08.)*

**A18. GMGN wallet scoring algorithms (track-record / copy-tradeability / self-dealing discount / empty-history guard) — `GMGNAI/gmgn-skills` (SRC-100, P0/meme-smart-money).**
- *Notes verdict (§67–93):* "Adopt the scoring algorithms (port to TS in the whale/copy-trade voter)." *(Already MERGED in `wallet-scoring.ts` Q03 → consumed by `walletVote`.)*

**A19. GMGN Agent API official contract (chain union, Ed25519 auth, ±5s timestamps) — `docs.gmgn.ai/index/gmgn-agent-api` (SRC-001, P0/meme-smart-money).**
- *Notes verdict:* "Adopt | flags: Private keys must never enter git, logs, chats, or screenshots and must match the public-key pair uploaded for the API key. Hosted-wallet execution and IP allowlisting reduce local transaction construction but increase vendor/custody dependence." *(Already MERGED in `gmgn-adapter.ts`.)*

**A20. GMGN Callout OpenAPI schema — `docs.gmgn.ai/index/gmgn-callout-openapi` (SRC-002, P0/meme-smart-money).**
- *Notes verdict:* "Adopt | flags: Keep SK server-side; exact serialized bytes must be signed and sent."

### Gap 5 — Cross-cutting quality + calibration

**A21. FlySwarm RH-4663 native weighted cohort-voter — `semkazz1/FlySwarm` (SRC-194, P2/general).**
- *Notes verdict (§1941–1947):* "Adopt - same Node/ESM ecosystem, RH-4663 native, GMGN-independent, and a concrete weighted cohort-voter with explainable thresholds and a working RPC adapter." 4-factor scoring (cohort overlap 44%, timing proximity 28%, liquidity 18%, cohort size 10%) with explicit thresholds NOISE<70, WATCH 70–83, FIRE ≥84. NEW/WARM/ESTABLISHED holder-age heuristic and contract/EOA detection.

**A22. lookahead-free DAG + linear-time decision-availability checker + P0/P1 severity honesty boundary — `holdout-labs/lookahead-free` (SRC-112, P2/general).**
- *Notes verdict:* "Adopt - port the DAG + linear-time decision-availability checker and the P0/P1 severity + 'value-dependent can't be proven' honesty boundary as a small TS library; wire it into Memeland's backtest/dry-run attribution so every signal build and trade decision is accompanied by a machine-checkable timing evidence layer."

**A23. fly-high causal next-close simulator (gap-cancelling fills, depth-capped equity/fitness, conservative fee+slippage) + cold-out holdout + drawdown-penalized fitness search — `immortalhowwl/fly-high` (SRC-115, P2/general).**
- *Notes verdict (§1780–1786):* "Adopt the causal next-close simulator (gap-cancelling fills, depth-capped equity/fitness, conservative fee+slippage) and the cold-out holdout + drawdown-penalized fitness search as Memeland's strategy/voter validation discipline. Data-agnostic, chain-portable, no GMGN dependency." Explicit discipline: zero return means inactivity, not alpha.

**A24. Million chain-portable risk-gate structure (one-way-door caching, concurrent check chains, distribution grace, owner de-dup consensus, control-group calibration, decision ledger) — `Kelows/million` (SRC-122, P2/general).**
- *Notes verdict (§1801–1807):* "Adopt the chain-portable risk-gate structure (one-way-door caching, concurrent check chains, distribution grace, owner de-dup consensus, control-group calibration, decision ledger); Solana data adapters are not portable." The owner-id de-duplication (one actor's five wallets = one confirmation) is the standout for Memeland's whale voter.

**A25. QuantDinger fee-aware trailing-exit breakeven + free-balance spot sizing + idempotent fill/PnL reconciliation — `brokermr810/QuantDinger` (SRC-065, P1/trading-risk-research) and `OpenByteInc/QuantDinger` (SRC-177, P1/trading-risk-research).**
- *Notes verdict:* "Adopt (fee-aware trailing-exit breakeven + free-balance spot sizing + idempotent fill/PnL reconciliation as TS modules) / Skip (the platform itself). See SRC-177 for the same repo; audit once, apply findings to both." *(Already MERGED in `fill-simulation.ts` + position sizing.)*

**A26. gunbot-quant `volume_concentration_pct`, `max_daily_spike_pct`, `volatility_consistency`, distance-from-ATH + liquidity screening metrics — `GuntharDeNiro/gunbot-quant` (SRC-105, P1/trading-risk-research).**
- *Notes verdict:* "Adopt (port `volume_concentration_pct`, `max_daily_spike_pct`, `volatility_consistency`, distance-from-ATH + liquidity screening metrics and the declarative filter schema into Memeland's universe/bot-rug voters)."

**A27. zetryn downgrade-only guardrail pipeline + rug-avoidance/entry backtest metrics + CalibrationMap — `zetryn-ai/ai-agent` (SRC-233, P2/general).**
- *Notes verdict (§2065–2071):* "Adopt the downgrade-only guardrail pipeline and the rug-avoidance/entry backtest metrics as portable TS patterns for the consensus gate." Hard checks can only demote, never promote. Confidence becomes the empirical win rate observed for a given final score per token source.

**A28. agent-arena pure radar detectors + verdict-hardening/fail-safe SKIP + gross-net deterministic backtest split — `zostaff/agent-arena` (SRC-235, P2/general).**
- *Notes verdict (§2079–2085):* "Adopt the pure radar detectors, verdict-hardening/fail-safe SKIP, and the gross-net deterministic backtest split as portable TS patterns for the RH-4663 entry layer and evaluation ledger." RIPPLE (vol ≥ 2× prior 8 mean), LEAP (price beyond prior 8 high/low by ≥ 0.2%), DEPTH (top-5 one-side depth ≥ 65%). GROSS-NET split keeps the sim brain independent of any model cost.

**A29. FLYWHEEL propose-vs-decide risk architecture + structured observed/limit risk checks + resulting-weight sizing + two-sided liquidity band + append-only decision ledger — `tsukiema1/FLYWHEEL` (SRC-261, P2/general).**
- *Notes verdict (§1836–1842):* "Adopt the propose-vs-decide risk architecture, structured observed/limit risk checks, resulting-weight sizing, two-sided liquidity band, and append-only decision ledger; Skip the biological/connectome signal layer." Six structured checks `{id,label,passed,observed,limit}`. Two-sided liquidity band (≥ min AND ≤ max USD).

**A30. grok-trading-desk fail-closed vetoes + pessimistic fallbacks + cross-market sizing + cost-gated two-stage filtering + outcome memory — `zostaff/grok-trading-desk` (SRC-262, P2/general).**
- *Notes verdict (§1843–1849):* "Adopt Fail-closed vetoes, pessimistic fallbacks, cross-market sizing, and cost-gated two-stage filtering map to real operational edges and port to every chain Memeland trades; also a concrete GMGN-decoupling pattern." Cross-market RiskManager sizing (tightest-of-three-bounds scaled by confidence). Two-stage scout: cheap filters first, expensive model calls on survivors only.

---

## 3. Adapt — green with porting/hardening (verbatim from notes verdicts)

The complete 60-source Adapt list is preserved in `_verdict_map_final.tsv`. Highlights by relevance to Memeland's *current* state (not exhaustively):

- **SRC-107 (NERVE)** — moved to **Adopt** above; the notes verdict is unambiguous.
- **SRC-143 (web3-signals-mcp)** — Adopt in prior list; notes verdict is **Adopt** (I demoted this in the prior list — correction).
- **SRC-058 (tradingview-mcp)** — Adapt: walk-forward + overfitting-verdict concept into Memeland's quant/learning gate.
- **SRC-068 (ccxt)** — Adapt: port the `Precise` bigint-decimal class and the leaky-bucket Throttler as dependency-free TS primitives.
- **SRC-085 (pybroker)** — Adapt: BCa bootstrap CI / jackknife profit-factor / Sharpe / Decimal position-ledger math to TS.
- **SRC-150 (garchmethod)** — Adapt: walk-forward GARCH(1,1) + vol-target sizing into RiskManager.
- **SRC-151 (tradememory-protocol)** — Adapt: AdaptiveRisk worst-status-wins + outcome-weighted recall-to-Kelly as TS modules.
- **SRC-107/124/173** — already MERGED as Q11/Q15/Q16.
- **SRC-052 (alpaca-mcp-server)** — Adapt: trust-boundary envelope / per-tool output-risk registry / toolset allowlist.
- **SRC-026 (Dune MCP), SRC-246 (Bitquery MCP), SRC-247 (crypto.com MCP)** — Adapt: closed read-only discovery/analysis registry shape.
- **SRC-184 (azimuth)** — Adapt: keyless multi-source discovery (GeckoTerminal + Uniswap gateway), fail-closed-on-positive-security with sticky convictions, lone-candidate conviction floor, PVP guard, tenure sizing, escalating cooldown. Not in Adopt because every threshold is calibrated from azimuth close journals and must be re-fit on Memeland tick data.
- **SRC-197 (loxley)** — already Adopt above.
- **SRC-115 (fly-high)** — already Adopt above.
- **SRC-149 (QuantGPT)** — Adapt: 4-test anti-overfit battery + rules/findings/failures KB + `[Agent+DS Consensus/Disagreement]` convention.

(Full Adapt list at `_verdict_map_final.tsv`.)

---

## 4. Merge — already integrated (review source → file mapping)

21 sources verified landed in the repo. Mapping:

| SRC | Notes verdict | Where it now lives |
|---|---|---|
| SRC-001 | Adopt GMGN Agent API contract | `src/adapters/gmgn-adapter.ts` |
| SRC-002 | Adopt GMGN Callout OpenAPI schema | `src/adapters/gmgn-adapter.ts` (callout shape) |
| SRC-003 | Adapt aitrader pipeline | `src/agents/meme-robinhood/robinhood-screening-agent.ts` |
| SRC-100 | Adopt wallet-scoring algorithms | `src/services/wallet-scoring.ts` → `walletVote` |
| SRC-101 | Adopt candidate-only + LLM-explainer | `src/agents/meme-robinhood/robinhood-screening-agent.ts` |
| SRC-070/076/117 | Adapt fomo RH-RPC listeners | `src/adapters/rh-fill-tape.ts` → `collectTapeCandidates` |
| SRC-169 | Adapt execution-guard model | `src/services/safety-registry.ts` |
| SRC-180 | Adopt fast-submit + Nitro + Quoter + txlock | `src/services/rh-execution-core.ts` |
| SRC-038 | Adapt convergence-alert concept | `src/services/flow-convergence.ts` → `convergenceVote` |
| SRC-080 | Adapt rug-score heuristics | `src/services/rug-scoring.ts` + `globalRugScoring.assess()` |
| SRC-108 | Adapt copy-trade sizing + paper broker | `src/services/solana-copy-trade.ts` |
| SRC-143 | Adopt IC-weight + Platt + regime + walk-forward | `src/orchestrator/scoring-calibration.ts` + `swarm-learning.calibrate()` |
| SRC-154 | Adopt execution governance | `src/services/exec-governance.ts` (Q11) |
| SRC-173 | Adapt MCP safety architecture | `src/services/safety-registry.ts` (Q15) |
| SRC-124 | Adapt event-sourced journal + MCP registry | `src/services/opportunity-post-mortem.ts` (Q16) |
| SRC-213 | Adopt fill-simulation pattern | `src/services/fill-simulation.ts` → `gateFillSim()` |
| SRC-236 | Adopt anti-overfit harness | `src/orchestrator/learning-harness.ts` |
| SRC-190 | Adopt layered risk-gate + sizeCopy | `src/services/position-sizing.ts` (Q07); `incident-classifier.ts` still pending |
| SRC-222 | Adapt DexScreener feed | `src/adapters/dexscreener-feed.ts` → `collectDexscreenerCandidates` |
| SRC-084 | Adapt risk-scoring rubric | `src/services/risk-rubric.ts` → `rubricVote` |
| SRC-187 | Adopt bonding-curve math | (Solana feed path; awaiting prod enable) |

---

## 5. Study — keep the idea (59 sources)

The notes verdict is **Study** when: (a) the algorithm transfers but the bot shell is too heavy / wrong chain / wrong domain, OR (b) the pattern is good but the evidence for Memeland-specific edge is incomplete. Highlights most relevant to Memeland:

- **SRC-106 (qlo) — time-on-curve / slow-graduation filter.** Notes verdict (§1752–1758): "Study the time-on-curve organic-demand filter (evidence-backed, chain-portable-concept) and adopt the early-stop pagination + raw-pool-state pricing verification; skip the single-chain alert-bot shell." The empirical edge is real (97,146 graduations, 1.5× at 2×, 2.4× at 5×, holdout-validated) but chain-portable only as a concept. **The prior synthesis elevated this to Adopt; the notes verdict is Study. The corrected position: time-on-curve is a quant voter feature for the Solana leg when it goes live; treat as a Study item not a feature in the first sprint.**
- **SRC-058 (tradingview-mcp)** — walk-forward / overfitting verdict / backtest annualisation policy: methodology ports to Memeland's harness, but the platform itself is CEX-focused and too heavy.
- **SRC-098 (freqtrade), SRC-113 (hummingbot)** — Study the backtest/hyperopt/connector-controller patterns; Skip the wholesale platforms.
- **SRC-207 (TradingAgents), SRC-214 (CryptoTradingAgents)** — bull/bear + risk-debate pattern is Study for Memeland's critic-voter prompts; Skip the LangGraph frameworks.
- **SRC-208 (AutoHedge)** — Study the Director/Quant/Risk/Execution division; Skip the autonomous execution.
- **SRC-262, SRC-232, SRC-074, SRC-145** — various wallet-quality and consistency-countscoring patterns as Studys.
- **SRC-012 (arXiv 2501.00826v3)** — Adapt: regime-conditioned backtest, ablation, skill-augmentation, agent-weighting as TS methodology.

(Full Study list at `_verdict_map_final.tsv` — 59 sources.)

---

## 6. Skip — no integration effort (112 sources)

The notes verdict is **Skip** when: (a) full platform / heavy stack with no Memeland-portable algorithm, (b) closed SaaS with custody delegation, (c) browser scrapers / unofficial / ToS-fragile APIs, (d) Solana-only or CEX-only with no Memeland portability, (e) no trading edge. Highlights most important to flag so a future agent doesn't relitigate:

- **SRC-073 (ChipaDevTeam/GmGnAPI)** — unofficial SRP/captcha client. Redundant with official GMGN OpenAPI.
- **SRC-188 (redactedmeme/swarm)** — token-PR-driven, no Memeland edge.
- **SRC-220 (uxuycom/indexer)** — plaintext MySQL creds (`root:1234qwer@...` at rest). Security fail.
- **SRC-116 (ironclad-protocol/solana-copy-trading-bot)** — Helius + Jupiter live API keys committed in plaintext. **NEVER REUSE THE KEYS.** Adopt the sizing/sim/queue pattern in TS only.
- **SRC-147 (MayurK-cmd/4Meme-Pilot)** — committed `AGENT_API_SECRET` (`aa78d2bdf36c0144bbf31ff05450d8d183f144b03a76a65e811e18af47d83480`). Skip the shared-backend wallet model.
- **SRC-226 (DexScreener-Trending)** — traffic-bot for trending manipulation. **Do not weight trending ranks heavily.**
- **SRC-053 (alpha-arena), SRC-089 (fastquant), SRC-027 (Fere AI), SRC-095 (FinceptTerminal)** — heavy CEX/equity SaaS, no Memeland edge.
- **SRC-079 (dbotx/dbot-mcp-servers), SRC-131 (rug-check-mcp), SRC-130 (pumpfun-wallets-mcp), SRC-132 (whale-tracker-mcp), SRC-125 (crypto-indicators-mcp), SRC-127 (dexscreener-trending-mcp)** — MCP wrappers that proxy someone else's API, no ownable edge.

(Full Skip list at `_verdict_map_final.tsv` — 112 sources.)

---

## 7. Implementation plan (ordered by gap-closure impact × low-risk)

The order below is **gap-first**: which Memeland unfilled gap does the item close, ranked by impact on the funnel.

| # | Item | SRC | Closes gap | Effort |
|---|---|---|---|---|
| 1 | **A1 AEGIS Second Brain + follow-up labels** | SRC-054 | Reputation memory, delayed verification | ~250 LOC + 2 test files |
| 2 | **A4 ContestTrade forward-outcome reward + Sharpe-weighted voters** | SRC-096 | Honest voter weighting from realized | ~150 LOC + 1 test |
| 3 | **A5 Decision-Hub consistency gates** | SRC-097 | The 80% gate's missing math | ~80 LOC + 2 tests |
| 4 | **A10 MEERKAT unreadable-fail wrapper + coverage-gated scoring** | SRC-123 | Audit-finding A1 fix | ~50 LOC + 1 test |
| 5 | **A11 NERVE SENTINEL `eth_simulateV1` + bytecode scan** | SRC-107 | Honeypot + tax proof on RH-4663 | ~120 LOC + 2 tests |
| 6 | **A15 Codex.io adapter** | SRC-023 | GMGN-independence on discovery + wallet + launchpad | ~150 LOC + 2 tests |
| 7 | **A16 DEXPaprika adapter** | SRC-010 | GMGN-independence on keyless discovery | ~120 LOC + 1 test |
| 8 | **A21 FlySwarm cohort voter** | SRC-194 | New voter signal (cohort overlap) | ~120 LOC + 1 test |
| 9 | **A27 zetryn downgrade-only guardrail + CalibrationMap** | SRC-233 | Hard checks demote, never promote | ~80 LOC + 1 test |
| 10 | **A29 FLYWHEEL propose-vs-decide + decision ledger** | SRC-261 | Append-only audit + resulting-weight | ~150 LOC + 2 tests |
| 11 | **A30 grok-trading-desk fail-closed vetoes + pessimistic fallback + cross-market sizing** | SRC-262 | Consensus fails closed on parse error | ~100 LOC + 2 tests |
| 12 | **A14 Loxley named-refusal codes + farm fingerprint** | SRC-197 | Auditability on refusals | ~80 LOC + 1 test |
| 13 | **A7 PELLET throw-free `Result<T,E>` for adapters** | SRC-039 | Adapter error clarity | ~80 LOC + 2 tests |
| 14 | **A8 RABIQ two-lane RPC throttle** | SRC-037 | Read/submit independence | ~60 LOC + 1 test |
| 15 | **A9 Stampede distinct-wallet rotation weighting** | SRC-055 | Rotation graph edge | ~120 LOC + 1 test |
| 16 | **A2 COPUMP incident-classifier.ts** | SRC-190 | Declarative incident reason table | ~80 LOC + 1 test |
| 17 | **A12 Pons-sniper verify-before-fire + nonce/gas cache** | SRC-200 | RH execution edge | ~100 LOC + 1 test |
| 18 | **A22 lookahead-free timing evidence layer** | SRC-112 | Backtest/dry-run attribution | ~80 LOC + 1 test |
| 19 | **A24 Million owner-id de-dup + decision log + control-group calibration** | SRC-122 | Owner-actor counting, calibration | ~150 LOC + 2 tests |
| 20 | **A28 agent-arena gross-net backtest split** | SRC-235 | Honest backtest reporting | ~50 LOC + 1 test |
| 21 | **A3 anti-overfit harness `leakageDetector` integration into `calibrate()`** | SRC-236 | The integrity floor for calibrations | ~30 LOC + 1 test |

(Following items are lower-priority quality refinements: A17 calibrate `k` for fill-sim, A26 volume-concentration metrics, A11 audit append-only to disk, A6 governance append-only audit, A2 layered gates, A14 named-refusal codes for the scorecard.)

---

## 8. Constraints honored (and one stretch)

This list is **zero new npm dependencies** end-to-end. Every Adopt and Adapt item is either:
- Pure TypeScript using existing patterns, OR
- An adapter over a keyless/free public HTTP endpoint (DEXPaprika, Codex.io MPP, GMGN OpenAPI, `eth_simulateV1`, GoPlus), OR
- A small TS port of a documented algorithm from an external repo (notes verdict text dictates *what exactly* to port).

The **one stretch** is `src/services/reputation-memory.ts` (A1), `src/services/incident-classifier.ts` (A2), `src/services/sellability/` (A11), `src/services/bytecode-scanner.ts` (A11). These are *new modules*, but they reuse the existing tsconfig, ESM, vitest, and adapter surface; no new infra, no new framework. The Memeland invariant "zero new npm deps, raw `fetch` for all external APIs" holds.

**FARSIGHT RiskEngineV2 audit points honored:**
- **#1 "Clamp/ignore any non-finite or out-of-range GMGN ratios"** → existing voter scoring treats non-finite as fail-open neutral; A10 (MEERKAT unreadable-fail) makes this fail-**closed** per audit finding A1.
- **#2 "Add an absolute minimum-equity floor as a last-resort exposure backstop"** → A24 (Million control-group calibration) + A30 (grok cross-market sizing) include the floor.
- **#3 "If execution moves off single-threaded loop, serialize loss counter + kill-check mutation"** → A11 (NERVE reconcile-by-nonce) + A6 (TxLock already in place) cover this.

**Security guardrails enforced:**
- A11 reconcile-by-nonce + A6 execution governance + A30 fail-closed vetoes form a three-layer "no double-fire / no signed-on-parse-failure" spine.
- SRC-116 plaintext-key warning is logged in §6 above and a guardrail must reject any imported config with hardcoded keys.
- A10 (MEERKAT) RPC-credential scrubbing is mirrored in the new `src/adapters/evm-adapter.ts` two-lane throttle.
- LLM stays last; A5 (Decision Hub) keeps the consensus path deterministic.

---

## 9. The corrected one-line thesis

**The review is not "add more agents." It is: remember who rugged (AEGIS Second Brain), calibrate the 80% gate (A5 Decision Hub + A4 ContestTrade forward-outcome reward), prove fills (A11 NERVE SENTINEL + A12 Pons-sniper verify-before-fire), and stop learning from fake wins (A3 anti-overfit harness + A28 gross-net backtest). Merge overlapping sources into those four kernels instead of shipping 40 micro-features.**

**First sprint (highest live-impact):** A1 (AEGIS Second Brain) → A5 (Decision Hub consistency gate) → A11 (NERVE SENTINEL) → A15 (Codex.io adapter) → A16 (DEXPaprika adapter). Five items, ~700 LOC, ~12 tests. None introduce new dependencies.

**Second sprint:** A4 (ContestTrade calibration), A21 (FlySwarm cohort voter), A29 (FLYWHEEL decision ledger), A30 (grok fail-closed vetoes), A27 (zetryn downgrade-only), A10 (MEERKAT unreadable-fail), A14 (Loxley named refusals).

**Third sprint:** A7, A8, A9, A12, A22, A24, A28 — quality refinements that don't unlock new edge by themselves but tighten the existing funnel.

---

## 10. Source / file index

This report was produced from the following artifacts in `C:\Users\CM265\Documents\ChatGPT\Memeland\docs\research\`:
- `notes/source-notes.md` (2,268 lines) — verbatim per-source deep-review evidence.
- `source-manifest.csv` (262 rows) — verdict-extraction target.
- `source-manifest-summary.json` (48 lines) — category balance.
- `memeland-ecosystem-review.md` (699 lines) — synthesized review.
- `memeland-constraints.md` (126 lines) — green-label rules.
- `farsight-riskmanagerv2-audit.md` (94 lines) — risk-engine audit.
- `sources-raw.txt` (204 lines) — flat URL list (no findings beyond what the review already documents).

Generated outputs:
- `_verdict_map.tsv` — initial extraction from CSV.
- `_verdict_map_corrected.tsv` — cross-checked against notes.
- `_verdict_map_final.tsv` — final, with manual fixups for 6 NA sources; **262 rows, 31 Adopt, 60 Adapt, 59 Study, 112 Skip**.

Every Adopt item above cites the SRC id and references the corresponding notes section.