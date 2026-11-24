-- Lady K ★ Fih AdoptShop — consolidated payment and archive workflow
-- Transaction rules only; no business records are inserted or modified.
CREATE OR REPLACE FUNCTION public.admin_confirm_payment(p_payment_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog, public AS $function$
DECLARE
 v_payment public.payments%ROWTYPE; v_request public.purchase_requests%ROWTYPE; v_adopt public.adopts%ROWTYPE;
 v_order public.custom_orders%ROWTYPE; v_total numeric; v_expected numeric; v_now timestamptz := now();
BEGIN
 SELECT * INTO v_payment FROM public.payments WHERE id=p_payment_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Payment not found'; END IF;
 IF v_payment.status='Confirmed' THEN RETURN jsonb_build_object('ok',true,'already_confirmed',true,'payment_id',p_payment_id); END IF;
 IF v_payment.status<>'Pending' OR round(v_payment.amount,2)<=0 OR upper(v_payment.currency)<>'USD' THEN RAISE EXCEPTION 'Payment is not eligible for confirmation'; END IF;
 IF v_payment.purchase_request_id IS NOT NULL THEN
  SELECT * INTO v_request FROM public.purchase_requests WHERE id=v_payment.purchase_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purchase request not found'; END IF;
  IF v_request.paid OR v_request.status IN ('Cancelled','Rejected','Completed','Delivered') OR lower(btrim(v_payment.stage))<>'full payment' OR round(v_payment.amount,2)<>round(v_request.total,2) THEN RAISE EXCEPTION 'Purchase request is not eligible for this payment confirmation'; END IF;
  SELECT * INTO v_adopt FROM public.adopts WHERE id=v_request.adopt_id FOR UPDATE;
  IF NOT FOUND OR v_adopt.status<>'Reserved' THEN RAISE EXCEPTION 'The adoptable must remain Reserved before payment confirmation'; END IF;
  UPDATE public.payments SET status='Confirmed',confirmed_at=v_now WHERE id=p_payment_id;
  UPDATE public.purchase_requests SET paid=true,paid_at=v_now,payment_pending=false,payment_status='Paid',status='Payment Confirmed',updated_at=v_now WHERE id=v_request.id;
  UPDATE public.adopts SET status='Sold',public_visible=false,archive_visible=true,updated_at=v_now WHERE id=v_request.adopt_id AND status='Reserved';
  IF NOT FOUND THEN RAISE EXCEPTION 'The reserved Adopt could not be marked Sold'; END IF;
 ELSIF v_payment.custom_order_id IS NOT NULL THEN
  SELECT * INTO v_order FROM public.custom_orders WHERE id=v_payment.custom_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Custom order not found'; END IF;
  v_total:=round(COALESCE(v_order.agreed_total,v_order.quote_base+v_order.license_fee),2);
  IF v_total IS NULL OR v_total<=0 OR NOT v_order.quote_sent OR NOT v_order.client_approved_quote OR v_order.status IN ('Rejected','Cancelled','Completed') THEN RAISE EXCEPTION 'Custom order is not eligible for payment confirmation'; END IF;
  IF lower(v_payment.stage) LIKE '%initial%' THEN
   v_expected:=round(v_total*.60,2);
   IF v_order.payment_plan='full' OR v_order.initial_paid OR v_order.final_paid OR round(v_payment.amount,2)<>v_expected THEN RAISE EXCEPTION 'Initial payment must equal 60 percent of the approved total'; END IF;
   UPDATE public.payments SET status='Confirmed',confirmed_at=v_now WHERE id=p_payment_id;
   UPDATE public.custom_orders SET initial_paid=true,initial_paid_at=v_now,status='In Progress',updated_at=v_now WHERE id=v_order.id;
  ELSIF lower(v_payment.stage) LIKE '%final%' THEN
   v_expected:=round(v_total*.40,2);
   IF v_order.payment_plan='full' OR NOT v_order.initial_paid OR NOT v_order.final_approved OR v_order.final_paid OR nullif(btrim(coalesce(v_order.character_name,'')),'') IS NULL OR nullif(btrim(coalesce(v_order.final_artwork_path,'')),'') IS NULL OR round(v_payment.amount,2)<>v_expected THEN RAISE EXCEPTION 'Final 40 percent requires initial payment, final approval, character name, final artwork and the exact agreed amount'; END IF;
   UPDATE public.payments SET status='Confirmed',confirmed_at=v_now WHERE id=p_payment_id;
   UPDATE public.custom_orders SET final_paid=true,final_paid_at=v_now,updated_at=v_now WHERE id=v_order.id;
   PERFORM public.admin_complete_custom_delivery(v_order.id);
  ELSE RAISE EXCEPTION 'Unrecognized Custom Adopt payment stage'; END IF;
 ELSE RAISE EXCEPTION 'Payment has no associated order'; END IF;
 INSERT INTO public.activity_log(entity_type,entity_id,action,description,metadata)
 VALUES('payment',p_payment_id,'payment_confirmed','Payment manually confirmed by administrator',jsonb_build_object('amount',v_payment.amount,'currency',v_payment.currency,'stage',v_payment.stage));
 RETURN jsonb_build_object('ok',true,'already_confirmed',false,'payment_id',p_payment_id);
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_confirm_payment(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.admin_confirm_payment(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.admin_confirm_custom_full_payment(p_payment_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog, public AS $function$
DECLARE v_payment public.payments%ROWTYPE; v_order public.custom_orders%ROWTYPE; v_now timestamptz:=now();
BEGIN
 SELECT * INTO v_payment FROM public.payments WHERE id=p_payment_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Payment not found'; END IF;
 IF v_payment.status='Confirmed' THEN RETURN jsonb_build_object('ok',true,'already_confirmed',true,'payment_id',p_payment_id); END IF;
 IF v_payment.status<>'Pending' OR v_payment.custom_order_id IS NULL OR lower(v_payment.stage) NOT LIKE '%full%' THEN RAISE EXCEPTION 'Payment is not a pending full Custom Adopt payment'; END IF;
 SELECT * INTO v_order FROM public.custom_orders WHERE id=v_payment.custom_order_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Custom order not found'; END IF;
 IF v_order.payment_plan<>'full' OR NOT v_order.quote_sent OR NOT v_order.client_approved_quote OR v_order.initial_paid OR v_order.final_paid OR v_order.status IN ('Rejected','Cancelled','Completed') THEN RAISE EXCEPTION 'Custom order is not eligible for full payment confirmation'; END IF;
 IF round(v_payment.amount,2)<>round(COALESCE(v_order.agreed_total,v_order.quote_base+v_order.license_fee),2) THEN RAISE EXCEPTION 'Full payment amount does not match the agreed total'; END IF;
 UPDATE public.payments SET status='Confirmed',confirmed_at=v_now WHERE id=p_payment_id;
 UPDATE public.custom_orders SET initial_paid=true,initial_paid_at=v_now,final_paid=true,final_paid_at=v_now,status='In Progress',updated_at=v_now WHERE id=v_order.id;
 INSERT INTO public.activity_log(entity_type,entity_id,action,description,metadata)
 VALUES('payment',p_payment_id,'custom_full_payment_confirmed','Custom Adopt full payment manually confirmed',jsonb_build_object('custom_order_id',v_order.id,'amount',v_payment.amount,'stage',v_payment.stage));
 RETURN jsonb_build_object('ok',true,'already_confirmed',false,'payment_id',p_payment_id);
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_confirm_custom_full_payment(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.admin_confirm_custom_full_payment(uuid) TO service_role;
