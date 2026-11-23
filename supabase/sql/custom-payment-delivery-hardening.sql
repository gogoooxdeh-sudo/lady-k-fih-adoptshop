-- Lady K ★ Fih AdoptShop
-- Custom Adopt payment and delivery hardening.
-- Review and apply only after testing in a Supabase development project.

ALTER TABLE public.ownership_records
  ALTER COLUMN adopt_id DROP NOT NULL;

-- One payment per order/stage prevents duplicate confirmations under concurrent clicks.
CREATE UNIQUE INDEX IF NOT EXISTS payments_purchase_stage_unique
  ON public.payments (purchase_request_id, stage)
  WHERE purchase_request_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS payments_custom_stage_unique
  ON public.payments (custom_order_id, stage)
  WHERE custom_order_id IS NOT NULL;

-- Each completed order can own only one canonical certificate record.
CREATE UNIQUE INDEX IF NOT EXISTS certificates_purchase_request_unique
  ON public.certificates (purchase_request_id)
  WHERE purchase_request_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS certificates_custom_order_unique
  ON public.certificates (custom_order_id)
  WHERE custom_order_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.admin_confirm_custom_full_payment(p_payment_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payment public.payments%ROWTYPE;
  v_order public.custom_orders%ROWTYPE;
  v_now timestamptz := now();
BEGIN
  SELECT *
    INTO v_payment
    FROM public.payments
   WHERE id = p_payment_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment not found';
  END IF;

  IF v_payment.status = 'Confirmed' THEN
    RETURN jsonb_build_object('ok', true, 'already_confirmed', true, 'payment_id', p_payment_id);
  END IF;

  IF v_payment.status <> 'Pending'
     OR v_payment.custom_order_id IS NULL
     OR lower(v_payment.stage) NOT LIKE '%full%' THEN
    RAISE EXCEPTION 'Payment is not a pending full Custom Adopt payment';
  END IF;

  SELECT *
    INTO v_order
    FROM public.custom_orders
   WHERE id = v_payment.custom_order_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Custom order not found';
  END IF;

  IF v_order.payment_plan <> 'full'
     OR NOT v_order.quote_sent
     OR NOT v_order.client_approved_quote
     OR v_order.initial_paid
     OR v_order.final_paid THEN
    RAISE EXCEPTION 'Custom order is not eligible for full payment confirmation';
  END IF;

  IF round(v_payment.amount, 2) <> round(COALESCE(v_order.agreed_total, v_order.quote_base + v_order.license_fee), 2) THEN
    RAISE EXCEPTION 'Full payment amount does not match the agreed total';
  END IF;

  UPDATE public.payments
     SET status = 'Confirmed', confirmed_at = v_now
   WHERE id = p_payment_id;

  UPDATE public.custom_orders
     SET initial_paid = true,
         initial_paid_at = v_now,
         final_paid = true,
         final_paid_at = v_now,
         updated_at = v_now
   WHERE id = v_order.id;

  INSERT INTO public.activity_log(entity_type, entity_id, action, description, metadata)
  VALUES (
    'payment',
    p_payment_id,
    'custom_full_payment_confirmed',
    'Custom Adopt full payment manually confirmed',
    jsonb_build_object('custom_order_id', v_order.id, 'amount', v_payment.amount, 'stage', v_payment.stage)
  );

  RETURN jsonb_build_object('ok', true, 'already_confirmed', false, 'payment_id', p_payment_id);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_confirm_custom_full_payment(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_confirm_custom_full_payment(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.admin_complete_custom_delivery(p_custom_order_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
      adopt_id,
      customer_id,
      custom_order_id,
      license_type,
      acquisition_price,
      acquired_at,
      metadata
    )
    VALUES (
      NULL,
      v_order.customer_id,
      p_custom_order_id,
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
      certificate_code,
      custom_order_id,
      status,
      certificate_data
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
    'custom_order',
    p_custom_order_id,
    'delivery_completed',
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
$$;

REVOKE ALL ON FUNCTION public.admin_complete_custom_delivery(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_complete_custom_delivery(uuid) TO service_role;
