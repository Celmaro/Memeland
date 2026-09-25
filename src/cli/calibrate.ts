/**
 * #2 — Calibration backfill CLI: `npx tsx src/cli/calibrate.ts`
 *
 * Replays the signal ledger through the current swarm, labels follow-through
 * from GeckoTerminal klines, sweeps thresholds, and prints the earned floor.
 * Turns the accumulated (mostly unlabelled) ledger into a real calibration
 * dataset without waiting for fires.
 */

import { globalStateStore } from '../services/state-store.js';
import { fetchKlinesWithGeckoFallback, geckoNetworkIdFor } from '../agents/shared/ml-predictor.js';
import { sweepThresholds, klinesFollowThroughLabeler } from '../orchestrator/calibration-harness.js';

async function main(): Promise<void> {
  const store = globalStateStore;
  // Gecko klines need the chain's network id; the ledger stores domain only, so
  // map the meme domain to bsc (primary venue) for the follow-through read.
  const labeler = klinesFollowThroughLabeler({
    fetchKlines: async (chain, address, hours) => {
      const net = geckoNetworkIdFor(chain === 'MEME_ROBINHOOD' ? 'bsc' : chain.toLowerCase());
      if (!net) return null;
      const rows = await fetchKlinesWithGeckoFallback(
        () => Promise.resolve(null), // no GMGN primary in the backfill CLI
        net,
        address,
      );
      return (rows ?? []).map((r) => ({ timestamp: r.timestamp * 1000, close: r.close })) as unknown as ReturnType<NonNullable<Parameters<typeof klinesFollowThroughLabeler>[0]['fetchKlines']>>;
    },
  });

  const ledger = (store as any).getSignalLedger?.() ?? [];
  const labelled = [];
  for (const entry of ledger as Array<{ symbol: string; domain: string; contractAddress: string; totalConfidence: number; passed: boolean; timestamp: string; rawPayloadJson: string }>) {
    const label = await labeler(entry);
    if (label === null) continue; // unlabelled (no klines yet) — never a false fire
    labelled.push({ symbol: entry.symbol, confidenceScore: entry.totalConfidence, passed: Boolean(entry.passed), followThrough: label });
  }

  const report = sweepThresholds(labelled, { minPrecision: 0.15, minRecall: 0.3 });
  console.log('[CALIBRATE] ============================================');
  console.log(`[CALIBRATE] ledger rows: ${(ledger as unknown[]).length}  labelled: ${report.labelled}  follow-through up: ${report.upTotal}`);
  console.log('[CALIBRATE] threshold | count | precision | recall');
  for (const t of report.thresholds) {
    console.log(`[CALIBRATE]    ${String(t.threshold).padStart(4)}   | ${String(t.count).padStart(4)} | ${(t.precision * 100).toFixed(0).padStart(4)}% | ${(t.recall * 100).toFixed(0).padStart(4)}%`);
  }
  console.log(`[CALIBRATE] recommended floor: ${report.recommendedFloor ?? 'NONE (data insufficient)'}`);
  console.log(`[CALIBRATE] rationale: ${report.rationale}`);
}

main().catch((err) => {
  console.error('[CALIBRATE] failed:', err.message);
  process.exit(1);
});
