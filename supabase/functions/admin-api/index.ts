import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ADMIN_SESSION_SECRET = Deno.env.get("ADMIN_SESSION_SECRET")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
auth: { autoRefreshToken: false, persistSession: false },
});

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

async function confirmPurchasePayment(body: Record<string, unknown>) {
if (!validUuid(body.request_id)) {
return respond({ ok: false, error: "Invalid purchase request ID." }, 400);
}
const { data: request, error: requestError } = await supabase
.from("purchase_requests")
.select("id, adopt_id, total, paid, status")
.eq("id", body.request_id)
.maybeSingle();
if (requestError) return respond({ ok: false, error: requestError.message }, 400);
if (!request) return respond({ ok: false, error: "Purchase request not found." }, 404);
if (request.paid) return respond({ ok: true, already_confirmed: true });
if (["Cancelled", "Rejected", "Completed", "Delivered"].includes(request.status)) {
return respond({ ok: false, error: "This purchase request is closed." }, 409);
}
const { data: adopt, error: adoptError } = await supabase
.from("adopts")
.select("id, status")
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
if (paymentError) return respond({ ok: false, error: paymentError.message }, 400);
paymentId = payment.id;
}
const { data: confirmation, error: confirmationError } = await supabase.rpc(
"admin_confirm_payment",
{ p_payment_id: paymentId },
);
if (confirmationError) return respond({ ok: false, error: confirmationError.message }, 400);
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
"delivered",
"metadata",
]);
if (Object.keys(values).length === 0) {
return respond({ ok: false, error: "No permitted fields supplied." }, 400);
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
.select("id, quote_base, license_fee, agreed_total, payment_plan, quote_sent, client_approved_quote, initial_paid, final_approved, final_paid, status")
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
if (paymentError) return respond({ ok: false, error: paymentError.message }, 400);
paymentId = payment.id;
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
"license_type",
"license_fee",
"status",
"quote_base",
"agreed_total",
"quote_sent",
"client_approved_quote",
"payment_plan",
"initial_paid",
"initial_paid_at",
"preview_presented",
"preview_presented_at",
"final_approved",
"final_approved_at",
"final_paid",
"final_paid_at",
"final_artwork_path",
"delivery_at",
"terms_accepted",
"metadata",
]);

if (Object.keys(values).length === 0) {
return respond({ ok: false, error: "No permitted fields supplied." }, 400);
}

values.updated_at = new Date().toISOString();

const { data, error } = await supabase
.from("custom_orders")
.update(values)
.eq("id", body.id)
.select()
.maybeSingle();

if (error) return respond({ ok: false, error: error.message }, 400);
if (!data) return respond({ ok: false, error: "Custom order not found." }, 404);

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

case "update-adopt":
return await updateAdopt(body);

case "confirm-purchase-payment":
return await confirmPurchasePayment(body);

case "update-purchase-request":
return await updatePurchaseRequest(body);

case "create-final-artwork-upload":
return await createFinalArtworkUpload(body);

case "confirm-custom-payment":
return await confirmCustomPayment(body);

case "add-custom-update":
return await addCustomUpdate(body);

case "update-custom-order":
return await updateCustomOrder(body);

case "confirm-payment":
return await callTransaction(
"admin_confirm_payment",
String(body.payment_id ?? ""),
"p_payment_id",
);

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
