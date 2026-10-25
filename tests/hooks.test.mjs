import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { createRuntimeWorkspace, cleanupDir } from "./helpers.mjs";

describe("session lifecycle", () => {
  it("cancels only the ending session's active jobs and preserves completed history", () => {
    const workspace = createRuntimeWorkspace();
    try {
      const completed = workspace.run(["task", "Keep this history", "--wait", "--json"]);
      assert.equal(completed.status, 0, completed.stderr);
      const stateRoot = path.join(workspace.env.CLAUDE_PLUGIN_DATA, "state");
      const stateDir = path.join(stateRoot, fs.readdirSync(stateRoot)[0]);
      const stateFile = path.join(stateDir, "state.json");
      const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      const finished = state.jobs[0];
      const active = {
        ...finished, id: "active-current", status: "queued", pid: null
      };
      const other = { ...active, id: "active-other", claudeSessionId: "other-claude-session" };
      state.jobs.push(active, other);
      fs.writeFileSync(stateFile, JSON.stringify(state));
      for (const job of [active, other]) {
        fs.writeFileSync(path.join(stateDir, "jobs", `${job.id}.json`), JSON.stringify(job));
      }
      const end = workspace.hook("session-lifecycle-hook", { hook_event_name: "SessionEnd" });
      assert.equal(end.status, 0, end.stderr);
      const jobs = JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs;
      assert.equal(jobs.find((job) => job.id === finished.id).status, "completed");
      assert.equal(jobs.find((job) => job.id === active.id).status, "cancelled");
      assert.equal(jobs.find((job) => job.id === other.id).status, "queued");
    } finally {
      cleanupDir(workspace.dir);
    }
  });
});

function enableGate(workspace) {
  const result = workspace.run(["setup", "--enable-review-gate", "--json"]);
  assert.equal(result.status, 0, result.stderr);
}

describe("turn-scoped review gate", () => {
  it("reviews only this turn's delta, including committed and untracked changes, without touching the user's index", () => {
    const workspace = createRuntimeWorkspace();
    try {
      enableGate(workspace);
      fs.writeFileSync(path.join(workspace.dir, "file.txt"), "older edit\n");
      workspace.git("add", "file.txt");
      const indexBefore = workspace.git("diff", "--cached");
      const start = workspace.hook("turn-start-hook");
      assert.equal(start.status, 0, start.stderr);
      assert.equal(workspace.git("diff", "--cached"), indexBefore);
      fs.writeFileSync(path.join(workspace.dir, "file.txt"), "this turn\n");
      workspace.git("add", "file.txt");
      workspace.git("commit", "--quiet", "-m", "commit during turn");
      fs.writeFileSync(path.join(workspace.dir, "new file.txt"), "new this turn\n");
      const promptFile = path.join(workspace.env.CLAUDE_PLUGIN_DATA, "review-prompt.txt");
      const stop = workspace.hook("stop-review-gate-hook", {}, {
        COPILOT_TEST_RESPONSE: "BLOCK: A concrete issue",
        COPILOT_TEST_PROMPT: promptFile
      });
      assert.equal(stop.status, 0, stop.stderr);
      assert.equal(JSON.parse(stop.stdout).decision, "block");
      const prompt = fs.readFileSync(promptFile, "utf8");
      assert.match(prompt, /-older edit/);
      assert.match(prompt, /\+this turn/);
      assert.match(prompt, /new file.txt/);
      assert.doesNotMatch(prompt, /-initial/);
      assert.equal(workspace.git("diff", "--cached"), "");
      const callsBefore = fs.readFileSync(workspace.env.COPILOT_TEST_TRACE, "utf8");
      const repeated = workspace.hook("stop-review-gate-hook", { stop_hook_active: true });
      assert.equal(repeated.stdout, "");
      const duplicate = workspace.hook("stop-review-gate-hook");
      assert.equal(duplicate.stdout, "");
      assert.equal(fs.readFileSync(workspace.env.COPILOT_TEST_TRACE, "utf8"), callsBefore);
    } finally {
      cleanupDir(workspace.dir);
    }
  });

  it("does not spend a Copilot turn for status-only turns or pre-existing dirty files", () => {
    const workspace = createRuntimeWorkspace();
    try {
      enableGate(workspace);
      fs.writeFileSync(path.join(workspace.dir, "file.txt"), "existing dirty work\n");
      assert.equal(workspace.hook("turn-start-hook").status, 0);
      const stop = workspace.hook("stop-review-gate-hook");
      assert.equal(stop.status, 0, stop.stderr);
      assert.equal(stop.stdout, "");
      assert.equal(fs.existsSync(workspace.env.COPILOT_TEST_TRACE), false);
    } finally {
      cleanupDir(workspace.dir);
    }
  });

  it("surfaces invalid verdicts and authentication failures as a single block", () => {
    const workspace = createRuntimeWorkspace();
    try {
      enableGate(workspace);
      for (const env of [
        { COPILOT_TEST_RESPONSE: "not a verdict" },
        { COPILOT_TEST_AUTH: "false" }
      ]) {
        assert.equal(workspace.hook("turn-start-hook").status, 0);
        fs.appendFileSync(path.join(workspace.dir, "file.txt"), "changed\n");
        const stop = workspace.hook("stop-review-gate-hook", {}, env);
        assert.equal(stop.status, 0, stop.stderr);
        assert.equal(JSON.parse(stop.stdout).decision, "block");
      }
      assert.match(fs.readFileSync(workspace.env.COPILOT_TEST_TRACE, "utf8"), /builtin:view/);
    } finally {
      cleanupDir(workspace.dir);
    }
  });

  it("allows an approved review and does not turn gate reviews into rescue continuation candidates", () => {
    const workspace = createRuntimeWorkspace();
    try {
      enableGate(workspace);
      assert.equal(workspace.hook("turn-start-hook").status, 0);
      fs.unlinkSync(path.join(workspace.dir, "file.txt"));
      const stop = workspace.hook("stop-review-gate-hook", {}, { COPILOT_TEST_RESPONSE: "ALLOW: Looks good" });
      assert.equal(stop.status, 0, stop.stderr);
      assert.equal(stop.stdout, "");
      const candidate = workspace.run(["task-resume-candidate", "--json"]);
      assert.equal(JSON.parse(candidate.stdout).available, false);
    } finally {
      cleanupDir(workspace.dir);
    }
  });
});
