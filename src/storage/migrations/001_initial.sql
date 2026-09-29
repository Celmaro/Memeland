-- 001_initial.sql — the first durable table at the observation boundary.
-- Idempotent (CREATE IF NOT EXISTS) so it is safe on an already-provisioned DB.
-- Subsequent schema changes become new files (002_..., 003_...) applied in
-- filename order and tracked in `schema_migrations`.
CREATE TABLE IF NOT EXISTS discovery_observations (
  chain          TEXT NOT NULL,
  token_address  TEXT NOT NULL,
  source         TEXT NOT NULL,
  at             BIGINT NOT NULL,
  cost_credits   NUMERIC DEFAULT 0,
  PRIMARY KEY (chain, token_address, source, at)
);
CREATE INDEX IF NOT EXISTS idx_discovery_observations_at ON discovery_observations (at DESC);
