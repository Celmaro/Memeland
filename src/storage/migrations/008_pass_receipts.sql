-- 008_pass_receipts.sql — 6.1: immutable per-pass audit receipts.
-- Promotes "did the bot fire" from log-grep to a queryable, durable record: each
-- pass appends one row (timestamp, chains, candidate-by-source, budget, failures,
-- gate before/after, fired). Idempotent (CREATE IF NOT EXISTS).
CREATE TABLE IF NOT EXISTS pass_receipts (
  id         BIGSERIAL PRIMARY KEY,
  payload    JSONB NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pass_receipts_created_at ON pass_receipts (created_at);