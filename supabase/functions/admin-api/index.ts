import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ADMIN_SESSION_SECRET = Deno.env.get("ADMIN_SESSION_SECRET")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
auth: { autoRefreshToken: false, persistSession: false },
});

function escapeTelegramHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  })[char]!);
}

async function notifyTelegram(message: string): Promise<void> {
  const category = message.includes("Ownership transfer") ? "ownership_transfer"
    : message.includes("Manual sale") ? "manual_sale"
    : message.toLowerCase().includes("payment confirmed") ? "payment_confirmation"
    : message.includes("Certificate approved") || message.includes("Certificate rejected") ? "certificate_review"
    : message.toLowerCase().includes("delivery completed") ? "delivery_complete"
    : message.includes("returned to shop") ? "returned_to_shop" : "other";
  const { data: preferenceRow, error: preferenceError } = await supabase
    .from("shop_settings").select("setting_value")
    .eq("setting_key", "telegram_notifications").maybeSingle();
  const preferences = preferenceRow?.setting_value && typeof preferenceRow.setting_value === "object"
    ? preferenceRow.setting_value as Record<string, unknown> : {};
  if (!preferenceError && preferences[category] === false) {
    console.info("[telegram] Notification disabled by administrator preference:", category);
    return;
  }
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Deno.env.get("TELEGRAM_CHAT_ID");
  if (!token || !chatId) {
    console.warn("[telegram] Notification skipped: Telegram secrets are not configured.");
    return;
  }
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    if (!response.ok) {
      console.error("[telegram] Message delivery failed with HTTP", response.status);
    } else {
      const result = await response.json().catch(() => null);
      if (!result?.ok) console.error("[telegram] Telegram rejected a notification.");
    }
  } catch (error) {
    console.error("[telegram] Message delivery failed:", error instanceof Error ? error.message : "unknown error");
  }
}

const corsHeaders = {
"Access-Control-Allow-Origin": "*",
"Access-Control-Allow-Headers":
"authorization, x-client-info, apikey, content-type",
"Access-Control-Allow-Methods": "POST, OPTIONS",
"Content-Type": "application/json",
};

const PAGE_SIZE_MAX = 100;

function respond(data: unknown, status = 200) {
return new Response(JSON.stringify(data), {
status,
headers: corsHeaders,
});
}

