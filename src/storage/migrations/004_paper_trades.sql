-- 004_paper_trades.sql — P8: durable paper-trade history.
-- The paper ledger was a process-local Map, so the closed-trade coverage the
-- approval-unlock gate depends on reset on every restart. This table makes it
-- durable: upsert by id keeps the LATEST state (open or closed) authoritative.
-- Idempotent (CREATE IF NOT EXISTS) so it is safe on an already-migrated DB.
CREATE TABLE IF NOT EXISTS paper_trades (
  id         TEXT PRIMARY KEY,
  payload    JSONB NOT NULL,
  updated_at BIGINT NOT NULL
);
