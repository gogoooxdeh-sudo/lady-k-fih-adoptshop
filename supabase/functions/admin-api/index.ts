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

const { data, error, count } = await query
.order("created_at", { ascending: false })
.range(from, to);

if (error) {
return respond({ ok: false, error: error.message }, 400);
}

return respond({
ok: true,
data: data ?? [],
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
