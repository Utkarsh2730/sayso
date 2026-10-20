/**
 * Records the product tour shown on the landing page, plus the screenshots and social image it uses.
 *
 *   npm run record:tour
 *
 * Starts Debrief in demo mode (mock Claude, sample data, throwaway data file), drives it with Playwright
 * (visible cursor + captions) and writes to public/media/:
 *   debrief-tour.webm   the tour video          tour-poster.jpg  its poster frame
 *   app-review.jpg      record + email          app-ask.jpg      Ask your pipeline
 *   proof.jpg           proof page              og.png           1200×630 link-preview image
 * Needs Playwright's Chromium (`npx playwright install chromium` if it isn't cached yet).
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.join(import.meta.dirname, "..");
const MEDIA = path.join(ROOT, "public", "media");
const PORT = 4400;
const B = `http://localhost:${PORT}`;
const work = mkdtempSync(path.join(tmpdir(), "debrief-tour-"));
mkdirSync(MEDIA, { recursive: true });

console.log("Starting Debrief in demo mode…");
const server = spawn(process.execPath, ["scripts/demo.js"], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), CRM_FILE: path.join(work, "tour.json") }, stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((resolve) => server.stdout.on("data", (d) => String(d).includes("running") && resolve()));

const browser = await chromium.launch();
const SIZE = { width: 1280, height: 720 };

// ---- still images first, in their own context (no video) ----
{
  const ctx = await browser.newContext({ viewport: SIZE, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await ctx.addInitScript(() => addEventListener("DOMContentLoaded", () => {
    const st = document.createElement("style");
    // Timings come from the mock Claude and would overstate real speed, so they're hidden in recordings.
    st.textContent = "#banner{display:none!important} .rv{opacity:1!important;transform:none!important} .timing{visibility:hidden!important} header,.actions,.grid>.panel{position:static!important}";
    document.head.appendChild(st);
  }));

  await page.goto(`${B}/app`, { waitUntil: "networkidle" });
  // Mid-stream: some fields filled, the rest still loading.
  await page.getByRole("button", { name: "Try a sample recap" }).click();
  await page.waitForFunction(() => document.querySelector('[data-k="deal_value"]')?.value && document.querySelectorAll("#review label.pending").length >= 3);
  await page.locator(".grid").screenshot({ path: path.join(MEDIA, "app-stream.jpg"), type: "jpeg", quality: 82 });
  await page.waitForFunction(() => document.getElementById("liveTag").textContent.includes("ready"));
  await page.evaluate(() => scrollTo(0, 0));
  await page.waitForTimeout(800); // let the field highlight fade
  await page.screenshot({ path: path.join(MEDIA, "app-review.jpg"), type: "jpeg", quality: 82 });
  await page.getByRole("button", { name: "Draft email" }).click();
  await page.waitForFunction(() => document.getElementById("emailTiming")?.textContent.includes("written"));
  // Just the hands-free part: correction bar, suggestion chips and the drafted email.
  const top = await page.locator("#review .chips").boundingBox();
  const bottom = await page.locator("#review .actions").boundingBox();
  const panel = await page.locator("#review").boundingBox();
  await page.screenshot({
    path: path.join(MEDIA, "app-email.jpg"), type: "jpeg", quality: 82, fullPage: true,
    clip: { x: panel.x - 16, y: top.y - 16, width: panel.width + 32, height: bottom.y + bottom.height - top.y + 32 },
  });

  await page.locator("#askChips button").first().click();
  await page.locator(".srcs").waitFor();
  await page.locator("#askPanel").screenshot({ path: path.join(MEDIA, "app-ask.jpg"), type: "jpeg", quality: 82 });

  // The proof page shows the owner's real calls; feature one sample so the screenshot has content.
  await page.getByRole("button", { name: "Save to CRM" }).click().catch(() => {});
  await page.waitForTimeout(600);
  const calls = await page.evaluate(() => fetch("/api/calls").then((r) => r.json()));
  const saved = calls.calls.find((c) => !c.is_sample);
  if (saved) await page.evaluate((id) => fetch(`/api/calls/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ featured: true }) }), saved.id);
  await page.goto(`${B}/proof`, { waitUntil: "networkidle" });
  await page.screenshot({ path: path.join(MEDIA, "proof.jpg"), type: "jpeg", quality: 82 });

  await ctx.close();
  const og = await browser.newContext({ viewport: { width: 1200, height: 630 } });
  const ogPage = await og.newPage();
  await ogPage.setContent(ogCard());
  await ogPage.screenshot({ path: path.join(MEDIA, "og.jpg"), type: "jpeg", quality: 88 });
  await og.close();
}

// Reset so the tour starts from a clean sample workspace.
await fetch(`${B}/api/reset`, { method: "POST" });

// ---- the tour video ----
const ctx = await browser.newContext({ viewport: SIZE, recordVideo: { dir: work, size: SIZE } });
await ctx.addInitScript(() => {
  const css = `
    #banner{display:none!important} .rv{opacity:1!important;transform:none!important} .timing{visibility:hidden!important}
    #tour-cap{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:99999;max-width:1180px;width:max-content;
      display:flex;align-items:center;gap:14px;padding:14px 24px;border-radius:18px;background:rgba(6,8,11,.92);border:1px solid rgba(94,234,212,.35);
      color:#eef2f5;font:650 27px/1.25 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;box-shadow:0 14px 40px rgba(0,0,0,.5)}
    #tour-cap b{flex:none;display:inline-flex;align-items:center;justify-content:center;min-width:40px;height:40px;padding:0 10px;border-radius:12px;background:#5eead4;color:#04110f;font-size:21px}
    #tour-cur{position:fixed;z-index:100000;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;
      background:rgba(94,234,212,.3);border:2px solid #5eead4;pointer-events:none;transition:transform .12s}
    #tour-cur.down{transform:scale(.6);background:rgba(94,234,212,.7)}`;
  const mount = () => {
    if (document.getElementById("tour-cur")) return;
    const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
    const cur = document.createElement("div"); cur.id = "tour-cur"; document.body.appendChild(cur);
    const pos = JSON.parse(sessionStorage.getItem("tour-pos") || "[640,360]");
    cur.style.left = pos[0] + "px"; cur.style.top = pos[1] + "px";
    addEventListener("mousemove", (e) => { cur.style.left = e.clientX + "px"; cur.style.top = e.clientY + "px"; sessionStorage.setItem("tour-pos", JSON.stringify([e.clientX, e.clientY])); }, true);
    addEventListener("mousedown", () => cur.classList.add("down"), true);
    addEventListener("mouseup", () => cur.classList.remove("down"), true);
    window.__cap = (step, text) => {
      sessionStorage.setItem("tour-cap", JSON.stringify([step, text]));
      let el = document.getElementById("tour-cap");
      if (!text) { el?.remove(); return; }
      if (!el) { el = document.createElement("div"); el.id = "tour-cap"; document.body.appendChild(el); }
      el.innerHTML = (step ? `<b>${step}</b>` : "") + `<span>${text}</span>`;
    };
    const saved = JSON.parse(sessionStorage.getItem("tour-cap") || "null");
    if (saved && saved[1]) window.__cap(saved[0], saved[1]);
  };
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", mount); else mount();
});

const page = await ctx.newPage();
const sleep = (ms) => page.waitForTimeout(ms);
const cap = (step, text) => page.evaluate(([s, t]) => window.__cap?.(s, t), [step, text]);
const moveTo = async (loc) => {
  await loc.scrollIntoViewIfNeeded();
  const box = await loc.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 24 });
  await sleep(200);
};
const click = async (loc) => { await moveTo(loc); await loc.click(); };

// 0 · intro card
await page.setContent(card("Talk for 30 seconds.", "Your CRM updates itself.", "Product tour · sample data"));
await sleep(3500);

// 1 · the recap, dictated in phrases the way the Wispr Flow desktop app inserts them
await page.goto(`${B}/app`, { waitUntil: "networkidle" });
await cap("1", "Right after a call, hold your Wispr Flow key and talk.");
await click(page.locator("#transcript"));
const RECAP = await page.evaluate(() => SAMPLE);
for (const phrase of RECAP.match(/[^,.]+[,.]?/g)) {
  await page.keyboard.insertText(phrase);
  await sleep(170);
}
await sleep(700);

// 2 · streaming extraction
await cap("2", "Claude fills in the CRM record while it's still writing.");
await click(page.getByRole("button", { name: "Extract CRM fields" }));
await page.waitForFunction(() => document.getElementById("liveTag").textContent.includes("ready"));
await sleep(1800);

// 3 · voice correction
await cap("3", "Something wrong? Just say it. Only that field changes.");
await click(page.locator('[data-say="Change the stage to proposal"]'));
await page.locator('[data-k="deal_stage"]').evaluate((el) => new Promise((r) => { const t = setInterval(() => el.value === "proposal" && (clearInterval(t), r()), 100); }));
await moveTo(page.locator('[data-k="deal_stage"]'));
await sleep(2200);

// 4 · follow-up email
await cap("4", "“Write the follow-up” drafts the email from the same call.");
await click(page.locator('[data-say="Write the follow-up email"]'));
await page.locator("#emailBody").evaluate((el) => new Promise((r) => { const t = setInterval(() => el.value.length > 100 && !document.querySelector("#emailBtn").textContent.includes("Writing") && (clearInterval(t), r()), 100); }));
await moveTo(page.locator("#emailBody"));
await sleep(3000);

// 5 · save
await cap("5", "“Save.” Logged, with the follow-up date in your list.");
await click(page.locator('[data-say="Save"]'));
await sleep(1200);
await moveTo(page.locator("#due"));
await sleep(2200);

// 6 · ask your pipeline
await cap("6", "Then ask your pipeline anything. Answers cite the calls.");
await click(page.locator("#askChips button").first());
await page.locator(".srcs").waitFor();
await moveTo(page.locator("#answerText"));
await sleep(2600);
await click(page.locator(".srcs button").first());
await sleep(2200);

// 7 · proof
await page.goto(`${B}/proof`, { waitUntil: "networkidle" });
await cap("7", "Every call adds up: time saved, fields filled, follow-ups sent.");
await sleep(3200);
await cap(null, null);

// outro
await page.setContent(card("Stop typing up calls.", "Start talking them down.", "Built hands-free with Wispr Flow · #NoHandsChallenge"));
await sleep(3500);

const video = page.video();
await ctx.close();
renameSync(await video.path(), path.join(MEDIA, "debrief-tour.webm"));

// poster: the record mid-review, from the still screenshots context
{
  const c = await browser.newContext({ viewport: SIZE });
  const p = await c.newPage();
  await p.setContent(card("Talk for 30 seconds.", "Your CRM updates itself.", "▶ Watch the 60-second tour"));
  await p.screenshot({ path: path.join(MEDIA, "tour-poster.jpg"), type: "jpeg", quality: 85 });
  await c.close();
}

await browser.close();
server.kill();
rmSync(work, { recursive: true, force: true });
console.log("Wrote:", readdirSync(MEDIA).join(", "));

function card(title, accent, foot) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;
    font-family:ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;color:#eef2f5;
    background:radial-gradient(600px 380px at 25% 25%,rgba(94,234,212,.18),transparent 70%),radial-gradient(520px 360px at 80% 20%,rgba(167,139,250,.16),transparent 70%),#06080b}
    .logo{display:flex;align-items:center;gap:12px;font-size:28px;font-weight:700}
    .logo i{width:40px;height:40px;border-radius:11px;background:#5eead4;display:grid;place-items:center}
    h1{margin:0;font-size:72px;letter-spacing:-2px;text-align:center;line-height:1.05}
    h1 span{display:block;background:linear-gradient(100deg,#5eead4 10%,#22d3ee 45%,#a78bfa 90%);-webkit-background-clip:text;background-clip:text;color:transparent}
    .foot{margin-top:14px;font:500 20px ui-monospace,Menlo,monospace;color:#8b95a1}
    </style></head><body><div class="logo"><i><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#06080b" stroke-width="2.6" stroke-linecap="round"><path d="M5 10v4M9 6v12M13 8v8M17 11v2M21 9v6"/></svg></i>Debrief</div>
    <h1>${title}<span>${accent}</span></h1><div class="foot">${foot}</div></body></html>`;
}

function ogCard() {
  return card("Talk for 30 seconds.", "Your CRM updates itself.", "Voice-first CRM for sales calls · #NoHandsChallenge");
}
