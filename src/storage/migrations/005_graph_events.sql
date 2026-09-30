-- 005_graph_events.sql — P9: durable identity-graph history.
-- The on-chain identity graph was process-local, so wallet→handle→co-trade
-- clusters (the anti-double-count moat) reset on every restart. This table
-- makes it durable: append-only events with provenance so hydrate can replay.
-- Idempotent (CREATE IF NOT EXISTS) so it is safe on an already-migrated DB.
CREATE TABLE IF NOT EXISTS graph_events (
  id         BIGSERIAL PRIMARY KEY,
  payload    JSONB NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_graph_events_created_at ON graph_events (created_at);