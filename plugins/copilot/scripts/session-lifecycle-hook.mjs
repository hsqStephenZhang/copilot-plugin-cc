#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { terminateProcessTree } from "./lib/process.mjs";
import { listJobs, upsertJob, writeJobFile } from "./lib/state.mjs";
import { readStoredJob } from "./lib/job-control.mjs";
import { clearTurnSnapshot } from "./lib/turn-review.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

export const SESSION_ID_ENV = "COPILOT_COMPANION_SESSION_ID";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

function readHookInput() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") return;
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) return;
  try {
    const workspaceRoot = resolveWorkspaceRoot(cwd);
    clearTurnSnapshot(workspaceRoot, sessionId);
    const sessionJobs = listJobs(workspaceRoot).filter((job) => job.claudeSessionId === sessionId);
    if (sessionJobs.length === 0) return;

    for (const job of sessionJobs) {
      if (job.status === "queued" || job.status === "running") {
        terminateProcessTree(job.pid ?? Number.NaN);
        const cancelled = {
          ...job,
          status: "cancelled",
          phase: "cancelled",
          pid: null,
          completedAt: new Date().toISOString(),
          errorMessage: "The owning Claude session ended."
        };
        writeJobFile(workspaceRoot, job.id, { ...readStoredJob(workspaceRoot, job.id), ...cancelled });
        upsertJob(workspaceRoot, cancelled);
      }
    }
  } catch (error) {
    process.stderr.write(`Copilot session cleanup failed: ${error.message}\n`);
  }
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
}

function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  cleanupSessionJobs(cwd, input.session_id || process.env[SESSION_ID_ENV]);
}

async function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }
  if (eventName === "SessionEnd") {
    handleSessionEnd(input);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
