import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createSession, ensureClient, shutdownClient } from "./copilot-client.mjs";
import { writeJsonFile } from "./fs.mjs";
import { readStoredJob } from "./job-control.mjs";
import { terminateProcessTree } from "./process.mjs";
import { generateJobId, loadState, resolveJobFile, resolveJobLogFile, resolveStateFile, updateState, upsertJob, writeJobFile } from "./state.mjs";
import { executeTaskPrompt } from "./task-execution.mjs";
import { createJobLogFile, createJobProgressUpdater, createJobRecord, createProgressReporter, runTrackedJob, SESSION_ID_ENV } from "./tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

const LIVE_STATUSES = new Set(["starting", "busy", "idle", "paused", "stopping"]);
const MAX_ROUNDS = 5;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function requireOwner(owner = process.env[SESSION_ID_ENV]) {
  if (!owner) throw new Error("Ping-pong requires a Claude session ID. Start it from the current Claude conversation.");
  return owner;
}

function sessionKey(owner) {
  return createHash("sha256").update(owner).digest("hex");
}

export function getPingPongSession(cwd, owner = requireOwner()) {
  return loadState(cwd).pingPongSessions[sessionKey(owner)] ?? null;
}

function changeSession(cwd, owner, instanceId, mutate) {
  return updateState(cwd, (state) => {
    const record = state.pingPongSessions[sessionKey(owner)];
    if (!record || record.id !== instanceId) throw new Error("The Ping-pong session was replaced or removed.");
    mutate(record);
    record.updatedAt = new Date().toISOString();
  }).pingPongSessions[sessionKey(owner)];
}

