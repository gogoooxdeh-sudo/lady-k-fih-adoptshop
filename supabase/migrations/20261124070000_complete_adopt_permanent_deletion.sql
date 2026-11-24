-- Make permanent Adopt deletion remove its complete directly-linked history.
-- Customer rows are shared and intentionally remain untouched.
CREATE OR REPLACE FUNCTION public.admin_delete_adopt(p_adopt_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_paths jsonb;
  v_request_ids uuid[];
  v_deleted_requests integer := 0;
  v_deleted_activity integer := 0;
BEGIN
  PERFORM 1 FROM public.adopts WHERE id = p_adopt_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Adoptable not found';
  END IF;

  SELECT COALESCE(array_agg(id), ARRAY[]::uuid[])
    INTO v_request_ids
    FROM public.purchase_requests
   WHERE adopt_id = p_adopt_id;

  SELECT COALESCE(jsonb_agg(storage_path), '[]'::jsonb)
    INTO v_paths
    FROM public.adopt_images
   WHERE adopt_id = p_adopt_id
     AND storage_path IS NOT NULL;

  -- Remove activity entries for this Adopt and every linked purchase request.
  DELETE FROM public.activity_log
   WHERE entity_id = p_adopt_id
      OR entity_id = ANY(v_request_ids);
  GET DIAGNOSTICS v_deleted_activity = ROW_COUNT;

  DELETE FROM public.certificates
   WHERE purchase_request_id = ANY(v_request_ids);

  DELETE FROM public.ownership_records
   WHERE adopt_id = p_adopt_id
      OR purchase_request_id = ANY(v_request_ids);

  DELETE FROM public.payments
   WHERE purchase_request_id = ANY(v_request_ids);

  DELETE FROM public.purchase_requests
   WHERE adopt_id = p_adopt_id;
  GET DIAGNOSTICS v_deleted_requests = ROW_COUNT;

  DELETE FROM public.adopt_images
   WHERE adopt_id = p_adopt_id;

  DELETE FROM public.adopts
   WHERE id = p_adopt_id;

  RETURN jsonb_build_object(
    'ok', true,
    'storage_paths', v_paths,
    'deleted_purchase_requests', v_deleted_requests,
    'deleted_activity_entries', v_deleted_activity
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_delete_adopt(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_adopt(uuid) TO service_role;
