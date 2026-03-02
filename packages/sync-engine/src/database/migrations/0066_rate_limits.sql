-- Rate limiting table and function for cross-process request throttling.
-- Used by claimNextTask to cap how many claims/sec hit the database.

CREATE TABLE IF NOT EXISTS "stripe"."_rate_limits" (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  window_start TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION "stripe".check_rate_limit(
  rate_key TEXT,
  max_requests INTEGER,
  window_seconds INTEGER
)
RETURNS VOID AS $$
DECLARE
  now TIMESTAMPTZ := clock_timestamp();
  window_length INTERVAL := make_interval(secs => window_seconds);
  current_count INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(rate_key));

  INSERT INTO "stripe"."_rate_limits" (key, count, window_start)
  VALUES (rate_key, 1, now)
  ON CONFLICT (key) DO UPDATE
  SET count = CASE
                WHEN "_rate_limits".window_start + window_length <= now
                  THEN 1
                  ELSE "_rate_limits".count + 1
              END,
      window_start = CASE
                       WHEN "_rate_limits".window_start + window_length <= now
                         THEN now
                         ELSE "_rate_limits".window_start
                     END;

  SELECT count INTO current_count FROM "stripe"."_rate_limits" WHERE key = rate_key;

  IF current_count > max_requests THEN
    RAISE EXCEPTION 'Rate limit exceeded for %', rate_key;
  END IF;
END;
$$ LANGUAGE plpgsql;
