
CREATE TABLE IF NOT EXISTS public.public_request_rate_limits (
  ip_hash text PRIMARY KEY CHECK (ip_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  blocked_until timestamptz
);

ALTER TABLE public.public_request_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.public_request_rate_limits FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.public_request_rate_limits TO service_role;

CREATE OR REPLACE FUNCTION public.public_register_request_attempt(
  p_ip_hash text,
  p_limit integer DEFAULT 10,
  p_window_seconds integer DEFAULT 3600
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row public.public_request_rate_limits%ROWTYPE;
  v_now timestamptz := now();
  v_window interval;
BEGIN
  IF p_ip_hash IS NULL OR p_ip_hash !~ '^[0-9a-f]{64}$'
     OR p_limit < 1 OR p_limit > 100
     OR p_window_seconds < 60 OR p_window_seconds > 86400 THEN
    RAISE EXCEPTION 'Invalid public request rate-limit parameters';
  END IF;

  v_window := make_interval(secs => p_window_seconds);
  PERFORM pg_advisory_xact_lock(hashtextextended(p_ip_hash, 0));

  SELECT * INTO v_row
  FROM public.public_request_rate_limits
  WHERE ip_hash = p_ip_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.public_request_rate_limits(ip_hash, window_started_at, request_count)
    VALUES (p_ip_hash, v_now, 1);
    RETURN true;
  END IF;

  IF v_row.blocked_until IS NOT NULL AND v_row.blocked_until > v_now THEN
    RETURN false;
  END IF;

  IF v_row.window_started_at <= v_now - v_window THEN
    UPDATE public.public_request_rate_limits
    SET window_started_at = v_now, request_count = 1, blocked_until = NULL
    WHERE ip_hash = p_ip_hash;
    RETURN true;
  END IF;

  IF v_row.request_count >= p_limit THEN
    UPDATE public.public_request_rate_limits
    SET blocked_until = v_row.window_started_at + v_window
    WHERE ip_hash = p_ip_hash;
    RETURN false;
  END IF;

  UPDATE public.public_request_rate_limits
  SET request_count = request_count + 1
  WHERE ip_hash = p_ip_hash;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.public_register_request_attempt(text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.public_register_request_attempt(text, integer, integer) TO service_role;
