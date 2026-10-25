import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { runCommand, runCommandChecked } from "./process.mjs";
import { resolveStateDir } from "./state.mjs";

const MAX_REVIEW_BYTES = 256 * 1024;

export function resolveTurnFile(workspaceRoot, sessionId) {
  if (!sessionId) throw new Error("The review gate requires a Claude session ID.");
  const id = createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
  return path.join(resolveStateDir(workspaceRoot), `turn-${id}.json`);
}

export function clearTurnSnapshot(workspaceRoot, sessionId) {
  fs.rmSync(resolveTurnFile(workspaceRoot, sessionId), { force: true });
}

export function captureWorkingTree(workspaceRoot) {
  const stateDir = resolveStateDir(workspaceRoot);
  fs.mkdirSync(stateDir, { recursive: true });
  const temporaryDir = fs.mkdtempSync(path.join(stateDir, "snapshot-"));
  const env = { ...process.env, GIT_INDEX_FILE: path.join(temporaryDir, "index") };
  const options = { cwd: workspaceRoot, env, timeout: 20000 };
  try {
    const head = runCommand("git", ["rev-parse", "--verify", "HEAD"], options);
    runCommandChecked("git", ["read-tree", head.status === 0 ? "HEAD" : "--empty"], options);
    runCommandChecked("git", ["add", "-A", "--", "."], options);
    return runCommandChecked("git", ["write-tree"], options).stdout.trim();
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
}

export function recordTurnStart(workspaceRoot, sessionId) {
  const file = resolveTurnFile(workspaceRoot, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let snapshot;
  try {
    snapshot = { tree: captureWorkingTree(workspaceRoot) };
  } catch (error) {
    snapshot = { error: error.message };
    throw error;
  } finally {
    fs.writeFileSync(file, `${JSON.stringify(snapshot)}\n`);
  }
}

export function collectTurnChanges(workspaceRoot, sessionId) {
  const file = resolveTurnFile(workspaceRoot, sessionId);
  if (!fs.existsSync(file)) return null;
  const baseline = JSON.parse(fs.readFileSync(file, "utf8"));
  if (baseline.error) throw new Error(`Could not snapshot the start of this turn: ${baseline.error}`);
  if (baseline.reviewed) return null;
  if (!/^[a-f0-9]{40,64}$/.test(baseline.tree)) throw new Error("Invalid turn snapshot tree.");
  const tree = captureWorkingTree(workspaceRoot);
  const diff = runCommandChecked("git", [
    "diff", "--no-ext-diff", "--no-textconv", "--binary", baseline.tree, tree, "--"
  ], { cwd: workspaceRoot, timeout: 20000, maxBuffer: MAX_REVIEW_BYTES + 1024 }).stdout;
  if (Buffer.byteLength(diff) > MAX_REVIEW_BYTES) {
    throw new Error("This turn's diff is too large for the automatic gate. Run a manual review.");
  }
  return { file, baseline, diff };
}

export function markTurnReviewed(changes) {
  fs.writeFileSync(changes.file, `${JSON.stringify({ ...changes.baseline, reviewed: true })}\n`);
}
