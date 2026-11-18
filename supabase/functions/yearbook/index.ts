// yearbook: "Sign My Yearbook" notes for the Class of 2026 yearbook.
// POST JSON { action: "submit", name (first name), organization, color, hex, style, png (data URL), consent }
//   -> saves a transparent 1800x1080 PNG to the private "yearbook-notes" bucket and a row in yearbook_notes.
// POST JSON { action: "read", image (JPEG data URL of a handwritten word or two), context } -> { text }: reads the handwriting
//   with OpenAI so the page can redraw it in a handwriting font. The image is not stored.
// POST JSON { action: "list", pass }            -> all notes with short-lived signed image links (admin).
// POST JSON { action: "remove", pass, id }      -> deletes one note (admin).
// Nothing in the bucket or table is readable without this function.

const BUCKET = "yearbook-notes";
const W = 1800, H = 1080;
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_NOTES = 60; // safety cap; the book needs 10
const COLORS = new Set(["blue", "magenta", "teal", "purple", "orange-red", "navy"]);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const URL_ = Deno.env.get("SUPABASE_URL")!, KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const auth = { apikey: KEY, Authorization: `Bearer ${KEY}` };

function reply(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
const clean = (v: unknown, n: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");
function slug(name: string) {
  const s = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "guest";
}
async function sha256(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function rest(path: string, init: RequestInit = {}) {
  return fetch(`${URL_}/rest/v1/${path}`, { ...init, headers: { ...auth, "Content-Type": "application/json", ...(init.headers ?? {}) } });
}
async function isAdmin(pass: unknown) {
  if (typeof pass !== "string" || !pass) return false;
  const res = await rest("yearbook_admin?id=eq.1&select=pass_hash");
  if (!res.ok) return false;
  const rows = await res.json();
  return rows.length === 1 && rows[0].pass_hash === (await sha256("caam-yearbook:" + pass));
}

async function submit(body: Record<string, unknown>) {
  const name = clean(body.name, 80), org = clean(body.organization, 100), color = clean(body.color, 20), hex = clean(body.hex, 9);
  if (!name || !org) return reply(400, { error: "missing", message: "Add your first name and organization." });
  const style = clean(body.style, 40) || "Handwritten";
  if (!COLORS.has(color) || !/^#[0-9a-fA-F]{6}$/.test(hex)) return reply(400, { error: "color", message: "Pick a pen color." });
  if (body.consent !== true) return reply(400, { error: "consent", message: "Consent is required." });
  const m = typeof body.png === "string" ? body.png.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/) : null;
  if (!m) return reply(400, { error: "image", message: "The note didn't come through. Try sending again." });
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0)); } catch { return reply(400, { error: "image", message: "The note didn't come through. Try sending again." }); }
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  const dv = new DataView(bytes.buffer);
  if (bytes.length < 100 || bytes.length > MAX_BYTES || !sig.every((b, i) => bytes[i] === b) || dv.getUint32(16) !== W || dv.getUint32(20) !== H) {
    return reply(400, { error: "image", message: "The note didn't come through. Try sending again." });
  }

  const countRes = await rest("yearbook_notes?select=file_name");
  const existing: { file_name: string }[] = countRes.ok ? await countRes.json() : [];
  if (existing.length >= MAX_NOTES) return reply(429, { error: "full", message: "The yearbook pages are full. Thank you!" });
  const taken = new Set(existing.map((r) => r.file_name));
  const base = "note-" + slug(name);
  let file = base + ".png";
  for (let i = 2; taken.has(file); i++) file = `${base}-${i}.png`;

  const up = await fetch(`${URL_}/storage/v1/object/${BUCKET}/${file}`, {
    method: "POST", headers: { ...auth, "Content-Type": "image/png", "x-upsert": "false" }, body: bytes,
  });
  if (!up.ok) { console.error("upload failed", up.status, await up.text()); return reply(500, { error: "save", message: "We couldn't save your note. Try sending again." }); }
  const ins = await rest("yearbook_notes", {
    method: "POST", headers: { Prefer: "return=representation" },
    body: JSON.stringify({ full_name: name, organization: org, pen_color: color, pen_hex: hex.toUpperCase(), file_name: file, note_style: style, consent: true, device: clean(body.device, 10) || null }),
  });
  if (!ins.ok) {
    console.error("insert failed", ins.status, await ins.text());
    await fetch(`${URL_}/storage/v1/object/${BUCKET}/${file}`, { method: "DELETE", headers: auth });
    return reply(500, { error: "save", message: "We couldn't save your note. Try sending again." });
  }
  const row = (await ins.json())[0];
  return reply(200, { ok: true, file_name: file, submitted_at: row.submitted_at });
}

