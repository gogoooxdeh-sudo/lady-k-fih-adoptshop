import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ADMIN_PANEL_PASSWORD = Deno.env.get("ADMIN_PANEL_PASSWORD")!;
const ADMIN_SESSION_SECRET = Deno.env.get("ADMIN_SESSION_SECRET")!;

const SESSION_DURATION_SECONDS = 2 * 60 * 60;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
auth: {
autoRefreshToken: false,
persistSession: false,
},
});

const corsHeaders = {
"Access-Control-Allow-Origin": "*",
"Access-Control-Allow-Headers":
"authorization, x-client-info, apikey, content-type",
"Access-Control-Allow-Methods": "POST, OPTIONS",
"Content-Type": "application/json",
};

type SessionPayload = {
role: "admin";
sid: string;
iat: number;
exp: number;
nonce: string;
};

function response(data: unknown, status = 200) {
return new Response(JSON.stringify(data), {
status,
headers: corsHeaders,
});
}

function base64UrlEncode(bytes: Uint8Array): string {
let binary = "";
for (const byte of bytes) binary += String.fromCharCode(byte);

return btoa(binary)
.replace(/\+/g, "-")
.replace(/\//g, "_")
.replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array {
const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
const binary = atob(normalized);
return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function sha256(value: string): Promise<string> {
const digest = await crypto.subtle.digest(
"SHA-256",
new TextEncoder().encode(value),
);
return base64UrlEncode(new Uint8Array(digest));
}

async function hmacSignature(value: string): Promise<string> {
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

return base64UrlEncode(new Uint8Array(signature));
}

function constantTimeEqual(a: string, b: string): boolean {
const left = new TextEncoder().encode(a);
const right = new TextEncoder().encode(b);

if (left.length !== right.length) return false;

let difference = 0;
for (let i = 0; i < left.length; i++) {
difference |= left[i] ^ right[i];
}

return difference === 0;
}

async function createToken(sid: string): Promise<{
token: string;
expiresAt: string;
}> {
const now = Math.floor(Date.now() / 1000);

const payload: SessionPayload = {
role: "admin",
sid,
iat: now,
exp: now + SESSION_DURATION_SECONDS,
nonce: crypto.randomUUID(),
};

const encodedPayload = base64UrlEncode(
new TextEncoder().encode(JSON.stringify(payload)),
);

const signature = await hmacSignature(encodedPayload);

return {
token: `${encodedPayload}.${signature}`,
expiresAt: new Date(payload.exp * 1000).toISOString(),
};
}

async function verifyToken(token: string): Promise<SessionPayload | null> {
try {
const parts = token.split(".");
if (parts.length !== 2) return null;

const [encodedPayload, suppliedSignature] = parts;
const expectedSignature = await hmacSignature(encodedPayload);

if (!constantTimeEqual(suppliedSignature, expectedSignature)) {
return null;
}

const payload = JSON.parse(
new TextDecoder().decode(base64UrlDecode(encodedPayload)),
) as SessionPayload;

const now = Math.floor(Date.now() / 1000);

if (
payload.role !== "admin" ||
typeof payload.sid !== "string" ||
typeof payload.exp !== "number" ||
typeof payload.iat !== "number" ||
payload.exp <= now ||
payload.iat > now + 60
) {
return null;
}

return payload;
} catch {
return null;
}
}

function getClientIp(req: Request): string {
const forwarded = req.headers.get("x-forwarded-for");
if (forwarded) return forwarded.split(",")[0].trim();

return req.headers.get("cf-connecting-ip") || "unknown";
}

async function getIpHash(req: Request): Promise<string> {
return await sha256(
`${ADMIN_SESSION_SECRET}:${getClientIp(req)}`,
);
}

async function loginIsBlocked(ipHash: string): Promise<boolean> {
const { data, error } = await supabase.rpc(
"admin_login_is_blocked",
{ p_ip_hash: ipHash },
);

if (error) throw error;

if (typeof data === "boolean") return data;

if (data && typeof data === "object") {
if ("blocked" in data) return Boolean(data.blocked);
if ("is_blocked" in data) return Boolean(data.is_blocked);
}

return false;
}

async function registerFailure(ipHash: string): Promise<void> {
const { error } = await supabase.rpc(
"admin_login_register_failure",
{ p_ip_hash: ipHash },
);

if (error) throw error;
}

async function resetFailures(ipHash: string): Promise<void> {
const { error } = await supabase.rpc(
"admin_login_reset",
{ p_ip_hash: ipHash },
);

if (error) throw error;
}

async function login(req: Request, body: Record<string, unknown>) {
const password =
typeof body.password === "string" ? body.password : "";

if (!password || password.length > 1024) {
return response({ ok: false, error: "Invalid credentials." }, 401);
}

const ipHash = await getIpHash(req);

let blocked: boolean;

try {
blocked = await loginIsBlocked(ipHash);
} catch {
return response(
{ ok: false, error: "Authentication service unavailable." },
503,
);
}

if (blocked) {
return response(
{
ok: false,
error: "Too many failed attempts. Try again in 15 minutes.",
},
429,
);
}

const suppliedHash = await sha256(password);
const expectedHash = await sha256(ADMIN_PANEL_PASSWORD);

if (!constantTimeEqual(suppliedHash, expectedHash)) {
try {
await registerFailure(ipHash);
} catch {
return response(
{ ok: false, error: "Authentication service unavailable." },
503,
);
}

return response({ ok: false, error: "Invalid credentials." }, 401);
}

try {
await resetFailures(ipHash);

const sid = crypto.randomUUID();
const { token, expiresAt } = await createToken(sid);
const tokenHash = await sha256(token);

const { error } = await supabase
.from("admin_sessions")
.insert({
id: sid,
token_hash: tokenHash,
created_at: new Date().toISOString(),
expires_at: expiresAt,
revoked_at: null,
last_seen_at: new Date().toISOString(),
});

if (error) throw error;

return response({
ok: true,
token,
expiresAt,
});
} catch {
return response(
{ ok: false, error: "Could not create admin session." },
500,
);
}
}

async function verifySession(body: Record<string, unknown>) {
const token = typeof body.token === "string" ? body.token : "";

if (!token) {
return response({ ok: false, authenticated: false }, 401);
}

const payload = await verifyToken(token);

if (!payload) {
return response({ ok: false, authenticated: false }, 401);
}

const tokenHash = await sha256(token);

const { data: session, error } = await supabase
.from("admin_sessions")
.select("id, expires_at, revoked_at")
.eq("id", payload.sid)
.eq("token_hash", tokenHash)
.is("revoked_at", null)
.gt("expires_at", new Date().toISOString())
.maybeSingle();

if (error || !session) {
return response({ ok: false, authenticated: false }, 401);
}

await supabase
.from("admin_sessions")
.update({ last_seen_at: new Date().toISOString() })
.eq("id", payload.sid)
.eq("token_hash", tokenHash)
.is("revoked_at", null);

return response({
ok: true,
authenticated: true,
expiresAt: session.expires_at,
});
}

async function logout(body: Record<string, unknown>) {
const token = typeof body.token === "string" ? body.token : "";

if (!token) {
return response({ ok: false, error: "Missing session token." }, 400);
}

const payload = await verifyToken(token);

if (!payload) {
return response({ ok: false, error: "Invalid session." }, 401);
}

const tokenHash = await sha256(token);

const { error } = await supabase
.from("admin_sessions")
.update({ revoked_at: new Date().toISOString() })
.eq("id", payload.sid)
.eq("token_hash", tokenHash)
.is("revoked_at", null);

if (error) {
return response({ ok: false, error: "Could not revoke session." }, 500);
}

return response({ ok: true, loggedOut: true });
}

Deno.serve(async (req: Request) => {
if (req.method === "OPTIONS") {
return new Response("ok", { headers: corsHeaders });
}

if (req.method !== "POST") {
return response({ ok: false, error: "Method not allowed." }, 405);
}

if (
!SUPABASE_URL ||
!SERVICE_ROLE_KEY ||
!ADMIN_PANEL_PASSWORD ||
!ADMIN_SESSION_SECRET
) {
return response(
{ ok: false, error: "Server configuration is incomplete." },
500,
);
}

try {
const body = await req.json();

if (!body || typeof body !== "object" || Array.isArray(body)) {
return response({ ok: false, error: "Invalid request body." }, 400);
}

switch (body.action) {
case "login":
return await login(req, body);

case "verify":
return await verifySession(body);

case "logout":
return await logout(body);

default:
return response({ ok: false, error: "Unknown action." }, 400);
}
} catch {
return response({ ok: false, error: "Unexpected server error." }, 500);
}
});
