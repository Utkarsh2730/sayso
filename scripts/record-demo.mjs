/**
 * Records the ~2-minute captioned demo video for the hackathon submission.
 *
 *   npm run record:demo        → docs/sayso-demo.webm
 *
 * Runs Sayso in demo mode (built-in engine, sample data, throwaway data file) and walks through the whole
 * story with a visible cursor, large captions and chapter cards. No audio.
 *
 * Quality: the page is captured at 1920×1080 with Chrome's screencast (JPEG quality 95, real timestamps), then
 * re-timed to a steady 30 fps and encoded at ~8 Mbps VP8 with Playwright's bundled ffmpeg, so no extra
 * install is needed. Needs Playwright's Chromium and ffmpeg (`npx playwright install chromium ffmpeg`).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.join(import.meta.dirname, "..");
const OUT = path.join(ROOT, "docs", "sayso-demo.webm");
const PORT = 4410;
const B = `http://localhost:${PORT}`;
const SIZE = { width: 1280, height: 720 };
const work = mkdtempSync(path.join(tmpdir(), "sayso-demo-"));
mkdirSync(path.dirname(OUT), { recursive: true });

const server = spawn(process.execPath, ["scripts/demo.js"], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), CRM_FILE: path.join(work, "demo.json") }, stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((resolve) => server.stdout.on("data", (d) => String(d).includes("running") && resolve()));

const browser = await chromium.launch();
// 1280×720 layout rendered at 1.5× = 1920×1080 pixels: same composition, much sharper text.
const ctx = await browser.newContext({ viewport: SIZE, deviceScaleFactor: 1.5 });
// The screencast only sends a frame when something repaints; a 1-pixel ticker keeps frames (and timing) flowing.
await ctx.addInitScript(() => {
  const tick = () => {
    if (!document.body) return requestAnimationFrame(tick);
    let t = document.getElementById("tick");
    if (!t) { t = document.createElement("div"); t.id = "tick"; t.style.cssText = "position:fixed;right:0;bottom:0;width:1px;height:1px;z-index:100001;pointer-events:none"; document.body.appendChild(t); }
    t.style.background = t.style.background === "rgb(6, 8, 11)" ? "rgb(7, 8, 11)" : "rgb(6, 8, 11)";
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
await ctx.addInitScript(() => {
  const css = `
    #banner{display:none!important} .rv{opacity:1!important;transform:none!important}
    #cap{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:99999;max-width:1200px;width:max-content;
      display:flex;align-items:center;gap:14px;padding:14px 24px;border-radius:18px;background:rgba(6,8,11,.94);border:1px solid rgba(200,242,90,.4);
      color:#eef2f5;font:650 26px/1.3 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;box-shadow:0 14px 40px rgba(0,0,0,.6)}
    #cap b{flex:none;display:inline-flex;align-items:center;justify-content:center;min-width:40px;height:40px;padding:0 10px;border-radius:12px;background:#c8f25a;color:#151b04;font-size:20px}
    #cur{position:fixed;z-index:100000;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:rgba(200,242,90,.3);border:2px solid #c8f25a;pointer-events:none;transition:transform .12s}
    #cur.down{transform:scale(.6);background:rgba(200,242,90,.7)}`;
  const mount = () => {
    if (document.getElementById("cur")) return;
    const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
    const cur = document.createElement("div"); cur.id = "cur"; document.body.appendChild(cur);
    const pos = JSON.parse(sessionStorage.getItem("pos") || "[640,360]");
    cur.style.left = pos[0] + "px"; cur.style.top = pos[1] + "px";
    addEventListener("mousemove", (e) => { cur.style.left = e.clientX + "px"; cur.style.top = e.clientY + "px"; sessionStorage.setItem("pos", JSON.stringify([e.clientX, e.clientY])); }, true);
    addEventListener("mousedown", () => cur.classList.add("down"), true);
    addEventListener("mouseup", () => cur.classList.remove("down"), true);
    window.__cap = (step, text) => {
      sessionStorage.setItem("cap", JSON.stringify([step, text]));
      let el = document.getElementById("cap");
      if (!text) { el?.remove(); return; }
      if (!el) { el = document.createElement("div"); el.id = "cap"; document.body.appendChild(el); }
      el.innerHTML = (step ? `<b>${step}</b>` : "") + `<span>${text}</span>`;
    };
    const saved = JSON.parse(sessionStorage.getItem("cap") || "null");
    if (saved && saved[1]) window.__cap(saved[0], saved[1]);
  };
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", mount); else mount();
});

const page = await ctx.newPage();
page.on("dialog", (d) => d.accept());
const FRAMES = path.join(work, "frames");
mkdirSync(FRAMES);
const frames = [];
const cdp = await ctx.newCDPSession(page);
cdp.on("Page.screencastFrame", (f) => {
  const file = path.join(FRAMES, `${String(frames.length).padStart(6, "0")}.jpg`);
  writeFileSync(file, Buffer.from(f.data, "base64"));
  frames.push({ file, t: f.metadata.timestamp });
  cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
});
await page.setContent(card("", "", ""));
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 95, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
const t0 = Date.now();
const PACE = 1.4; // stretch every pause so each caption can be read comfortably
const sleep = (ms) => page.waitForTimeout(ms * PACE);
const cap = (step, text) => {
  if (text) console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${step ?? ""} ${text}`);
  return page.evaluate(([s, t]) => window.__cap?.(s, t), [step, text]);
};
const moveTo = async (loc) => {
  await loc.scrollIntoViewIfNeeded();
  const box = await loc.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 22 });
  await sleep(180);
};
const click = async (loc) => { await moveTo(loc); await loc.click(); };
const scrollTo = (sel) => page.evaluate((s) => document.querySelector(s).scrollIntoView({ behavior: "smooth", block: "center" }), sel);
const chapter = async (title, accent, foot, ms = 4200) => { await page.setContent(card(title, accent, foot)); await sleep(ms); };

// 0:00 · the problem
await chapter("Nobody updates the CRM.", "Writing up a call takes longer than the call.", "Sayso · No Hands: The Wispr Challenge · product walkthrough on sample data", 5200);
await chapter("So I stopped typing.", "I talk for 30 seconds instead.", "Built and used with Wispr Flow", 3800);

// 0:09 · landing
await page.goto(B, { waitUntil: "networkidle" });
await cap(null, "Sayso: a voice-first CRM for founders and small sales teams.");
await sleep(3200);

// 0:13 · dictate with Wispr Flow
await page.goto(`${B}/app`, { waitUntil: "networkidle" });
await cap("1", "Right after a call, I hold my Wispr Flow key and talk.");
await moveTo(page.locator("#wfBar"));
await sleep(1800);
await click(page.locator("#transcript"));
const recap = await page.evaluate(() => SAMPLE);
for (const phrase of recap.match(/[^,.]+[,.]?/g)) {
  await page.keyboard.insertText(phrase);
  await sleep(230);
}
await cap("1", "Wispr Flow types it in; Sayso spots the dictation.");
await moveTo(page.locator("#wfBar"));
await sleep(2600);

// 0:35 · streaming extraction
await cap("2", "Sayso turns the ramble into a complete CRM record. No API key needed.");
await click(page.getByRole("button", { name: "Extract CRM fields" }));
await page.waitForFunction(() => document.getElementById("liveTag").textContent.includes("ready"));
await sleep(1800);
await cap("2", "“Tuesday, no wait, Thursday” and “priya at acme logistics dot in” come out right.");
await moveTo(page.locator('[data-k="follow_up_date"]'));
await sleep(3400);

// 0:44 · contact history
await cap("3", "It knows Priya: second call, phone carried over from the intro call.");
await moveTo(page.locator("#historyBox"));
await sleep(4200);

// 0:49 · voice correction
await cap("4", "Wrong value? I just say so. Only that field changes.");
await page.locator("#fixInput").click();
await page.keyboard.insertText("The value is five lakh a year");
await sleep(600);
await page.keyboard.press("Enter");
await page.waitForFunction(() => document.querySelector('[data-k="deal_value"]').value.includes("5,00,000"));
await moveTo(page.locator('[data-k="deal_value"]'));
await sleep(2800);

// 0:55 · follow-up email
await cap("5", "“Write the follow-up.” The email is drafted from the same call.");
await page.locator("#fixInput").click();
await page.keyboard.insertText("Write the follow-up");
await page.keyboard.press("Enter");
await page.locator("#emailBody").evaluate((el) => new Promise((r) => { const t = setInterval(() => el.value.length > 100 && !document.querySelector("#emailBtn").textContent.includes("Writing") && (clearInterval(t), r()), 100); }));
await moveTo(page.locator("#emailBody"));
await sleep(4200);

// 1:04 · save
await cap("6", "“Save.” Logged, the old follow-up closed, the new one scheduled.");
await page.locator("#fixInput").click();
await page.keyboard.insertText("Save");
await page.keyboard.press("Enter");
await sleep(900);
await scrollTo(".lower");
await sleep(3800);

// 1:10 · ask your pipeline
await cap("7", "Then I ask my pipeline what to do next.");
await click(page.locator("#askChips button").first());
await page.locator(".srcs").waitFor();
await sleep(600);
await moveTo(page.locator("#answerText"));
await cap("7", "Every answer cites the calls it came from.");
await sleep(3600);
await click(page.locator(".srcs button").first());
await sleep(2400);

// 1:22 · proof
await page.goto(`${B}/proof`, { waitUntil: "networkidle" });
await cap("8", "The proof page tracks real use: calls, minutes saved, fields filled.");
await sleep(4200);

// 1:27 · why it works
await chapter("30 seconds instead of 6 minutes.", "Every field. Every follow-up.", "Built-in engine, no API key · Wispr Flow first · Ask with citations · HubSpot & CSV", 5000);
await cap(null, null);
await chapter("Sayso", "Talk for 30 seconds. Your CRM updates itself.", "Built hands-free with Wispr Flow · #NoHandsChallenge", 4500);

await cdp.send("Page.stopScreencast").catch(() => {});
await ctx.close();
await browser.close();
server.kill();

// Re-time to a steady 30 fps (each output frame shows the latest captured frame) and encode.
const FPS = 30;
const ffmpeg = findFfmpeg();
const start = frames[0].t, end = frames.at(-1).t + 0.5;
const enc = spawn(ffmpeg, [
  "-hide_banner", "-loglevel", "error", "-y",
  "-f", "image2pipe", "-c:v", "mjpeg", "-framerate", String(FPS), "-i", "pipe:0", // Playwright's build has pipe:, not "-"
  "-vf", "scale=1920:1080:flags=lanczos,format=yuv420p",
  "-c:v", "libvpx", "-b:v", "8M", "-crf", "6", "-qmin", "0", "-qmax", "24",
  "-deadline", "good", "-cpu-used", "1", "-g", String(FPS * 2), "-an", OUT,
], { stdio: ["pipe", "inherit", "inherit"] });
const done = new Promise((resolve, reject) => enc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`)))));
enc.stdin.on("error", () => {}); // if ffmpeg fails, its exit code (above) carries the error
let i = 0;
for (let t = start; t < end; t += 1 / FPS) {
  while (i + 1 < frames.length && frames[i + 1].t <= t) i++;
  if (!enc.stdin.write(readFileSync(frames[i].file))) await new Promise((r) => enc.stdin.once("drain", r));
}
enc.stdin.end();
await done;
rmSync(work, { recursive: true, force: true });
console.log(`Wrote ${path.relative(ROOT, OUT)} (${(end - start).toFixed(0)}s, 1920×1080, ${frames.length} captured frames)`);

// Playwright keeps its own ffmpeg build next to its browsers; use the newest one.
function findFfmpeg() {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(homedir(), process.platform === "darwin" ? "Library/Caches/ms-playwright" : process.platform === "win32" ? "AppData/Local/ms-playwright" : ".cache/ms-playwright");
  const bin = process.platform === "darwin" ? "ffmpeg-mac" : process.platform === "win32" ? "ffmpeg-win64.exe" : "ffmpeg-linux";
  const dirs = existsSync(cache) ? readdirSync(cache).filter((d) => d.startsWith("ffmpeg-")).sort().reverse() : [];
  for (const d of dirs) if (existsSync(path.join(cache, d, bin))) return path.join(cache, d, bin);
  throw new Error("Playwright's ffmpeg wasn't found. Run: npx playwright install ffmpeg");
}

function card(title, accent, foot) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;padding:0 60px;
    font-family:ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;color:#eef2f5;text-align:center;
    background:radial-gradient(600px 380px at 25% 25%,rgba(200,242,90,.18),transparent 70%),radial-gradient(520px 360px at 80% 20%,rgba(255,138,107,.16),transparent 70%),#06080b}
    .logo{display:flex;align-items:center;gap:12px;font-size:26px;font-weight:700}
    .logo i{width:38px;height:38px;border-radius:11px;background:#c8f25a;display:grid;place-items:center}
    h1{margin:0;font-size:64px;letter-spacing:-2px;line-height:1.08;max-width:1100px}
    h1 span{display:block;font-size:46px;margin-top:10px;background:linear-gradient(100deg,#c8f25a 10%,#f9d65c 45%,#ff8a6b 90%);-webkit-background-clip:text;background-clip:text;color:transparent}
    .foot{margin-top:14px;font:500 19px ui-monospace,Menlo,monospace;color:#8b95a1}
    </style></head><body><div class="logo"><i><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#06080b" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 3.5V17A2.5 2.5 0 0 1 4 14.5z"/><path d="M9.5 9v3M12 7.5v6M14.5 9v3"/></svg></i>Sayso</div>
    <h1>${title}<span>${accent}</span></h1><div class="foot">${foot}</div></body></html>`;
}
