# FARSIGHT / SoK Robustness Checklist — `RiskManagerV2` audit

**Scope:** `src/orchestrator/risk-engine-v2.ts` (`RiskEngineV2` + `globalRiskEngineV2`),
wired end-to-end through the execution path in `src/index.ts` and the new
`src/services/market-sentinel.ts` (decoupled kill-switch).

**Method:** SoK/FARSIGHT robustness framing (arXiv 2609.19705) applied to a
memecoin auto-execution risk layer. Each checklist dimension is a heading with
`Status`, `Evidence`, and `Gap / Mitigation`. Verdicts are: `Robust`,
`Adequate`, or `Weak`.

---

## 1. Info-source integrity

**Status: Adequate**

Risk decisions currently depend on three sources: local PnL/drawdown accounting,
the market-regime filter, and (new) the bot-detection window. The risk layer
itself ("am I allowed to trade?") reads only locally-derived numeric state — it
never parses untrusted on-chain text or an LLM verdict.

- **Evidence:** `evaluateTradeRisk` consumes `portfolioTotalUsd`,
  `currentDrawdownPercent`, `existingPositions`, and numeric ATR. All are
  computed from the bot's own ledger, not scraped text.
- **Gap / Mitigation:** the bot-detection window is fed by GMGN API fields
  (`bundlerRate`, `top10HolderRate`...). If the API is compromised or a garbage
  outlier lands in the window, the Sentinel could trip on a lie. Mitigated: the
  Sentinel requires `requireConsecutive` persistent passes (default 3) and a
  `highRiskFraction` > 0.2, so a single bad row can't trip it. Recommend
  clamping any field that reads as `NaN`/`> 1` to unknown before scoring (the
  scorer already treats non-finite as fail-open).

## 2. Injection / parameter-confusion

**Status: Robust**

- **Evidence:** kill-switch state is a private boolean with explicit
  `activateKillSwitch(reason)` / `resetKillSwitch()` methods; `reason` is only
  ever a log string, never evaluated. Config is a bounded `Partial<RiskEngineConfig>`
  applied at construction with defaults — no free-form key/value reflection.
- **Gap / Mitigation:** `consecutiveLossesCount` and the kill-switch are in-memory;
  a restart wipes them. That is fail-open (trading resumes) rather than a loading
  path, so no injection surface. Keep it that way — do not persist actor-controlled
  strings into the engine.

## 3. Flash-crash / fast-sequencing

**Status: Adequate**

- **Evidence:** the kill-switch is checked at the top of `evaluateTradeRisk`,
  and `index.ts` re-checks `checkKillSwitchStatus()` immediately before every
  auto-execute. Drawdown/volatility caps are computed against
  `currentDrawdownPercent`, which is updated from realized equity deltas.
- **Gap / Mitigation:** concurrent sequencing isn't serialized inside the engine
  itself (two rapid `recordTradeOutcome` calls could both increment
  `consecutiveLossesCount` before a reset lands). In the current single-threaded
  Node loop this is not exploitable, but if execution moves to worker threads,
  wrap the loss counter + kill-check in a mutex. The new MarketSentinel mitigates
  the worst fast-sequencing case (bulk bot entries) by tripping on a *market-wide*
  persistent signal rather than waiting for individual losses.

## 4. Exposure collapse / portfolio concentration

**Status: Robust**

- **Evidence:** `RiskEngineV2` enforces per-asset (`maxSingleAssetExposurePercent`),
  per-chain (`maxSingleChainExposurePercent`), and correlation caps
  (`maxCorrelatedPositionsCount`), plus volatility-based sizing. `RiskManager`
  adds deployer-cluster and sector caps. Exposure math guards `portfolioTotalUsd`
  against `/0` (`Math.max(portfolioTotalUsd, 1)`).
- **Gap / Mitigation:** caps are percentage-based, so a *portfolio* that shrinks
  after drawdown still allows proportional re-entry up to the same % — the
  USD exposure tightens, which is acceptable. Consider an absolute minimum-USD
  equity floor as a final backstop if the account ever collapses far below
  operating capital.

---

## Summary

| Dimension | Status | Key mitigation |
| --- | --- | --- |
| Info-source integrity | Adequate | local numeric state + persistence guard |
| Injection / parameter confusion | Robust | typed config, string-only reasons |
| Flash-crash / fast sequencing | Adequate | kill-check before execute + Sentinel |
| Exposure collapse | Robust | multi-layer asset/chain/correlation caps |

**Recommendations (non-blocking):**
1. Clamp/ignore any non-finite or out-of-range GMGN ratios before the bot-risk
   window consumes them (defense in depth for info-source integrity).
2. Add an absolute minimum-equity floor as a last-resort exposure backstop.
3. If execution ever moves off the single-threaded loop, serialize the loss
   counter + kill-check mutation.