function encodeBase64Url(bytes: Uint8Array): string {
let binary = "";
for (const byte of bytes) binary += String.fromCharCode(byte);

return btoa(binary)
.replace(/\+/g, "-")
.replace(/\//g, "_")
.replace(/=+$/g, "");
}

function decodeBase64Url(value: string): Uint8Array {
const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
const binary = atob(normalized);
return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function sha256(value: string): Promise<string> {
const digest = await crypto.subtle.digest(
"SHA-256",
new TextEncoder().encode(value),
);
return encodeBase64Url(new Uint8Array(digest));
}

async function sign(value: string): Promise<string> {
const key = await crypto.subtle.importKey(
"raw",
new TextEncoder().encode(ADMIN_SESSION_SECRET),
{ name: "HMAC", hash: "SHA-256" },
false,
["sign"],
);

const signature = await crypto.subtle.sign(
"HMAC",
key,
new TextEncoder().encode(value),
);

return encodeBase64Url(new Uint8Array(signature));
}

function safeEqual(a: string, b: string): boolean {
const x = new TextEncoder().encode(a);
const y = new TextEncoder().encode(b);

if (x.length !== y.length) return false;

let result = 0;
for (let i = 0; i < x.length; i++) result |= x[i] ^ y[i];

return result === 0;
}

type AdminPayload = {
role: string;
sid: string;
iat: number;
exp: number;
nonce: string;
};

async function authenticate(token: string): Promise<boolean> {
try {
const parts = token.split(".");
if (parts.length !== 2) return false;

const [encodedPayload, suppliedSignature] = parts;
const expectedSignature = await sign(encodedPayload);

if (!safeEqual(suppliedSignature, expectedSignature)) return false;

const payload = JSON.parse(
new TextDecoder().decode(decodeBase64Url(encodedPayload)),
) as AdminPayload;

const now = Math.floor(Date.now() / 1000);

if (
payload.role !== "admin" ||
typeof payload.sid !== "string" ||
typeof payload.exp !== "number" ||
typeof payload.iat !== "number" ||
payload.exp <= now ||
payload.iat > now + 60
) {
return false;
}

const tokenHash = await sha256(token);

const { data: session, error } = await supabase
.from("admin_sessions")
.select("id")
.eq("id", payload.sid)
.eq("token_hash", tokenHash)
.is("revoked_at", null)
.gt("expires_at", new Date().toISOString())
.maybeSingle();

if (error || !session) return false;

await supabase
.from("admin_sessions")
.update({ last_seen_at: new Date().toISOString() })
.eq("id", payload.sid)
.eq("token_hash", tokenHash)
.is("revoked_at", null);

return true;
} catch {
return false;
}
}

function isObject(value: unknown): value is Record<string, unknown> {
return (
typeof value === "object" &&
value !== null &&
!Array.isArray(value)
);
}

function validUuid(value: unknown): value is string {
return typeof value === "string" &&
/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
.test(value);
}

function pickAllowed(
input: Record<string, unknown>,
allowed: string[],
): Record<string, unknown> {
const result: Record<string, unknown> = {};

for (const key of allowed) {
if (Object.prototype.hasOwnProperty.call(input, key)) {
result[key] = input[key];
}
}

return result;
}

async function listTable(
table: string,
body: Record<string, unknown>,
) {
const allowedTables: Record<string, string> = {
adopts: "adopts",
adopt_images: "adopt_images",
customers: "customers",
purchase_requests: "purchase_requests",
custom_orders: "custom_orders",
custom_reference_files: "custom_reference_files",
payments: "payments",
ownership_records: "ownership_records",
certificates: "certificates",
custom_order_updates: "custom_order_updates",
activity_log: "activity_log",
shop_settings: "shop_settings",
};

const actualTable = allowedTables[table];
if (!actualTable) {
return respond({ ok: false, error: "Resource not allowed." }, 400);
}

const requestedLimit = Number(body.limit ?? 50);
const limit = Number.isFinite(requestedLimit)
? Math.min(Math.max(Math.floor(requestedLimit), 1), PAGE_SIZE_MAX)
: 50;

const requestedPage = Number(body.page ?? 0);
const page = Number.isFinite(requestedPage)
? Math.max(Math.floor(requestedPage), 0)
: 0;

const from = page * limit;
const to = from + limit - 1;

let query = supabase
.from(actualTable)
.select("*", { count: "exact" });

if (typeof body.search === "string" && body.search.trim()) {
const search = body.search.trim().slice(0, 100);

if (table === "adopts") {
query = query.or(
`name.ilike.%${search}%,adopt_code.ilike.%${search}%`,
);
} else if (table === "customers") {
query = query.or(
`full_name.ilike.%${search}%,email.ilike.%${search}%`,
);
} else if (table === "purchase_requests") {
query = query.ilike("request_code", `%${search}%`);
} else if (table === "custom_orders") {
query = query.or(
`order_code.ilike.%${search}%,character_name.ilike.%${search}%`,
);
} else if (table === "certificates") {
query = query.ilike("certificate_code", `%${search}%`);
}
}

if (table === "adopts" && typeof body.status === "string") {
query = query.eq("status", body.status);
}

if (table === "adopts" && body.archived === true) {
query = query.eq("archive_visible", true);
} else if (table === "adopts" && body.archived === false) {
query = query.eq("archive_visible", false);
}

if (table === "purchase_requests" && typeof body.status === "string") {
query = query.eq("status", body.status);
}

if (table === "custom_orders" && typeof body.status === "string") {
query = query.eq("status", body.status);
}

if (table === "payments" && typeof body.status === "string") {
query = query.eq("status", body.status);
}

if (table === "certificates" && typeof body.status === "string") {
query = query.eq("status", body.status);
}

const orderColumn = table === "ownership_records"
? "acquired_at"
: table === "shop_settings"
? "updated_at"
: "created_at";

const { data, error, count } = await query
.order(orderColumn, { ascending: false })
.range(from, to);

if (error) {
return respond({ ok: false, error: error.message }, 400);
}

let outputData = data ?? [];

if (table === "adopt_images" || table === "custom_reference_files") {
const bucket = table === "adopt_images" ? "adoptables" : "custom-references";
outputData = await Promise.all(outputData.map(async (row: Record<string, unknown>) => {
const storagePath = typeof row.storage_path === "string" ? row.storage_path : "";
if (!storagePath) return { ...row, signed_url: null };
const { data: signed, error: signedError } = await supabase.storage
.from(bucket)
.createSignedUrl(storagePath, 1800);
return { ...row, signed_url: signedError ? null : signed?.signedUrl ?? null };
}));
} else if (table === "custom_orders") {
outputData = await Promise.all(outputData.map(async (row: Record<string, unknown>) => {
const storagePath = typeof row.final_artwork_path === "string" ? row.final_artwork_path : "";
if (!storagePath) return { ...row, final_artwork_url: null };
const { data: signed, error: signedError } = await supabase.storage
.from("private-deliveries")
.createSignedUrl(storagePath, 1800);
return { ...row, final_artwork_url: signedError ? null : signed?.signedUrl ?? null };
}));
}

return respond({
ok: true,
data: outputData,
page,
limit,
total: count ?? 0,
});
}

async function dashboard() {
const tables = [
"adopts",
"customers",
"purchase_requests",
"custom_orders",
"payments",
"certificates",
] as const;

const results = await Promise.all(
tables.map(async (table) => {
const { count, error } = await supabase
.from(table)
.select("id", { count: "exact", head: true });

if (error) throw error;
return [table, count ?? 0] as const;
}),
);

const counts = Object.fromEntries(results);

const { count: available, error: availableError } = await supabase
.from("adopts")
.select("id", { count: "exact", head: true })
.eq("status", "Available")
.eq("public_visible", true);

if (availableError) throw availableError;

const { count: pendingRequests, error: requestsError } = await supabase
.from("purchase_requests")
.select("id", { count: "exact", head: true })
.eq("status", "Pending Review");

if (requestsError) throw requestsError;

const { count: pendingCertificates, error: certError } = await supabase
.from("certificates")
.select("id", { count: "exact", head: true })
.eq("status", "Pending Review");

if (certError) throw certError;

return respond({
ok: true,
counts: {
...counts,
available_adopts: available ?? 0,
pending_requests: pendingRequests ?? 0,
pending_certificates: pendingCertificates ?? 0,
},
});
}

async function createAdopt(body: Record<string, unknown>) {
if (!isObject(body.values)) return respond({ ok: false, error: "Invalid adopt data." }, 400);
const input = body.values;
const adoptCode = typeof input.adopt_code === "string" ? input.adopt_code.trim() : "";
const name = typeof input.name === "string" ? input.name.trim() : "";
const price = Number(input.price);
if (!adoptCode || adoptCode.length > 80 || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(adoptCode)) {
return respond({ ok: false, error: "Adopt ID must be 1–80 characters and use only letters, numbers, hyphens or underscores." }, 400);
}
if (!name || name.length > 180 || !Number.isFinite(price) || price < 0) {
return respond({ ok: false, error: "Enter a valid character name and non-negative price." }, 400);
}
if (input.status !== undefined && !["Available", "Reserved", "Sold"].includes(String(input.status))) {
return respond({ ok: false, error: "Choose a valid inventory status." }, 400);
}
for (const key of ["public_visible", "featured", "archive_visible"]) {
if (input[key] !== undefined && typeof input[key] !== "boolean") {
return respond({ ok: false, error: "Inventory visibility and featured flags must be boolean." }, 400);
}
}
for (const key of ["tags", "files"]) {
if (input[key] !== undefined && !Array.isArray(input[key])) {
return respond({ ok: false, error: "Tags and file details must be lists." }, 400);
}
}
if (input.metadata !== undefined && !isObject(input.metadata)) {
return respond({ ok: false, error: "Inventory metadata must be an object." }, 400);
}
const values = pickAllowed(input, [
"adopt_code", "name", "category", "price", "currency", "status",
"public_visible", "description", "license_info", "tags", "files",
"featured", "archive_visible", "symbol", "metadata",
]);
values.adopt_code = adoptCode;
values.name = name;
values.price = price;
values.currency = "USD";
const { data, error } = await supabase.from("adopts").insert(values).select().single();
if (error) return respond({ ok: false, error: error.code === "23505" ? "That Adopt ID is already in use." : error.message }, 400);
await supabase.from("activity_log").insert({
entity_type: "adopt", entity_id: data.id, action: "adopt_created",
description: "Adoptable created from admin panel",
metadata: { adopt_code: adoptCode },
});
return respond({ ok: true, data });
}

async function createAdoptImageUpload(body: Record<string, unknown>) {
if (!validUuid(body.adopt_id)) return respond({ ok: false, error: "Invalid adopt ID." }, 400);
const filename = typeof body.filename === "string" ? body.filename.trim().slice(0, 180) : "";
const contentType = typeof body.content_type === "string" ? body.content_type.toLowerCase() : "";
const fileSize = Number(body.file_size);
if (!filename || !/^image\/(jpeg|png|webp|gif|avif)$/.test(contentType) ||
!Number.isFinite(fileSize) || fileSize <= 0 || fileSize > 10 * 1024 * 1024) {
return respond({ ok: false, error: "Choose a JPG, PNG, WebP, GIF or AVIF image up to 10 MB." }, 400);
}
const { data: adopt, error: adoptError } = await supabase.from("adopts")
.select("id").eq("id", body.adopt_id).maybeSingle();
if (adoptError) return respond({ ok: false, error: adoptError.message }, 400);
if (!adopt) return respond({ ok: false, error: "Adoptable not found." }, 404);
const extension = filename.includes(".") ? filename.split(".").pop()!.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) : "img";
const path = "adopts/" + String(body.adopt_id) + "/" + crypto.randomUUID() + "." + (extension || "img");
const { data, error } = await supabase.storage.from("adoptables").createSignedUploadUrl(path);
if (error || !data?.token) return respond({ ok: false, error: error?.message || "Could not prepare secure image upload." }, 400);
return respond({ ok: true, path, token: data.token });
}

async function saveAdoptImages(body: Record<string, unknown>) {
if (!validUuid(body.adopt_id) || !Array.isArray(body.images) || body.images.length > 30) {
return respond({ ok: false, error: "Invalid adopt image list." }, 400);
}
const adoptId = body.adopt_id;
const { data: adopt, error: adoptError } = await supabase.from("adopts").select("id").eq("id", adoptId).maybeSingle();
if (adoptError) return respond({ ok: false, error: adoptError.message }, 400);
if (!adopt) return respond({ ok: false, error: "Adoptable not found." }, 404);
const { data: current, error: currentError } = await supabase.from("adopt_images")
.select("id, storage_path").eq("adopt_id", adoptId);
if (currentError) return respond({ ok: false, error: currentError.message }, 400);
const currentById = new Map<string, Record<string, unknown>>();
for (const row of current || []) currentById.set(String(row.id), row as Record<string, unknown>);
const keepIds = new Set<string>();
const newRows: Record<string, unknown>[] = [];
const updateRows: { id: string; sort_order: number; is_main: boolean }[] = [];
let mainCount = 0;
for (let index = 0; index < body.images.length; index++) {
const item = body.images[index];
if (!isObject(item)) return respond({ ok: false, error: "Invalid image entry." }, 400);
const isMain = item.is_main === true;
if (isMain) mainCount++;
if (typeof item.id === "string") {
const row = currentById.get(item.id);
if (!row || keepIds.has(item.id)) return respond({ ok: false, error: "An image does not belong to this adoptable." }, 400);
keepIds.add(item.id);
updateRows.push({ id: item.id, sort_order: index, is_main: isMain });
} else {
const path = typeof item.storage_path === "string" ? item.storage_path : "";
const expectedPrefix = "adopts/" + String(adoptId) + "/";
const filename = typeof item.original_filename === "string" ? item.original_filename.trim().slice(0, 180) : "";
const mime = typeof item.mime_type === "string" ? item.mime_type.toLowerCase() : "";
const size = Number(item.file_size);
if (!path.startsWith(expectedPrefix) || path.includes("..") || !filename ||
!/^image\/(jpeg|png|webp|gif|avif)$/.test(mime) || !Number.isFinite(size) || size <= 0 || size > 10 * 1024 * 1024) {
return respond({ ok: false, error: "An uploaded image has invalid metadata." }, 400);
}
newRows.push({ adopt_id: adoptId, storage_path: path, original_filename: filename, mime_type: mime, file_size: size, sort_order: index, is_main: isMain });
}
}
if ((body.images.length === 0 && mainCount !== 0) || (body.images.length > 0 && mainCount !== 1)) {
return respond({ ok: false, error: "Choose exactly one main artwork image." }, 400);
}
for (const row of updateRows) {
const { error } = await supabase.from("adopt_images").update({ sort_order: row.sort_order, is_main: row.is_main }).eq("id", row.id).eq("adopt_id", adoptId);
if (error) return respond({ ok: false, error: error.message }, 400);
}
if (newRows.length) {
const { error } = await supabase.from("adopt_images").insert(newRows);
if (error) return respond({ ok: false, error: error.message }, 400);
}
const removed = (current || []).filter((row: Record<string, unknown>) => !keepIds.has(String(row.id)));
if (removed.length) {
const { error } = await supabase.from("adopt_images").delete().in("id", removed.map((row: Record<string, unknown>) => row.id));
if (error) return respond({ ok: false, error: error.message }, 400);
const paths = removed.map((row: Record<string, unknown>) => row.storage_path).filter((path): path is string => typeof path === "string" && path.startsWith("adopts/" + String(adoptId) + "/"));
if (paths.length) {
const { error: storageError } = await supabase.storage.from("adoptables").remove(paths);
if (storageError) console.error("[AdoptShop] Removed image rows but storage cleanup failed:", storageError.message);
}
}
await supabase.from("activity_log").insert({
entity_type: "adopt", entity_id: adoptId, action: "adopt_images_updated",
description: "Adoptable artwork updated from admin panel",
metadata: { image_count: body.images.length },
});
return respond({ ok: true, image_count: body.images.length });
}

async function cleanupAdoptImageUploads(body: Record<string, unknown>) {
  if (!validUuid(body.adopt_id) || !Array.isArray(body.paths) || body.paths.length > 30) {
    return respond({ ok: false, error: "Invalid adopt image cleanup request." }, 400);
  }
  const adoptId = String(body.adopt_id);
  const prefix = "adopts/" + adoptId + "/";
  const paths = [...new Set(body.paths.filter((value): value is string =>
    typeof value === "string" && value.startsWith(prefix) && !value.includes("..") && value.length <= 500
  ))];
  if (!paths.length) return respond({ ok: true, removed_count: 0 });
  const { data: linked, error: linkedError } = await supabase
    .from("adopt_images").select("storage_path").eq("adopt_id", adoptId).in("storage_path", paths);
  if (linkedError) return respond({ ok: false, error: linkedError.message }, 400);
  const linkedPaths = new Set((linked || []).map((row: { storage_path: string }) => row.storage_path));
  const unlinkedPaths = paths.filter((path) => !linkedPaths.has(path));
  if (!unlinkedPaths.length) return respond({ ok: true, removed_count: 0 });
  const { error: removeError } = await supabase.storage.from("adoptables").remove(unlinkedPaths);
  if (removeError) return respond({ ok: false, error: removeError.message }, 400);
  return respond({ ok: true, removed_count: unlinkedPaths.length });
}

async function sendTelegramTest() {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Deno.env.get("TELEGRAM_CHAT_ID");
  if (!token || !chatId) {
    return respond({ ok: false, error: "Telegram bot credentials are not configured in Supabase secrets." }, 503);
  }
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: "✦ Lady K ★ Fih AdoptShop\nPrivate Telegram test successful. Administrative notifications are reachable.",
        disable_web_page_preview: true,
      }),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result?.ok) {
      console.error("[telegram] Test message rejected with HTTP", response.status);
      return respond({ ok: false, error: "Telegram rejected the test message. Check the bot and chat configuration in Supabase." }, 502);
    }
    return respond({ ok: true, message: "Test message sent to the configured private Telegram chat." });
  } catch (error) {
    console.error("[telegram] Test message failed:", error instanceof Error ? error.message : "unknown error");
    return respond({ ok: false, error: "Telegram could not be reached. Try again later." }, 502);
  }
}

