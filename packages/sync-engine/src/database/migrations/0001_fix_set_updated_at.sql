CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
  NEW._updated_at = now();
  RETURN NEW;
END;
$$;
