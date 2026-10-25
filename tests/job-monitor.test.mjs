import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { watchJobFile } from "../plugins/copilot/scripts/job-monitor.mjs";
import { writeJsonFile } from "../plugins/copilot/scripts/lib/fs.mjs";
import { createTempWorkspace, cleanupDir } from "./helpers.mjs";

describe("job completion monitor", () => {
  it("notifies once after atomic updates to the selected job and ignores other jobs", async () => {
    const dir = createTempWorkspace();
    try {
      const selected = path.join(dir, "selected.json");
      const other = path.join(dir, "other.json");
      writeJsonFile(selected, { id: "selected", status: "running" });
      const watching = watchJobFile(selected, { interval: 10 });
      writeJsonFile(other, { id: "other", status: "completed" });
      setTimeout(() => writeJsonFile(selected, { id: "selected", status: "completed" }), 50);
      assert.deepEqual(await watching, { jobId: "selected", status: "completed" });
    } finally {
      cleanupDir(dir);
    }
  });

  it("handles jobs that finished before the monitor started, including failures and cancellations", async () => {
    const dir = createTempWorkspace();
    try {
      const file = path.join(dir, "job.json");
      for (const status of ["completed", "failed", "cancelled"]) {
        writeJsonFile(file, { id: "job", status });
        assert.deepEqual(await watchJobFile(file), { jobId: "job", status });
      }
    } finally {
      cleanupDir(dir);
    }
  });

  it("reports missing or corrupt records rather than inventing a completion", async () => {
    const dir = createTempWorkspace();
    try {
      const file = path.join(dir, "missing.json");
      await assert.rejects(watchJobFile(file), /ENOENT/);
      fs.writeFileSync(file, "invalid JSON");
      await assert.rejects(watchJobFile(file), SyntaxError);
    } finally {
      cleanupDir(dir);
    }
  });

  it("includes the turn identity and budget in Ping-pong handoffs, and pauses on errors", () => {
    const dir = createTempWorkspace();
    try {
      const file = path.join(dir, "job.json");
      const script = fileURLToPath(new URL("../plugins/copilot/scripts/job-monitor.mjs", import.meta.url));
      for (const status of ["completed", "failed", "cancelled"]) {
        writeJsonFile(file, { id: "turn-5", status, pingPongSessionId: "resident", round: 5, maxRounds: 5 });
        const notification = spawnSync(process.execPath, [script, file], { encoding: "utf8" });
        assert.equal(notification.status, 0, notification.stderr);
        assert.match(notification.stdout, /round 5\/5/);
        assert.equal(notification.stdout.match(new RegExp(`Copilot job turn-5 ${status}`, "g")).length, 1);
        if (status === "completed") assert.match(notification.stdout, /--after turn-5/);
        else assert.match(notification.stdout, /Pause automatic handoffs/);
      }
    } finally {
      cleanupDir(dir);
    }
  });
});
