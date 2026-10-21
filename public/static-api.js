// Static mode (the Vercel deployment): there is no server, so this script answers the pages' /api/* calls
// inside the browser. The built-in engine runs here, and each visitor's calls are kept in their own browser
// (localStorage), seeded with the sample calls, exactly like a private public-demo workspace.
// It's loaded as a plain script before the page's own code, so every fetch("/api/...") goes through it.
(() => {
  const MANUAL_MINUTES = 6;
  const MAX_TEXT = 6000;
  const KEY = "sayso_calls";
  const PROFILE_KEY = "sayso_profile";
  const EDITABLE = new Set([
    "contact_name", "company", "email", "phone", "role", "deal_stage", "deal_value", "summary", "pain_points",
    "next_step", "follow_up_date", "sentiment", "action_items", "follow_up_done", "featured", "followup_subject", "followup_body",
  ]);
  const pick = (obj) => Object.fromEntries(Object.entries(obj ?? {}).filter(([k]) => EDITABLE.has(k)));
  const mods = {};
  const load = (name) => (mods[name] ??= import(`/lib/${name}.js`));

  // ---- storage (falls back to memory when the browser blocks localStorage) ----
  let memory = null;
  const read = () => { try { const v = localStorage.getItem(KEY); return v ? JSON.parse(v) : null; } catch { return memory; } };
  const write = (calls) => { memory = calls; try { localStorage.setItem(KEY, JSON.stringify(calls)); } catch {} };
  let memoryProfile = null;
  const readProfile = () => { try { const v = localStorage.getItem(PROFILE_KEY); return v ? JSON.parse(v) : null; } catch { return memoryProfile; } };
  const writeProfile = (p) => { memoryProfile = p; try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); } catch {} };

  async function calls() {
    let list = read();
    if (!list) { list = (await load("samples")).sampleCalls(); write(list); }
    return list;
  }

  // ---- responses ----
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fail = (status, error) => json(status, { error });
  const ndjson = (lines) => new Response(lines.map((l) => JSON.stringify(l)).join("\n") + "\n", { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
  async function task(run) {
    try { return ndjson([{ type: "done", data: await run(), ms: 0 }]); }
    catch (err) { return ndjson([{ type: "error", error: err.message }]); }
  }
  const text = (v, name, max = MAX_TEXT) => {
    if (typeof v !== "string" || !v.trim()) throw Object.assign(new Error(`Say or type a ${name} first.`), { status: 400 });
    if (v.length > max) throw Object.assign(new Error(`That ${name} is too long (max ${max} characters).`), { status: 413 });
    return v.trim();
  };

  async function handle(method, path, body) {
    const key = `${method} ${path}`;
    const idMatch = path.match(/^\/api\/calls\/([\w-]+)(\/sync)?$/);

    if (key === "GET /api/config") return json(200, { profile: readProfile(), can_demo: true, hubspot: false, model: "built-in engine", manual_minutes: MANUAL_MINUTES, public_mode: true, demo_mode: false, can_reset: true, sender_name: "", static: true });
    if (key === "POST /api/profile") {
      const profile = (await load("profile")).cleanProfile(body);
      if (profile.mode === "own" && !profile.company) return fail(400, "Add your company name.");
      if (body.reset) write(profile.mode === "example" ? (await load("samples")).sampleCalls() : []);
      writeProfile(profile);
      return json(200, { profile });
    }
    if (key === "GET /api/proof") {
      const res = await realFetch("/proof.json").catch(() => null);
      if (res?.ok) return json(200, await res.json());
      return json(200, (await load("stats")).buildProof([], MANUAL_MINUTES));
    }
    if (key === "POST /api/proof/snapshot") return fail(403, "Snapshots can only be made from your local copy.");

    const rules = await load("rules");
    if (key === "POST /api/extract") { const t = text(body.transcript, "recap"); return task(() => rules.extract(t, undefined, { currency: readProfile()?.currency ?? "₹" })); }
    if (key === "POST /api/revise") { const i = text(body.instruction, "correction", 1000); return task(() => rules.revise(body.record ?? {}, i)); }
    if (key === "POST /api/followup") {
      const profile = readProfile();
      const sender = (await load("profile")).signOff(profile, String(body.sender_name ?? "").slice(0, 80));
      return task(() => rules.followup(pick(body.record), String(body.transcript ?? ""), sender, { product: profile?.mode === "own" ? profile.product : "" }));
    }
    if (key === "POST /api/ask") {
      const q = text(body.question, "question", 500);
      const list = await calls();
      return task(() => {
        const result = rules.ask(list, q);
        const refs = Object.fromEntries([...new Set([...(result.sources ?? []), ...(result.answer.match(/C\d+/g) ?? [])])]
          .map((ref) => [ref, list[Number(ref.slice(1)) - 1]?.id]).filter(([, id]) => id));
        return { ...result, refs, searched: Math.min(list.length, 200) };
      });
    }

    if (key === "GET /api/calls") {
      const list = await calls();
      const { stats } = await load("stats");
      return json(200, { calls: list, stats: stats(list, MANUAL_MINUTES), all_stats: stats(list.map((c) => ({ ...c, is_sample: false })), MANUAL_MINUTES) });
    }
    if (key === "POST /api/calls") {
      if (!body.record || typeof body.record !== "object") return fail(400, "Missing record.");
      const list = await calls();
      const call = {
        id: crypto.randomUUID(), created_at: new Date().toISOString(), ...pick(body.record),
        transcript: typeof body.transcript === "string" ? body.transcript.slice(0, MAX_TEXT) : "",
        dictation_seconds: Math.max(0, Math.min(3600, Number(body.dictation_seconds) || 0)),
        input_source: ["wispr", "mic", "typed"].includes(body.input_source) ? body.input_source : "typed",
        hubspot_status: "off",
      };
      list.unshift(call);
      write(list);
      return json(200, { call });
    }
    if (idMatch && idMatch[2]) return fail(400, "HubSpot sync isn't available in the online demo.");
    if (idMatch && method === "PATCH") {
      const list = await calls();
      const call = list.find((c) => c.id === idMatch[1]);
      if (!call) return fail(404, "Call not found.");
      Object.assign(call, pick(body));
      write(list);
      return json(200, { call });
    }
    if (idMatch && method === "DELETE") {
      const list = await calls();
      const kept = list.filter((c) => c.id !== idMatch[1]);
      write(kept);
      return json(200, { deleted: kept.length !== list.length });
    }
    if (key === "POST /api/reset") { const fresh = (await load("samples")).sampleCalls(); write(fresh); return json(200, { calls: fresh.length }); }
    if (key === "POST /api/restore") return fail(403, "Restore is only available on your own copy.");
    return fail(404, "Not found");
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith("/api/")) return realFetch(input, init);
    const method = (init.method || (typeof input === "string" ? "GET" : input.method) || "GET").toUpperCase();
    let body = {};
    try { body = init.body ? JSON.parse(init.body) : {}; } catch { return fail(400, "Invalid JSON."); }
    try { return await handle(method, url.pathname, body); }
    catch (err) { return fail(err.status ?? 500, err.message); }
  };

  // Backup and CSV are plain links on the server; here they become downloads made in the browser.
  const download = (name, type, content) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([content], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  document.addEventListener("click", async (e) => {
    const a = e.target.closest?.('a[href="/api/backup.json"], a[href="/api/export.csv"]');
    if (!a) return;
    e.preventDefault();
    const list = await calls();
    const day = new Date().toISOString().slice(0, 10);
    if (a.getAttribute("href") === "/api/backup.json") {
      download(`sayso-backup-${day}.json`, "application/json", JSON.stringify({ app: "sayso", version: 1, exported_at: new Date().toISOString(), calls: list }, null, 2));
    } else {
      download("calls.csv", "text/csv;charset=utf-8", "﻿" + (await load("csv")).toCsv(list));
    }
  }, true);
})();
