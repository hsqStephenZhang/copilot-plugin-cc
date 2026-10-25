#!/usr/bin/env node

import { runPingPongWorker } from "./lib/ping-pong.mjs";

const [cwd, instanceId] = process.argv.slice(2);
if (!cwd || !instanceId) {
  process.stderr.write("Usage: ping-pong-worker.mjs <workspace-root> <session-instance-id>\n");
  process.exitCode = 1;
} else {
  runPingPongWorker(cwd, instanceId).catch((error) => {
    process.stderr.write(`Ping-pong worker failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
