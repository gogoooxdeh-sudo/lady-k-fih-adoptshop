CREATE OR REPLACE FUNCTION public.admin_confirm_custom_final_payment(p_payment_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_payment public.payments%ROWTYPE;
  v_order public.custom_orders%ROWTYPE;
  v_total numeric;
  v_expected numeric;
  v_now timestamptz := now();
BEGIN
  SELECT * INTO v_payment FROM public.payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment not found'; END IF;
  IF v_payment.status = 'Confirmed' THEN
    RETURN jsonb_build_object('ok', true, 'already_confirmed', true, 'payment_id', p_payment_id);
  END IF;
  IF v_payment.status <> 'Pending' OR v_payment.custom_order_id IS NULL OR lower(v_payment.stage) NOT LIKE '%final%' THEN
    RAISE EXCEPTION 'Payment is not a pending final Custom Adopt payment';
  END IF;
  SELECT * INTO v_order FROM public.custom_orders WHERE id = v_payment.custom_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Custom order not found'; END IF;
  v_total := round(COALESCE(v_order.agreed_total, v_order.quote_base + v_order.license_fee), 2);
  v_expected := round(v_total * .40, 2);
  IF v_order.payment_plan <> 'split'
     OR NOT v_order.quote_sent
     OR NOT v_order.client_approved_quote
     OR NOT v_order.initial_paid
     OR v_order.final_paid
     OR v_order.status IN ('Rejected', 'Cancelled', 'Completed')
     OR round(v_payment.amount, 2) <> v_expected THEN
    RAISE EXCEPTION 'Final 40 percent requires an approved quote, confirmed initial 60 percent and the exact agreed amount';
  END IF;
  UPDATE public.payments SET status = 'Confirmed', confirmed_at = v_now WHERE id = p_payment_id;
  UPDATE public.custom_orders SET final_paid = true, final_paid_at = v_now, status = 'Completed', updated_at = v_now WHERE id = v_order.id;
  INSERT INTO public.activity_log(entity_type, entity_id, action, description, metadata)
  VALUES ('payment', p_payment_id, 'custom_final_payment_confirmed',
    'Custom Adopt final 40 percent confirmed; final artwork registration pending',
    jsonb_build_object('custom_order_id', v_order.id, 'amount', v_payment.amount, 'stage', v_payment.stage));
  RETURN jsonb_build_object('ok', true, 'already_confirmed', false, 'payment_id', p_payment_id,
    'status', 'Completed', 'final_artwork_pending', true);
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_complete_custom_delivery(p_custom_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_order public.custom_orders%ROWTYPE;
  v_certificate_id uuid;
  v_certificate_code text;
  v_ownership_id uuid;
  v_now timestamptz := now();
  v_custom_data jsonb;
  v_was_registered boolean := false;
BEGIN
  SELECT * INTO v_order FROM public.custom_orders WHERE id = p_custom_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Custom order not found'; END IF;
  v_was_registered := v_order.final_artwork_saved_at IS NOT NULL;
  IF NOT v_order.final_paid THEN RAISE EXCEPTION 'Full payment must be confirmed before registering final artwork'; END IF;
  IF nullif(btrim(coalesce(v_order.character_name, '')), '') IS NULL THEN RAISE EXCEPTION 'A final character name is required'; END IF;
  IF nullif(btrim(coalesce(v_order.original_idea_by, '')), '') IS NULL THEN RAISE EXCEPTION 'Original Idea By is required'; END IF;
  IF nullif(btrim(coalesce(v_order.final_artwork_path, '')), '') IS NULL THEN RAISE EXCEPTION 'Final artwork must be uploaded before registration'; END IF;
  v_custom_data := jsonb_build_object('custom_id', v_order.order_code, 'character_name', v_order.character_name,
    'original_idea_by', v_order.original_idea_by, 'license_type', v_order.license_type,
    'agreed_total', v_order.agreed_total, 'final_artwork_path', v_order.final_artwork_path);
  UPDATE public.custom_orders SET final_artwork_saved_at = COALESCE(final_artwork_saved_at, v_now), updated_at = v_now
    WHERE id = p_custom_order_id;
  SELECT id INTO v_ownership_id FROM public.ownership_records WHERE custom_order_id = p_custom_order_id
    ORDER BY acquired_at DESC LIMIT 1 FOR UPDATE;
  IF v_ownership_id IS NULL THEN
    INSERT INTO public.ownership_records(adopt_id, customer_id, custom_order_id, license_type, acquisition_price, acquired_at, metadata)
    VALUES(NULL, v_order.customer_id, p_custom_order_id, COALESCE(v_order.license_type, 'Personal Use'),
      COALESCE(v_order.agreed_total, v_order.quote_base + v_order.license_fee), v_now,
      v_custom_data || jsonb_build_object('source', 'custom_final_artwork_registration'));
  ELSE
    UPDATE public.ownership_records SET metadata = COALESCE(metadata, '{}'::jsonb) || v_custom_data
      WHERE id = v_ownership_id;
  END IF;
  SELECT id, certificate_code INTO v_certificate_id, v_certificate_code
    FROM public.certificates WHERE custom_order_id = p_custom_order_id ORDER BY created_at DESC LIMIT 1;
  IF v_certificate_id IS NULL THEN
    v_certificate_code := 'CERT-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
    INSERT INTO public.certificates(custom_order_id, customer_id, certificate_code, status, certificate_data, created_at, updated_at)
    VALUES(p_custom_order_id, v_order.customer_id, v_certificate_code, 'Pending Review', v_custom_data, v_now, v_now)
    RETURNING id INTO v_certificate_id;
  ELSE
    UPDATE public.certificates SET certificate_data = COALESCE(certificate_data, '{}'::jsonb) || v_custom_data, updated_at = v_now
      WHERE id = v_certificate_id;
  END IF;
  RETURN jsonb_build_object('ok', true, 'already_registered', v_was_registered,
    'final_artwork_saved_at', v_now, 'certificate_id', v_certificate_id, 'certificate_code', v_certificate_code);
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_delete_adopt(p_adopt_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_paths jsonb;
  v_request_ids uuid[];
  v_payment_ids uuid[];
  v_deleted_requests integer := 0;
BEGIN
  PERFORM 1 FROM public.adopts WHERE id = p_adopt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Adoptable not found'; END IF;

  SELECT COALESCE(array_agg(id), ARRAY[]::uuid[]) INTO v_request_ids
    FROM public.purchase_requests WHERE adopt_id = p_adopt_id;
  SELECT COALESCE(array_agg(id), ARRAY[]::uuid[]) INTO v_payment_ids
    FROM public.payments WHERE purchase_request_id = ANY(v_request_ids);

  SELECT COALESCE(jsonb_agg(storage_path), '[]'::jsonb) INTO v_paths
    FROM public.adopt_images WHERE adopt_id = p_adopt_id AND storage_path IS NOT NULL;

  DELETE FROM public.certificates WHERE purchase_request_id = ANY(v_request_ids);
  DELETE FROM public.ownership_records WHERE adopt_id = p_adopt_id OR purchase_request_id = ANY(v_request_ids);
  DELETE FROM public.payments WHERE purchase_request_id = ANY(v_request_ids);
  DELETE FROM public.purchase_requests WHERE adopt_id = p_adopt_id;
  GET DIAGNOSTICS v_deleted_requests = ROW_COUNT;
  DELETE FROM public.adopt_images WHERE adopt_id = p_adopt_id;
  DELETE FROM public.adopts WHERE id = p_adopt_id;

  RETURN jsonb_build_object('ok', true, 'storage_paths', v_paths,
    'deleted_purchase_requests', v_deleted_requests, 'deleted_payment_ids', to_jsonb(v_payment_ids));
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_confirm_custom_final_payment(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_confirm_custom_final_payment(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.admin_complete_custom_delivery(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_complete_custom_delivery(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.admin_delete_adopt(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_adopt(uuid) TO service_role;
