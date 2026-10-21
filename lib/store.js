import { readFile, writeFile, rename, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

const DATA_DIR = path.join(import.meta.dirname, "..", "data");
const DEFAULT_FILE = process.env.CRM_FILE || path.join(DATA_DIR, "crm.json");
const WS_DIR = process.env.WORKSPACE_DIR || path.join(DATA_DIR, "workspaces");
const MAX_CACHED = 500;

export const isWorkspaceId = (id) => id === "default" || /^[0-9a-f-]{36}$/.test(id);

// One workspace = one list of calls held in memory and written to disk in order
// (temp file + rename, so a crash mid-write never leaves a corrupt file).
class Workspace {
  constructor(file) {
    this.file = file;
    this.calls = null;
    this.writing = Promise.resolve();
  }

  async load() {
    if (this.calls) return this.calls;
    try {
      this.calls = JSON.parse(await readFile(this.file, "utf8"));
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      this.calls = [];
    }
    return this.calls;
  }

  persist() {
    const snapshot = JSON.stringify(this.calls, null, 2);
    this.writing = this.writing.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, snapshot);
      await rename(tmp, this.file);
    }).catch((err) => console.error("Failed to write CRM file:", err));
    return this.writing;
  }

  async list() {
    return this.load();
  }

  // The company profile (who's using Sayso and what they sell) sits next to the calls, in its own file.
  async getProfile() {
    if (this.profile !== undefined) return this.profile;
    try {
      this.profile = JSON.parse(await readFile(this.profileFile(), "utf8"));
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      this.profile = null;
    }
    return this.profile;
  }

  async setProfile(profile) {
    this.profile = profile;
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.profileFile(), JSON.stringify(profile, null, 2));
    return profile;
  }

  profileFile() {
    return this.file.replace(/\.json$/, ".profile.json");
  }

  async replaceCalls(calls) {
    await this.load();
    this.calls = calls;
    this.persist();
  }

  async add(call) {
    await this.load();
    const saved = { id: randomUUID(), created_at: new Date().toISOString(), ...call };
    this.calls.unshift(saved);
    this.persist();
    return saved;
  }

  async update(id, changes) {
    await this.load();
    const call = this.calls.find((c) => c.id === id);
    if (!call) return null;
    Object.assign(call, changes);
    this.persist();
    return call;
  }

  async remove(id) {
    await this.load();
    const before = this.calls.length;
    this.calls = this.calls.filter((c) => c.id !== id);
    if (this.calls.length !== before) this.persist();
    return this.calls.length !== before;
  }
}

const cache = new Map();

export function workspace(id = "default") {
  if (!isWorkspaceId(id)) throw new Error("Invalid workspace id");
  let ws = cache.get(id);
  if (ws) {
    cache.delete(id); // move to most-recently-used
  } else {
    ws = new Workspace(id === "default" ? DEFAULT_FILE : path.join(WS_DIR, `${id}.json`));
    if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value);
  }
  cache.set(id, ws);
  return ws;
}

// Resolves once every queued write has hit the disk (used by tests and on shutdown).
export const flush = () => Promise.all([...cache.values()].map((ws) => ws.writing));

// Public-mode visitor workspaces are disposable; drop ones untouched for `days`.
export async function pruneWorkspaces(days = 7) {
  let files;
  try {
    files = await readdir(WS_DIR);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - days * 86400000;
  let removed = 0;
  for (const f of files) {
    const p = path.join(WS_DIR, f);
    if ((await stat(p)).mtimeMs < cutoff) await unlink(p).then(() => removed++, () => {});
  }
  return removed;
}

export { toCsv } from "./csv.js";
