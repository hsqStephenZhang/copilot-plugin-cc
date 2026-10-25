---
description: Check whether the local Copilot CLI is ready and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), Bash(npm:*), AskUserQuestion
---

First check the installed plugin's own dependencies:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/check-dependencies.mjs"
```

If this check fails, show its error and use `AskUserQuestion` once to ask whether to install the plugin dependencies. Do not confuse these with the global Copilot CLI:
- `Install plugin dependencies (Recommended)`
- `Skip for now`

If approved, run:

```bash
npm ci --ignore-scripts --prefix "${CLAUDE_PLUGIN_ROOT}"
node "${CLAUDE_PLUGIN_ROOT}/scripts/check-dependencies.mjs"
```

If installation was skipped or either command fails, present the error and stop. Do not run the runtime without its dependencies.

Once dependencies are ready, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" setup --json $ARGUMENTS
```

If the result says Copilot is unavailable and npm is available:
- Use `AskUserQuestion` exactly once to ask whether Claude should install Copilot CLI now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install Copilot CLI (Recommended)`
  - `Skip for now`
- If the user chooses install, run:

```bash
npm install -g @github/copilot-cli
```

- Then rerun:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" setup --json $ARGUMENTS
```

If Copilot CLI is already installed or npm is unavailable:
- Do not ask about installation.

Output rules:
- Present the final setup output to the user.
- If installation was skipped, present the original setup output.
- If Copilot CLI is installed but not authenticated, preserve the guidance to run `!copilot login`.
