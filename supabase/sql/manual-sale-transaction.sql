-- Lady K ★ Fih AdoptShop — atomic manual premade sale
-- Called only by the authenticated admin-api Edge Function using service_role.
-- The function records the buyer, purchase request, confirmed payment, inventory state and activity
-- in one database transaction. Ownership and the certificate are created by the existing
-- admin_complete_purchase_delivery() workflow after actual delivery is recorded.

create or replace function public.admin_create_manual_sale(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_adopt public.adopts%rowtype;
  v_customer_id uuid;
  v_request_id uuid;
  v_payment_id uuid;
  v_code text;
  v_email text;
  v_name text;
  v_discord text;
  v_license text;
  v_license_fee numeric;
  v_amount numeric;
  v_method text;
  v_notes text;
  v_now timestamptz := now();
begin
  v_name := btrim(coalesce(p_payload->>'full_name',''));
  v_email := lower(btrim(coalesce(p_payload->>'email','')));
  v_discord := btrim(coalesce(p_payload->>'discord',''));
  v_license := btrim(coalesce(p_payload->>'license_type',''));
  v_method := btrim(coalesce(p_payload->>'payment_method',''));
  v_notes := left(btrim(coalesce(p_payload->>'notes','')),2000);

  if v_name = '' or length(v_name) > 180 then
    raise exception 'Enter the buyer full name.';
  end if;
  if v_email = '' or length(v_email) > 320 or v_email !~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$' then
    raise exception 'Enter a valid buyer email address.';
  end if;
  if v_discord = '' or length(v_discord) > 100 then
    raise exception 'Enter the buyer Discord username.';
  end if;
  if v_license not in ('Personal Use','Commercial Use','Full Rights Transfer') then
    raise exception 'Select a valid license.';
  end if;
  if v_method = '' or length(v_method) > 100 then
    raise exception 'Enter the payment method.';
  end if;
  if coalesce(p_payload->>'terms_accepted','false') <> 'true' then
    raise exception 'Confirm that the buyer accepted the official Terms of Service.';
  end if;
  if coalesce(p_payload->>'payment_confirmed','false') <> 'true' then
    raise exception 'Confirm that payment was actually received.';
  end if;

  begin
    v_amount := (p_payload->>'amount')::numeric;
  exception when others then
    raise exception 'Enter a valid received amount.';
  end;
  if v_amount is null or v_amount <= 0 or v_amount > 1000000 then
    raise exception 'The received amount must be greater than zero.';
  end if;

  v_license_fee := case v_license
    when 'Personal Use' then 0
    when 'Commercial Use' then 25
    when 'Full Rights Transfer' then 75
  end;

  select * into v_adopt
  from public.adopts
  where adopt_code = btrim(coalesce(p_payload->>'adopt_code',''))
  for update;

  if not found then
    raise exception 'Adoptable not found.';
  end if;
  if v_adopt.status <> 'Available' then
    raise exception 'This adoptable is not Available. Use its existing purchase request if it is Reserved, or review its sale record if it is Sold.';
  end if;

  if exists (
    select 1 from public.purchase_requests
    where adopt_id = v_adopt.id
      and status not in ('Cancelled','Rejected')
      and delivered = false
  ) then
    raise exception 'An active purchase request already exists for this adoptable. Review that request instead of creating a duplicate sale.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(v_email));
  select id into v_customer_id
  from public.customers
  where lower(email) = v_email
  order by created_at asc
  limit 1
  for update;

  if v_customer_id is null then
    insert into public.customers(full_name,email,discord_username)
    values (v_name,v_email,v_discord)
    returning id into v_customer_id;
  else
    update public.customers
    set full_name = v_name, discord_username = v_discord, updated_at = v_now
    where id = v_customer_id;
  end if;

  v_code := 'PR-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,10));

  insert into public.purchase_requests(
    request_code, adopt_id, customer_id, license_type, base_price, license_fee,
    total, status, payment_status, invoice_sent, payment_pending, paid, paid_at,
    delivered, terms_accepted, metadata
  ) values (
    v_code, v_adopt.id, v_customer_id, v_license, v_adopt.price, v_license_fee,
    v_amount, 'Payment Confirmed', 'Confirmed', false, false, true, v_now,
    false, true,
    jsonb_build_object(
      'source','admin-manual-sale',
      'manual_sale',true,
      'payment_method',v_method,
      'payment_notes',v_notes,
      'expected_total',v_adopt.price + v_license_fee,
      'price_adjustment',v_amount - (v_adopt.price + v_license_fee),
      'recorded_at',v_now
    )
  ) returning id into v_request_id;

  insert into public.payments(
    purchase_request_id, stage, amount, currency, status, payment_method,
    confirmed_at, notes, metadata
  ) values (
    v_request_id, 'Full payment', v_amount, 'USD', 'Confirmed', v_method,
    v_now, nullif(v_notes,''), jsonb_build_object('source','admin-manual-sale')
  ) returning id into v_payment_id;

  update public.adopts
  set status = 'Sold', updated_at = v_now
  where id = v_adopt.id;

  insert into public.activity_log(entity_type,entity_id,action,description,metadata)
  values (
    'purchase_request',v_request_id,'manual_sale_recorded',
    'Manual sale recorded with payment confirmed by administrator',
    jsonb_build_object(
      'adopt_id',v_adopt.id,
      'adopt_code',v_adopt.adopt_code,
      'payment_id',v_payment_id,
      'amount',v_amount,
      'currency','USD'
    )
  );

  return jsonb_build_object(
    'ok',true,
    'request_id',v_request_id,
    'request_code',v_code,
    'payment_id',v_payment_id,
    'adopt_code',v_adopt.adopt_code,
    'status','Payment Confirmed',
    'delivered',false
  );
end;
$$;

revoke all on function public.admin_create_manual_sale(jsonb) from public, anon, authenticated;
grant execute on function public.admin_create_manual_sale(jsonb) to service_role;
