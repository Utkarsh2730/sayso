import { streamJson, MODEL, warmUp, Anthropic } from "./claude.js";
import * as rules from "./rules.js";
export { completeness } from "./stats.js";

export { MODEL, warmUp };

// Claude is optional: with no key, every task runs on the built-in engine (lib/rules.js). With a key, Claude
// runs the task, and if the API call fails (bad key, outage, rate limit) the built-in engine answers instead.
export const usingClaude = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
export const engineName = () => (usingClaude() ? MODEL : "built-in engine");

async function run(viaClaude, viaRules, signal) {
  if (!usingClaude()) return viaRules();
  try {
    return await viaClaude();
  } catch (err) {
    if (signal?.aborted || !(err instanceof Anthropic.APIError)) throw err;
    console.warn(`Claude failed (${err.status ?? err.name}); answered with the built-in engine instead.`);
    return viaRules();
  }
}
export const DEAL_STAGES = ["lead", "qualified", "demo", "proposal", "negotiation", "won", "lost"];

// Every field is required so the model always returns the full shape; unknown values come back as "".
// Property order is the order fields stream in, so the most useful ones come first.
export const CALL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "contact_name", "company", "email", "phone", "role", "deal_stage", "deal_value",
    "next_step", "follow_up_date", "summary", "pain_points", "action_items", "sentiment",
  ],
  properties: {
    contact_name: { type: "string", description: "Full name of the person spoken to, or \"\"" },
    company: { type: "string" },
    email: { type: "string" },
    phone: { type: "string" },
    role: { type: "string", description: "Their job title, or \"\"" },
    deal_stage: { type: "string", enum: DEAL_STAGES },
    deal_value: { type: "string", description: "Amount with currency as spoken, e.g. \"₹4,00,000\" or \"$12k/yr\", or \"\"" },
    next_step: { type: "string", description: "The single most important next action" },
    follow_up_date: { type: "string", description: "YYYY-MM-DD, resolved against today's date, or \"\"" },
    summary: { type: "string", description: "2-3 sentence factual summary of the call" },
    pain_points: { type: "array", items: { type: "string" } },
    action_items: { type: "array", items: { type: "string" } },
    sentiment: { type: "string", enum: ["positive", "neutral", "negative"] },
  },
};

const EXTRACT_SYSTEM = `You turn a salesperson's spoken post-call recap into a CRM record.
The recap is dictated, so expect filler words, self-corrections ("no wait, Thursday") and spelled-out emails ("priya at acme dot com"). Use the corrected version and normalise emails and phone numbers.
Only record what the speaker said. If a field was not mentioned, return "" (or [] for lists); never guess names, emails, amounts or dates.
Pick the deal_stage that best matches where the deal is now; default to "lead" for a first conversation.`;

const REVISE_SYSTEM = `You update a CRM record from a salesperson's spoken correction, e.g. "change the stage to proposal" or "her email is actually priya dot n at acme dot in".
Return the full record with only the requested changes applied; keep every other field exactly as it was.
Normalise emails, phone numbers and dates the same way as the original record. Resolve relative dates against today's date.`;

const today = () => new Date().toISOString().slice(0, 10);

export function extractCall(transcript, { onPartial, signal } = {}) {
  return run(() => streamJson({
    system: EXTRACT_SYSTEM,
    schema: CALL_SCHEMA,
    user: `Today is ${today()}.\n\n<recap>\n${transcript}\n</recap>`,
    onPartial, signal,
  }), () => rules.extract(transcript, today()), signal);
}

export function reviseCall(record, instruction, { onPartial, signal } = {}) {
  const current = Object.fromEntries(Object.keys(CALL_SCHEMA.properties).map((k) => [k, record[k] ?? (CALL_SCHEMA.properties[k].type === "array" ? [] : "")]));
  return run(() => streamJson({
    system: REVISE_SYSTEM,
    schema: CALL_SCHEMA,
    user: `Today is ${today()}.\n\n<record>\n${JSON.stringify(current, null, 2)}\n</record>\n\n<correction>\n${instruction}\n</correction>`,
    onPartial, signal,
  }), () => rules.revise(record, instruction, today()), signal);
}

export const FOLLOWUP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["subject", "body"],
  properties: {
    subject: { type: "string" },
    body: { type: "string", description: "Plain-text email body with line breaks, signed with the sender's name if known" },
  },
};

const FOLLOWUP_SYSTEM = `You write the follow-up email a salesperson sends right after a call.
Write like a busy, friendly professional: short (under 150 words), specific to what was discussed, one clear ask matching the next step, no buzzwords, no exclamation marks, no placeholders like [Your Name].
Use only facts from the call record and recap. Match the language the recap was spoken in (for example Hinglish stays Hinglish only if the recap was).`;

export function draftFollowup(record, transcript, senderName, { onPartial, signal } = {}) {
  return run(() => streamJson({
    system: FOLLOWUP_SYSTEM,
    schema: FOLLOWUP_SCHEMA,
    user: `Today is ${today()}. Sender: ${senderName || "unknown (sign off without a name)"}.\n\n<record>\n${JSON.stringify(record, null, 2)}\n</record>\n\n<recap>\n${transcript || "(no recap)"}\n</recap>`,
    onPartial, signal,
  }), () => rules.followup(record, transcript, senderName), signal);
}


export const ASK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["answer", "sources"],
  properties: {
    answer: { type: "string", description: "Plain-text answer. Cite calls inline as [C3]. Short paragraphs or '- ' bullets; no markdown headings." },
    sources: { type: "array", items: { type: "string" }, description: "Ids (like \"C3\") of the calls the answer relies on, most relevant first" },
  },
};

const ASK_SYSTEM = `You answer a salesperson's questions about their own pipeline, using only the call log provided.
Be direct and specific: names, companies, amounts, dates. Lead with the answer, then the evidence. Keep it under 150 words.
Cite every call you rely on inline as [C<n>] and list those ids in "sources". If the log doesn't contain the answer, say so plainly instead of guessing.
Resolve relative dates ("this week", "overdue") against today's date.`;

const ASK_FIELDS = ["contact_name", "company", "role", "deal_stage", "deal_value", "next_step", "follow_up_date", "follow_up_done", "sentiment", "summary", "pain_points", "followup_subject"];

// Calls are numbered C1..Cn (newest first) so answers can cite them; the caller maps ids back to calls.
export function askPipeline(calls, question, { onPartial, signal } = {}) {
  const log = calls.slice(0, 200).map((c, i) => {
    const fields = Object.fromEntries(ASK_FIELDS.filter((k) => c[k] !== undefined && c[k] !== "" && !(Array.isArray(c[k]) && !c[k].length)).map((k) => [k, c[k]]));
    return `<call id="C${i + 1}" date="${c.created_at.slice(0, 10)}">${JSON.stringify(fields)}</call>`;
  });
  return run(() => streamJson({
    system: ASK_SYSTEM,
    schema: ASK_SCHEMA,
    user: `Today is ${today()}.\n\n<calls count="${log.length}">\n${log.join("\n") || "(no calls logged yet)"}\n</calls>\n\n<question>\n${question}\n</question>`,
    onPartial, signal,
  }), () => rules.ask(calls, question, today()), signal);
}
