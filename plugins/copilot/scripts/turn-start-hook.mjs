#!/usr/bin/env node

import fs from "node:fs";

import { getConfig } from "./lib/state.mjs";
import { clearTurnSnapshot, recordTurnStart } from "./lib/turn-review.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

try {
  const input = JSON.parse(fs.readFileSync(0, "utf8"));
  const root = resolveWorkspaceRoot(input.cwd || process.cwd());
  if (getConfig(root).stopReviewGate) {
    recordTurnStart(root, input.session_id);
  } else if (input.session_id) {
    clearTurnSnapshot(root, input.session_id);
  }
} catch (error) {
  process.stderr.write(`Copilot turn snapshot failed: ${error.message}\n`);
  process.exitCode = 1;
}
