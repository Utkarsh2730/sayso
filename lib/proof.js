import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { completeness } from "./extract.js";

const PROOF_FILE = process.env.PROOF_FILE || path.join(import.meta.dirname, "..", "data", "proof.json");

export function stats(calls, manualMinutes) {
  const today = new Date().toLocaleDateString("en-CA");
  const real = calls.filter((c) => !c.is_sample);
  const dictated = real.reduce((s, c) => s + (c.dictation_seconds ?? 0), 0);
  const words = real.reduce((s, c) => s + (c.transcript?.split(/\s+/).filter(Boolean).length ?? 0), 0);
  const avgComplete = real.length ? real.reduce((s, c) => s + completeness(c), 0) / real.length : 0;
  const voiced = real.filter((c) => c.input_source === "wispr" || c.input_source === "mic").length;
  return {
    calls_logged: real.length,
    words_dictated: words,
    minutes_saved: Math.round(Math.max(0, real.length * manualMinutes - dictated / 60)),
    avg_completeness: Math.round(avgComplete * 100),
    follow_ups_set: real.filter((c) => c.follow_up_date).length,
    follow_ups_done: real.filter((c) => c.follow_up_done).length,
    follow_ups_due: real.filter((c) => c.follow_up_date && !c.follow_up_done && c.follow_up_date <= today).length,
    emails_drafted: real.filter((c) => c.followup_body).length,
    voice_share: real.length ? Math.round((voiced / real.length) * 100) : 0,
    wispr_recaps: real.filter((c) => c.input_source === "wispr").length,
    synced_to_hubspot: real.filter((c) => c.hubspot_status === "synced").length,
    avg_seconds_per_call: real.length ? Math.round(dictated / real.length) : 0,
  };
}

// Public view of a workspace: aggregate numbers, a per-day timeline and only the calls the owner chose to
// feature, with contact details removed.
const shortName = (name) => name.split(/\s+/).map((p, i) => (i === 0 ? p : `${p[0]}.`)).join(" ");

// Removes contact details from free text: emails (written or spoken), phone numbers and the full contact name.
export function scrub(text, contactName = "") {
  if (!text) return text;
  let out = text
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]")
    .replace(/\b[\w.]+ at [\w ]{1,40}? dot (com|in|io|co|org|net|ai)\b/gi, "[email]")
    .replace(/\+?\d[\d\s-]{7,}\d/g, "[phone]");
  const parts = contactName.trim().split(/\s+/).filter(Boolean);
  if (parts.length > 1) out = out.replaceAll(contactName.trim(), shortName(contactName.trim()));
  return out;
}

export function buildProof(calls, manualMinutes) {
  const real = calls.filter((c) => !c.is_sample);
  const byDay = new Map();
  for (const c of real) {
    const d = c.created_at.slice(0, 10);
    const e = byDay.get(d) ?? { date: d, calls: 0, seconds: 0 };
    e.calls++;
    e.seconds += c.dictation_seconds ?? 0;
    byDay.set(d, e);
  }
  const timeline = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)).map((e) => ({
    date: e.date, calls: e.calls, minutes_saved: Math.max(0, Math.round(e.calls * manualMinutes - e.seconds / 60)),
  }));
  const featured = real.filter((c) => c.featured).slice(0, 3).map((c) => ({
    created_at: c.created_at,
    contact: c.contact_name ? shortName(c.contact_name) : "",
    company: c.company, role: c.role, deal_stage: c.deal_stage, deal_value: c.deal_value,
    next_step: scrub(c.next_step, c.contact_name), follow_up_date: c.follow_up_date, summary: scrub(c.summary, c.contact_name),
    transcript: scrub(c.transcript, c.contact_name), dictation_seconds: c.dictation_seconds, input_source: c.input_source,
    followup_subject: scrub(c.followup_subject, c.contact_name), followup_body: scrub(c.followup_body, c.contact_name),
  }));
  return {
    generated_at: new Date().toISOString(),
    manual_minutes: manualMinutes,
    stats: stats(real, manualMinutes),
    timeline,
    featured,
    first_call_at: real.at(-1)?.created_at ?? null,
  };
}

export async function readProofSnapshot() {
  try {
    return JSON.parse(await readFile(PROOF_FILE, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

export async function writeProofSnapshot(proof) {
  await mkdir(path.dirname(PROOF_FILE), { recursive: true });
  await writeFile(PROOF_FILE, JSON.stringify(proof, null, 2));
  return PROOF_FILE;
}