async function updateTelegramPreferences(body: Record<string, unknown>) {
  const keys = [
    "purchase_request", "custom_request", "manual_sale", "ownership_transfer",
    "payment_confirmation", "certificate_review", "delivery_complete", "returned_to_shop",
  ] as const;
  if (!isObject(body.notification_preferences)) {
    return respond({ ok: false, error: "Notification preferences are required." }, 400);
  }
  const input = body.notification_preferences as Record<string, unknown>;
  const preferences: Record<string, boolean> = {};
  for (const key of keys) {
    if (typeof input[key] !== "boolean") {
      return respond({ ok: false, error: "Every notification preference must be enabled or disabled." }, 400);
    }
    preferences[key] = input[key] as boolean;
  }
  const { data, error } = await supabase.from("shop_settings").upsert({
    setting_key: "telegram_notifications",
    setting_value: preferences,
    updated_at: new Date().toISOString(),
  }, { onConflict: "setting_key" }).select().single();
  if (error) return respond({ ok: false, error: error.message }, 400);
  await supabase.from("activity_log").insert({
    entity_type: "shop_settings", entity_id: data.id,
    action: "telegram_preferences_updated",
    description: "Private Telegram notification preferences updated",
    metadata: preferences,
  });
  return respond({ ok: true, data });
}

async function updateStoreVisibility(body: Record<string, unknown>) {
  const allowed = ["Public", "Temporarily Closed", "Hidden from Public"];
  const visibility = typeof body.store_visibility === "string" ? body.store_visibility : "";
  if (!allowed.includes(visibility)) {
    return respond({ ok: false, error: "Choose a valid store availability status." }, 400);
  }
  const { data, error } = await supabase
    .from("shop_settings")
    .upsert({
      setting_key: "store_visibility",
      setting_value: visibility,
      updated_at: new Date().toISOString(),
    }, { onConflict: "setting_key" })
    .select()
    .single();
  if (error) return respond({ ok: false, error: error.message }, 400);
  await supabase.from("activity_log").insert({
    entity_type: "shop_settings",
    entity_id: data.id,
    action: "store_visibility_updated",
    description: "Store availability changed to " + visibility,
    metadata: { store_visibility: visibility },
  });
  return respond({ ok: true, data });
}

