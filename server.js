import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { gzipSync } from "node:zlib";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { Anthropic } from "./lib/claude.js";
import { extractCall, reviseCall, draftFollowup, askPipeline, warmUp, engineName } from "./lib/extract.js";
import { workspace, isWorkspaceId, flush, pruneWorkspaces, toCsv } from "./lib/store.js";
import { syncToHubSpot } from "./lib/hubspot.js";
import { sampleCalls } from "./lib/samples.js";
import { allowAiCall } from "./lib/limits.js";
import { stats, buildProof, readProofSnapshot, writeProofSnapshot } from "./lib/proof.js";

const PORT = Number(process.env.PORT ?? 3000);
const MANUAL_MINUTES = Number(process.env.MANUAL_WRITEUP_MINUTES ?? 6);
// Public mode is for the hosted demo: every visitor gets a private sample workspace, usage is capped,
// HubSpot is off and the proof page shows the committed snapshot of the owner's real results.
const PUBLIC = process.env.PUBLIC_MODE === "1";
// Demo mode (npm run demo) runs on sample data, so resetting it is safe; real local data can never be reset.
const DEMO = process.env.DEMO_MODE === "1";
const HUBSPOT_TOKEN = PUBLIC ? "" : process.env.HUBSPOT_TOKEN;
const SENDER_NAME = process.env.SENDER_NAME || "";
const MAX_TEXT = 6000;

// Pages are read and compressed once at startup, then served from memory with an ETag.
const PAGES = {};
for (const [route, file] of [["/", "index.html"], ["/app", "app.html"], ["/proof", "proof.html"]]) {
  // Link previews need absolute image URLs; Render sets RENDER_EXTERNAL_URL, or set PUBLIC_URL yourself.
  const origin = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");
  const raw = Buffer.from((await readFile(path.join(import.meta.dirname, "public", file), "utf8")).replaceAll("__ORIGIN__", origin));
  PAGES[route] = { raw, gz: gzipSync(raw, { level: 9 }), etag: `"${createHash("sha1").update(raw).digest("base64url").slice(0, 16)}"` };
}
PAGES["/index.html"] = PAGES["/"];
PAGES["/app/"] = PAGES["/app"];
PAGES["/proof/"] = PAGES["/proof"];

// Screenshots, the tour video and the social image live in public/media (made by `npm run record:tour`).
const MEDIA_DIR = path.join(import.meta.dirname, "public", "media");
const MEDIA_TYPES = { ".webm": "video/webm", ".mp4": "video/mp4", ".jpg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml" };

