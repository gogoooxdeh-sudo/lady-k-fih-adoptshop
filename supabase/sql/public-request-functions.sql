-- Lady K ★ Fih AdoptShop — public request RPCs
-- Run this once in Supabase SQL Editor before deploying public-api.
-- Public/anon/authenticated cannot execute these functions; public-api uses service_role.

create or replace function public.public_create_purchase_request(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_adopt public.adopts%rowtype;
  v_customer_id uuid;
  v_request_id uuid;
  v_code text;
  v_total numeric;
  v_license_fee numeric;
begin
  if coalesce(trim(p_payload->>'full_name'), '') = ''
     or coalesce(trim(p_payload->>'email'), '') = ''
     or coalesce(trim(p_payload->>'discord'), '') = ''
     or coalesce(p_payload->>'terms_accepted','false') <> 'true' then
    raise exception 'Required buyer details or terms acceptance are missing';
  end if;

  select * into v_adopt
  from public.adopts
  where adopt_code = trim(p_payload->>'adopt_code')
  for update;

  if not found or v_adopt.status <> 'Available' or not v_adopt.public_visible then
    raise exception 'This adopt is no longer available';
  end if;

  insert into public.customers(full_name,email,discord_username)
  values (trim(p_payload->>'full_name'), lower(trim(p_payload->>'email')), trim(p_payload->>'discord'))
  returning id into v_customer_id;

  if coalesce(p_payload->>'license_type','') not in ('Personal Use','Commercial Use','Full Rights Transfer') then
    raise exception 'Invalid license selection';
  end if;
  v_license_fee := case p_payload->>'license_type'
    when 'Personal Use' then 0
    when 'Commercial Use' then 25
    when 'Full Rights Transfer' then 75
  end;
  v_total := v_adopt.price + v_license_fee;
  v_code := 'PR-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,10));

  insert into public.purchase_requests(
    request_code, adopt_id, customer_id, license_type, base_price, license_fee,
    total, status, payment_status, terms_accepted, metadata
  ) values (
    v_code, v_adopt.id, v_customer_id, p_payload->>'license_type',
    v_adopt.price, v_license_fee,
    v_total, 'Pending Review', 'Not Sent', true,
    jsonb_build_object('source','public-shop','submitted_at',now())
  ) returning id into v_request_id;

  update public.adopts
  set status='Reserved', updated_at=now()
  where id=v_adopt.id and status='Available';

  if not found then
    raise exception 'This adopt was reserved by another request';
  end if;

  insert into public.activity_log(entity_type,entity_id,action,description,metadata)
  values ('purchase_request',v_request_id,'created','New public purchase request received',
          jsonb_build_object('request_code',v_code,'adopt_code',v_adopt.adopt_code));

  return jsonb_build_object('id',v_request_id,'request_code',v_code,'status','Pending Review');
end;
$$;

create or replace function public.public_create_custom_order(p_payload jsonb, p_files jsonb default '[]'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer_id uuid;
  v_order_id uuid;
  v_code text;
  v_file jsonb;
  v_license_fee numeric;
begin
  if coalesce(trim(p_payload->>'full_name'), '') = ''
     or coalesce(trim(p_payload->>'email'), '') = ''
     or coalesce(trim(p_payload->>'discord'), '') = ''
     or coalesce(trim(p_payload->>'concept'), '') = ''
     or coalesce(p_payload->>'terms_accepted','false') <> 'true' then
    raise exception 'Required client details, concept, or terms acceptance are missing';
  end if;

  if jsonb_typeof(p_files) <> 'array' or jsonb_array_length(p_files) > 8 then
    raise exception 'A maximum of 8 reference images is allowed';
  end if;

  if coalesce(p_payload->>'license_type','') not in ('Personal Use','Commercial Use','Full Rights Transfer') then
    raise exception 'Invalid license selection';
  end if;
  v_license_fee := case p_payload->>'license_type'
    when 'Personal Use' then 0
    when 'Commercial Use' then 25
    when 'Full Rights Transfer' then 75
  end;

  insert into public.customers(full_name,email,discord_username)
  values (trim(p_payload->>'full_name'), lower(trim(p_payload->>'email')), trim(p_payload->>'discord'))
  returning id into v_customer_id;

  v_code := 'CR-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,10));

  insert into public.custom_orders(
    order_code,customer_id,character_name,category,concept,appearance,colors,
    clothing,theme,instructions,links,license_type,license_fee,status,terms_accepted,metadata
  ) values (
    v_code,v_customer_id,nullif(trim(p_payload->>'character_name'),''),
    p_payload->>'category',trim(p_payload->>'concept'),p_payload->>'appearance',
    p_payload->>'colors',p_payload->>'clothing',p_payload->>'theme',
    p_payload->>'instructions',p_payload->>'links',p_payload->>'license_type',
    v_license_fee,'New Request',true,
    jsonb_build_object('source','public-shop','submitted_at',now())
  ) returning id into v_order_id;

  for v_file in select value from jsonb_array_elements(p_files)
  loop
    insert into public.custom_reference_files(
      custom_order_id,storage_path,original_filename,mime_type,file_size,sort_order
    ) values (
      v_order_id,v_file->>'storage_path',v_file->>'original_filename',
      v_file->>'mime_type',(v_file->>'file_size')::bigint,
      coalesce((v_file->>'sort_order')::integer,0)
    );
  end loop;

  insert into public.activity_log(entity_type,entity_id,action,description,metadata)
  values ('custom_order',v_order_id,'created','New public Custom Adopt request received',
          jsonb_build_object('order_code',v_code,'reference_count',jsonb_array_length(p_files)));

  return jsonb_build_object('id',v_order_id,'order_code',v_code,'status','New Request');
end;
$$;

revoke all on function public.public_create_purchase_request(jsonb) from public, anon, authenticated;
revoke all on function public.public_create_custom_order(jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.public_create_purchase_request(jsonb) to service_role;
grant execute on function public.public_create_custom_order(jsonb,jsonb) to service_role;
