-- Enforce Custom Adopt completion prerequisites inside the database transaction.
-- Browser-side checks are useful for UX but cannot be the only enforcement layer.
CREATE OR REPLACE FUNCTION public.admin_complete_custom_delivery(p_custom_order_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_order public.custom_orders%ROWTYPE;
  v_certificate_id uuid;
  v_certificate_code text;
  v_ownership_id uuid;
  v_now timestamptz := now();
BEGIN
  SELECT *
    INTO v_order
    FROM public.custom_orders
   WHERE id = p_custom_order_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Custom order not found';
  END IF;

  IF NOT v_order.final_paid THEN
    RAISE EXCEPTION 'Final payment must be confirmed before delivery';
  END IF;

  IF v_order.status = 'Completed' THEN
    SELECT id INTO v_certificate_id
      FROM public.certificates
     WHERE custom_order_id = p_custom_order_id
     LIMIT 1;
    SELECT id INTO v_ownership_id
      FROM public.ownership_records
     WHERE custom_order_id = p_custom_order_id
     ORDER BY acquired_at DESC
     LIMIT 1;
    RETURN jsonb_build_object(
      'ok', true,
      'already_completed', true,
      'custom_order_id', p_custom_order_id,
      'certificate_id', v_certificate_id,
      'ownership_id', v_ownership_id
    );
  END IF;

  IF NOT v_order.final_approved THEN
    RAISE EXCEPTION 'Final design approval must be recorded before delivery';
  END IF;

  IF nullif(btrim(coalesce(v_order.character_name, '')), '') IS NULL THEN
    RAISE EXCEPTION 'A final character name is required before delivery';
  END IF;

  IF nullif(btrim(coalesce(v_order.final_artwork_path, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Final artwork must be uploaded before delivery';
  END IF;

  UPDATE public.custom_orders
     SET status = 'Completed',
         delivery_at = v_now,
         updated_at = v_now
   WHERE id = p_custom_order_id;

  SELECT id INTO v_ownership_id
    FROM public.ownership_records
   WHERE custom_order_id = p_custom_order_id
   LIMIT 1;

  IF v_ownership_id IS NULL THEN
    INSERT INTO public.ownership_records (
      adopt_id, customer_id, custom_order_id, license_type,
      acquisition_price, acquired_at, metadata
    )
    VALUES (
      NULL, v_order.customer_id, p_custom_order_id,
      COALESCE(v_order.license_type, 'Personal Use'),
      COALESCE(v_order.agreed_total, v_order.quote_base + v_order.license_fee),
      v_now,
      jsonb_build_object('character_name', v_order.character_name, 'source', 'custom_order_delivery')
    )
    RETURNING id INTO v_ownership_id;
  END IF;

  SELECT id INTO v_certificate_id
    FROM public.certificates
   WHERE custom_order_id = p_custom_order_id
   LIMIT 1;

  IF v_certificate_id IS NULL THEN
    v_certificate_code :=
      'LKF-' || to_char(v_now, 'YYYYMMDD') || '-' ||
      upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));

    INSERT INTO public.certificates (
      certificate_code, custom_order_id, status, certificate_data
    )
    VALUES (
      v_certificate_code,
      p_custom_order_id,
      'Pending Review',
      jsonb_build_object(
        'custom_order_id', p_custom_order_id,
        'customer_id', v_order.customer_id,
        'character_name', v_order.character_name,
        'license_type', v_order.license_type,
        'agreed_total', v_order.agreed_total,
        'final_artwork_path', v_order.final_artwork_path,
        'generated_at', v_now
      )
    )
    RETURNING id INTO v_certificate_id;
  END IF;

  INSERT INTO public.activity_log(entity_type, entity_id, action, description, metadata)
  VALUES (
    'custom_order', p_custom_order_id, 'delivery_completed',
    'Custom order delivery completed',
    jsonb_build_object('certificate_id', v_certificate_id, 'ownership_id', v_ownership_id)
  );

  RETURN jsonb_build_object(
    'ok', true,
    'custom_order_id', p_custom_order_id,
    'certificate_id', v_certificate_id,
    'ownership_id', v_ownership_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_complete_custom_delivery(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_complete_custom_delivery(uuid) TO service_role;