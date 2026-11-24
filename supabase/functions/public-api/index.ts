// Lady K ★ Fih AdoptShop — secure public request intake
// Deploy as Supabase Edge Function: public-api
// Required secrets: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (platform-provided).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const clean = (v: FormDataEntryValue | null, max = 10000) =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

function escapeTelegramHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  })[char]!);
}

async function notifyTelegram(message: string, client: any, category: "custom_request" | "purchase_request"): Promise<void> {
  const { data: preferenceRow, error: preferenceError } = await client
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


async function publicRequestIpHash(req: Request, serviceKey: string): Promise<string> {
  const forwarded = req.headers.get("x-forwarded-for");
  const forwardedLast = forwarded?.split(",").map((part) => part.trim()).filter(Boolean).at(-1);
  const ip = req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-real-ip") ||
    forwardedLast || "unknown";
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(serviceKey + ":" + ip),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  try {
    const url = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !serviceKey) throw new Error("Server configuration is incomplete.");

    const supabase = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const contentType = req.headers.get("content-type") || "";
    const requestLength = Number(req.headers.get("content-length") || 0);
    const isMultipart = contentType.includes("multipart/form-data");
    if (requestLength > (isMultipart ? 45 : 0.25) * 1024 * 1024) {
      return json({ ok: false, error: "The request is larger than the allowed upload limit." }, 413);
    }
    let action = "";
    let payload: Record<string, unknown> = {};
    let files: File[] = [];

    if (isMultipart) {
      const form = await req.formData();
      action = clean(form.get("action"), 40);
      try { payload = JSON.parse(clean(form.get("payload"), 60000)); }
      catch { return json({ ok: false, error: "Invalid request data." }, 400); }
      files = form.getAll("references").filter((x): x is File => x instanceof File);
    } else {
      const body = await req.json();
      action = String(body?.action || "");
      payload = body?.payload || {};
    }

    const { data: visibilityRow, error: visibilityError } = await supabase
      .from("shop_settings")
      .select("setting_value")
      .eq("setting_key", "store_visibility")
      .maybeSingle();
    if (visibilityError) throw visibilityError;
    const allowedVisibility = ["Public", "Temporarily Closed", "Hidden from Public"];
    const storeVisibility = allowedVisibility.includes(String(visibilityRow?.setting_value))
      ? String(visibilityRow?.setting_value)
      : "Temporarily Closed";

    const fullName = String(payload.full_name || "").trim();
    const email = String(payload.email || "").trim();
    const discord = String(payload.discord || "").trim();

    if (action !== "catalog") {
      if (!fullName || fullName.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
          email.length > 254 || !discord || discord.length > 100 || payload.terms_accepted !== true) {
        return json({ ok: false, error: "Check the required contact details and accept the Terms of Service." }, 400);
      }
    }

    if (action === "catalog") {
      if (storeVisibility === "Hidden from Public") {
        return json({ ok: true, adopts: [], customArchive: [], storeVisibility });
      }
      const { data: activeRows, error: activeCatalogError } = await supabase
        .from("adopts")
        .select("*")
        .in("status", ["Available", "Reserved"])
        .eq("public_visible", true)
        .order("created_at", { ascending: false });
      if (activeCatalogError) throw activeCatalogError;
      const { data: soldRows, error: soldCatalogError } = await supabase
        .from("adopts")
        .select("*")
        .eq("status", "Sold")
        .eq("archive_visible", true)
        .order("created_at", { ascending: false });
      if (soldCatalogError) throw soldCatalogError;
      const rows = [...(activeRows || []), ...(soldRows || [])]
        .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
      const items = [];
      for (const row of rows || []) {
        const { data: imageRows, error: imageError } = await supabase
          .from("adopt_images")
          .select("storage_path,original_filename,sort_order,is_main")
          .eq("adopt_id", row.id)
          .order("sort_order", { ascending: true });
        if (imageError) throw imageError;
        const images = [];
        for (const image of imageRows || []) {
          const { data: signed, error: signError } = await supabase.storage
            .from("adoptables").createSignedUrl(image.storage_path, 1800);
          if (signError) continue;
          images.push({
            name: image.original_filename || "Artwork",
            url: signed.signedUrl,
            sortOrder: image.sort_order,
            isMain: image.is_main,
          });
        }
        const publicFileLabels = (Array.isArray(row.files) ? row.files : [])
          .map((item: unknown) => typeof item === "string"
            ? item.trim()
            : item && typeof item === "object" && "name" in item && typeof (item as { name?: unknown }).name === "string"
              ? (item as { name: string }).name.trim()
              : "")
          .filter((label: string) => label.length > 0 && label.length <= 120 &&
            !/^(https?:\/\/|www\.|data:|blob:)/i.test(label) &&
            !label.includes("/") && !label.includes("\\"))
          .slice(0, 30);
        items.push({
          id: row.adopt_code, name: row.name, category: row.category || "Other",
          price: Number(row.price || 0), status: row.status, publicVisible: row.public_visible,
          archiveVisible: row.archive_visible, symbol: row.symbol || "✧",
          description: row.description || "", files: publicFileLabels, tags: row.tags || [],
          featured: !!row.featured, images, mainImage: Math.max(0, images.findIndex((x) => x.isMain)),
        });
      }
      const { data: completedCustoms, error: customArchiveError } = await supabase
        .from("custom_orders")
        .select("order_code, character_name, category, final_artwork_path, delivery_at, created_at")
        .eq("status", "Completed")
        .not("final_artwork_path", "is", null)
        .order("delivery_at", { ascending: false, nullsFirst: false });
      if (customArchiveError) throw customArchiveError;
      const customArchive = [];
      for (const order of completedCustoms || []) {
        if (!order.final_artwork_path) continue;
        const { data: signed, error: signError } = await supabase.storage.from("private-deliveries").createSignedUrl(order.final_artwork_path, 86400);
        if (signError || !signed?.signedUrl) continue;
        customArchive.push({ id: order.order_code, name: order.character_name || "Custom character", category: order.category || "Custom design", imageUrl: signed.signedUrl, completedAt: order.delivery_at || order.created_at });
      }
      return json({ ok: true, adopts: items, customArchive, storeVisibility });
    }

    if ((action === "purchase" || action === "custom") && storeVisibility !== "Public") {
      return json({
        ok: false,
        error: storeVisibility === "Temporarily Closed"
          ? "The shop is temporarily closed and is not accepting requests."
          : "The shop is currently unavailable and is not accepting requests.",
      }, 409);
    }

    if (action === "purchase" || action === "custom") {
      const ipHash = await publicRequestIpHash(req, serviceKey);
      const { data: allowed, error: rateLimitError } = await supabase.rpc(
        "public_register_request_attempt",
        { p_ip_hash: ipHash, p_limit: 10, p_window_seconds: 3600 },
      );
      if (rateLimitError) {
        console.error("[public-api] Request rate-limit check failed:", rateLimitError.message);
        return json({ ok: false, error: "Request service temporarily unavailable. Please try again later." }, 503);
      }
      if (allowed !== true) {
        return new Response(JSON.stringify({
          ok: false,
          error: "Too many requests from this network. Please try again later.",
        }), {
          status: 429,
          headers: { ...cors, "Content-Type": "application/json", "Retry-After": "3600" },
        });
      }
    }

    if (action === "purchase") {
      const adoptCode = String(payload.adopt_code || "").trim();
      const license = String(payload.license_type || "");
      if (!adoptCode || adoptCode.length > 80 ||
          !["Personal Use", "Commercial Use", "Full Rights Transfer"].includes(license)) {
        return json({ ok: false, error: "Invalid adopt or license selection." }, 400);
      }
      const { data, error } = await supabase.rpc("public_create_purchase_request", {
        p_payload: {
          ...payload, full_name: fullName, email, discord,
          adopt_code: adoptCode, license_type: license, terms_accepted: true,
        },
      });
      if (error) throw error;
      const request = data && typeof data === "object" ? data as Record<string, unknown> : {};
      await notifyTelegram(
        "🛍️ <b>New purchase request</b>\n" +
        "Request: <code>" + escapeTelegramHtml(request.request_code || "New request") + "</code>\n" +
        "Adopt: " + escapeTelegramHtml(adoptCode) + "\n" +
        "License: " + escapeTelegramHtml(license),
        supabase,
        "purchase_request",
      );
      return json({ ok: true, request: data });
    }

    if (action === "custom") {
      const concept = String(payload.concept || "").trim();
      const license = String(payload.license_type || "");
      const fieldLimits: Record<string, number> = {
        character_name: 120, category: 80, concept: 12000, appearance: 5000,
        colors: 2000, clothing: 5000, theme: 2000, instructions: 12000, links: 5000,
      };
      for (const [field, limit] of Object.entries(fieldLimits)) {
        const value = payload[field];
        if (value !== undefined && value !== null && typeof value !== "string") {
          return json({ ok: false, error: "Custom Adopt text fields must contain plain text." }, 400);
        }
        if (typeof value === "string" && value.length > limit) {
          return json({ ok: false, error: `The ${field.replaceAll("_", " ")} field exceeds its ${limit}-character limit.` }, 400);
        }
        if (typeof value === "string") payload[field] = value.trim();
      }
      const links = String(payload.links || "").split(/\r?\n/).map((link) => link.trim()).filter(Boolean);
      if (links.some((link) => {
        try { return !["http:", "https:"].includes(new URL(link).protocol); }
        catch { return true; }
      })) {
        return json({ ok: false, error: "External references must be valid HTTP or HTTPS links." }, 400);
      }
      if (!concept || concept.length > 12000 ||
          !["Personal Use", "Commercial Use", "Full Rights Transfer"].includes(license) ||
          files.length > 8) {
        return json({ ok: false, error: "Check the Custom Adopt details and reference image limit." }, 400);
      }
      const stored: Array<Record<string, unknown>> = [];
      try {
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          if (!/^image\/(jpeg|png|webp|gif|avif)$/.test(file.type.toLowerCase()) || file.size <= 0 || file.size > 5 * 1024 * 1024) {
            throw new Error("Each reference must be a JPG, PNG, WebP, GIF or AVIF image no larger than 5 MB.");
          }
          const ext = (file.name.split(".").pop() || "img").replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "img";
          const path = `custom-requests/${crypto.randomUUID()}/${String(i + 1).padStart(2, "0")}.${ext}`;
          const { error: uploadError } = await supabase.storage.from("custom-references").upload(path, file, {
            contentType: file.type, upsert: false,
          });
          if (uploadError) throw uploadError;
          stored.push({
            storage_path: path, original_filename: file.name.slice(0, 255),
            mime_type: file.type, file_size: file.size, sort_order: i,
          });
        }
      } catch (uploadError) {
        if (stored.length) await supabase.storage.from("custom-references").remove(stored.map((f) => String(f.storage_path)));
        throw uploadError;
      }
      console.info("[public-api] Creating Custom request; reference count:", stored.length);
      const { data, error } = await supabase.rpc("public_create_custom_order", {
        p_payload: {
          ...payload, full_name: fullName, email, discord,
          license_type: license, terms_accepted: true,
        },
        p_files: stored,
      });
      if (error) {
        for (const f of stored) await supabase.storage.from("custom-references").remove([String(f.storage_path)]);
        throw error;
      }
      const request = data && typeof data === "object" ? data as Record<string, unknown> : {};
      console.info("[public-api] Custom request saved:", request.order_code || "record created");
      const licenseFee = license === "Commercial Use" ? 25 : license === "Full Rights Transfer" ? 75 : 0;
      const telegramField = (label: string, value: unknown, maxLength: number) => {
        const normalized = typeof value === "string" ? value.replace(/\\s+/g, " ").trim() : "";
        return normalized ? label + ": " + escapeTelegramHtml(normalized.slice(0, maxLength)) : "";
      };
      const customDetails = [
        telegramField("Concept", payload.concept, 550),
        telegramField("Appearance", payload.appearance, 300),
        telegramField("Colors", payload.colors, 180),
        telegramField("Clothing", payload.clothing, 300),
        telegramField("Theme", payload.theme, 180),
        telegramField("Instructions", payload.instructions, 450),
        telegramField("External links", payload.links, 450),
      ].filter(Boolean);
      await notifyTelegram(
        [
          "🛍️ <b>New Custom request</b>",
          "Request: <code>" + escapeTelegramHtml(request.order_code || request.id || "New request") + "</code>",
          "Client: " + escapeTelegramHtml(fullName),
          "Email: " + escapeTelegramHtml(email),
          "Discord: " + escapeTelegramHtml(discord),
          "Character: " + escapeTelegramHtml(payload.character_name || "Not specified"),
          "Category: " + escapeTelegramHtml(payload.category || "Other"),
          "License: " + escapeTelegramHtml(license),
          "License fee: <b>$" + licenseFee.toFixed(2) + " USD</b>",
          ...customDetails,
          "References uploaded: " + stored.length,
        ].join("\\n"),
        supabase,
        "custom_request",
      );
      return json({ ok: true, request: data });
    }

    return json({ ok: false, error: "Unknown request action." }, 400);
  } catch (error) {
    console.error("[public-api]", error);
    return json({ ok: false, error: "The request could not be completed. Please try again later." }, 500);
  }
});
