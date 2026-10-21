// Runs Sayso in demo mode with the built-in engine (no API key) and a separate data file, pre-filled with
// sample calls. Used for trying the app, recording the tour and demo videos, and as a stage backup.
import path from "node:path";

Object.assign(process.env, {
  ANTHROPIC_API_KEY: "",
  ANTHROPIC_AUTH_TOKEN: "",
  CRM_FILE: process.env.CRM_FILE || path.join(import.meta.dirname, "..", "data", "demo.json"),
  HUBSPOT_TOKEN: "",
  DEMO_MODE: "1",
});
console.log("DEMO MODE: built-in engine, sample data. Your real data isn't touched.");
await import("../server.js");
