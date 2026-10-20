import Anthropic from "@anthropic-ai/sdk";
import { parsePartialJson } from "./partial-json.js";

export const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";

// Created on first use so the server can start (and show a clear error) before a key is set.
let client;
const getClient = () => (client ??= new Anthropic());

// Opens the HTTPS connection ahead of the first request so it doesn't pay the TLS handshake. Costs no tokens.
export async function warmUp() {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) return;
  try {
    await getClient().models.retrieve(MODEL);
  } catch (err) {
    console.warn(`Claude warm-up failed: ${err.message}`);
  }
}

// Streams a structured (JSON-schema) answer. Calls onPartial(obj) whenever more of the object is available
// and resolves with the complete, parsed object.
// Server-side refusal fallback is a beta. If an account or model rejects it, drop it once and keep working
// rather than failing every request.
let useFallbacks = process.env.CLAUDE_FALLBACKS !== "off";

export async function streamJson(args) {
  try {
    return await streamOnce(args);
  } catch (err) {
    const rejectedBeta = err instanceof Anthropic.BadRequestError && /fallback|beta/i.test(err.message);
    if (!useFallbacks || !rejectedBeta || args.signal?.aborted) throw err;
    console.warn("Claude rejected the refusal-fallback beta; continuing without it:", err.message);
    useFallbacks = false;
    return streamOnce(args);
  }
}

async function streamOnce({ system, user, schema, onPartial, signal, effort = "low" }) {
  const stream = getClient().beta.messages.stream(
    {
      model: MODEL,
      max_tokens: 4096,
      ...(useFallbacks && { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }),
      output_config: { effort, format: { type: "json_schema", schema } },
      system,
      messages: [{ role: "user", content: user }],
    },
    { signal },
  );

  let text = "";
  let lastSent = "";
  for await (const event of stream) {
    if (event.type === "message_start") text = ""; // a server-side fallback restarts the answer
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      text += event.delta.text;
      if (!onPartial) continue;
      const partial = parsePartialJson(text);
      const serialized = partial && JSON.stringify(partial);
      if (serialized && serialized !== "{}" && serialized !== lastSent) {
        lastSent = serialized;
        onPartial(partial);
      }
    }
  }

  const response = await stream.finalMessage();
  if (response.stop_reason === "refusal") throw new Error("Claude declined to process this request.");
  if (response.stop_reason === "max_tokens") throw new Error("The input was too long to process in one go.");
  const final = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  if (!final) throw new Error("Claude returned an empty answer.");
  return JSON.parse(final);
}

export { Anthropic };