function daemonAlive(record) {
  if (!Number.isInteger(record.pid) || record.pid <= 0) return false;
  try {
    process.kill(record.pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

export function readPingPongStatus(cwd) {
  const record = getPingPongSession(cwd);
  if (record?.pid && LIVE_STATUSES.has(record.status) && !daemonAlive(record)) {
    throw new Error("The Ping-pong worker exited unexpectedly. Stop it, then start a new session; no automatic retry was submitted.");
  }
  return record;
}

function cancelCurrentJob(cwd, record, reason) {
  if (!record.currentJobId) return;
  const job = readStoredJob(cwd, record.currentJobId);
  if (!job || !["queued", "running"].includes(job.status)) return;
  const cancelled = {
    ...job, status: "cancelled", phase: "cancelled", pid: null,
    completedAt: new Date().toISOString(), errorMessage: reason
  };
  upsertJob(cwd, cancelled);
  writeJobFile(cwd, job.id, cancelled);
}

function requestStop(cwd, owner, record) {
  const next = changeSession(cwd, owner, record.id, (current) => {
    current.stopRequested = true;
    current.status = "stopping";
  });
  cancelCurrentJob(cwd, next, "The owning Ping-pong session stopped.");
  return next;
}

export async function stopPingPongSession(cwd, owner = requireOwner()) {
  requireOwner(owner);
  const record = getPingPongSession(cwd, owner);
  if (!record || !LIVE_STATUSES.has(record.status)) return record;
  requestStop(cwd, owner, record);
  if (!daemonAlive(record)) {
    return changeSession(cwd, owner, record.id, (current) => {
      current.status = "stopped";
      current.pid = null;
      current.currentJobId = null;
    });
  }
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const current = getPingPongSession(cwd, owner);
    if (current.id !== record.id || !LIVE_STATUSES.has(current.status)) return current;
    await sleep(50);
  }
  throw new Error("The Ping-pong worker did not acknowledge shutdown. Its stop request remains recorded; inspect /copilot:ping-pong status.");
}

export function finishPingPongTask(cwd, after, owner = requireOwner()) {
  const record = getPingPongSession(cwd, owner);
  if (!record || !["idle", "paused"].includes(record.status)) {
    throw new Error("Only an idle Ping-pong task can be marked finished.");
  }
  return changeSession(cwd, owner, record.id, (current) => {
    if (!after || current.lastJobId !== after || !["idle", "paused"].includes(current.status)) {
      throw new Error("The Ping-pong result has advanced. Refresh status before marking it finished.");
    }
    current.taskComplete = true;
  });
}

export async function submitPingPongTurn(cwd, options) {
  const owner = requireOwner();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const prompt = options.prompt?.trim();
  if (!prompt) throw new Error("Provide a Ping-pong prompt or --prompt-file.");
  const action = options.action ?? "start";
  let record;
  let job;
  let startWorker = false;
  updateState(workspaceRoot, (state) => {
    const key = sessionKey(owner);
    const previous = state.pingPongSessions[key];
    startWorker = !previous || !LIVE_STATUSES.has(previous.status);
    if (startWorker && action !== "start") throw new Error("No resident Ping-pong session. Use /copilot:ping-pong start first.");
    if (!startWorker) {
      if (!["idle", "paused"].includes(previous.status)) throw new Error(`Ping-pong is ${previous.status}; wait for its current turn or stop it.`);
      if (!daemonAlive(previous)) throw new Error("The Ping-pong worker exited unexpectedly. Stop it, then start a new session.");
      if (options.model !== undefined || options.effort !== undefined || options.write !== undefined) {
        throw new Error("Model, effort, and write permission are fixed for the resident session. Stop and start it to change them.");
      }
      if (action === "start" && !previous.taskComplete) throw new Error("A task is already open. Use send, or explicitly continue after its round limit.");
      if (action === "send" && (previous.taskComplete || previous.round >= previous.maxRounds)) {
        throw new Error("This Ping-pong batch is finished or has reached its five-round limit. An explicit user continuation is required.");
      }
      if (action === "send" && (!options.after || previous.lastJobId !== options.after)) {
        throw new Error("send requires --after <latest-completed-job-id>; the result may already have advanced.");
      }
      if (action === "continue" && !previous.taskComplete && previous.round < previous.maxRounds) {
        throw new Error("The current batch still has rounds available. Use send without resetting the limit.");
      }
    }
    record = startWorker ? {
      id: generateJobId("ping"), claudeSessionId: owner, cwd: path.resolve(cwd),
      status: "starting", pid: null, copilotSessionId: null,
      model: options.model ?? null, effort: options.effort ?? null, write: Boolean(options.write),
      round: 0, maxRounds: MAX_ROUNDS, createdAt: new Date().toISOString()
    } : { ...previous };
    if (action !== "send") record.round = 0;
    record.round += 1;
    record.taskComplete = false;
    record.stopRequested = false;
    record.updatedAt = new Date().toISOString();
    record.logFile = resolveJobLogFile(workspaceRoot, record.id);
    job = createJobRecord({
      id: generateJobId("ping-turn"), kind: "ping-pong", kindLabel: "ping-pong",
      title: `Copilot Ping-pong (${record.round}/${record.maxRounds})`, jobClass: "task",
      workspaceRoot, summary: prompt.replace(/\s+/g, " ").slice(0, 96), write: record.write,
      pingPongSessionId: record.id, round: record.round, maxRounds: record.maxRounds,
      status: "queued", phase: "queued", pid: record.pid,
      request: { cwd: record.cwd, prompt, write: record.write }
    });
    record.currentJobId = job.id;
    if (!startWorker) record.status = "busy";
    writeJsonFile(resolveJobFile(workspaceRoot, job.id), job);
    state.jobs.unshift(job);
    state.pingPongSessions[key] = record;
  });

  if (startWorker) {
    let logFd;
    try {
      const logFile = createJobLogFile(workspaceRoot, record.id, "Copilot Ping-pong worker");
      logFd = fs.openSync(logFile, "a");
      const workerPath = fileURLToPath(new URL("../ping-pong-worker.mjs", import.meta.url));
      const child = spawn(process.execPath, [workerPath, workspaceRoot, record.id], {
        cwd: record.cwd, env: process.env, detached: true,
        stdio: ["ignore", logFd, logFd], windowsHide: true
      });
      let exited;
      child.once("exit", (code, signal) => { exited = `code ${code}, signal ${signal ?? "none"}`; });
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      child.unref();
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        record = getPingPongSession(workspaceRoot, owner);
        if (record.status === "failed") throw new Error(record.errorMessage);
        if (exited) throw new Error(`Ping-pong worker exited during startup (${exited}). See ${logFile}.`);
        if (record.status !== "starting") break;
        await sleep(50);
      }
      if (!["busy", "idle", "paused"].includes(record.status)) {
        throw new Error("Ping-pong startup timed out or was cancelled.");
      }
    } catch (error) {
      await stopPingPongSession(workspaceRoot, owner);
      throw error;
    } finally {
      if (logFd !== undefined) fs.closeSync(logFd);
    }
  }
  return {
    session: getPingPongSession(workspaceRoot, owner),
    jobId: job.id, jobFile: resolveJobFile(workspaceRoot, job.id), status: "queued"
  };
}

export async function runPingPongWorker(cwd, instanceId) {
  const owner = requireOwner();
  const initial = getPingPongSession(cwd, owner);
  if (!initial || initial.id !== instanceId || initial.status !== "starting") {
    throw new Error("No matching starting Ping-pong session.");
  }
  changeSession(cwd, owner, instanceId, (current) => {
    if (current.status !== "starting" || current.stopRequested || current.pid !== null) {
      throw new Error("The Ping-pong worker was already claimed or stopped.");
    }
    current.pid = process.pid;
  });
  let session;
  let stopping = false;
  let fatalError;
  let permissionDenied;
  let turnActive = false;
  let wake;
  let shutdownTimer;
  const stateFile = resolveStateFile(cwd);
  const beginStop = () => {
    if (stopping) return;
    stopping = true;
    wake?.();
    shutdownTimer = setTimeout(() => {
      const message = "Ping-pong graceful shutdown timed out; terminating its process tree.";
      process.stderr.write(`${message}\n`);
      try {
        changeSession(cwd, owner, instanceId, (record) => {
          record.status = "failed";
          record.errorMessage = message;
          record.pid = null;
        });
      } finally {
        process.off("SIGTERM", onSignal);
        process.off("SIGINT", onSignal);
        const result = terminateProcessTree(process.pid);
        if (!result.delivered) process.kill(process.pid, "SIGTERM");
      }
    }, 8000);
    if (session && turnActive) {
      session.abort().catch((error) => {
        fatalError = error;
        process.stderr.write(`Ping-pong abort failed: ${error.message}\n`);
      });
    }
  };
  const onChange = () => {
    try {
      const current = getPingPongSession(cwd, owner);
      if (!current || current.id !== instanceId || current.stopRequested) beginStop();
      wake?.();
    } catch (error) {
      fatalError = error;
      beginStop();
    }
  };
  const onSignal = () => {
    try {
      requestStop(cwd, owner, getPingPongSession(cwd, owner));
    } catch (error) {
      fatalError = error;
    }
    beginStop();
  };
  fs.watchFile(stateFile, { interval: 100 }, onChange);
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  try {
    const client = await ensureClient();
    const auth = await client.getAuthStatus();
    if (!auth.isAuthenticated) throw new Error("Copilot is not authenticated. Run /copilot:setup.");
    session = await createSession({
      cwd: initial.cwd, model: initial.model, reasoningEffort: initial.effort,
      sessionId: instanceId, write: initial.write,
      onPermissionDenied: (reason) => { permissionDenied = reason; }
    });
    changeSession(cwd, owner, instanceId, (current) => {
      current.copilotSessionId = session.sessionId;
      if (!current.stopRequested) current.status = "busy";
    });
    onChange();
    while (!stopping) {
      const current = getPingPongSession(cwd, owner);
      if (!current.currentJobId) {
        await new Promise((resolve) => { wake = resolve; });
        wake = null;
        continue;
      }
      const job = readStoredJob(cwd, current.currentJobId);
      if (!job || job.status !== "queued") throw new Error("The queued Ping-pong turn is missing or no longer executable.");
      permissionDenied = null;
      const logFile = createJobLogFile(cwd, job.id, job.title);
      const progress = createProgressReporter({ logFile, onEvent: createJobProgressUpdater(cwd, job.id) });
      turnActive = true;
      const execution = await runTrackedJob(job, async () => {
        const result = await executeTaskPrompt(session, { ...job.request, jobId: job.id, onProgress: progress }, {
          title: job.title, keepAlive: true
        });
        turnActive = false;
        if (permissionDenied) throw new Error(`Ping-pong paused: ${permissionDenied}`);
        return result;
      }, {
        logFile,
        onError: (error) => changeSession(cwd, owner, instanceId, (record) => {
          record.lastJobId = job.id;
          record.currentJobId = null;
          if (!record.stopRequested) {
            record.status = "failed";
            record.errorMessage = error.message;
          }
        }),
        onComplete: (result) => changeSession(cwd, owner, instanceId, (record) => {
          record.lastJobId = job.id;
          record.currentJobId = null;
          if (!record.stopRequested) record.status = result.exitStatus !== 0 ? "failed" : record.round >= record.maxRounds ? "paused" : "idle";
        })
      });
      if (execution.exitStatus !== 0) throw new Error("Copilot returned no usable output; automatic Ping-pong has paused.");
    }
    if (fatalError) throw fatalError;
  } catch (error) {
    turnActive = false;
    const current = getPingPongSession(cwd, owner);
    if (!current?.stopRequested) {
      changeSession(cwd, owner, instanceId, (record) => {
        record.status = "failed";
        record.errorMessage = error.message;
        record.lastJobId = record.currentJobId ?? record.lastJobId;
      });
      const job = current?.currentJobId ? readStoredJob(cwd, current.currentJobId) : null;
      if (job && ["queued", "running"].includes(job.status)) {
        const failed = { ...job, status: "failed", phase: "failed", pid: null, errorMessage: error.message, completedAt: new Date().toISOString() };
        upsertJob(cwd, failed);
        writeJobFile(cwd, job.id, failed);
      }
      throw error;
    }
  } finally {
    beginStop();
    fs.unwatchFile(stateFile, onChange);
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    try {
      try {
        if (session) await session.disconnect();
      } finally {
        await shutdownClient();
      }
    } catch (error) {
      changeSession(cwd, owner, instanceId, (record) => {
        record.status = "failed";
        record.errorMessage = `Ping-pong shutdown failed: ${error.message}`;
      });
      throw error;
    } finally {
      if (shutdownTimer) clearTimeout(shutdownTimer);
      changeSession(cwd, owner, instanceId, (record) => {
        if (record.status !== "failed") record.status = "stopped";
        record.pid = null;
        record.currentJobId = null;
      });
    }
  }
}