async function serveMedia(req, res, name) {
  const type = MEDIA_TYPES[path.extname(name)];
  if (!type || name.includes("..") || name.includes("/")) return false;
  const file = path.join(MEDIA_DIR, name);
  let info;
  try { info = await stat(file); } catch { return false; }
  const headers = { "Content-Type": type, "Cache-Control": "public, max-age=3600", "Accept-Ranges": "bytes", "Last-Modified": info.mtime.toUTCString() };
  // Byte ranges let browsers seek in the video (Safari won't play video without them).
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  if (range) {
    const start = range[1] ? Number(range[1]) : Math.max(0, info.size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
    if (start > end || start >= info.size) {
      res.writeHead(416, { "Content-Range": `bytes */${info.size}` });
      res.end();
      return true;
    }
    res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${info.size}`, "Content-Length": end - start + 1 });
    createReadStream(file, { start, end }).pipe(res);
    return true;
  }
  res.writeHead(200, { ...headers, "Content-Length": info.size });
  createReadStream(file).pipe(res);
  return true;
}

const httpError = (status, message) => Object.assign(new Error(message), { status });

const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};

async function readBody(req) {
  let data = "";
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 1_000_000) throw httpError(413, "Request too large");
  }
  return data ? JSON.parse(data) : {};
}

function friendlyError(err) {
  if (err instanceof Anthropic.RateLimitError) return [429, "Claude is rate-limiting requests; try again in a moment."];
  if (err instanceof Anthropic.APIConnectionError) return [502, "Could not reach the Claude API. Check your connection."];
  if (err instanceof Anthropic.APIError) return [502, `Claude API error: ${err.message}`];
  if (err instanceof SyntaxError) return [400, "Invalid JSON."];
  return [err.status ?? 500, err.message];
}

const cookies = (req) => Object.fromEntries((req.headers.cookie ?? "").split(/;\s*/).filter(Boolean).map((c) => c.split("=").map(decodeURIComponent)));
const clientIp = (req) => (PUBLIC && req.headers["x-forwarded-for"]?.split(",")[0].trim()) || req.socket.remoteAddress;

// Locally everything lives in one workspace. In public mode each browser gets its own, pre-filled with samples.
async function resolveWorkspace(req, res) {
  if (!PUBLIC) return { id: "default", ws: workspace("default") };
  let id = cookies(req).sayso_ws;
  if (id && isWorkspaceId(id) && id !== "default") return { id, ws: workspace(id) };
  id = randomUUID();
  res.setHeader("Set-Cookie", `sayso_ws=${id}; Path=/; Max-Age=${60 * 60 * 24 * 30}; HttpOnly; SameSite=Lax${req.headers["x-forwarded-proto"] === "https" ? "; Secure" : ""}`);
  const ws = workspace(id);
  await ws.load();
  ws.calls.push(...sampleCalls());
  ws.persist();
  return { id, ws };
}

// Streams a Claude task as newline-delimited JSON: {"type":"partial"|"done"|"error", ...}.
async function streamTask(req, res, ctx, run) {
  if (PUBLIC) {
    const blocked = allowAiCall({ workspaceId: ctx.id, ip: clientIp(req) });
    if (blocked) throw httpError(429, blocked);
  }
  const abort = new AbortController();
  res.on("close", () => abort.abort()); // browser went away: stop paying for tokens
  res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  const send = (msg) => res.writableEnded || res.write(JSON.stringify(msg) + "\n");
  const started = Date.now();
  try {
    const result = await run({ signal: abort.signal, onPartial: (partial) => send({ type: "partial", data: partial }) });
    send({ type: "done", data: result, ms: Date.now() - started });
  } catch (err) {
    if (abort.signal.aborted) return;
    const [, message] = friendlyError(err);
    if (!(err instanceof Anthropic.APIError) && !(err.status < 500)) console.error(err);
    send({ type: "error", error: message });
  }
  res.end();
}

const text = (v, name, max = MAX_TEXT) => {
  if (typeof v !== "string" || !v.trim()) throw httpError(400, `Say or type a ${name} first.`);
  if (v.length > max) throw httpError(413, `That ${name} is too long (max ${max} characters).`);
  return v.trim();
};

// HubSpot runs after the response is sent, so saving never waits on it.
function syncInBackground(ws, call) {
  syncToHubSpot(HUBSPOT_TOKEN, call)
    .then((contactId) => ws.update(call.id, { hubspot_status: "synced", hubspot_contact_id: contactId, hubspot_error: undefined }))
    .catch((err) => ws.update(call.id, { hubspot_status: "failed", hubspot_error: err.message }));
}

const EDITABLE = new Set([
  "contact_name", "company", "email", "phone", "role", "deal_stage", "deal_value", "summary", "pain_points",
  "next_step", "follow_up_date", "sentiment", "action_items", "follow_up_done", "featured", "followup_subject", "followup_body",
]);
const pick = (obj) => Object.fromEntries(Object.entries(obj ?? {}).filter(([k]) => EDITABLE.has(k)));

async function route(req, res, url) {
  const key = `${req.method} ${url.pathname}`;

  const page = req.method === "GET" && PAGES[url.pathname];
  if (page) {
    if (req.headers["if-none-match"] === page.etag) {
      res.writeHead(304, { ETag: page.etag });
      return res.end();
    }
    const gz = /\bgzip\b/.test(req.headers["accept-encoding"] ?? "");
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache", ETag: page.etag, Vary: "Accept-Encoding",
      "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin", "X-Frame-Options": "DENY",
      ...(gz && { "Content-Encoding": "gzip" }),
    });
    return res.end(gz ? page.gz : page.raw);
  }
  if (key === "GET /healthz") return json(res, 200, { ok: true });
  if (req.method === "GET" && url.pathname.startsWith("/media/") && (await serveMedia(req, res, url.pathname.slice(7)))) return;

  if (key === "GET /api/proof") {
    const proof = PUBLIC ? await readProofSnapshot() : buildProof(await workspace("default").list(), MANUAL_MINUTES);
    return json(res, 200, proof ?? buildProof([], MANUAL_MINUTES));
  }
  if (key === "POST /api/proof/snapshot") {
    if (PUBLIC) throw httpError(403, "Snapshots can only be made from your local copy.");
    const file = await writeProofSnapshot(buildProof(await workspace("default").list(), MANUAL_MINUTES));
    return json(res, 200, { file: path.relative(process.cwd(), file) });
  }

  if (!url.pathname.startsWith("/api/")) return json(res, 404, { error: "Not found" });
  const ctx = await resolveWorkspace(req, res);
  const { ws } = ctx;
  const idMatch = url.pathname.match(/^\/api\/calls\/([\w-]+)(\/sync)?$/);

  if (key === "GET /api/config") {
    return json(res, 200, { hubspot: Boolean(HUBSPOT_TOKEN), model: engineName(), manual_minutes: MANUAL_MINUTES, public_mode: PUBLIC, demo_mode: DEMO, can_reset: PUBLIC || DEMO, sender_name: SENDER_NAME });
  }
  if (key === "POST /api/extract") {
    const transcript = text((await readBody(req)).transcript, "recap");
    return streamTask(req, res, ctx, (opts) => extractCall(transcript, opts));
  }
  if (key === "POST /api/revise") {
    const body = await readBody(req);
    const instruction = text(body.instruction, "correction", 1000);
    if (!body.record || typeof body.record !== "object") throw httpError(400, "Missing record.");
    return streamTask(req, res, ctx, (opts) => reviseCall(body.record, instruction, opts));
  }
  if (key === "POST /api/followup") {
    const body = await readBody(req);
    if (!body.record || typeof body.record !== "object") throw httpError(400, "Missing record.");
    const transcript = typeof body.transcript === "string" ? body.transcript.slice(0, MAX_TEXT) : "";
    const sender = String(body.sender_name || SENDER_NAME).slice(0, 80);
    return streamTask(req, res, ctx, (opts) => draftFollowup(pick(body.record), transcript, sender, opts));
  }

  if (key === "POST /api/ask") {
    const question = text((await readBody(req)).question, "question", 500);
    const calls = await ws.list();
    return streamTask(req, res, ctx, async (opts) => {
      const result = await askPipeline(calls, question, opts);
      // Map the C<n> ids Claude cited back to real calls so the page can link to them.
      const refs = Object.fromEntries(
        [...new Set([...(result.sources ?? []), ...(result.answer.match(/C\d+/g) ?? [])])]
          .map((ref) => [ref, calls[Number(ref.slice(1)) - 1]?.id])
          .filter(([, id]) => id),
      );
      return { ...result, refs, searched: Math.min(calls.length, 200) };
    });
  }
  if (key === "POST /api/reset") {
    if (!PUBLIC && !DEMO) throw httpError(403, "Your real call log can't be reset from the app.");
    ws.calls.length = 0;
    ws.calls.push(...sampleCalls());
    ws.persist();
    return json(res, 200, { calls: ws.calls.length });
  }
  if (key === "GET /api/calls") {
    const calls = await ws.list();
    return json(res, 200, { calls, stats: stats(calls, MANUAL_MINUTES), all_stats: stats(calls.map((c) => ({ ...c, is_sample: false })), MANUAL_MINUTES) });
  }
  if (key === "POST /api/calls") {
    const body = await readBody(req);
    if (!body.record || typeof body.record !== "object") throw httpError(400, "Missing record.");
    const wantSync = Boolean(body.sync && HUBSPOT_TOKEN);
    const call = await ws.add({
      ...pick(body.record),
      transcript: typeof body.transcript === "string" ? body.transcript.slice(0, MAX_TEXT) : "",
      dictation_seconds: Math.max(0, Math.min(3600, Number(body.dictation_seconds) || 0)),
      input_source: ["wispr", "mic", "typed"].includes(body.input_source) ? body.input_source : "typed",
      hubspot_status: wantSync ? "pending" : "off",
    });
    if (wantSync) syncInBackground(ws, call);
    return json(res, 200, { call });
  }
  if (idMatch && req.method === "PATCH" && !idMatch[2]) {
    const call = await ws.update(idMatch[1], pick(await readBody(req)));
    return call ? json(res, 200, { call }) : json(res, 404, { error: "Call not found." });
  }
  if (idMatch && req.method === "POST" && idMatch[2]) {
    if (!HUBSPOT_TOKEN) throw httpError(400, "HubSpot is not configured.");
    const call = await ws.update(idMatch[1], { hubspot_status: "pending" });
    if (!call) return json(res, 404, { error: "Call not found." });
    syncInBackground(ws, call);
    return json(res, 200, { call });
  }
  if (idMatch && req.method === "DELETE" && !idMatch[2]) return json(res, 200, { deleted: await ws.remove(idMatch[1]) });

  if (key === "GET /api/backup.json") {
    res.writeHead(200, { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="sayso-backup-${new Date().toISOString().slice(0, 10)}.json"` });
    return res.end(JSON.stringify({ app: "sayso", version: 1, exported_at: new Date().toISOString(), calls: await ws.list() }, null, 2));
  }
  if (key === "POST /api/restore") {
    if (PUBLIC) throw httpError(403, "Restore is only available on your own copy.");
    const body = await readBody(req);
    // "debrief" is the app's earlier name, so older backups still restore.
    if (!["sayso", "debrief"].includes(body.app) || !Array.isArray(body.calls)) throw httpError(400, "That isn't a Sayso backup file.");
    const existing = new Set((await ws.list()).map((c) => c.id));
    let added = 0;
    for (const c of body.calls) {
      if (!c || typeof c.id !== "string" || existing.has(c.id) || Number.isNaN(Date.parse(c.created_at))) continue;
      // Rebuild each call from known fields only, so a backup can't inject anything else.
      ws.calls.push({
        id: c.id, created_at: c.created_at, ...pick(c),
        transcript: typeof c.transcript === "string" ? c.transcript.slice(0, MAX_TEXT) : "",
        dictation_seconds: Math.max(0, Math.min(3600, Number(c.dictation_seconds) || 0)),
        input_source: ["wispr", "mic", "typed"].includes(c.input_source) ? c.input_source : "typed",
        hubspot_status: "off", ...(c.is_sample && { is_sample: true }),
      });
      existing.add(c.id);
      added++;
    }
    ws.calls.sort((a, b) => b.created_at.localeCompare(a.created_at));
    ws.persist();
    return json(res, 200, { added, skipped: body.calls.length - added });
  }
  if (key === "GET /api/export.csv") {
    res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="calls.csv"' });
    return res.end("﻿" + toCsv(await ws.list())); // BOM so Excel reads ₹ and other symbols correctly
  }
  json(res, 404, { error: "Not found" });
}

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res, new URL(req.url, "http://localhost"));
  } catch (err) {
    const [status, message] = friendlyError(err);
    if (status >= 500) console.error(err);
    if (!res.headersSent) json(res, status, { error: message });
    else res.end();
  }
});
server.keepAliveTimeout = 65_000;

if (PUBLIC) pruneWorkspaces().then((n) => n && console.log(`Pruned ${n} stale demo workspaces`));
const own = workspace("default");
await own.load();
if (DEMO && !own.calls.length) {
  own.calls.push(...sampleCalls());
  own.persist();
}
server.listen(PORT, () => {
  console.log(`Sayso running at http://localhost:${PORT} (engine: ${engineName()}${PUBLIC ? ", PUBLIC MODE" : ""})`);
  warmUp();
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    server.close();
    await flush();
    process.exit(0);
  });
}
