// Lady K ★ Fih AdoptShop — secure public request intake
// Deploy as Supabase Edge Function: public-api
// Required secrets: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (platform-provided).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const clean = (v: FormDataEntryValue | null, max = 10000) =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

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
    let action = "";
    let payload: Record<string, unknown> = {};
    let files: File[] = [];

    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      action = clean(form.get("action"), 40);
      try { payload = JSON.parse(clean(form.get("payload"), 30000)); }
      catch { return json({ ok: false, error: "Invalid request data." }, 400); }
      files = form.getAll("references").filter((x): x is File => x instanceof File);
    } else {
      const body = await req.json();
      action = String(body?.action || "");
      payload = body?.payload || {};
    }

    if (action !== "catalog") {
    const fullName = String(payload.full_name || "").trim();
    const email = String(payload.email || "").trim();
    const discord = String(payload.discord || "").trim();
    if (!fullName || fullName.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
        email.length > 254 || !discord || discord.length > 100 || payload.terms_accepted !== true) {
      return json({ ok: false, error: "Check the required contact details and accept the Terms of Service." }, 400);
    }

    }

    if (action === "catalog") {
      const { data: rows, error: catalogError } = await supabase
        .from("adopts")
        .select("*")
        .or("and(status.eq.Available,public_visible.eq.true),and(status.eq.Reserved,public_visible.eq.true),and(status.eq.Sold,archive_visible.eq.true)")
        .order("created_at", { ascending: false });
      if (catalogError) throw catalogError;
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
        items.push({
          id: row.adopt_code, name: row.name, category: row.category || "Other",
          price: Number(row.price || 0), status: row.status, publicVisible: row.public_visible,
          archiveVisible: row.archive_visible, symbol: row.symbol || "✧",
          description: row.description || "", files: row.files || [], tags: row.tags || [],
          featured: !!row.featured, images, mainImage: Math.max(0, images.findIndex((x) => x.isMain)),
          databaseId: row.id,
        });
      }
      return json({ ok: true, adopts: items });
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
      return json({ ok: true, request: data });
    }

    if (action === "custom") {
      const concept = String(payload.concept || "").trim();
      const license = String(payload.license_type || "");
      if (!concept || concept.length > 12000 ||
          !["Personal Use", "Commercial Use", "Full Rights Transfer"].includes(license) ||
          files.length > 8) {
        return json({ ok: false, error: "Check the Custom Adopt details and reference image limit." }, 400);
      }
      const stored: Array<Record<string, unknown>> = [];
      try {
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          if (!file.type.startsWith("image/") || file.size <= 0 || file.size > 5 * 1024 * 1024) {
            throw new Error("Each reference must be an image no larger than 5 MB.");
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
      return json({ ok: true, request: data });
    }

    return json({ ok: false, error: "Unknown request action." }, 400);
  } catch (error) {
    console.error("[public-api]", error);
    const message = error instanceof Error ? error.message : "Request could not be submitted.";
    return json({ ok: false, error: message }, 400);
  }
});
