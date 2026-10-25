import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRuntimeWorkspace, createTempWorkspace, cleanupDir } from "./helpers.mjs";
import { watchJobFile } from "../plugins/copilot/scripts/job-monitor.mjs";

describe("copilot-companion CLI", () => {
  it("prints help and rejects unknown subcommands", () => {
    const workspace = createRuntimeWorkspace();
    try {
      for (const command of ["help", "--help"]) {
        const result = workspace.run([command]);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /Usage:/);
      }
      const unknown = workspace.run(["nonexistent"]);
      assert.equal(unknown.status, 1);
      assert.match(unknown.stderr, /Unknown subcommand/);
    } finally {
      cleanupDir(workspace.dir);
    }
  });

  it("reports setup and empty status without contacting a real Copilot runtime", () => {
    const workspace = createRuntimeWorkspace();
    try {
      const setup = workspace.run(["setup", "--json"]);
      assert.equal(setup.status, 0, setup.stderr);
      assert.equal(JSON.parse(setup.stdout).ready, true);
      const status = workspace.run(["status"]);
      assert.equal(status.status, 0, status.stderr);
      assert.match(status.stdout, /Copilot Status/);
    } finally {
      cleanupDir(workspace.dir);
    }
  });
});

describe("runtime command integration", () => {
  it("reports missing dependencies in an isolated plugin installation before setup", () => {
    const dir = createTempWorkspace();
    try {
      fs.cpSync(new URL("../plugins/copilot", import.meta.url), dir, {
        recursive: true, filter: (source) => path.basename(source) !== "node_modules"
      });
      const check = spawnSync(process.execPath, [path.join(dir, "scripts/check-dependencies.mjs")], {
        cwd: dir, encoding: "utf8"
      });
      assert.equal(check.status, 1);
      assert.match(check.stderr, /Plugin dependencies are unavailable/);
      assert.match(check.stderr, /npm ci --ignore-scripts/);
    } finally {
      cleanupDir(dir);
    }
  });

  it("completes background task and review workers and makes their output immediately retrievable", async () => {
    const workspace = createRuntimeWorkspace();
    try {
      fs.writeFileSync(path.join(workspace.dir, "file.txt"), "reviewable change\n");
      for (const args of [["task", "Investigate"], ["review"]]) {
        const launch = workspace.run([...args, "--background", "--json"]);
        assert.equal(launch.status, 0, launch.stderr);
        const queued = JSON.parse(launch.stdout);
        assert.equal(queued.status, "queued");
        const terminal = await watchJobFile(queued.jobFile, { interval: 10 });
        assert.equal(terminal.status, "completed");
        const result = workspace.run(["result", queued.jobId, "--json"]);
        assert.equal(result.status, 0, result.stderr);
        const stored = JSON.parse(result.stdout);
        assert.equal(stored.job.status, "completed");
        assert.equal(stored.storedJob.claudeSessionId, workspace.env.COPILOT_COMPANION_SESSION_ID);
        assert.ok(stored.storedJob.copilotSessionId);
      }
    } finally {
      cleanupDir(workspace.dir);
    }
  });

  it("passes write, effort and working directory, and resumes the stored Copilot ID", () => {
    const workspace = createRuntimeWorkspace();
    try {
      const first = workspace.run(["task", "--write", "--effort", "high", "--wait", "--json", "Fix the bug"]);
      assert.equal(first.status, 0, first.stderr);
      const firstPayload = JSON.parse(first.stdout);
      const candidate = workspace.run(["task-resume-candidate", "--json"]);
      assert.equal(JSON.parse(candidate.stdout).available, true);
      const resumed = workspace.run(["task", "--resume", "--json", "Continue"]);
      assert.equal(resumed.status, 0, resumed.stderr);
      assert.equal(JSON.parse(resumed.stdout).sessionId, firstPayload.sessionId);
      const calls = fs.readFileSync(workspace.env.COPILOT_TEST_TRACE, "utf8").trim().split("\n").map(JSON.parse);
      assert.equal(calls[0].reasoningEffort, "high");
      assert.equal(calls[0].workingDirectory, workspace.dir);
      assert.equal(calls[0].availableTools, undefined);
      assert.ok(calls[1].availableTools.includes("builtin:view"));
      const other = workspace.run(["task-resume-candidate", "--json"], {
        env: { ...workspace.env, COPILOT_COMPANION_SESSION_ID: "another-claude-session" }
      });
      assert.equal(JSON.parse(other.stdout).available, false);
    } finally {
      cleanupDir(workspace.dir);
    }
  });

  it("rejects conflicting execution flags and unsupported effort before contacting Copilot", () => {
    const workspace = createRuntimeWorkspace();
    try {
      for (const args of [
        ["task", "--wait", "--background", "Fix"],
        ["review", "--wait", "--background"],
        ["task", "--effort", "minimal", "Fix"]
      ]) {
        const result = workspace.run(args);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /Choose either|Unsupported reasoning effort/);
      }
      assert.equal(fs.existsSync(workspace.env.COPILOT_TEST_TRACE), false);
    } finally {
      cleanupDir(workspace.dir);
    }
  });

  it("rejects unauthenticated execution instead of reporting a successful job", () => {
    const workspace = createRuntimeWorkspace();
    try {
      const result = workspace.run(["task", "Fix"], {
        env: { ...workspace.env, COPILOT_TEST_AUTH: "false" }
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /not authenticated/);
      assert.equal(fs.existsSync(workspace.env.COPILOT_TEST_TRACE), false);
    } finally {
      cleanupDir(workspace.dir);
    }
  });
});
