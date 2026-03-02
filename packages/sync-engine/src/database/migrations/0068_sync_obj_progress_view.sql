-- Per-object sync progress view for monitoring.
-- Defaults to the newest run per account; callers can filter by a specific
-- run_started_at if needed.

DROP FUNCTION IF EXISTS "stripe"."sync_obj_progress"(TEXT, TIMESTAMPTZ);

CREATE OR REPLACE VIEW "stripe"."sync_obj_progress" AS
SELECT
  r."_account_id" AS account_id,
  r.run_started_at,
  r.object,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE r.status = 'complete') / NULLIF(COUNT(*), 0),
    1
  ) AS pct_complete,
  COALESCE(SUM(r.processed_count), 0) AS processed
FROM "stripe"."_sync_obj_runs" r
WHERE r.run_started_at = (
  SELECT MAX(s.started_at)
  FROM "stripe"."_sync_runs" s
  WHERE s."_account_id" = r."_account_id"
)
GROUP BY r."_account_id", r.run_started_at, r.object;
