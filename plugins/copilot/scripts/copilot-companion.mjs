#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
    buildPersistentTaskSessionId,
    DEFAULT_CONTINUE_PROMPT,
    createSession,
    runPrompt,
    shutdownClient,
    getCopilotAvailability,
    getCopilotLoginStatus,
    getSessionRuntimeStatus,
    parseStructuredOutput
  } from "./lib/copilot-client.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  generateJobId,
  getConfig,
  listJobs,
  resolveJobFile,
  setConfig,
  upsertJob,
  updateState,
  writeJobFile
} from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  findResumableTask,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import { executeTaskPrompt } from "./lib/task-execution.mjs";
import { finishPingPongTask, readPingPongStatus, stopPingPongSession, submitPingPongTurn } from "./lib/ping-pong.mjs";
import {
  renderReviewResult,
  renderNativeReviewResult,
  renderStoredJobResult,
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const VALID_REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const MODEL_ALIASES = new Map([
  ["codex", "gpt-5.3-codex"],
  ["gemini", "gemini-3.1-pro"]
]);

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/copilot-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--json]",
      "  node scripts/copilot-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>]",
      "  node scripts/copilot-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [focus text]",
      "  node scripts/copilot-companion.mjs task [--background|--wait] [--write] [--resume-last|--resume|--fresh] [--model <model|codex|gemini>] [--effort <low|medium|high|xhigh|max>] [prompt]",
      "  node scripts/copilot-companion.mjs ping-pong start [--write] [--model <id>] [--effort <value>] [--prompt-file <path>] [prompt]",
      "  node scripts/copilot-companion.mjs ping-pong send --after <completed-job-id> [--prompt-file <path>] [prompt]",
      "  node scripts/copilot-companion.mjs ping-pong continue [--prompt-file <path>] [prompt]",
      "  node scripts/copilot-companion.mjs ping-pong finish --after <completed-job-id>",
      "  node scripts/copilot-companion.mjs ping-pong <status|stop> [--json]",
      "  node scripts/copilot-companion.mjs status [job-id] [--all] [--json]",
      "  node scripts/copilot-companion.mjs result [job-id] [--json]",
      "  node scripts/copilot-companion.mjs cancel [job-id] [--json]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeRequestedModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return MODEL_ALIASES.get(normalized.toLowerCase()) ?? normalized;
}

function normalizeReasoningEffort(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    throw new Error(
      `Unsupported reasoning effort "${effort}". Use one of: low, medium, high, xhigh, max.`
    );
  }
  return normalized;
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

