// Runs Sayso with the built-in engine (no API key) and a separate data file, pre-filled with example calls.
// Used for trying the app, recording the tour and demo videos, and as a stage backup.
import path from "node:path";

Object.assign(process.env, {
  ANTHROPIC_API_KEY: "",
  ANTHROPIC_AUTH_TOKEN: "",
  CRM_FILE: process.env.CRM_FILE || path.join(import.meta.dirname, "..", "data", "demo.json"),
  HUBSPOT_TOKEN: "",
  DEMO_MODE: "1",
});
console.log("Example mode: built-in engine and example calls, in a separate data file. Your real data isn't touched.");
await import("../server.js");