async function updateAdopt(body: Record<string, unknown>) {
if (!validUuid(body.id) || !isObject(body.values)) {
return respond({ ok: false, error: "Invalid adopt update." }, 400);
}

const values = pickAllowed(body.values, [
"name",
"category",
"price",
"currency",
"status",
"public_visible",
"description",
"license_info",
"tags",
"files",
"featured",
"archive_visible",
"symbol",
"metadata",
]);

if (Object.keys(values).length === 0) {
return respond({ ok: false, error: "No permitted fields supplied." }, 400);
}
if ("name" in values && (typeof values.name !== "string" || !values.name.trim() || values.name.trim().length > 180)) {
return respond({ ok: false, error: "Enter a valid character name." }, 400);
}
if ("price" in values && (!Number.isFinite(Number(values.price)) || Number(values.price) < 0)) {
return respond({ ok: false, error: "Adopt price must be a non-negative USD amount." }, 400);
}
if ("status" in values && !["Available", "Reserved", "Sold"].includes(String(values.status))) {
return respond({ ok: false, error: "Choose a valid inventory status." }, 400);
}
for (const key of ["public_visible", "featured", "archive_visible"]) {
if (key in values && typeof values[key] !== "boolean") {
return respond({ ok: false, error: "Inventory visibility and featured flags must be boolean." }, 400);
}
}
for (const key of ["tags", "files"]) {
if (key in values && !Array.isArray(values[key])) {
return respond({ ok: false, error: "Tags and file details must be lists." }, 400);
}
}
if ("metadata" in values && !isObject(values.metadata)) {
return respond({ ok: false, error: "Inventory metadata must be an object." }, 400);
}
if ("currency" in values) values.currency = "USD";
values.updated_at = new Date().toISOString();

const { data, error } = await supabase
.from("adopts")
.update(values)
.eq("id", body.id)
.select()
.maybeSingle();

if (error) return respond({ ok: false, error: error.message }, 400);
if (!data) return respond({ ok: false, error: "Adoptable not found." }, 404);

await supabase.from("activity_log").insert({
entity_type: "adopt",
entity_id: body.id,
action: "adopt_updated",
description: "Adoptable updated from admin panel",
metadata: { changed_fields: Object.keys(values) },
});

return respond({ ok: true, data });
}


async function transferOwnership(body: Record<string, unknown>) {
  if (!isObject(body.payload)) return respond({ ok: false, error: "Transfer details are required." }, 400);
  const input = body.payload;
  const adoptCode = typeof input.adopt_code === "string" ? input.adopt_code.trim() : "";
  const fullName = typeof input.full_name === "string" ? input.full_name.trim() : "";
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const discord = typeof input.discord_username === "string" ? input.discord_username.trim() : "";
  const notes = typeof input.notes === "string" ? input.notes.trim() : "";
  if (!adoptCode || !fullName || !email || !notes ||
      input.previous_owner_consent !== true || input.new_owner_consent !== true ||
      input.admin_authorized !== true) {
    return respond({ ok: false, error: "Complete the new owner's details, transfer notes and all three confirmations." }, 400);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return respond({ ok: false, error: "Enter a valid new owner email address." }, 400);
  }
  const payload = {
    adopt_code: adoptCode.slice(0, 100),
    full_name: fullName.slice(0, 180),
    email: email.slice(0, 320),
    discord_username: discord.slice(0, 100),
    notes: notes.slice(0, 2000),
    previous_owner_consent: true,
    new_owner_consent: true,
    admin_authorized: true,
  };
  const { data, error } = await supabase.rpc("admin_transfer_ownership", { p_payload: payload });
  if (error) return respond({ ok: false, error: error.message }, 400);
  const result = Array.isArray(data) ? data[0] : data;
  if (!result?.ok) return respond({ ok: false, error: "The ownership transfer could not be recorded." }, 400);
  await notifyTelegram(
    "↔️ <b>Ownership transfer recorded</b>\nAdopt: <code>" +
    escapeTelegramHtml(result.adopt_code || adoptCode) + "</code>\nNew owner: " +
    escapeTelegramHtml(fullName) + "\nNew certificate: <code>" +
    escapeTelegramHtml(result.certificate_code || "") + "</code>\nStatus: Pending artist review",
  );
  return respond({ ok: true, data: result });
}

async function createManualSale(body: Record<string, unknown>) {
if (!isObject(body.payload)) return respond({ ok: false, error: "Manual sale details are required." }, 400);
const input = body.payload;
const adoptCode = typeof input.adopt_code === "string" ? input.adopt_code.trim() : "";
const fullName = typeof input.full_name === "string" ? input.full_name.trim() : "";
const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
const discord = typeof input.discord === "string" ? input.discord.trim() : "";
const license = typeof input.license_type === "string" ? input.license_type.trim() : "";
const paymentMethod = typeof input.payment_method === "string" ? input.payment_method.trim() : "";
const amount = Number(input.amount);
if (!adoptCode || !fullName || !email || !discord || !license || !paymentMethod ||
!Number.isFinite(amount) || amount <= 0 || input.terms_accepted !== true || input.payment_confirmed !== true) {
return respond({ ok: false, error: "Complete buyer details, license, received amount, payment method, Terms acceptance and payment confirmation." }, 400);
}
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
return respond({ ok: false, error: "Enter a valid buyer email address." }, 400);
}
const payload = {
adopt_code: adoptCode,
full_name: fullName.slice(0, 180),
email: email.slice(0, 320),
discord: discord.slice(0, 100),
license_type: license,
amount,
payment_method: paymentMethod.slice(0, 100),
notes: typeof input.notes === "string" ? input.notes.slice(0, 2000) : "",
terms_accepted: true,
payment_confirmed: true,
};
const { data, error } = await supabase.rpc("admin_create_manual_sale", { p_payload: payload });
if (error) return respond({ ok: false, error: error.message }, 400);
const result = Array.isArray(data) ? data[0] : data;
if (!result?.ok) return respond({ ok: false, error: "The manual sale could not be recorded." }, 400);
await notifyTelegram(
"🧾 <b>Manual sale recorded</b>\nAdopt: <code>" +
escapeTelegramHtml(result.adopt_code || adoptCode) + "</code>\nRequest: <code>" +
escapeTelegramHtml(result.request_code || "") + "</code>\nBuyer: " +
escapeTelegramHtml(fullName) + "\nAmount: $" + amount.toFixed(2) + " USD\nPayment: " +
escapeTelegramHtml(paymentMethod) + "\nStatus: Payment confirmed · delivery pending",
);
return respond({ ok: true, data: result });
}