async function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const copilotStatus = getCopilotAvailability(cwd);
  const authStatus = await getCopilotLoginStatus(cwd);
  const config = getConfig(workspaceRoot);

  const nextSteps = [];
  if (!copilotStatus.available) {
    nextSteps.push("Install Copilot CLI with `npm install -g @github/copilot-cli`.");
  }
  if (copilotStatus.available && !authStatus.loggedIn) {
    nextSteps.push("Run `!copilot login`.");
    nextSteps.push("If browser login is blocked, retry with `!copilot login --device-code`. For token-based login, run `copilot login --with-token` interactively; never include tokens in Claude messages or command arguments.");
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `/copilot:setup --enable-review-gate` to require a fresh review before stop.");
  }

  return {
    ready: nodeStatus.available && copilotStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    copilot: copilotStatus,
    auth: authStatus,
    sessionRuntime: getSessionRuntimeStatus(),
    reviewGateEnabled: Boolean(config.stopReviewGate),
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

function buildAdversarialReviewPrompt(context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
  return interpolateTemplate(template, {
    REVIEW_KIND: "Adversarial Review",
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_INPUT: context.content
  });
}

async function ensureCopilotReady(cwd) {
  const authStatus = await getCopilotLoginStatus(cwd);
  if (!authStatus.available) {
    throw new Error("Copilot CLI is not installed or is missing required runtime support. Install it with `npm install -g @github/copilot-cli`, then rerun `/copilot:setup`.");
  }
  if (!authStatus.loggedIn) {
    throw new Error("Copilot is not authenticated. Run `!copilot login`, then rerun `/copilot:setup`.");
  }
}

function renderStatusPayload(report, asJson) {
  return asJson ? report : renderStatusReport(report);
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

async function resolveLatestTrackedTaskSession(workspaceRoot, options = {}) {
  const task = findResumableTask(
    listJobs(workspaceRoot), process.env[SESSION_ID_ENV], options.excludeJobId
  );
  return task ? { id: task.copilotSessionId } : null;
}

async function executeReviewRun(request) {
  await ensureCopilotReady(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";
  const context = collectReviewContext(request.cwd, target);

  let prompt;
  let isStructured = false;
  if (reviewName === "Adversarial Review") {
    prompt = buildAdversarialReviewPrompt(context, focusText);
    isStructured = true;
  } else {
    // Regular review: plain prompt with diff context
    prompt = [
      `Please review the following ${target.label} diff and provide a code review.`,
      focusText ? `Focus on: ${focusText}` : "",
      "",
      context.content
    ].filter(Boolean).join("\n");
  }

  const session = await createSession({
    model: request.model,
    cwd: request.cwd,
    systemMessage: isStructured
      ? `You are Copilot performing an adversarial software review. Return only JSON matching this schema:\n${fs.readFileSync(REVIEW_SCHEMA, "utf8")}`
      : "You are Copilot performing a code review. Provide clear, actionable feedback."
  });

  const result = await runPrompt(session, prompt, { onProgress: request.onProgress });
  const rawOutput = result.content ?? "";

  if (isStructured) {
    const parsed = parseStructuredOutput(rawOutput, {
      failureMessage: result.error?.message ?? ""
    });
    const payload = {
      review: reviewName,
      target,
      sessionId: result.sessionId,
      context: {
        repoRoot: context.repoRoot,
        branch: context.branch,
        summary: context.summary
      },
      copilot: {
        status: rawOutput ? 0 : 1,
        stdout: rawOutput,
        reasoning: result.reasoning
      },
      result: parsed.parsed,
      rawOutput: parsed.rawOutput,
      parseError: parsed.parseError,
      reasoningSummary: result.reasoning ? [result.reasoning] : []
    };
    return {
      exitStatus: rawOutput ? 0 : 1,
      copilotSessionId: result.sessionId,
      payload,
      rendered: renderReviewResult(parsed, {
        reviewLabel: reviewName,
        targetLabel: context.target.label,
        reasoningSummary: result.reasoning ? [result.reasoning] : []
      }),
      summary: parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(rawOutput, `${reviewName} finished.`),
      jobTitle: `Copilot ${reviewName}`,
      jobClass: "review",
      targetLabel: context.target.label
    };
  }

  // Plain review result
  const payload = {
    review: reviewName,
    target,
    sessionId: result.sessionId,
    copilot: {
      status: rawOutput ? 0 : 1,
      stdout: rawOutput,
      reasoning: result.reasoning
    }
  };
  return {
    exitStatus: rawOutput ? 0 : 1,
    copilotSessionId: result.sessionId,
    payload,
    rendered: renderNativeReviewResult(
      { stdout: rawOutput, stderr: "", status: rawOutput ? 0 : 1 },
      { reviewLabel: reviewName, targetLabel: context.target.label }
    ),
    summary: firstMeaningfulLine(rawOutput, `${reviewName} completed.`),
    jobTitle: `Copilot ${reviewName}`,
    jobClass: "review",
    targetLabel: context.target.label
  };
}

async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  await ensureCopilotReady(request.cwd);

  let sessionId = null;
  if (request.resumeLast) {
    const latestThread = await resolveLatestTrackedTaskSession(workspaceRoot, {
      excludeJobId: request.jobId
    });
    if (!latestThread) {
      throw new Error("No previous Copilot task session was found for this repository.");
    }
    sessionId = latestThread.id;
  } else {
    sessionId = buildPersistentTaskSessionId(request.prompt || DEFAULT_CONTINUE_PROMPT);
  }

  if (!request.prompt && !request.resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  const session = await createSession({
    model: request.model,
    cwd: request.cwd,
    sessionId,
    resume: request.resumeLast,
    write: request.write,
    reasoningEffort: request.effort
  });

  return executeTaskPrompt(session, { ...request, prompt: request.prompt || DEFAULT_CONTINUE_PROMPT });
}

async function handlePingPong(argv) {
  const normalized = normalizeArgv(argv);
  const actions = new Set(["start", "send", "continue", "status", "finish", "stop"]);
  const action = actions.has(normalized[0]) ? normalized.shift() : normalized.length ? "start" : "status";
  const { options, positionals } = parseCommandInput(normalized, {
    valueOptions: ["cwd", "model", "effort", "prompt-file", "after"],
    booleanOptions: ["write", "json"],
    aliasMap: { m: "model" }
  });
  const cwd = resolveCommandCwd(options);
  if (options.after !== undefined && action !== "send" && action !== "finish") {
    throw new Error("--after is only valid for ping-pong send or finish.");
  }
  let payload;
  if (["status", "finish", "stop"].includes(action)) {
    if (positionals.length || options.model !== undefined || options.effort !== undefined ||
        options.write !== undefined || options["prompt-file"] !== undefined) {
      throw new Error(`ping-pong ${action} does not accept a prompt or execution settings.`);
    }
    const session = action === "stop" ? await stopPingPongSession(cwd)
      : action === "finish" ? finishPingPongTask(cwd, options.after) : readPingPongStatus(cwd);
    payload = { session };
  } else {
    payload = await submitPingPongTurn(cwd, {
      action, prompt: readTaskPrompt(cwd, options, positionals), after: options.after,
      ...(options.model !== undefined ? { model: normalizeRequestedModel(options.model) } : {}),
      ...(options.effort !== undefined ? { effort: normalizeReasoningEffort(options.effort) } : {}),
      ...(options.write !== undefined ? { write: Boolean(options.write) } : {})
    });
  }
  const record = payload.session;
  const rendered = record ? [
    `Copilot Ping-pong: ${record.status} (round ${record.round}/${record.maxRounds}).`,
    `Resident session: ${record.id}`,
    `Copilot session: ${record.copilotSessionId ?? "starting"}`,
    `Worker PID: ${record.pid ?? "not running"}`,
    ...(payload.jobId ? [`Job: ${payload.jobId}`, `Job file: ${payload.jobFile}`] : []),
    ...(record.lastJobId ? [`Last job: ${record.lastJobId}`] : []),
    ...(record.errorMessage ? [`Error: ${record.errorMessage}`] : []),
    record.taskComplete ? "Task marked complete; the resident session is waiting for a new request."
      : record.round >= record.maxRounds ? "Five-round limit reached. Wait for an explicit user continuation."
      : "Read the turn result, verify it, then finish or send one follow-up and watch its job file."
  ].join("\n") + "\n" : "No Ping-pong session for this Claude conversation.\n";
  outputCommandResult(payload, rendered, options.json);
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: reviewName === "Review" ? "Copilot Review" : `Copilot ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  const title = resumeLast ? "Copilot Resume" : "Copilot Task";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

function renderQueuedTaskLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check /copilot:status ${payload.jobId} for progress.\nJob file: ${payload.jobFile}\n`;
}

function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") {
    return "adversarial-review";
  }
  return jobClass === "review" ? "review" : "rescue";
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

function buildTaskJob(workspaceRoot, taskMetadata, write) {
  return createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write
  });
}

