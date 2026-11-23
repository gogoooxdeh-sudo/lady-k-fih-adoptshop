-- Persistent premade ownership transfer.
-- The RPC is callable only by service_role; admin-api enforces the signed admin session.

CREATE OR REPLACE FUNCTION public.admin_transfer_ownership(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_adopt_code text := nullif(btrim(p_payload->>'adopt_code'), '');
  v_full_name text := nullif(btrim(p_payload->>'full_name'), '');
  v_email text := lower(nullif(btrim(p_payload->>'email'), ''));
  v_discord text := nullif(btrim(p_payload->>'discord_username'), '');
  v_notes text := nullif(btrim(p_payload->>'notes'), '');
  v_previous_consent boolean := coalesce((p_payload->>'previous_owner_consent')::boolean, false);
  v_new_consent boolean := coalesce((p_payload->>'new_owner_consent')::boolean, false);
  v_admin_authorized boolean := coalesce((p_payload->>'admin_authorized')::boolean, false);
  v_adopt public.adopts%rowtype;
  v_request public.purchase_requests%rowtype;
  v_current public.ownership_records%rowtype;
  v_customer_id uuid;
  v_old_certificate_id uuid;
  v_old_certificate_code text;
  v_new_ownership_id uuid;
  v_new_certificate_id uuid;
  v_new_certificate_code text;
  v_now timestamptz := now();
BEGIN
  IF v_adopt_code IS NULL OR v_full_name IS NULL OR v_email IS NULL OR v_notes IS NULL THEN
    RAISE EXCEPTION 'Adopt code, new owner name, email and transfer notes are required.';
  END IF;
  IF v_email !~* '^[A-Z0-9.!#$%&''*+/=?^_\x60{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$' THEN
    RAISE EXCEPTION 'Enter a valid new owner email address.';
  END IF;
  IF NOT (v_previous_consent AND v_new_consent AND v_admin_authorized) THEN
    RAISE EXCEPTION 'Both parties'' consent and administrator authorization must be confirmed.';
  END IF;

  SELECT * INTO v_adopt FROM public.adopts WHERE adopt_code = v_adopt_code FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Adoptable not found.'; END IF;
  IF v_adopt.status <> 'Sold' THEN RAISE EXCEPTION 'Only a sold adoptable can have its ownership transferred.'; END IF;

  SELECT * INTO v_current
  FROM public.ownership_records
  WHERE adopt_id = v_adopt.id AND purchase_request_id IS NOT NULL
    AND (metadata->>'ownership_state' IS DISTINCT FROM 'transferred')
  ORDER BY acquired_at DESC, id DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'No current registered owner was found for this adoptable.'; END IF;
  IF v_current.license_type <> 'Full Rights Transfer' THEN
    RAISE EXCEPTION 'This ownership record does not have the Full Rights Transfer license.';
  END IF;

  SELECT * INTO v_request FROM public.purchase_requests WHERE id = v_current.purchase_request_id FOR UPDATE;
  IF NOT FOUND OR NOT v_request.paid OR NOT v_request.delivered THEN
    RAISE EXCEPTION 'The original purchase must be fully paid and delivered before a transfer.';
  END IF;
  IF v_request.customer_id <> v_current.customer_id OR v_request.license_type <> 'Full Rights Transfer' THEN
    RAISE EXCEPTION 'The original purchase and current ownership record do not match.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_email, 0));
  SELECT id INTO v_customer_id FROM public.customers
  WHERE lower(email) = v_email ORDER BY created_at ASC LIMIT 1 FOR UPDATE;
  IF v_customer_id IS NULL THEN
    INSERT INTO public.customers(full_name, email, discord_username)
    VALUES (v_full_name, v_email, v_discord) RETURNING id INTO v_customer_id;
  ELSE
    UPDATE public.customers SET full_name = v_full_name,
      discord_username = coalesce(v_discord, discord_username), updated_at = v_now
    WHERE id = v_customer_id;
  END IF;
  IF v_customer_id = v_current.customer_id THEN
    RAISE EXCEPTION 'The new owner must be different from the current owner.';
  END IF;

  SELECT id, certificate_code INTO v_old_certificate_id, v_old_certificate_code
  FROM public.certificates
  WHERE purchase_request_id = v_current.purchase_request_id
    AND (certificate_data->>'ownership_id' = v_current.id::text
      OR (certificate_data->>'ownership_id' IS NULL AND certificate_data->>'transfer' IS DISTINCT FROM 'true'))
  ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  IF v_old_certificate_id IS NOT NULL THEN
    UPDATE public.certificates SET status = 'Superseded',
      reviewed_at = coalesce(reviewed_at, v_now) WHERE id = v_old_certificate_id;
  END IF;

  UPDATE public.ownership_records
  SET metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
    'ownership_state', 'transferred', 'transferred_at', v_now,
    'transferred_to_customer_id', v_customer_id, 'transfer_notes', v_notes,
    'transfer_consent_confirmed', true
  ) WHERE id = v_current.id;

  INSERT INTO public.ownership_records(
    adopt_id, customer_id, purchase_request_id, license_type,
    acquisition_price, acquired_at, metadata
  ) VALUES (
    v_adopt.id, v_customer_id, v_current.purchase_request_id,
    v_current.license_type, v_current.acquisition_price, v_now,
    jsonb_build_object(
      'ownership_state', 'current', 'transfer_from_ownership_id', v_current.id,
      'transfer_from_customer_id', v_current.customer_id,
      'transfer_from_certificate_code', v_old_certificate_code,
      'transfer_notes', v_notes, 'previous_owner_consent_confirmed', true,
      'new_owner_consent_confirmed', true, 'administrator_authorized', true
    )
  ) RETURNING id INTO v_new_ownership_id;

  v_new_certificate_code := 'LKF-' || to_char(v_now, 'YYYYMMDD') || '-' ||
    upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  INSERT INTO public.certificates(certificate_code, purchase_request_id, status, certificate_data)
  VALUES (
    v_new_certificate_code, v_current.purchase_request_id, 'Pending Review',
    jsonb_build_object(
      'request_id', v_current.purchase_request_id, 'adopt_id', v_adopt.id,
      'customer_id', v_customer_id, 'ownership_id', v_new_ownership_id,
      'transfer_from_ownership_id', v_current.id,
      'transfer_from_certificate_code', v_old_certificate_code,
      'license_type', v_current.license_type,
      'acquisition_price', v_current.acquisition_price,
      'generated_at', v_now, 'transfer', true
    )
  ) RETURNING id INTO v_new_certificate_id;

  INSERT INTO public.activity_log(entity_type, entity_id, action, description, metadata)
  VALUES (
    'ownership', v_new_ownership_id, 'ownership_transferred',
    'Ownership transferred for ' || v_adopt.adopt_code,
    jsonb_build_object(
      'adopt_id', v_adopt.id, 'from_ownership_id', v_current.id,
      'to_ownership_id', v_new_ownership_id, 'from_customer_id', v_current.customer_id,
      'to_customer_id', v_customer_id, 'previous_certificate_id', v_old_certificate_id,
      'new_certificate_id', v_new_certificate_id
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'adopt_code', v_adopt.adopt_code,
    'ownership_id', v_new_ownership_id, 'certificate_id', v_new_certificate_id,
    'certificate_code', v_new_certificate_code,
    'previous_certificate_id', v_old_certificate_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_transfer_ownership(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_transfer_ownership(jsonb) TO service_role;
