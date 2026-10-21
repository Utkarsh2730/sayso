// High-quality screen recording shared by record-tour.mjs and record-demo.mjs.
//
// Capture: Chrome's screencast at 1920×1080 (pages laid out at 1280×720 and rendered at 1.5×), JPEG quality
// 100, with real timestamps. Encode: re-timed to a steady 30 fps and encoded at ~12 Mbps VP8 with Playwright's
// bundled ffmpeg (no extra install). A faint static grain is drawn over every frame so dark gradients don't
// band or turn blocky after compression.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const VIEWPORT = { width: 1280, height: 720 };
export const SCALE = 1.5;
const FPS = 30;

// Static film grain (SVG noise), plus the repaint ticker the screencast needs to keep frames flowing.
export async function prepareContext(ctx) {
  await ctx.addInitScript(() => {
    const grain = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" stitchTiles="stitch"/></filter><rect width="100%" height="100%" filter="url(#n)" opacity=".55"/></svg>')}")`;
    const mount = () => {
      if (!document.body || document.getElementById("rec-grain")) return;
      const g = document.createElement("div");
      g.id = "rec-grain";
      g.style.cssText = `position:fixed;inset:0;z-index:2147483646;pointer-events:none;background-image:${grain};opacity:.05;mix-blend-mode:overlay`;
      document.body.appendChild(g);
      const t = document.createElement("div");
      t.id = "rec-tick";
      t.style.cssText = "position:fixed;right:0;bottom:0;width:1px;height:1px;z-index:2147483647;pointer-events:none";
      document.body.appendChild(t);
      const tick = () => { t.style.background = t.style.background === "rgb(6, 8, 11)" ? "rgb(7, 8, 11)" : "rgb(6, 8, 11)"; requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    };
    if (document.readyState === "loading") addEventListener("DOMContentLoaded", mount); else mount();
  });
}

// Starts saving screencast frames for `page`; returns stop(), which resolves to the captured frames.
export async function startCapture(ctx, page, dir) {
  mkdirSync(dir, { recursive: true });
  const frames = [];
  const cdp = await ctx.newCDPSession(page);
  cdp.on("Page.screencastFrame", (f) => {
    const file = path.join(dir, `${String(frames.length).padStart(6, "0")}.jpg`);
    writeFileSync(file, Buffer.from(f.data, "base64"));
    frames.push({ file, t: f.metadata.timestamp });
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 100, maxWidth: VIEWPORT.width * SCALE, maxHeight: VIEWPORT.height * SCALE, everyNthFrame: 1 });
  return async () => {
    await cdp.send("Page.stopScreencast").catch(() => {});
    return frames;
  };
}

// Encodes captured frames to a 1080p WebM. Returns the video length in seconds.
export async function encode(frames, out) {
  if (!frames.length) throw new Error("No frames were captured.");
  const start = frames[0].t, end = frames.at(-1).t + 0.5;
  const enc = spawn(findFfmpeg(), [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "image2pipe", "-c:v", "mjpeg", "-framerate", String(FPS), "-i", "pipe:0", // Playwright's build has pipe:, not "-"
    "-vf", `scale=${VIEWPORT.width * SCALE}:${VIEWPORT.height * SCALE}:flags=lanczos,format=yuv420p`,
    "-c:v", "libvpx", "-b:v", "12M", "-crf", "4", "-qmin", "0", "-qmax", "16",
    "-deadline", "good", "-cpu-used", "0", "-g", String(FPS * 2), "-an", out,
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
  return end - start;
}

// Playwright keeps its own ffmpeg build next to its browsers; use the newest one.
function findFfmpeg() {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(homedir(), process.platform === "darwin" ? "Library/Caches/ms-playwright" : process.platform === "win32" ? "AppData/Local/ms-playwright" : ".cache/ms-playwright");
  const bin = process.platform === "darwin" ? "ffmpeg-mac" : process.platform === "win32" ? "ffmpeg-win64.exe" : "ffmpeg-linux";
  const dirs = existsSync(cache) ? readdirSync(cache).filter((d) => d.startsWith("ffmpeg-")).sort().reverse() : [];
  for (const d of dirs) if (existsSync(path.join(cache, d, bin))) return path.join(cache, d, bin);
  throw new Error("Playwright's ffmpeg wasn't found. Run: npx playwright install ffmpeg");
}
