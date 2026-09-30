-- 003_decision_events.sql — P7: durable decision-event history.
-- The decision ledger was an append-only JSONL audit file that the process never
-- rebuilt state from. This table gives it a Postgres-backed history so operational
-- state (seq, audit, send/reconcile outcomes) can be reconstructed across restarts.
-- Idempotent (CREATE IF NOT EXISTS) so it is safe on an already-migrated DB.
CREATE TABLE IF NOT EXISTS decision_events (
  id         BIGSERIAL PRIMARY KEY,
  payload    JSONB NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decision_events_created_at ON decision_events (created_at);