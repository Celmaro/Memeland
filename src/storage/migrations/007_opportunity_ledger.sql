-- 007_opportunity_ledger.sql — P6: durable opportunity-ledger snapshot in Postgres.
-- The ledger already survives restarts via an atomic JSON file; this table gives it
-- the same Postgres backing as the other durable ledgers (P7/P8/P9), so a deployment
-- with a DB keeps its opportunity history co-located with the rest of the evidence.
-- One snapshot row (upserted on every debounced save). Idempotent.
CREATE TABLE IF NOT EXISTS opportunity_ledger_state (
  id         TEXT PRIMARY KEY,
  payload    JSONB NOT NULL,
  updated_at BIGINT NOT NULL
);