async function confirmPurchasePayment(body: Record<string, unknown>) {
if (!validUuid(body.request_id)) {
return respond({ ok: false, error: "Invalid purchase request ID." }, 400);
}
const { data: request, error: requestError } = await supabase
.from("purchase_requests")
.select("id, request_code, adopt_id, total, paid, status, invoice_sent")
.eq("id", body.request_id)
.maybeSingle();
if (requestError) return respond({ ok: false, error: requestError.message }, 400);
if (!request) return respond({ ok: false, error: "Purchase request not found." }, 404);
if (request.paid) return respond({ ok: true, already_confirmed: true });
if (["Cancelled", "Rejected", "Completed", "Delivered"].includes(request.status)) {
return respond({ ok: false, error: "This purchase request is closed." }, 409);
}
if (request.status !== "Approved" || !request.invoice_sent) {
return respond({ ok: false, error: "Approve the request and mark the invoice as sent before confirming payment." }, 409);
}
const { data: adopt, error: adoptError } = await supabase
.from("adopts")
.select("id, name, adopt_code, status")
.eq("id", request.adopt_id)
.maybeSingle();
if (adoptError) return respond({ ok: false, error: adoptError.message }, 400);
if (!adopt || adopt.status !== "Reserved") {
return respond({ ok: false, error: "The adoptable must remain Reserved before payment confirmation." }, 409);
}
const stage = "Full payment";
const { data: existing, error: existingError } = await supabase
.from("payments")
.select("id, status")
.eq("purchase_request_id", request.id)
.eq("stage", stage)
.order("created_at", { ascending: false })
.limit(1)
.maybeSingle();
if (existingError) return respond({ ok: false, error: existingError.message }, 400);
if (existing?.status === "Confirmed") {
return respond({ ok: true, already_confirmed: true, payment_id: existing.id });
}
let paymentId = existing?.id;
if (!paymentId) {
const { data: payment, error: paymentError } = await supabase
.from("payments")
.insert({
purchase_request_id: request.id,
stage,
amount: request.total,
currency: "USD",
status: "Pending",
payment_method: typeof body.payment_method === "string"
? body.payment_method.trim().slice(0, 100)
: "Manual verification",
})
.select("id")
.single();
if (paymentError) {
if (paymentError.code !== "23505") return respond({ ok: false, error: paymentError.message }, 400);
const { data: raced, error: racedError } = await supabase
.from("payments")
.select("id, status")
.eq("purchase_request_id", request.id)
.eq("stage", stage)
.maybeSingle();
if (racedError || !raced) return respond({ ok: false, error: racedError?.message || "Payment record could not be recovered." }, 400);
if (raced.status === "Confirmed") return respond({ ok: true, already_confirmed: true, payment_id: raced.id });
paymentId = raced.id;
} else {
paymentId = payment.id;
}
}
const { data: confirmation, error: confirmationError } = await supabase.rpc(
"admin_confirm_payment",
{ p_payment_id: paymentId },
);
if (confirmationError) return respond({ ok: false, error: confirmationError.message }, 400);
await notifyTelegram(
  "💳 <b>Purchase payment confirmed</b>\n" +
  "Request: <code>" + escapeTelegramHtml(request.request_code || request.id) + "</code>\n" +
  "Adopt: " + escapeTelegramHtml(adopt.name || adopt.adopt_code || "Adoptable") + "\n" +
  "Amount: <b>$" + escapeTelegramHtml(Number(request.total).toFixed(2)) + " USD</b>",
);
return respond({ ok: true, payment_id: paymentId, data: confirmation });
}

async function updatePurchaseRequest(body: Record<string, unknown>) {
if (!validUuid(body.id) || !isObject(body.values)) {
return respond({ ok: false, error: "Invalid purchase request update." }, 400);
}
const values = pickAllowed(body.values, [
"status",
"payment_status",
"invoice_sent",
"payment_pending",
"metadata",
]);
if (Object.keys(values).length === 0) {
return respond({ ok: false, error: "No permitted fields supplied." }, 400);
}
const allowedStatuses = ["Pending Review", "Clarification Requested", "Approved", "Rejected", "Cancelled"];
const allowedPaymentStatuses = ["Not Sent", "Invoice Sent", "Payment Pending"];
if ("status" in values && !allowedStatuses.includes(String(values.status))) {
return respond({ ok: false, error: "Purchase status must be changed through an allowed review action." }, 400);
}
if ("payment_status" in values && !allowedPaymentStatuses.includes(String(values.payment_status))) {
return respond({ ok: false, error: "Payment status can only be changed by the payment workflow." }, 400);
}
for (const key of ["invoice_sent", "payment_pending"]) {
if (key in values && typeof values[key] !== "boolean") {
return respond({ ok: false, error: "Invoice and pending-payment flags must be boolean." }, 400);
}
}
if ("metadata" in values && !isObject(values.metadata)) {
return respond({ ok: false, error: "Purchase metadata must be an object." }, 400);
}
const { data: current, error: currentError } = await supabase
.from("purchase_requests").select("paid, status, invoice_sent, payment_pending, payment_status").eq("id", body.id).maybeSingle();
if (currentError) return respond({ ok: false, error: currentError.message }, 400);
if (!current) return respond({ ok: false, error: "Purchase request not found." }, 404);
if (current.paid && "status" in values && values.status !== current.status) {
return respond({ ok: false, error: "A paid purchase request's review status is locked." }, 409);
}
if (["Rejected", "Cancelled"].includes(current.status) && "status" in values && values.status !== current.status) {
return respond({ ok: false, error: "A rejected or cancelled request cannot be reopened; preserve its history and create a new request instead." }, 409);
}
if (current.invoice_sent && values.invoice_sent === false) {
return respond({ ok: false, error: "Invoice-sent confirmation cannot be reversed." }, 409);
}
if (current.payment_pending && values.payment_pending === false) {
return respond({ ok: false, error: "Payment-pending confirmation cannot be reversed." }, 409);
}
if (values.payment_status === "Invoice Sent" && !(current.invoice_sent || values.invoice_sent === true)) {
return respond({ ok: false, error: "Mark the invoice as sent before setting its payment status." }, 409);
}
if (values.payment_status === "Payment Pending" && !(current.payment_pending || values.payment_pending === true)) {
return respond({ ok: false, error: "Mark payment as pending before setting its payment status." }, 409);
}
if (current.paid && ("invoice_sent" in values || "payment_pending" in values || "payment_status" in values)) {
return respond({ ok: false, error: "Payment and invoice history are locked after payment confirmation." }, 409);
}
values.updated_at = new Date().toISOString();
const { data, error } = await supabase
.from("purchase_requests")
.update(values)
.eq("id", body.id)
.select()
.maybeSingle();
if (error) return respond({ ok: false, error: error.message }, 400);
if (!data) return respond({ ok: false, error: "Purchase request not found." }, 404);
await supabase.from("activity_log").insert({
entity_type: "purchase_request",
entity_id: body.id,
action: "purchase_request_updated",
description: "Purchase request updated from admin panel",
metadata: { changed_fields: Object.keys(values) },
});
return respond({ ok: true, data });
}

async function createFinalArtworkUpload(body: Record<string, unknown>) {
if (!validUuid(body.custom_order_id)) {
return respond({ ok: false, error: "Invalid Custom Adopt order ID." }, 400);
}
const filename = typeof body.filename === "string" ? body.filename.trim().slice(0, 180) : "";
const contentType = typeof body.content_type === "string" ? body.content_type.toLowerCase() : "";
const fileSize = Number(body.file_size);
if (!filename || !contentType.startsWith("image/") || !Number.isFinite(fileSize) || fileSize <= 0 || fileSize > 20 * 1024 * 1024) {
return respond({ ok: false, error: "Choose an image up to 20 MB." }, 400);
}
const { data: order, error: orderError } = await supabase
.from("custom_orders")
.select("id")
.eq("id", body.custom_order_id)
.maybeSingle();
if (orderError) return respond({ ok: false, error: orderError.message }, 400);
if (!order) return respond({ ok: false, error: "Custom Adopt order not found." }, 404);
const extension = filename.includes(".") ? filename.split(".").pop()!.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) : "img";
const storagePath = "custom-orders/" + String(body.custom_order_id) + "/final/" + crypto.randomUUID() + "." + (extension || "img");
const { data, error } = await supabase.storage
.from("private-deliveries")
.createSignedUploadUrl(storagePath);
if (error || !data?.token) {
return respond({ ok: false, error: error?.message || "Could not prepare the secure artwork upload." }, 400);
}
return respond({ ok: true, path: storagePath, token: data.token });
}

