import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createRuntimeWorkspace, cleanupDir } from "./helpers.mjs";
import { watchJobFile } from "../plugins/copilot/scripts/job-monitor.mjs";

function run(workspace, args, extraEnv = {}) {
  const result = workspace.run(["ping-pong", ...args, "--json"], {
    env: { ...workspace.env, ...extraEnv }, timeout: 30000
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function lifecycle(workspace) {
  return fs.readFileSync(workspace.env.COPILOT_TEST_LIFECYCLE, "utf8").trim().split("\n").map(JSON.parse);
}

async function waitForExit(pid) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Ping-pong worker ${pid} did not exit`);
}

function createWorkspace() {
  const workspace = createRuntimeWorkspace();
  workspace.env.COPILOT_TEST_LIFECYCLE = path.join(workspace.env.CLAUDE_PLUGIN_DATA, "lifecycle.jsonl");
  return workspace;
}

function cleanup(workspace, owners = [workspace.env.COPILOT_COMPANION_SESSION_ID]) {
  try {
    for (const owner of owners) run(workspace, ["stop"], { COPILOT_COMPANION_SESSION_ID: owner });
  } finally {
    cleanupDir(workspace.dir);
  }
}

function runAsync(workspace, args) {
  return new Promise((resolve, reject) => {
    const script = fileURLToPath(new URL("../plugins/copilot/scripts/copilot-companion.mjs", import.meta.url));
    const child = spawn(process.execPath, [script, "ping-pong", ...args, "--json"], {
      cwd: workspace.dir, env: workspace.env, stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (status) => resolve({ status, stdout, stderr }));
  });
}

describe("resident Ping-pong runtime", () => {
  it("keeps one client and session alive across rounds, enforces five rounds, and resumes only explicitly", async () => {
    const workspace = createWorkspace();
    try {
      let launch = run(workspace, ["start", "--write", "--effort", "high", "Fix the bug"]);
      const pid = launch.session.pid;
      const sessionId = launch.session.copilotSessionId;
      assert.ok(pid > 0);
      for (let round = 1; round <= 5; round++) {
        if (round > 1) launch = run(workspace, ["send", "--after", launch.jobId, `Round ${round}: address the remaining issue`]);
        assert.equal((await watchJobFile(launch.jobFile, { interval: 10 })).status, "completed");
        const result = workspace.run(["result", launch.jobId, "--json"]);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(JSON.parse(result.stdout).storedJob.copilotSessionId, sessionId);
        const record = run(workspace, ["status"]).session;
        assert.equal(record.pid, pid);
        assert.equal(record.round, round);
      }
      assert.equal(run(workspace, ["status"]).session.status, "paused");
      const sixth = workspace.run(["ping-pong", "send", "One more"]);
      assert.equal(sixth.status, 1);
      assert.match(sixth.stderr, /five-round limit/);
      const candidate = workspace.run(["task-resume-candidate", "--json"]);
      assert.equal(JSON.parse(candidate.stdout).available, false);
      const continued = run(workspace, ["continue", "User explicitly authorizes another batch"]);
      await watchJobFile(continued.jobFile, { interval: 10 });
      assert.equal(continued.session.round, 1);
      assert.equal(continued.session.pid, pid);
      assert.equal(continued.session.copilotSessionId, sessionId);
      run(workspace, ["finish", "--after", continued.jobId]);
      assert.equal(run(workspace, ["status"]).session.taskComplete, true);
      const lateFollowup = workspace.run(["ping-pong", "send", "Replay"]);
      assert.equal(lateFollowup.status, 1);
      assert.equal(lifecycle(workspace).filter((event) => event.event === "start").length, 1);
      assert.equal(lifecycle(workspace).filter((event) => event.event === "create").length, 1);
      assert.equal(lifecycle(workspace).filter((event) => event.event === "disconnect").length, 0);
      const sends = lifecycle(workspace).filter((event) => event.event === "send");
      assert.deepEqual(sends.map((event) => event.messageCount), [1, 2, 3, 4, 5, 6]);
      assert.ok(sends.every((event) => event.pid === pid && event.sessionId === sessionId));
      run(workspace, ["stop"]);
      await waitForExit(pid);
      assert.equal(lifecycle(workspace).filter((event) => event.event === "disconnect").length, 1);
      assert.equal(lifecycle(workspace).filter((event) => event.event === "stop").length, 1);
      assert.equal(run(workspace, ["status"]).session.pid, null);
    } finally {
      cleanup(workspace);
    }
  });

  it("serializes competing submissions and rejects per-turn permission or model changes", async () => {
    const workspace = createWorkspace();
    workspace.env.COPILOT_TEST_DELAY_MS = "2000";
    try {
      const launch = run(workspace, ["start", "Investigate"]);
      const duplicate = workspace.run(["ping-pong", "start", "Duplicate"]);
      assert.equal(duplicate.status, 1);
      assert.match(duplicate.stderr, /busy/);
      await watchJobFile(launch.jobFile, { interval: 10 });
      const stale = workspace.run(["ping-pong", "send", "--after", "stale-notification", "Replay"]);
      assert.equal(stale.status, 1);
      assert.match(stale.stderr, /result may already have advanced/);
      for (const option of [["--write"], ["--model", "different"], ["--effort", "max"]]) {
        const changed = workspace.run(["ping-pong", "send", ...option, "Escalate"]);
        assert.equal(changed.status, 1);
        assert.match(changed.stderr, /fixed for the resident session/);
      }
      const results = await Promise.all([
        runAsync(workspace, ["send", "--after", launch.jobId, "First continuation"]),
        runAsync(workspace, ["send", "--after", launch.jobId, "Competing continuation"])
      ]);
      assert.equal(results.filter((result) => result.status === 0).length, 1);
      const rejected = results.find((result) => result.status !== 0);
      assert.match(rejected.stderr, /busy/);
      const accepted = JSON.parse(results.find((result) => result.status === 0).stdout);
      await watchJobFile(accepted.jobFile, { interval: 10 });
      const replay = workspace.run(["ping-pong", "send", "--after", launch.jobId, "Old completion notification"]);
      assert.equal(replay.status, 1);
      assert.match(replay.stderr, /result may already have advanced/);
      assert.equal(run(workspace, ["status"]).session.round, 2);
      assert.equal(lifecycle(workspace).filter((event) => event.event === "send").length, 2);
    } finally {
      cleanup(workspace);
    }
  });

  it("isolates resident sessions and shuts down only the ending Claude session, including idle workers", async () => {
    const workspace = createWorkspace();
    const otherEnv = { COPILOT_COMPANION_SESSION_ID: "other-claude-session" };
    try {
      const first = run(workspace, ["start", "First owner's task"]);
      const other = run(workspace, ["start", "Other owner's task"], otherEnv);
      await Promise.all([watchJobFile(first.jobFile, { interval: 10 }), watchJobFile(other.jobFile, { interval: 10 })]);
      assert.notEqual(first.session.pid, other.session.pid);
      const end = workspace.hook("session-lifecycle-hook", { hook_event_name: "SessionEnd" });
      assert.equal(end.status, 0, end.stderr);
      assert.equal(end.stderr, "");
      await waitForExit(first.session.pid);
      assert.equal(run(workspace, ["status"]).session.status, "stopped");
      assert.equal(run(workspace, ["status"], otherEnv).session.status, "idle");
      const result = workspace.run(["result", first.jobId, "--json"]);
      assert.equal(JSON.parse(result.stdout).job.status, "completed");
      assert.equal(lifecycle(workspace).filter((event) => event.event === "stop").length, 1);
    } finally {
      cleanup(workspace, [workspace.env.COPILOT_COMPANION_SESSION_ID, "other-claude-session"]);
    }
  });

  it("aborts an active turn through the normal cancel command without resurrecting its job", async () => {
    for (const sessionEnd of [false, true]) {
      const workspace = createWorkspace();
      workspace.env.COPILOT_TEST_DELAY_MS = "5000";
      try {
        const launch = run(workspace, ["start", "--write", "Run a long task"]);
        const cancelled = sessionEnd
          ? workspace.hook("session-lifecycle-hook", { hook_event_name: "SessionEnd" })
          : workspace.run(["cancel", launch.jobId, "--json"]);
        assert.equal(cancelled.status, 0, cancelled.stderr);
        await waitForExit(launch.session.pid);
        assert.equal((await watchJobFile(launch.jobFile, { interval: 10 })).status, "cancelled");
        assert.equal(run(workspace, ["status"]).session.status, "stopped");
        assert.ok(lifecycle(workspace).some((event) => event.event === "abort"));
        const result = workspace.run(["result", launch.jobId, "--json"]);
        assert.equal(JSON.parse(result.stdout).storedJob.status, "cancelled");
      } finally {
        cleanup(workspace);
      }
    }
  });

  it("defers the optional review gate while Copilot is editing, without consuming its turn snapshot", async () => {
    const workspace = createWorkspace();
    workspace.env.COPILOT_TEST_DELAY_MS = "5000";
    try {
      const setup = workspace.run(["setup", "--enable-review-gate", "--json"]);
      assert.equal(setup.status, 0, setup.stderr);
      assert.equal(workspace.hook("turn-start-hook").status, 0);
      run(workspace, ["start", "--write", "Implement the change"]);
      fs.appendFileSync(path.join(workspace.dir, "file.txt"), "work in progress\n");
      const deferred = workspace.hook("stop-review-gate-hook");
      assert.equal(deferred.status, 0, deferred.stderr);
      assert.equal(deferred.stdout, "");
      assert.equal(lifecycle(workspace).filter((event) => event.event === "send").length, 1);
      run(workspace, ["stop"]);
      const reviewed = workspace.hook("stop-review-gate-hook", {}, {
        COPILOT_TEST_DELAY_MS: "0", COPILOT_TEST_RESPONSE: "ALLOW: Reviewed after stopping"
      });
      assert.equal(reviewed.status, 0, reviewed.stderr);
      assert.equal(reviewed.stdout, "");
      assert.equal(lifecycle(workspace).filter((event) => event.event === "send").length, 2);
    } finally {
      cleanup(workspace);
    }
  });

  it("surfaces SDK and approval failures and never automatically starts another round", async () => {
    for (const extraEnv of [
      { COPILOT_TEST_ERROR: "SDK transport failed" },
      { COPILOT_TEST_PERMISSION: "managed" },
      { COPILOT_TEST_AUTH: "false" }
    ]) {
      const workspace = createWorkspace();
      Object.assign(workspace.env, extraEnv);
      try {
        const launch = workspace.run(["ping-pong", "start", "--write", "Do work", "--json"], { timeout: 30000 });
        if (launch.status === 0) {
          await watchJobFile(JSON.parse(launch.stdout).jobFile, { interval: 10 });
        }
        const record = run(workspace, ["status"]).session;
        assert.equal(record.status, "failed");
        assert.match(record.errorMessage, /SDK transport failed|human approval|not authenticated/);
        assert.equal(record.round, 1);
        const result = workspace.run(["result", "--json"]);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(JSON.parse(result.stdout).storedJob.status, "failed");
        const followup = workspace.run(["ping-pong", "send", "Must not restart"]);
        assert.equal(followup.status, 1);
      } finally {
        cleanup(workspace);
      }
    }
  });

  it("requires Claude ownership instead of starting an unowned daemon", () => {
    const workspace = createWorkspace();
    try {
      const result = workspace.run(["ping-pong", "start", "Investigate"], {
        env: { ...workspace.env, COPILOT_COMPANION_SESSION_ID: "" }
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /requires a Claude session ID/);
      assert.equal(fs.existsSync(workspace.env.COPILOT_TEST_LIFECYCLE), false);
    } finally {
      cleanup(workspace);
    }
  });

  it("reports a crashed worker instead of claiming it is idle or automatically restarting it", async () => {
    const workspace = createWorkspace();
    workspace.env.COPILOT_TEST_DELAY_MS = "5000";
    try {
      const launch = run(workspace, ["start", "Long-running investigation"]);
      process.kill(launch.session.pid, "SIGKILL");
      await waitForExit(launch.session.pid);
      const status = workspace.run(["ping-pong", "status", "--json"]);
      assert.equal(status.status, 1);
      assert.match(status.stderr, /exited unexpectedly/);
      run(workspace, ["stop"]);
      assert.equal((await watchJobFile(launch.jobFile, { interval: 10 })).status, "cancelled");
      assert.equal(run(workspace, ["status"]).session.status, "stopped");
      assert.equal(lifecycle(workspace).filter((event) => event.event === "start").length, 1);
    } finally {
      cleanup(workspace);
    }
  });
});