function buildTaskRequest({ cwd, model, effort, prompt, write, resumeLast, jobId }) {
  return {
    cwd,
    model,
    effort,
    prompt,
    write,
    resumeLast,
    jobId
  };
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }

  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

function requireTaskRequest(prompt, resumeLast) {
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedTaskWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "copilot-companion.mjs");
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

function enqueueBackgroundTask(cwd, job, request) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: null,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);
  const child = spawnDetachedTaskWorker(cwd, job.id);
  if (child.pid) {
    updateState(job.workspaceRoot, (state) => {
      const queued = state.jobs.find((entry) => entry.id === job.id && entry.status === "queued");
      if (queued) queued.pid = child.pid;
    });
  }
  child.once("error", (error) => {
    const failed = { id: job.id, status: "failed", phase: "failed", pid: null, errorMessage: error.message };
    writeJobFile(job.workspaceRoot, job.id, { ...queuedRecord, ...failed });
    upsertJob(job.workspaceRoot, failed);
    process.stderr.write(`Copilot worker failed to start: ${error.message}\n`);
    process.exitCode = 1;
  });

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      jobFile: resolveJobFile(job.workspaceRoot, job.id),
      logFile
    },
    logFile
  };
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ").trim();
  if (options.background && options.wait) {
    throw new Error("Choose either --background or --wait.");
  }
  if (config.reviewName === "Review" && focusText) {
    throw new Error("Use /copilot:adversarial-review for custom review focus text.");
  }
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary
  });
  const request = {
    cwd,
    base: options.base,
    scope: options.scope,
    model: options.model,
    focusText,
    reviewName: config.reviewName
  };
  if (options.background) {
    await ensureCopilotReady(cwd);
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }
  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({ ...request, onProgress: progress }),
    { json: options.json }
  );
}

