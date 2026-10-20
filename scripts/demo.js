// Runs Debrief against the local mock Claude API, with a separate data file. For UI checks without an API key;
// every extraction returns the same sample record.
import path from "node:path";
import { startMock } from "./mock-anthropic.js";

const mock = await startMock({ delayMs: 35 });
Object.assign(process.env, {
  ANTHROPIC_API_KEY: "mock",
  ANTHROPIC_BASE_URL: `http://localhost:${mock.address().port}`,
  CRM_FILE: process.env.CRM_FILE || path.join(import.meta.dirname, "..", "data", "demo.json"),
  HUBSPOT_TOKEN: "",
  DEMO_MODE: "1",
});
console.log("DEMO MODE: Claude is mocked; every recap returns the same sample record.");
await import("../server.js");