async function cleanupFinalArtworkUpload(body: Record<string, unknown>) {
  if (!validUuid(body.custom_order_id) || typeof body.path !== "string") {
    return respond({ ok: false, error: "Invalid final artwork cleanup request." }, 400);
  }
  const orderId = String(body.custom_order_id);
  const path = body.path;
  const prefix = "custom-orders/" + orderId + "/final/";
  if (!path.startsWith(prefix) || path.includes("..") || path.length > 500) {
    return respond({ ok: false, error: "Final artwork path is outside this order's private folder." }, 400);
  }
  const { data: linked, error: linkedError } = await supabase
    .from("custom_orders").select("id").eq("id", orderId).eq("final_artwork_path", path).maybeSingle();
  if (linkedError) return respond({ ok: false, error: linkedError.message }, 400);
  if (linked) return respond({ ok: true, removed_count: 0 });
  const { error: removeError } = await supabase.storage.from("private-deliveries").remove([path]);
  if (removeError) return respond({ ok: false, error: removeError.message }, 400);
  return respond({ ok: true, removed_count: 1 });
}

async function confirmCustomPayment(body: Record<string, unknown>) {
if (!validUuid(body.custom_order_id)) {
return respond({ ok: false, error: "Invalid Custom Adopt order ID." }, 400);
}
const requestedStage = String(body.stage ?? "").toLowerCase();
const stageMap: Record<string, { label: string; rpc: string; fraction: number }> = {
full: { label: "Full payment · 100%", rpc: "admin_confirm_custom_full_payment", fraction: 1 },
initial: { label: "Initial payment · 60%", rpc: "admin_confirm_payment", fraction: 0.6 },
final: { label: "Final payment · 40%", rpc: "admin_confirm_payment", fraction: 0.4 },
};
const selected = stageMap[requestedStage];
if (!selected) return respond({ ok: false, error: "Unknown payment stage." }, 400);

const { data: order, error: orderError } = await supabase
.from("custom_orders")
.select("id, order_code, character_name, quote_base, license_fee, agreed_total, payment_plan, quote_sent, client_approved_quote, initial_paid, final_approved, final_paid, status")
.eq("id", body.custom_order_id)
.maybeSingle();
if (orderError) return respond({ ok: false, error: orderError.message }, 400);
if (!order) return respond({ ok: false, error: "Custom Adopt order not found." }, 404);

const total = Number(order.agreed_total ?? (Number(order.quote_base || 0) + Number(order.license_fee || 0)));
if (!Number.isFinite(total) || total <= 0 || !order.quote_sent || !order.client_approved_quote) {
return respond({ ok: false, error: "A valid quotation must be sent and approved before payment confirmation." }, 409);
}
if (requestedStage === "full") {
if (order.payment_plan !== "full" || order.initial_paid || order.final_paid) {
return respond({ ok: false, error: "This order is not eligible for a full payment confirmation." }, 409);
}
} else if (order.payment_plan === "full") {
return respond({ ok: false, error: "This order uses the Full Payment plan." }, 409);
} else if (requestedStage === "initial" && order.initial_paid) {
return respond({ ok: true, already_confirmed: true });
} else if (requestedStage === "final" && (!order.initial_paid || !order.final_approved || order.final_paid)) {
return respond({ ok: false, error: "The final payment requires confirmed initial payment and final design approval." }, 409);
}

const amount = Number((total * selected.fraction).toFixed(2));
const { data: existing, error: existingError } = await supabase
.from("payments")
.select("id, status")
.eq("custom_order_id", order.id)
.eq("stage", selected.label)
.order("created_at", { ascending: false })
.limit(1)
.maybeSingle();
if (existingError) return respond({ ok: false, error: existingError.message }, 400);
if (existing?.status === "Confirmed") {
return respond({ ok: true, already_confirmed: true, payment_id: existing.id });
}
let paymentId = existing?.id;
if (!paymentId) {
const { data: payment, error: paymentError } = await supabase
.from("payments")
.insert({
custom_order_id: order.id,
stage: selected.label,
amount,
currency: "USD",
status: "Pending",
payment_method: typeof body.payment_method === "string"
? body.payment_method.trim().slice(0, 100)
: "Manual verification",
})
.select("id")
.single();
if (paymentError) {
if (paymentError.code !== "23505") return respond({ ok: false, error: paymentError.message }, 400);
const { data: raced, error: racedError } = await supabase
.from("payments")
.select("id, status")
.eq("custom_order_id", order.id)
.eq("stage", selected.label)
.maybeSingle();
if (racedError || !raced) return respond({ ok: false, error: racedError?.message || "Payment record could not be recovered." }, 400);
if (raced.status === "Confirmed") return respond({ ok: true, already_confirmed: true, payment_id: raced.id });
paymentId = raced.id;
} else {
paymentId = payment.id;
}
}
const { data: confirmation, error: confirmationError } = await supabase.rpc(
selected.rpc,
{ p_payment_id: paymentId },
);
if (confirmationError) return respond({ ok: false, error: confirmationError.message }, 400);

const nextStatus = requestedStage === "final" ? "Awaiting Delivery" : "In Progress";
await supabase.from("custom_orders").update({
status: nextStatus,
updated_at: new Date().toISOString(),
}).eq("id", order.id);

await notifyTelegram(
  "💳 <b>Custom Adopt payment confirmed</b>\n" +
  "Order: <code>" + escapeTelegramHtml(order.order_code || order.id) + "</code>\n" +
  "Character: " + escapeTelegramHtml(order.character_name || "Custom character") + "\n" +
  "Stage: " + escapeTelegramHtml(selected.label) + "\n" +
  "Amount: <b>$" + escapeTelegramHtml(amount.toFixed(2)) + " USD</b>",
);
return respond({ ok: true, payment_id: paymentId, amount, stage: selected.label, data: confirmation });
}

async function addCustomUpdate(body: Record<string, unknown>) {
if (!validUuid(body.custom_order_id) || !["Note", "Feedback", "Suggestion"].includes(String(body.update_type))) {
return respond({ ok: false, error: "Invalid custom order update." }, 400);
}
const content = typeof body.content === "string" ? body.content.trim().slice(0, 5000) : "";
if (!content) return respond({ ok: false, error: "Update content is required." }, 400);
const values: Record<string, unknown> = {
custom_order_id: body.custom_order_id,
update_type: body.update_type,
content,
};
if (body.update_type === "Suggestion") {
values.review_status = typeof body.review_status === "string"
? body.review_status.slice(0, 40)
: "Pending Review";
}
const { data, error } = await supabase
.from("custom_order_updates")
.insert(values)
.select()
.single();
if (error) return respond({ ok: false, error: error.message }, 400);
await supabase.from("activity_log").insert({
entity_type: "custom_order",
entity_id: body.custom_order_id,
action: "custom_order_update_added",
description: "Custom order update recorded from admin panel",
metadata: { update_type: body.update_type },
});
return respond({ ok: true, data });
}

