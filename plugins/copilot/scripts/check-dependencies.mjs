#!/usr/bin/env node

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

try {
  for (const name of ["@github/copilot-sdk", "proper-lockfile"]) {
    await import(pathToFileURL(require.resolve(name)).href);
  }
  process.stdout.write("Plugin dependencies are ready.\n");
} catch (error) {
  process.stderr.write(`Plugin dependencies are unavailable: ${error.message}\nRun npm ci --ignore-scripts in the installed plugin directory, or use /copilot:setup.\n`);
  process.exitCode = 1;
}
