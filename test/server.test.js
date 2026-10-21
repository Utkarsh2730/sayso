// End-to-end: real server + real SDK, with the Claude API replaced by the local mock.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startMock, MOCK_RECORD, MOCK_EMAIL } from "../scripts/mock-anthropic.js";

let mock;
before(async () => { mock = await startMock(); });
after(() => mock.close());

async function startApp(port, env = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "sayso-"));
  const app = spawn(process.execPath, ["server.js"], {
    cwd: path.join(import.meta.dirname, ".."),
    env: {
      ...process.env, PORT: String(port), ANTHROPIC_API_KEY: "test", HUBSPOT_TOKEN: "", PUBLIC_MODE: "",
      ANTHROPIC_BASE_URL: `http://localhost:${mock.address().port}`,
      CRM_FILE: path.join(dir, "crm.json"), WORKSPACE_DIR: path.join(dir, "ws"), PROOF_FILE: path.join(dir, "proof.json"),
      ...env,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve) => app.stdout.on("data", (d) => String(d).includes("running") && resolve()));
  return { app, dir, base: `http://localhost:${port}` };
}

const post = (url, body, headers = {}) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const ndjson = async (res) => (await res.text()).trim().split("\n").map((l) => JSON.parse(l));

describe("local mode", () => {
  let s;
  before(async () => { s = await startApp(3997); });
  after(() => s.app.kill());

  test("extraction streams partial records before the final one", async () => {
    const lines = await ndjson(await post(`${s.base}/api/extract`, { transcript: "recap" }));
    const partials = lines.filter((l) => l.type === "partial");
    assert.ok(partials.length > 5, `expected many partials, got ${partials.length}`);
    assert.equal(lines.at(-1).type, "done");
    assert.deepEqual(lines.at(-1).data, MOCK_RECORD);
    assert.ok(partials.some((p) => p.data.contact_name && !p.data.summary), "fields should arrive progressively");
  });

  test("a spoken correction changes only what was asked", async () => {
    const lines = await ndjson(await post(`${s.base}/api/revise`, { record: MOCK_RECORD, instruction: "change the stage to proposal" }));
    const done = lines.at(-1).data;
    assert.equal(done.deal_stage, "proposal");
    assert.equal(done.email, MOCK_RECORD.email);
  });

  test("follow-up email streams subject and body", async () => {
    const lines = await ndjson(await post(`${s.base}/api/followup`, { record: MOCK_RECORD, transcript: "recap" }));
    assert.deepEqual(lines.at(-1).data, MOCK_EMAIL);
    assert.ok(lines.some((l) => l.type === "partial" && l.data.body && l.data.body.length < MOCK_EMAIL.body.length));
  });

  test("save, list, mark done, feature, export, delete", async () => {
    const { call } = await post(`${s.base}/api/calls`, {
      record: { ...MOCK_RECORD, followup_subject: MOCK_EMAIL.subject, followup_body: MOCK_EMAIL.body, hacked: 1 },
      transcript: "Priya Nair at priya at acme logistics dot in", dictation_seconds: 30, input_source: "wispr",
    }).then((r) => r.json());
    assert.equal(call.hubspot_status, "off");
    assert.equal(call.input_source, "wispr");
    assert.equal(call.hacked, undefined);

    await fetch(`${s.base}/api/calls/${call.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ follow_up_done: true, featured: true }) });
    const { calls, stats } = await fetch(`${s.base}/api/calls`).then((r) => r.json());
    assert.equal(calls[0].follow_up_done, true);
    assert.equal(stats.calls_logged, 1);
    assert.equal(stats.emails_drafted, 1);
    assert.equal(stats.wispr_recaps, 1);

    const proof = await fetch(`${s.base}/api/proof`).then((r) => r.json());
    assert.equal(proof.stats.calls_logged, 1);
    assert.equal(proof.featured.length, 1);
    assert.equal(proof.featured[0].contact, "Priya N.");
    assert.ok(!JSON.stringify(proof).includes("priya@acmelogistics.in"), "email must not leak into the proof");
    assert.ok(!proof.featured[0].transcript.includes("Priya Nair"));

    const snap = await post(`${s.base}/api/proof/snapshot`, {});
    assert.equal(snap.status, 200);
    assert.ok(existsSync(path.join(s.dir, "proof.json")));

    assert.match(await fetch(`${s.base}/api/export.csv`).then((r) => r.text()), /Priya Nair/);
    await fetch(`${s.base}/api/calls/${call.id}`, { method: "DELETE" });
    assert.equal((await fetch(`${s.base}/api/calls`).then((r) => r.json())).calls.length, 0);
  });

  test("backup and restore round-trip without duplicates", async () => {
    await post(`${s.base}/api/calls`, { record: MOCK_RECORD, transcript: "backup me" });
    const backup = await fetch(`${s.base}/api/backup.json`).then((r) => r.json());
    assert.equal(backup.app, "sayso");
    assert.ok(backup.calls.length >= 1);
    const again = await post(`${s.base}/api/restore`, backup).then((r) => r.json());
    assert.equal(again.added, 0, "restoring the same backup adds nothing");
    const id = backup.calls[0].id;
    await fetch(`${s.base}/api/calls/${id}`, { method: "DELETE" });
    const restored = await post(`${s.base}/api/restore`, { ...backup, calls: [{ ...backup.calls[0], hacked: true }] }).then((r) => r.json());
    assert.equal(restored.added, 1);
    const { calls } = await fetch(`${s.base}/api/calls`).then((r) => r.json());
    const back = calls.find((c) => c.id === id);
    assert.equal(back.contact_name, "Priya Nair");
    assert.equal(back.hacked, undefined);
    assert.equal((await post(`${s.base}/api/restore`, { calls: [] })).status, 400);
    await fetch(`${s.base}/api/calls/${id}`, { method: "DELETE" });
  });

  test("pages are served gzipped with ETags", async () => {
    for (const p of ["/", "/app", "/proof"]) {
      const res = await fetch(s.base + p);
      assert.equal(res.status, 200, p);
      const again = await fetch(s.base + p, { headers: { "If-None-Match": res.headers.get("etag") } });
      assert.equal(again.status, 304, p);
    }
  });

  test("real local data can't be reset", async () => {
    assert.equal((await post(`${s.base}/api/reset`, {})).status, 403);
  });

  test("ask answers from an empty log without crashing", async () => {
    const lines = await ndjson(await post(`${s.base}/api/ask`, { question: "anything?" }));
    assert.equal(lines.at(-1).type, "done");
    assert.deepEqual(lines.at(-1).data.refs, {});
  });

  test("bad input is rejected", async () => {
    assert.equal((await post(`${s.base}/api/extract`, { transcript: " " })).status, 400);
    assert.equal((await post(`${s.base}/api/extract`, { transcript: "x".repeat(7000) })).status, 413);
    assert.equal((await post(`${s.base}/api/revise`, { instruction: "x" })).status, 400);
  });
});

describe("public mode", () => {
  let s;
  before(async () => { s = await startApp(3998, { PUBLIC_MODE: "1", HUBSPOT_TOKEN: "secret", LIMIT_PER_WORKSPACE: "2" }); });
  after(() => s.app.kill());

  const visitor = async () => {
    const res = await fetch(`${s.base}/api/calls`);
    const cookie = res.headers.get("set-cookie").split(";")[0];
    return { cookie, body: await res.json() };
  };

  test("each visitor gets a private workspace with sample calls", async () => {
    const a = await visitor();
    const b = await visitor();
    assert.notEqual(a.cookie, b.cookie);
    assert.equal(a.body.calls.length, 6);
    assert.ok(a.body.calls.every((c) => c.is_sample));

    await post(`${s.base}/api/calls`, { record: MOCK_RECORD, transcript: "t" }, { Cookie: a.cookie });
    const aCalls = (await fetch(`${s.base}/api/calls`, { headers: { Cookie: a.cookie } }).then((r) => r.json())).calls;
    const bCalls = (await fetch(`${s.base}/api/calls`, { headers: { Cookie: b.cookie } }).then((r) => r.json())).calls;
    assert.equal(aCalls.length, 7);
    assert.equal(bCalls.length, 6);
  });

  test("restore is blocked on the public demo", async () => {
    assert.equal((await post(`${s.base}/api/restore`, { app: "sayso", calls: [] })).status, 403);
  });

  test("HubSpot is off and snapshots are blocked", async () => {
    const { cookie } = await visitor();
    const config = await fetch(`${s.base}/api/config`, { headers: { Cookie: cookie } }).then((r) => r.json());
    assert.equal(config.hubspot, false);
    assert.equal(config.public_mode, true);
    assert.equal((await post(`${s.base}/api/proof/snapshot`, {})).status, 403);
  });

  test("ask cites real calls from the visitor's own workspace", async () => {
    const { cookie, body } = await visitor();
    const lines = await ndjson(await post(`${s.base}/api/ask`, { question: "who should I follow up with?" }, { Cookie: cookie }));
    const done = lines.at(-1);
    assert.equal(done.type, "done");
    assert.equal(done.data.searched, 6);
    const ids = Object.values(done.data.refs);
    assert.ok(ids.length > 0);
    assert.ok(ids.every((id) => body.calls.some((c) => c.id === id)), "every citation maps to a call");
  });

  test("reset restores the sample calls", async () => {
    const { cookie } = await visitor();
    await post(`${s.base}/api/calls`, { record: MOCK_RECORD, transcript: "t" }, { Cookie: cookie });
    assert.equal((await post(`${s.base}/api/reset`, {}, { Cookie: cookie })).status, 200);
    const { calls } = await fetch(`${s.base}/api/calls`, { headers: { Cookie: cookie } }).then((r) => r.json());
    assert.equal(calls.length, 6);
    assert.ok(calls.every((c) => c.is_sample));
  });

  test("AI calls are capped per workspace", async () => {
    const { cookie } = await visitor();
    const statuses = [];
    for (let i = 0; i < 3; i++) {
      const res = await post(`${s.base}/api/extract`, { transcript: "recap" }, { Cookie: cookie });
      statuses.push(res.status);
      await res.text();
    }
    assert.deepEqual(statuses, [200, 200, 429]);
  });
});

describe("API compatibility", () => {
  let strict, s;
  before(async () => {
    strict = await startMock({ rejectFallbacks: true, delayMs: 0 });
    s = await startApp(3995, { ANTHROPIC_BASE_URL: `http://localhost:${strict.address().port}` });
  });
  after(() => { s.app.kill(); strict.close(); });

  test("extraction still works when the API rejects the refusal-fallback beta", async () => {
    const lines = await ndjson(await post(`${s.base}/api/extract`, { transcript: "recap" }));
    assert.equal(lines.at(-1).type, "done");
    assert.deepEqual(lines.at(-1).data, MOCK_RECORD);
  });
});

describe("built-in engine (no API key)", () => {
  let s;
  before(async () => { s = await startApp(3994, { ANTHROPIC_API_KEY: "", ANTHROPIC_BASE_URL: "" }); });
  after(() => s.app.kill());
  const RECAP = "Just got off a call with Priya Nair, she's head of ops at Acme Logistics. Her email is priya at acme logistics dot in. Budget is roughly four lakh rupees a year. She wants a demo for her three team leads. I'll send the invite today and follow up Tuesday, no wait, Thursday.";

  test("config reports the built-in engine", async () => {
    assert.equal((await fetch(`${s.base}/api/config`).then((r) => r.json())).model, "built-in engine");
  });

  test("extracts a real record from a recap", async () => {
    const done = (await ndjson(await post(`${s.base}/api/extract`, { transcript: RECAP }))).at(-1);
    assert.equal(done.type, "done");
    const r = done.data;
    assert.equal(r.contact_name, "Priya Nair");
    assert.equal(r.company, "Acme Logistics");
    assert.equal(r.email, "priya@acmelogistics.in");
    assert.equal(r.role, "Head of Ops");
    assert.equal(r.deal_value, "₹4,00,000/yr");
    assert.equal(r.deal_stage, "demo");
    assert.equal(new Date(r.follow_up_date + "T00:00").getDay(), 4, "Thursday, not Tuesday");
  });

  test("corrections, unclear corrections, emails and answers", async () => {
    const record = (await ndjson(await post(`${s.base}/api/extract`, { transcript: RECAP }))).at(-1).data;
    const fixed = (await ndjson(await post(`${s.base}/api/revise`, { record, instruction: "The value is five lakh a year" }))).at(-1).data;
    assert.equal(fixed.deal_value, "₹5,00,000/yr");
    assert.equal(fixed.email, record.email);
    const unclear = (await ndjson(await post(`${s.base}/api/revise`, { record, instruction: "hmm okay" }))).at(-1);
    assert.equal(unclear.type, "error");
    const email = (await ndjson(await post(`${s.base}/api/followup`, { record, transcript: RECAP, sender_name: "Sam" }))).at(-1).data;
    assert.match(email.body, /^Hi Priya,/);
    assert.match(email.body, /Sam$/);
    await post(`${s.base}/api/calls`, { record, transcript: RECAP });
    const ans = (await ndjson(await post(`${s.base}/api/ask`, { question: "Who should I follow up with this week?" }))).at(-1).data;
    assert.match(ans.answer, /Priya Nair/);
    assert.equal(Object.keys(ans.refs).length, 1);
  });
});
