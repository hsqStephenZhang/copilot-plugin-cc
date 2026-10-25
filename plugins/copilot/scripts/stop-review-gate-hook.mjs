#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createSession, getCopilotLoginStatus, runPrompt, shutdownClient } from "./lib/copilot-client.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { getConfig, listJobs } from "./lib/state.mjs";
import { SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { collectTurnChanges, markTurnReviewed } from "./lib/turn-review.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function block(reason) {
  process.stdout.write(`${JSON.stringify({ decision: "block", reason })}\n`);
}

async function main() {
  const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  if (input.stop_hook_active) {
    process.stderr.write("Copilot already blocked this turn once; skipping a repeated review to prevent a loop.\n");
    return;
  }
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = input.session_id || process.env[SESSION_ID_ENV];
  const running = listJobs(workspaceRoot).filter((job) =>
    job.claudeSessionId === sessionId && (job.status === "queued" || job.status === "running")
  );
  if (running.length) {
    process.stderr.write(`Copilot jobs are still running: ${running.map((job) => job.id).join(", ")}. Check /copilot:status.\n`);
  }
  if (!getConfig(workspaceRoot).stopReviewGate) return;
  if (running.some((job) => job.pingPongSessionId)) return;

  const changes = collectTurnChanges(workspaceRoot, sessionId);
  if (!changes) {
    process.stderr.write("No unreviewed turn snapshot is available. The gate starts tracking on the next user prompt.\n");
    return;
  }
  if (!changes.diff.trim()) return;
  markTurnReviewed(changes);

  const auth = await getCopilotLoginStatus(cwd);
  if (!auth.available || !auth.loggedIn) {
    block("The Copilot review gate is enabled but Copilot is unavailable or unauthenticated. Run /copilot:setup, or explicitly disable the gate.");
    return;
  }
  const template = loadPromptTemplate(ROOT_DIR, "stop-review-gate");
  const prompt = interpolateTemplate(template, {
    TURN_DIFF: changes.diff,
    CLAUDE_RESPONSE_BLOCK: input.last_assistant_message
      ? `Previous Claude response (context only, not proof of edits):\n${input.last_assistant_message}`
      : ""
  });
  const session = await createSession({ cwd });
  const result = await runPrompt(session, prompt, { timeoutMs: 14 * 60 * 1000 });
  const firstLine = result.content.trim().split(/\r?\n/, 1)[0];
  if (firstLine.startsWith("ALLOW:")) return;
  if (firstLine.startsWith("BLOCK:")) {
    block(`Copilot found issues in this turn's changes: ${result.content.slice("BLOCK:".length).trim()}`);
    return;
  }
  block("Copilot returned no valid ALLOW/BLOCK verdict. Run /copilot:review --wait manually, or explicitly disable the gate.");
}

main().catch((error) => {
  block(`The Copilot review gate failed: ${error.message}. Run a manual review, or explicitly disable the gate.`);
}).finally(shutdownClient).catch((error) => {
  process.stderr.write(`Copilot shutdown failed: ${error.message}\n`);
  process.exitCode = 1;
});
