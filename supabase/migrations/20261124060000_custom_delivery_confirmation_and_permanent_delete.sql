-- Full-payment Customs require a separate manual delivery confirmation.
-- The split plan still completes on confirmation of its final 40 percent.
CREATE OR REPLACE FUNCTION public.admin_confirm_custom_full_payment(p_payment_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_payment public.payments%ROWTYPE;
  v_order public.custom_orders%ROWTYPE;
  v_total numeric;
  v_now timestamptz := now();
BEGIN
  SELECT * INTO v_payment FROM public.payments WHERE id=p_payment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment not found'; END IF;
  IF v_payment.status='Confirmed' THEN
    RETURN jsonb_build_object('ok',true,'already_confirmed',true,'payment_id',p_payment_id);
  END IF;
  IF v_payment.status<>'Pending' OR v_payment.custom_order_id IS NULL
     OR lower(v_payment.stage) NOT LIKE '%full%' THEN
    RAISE EXCEPTION 'Payment is not a pending full Custom Adopt payment';
  END IF;
  SELECT * INTO v_order FROM public.custom_orders WHERE id=v_payment.custom_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Custom order not found'; END IF;
  v_total:=round(COALESCE(v_order.agreed_total,v_order.quote_base+v_order.license_fee),2);
  IF v_order.payment_plan IS DISTINCT FROM 'full' OR v_order.initial_paid OR v_order.final_paid
     OR v_order.status IN ('Rejected','Cancelled','Completed') OR v_total<=0
     OR round(v_payment.amount,2)<>v_total THEN
    RAISE EXCEPTION 'Full payment requires an unpaid Full Payment order and the exact agreed total';
  END IF;
  UPDATE public.payments SET status='Confirmed',confirmed_at=v_now WHERE id=p_payment_id;
  UPDATE public.custom_orders
    SET initial_paid=true,initial_paid_at=v_now,final_paid=true,final_paid_at=v_now,
        status='In Progress',updated_at=v_now
    WHERE id=v_order.id;
  INSERT INTO public.activity_log(entity_type,entity_id,action,description,metadata)
  VALUES('payment',p_payment_id,'custom_full_payment_confirmed',
    'Custom Adopt full 100 percent payment confirmed; manual delivery confirmation is still required',
    jsonb_build_object('custom_order_id',v_order.id,'amount',v_payment.amount,'stage',v_payment.stage));
  RETURN jsonb_build_object('ok',true,'already_confirmed',false,'payment_id',p_payment_id,
    'status','In Progress','delivery_confirmation_required',true);
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_confirm_custom_delivery(p_custom_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_order public.custom_orders%ROWTYPE;
  v_now timestamptz:=now();
BEGIN
  SELECT * INTO v_order FROM public.custom_orders WHERE id=p_custom_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Custom order not found'; END IF;
  IF v_order.status='Completed' AND v_order.payment_plan='full' AND v_order.final_paid THEN
    RETURN jsonb_build_object('ok',true,'already_confirmed',true,'custom_order_id',p_custom_order_id,'status','Completed');
  END IF;
  IF v_order.payment_plan IS DISTINCT FROM 'full' OR NOT v_order.final_paid OR v_order.status<>'In Progress' THEN
    RAISE EXCEPTION 'Only a fully paid Full Payment order in progress can have delivery confirmed';
  END IF;
  UPDATE public.custom_orders SET status='Completed',updated_at=v_now WHERE id=p_custom_order_id;
  INSERT INTO public.activity_log(entity_type,entity_id,action,description,metadata)
  VALUES('custom_order',p_custom_order_id,'custom_delivery_confirmed',
    'Artist manually confirmed delivery of the fully paid Custom Adopt',
    jsonb_build_object('payment_plan','full','status','Completed'));
  RETURN jsonb_build_object('ok',true,'already_confirmed',false,'custom_order_id',p_custom_order_id,'status','Completed');
END;
$function$;

-- Permanently remove a Custom order and every record directly owned by it.
-- Shared customer rows are intentionally retained.
CREATE OR REPLACE FUNCTION public.admin_delete_custom_order(p_custom_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_reference_paths jsonb;
  v_final_artwork_path text;
  v_payment_ids uuid[];
BEGIN
  PERFORM 1 FROM public.custom_orders WHERE id=p_custom_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Custom request not found'; END IF;

  SELECT COALESCE(jsonb_agg(storage_path),'[]'::jsonb)
    INTO v_reference_paths
    FROM public.custom_reference_files
    WHERE custom_order_id=p_custom_order_id AND storage_path IS NOT NULL;

  SELECT final_artwork_path INTO v_final_artwork_path
    FROM public.custom_orders WHERE id=p_custom_order_id;

  SELECT COALESCE(array_agg(id),ARRAY[]::uuid[])
    INTO v_payment_ids
    FROM public.payments WHERE custom_order_id=p_custom_order_id;

  DELETE FROM public.activity_log
    WHERE (entity_type='custom_order' AND entity_id=p_custom_order_id)
       OR (entity_type='payment' AND entity_id=ANY(v_payment_ids))
       OR metadata->>'custom_order_id'=p_custom_order_id::text;

  DELETE FROM public.certificates WHERE custom_order_id=p_custom_order_id;
  DELETE FROM public.ownership_records WHERE custom_order_id=p_custom_order_id;
  DELETE FROM public.payments WHERE custom_order_id=p_custom_order_id;
  DELETE FROM public.custom_order_updates WHERE custom_order_id=p_custom_order_id;
  DELETE FROM public.custom_reference_files WHERE custom_order_id=p_custom_order_id;
  DELETE FROM public.custom_orders WHERE id=p_custom_order_id;

  RETURN jsonb_build_object(
    'ok',true,
    'reference_paths',v_reference_paths,
    'final_artwork_path',v_final_artwork_path,
    'deleted_payment_count',cardinality(v_payment_ids)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_confirm_custom_full_payment(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_confirm_custom_full_payment(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.admin_confirm_custom_delivery(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_confirm_custom_delivery(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.admin_delete_custom_order(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_custom_order(uuid) TO service_role;
