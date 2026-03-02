-- Add priority column to _sync_obj_runs for deterministic task ordering.
-- Priority mirrors the `order` field from resourceRegistry so workers
-- always process parent resources (products, prices) before children
-- (subscriptions, invoices).

ALTER TABLE "stripe"."_sync_obj_runs"
  ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_sync_obj_runs_priority
  ON "stripe"."_sync_obj_runs" ("_account_id", run_started_at, status, priority);
