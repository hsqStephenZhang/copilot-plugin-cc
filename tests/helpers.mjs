import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function createTempWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-test-"));
  return dir;
}

export function cleanupDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

export function createRuntimeWorkspace() {
  const dir = createTempWorkspace();
  const root = path.dirname(fileURLToPath(import.meta.url));
  const env = {
    ...process.env,
    CLAUDE_PLUGIN_DATA: path.join(dir, ".plugin-data"),
    COPILOT_COMPANION_SESSION_ID: "claude-test",
    NODE_OPTIONS: `--no-warnings --experimental-loader=${new URL("./sdk-loader.mjs", import.meta.url).href}`,
    COPILOT_TEST_TRACE: path.join(dir, "sdk-trace.jsonl")
  };
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout;
  };
  git("init", "--quiet");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".plugin-data/\nsdk-trace.jsonl\nbin/\n");
  fs.writeFileSync(path.join(dir, "file.txt"), "initial\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "initial");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "copilot"), "#!/bin/sh\nprintf 'test-copilot\\n'\n", { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "copilot.cmd"), "@echo test-copilot\r\n");
  env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  return {
    dir, env, git,
    hook(name, input = {}, extraEnv = {}) {
      return spawnSync(process.execPath, [path.resolve(root, `../plugins/copilot/scripts/${name}.mjs`)], {
        cwd: dir,
        encoding: "utf8",
        env: { ...env, ...extraEnv },
        input: JSON.stringify({ cwd: dir, session_id: env.COPILOT_COMPANION_SESSION_ID, ...input }),
        timeout: 30000
      });
    },
    run(args, options = {}) {
      return spawnSync(process.execPath, [path.resolve(root, "../plugins/copilot/scripts/copilot-companion.mjs"), ...args], {
        cwd: dir, encoding: "utf8", env, timeout: 15000, ...options
      });
    }
  };
}