async function reviewCustomSuggestion(body: Record<string, unknown>) {
if (!validUuid(body.id)) {
return respond({ ok: false, error: "Invalid revision suggestion ID." }, 400);
}
const allowedStatuses = ["Pending Review", "Accepted", "Declined", "Completed"];
if (!allowedStatuses.includes(String(body.review_status))) {
return respond({ ok: false, error: "Invalid revision suggestion status." }, 400);
}
const { data, error } = await supabase
.from("custom_order_updates")
.update({ review_status: body.review_status })
.eq("id", body.id)
.eq("update_type", "Suggestion")
.select()
.maybeSingle();
if (error) return respond({ ok: false, error: error.message }, 400);
if (!data) return respond({ ok: false, error: "Revision suggestion not found." }, 404);
await supabase.from("activity_log").insert({
entity_type: "custom_order",
entity_id: data.custom_order_id,
action: "custom_suggestion_reviewed",
description: "Custom revision suggestion status updated",
metadata: { suggestion_id: data.id, review_status: data.review_status },
});
return respond({ ok: true, data });
}

async function updateCustomOrder(body: Record<string, unknown>) {
if (!validUuid(body.id) || !isObject(body.values)) {
return respond({ ok: false, error: "Invalid custom order update." }, 400);
}

const values = pickAllowed(body.values, [
"character_name",
"category",
"concept",
"appearance",
"colors",
"clothing",
"theme",
"instructions",
"links",
"status",
"quote_base",
"agreed_total",
"quote_sent",
"client_approved_quote",
"payment_plan",
"preview_presented",
"final_approved",
"final_artwork_path",
"metadata",
]);

if (Object.keys(values).length === 0) {
return respond({ ok: false, error: "No permitted fields supplied." }, 400);
}
const allowedStatuses = [
"New Request", "Pending Review", "Clarification Requested", "Approved",
"Rejected", "Cancelled", "Quote Pending", "Awaiting Client Approval",
"Awaiting Initial Payment", "In Progress", "Awaiting Final Approval",
"Awaiting Final Payment", "Awaiting Delivery", "Ready for Delivery",
];
if ("status" in values && !allowedStatuses.includes(String(values.status))) {
return respond({ ok: false, error: "Completed orders can only be set by the verified delivery workflow." }, 400);
}
if ("payment_plan" in values && !["full", "split"].includes(String(values.payment_plan))) {
return respond({ ok: false, error: "Select Full Payment or Split Payment." }, 400);
}
for (const key of ["quote_base", "agreed_total"]) {
if (key in values && (!Number.isFinite(Number(values[key])) || Number(values[key]) <= 0 || Number(values[key]) > 100000)) {
return respond({ ok: false, error: "Quotation amounts must be greater than zero and no more than $100,000 USD." }, 400);
}
}
if ("quote_sent" in values && typeof values.quote_sent !== "boolean") {
return respond({ ok: false, error: "Quote-sent status must be boolean." }, 400);
}
if ("client_approved_quote" in values && typeof values.client_approved_quote !== "boolean") {
return respond({ ok: false, error: "Client quote approval must be boolean." }, 400);
}
if ("preview_presented" in values && typeof values.preview_presented !== "boolean") {
return respond({ ok: false, error: "Preview presentation status must be boolean." }, 400);
}
if ("final_approved" in values && typeof values.final_approved !== "boolean") {
return respond({ ok: false, error: "Final approval status must be boolean." }, 400);
}
if ("metadata" in values && !isObject(values.metadata)) {
return respond({ ok: false, error: "Custom order metadata must be an object." }, 400);
}
if ("final_artwork_path" in values && values.final_artwork_path !== null) {
const expectedPrefix = "custom-orders/" + String(body.id) + "/final/";
if (typeof values.final_artwork_path !== "string" || !values.final_artwork_path.startsWith(expectedPrefix) || values.final_artwork_path.includes("..")) {
return respond({ ok: false, error: "Final artwork must use this order's private delivery folder." }, 400);
}
}
const { data: current, error: currentError } = await supabase
.from("custom_orders")
.select("status, initial_paid, final_paid, quote_sent, quote_base, license_fee, agreed_total, payment_plan, metadata, preview_presented, final_artwork_path")
.eq("id", body.id)
.maybeSingle();
if (currentError) return respond({ ok: false, error: currentError.message }, 400);
if (!current) return respond({ ok: false, error: "Custom order not found." }, 404);
if ((current.initial_paid || current.final_paid) && ["Rejected", "Cancelled"].includes(String(values.status || ""))) {
return respond({ ok: false, error: "A paid Custom Adopt cannot be rejected or cancelled." }, 409);
}
if (current.status === "Completed") {
return respond({ ok: false, error: "Completed orders are read-only." }, 409);
}
const currentQuoteBase = Number(current.quote_base || 0);
const currentLicenseFee = Number(current.license_fee || 0);
const nextQuoteBase = Number(values.quote_base ?? currentQuoteBase);
const nextTotal = Number(values.agreed_total ?? nextQuoteBase + currentLicenseFee);
const currentTotal = Number(current.agreed_total ?? currentQuoteBase + currentLicenseFee);
const quoteChanged = Math.round(nextQuoteBase * 100) !== Math.round(currentQuoteBase * 100)
  || Math.round(nextTotal * 100) !== Math.round(currentTotal * 100);
const planChanged = "payment_plan" in values && values.payment_plan !== current.payment_plan;
const hasConfirmedPayment = current.initial_paid || current.final_paid;
if (("quote_base" in values || "agreed_total" in values)
    && (!Number.isFinite(nextQuoteBase) || nextQuoteBase <= 0
      || !Number.isFinite(nextTotal) || Math.round(nextTotal * 100) !== Math.round((nextQuoteBase + currentLicenseFee) * 100))) {
return respond({ ok: false, error: "The agreed total must equal the design quote plus the fixed license fee." }, 400);
}
if (hasConfirmedPayment && planChanged) {
return respond({ ok: false, error: "The payment plan cannot be changed after a payment has been confirmed. You can still record an explicit price adjustment." }, 409);
}
if (hasConfirmedPayment && quoteChanged) {
const previousHistory = Array.isArray(current.metadata?.adjustment_history) ? current.metadata.adjustment_history : [];
const nextHistory = Array.isArray(values.metadata?.adjustment_history) ? values.metadata.adjustment_history : [];
const adjustment = nextHistory[nextHistory.length - 1];
const matchesAdjustment = nextHistory.length === previousHistory.length + 1
  && adjustment && typeof adjustment === "object"
  && Math.round(Number(adjustment.oldTotal) * 100) === Math.round(currentTotal * 100)
  && Math.round(Number(adjustment.newTotal) * 100) === Math.round(nextTotal * 100)
  && adjustment.oldPlan === current.payment_plan
  && adjustment.newPlan === current.payment_plan
  && typeof adjustment.date === "string"
  && Number.isFinite(Date.parse(adjustment.date));
if (!matchesAdjustment) {
return respond({ ok: false, error: "A paid order's price can only be adjusted with a matching administrative adjustment history entry." }, 409);
}
}
if (values.client_approved_quote === true && !(current.quote_sent || values.quote_sent === true)) {
return respond({ ok: false, error: "A quotation must be marked as sent before recording client approval." }, 409);
}
if (values.preview_presented === true && !(current.initial_paid || current.final_paid)) {
return respond({ ok: false, error: "A design preview can only be recorded after payment has been confirmed." }, 409);
}
if (values.final_approved === true && !(current.preview_presented || values.preview_presented === true)) {
return respond({ ok: false, error: "A preview must be recorded before final design approval." }, 409);
}
if (values.quote_sent === true && !(Number(values.quote_base ?? current.quote_base) > 0)) {
return respond({ ok: false, error: "Set a valid design quotation before marking it as sent." }, 409);
}
if (values.preview_presented === true) values.preview_presented_at = new Date().toISOString();
if (values.final_approved === true) values.final_approved_at = new Date().toISOString();
values.updated_at = new Date().toISOString();

const { data, error } = await supabase
.from("custom_orders")
.update(values)
.eq("id", body.id)
.select()
.maybeSingle();

if (error) return respond({ ok: false, error: error.message }, 400);
if (!data) return respond({ ok: false, error: "Custom order not found." }, 404);

const previousArtwork = typeof current.final_artwork_path === "string" ? current.final_artwork_path : "";
const nextArtwork = typeof data.final_artwork_path === "string" ? data.final_artwork_path : "";
const artworkPrefix = "custom-orders/" + String(body.id) + "/final/";
if (previousArtwork && previousArtwork !== nextArtwork && previousArtwork.startsWith(artworkPrefix)) {
  const { error: cleanupError } = await supabase.storage.from("private-deliveries").remove([previousArtwork]);
  if (cleanupError) console.warn("[AdoptShop] Previous final artwork cleanup failed:", cleanupError.message);
}

await supabase.from("activity_log").insert({
entity_type: "custom_order",
entity_id: body.id,
action: "custom_order_updated",
description: "Custom order updated from admin panel",
metadata: { changed_fields: Object.keys(values) },
});

return respond({ ok: true, data });
}

