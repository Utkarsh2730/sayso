// Builds the static version of Sayso into dist/ (what Vercel serves). No server: public/static-api.js answers
// the pages' /api calls in the browser with the built-in engine, and each visitor's calls stay in their browser.
//
//   npm run build:static
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const OUT = path.join(ROOT, "dist");
const origin = process.env.PUBLIC_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "");

rmSync(OUT, { recursive: true, force: true });
mkdirSync(path.join(OUT, "lib"), { recursive: true });

for (const page of ["index.html", "app.html", "proof.html"]) {
  let html = readFileSync(path.join(ROOT, "public", page), "utf8").replaceAll("__ORIGIN__", origin.replace(/\/$/, ""));
  // Load the in-browser API before any of the page's own scripts run.
  html = html.replace(/(<meta name="viewport"[^>]*>)/, `$1\n<script src="/static-api.js"></script>`);
  if (!html.includes("/static-api.js")) throw new Error(`Couldn't add static-api.js to ${page}`);
  writeFileSync(path.join(OUT, page), html);
}
cpSync(path.join(ROOT, "public", "static-api.js"), path.join(OUT, "static-api.js"));
cpSync(path.join(ROOT, "public", "media"), path.join(OUT, "media"), { recursive: true });
for (const mod of ["rules", "stats", "samples", "csv"]) cpSync(path.join(ROOT, "lib", `${mod}.js`), path.join(OUT, "lib", `${mod}.js`));
const proof = path.join(ROOT, "data", "proof.json");
if (existsSync(proof)) cpSync(proof, path.join(OUT, "proof.json"));

console.log(`Built dist/ for static hosting${origin ? ` (${origin})` : ""}${existsSync(proof) ? ", with your proof snapshot" : ""}.`);
