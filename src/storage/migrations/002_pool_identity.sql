-- 002_pool_identity.sql — P4: retain DEX pair/pool identity at the observation boundary.
-- token vs pool separation: a market observation can now be attributed to a specific
-- pool (dex pair) rather than only the token, so liquidity/flow deltas across pools
-- on the same token stay distinguishable.
-- Idempotent (ADD COLUMN IF NOT EXISTS) so it is safe on an already-migrated DB.
ALTER TABLE discovery_observations
  ADD COLUMN IF NOT EXISTS pool_address TEXT,
  ADD COLUMN IF NOT EXISTS dex TEXT;
CREATE INDEX IF NOT EXISTS idx_discovery_observations_pool ON discovery_observations (pool_address);
