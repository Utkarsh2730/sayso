// Daily usage limits for Claude-backed endpoints on the public demo, so a shared link can't run up the bill.
const counters = new Map();
let day = new Date().toISOString().slice(0, 10);

function bump(key, limit) {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) { counters.clear(); day = today; }
  const n = (counters.get(key) ?? 0) + 1;
  if (n > limit) return false;
  counters.set(key, n);
  return true;
}

export function allowAiCall({ workspaceId, ip }) {
  const perWorkspace = Number(process.env.LIMIT_PER_WORKSPACE ?? 40);
  const perIp = Number(process.env.LIMIT_PER_IP ?? 80);
  const global = Number(process.env.LIMIT_GLOBAL ?? 1500);
  if (!bump("global", global)) return "The demo has hit today's usage limit. Please try again tomorrow.";
  if (!bump(`ip:${ip}`, perIp)) return "You've hit today's demo limit from this network. Please try again tomorrow.";
  if (!bump(`ws:${workspaceId}`, perWorkspace)) return "You've hit today's demo limit for this workspace. Please try again tomorrow.";
  return null;
}
