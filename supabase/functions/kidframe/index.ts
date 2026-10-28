// kidframe: records anonymous page events for the mixer frame page.
// POST JSON { event, platform?, version?, source?, referrer?, visitor? } -> 204
const EVENTS = new Set(["view", "photo_added", "kid_made", "kid_failed", "download"]);
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const clip = (v: unknown, n = 60) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return new Response(null, { status: 405, headers: cors });
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(await req.text()); } catch { return new Response(null, { status: 400, headers: cors }); }
  const event = String(body.event ?? "");
  if (!EVENTS.has(event)) return new Response(null, { status: 400, headers: cors });
  const row = {
    event,
    platform: clip(body.platform, 20),
    version: clip(body.version, 10),
    source: clip(body.source, 40),
    referrer: clip(body.referrer, 80),
    visitor: clip(body.visitor, 40),
  };
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (url && key) {
    const res = await fetch(`${url}/rest/v1/page_events`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify(row),
    });
    if (!res.ok) console.error("insert failed", res.status, await res.text());
  }
  return new Response(null, { status: 204, headers: cors });
});
