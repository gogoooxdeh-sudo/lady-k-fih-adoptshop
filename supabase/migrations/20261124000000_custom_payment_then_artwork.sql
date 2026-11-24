-- Custom payment completion and final-artwork registration are separate stages.
ALTER TABLE public.custom_orders
  ADD COLUMN IF NOT EXISTS original_idea_by text,
  ADD COLUMN IF NOT EXISTS final_artwork_saved_at timestamptz;

CREATE OR REPLACE FUNCTION public.admin_confirm_custom_full_payment(p_payment_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE v_payment public.payments%ROWTYPE; v_order public.custom_orders%ROWTYPE; v_now timestamptz := now();
BEGIN
 SELECT * INTO v_payment FROM public.payments WHERE id=p_payment_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Payment not found'; END IF;
 IF v_payment.status='Confirmed' THEN RETURN jsonb_build_object('ok',true,'already_confirmed',true,'payment_id',p_payment_id); END IF;
 IF v_payment.status<>'Pending' OR v_payment.custom_order_id IS NULL OR lower(v_payment.stage) NOT LIKE '%full%' THEN
  RAISE EXCEPTION 'Payment is not a pending full Custom Adopt payment';
 END IF;
 SELECT * INTO v_order FROM public.custom_orders WHERE id=v_payment.custom_order_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Custom order not found'; END IF;
 IF v_order.payment_plan<>'full' OR NOT v_order.quote_sent OR NOT v_order.client_approved_quote
    OR v_order.initial_paid OR v_order.final_paid OR v_order.status IN ('Rejected','Cancelled','Completed') THEN
  RAISE EXCEPTION 'Custom order is not eligible for full payment confirmation';
 END IF;
 IF round(v_payment.amount,2)<>round(COALESCE(v_order.agreed_total,v_order.quote_base+v_order.license_fee),2) THEN
  RAISE EXCEPTION 'Full payment amount does not match the agreed total';
 END IF;
 UPDATE public.payments SET status='Confirmed',confirmed_at=v_now WHERE id=p_payment_id;
 UPDATE public.custom_orders SET initial_paid=true,initial_paid_at=v_now,final_paid=true,final_paid_at=v_now,status='Completed',updated_at=v_now WHERE id=v_order.id;
 INSERT INTO public.activity_log(entity_type,entity_id,action,description,metadata)
 VALUES('payment',p_payment_id,'custom_full_payment_confirmed','Custom Adopt full payment confirmed; final artwork registration pending',
        jsonb_build_object('custom_order_id',v_order.id,'amount',v_payment.amount,'stage',v_payment.stage));
 RETURN jsonb_build_object('ok',true,'already_confirmed',false,'payment_id',p_payment_id,'status','Completed','final_artwork_pending',true);
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_confirm_custom_final_payment(p_payment_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE v_payment public.payments%ROWTYPE; v_order public.custom_orders%ROWTYPE; v_total numeric; v_expected numeric; v_now timestamptz:=now();
BEGIN
 SELECT * INTO v_payment FROM public.payments WHERE id=p_payment_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Payment not found'; END IF;
 IF v_payment.status='Confirmed' THEN RETURN jsonb_build_object('ok',true,'already_confirmed',true,'payment_id',p_payment_id); END IF;
 IF v_payment.status<>'Pending' OR v_payment.custom_order_id IS NULL OR lower(v_payment.stage) NOT LIKE '%final%' THEN
  RAISE EXCEPTION 'Payment is not a pending final Custom Adopt payment';
 END IF;
 SELECT * INTO v_order FROM public.custom_orders WHERE id=v_payment.custom_order_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Custom order not found'; END IF;
 v_total:=round(COALESCE(v_order.agreed_total,v_order.quote_base+v_order.license_fee),2);
 v_expected:=round(v_total*.40,2);
 IF v_order.payment_plan<>'split' OR NOT v_order.quote_sent OR NOT v_order.client_approved_quote
    OR NOT v_order.initial_paid OR NOT v_order.final_approved OR v_order.final_paid
    OR v_order.status IN ('Rejected','Cancelled','Completed') OR round(v_payment.amount,2)<>v_expected THEN
  RAISE EXCEPTION 'Final 40 percent requires an approved quote, initial 60 percent, final approval and the exact agreed amount';
 END IF;
 UPDATE public.payments SET status='Confirmed',confirmed_at=v_now WHERE id=p_payment_id;
 UPDATE public.custom_orders SET final_paid=true,final_paid_at=v_now,status='Completed',updated_at=v_now WHERE id=v_order.id;
 INSERT INTO public.activity_log(entity_type,entity_id,action,description,metadata)
 VALUES('payment',p_payment_id,'custom_final_payment_confirmed','Custom Adopt final 40 percent confirmed; final artwork registration pending',
        jsonb_build_object('custom_order_id',v_order.id,'amount',v_payment.amount,'stage',v_payment.stage));
 RETURN jsonb_build_object('ok',true,'already_confirmed',false,'payment_id',p_payment_id,'status','Completed','final_artwork_pending',true);
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_complete_custom_delivery(p_custom_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
 v_order public.custom_orders%ROWTYPE; v_certificate_id uuid; v_certificate_code text;
 v_ownership_id uuid; v_now timestamptz:=now(); v_custom_data jsonb; v_was_registered boolean:=false;
BEGIN
 SELECT * INTO v_order FROM public.custom_orders WHERE id=p_custom_order_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Custom order not found'; END IF;
 v_was_registered := v_order.final_artwork_saved_at IS NOT NULL;
 IF NOT v_order.final_paid THEN RAISE EXCEPTION 'Full payment must be confirmed before registering final artwork'; END IF;
 IF NOT v_order.final_approved THEN RAISE EXCEPTION 'Final design approval must be recorded before certificate registration'; END IF;
 IF nullif(btrim(coalesce(v_order.character_name,'')),'') IS NULL THEN RAISE EXCEPTION 'A final character name is required'; END IF;
 IF nullif(btrim(coalesce(v_order.original_idea_by,'')),'') IS NULL THEN RAISE EXCEPTION 'Original Idea By is required'; END IF;
 IF nullif(btrim(coalesce(v_order.final_artwork_path,'')),'') IS NULL THEN RAISE EXCEPTION 'Final artwork must be uploaded before registration'; END IF;
 v_custom_data:=jsonb_build_object('custom_id',v_order.order_code,'character_name',v_order.character_name,
   'original_idea_by',v_order.original_idea_by,'license_type',v_order.license_type,
   'agreed_total',v_order.agreed_total,'final_artwork_path',v_order.final_artwork_path);
 UPDATE public.custom_orders SET final_artwork_saved_at=COALESCE(final_artwork_saved_at,v_now),updated_at=v_now
  WHERE id=p_custom_order_id;
 SELECT id INTO v_ownership_id FROM public.ownership_records WHERE custom_order_id=p_custom_order_id
  ORDER BY acquired_at DESC LIMIT 1 FOR UPDATE;
 IF v_ownership_id IS NULL THEN
  INSERT INTO public.ownership_records(adopt_id,customer_id,custom_order_id,license_type,acquisition_price,acquired_at,metadata)
  VALUES(NULL,v_order.customer_id,p_custom_order_id,COALESCE(v_order.license_type,'Personal Use'),
   COALESCE(v_order.agreed_total,v_order.quote_base+v_order.license_fee),v_now,
   v_custom_data||jsonb_build_object('source','custom_final_artwork_registration')) RETURNING id INTO v_ownership_id;
 ELSE
  UPDATE public.ownership_records SET metadata=COALESCE(metadata,'{}'::jsonb)||v_custom_data WHERE id=v_ownership_id;
 END IF;
 SELECT id,certificate_code INTO v_certificate_id,v_certificate_code FROM public.certificates
  WHERE custom_order_id=p_custom_order_id ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
 IF v_certificate_id IS NULL THEN
  v_certificate_code:='LKF-'||to_char(v_now,'YYYYMMDD')||'-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,8));
  INSERT INTO public.certificates(certificate_code,custom_order_id,status,certificate_data)
  VALUES(v_certificate_code,p_custom_order_id,'Pending Review',
   v_custom_data||jsonb_build_object('custom_order_id',p_custom_order_id,'customer_id',v_order.customer_id,
   'ownership_id',v_ownership_id,'generated_at',v_now)) RETURNING id INTO v_certificate_id;
 ELSE
  UPDATE public.certificates SET certificate_data=COALESCE(certificate_data,'{}'::jsonb)||v_custom_data||
   jsonb_build_object('ownership_id',v_ownership_id) WHERE id=v_certificate_id;
 END IF;
 IF NOT v_was_registered THEN
  INSERT INTO public.activity_log(entity_type,entity_id,action,description,metadata)
  VALUES('custom_order',p_custom_order_id,'final_artwork_registered',
   'Final Custom artwork and attribution registered; certificate queued for review',
   jsonb_build_object('certificate_id',v_certificate_id,'ownership_id',v_ownership_id,'custom_id',v_order.order_code));
 END IF;
 RETURN jsonb_build_object('ok',true,'already_registered',v_was_registered,
  'custom_order_id',p_custom_order_id,'custom_id',v_order.order_code,
  'certificate_id',v_certificate_id,'ownership_id',v_ownership_id,'final_artwork_saved_at',v_now);
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_confirm_custom_final_payment(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_confirm_custom_final_payment(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.admin_confirm_custom_full_payment(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_confirm_custom_full_payment(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.admin_complete_custom_delivery(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_complete_custom_delivery(uuid) TO service_role;