async function handleReview(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Review"
  });
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort);
  const prompt = readTaskPrompt(cwd, options, positionals);
  if (options.background && options.wait) {
    throw new Error("Choose either --background or --wait.");
  }

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  const write = Boolean(options.write);
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeLast
  });

  if (options.background) {
    await ensureCopilotReady(cwd);
    requireTaskRequest(prompt, resumeLast);

    const job = buildTaskJob(workspaceRoot, taskMetadata, write);
    const request = buildTaskRequest({
      cwd,
      model,
      effort,
      prompt,
      write,
      resumeLast,
      jobId: job.id
    });
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  const job = buildTaskJob(workspaceRoot, taskMetadata, write);
  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        cwd,
        model,
        effort,
        prompt,
        write,
        resumeLast,
        jobId: job.id,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }
  if (storedJob.status !== "queued") {
    throw new Error(`Stored job ${options["job-id"]} is no longer queued.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
  }

  const { logFile, progress } = createTrackedProgress(
    {
      ...storedJob,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );
  await runTrackedJob(
    {
      ...storedJob,
      workspaceRoot,
      logFile
    },
    () => storedJob.jobClass === "review"
      ? executeReviewRun({ ...request, onProgress: progress })
      : executeTaskRun({ ...request, onProgress: progress }),
    { logFile }
  );
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(renderStatusPayload(report, options.json), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = {
    job,
    storedJob
  };

  outputCommandResult(payload, renderStoredJobResult(job, storedJob), options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = process.env[SESSION_ID_ENV] ?? null;
  const candidate = findResumableTask(listJobs(workspaceRoot), sessionId);

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            copilotSessionId: candidate.copilotSessionId,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference);
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};

  if (job.pingPongSessionId) {
    if (job.claudeSessionId !== process.env[SESSION_ID_ENV]) {
      throw new Error("A Ping-pong job can only be cancelled by its owning Claude session.");
    }
    await stopPingPongSession(workspaceRoot);
  } else {
    terminateProcessTree(job.pid ?? Number.NaN);
  }
  appendLogLine(job.logFile, "Cancelled by user.");

  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: "Cancelled by user."
  };

  upsertJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    errorMessage: "Cancelled by user.",
    completedAt
  });
  writeJobFile(workspaceRoot, job.id, {
    ...existing,
    ...nextJob,
    cancelledAt: completedAt
  });

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title
  };

  outputCommandResult(payload, renderCancelReport(nextJob), options.json);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, {
        reviewName: "Adversarial Review"
      });
      break;
    case "task":
      await handleTask(argv);
      break;
    case "ping-pong":
      await handlePingPong(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  const isAuthError = /auth|login|unauthenticated|unauthorized|not signed in|credentials/i.test(message);
  if (isAuthError) {
    process.stderr.write(`Copilot authentication failed: ${message}\nRun \`!copilot login\` to authenticate and retry.\n`);
  } else {
    process.stderr.write(`${message}\n`);
  }
  process.exitCode = 1;
}).finally(shutdownClient).catch((error) => {
  process.stderr.write(`Copilot shutdown failed: ${error.message}\n`);
  process.exitCode = 1;
});
