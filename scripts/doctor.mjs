// `npm run doctor`: checks everything Sayso needs on this computer and prints the fix for each problem.
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
let problems = 0;
const ok = (m) => console.log(`  ✅ ${m}`);
const bad = (m, fix) => { problems++; console.log(`  ❌ ${m}\n     → ${fix.split("\n").join("\n       ")}`); };
const warn = (m, fix) => console.log(`  ⚠️  ${m}${fix ? `\n     → ${fix}` : ""}`);
const sh = (cmd) => { try { return execSync(cmd, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; } };

// .env is read the same way `npm start` reads it
const env = { ...process.env };
if (existsSync(path.join(ROOT, ".env"))) {
  for (const line of readFileSync(path.join(ROOT, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && m[2] && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

console.log("\nSayso check-up\n");

// 1. Node
const major = Number(process.versions.node.split(".")[0]);
if (major >= 22) ok(`Node.js ${process.versions.node}`);
else bad(`Node.js ${process.versions.node} is too old`, "Install Node.js 22 or newer from https://nodejs.org");

// 2. Packages
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const missing = Object.keys(pkg.dependencies ?? {}).filter((d) => !existsSync(path.join(ROOT, "node_modules", d, "package.json")));
if (missing.length) bad(`Missing packages: ${missing.join(", ")}`, "npm install");
else ok("Packages installed");

// 3. Claude API key (models.retrieve costs no tokens)
if (!existsSync(path.join(ROOT, ".env"))) ok("No .env file (not needed: everything works with the built-in engine)");
const model = env.CLAUDE_MODEL || "claude-opus-5-5";
if (!env.ANTHROPIC_API_KEY) {
  ok("Using the built-in engine (no API key needed). Optional: add ANTHROPIC_API_KEY to .env to use Claude.");
} else {
  try {
    const res = await fetch(`https://api.anthropic.com/v1/models/${model}`, {
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" }, signal: AbortSignal.timeout(10000),
    });
    if (res.ok) ok(`Claude API key works (${model})`);
    else if (res.status === 401) bad("The Claude API key was rejected", "Check ANTHROPIC_API_KEY in .env; create a new key in the Anthropic console if needed.");
    else if (res.status === 404) bad(`Model "${model}" isn't available to this key`, "Remove CLAUDE_MODEL from .env to use the default.");
    else warn(`Claude API answered ${res.status}`, "Try again in a minute.");
  } catch {
    warn("Couldn't reach the Claude API", "Check your internet connection.");
  }
}

// 4. HubSpot (optional)
if (!env.HUBSPOT_TOKEN) ok("HubSpot sync off (optional)");
else {
  try {
    const res = await fetch("https://api.hubapi.com/crm/v3/objects/contacts?limit=1", { headers: { Authorization: `Bearer ${env.HUBSPOT_TOKEN}` }, signal: AbortSignal.timeout(10000) });
    if (res.ok) ok("HubSpot token works");
    else bad(`HubSpot rejected the token (${res.status})`, "Check HUBSPOT_TOKEN and that the private app has contacts read/write scopes.");
  } catch {
    warn("Couldn't reach HubSpot", "Check your internet connection.");
  }
}

// 5. The app itself
const port = Number(env.PORT || 3000);
try {
  const res = await fetch(`http://localhost:${port}/healthz`, { signal: AbortSignal.timeout(3000) });
  const cfg = res.ok ? await fetch(`http://localhost:${port}/api/config`).then((r) => r.json()) : null;
  if (cfg?.demo_mode) warn(`Running at http://localhost:${port}, but in demo mode (Claude is simulated)`, "For real calls: stop it and run `npm start`.");
  else if (cfg) ok(`Running at http://localhost:${port}${cfg.public_mode ? " (public demo mode)" : ""}`);
  else bad(`Something else is answering on port ${port}`, `Stop it, or set PORT=3001 in .env`);
} catch {
  warn(`Not running on port ${port}`, "npm start");
}

// 6. Landing-page media and proof snapshot
const media = ["sayso-tour.webm", "app-review.jpg", "app-dictate.jpg", "app-email.jpg", "app-ask.jpg", "proof.jpg", "og.jpg"];
const noMedia = media.filter((f) => !existsSync(path.join(ROOT, "public", "media", f)));
if (noMedia.length) bad(`Landing-page media missing: ${noMedia.join(", ")}`, "npm run record:tour");
else ok("Tour video, screenshots and link-preview image present");

if (existsSync(path.join(ROOT, "data", "proof.json"))) {
  const proof = JSON.parse(readFileSync(path.join(ROOT, "data", "proof.json"), "utf8"));
  const age = Math.round((Date.now() - new Date(proof.generated_at)) / 86400000);
  (age > 2 ? warn : ok)(`Proof snapshot: ${proof.stats.calls_logged} calls, made ${age === 0 ? "today" : `${age} day${age === 1 ? "" : "s"} ago`}`, age > 2 ? "Open /proof locally → Publish proof snapshot, then commit data/proof.json and redeploy." : "");
} else warn("No proof snapshot yet (the hosted demo's /proof will be empty)", "After logging real calls: /proof → Publish proof snapshot, then commit data/proof.json.");

// 7. Git (needed to deploy)
const inRepo = sh("git rev-parse --is-inside-work-tree") === "true";
const branch = inRepo && sh("git rev-parse --abbrev-ref HEAD");
if (!inRepo) warn("Not a git repository yet", "git init && git add -A && git commit -m \"Sayso\"   (needed to deploy from GitHub)");
else if (!branch) warn("Git repository has no commits yet", "git add -A && git commit -m \"Sayso\"   then push to GitHub");
else {
  const remote = sh("git remote get-url origin");
  const dirty = (sh("git status --porcelain") ?? "").split("\n").filter(Boolean).length;
  ok(`Git: on ${branch}${remote ? ` → ${remote}` : " (no GitHub remote yet)"}${dirty ? `, ${dirty} uncommitted change${dirty === 1 ? "" : "s"}` : ""}`);
}

console.log(problems ? `\n${problems} problem${problems === 1 ? "" : "s"} found: follow the arrows, then run \`npm run doctor\` again.\n` : "\nEverything looks good.\n");
process.exitCode = problems ? 1 : 0;
