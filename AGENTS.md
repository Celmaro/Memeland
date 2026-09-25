# AGENTS.md — Memeland (Multi-Chain Autonomous Memecoin Trading Bot)

## The one rule
Screening is math, not vibes: no trade reaches execution until the security hard-gate
passes, the 5-slot swarm consensus clears the ≥ 80% floor (never lowered), the risk veto
holds, and every fired signal ships a scorecard with reasons. LLMs draft thesis cards and
critiques — never the verdict itself.

## Current context (verified 2026-09-25)
- Multi-chain autonomous memecoin trading bot. TypeScript, Node ≥ 20, viem, discord.js.
  Entry: src/index.ts. Chain scope: sol / bsc / base / eth / robinhood via ONE multi-chain
  meme agent (chain = runtime parameter in collectCandidates, not a per-chain agent class).
  Robinhood #4663 retained as the existing EVM execution venue.
- Module removals complete: lp-robinhood (Krystal), nft (OpenSea), alpha-robinhood,
  **whale-eth (Hyperliquid), and the regime voter** REMOVED — adapters, agents, strategies,
  position-scanner, and all Discord/Telegram/CLI/API/tool-registry wiring. The bot now runs
  a single domain: `meme-robinhood`. Voter count: **5 consolidated slots** (was 10).
- The Hyperliquid whale stack and market-regime service were stripped entirely (commit
  history: "strip: remove regime voter + market-regime service + Hyperliquid whale stack").
  There is deliberately NO macro risk-off signal today — revisit before Phase 3.

## Architecture: 5-slot consensus (Arch 3, consolidated from the 10-voter swarm)
Fine-grained emitters still exist (quant/ml/whale/wallet/convergence/rubric/security/
sentiment/critic) but `consolidateOpinions()` in voters.ts maps them into 5 gate slots:

1. **Momentum**  (quant + ml)   — GMGN rank/trenches/hot + technical indicators + kline ML
2. **Flow**      (whale + wallet + convergence) — who's buying: smart-money flow, wallet
                                score, accumulation convergence (Blockscout-fed)
3. **Security**  — GoPlus audit (keyless) + GMGN fallback + holder concentration +
                                bot-detection + rug scoring + **deterministic anti-fooling**
4. **Sentiment** — on-chain social + DexScreener boosts/ads (direct feed) + X (optional);
                                VETO/tiebreak, never an additive lift
5. **Critic**    (critic + rubric) — LLM adversarial pass (optional) + risk rubric

Weights (sum 1.0): momentum 0.30 / flow 0.20 / security 0.25 / sentiment 0.15 / critic 0.10.

**The gate is CONJUNCTIVE, not a single average:**
1. SECURITY HARD-GATE: security vote < 70 → refuse BEFORE any averaging (`SECURITY` refusal)
2. Consensus: weighted average of the slots that rendered ≥ 80% (flat `CONSENSUS_FLOOR`, never regime-aware)
3. Risk-engine-v2 veto → position manager (TP/SL/trailing)
- swarm-learning recalibrates the 5 slot weights by realized outcome (±30% bounded, renormalized).
- `orchestrator/calibration-harness.ts` replays the signal ledger through the swarm to
  measure threshold vs. follow-through and EARNS the floor number — the 80% figure is
  evidence-based, not asserted.

## Autonomy ladder (Arch 5) — never skip a phase
Phase 1 SIGNAL_ONLY: score live, journal predicted-vs-actual for every fired signal.
Phase 2 APPROVAL: orders queue to Discord/TG one-click approve; N > 50 approved fills.
Phase 3 AUTO: only after positive expectancy in Phase 2; daily loss cap + kill-switch.
Currently: **Phase 1 / DRY_RUN** (`AUTO_EXECUTE_ENABLED=false`, `LIVE_TRADING_ACKNOWLEDGED` unset).

## Data stack (free tiers, keyless-first, raw fetch, zero new SDKs)
- GMGN OpenAPI — enrichment ONLY (audit fallback, klines, smart-money/KOL track); NOT discovery.
- DEXPaprika — volume-ranked discovery, all 5 chains, keyless.
- GeckoTerminal — new_pools/trending discovery + OHLCV; 30/min budget.
- DexScreener — token-profiles listing + `/latest/dex/tokens` market-field enrichment
  (batch 30) + boosts/ads direct feed (paid-hype signal).
- Ankr-style PairCreated feed — on-chain discovery via `eth_getLogs` through the RPC
  pool, chunked + bounded (`ANKR_FEED_ENABLED=true`). Robinhood factory deliberately
  ABSENT until verified on-chain.
- GoPlus — contract security, keyless, primary EVM audit.
- Blockscout — token-transfers → provisional BuyEvents for the convergence voter
  (`BLOCKSCOUT_FEED_ENABLED=true`).
- Per-chain RPC failover pools (`rpc-failover.ts`) — 4-5 verified hosts per EVM chain,
  6 for Solana; chain-id verified probes, 429 circuit breaker, request-level failover
  via `reportRPCFailure` (lifi broadcast + Quoter sellability).

## Non-negotiables
1. Fail-closed: unknown volume/liquidity/mcap/security ⇒ reject, never pass.
2. Execution modes DRY_RUN / SIGNAL_ONLY / APPROVAL / AUTO_EXECUTE; live trades only in
   AUTO_EXECUTE behind Phase-3 gates with verified keys.
3. Pacing + backup-key rotation on every provider: GMGN (429 ban extends +5s per retry —
   no retry spam; per-chain key pools GMGN_API_KEY_SOL...), GeckoTerminal 30/min, GoPlus
   batch, Blockscout credit budget. `provider-rate-limiter.ts` enforces budget +
   concurrency + 429 circuit breaker globally.
4. Chain-aware gates: renounced = Solana-only; honeypot = EVM-only; token_signal booster
   absent on base/eth — degrade silently, never fabricate.
5. Dedupe per chain by lowercase contract address, 60s cooldown.
6. Never commit .env; backups as *_BACKUP_KEYS; GMGN keys IPv4-only; Ed25519 only for trade routes.
7. Consensus floor ≥ 80% never lowers. Security is a hard gate, never outvoted.
8. `UNAVAILABLE ≠ 0`: a feed that failed must surface as `sourceUnavailable` (distinct
   prefilter reason), never masquerade as a real zero-volume observation.

## Behavior norms
- Scan on 5–10 min cycles; enrich only post-prefilter candidates via batch endpoints.
- Proof over claims: every report names the live log signature it enabled and shows the
  funnel counter moved. fired=0 across deploys ⇒ diagnostic report, not another patch.
- Cheap deterministic math first; LLM calls reserved for critic/thesis/post-mortem
  (sentiment is now algorithmic veto, not an LLM vote).
- TDD: every change keeps the regression floor green before commit (currently 127 files /
  966 tests, all passing).

## Key paths (6)
- src/adapters/gmgn-adapter.ts — widen Chain union (line 4); per-chain key pools
- src/agents/meme-robinhood/robinhood-screening-agent.ts — the single multi-chain meme agent (chain loop)
- src/agents/shared/gmgn-meme-helpers.ts — chain-agnostic prefilter/dedupe/signal logic
- src/orchestrator/swarm-consensus.ts + voters.ts — the conjunctive gate (security hard-gate
  THEN 5-slot weighted average) + consolidation mapper; never the floor
- src/orchestrator/calibration-harness.ts — offline replay: measures threshold vs follow-through, earns the floor
- src/services/anti-fooling.ts + rpc-failover.ts + provider-rate-limiter.ts — deterministic
  anti-fooling, per-chain RPC pools, global rate-limit/429 circuit breaker
