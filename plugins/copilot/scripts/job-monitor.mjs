#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

export function watchJobFile(jobFile, options = {}) {
  return new Promise((resolve, reject) => {
    const check = () => {
      try {
        const job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
        if (!job.id || !["queued", "running", ...TERMINAL_STATUSES].includes(job.status)) {
          throw new Error("Invalid Copilot job record.");
        }
        if (TERMINAL_STATUSES.has(job.status)) {
          fs.unwatchFile(jobFile, check);
          resolve({ jobId: job.id, status: job.status });
        }
      } catch (error) {
        fs.unwatchFile(jobFile, check);
        reject(error);
      }
    };
    fs.watchFile(jobFile, { interval: options.interval ?? 1000 }, check);
    check();
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const jobFile = process.argv[2];
  if (!jobFile) {
    process.stderr.write("Usage: node job-monitor.mjs <absolute-job-file>\n");
    process.exitCode = 1;
  } else {
    watchJobFile(jobFile).then(({ jobId, status }) => {
      process.stdout.write(`Copilot job ${jobId} ${status}. Read /copilot:result ${jobId} for the stored output.\n`);
    }).catch((error) => {
      process.stderr.write(`Copilot job monitor failed: ${error.message}. Use /copilot:status instead.\n`);
      process.exitCode = 1;
    });
  }
}
