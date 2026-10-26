// age10: turns an attendee's photo into an AI "age 10" portrait for the
// Bi-Annual Child & Adolescent Mixer profile-frame page.
// POST multipart/form-data: image (file), code (event code), consent ("yes")
// Returns JSON { image: "data:image/png;base64,..." } or { error, message }.

const EVENT_CODE = (Deno.env.get("EVENT_CODE") ?? "MIXER1203").trim().toUpperCase();
const MODEL = Deno.env.get("OPENAI_IMAGE_MODEL") ?? "gpt-image-1.5";
const QUALITY = Deno.env.get("OPENAI_IMAGE_QUALITY") ?? "high";
const MAX_BYTES = 8 * 1024 * 1024;
const PER_IP_PER_HOUR = 6;
const DAY_CAP = Number(Deno.env.get("AGE10_DAY_CAP") ?? "300");

const PROMPT =
  "Using the photo provided, create a realistic portrait of this same person at about 10 years old. " +
  "Keep them clearly recognizable: same face shape, eyes, smile, skin tone and hair texture. " +
  "Do not change their skin tone or ethnicity. School picture day style, soft studio lighting, " +
  "plain light gray background. Frame from the chest up, centered, with space around the head. " +
  "One person only, square image, photorealistic, no text.";

const cors = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

async function sha256(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// Atomic usage check in Postgres: caps total images per 24 hours and per IP per hour.
async function claimSlot(ip: string): Promise<string> {
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return "ok";
  const res = await fetch(`${url}/rest/v1/rpc/claim_age10_slot`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_ip_hash: await sha256("mixer:" + ip), p_day_cap: DAY_CAP, p_ip_hour_cap: PER_IP_PER_HOUR }),
  });
  if (!res.ok) { console.error("claim failed", res.status, await res.text()); return "ok"; }
  return String(await res.json());
}

function reply(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

async function callOpenAI(key: string, image: File, fidelity: boolean) {
  const fd = new FormData();
  fd.append("model", MODEL);
  fd.append("image", image, image.name || "photo.jpg");
  fd.append("prompt", PROMPT);
  fd.append("size", "1024x1024");
  fd.append("quality", QUALITY);
  fd.append("n", "1");
  if (fidelity) fd.append("input_fidelity", "high");
  return await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: fd,
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { error: "method", message: "Use POST." });

  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) return reply(503, { error: "not_configured", message: "The age-10 step isn't switched on yet." });

  let form: FormData;
  try { form = await req.formData(); } catch { return reply(400, { error: "bad_request", message: "Send the photo as a file upload." }); }

  const code = String(form.get("code") ?? "").trim().toUpperCase();
  if (code !== EVENT_CODE) return reply(403, { error: "bad_code", message: "Please reload the page and try again." });
  if (String(form.get("consent") ?? "") !== "yes") return reply(400, { error: "consent", message: "Please agree to the photo note first." });

  const image = form.get("image");
  if (!(image instanceof File)) return reply(400, { error: "no_image", message: "Add a photo first." });
  if (!/^image\/(jpeg|png|webp)$/.test(image.type)) return reply(415, { error: "type", message: "Use a JPG, PNG or WebP photo." });
  if (image.size > MAX_BYTES) return reply(413, { error: "size", message: "That photo is too large. Try one under 8 MB." });

  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  const slot = await claimSlot(ip);
  if (slot === "ip_cap") return reply(429, { error: "rate_limited", message: "You've made a few already. Try again in an hour." });
  if (slot === "day_cap") return reply(429, { error: "day_cap", message: "We've hit today's limit for age-10 photos. Try again tomorrow, or use your photo as is." });

  try {
    let res = await callOpenAI(key, image, true);
    if (res.status === 400) {
      const t = await res.clone().text();
      if (/input_fidelity/i.test(t)) res = await callOpenAI(key, image, false);
    }
    const data = await res.json();
    if (!res.ok) {
      const msg = String(data?.error?.message ?? "");
      if (/safety|moderation|policy/i.test(msg)) return reply(422, { error: "declined", message: "The AI couldn't use that photo. Try a clear, front-facing photo of just you." });
      console.error("openai error", res.status, msg);
      return reply(502, { error: "upstream", message: "The image service is busy. Try again in a minute." });
    }
    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) return reply(502, { error: "empty", message: "No image came back. Try again." });
    return reply(200, { image: `data:image/png;base64,${b64}` });
  } catch (e) {
    console.error(e);
    return reply(500, { error: "server", message: "Something went wrong. Try again." });
  }
});
