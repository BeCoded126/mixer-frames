// yearbook: "Sign My Yearbook" notes for the Class of 2026 yearbook.
// POST JSON { action: "submit", name, organization, color, hex, png (data URL), consent }
//   -> saves a transparent 1800x1080 PNG to the private "yearbook-notes" bucket and a row in yearbook_notes.
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
  if (name.length < 2 || !org) return reply(400, { error: "missing", message: "Add your full name and organization." });
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
    body: JSON.stringify({ full_name: name, organization: org, pen_color: color, pen_hex: hex.toUpperCase(), file_name: file, consent: true, device: clean(body.device, 10) || null }),
  });
  if (!ins.ok) {
    console.error("insert failed", ins.status, await ins.text());
    await fetch(`${URL_}/storage/v1/object/${BUCKET}/${file}`, { method: "DELETE", headers: auth });
    return reply(500, { error: "save", message: "We couldn't save your note. Try sending again." });
  }
  const row = (await ins.json())[0];
  return reply(200, { ok: true, file_name: file, submitted_at: row.submitted_at });
}

async function list() {
  const res = await rest("yearbook_notes?select=id,submitted_at,full_name,organization,pen_color,pen_hex,file_name,device&order=submitted_at.asc");
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
