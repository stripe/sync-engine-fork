-- Add created_gte / created_lte columns for time-range partitioned parallel sync.
-- Workers use these to scope their Stripe list calls to a specific created window.
-- Stored as Unix epoch seconds (INTEGER) to match Stripe's created filter format.
-- created_gte defaults to 0 for non-chunked rows (required by PK).
ALTER TABLE "stripe"."_sync_obj_runs" ADD COLUMN IF NOT EXISTS created_gte INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "stripe"."_sync_obj_runs" ADD COLUMN IF NOT EXISTS created_lte INTEGER;

-- Expand PK to include created_gte so multiple time-range chunks of the same object can coexist.
-- PK constraint kept original name from 0053 (_sync_obj_run_pkey) after table rename in 0057.
ALTER TABLE "stripe"."_sync_obj_runs" DROP CONSTRAINT IF EXISTS "_sync_obj_runs_pkey";
ALTER TABLE "stripe"."_sync_obj_runs" DROP CONSTRAINT IF EXISTS "_sync_obj_run_pkey";
ALTER TABLE "stripe"."_sync_obj_runs"
  ADD CONSTRAINT "_sync_obj_runs_pkey" PRIMARY KEY ("_account_id", run_started_at, object, created_gte);
