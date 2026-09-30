-- 006_trader_rows.sql — P9: durable trader-persistence ledger.
-- The 24h∩7d∩30d persistence signal (and the regime-coverage unlock it feeds)
-- was process-local and reset on every restart. This table makes it durable:
-- upsert by (handle, window) keeps the richest/newest observation authoritative.
-- Idempotent (CREATE IF NOT EXISTS) so it is safe on an already-migrated DB.
CREATE TABLE IF NOT EXISTS trader_rows (
  handle     TEXT NOT NULL,
  window     TEXT NOT NULL,
  payload    JSONB NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (handle, window)
);