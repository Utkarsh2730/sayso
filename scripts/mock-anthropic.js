// A tiny stand-in for the Claude Messages API that streams a fixed record as SSE in small chunks.
// Used by the integration test and for UI demos without an API key:  node scripts/mock-anthropic.js 4010
import http from "node:http";

export const MOCK_RECORD = {
  contact_name: "Priya Nair", company: "Acme Logistics", email: "priya@acmelogistics.in", phone: "",
  role: "Head of Ops", deal_stage: "demo", deal_value: "₹4,00,000/yr",
  next_step: "Send demo invite to her three team leads", follow_up_date: "2026-10-22",
  summary: "Acme loses about two hours a day on manual dispatch spreadsheets and drivers get double-booked. Priya wants a demo for her team leads.",
  pain_points: ["Manual dispatch spreadsheets", "Double-booked drivers"], action_items: ["Send demo invite today"], sentiment: "positive",
};

export const MOCK_EMAIL = {
  subject: "Demo for your team leads on Thursday",
  body: "Hi Priya,\n\nThanks for walking me through how dispatch works today. Two hours a day on spreadsheets and double-booked drivers is exactly what we fix.\n\nI'll send a demo invite for you and your three team leads shortly. Does Thursday afternoon work?\n\nBest,\nSam",
};

// Picks the canned answer from the request: email schema, correction, or a fresh extraction.
function answerFor(req) {
  const schema = req.output_config?.format?.schema;
  if (schema?.properties?.subject) return MOCK_EMAIL;
  if (schema?.properties?.answer) {
    const ids = [...(req.messages?.[0]?.content ?? "").matchAll(/<call id="(C\d+)"[^>]*>(\{.*?\})<\/call>/g)].slice(0, 2);
    if (!ids.length) return { answer: "There are no calls in the log yet, so I can't answer that.", sources: [] };
    const [a, b] = ids.map(([, id, json]) => ({ id, ...JSON.parse(json) }));
    const line = (c) => `- ${c.contact_name} (${c.company}): ${c.next_step ?? "no next step"}, due ${c.follow_up_date ?? "soon"} [${c.id}]`;
    return { answer: `Two follow-ups need you this week:\n${[a, b].filter(Boolean).map(line).join("\n")}`, sources: ids.map(([, id]) => id) };
  }
  const user = req.messages?.[0]?.content ?? "";
  if (user.includes("<correction>")) {
    const record = JSON.parse(user.match(/<record>\n([\s\S]*?)\n<\/record>/)[1]);
    if (/proposal/i.test(user)) record.deal_stage = "proposal";
    if (/five lakh/i.test(user)) record.deal_value = "₹5,00,000/yr";
    return record;
  }
  return MOCK_RECORD;
}

export function startMock({ port = 0, chunkSize = 12, delayMs = 15, rejectFallbacks = false } = {}) {
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url.startsWith("/v1/models/")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ type: "model", id: req.url.split("/").pop(), display_name: "Mock" }));
    }
    let body = "";
    for await (const c of req) body += c;
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
    const request = JSON.parse(body);
    if (rejectFallbacks && request.fallbacks) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "fallbacks: unsupported beta for this account" } }));
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const model = request.model;
    send("message_start", { message: { id: "msg_mock", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
    send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    const text = JSON.stringify(answerFor(request));
    for (let i = 0; i < text.length; i += chunkSize) {
      send("content_block_delta", { index: 0, delta: { type: "text_delta", text: text.slice(i, i + chunkSize) } });
      await new Promise((r) => setTimeout(r, delayMs));
    }
    send("content_block_stop", { index: 0 });
    send("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 100 } });
    send("message_stop", {});
    res.end();
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = await startMock({ port: Number(process.argv[2] ?? 4010), delayMs: 40 });
  console.log(`Mock Claude API on http://localhost:${server.address().port}`);
}
