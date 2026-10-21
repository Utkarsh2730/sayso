import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { stats, buildProof, scrub } from "./stats.js";

export { stats, buildProof, scrub };

const PROOF_FILE = process.env.PROOF_FILE || path.join(import.meta.dirname, "..", "data", "proof.json");

export async function readProofSnapshot() {
  try {
    return JSON.parse(await readFile(PROOF_FILE, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

export async function writeProofSnapshot(proof) {
  await mkdir(path.dirname(PROOF_FILE), { recursive: true });
  await writeFile(PROOF_FILE, JSON.stringify(proof, null, 2));
  return PROOF_FILE;
}
