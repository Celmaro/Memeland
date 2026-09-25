import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Default project-wide discovery; the stale-worktree lesson is handled by
    // git (worktrees are removed), not by overfitting include/exclude here.
    environment: 'node',
  },
  coverage: {
    provider: 'v8',
    include: ['src/orchestrator/**', 'src/services/anti-fooling.ts', 'src/services/rpc-failover.ts', 'src/services/provider-rate-limiter.ts', 'src/services/fresh-pair-watchlist.ts'],
    // Decision-core floor: the modules that gate trades must stay covered.
    // Misses here are the merge-overwrite class of bug — behavior, not syntax.
    thresholds: {
      statements: 60,
      branches: 50,
      functions: 60,
      lines: 60,
    },
  },
});