// ---- handwriting -> text
const READ_MODELS = [Deno.env.get("OPENAI_READ_MODEL") ?? "gpt-4o-mini", "gpt-4.1-mini", "gpt-4o"];
const READ_DAY_CAP = 2500; // each word is one read
async function read(body: Record<string, unknown>) {
  const key = Deno.env.get("OPENAI_API_KEY");
  const image = typeof body.image === "string" && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(body.image) ? body.image : "";
  if (!key || !image || image.length > 600_000) return reply(400, { error: "image", message: "We couldn't read that. Try again, or type your note." });
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const used = await rest(`yearbook_reads?select=id&created_at=gt.${encodeURIComponent(since)}&limit=1`, { headers: { Prefer: "count=exact" } });
  if (Number((used.headers.get("content-range") ?? "/0").split("/")[1]) >= READ_DAY_CAP) return reply(429, { error: "busy", message: "That's busy right now. Type your note instead, or keep your handwriting." });
  await rest("yearbook_reads", { method: "POST", headers: { Prefer: "return=minimal" }, body: "{}" });
  const context = clean(body.context, 130).replace(/["\\]/g, "");
  const prompt = "This image shows a word or a few words handwritten with a finger on a phone, part of a short yearbook note. Transcribe exactly what is written: same words, spelling, capital letters and punctuation, no corrections, nothing added. " +
    (context ? `The note so far reads: "${context}". Use that only to help read unclear letters; do not repeat it. ` : "") +
    "Reply with only the transcribed text on one line. If nothing is legible, reply with exactly: UNREADABLE";
  for (const model of READ_MODELS) {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 40, temperature: 0, messages: [{ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: image, detail: "high" } }] }] }),
    });
    if (!res.ok) { console.error("read failed", model, res.status, (await res.text()).slice(0, 300)); if (res.status === 404 || res.status === 400) continue; break; }
    const data = await res.json();
    let text = clean(data?.choices?.[0]?.message?.content, 200).replace(/^["“]|["”]$/g, "");
    if (!text || /^UNREADABLE\.?$/i.test(text)) return reply(200, { ok: true, text: "" });
    if (text.length > 60) text = text.slice(0, 60).replace(/\s+\S*$/, "");
    return reply(200, { ok: true, text });
  }
  return reply(502, { error: "read", message: "We couldn't read that right now. Type your note instead, or keep your handwriting." });
}

async function list() {
  const res = await rest("yearbook_notes?select=id,submitted_at,full_name,organization,pen_color,pen_hex,note_style,file_name,device&order=submitted_at.asc");
  if (!res.ok) return reply(500, { error: "list" });
  const rows = await res.json();
  let signed: { path: string; signedURL?: string }[] = [];
  if (rows.length) {
    const s = await fetch(`${URL_}/storage/v1/object/sign/${BUCKET}`, {
      method: "POST", headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ expiresIn: 3600, paths: rows.map((r: { file_name: string }) => r.file_name) }),
    });
    if (s.ok) signed = await s.json();
  }
  const byPath = new Map(signed.map((x) => [x.path, x.signedURL ? `${URL_}/storage/v1${x.signedURL}` : null]));
  return reply(200, { notes: rows.map((r: { file_name: string }) => ({ ...r, url: byPath.get(r.file_name) ?? null })) });
}

async function remove(id: unknown) {
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)) return reply(400, { error: "id" });
  const res = await rest(`yearbook_notes?id=eq.${id}&select=file_name`);
  const rows = res.ok ? await res.json() : [];
  if (!rows.length) return reply(404, { error: "not_found" });
  await fetch(`${URL_}/storage/v1/object/${BUCKET}/${rows[0].file_name}`, { method: "DELETE", headers: auth });
  await rest(`yearbook_notes?id=eq.${id}`, { method: "DELETE" });
  return reply(200, { ok: true });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { error: "method" });
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(await req.text()); } catch { return reply(400, { error: "json" }); }
  try {
    if (body.action === "submit") return await submit(body);
    if (body.action === "read") return await read(body);
    if (body.action === "list" || body.action === "remove") {
      if (!(await isAdmin(body.pass))) return reply(401, { error: "pass", message: "That passcode isn't right." });
      return body.action === "list" ? await list() : await remove(body.id);
    }
    return reply(400, { error: "action" });
  } catch (e) {
    console.error(e);
    return reply(500, { error: "server", message: "Something went wrong. Try again." });
  }
});
