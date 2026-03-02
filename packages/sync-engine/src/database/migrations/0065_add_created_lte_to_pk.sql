-- Include created_lte in the PK so chunks with the same created_gte but
-- different created_lte can coexist.  Requires a NOT NULL default first.
ALTER TABLE "stripe"."_sync_obj_runs"
  ALTER COLUMN created_lte SET DEFAULT 0;

UPDATE "stripe"."_sync_obj_runs"
   SET created_lte = 0
 WHERE created_lte IS NULL;

ALTER TABLE "stripe"."_sync_obj_runs"
  ALTER COLUMN created_lte SET NOT NULL;

ALTER TABLE "stripe"."_sync_obj_runs" DROP CONSTRAINT IF EXISTS "_sync_obj_runs_pkey";
ALTER TABLE "stripe"."_sync_obj_runs"
  ADD CONSTRAINT "_sync_obj_runs_pkey" PRIMARY KEY ("_account_id", run_started_at, object, created_gte, created_lte);
