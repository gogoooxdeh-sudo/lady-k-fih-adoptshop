
-- Cover foreign keys used by custom-order history and ownership lookups.
-- These indexes are additive and do not modify existing customer or transaction rows.
CREATE INDEX IF NOT EXISTS custom_order_updates_custom_order_id_idx
  ON public.custom_order_updates (custom_order_id);
CREATE INDEX IF NOT EXISTS custom_reference_files_custom_order_id_idx
  ON public.custom_reference_files (custom_order_id);
CREATE INDEX IF NOT EXISTS ownership_records_custom_order_id_idx
  ON public.ownership_records (custom_order_id);
CREATE INDEX IF NOT EXISTS ownership_records_customer_id_idx
  ON public.ownership_records (customer_id);
CREATE INDEX IF NOT EXISTS ownership_records_purchase_request_id_idx
  ON public.ownership_records (purchase_request_id);