async function reviewCertificate(body: Record<string, unknown>) {
if (!validUuid(body.id)) {
return respond({ ok: false, error: "Invalid certificate ID." }, 400);
}

if (body.decision !== "approve" && body.decision !== "reject") {
return respond({ ok: false, error: "Invalid certificate decision." }, 400);
}

const now = new Date().toISOString();

const values = body.decision === "approve"
? {
status: "Approved",
reviewed_at: now,
approved_at: now,
}
: {
status: "Rejected",
reviewed_at: now,
};

const { data, error } = await supabase
.from("certificates")
.update(values)
.eq("id", body.id)
.eq("status", "Pending Review")
.select()
.maybeSingle();

if (error) return respond({ ok: false, error: error.message }, 400);
if (!data) {
return respond({
ok: false,
error: "Certificate not found or already reviewed.",
}, 409);
}

await supabase.from("activity_log").insert({
entity_type: "certificate",
entity_id: body.id,
action: body.decision === "approve"
? "certificate_approved"
: "certificate_rejected",
description: `Certificate ${body.decision}d by administrator`,
metadata: {},
});

await notifyTelegram(
  (body.decision === "approve" ? "📜 <b>Certificate approved</b>" : "⚠️ <b>Certificate rejected</b>") +
  "\nCertificate: <code>" + escapeTelegramHtml(data.certificate_code || data.id) + "</code>",
);
return respond({ ok: true, data });
}

async function callTransaction(
rpcName: string,
id: string,
parameterName: string,
) {
if (!validUuid(id)) {
return respond({ ok: false, error: "Invalid record ID." }, 400);
}

const { data, error } = await supabase.rpc(rpcName, {
[parameterName]: id,
});

if (error) {
return respond({ ok: false, error: error.message }, 400);
}

if (rpcName === "admin_complete_purchase_delivery") {
  const { data: request } = await supabase.from("purchase_requests")
    .select("request_code, total").eq("id", id).maybeSingle();
  await notifyTelegram(
    "📦 <b>Adopt delivery completed</b>\nRequest: <code>" +
    escapeTelegramHtml(request?.request_code || id) + "</code>" +
    (request?.total != null ? "\nTotal: $" + escapeTelegramHtml(Number(request.total).toFixed(2)) + " USD" : ""),
  );
} else if (rpcName === "admin_complete_custom_delivery") {
  const { data: order } = await supabase.from("custom_orders")
    .select("order_code, character_name").eq("id", id).maybeSingle();
  await notifyTelegram(
    "✦ <b>Custom Adopt delivery completed</b>\nOrder: <code>" +
    escapeTelegramHtml(order?.order_code || id) + "</code>\nCharacter: " +
    escapeTelegramHtml(order?.character_name || "Custom character"),
  );
} else if (rpcName === "admin_return_to_shop") {
  const { data: request } = await supabase.from("purchase_requests")
    .select("request_code").eq("id", id).maybeSingle();
  await notifyTelegram(
    "↩️ <b>Adopt returned to shop</b>\nRequest: <code>" +
    escapeTelegramHtml(request?.request_code || id) + "</code>",
  );
}
return respond({ ok: true, data });
}

Deno.serve(async (req: Request) => {
if (req.method === "OPTIONS") {
return new Response("ok", { headers: corsHeaders });
}

if (req.method !== "POST") {
return respond({ ok: false, error: "Method not allowed." }, 405);
}

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !ADMIN_SESSION_SECRET) {
return respond({ ok: false, error: "Server configuration is incomplete." }, 500);
}

try {
const contentLength = Number(req.headers.get("content-length") || 0);
if (contentLength > 1024 * 1024) {
return respond({ ok: false, error: "Administrative request exceeds the 1 MB limit." }, 413);
}
const body = await req.json();

if (!isObject(body)) {
return respond({ ok: false, error: "Invalid request body." }, 400);
}

const token = typeof body.token === "string" ? body.token : "";

if (!token || !(await authenticate(token))) {
return respond({ ok: false, error: "Unauthorized." }, 401);
}

switch (body.action) {
case "dashboard":
return await dashboard();

case "list":
if (typeof body.resource !== "string") {
return respond({ ok: false, error: "Resource is required." }, 400);
}
return await listTable(body.resource, body);

case "create-adopt":
return await createAdopt(body);

case "create-adopt-image-upload":
return await createAdoptImageUpload(body);

case "save-adopt-images":
return await saveAdoptImages(body);

case "cleanup-adopt-image-uploads":
return await cleanupAdoptImageUploads(body);

case "update-adopt":
return await updateAdopt(body);

case "update-store-visibility":
return await updateStoreVisibility(body);

case "update-telegram-preferences":
return await updateTelegramPreferences(body);

case "test-telegram":
return await sendTelegramTest();

case "create-manual-sale":
return await createManualSale(body);

case "transfer-ownership":
return await transferOwnership(body);

case "confirm-purchase-payment":
return await confirmPurchasePayment(body);

case "update-purchase-request":
return await updatePurchaseRequest(body);

case "create-final-artwork-upload":
return await createFinalArtworkUpload(body);

case "cleanup-final-artwork-upload":
return await cleanupFinalArtworkUpload(body);

case "confirm-custom-payment":
return await confirmCustomPayment(body);

case "add-custom-update":
return await addCustomUpdate(body);
 
case "review-custom-suggestion":
return await reviewCustomSuggestion(body);

case "update-custom-order":
return await updateCustomOrder(body);

case "return-to-shop":
return await callTransaction(
"admin_return_to_shop",
String(body.request_id ?? ""),
"p_request_id",
);

case "complete-purchase-delivery":
return await callTransaction(
"admin_complete_purchase_delivery",
String(body.request_id ?? ""),
"p_request_id",
);

case "complete-custom-delivery":
return await callTransaction(
"admin_complete_custom_delivery",
String(body.custom_order_id ?? ""),
"p_custom_order_id",
);

case "review-certificate":
return await reviewCertificate(body);

default:
return respond({ ok: false, error: "Unknown action." }, 400);
}
} catch (error) {
return respond({
ok: false,
error: error instanceof Error ? error.message : "Unexpected server error.",
}, 500);
}
});
