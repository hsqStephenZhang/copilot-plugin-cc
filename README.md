# Copilot plugin for Claude Code

Use Copilot from inside Claude Code for code reviews or to delegate tasks to Copilot.

This plugin is for Claude Code users who want an easy way to start using Copilot from the workflow
they already have.

<video src="./docs/plugin-demo.webm" controls muted playsinline autoplay></video>

## What You Get

- `/copilot:review` for a normal read-only Copilot review
- `/copilot:adversarial-review` for a steerable challenge review
- `/copilot:rescue`, `/copilot:status`, `/copilot:result`, and `/copilot:cancel` to delegate work and manage background jobs
- `/copilot:ping-pong` for a resident Copilot session with automatic Claude handoffs, capped at five rounds per task

## Requirements

- **GitHub Copilot subscription or GitHub token.**
  - Usage will contribute to your Copilot usage limits. [Learn more](https://docs.github.com/en/copilot/about-github-copilot/subscription-plans-for-github-copilot).
- **Node.js 20.19+ (20.x), or 22.12+**. Node.js 21 and early 22.x are not supported by the SDK.
- **A current Claude Code release**. Automatic Ping-pong requires its `Monitor` tool; other background jobs can fall back to status/result commands.

## Install

Add the marketplace in Claude Code:

```bash
/plugin marketplace add hsqStephenZhang/copilot-plugin-cc
```

Install the plugin:

```bash
/plugin install copilot@github-copilot
```

Reload plugins:

```bash
/reload-plugins
```

Then run:

```bash
/copilot:setup
```

`/copilot:setup` first checks the dependencies inside the installed plugin directory and offers to install missing ones with `npm ci --ignore-scripts`. A Git-based plugin install does not install npm dependencies automatically. Installing them only in the marketplace repository root is not sufficient for Claude's isolated plugin cache.

Setup then checks Copilot authentication. If the global Copilot CLI is missing and npm is available, it can offer to install it for you. Run setup again after a plugin update if dependencies have changed.

If you prefer to install Copilot yourself, use:

```bash
npm install -g @github/copilot-cli
```

If Copilot is installed but not logged in yet, run:

```bash
!copilot login
```

After install, you should see:

- the slash commands listed below
- the `copilot:copilot-rescue` subagent in `/agents`

One simple first run is:

```bash
/copilot:review --background
/copilot:status
/copilot:result
```

## Usage

### `/copilot:review`

Runs a read-only review through the Copilot SDK, using a review prompt and the selected Git diff. This does not invoke Copilot CLI's native `/review` command and does not promise identical behavior or review quality.

> [!NOTE]
> Code review especially for multi-file changes might take a while. It's generally recommended to run it in the background.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review. It also supports `--wait` and `--background`. It is not steerable and does not take custom focus text. Use [`/copilot:adversarial-review`](#copilotadversarial-review) when you want to challenge a specific decision or risk area.

Examples:

```bash
/copilot:review
/copilot:review --base main
/copilot:review --background
```

This command is read-only and will not perform any changes. When run in the background you can use [`/copilot:status`](#copilotstatus) to check on the progress and [`/copilot:cancel`](#copilotcancel) to cancel the ongoing task.

### `/copilot:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different approach would have been safer or simpler.

It uses the same review target selection as `/copilot:review`, including `--base <ref>` for branch review.
It also supports `--wait` and `--background`. Unlike `/copilot:review`, it can take extra focus text after the flags.

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- review focused on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing around specific risk areas like auth, data loss, rollback, race conditions, or reliability

Examples:

```bash
/copilot:adversarial-review
/copilot:adversarial-review --base main challenge whether this was the right caching and retry design
/copilot:adversarial-review --background look for race conditions and question the chosen approach
```

This command is read-only. It does not fix code.

### `/copilot:rescue`

Hands a task to Copilot. The slash command runs in the main Claude conversation so it can ask whether to resume a previous task; natural-language delegation can use the thin `copilot:copilot-rescue` forwarding subagent.

Use it when you want Copilot to:

- investigate a bug
- try a fix
- continue a previous Copilot task
- take a faster or cheaper pass with a smaller model

> [!NOTE]
> Long tasks can run with `--background`. `--wait` keeps the runtime in the foreground; it is not silently converted into a detached subagent.

It supports `--background`, `--wait`, `--resume`, and `--fresh`. If you omit `--resume` and `--fresh`, the plugin can offer to continue the latest rescue thread owned by the current Claude session in this repo. Diagnosis, planning, and research are read-only; explicit implementation requests authorize a write-capable run.

Examples:

```bash
/copilot:rescue investigate why the tests started failing
/copilot:rescue fix the failing test with the smallest safe patch
/copilot:rescue --resume apply the top fix from the last run
/copilot:rescue --model gpt-5.4 --effort medium investigate the flaky integration test
/copilot:rescue --background investigate the regression
```

You can also just ask for a task to be delegated to Copilot:

```text
Ask Copilot to redesign the database connection to be more resilient.
```

**Notes:**

- if you do not pass `--model` or `--effort`, Copilot chooses its own defaults.
- explicit model IDs are passed through; availability depends on your Copilot account, not a static plugin list
- supported effort values are `low`, `medium`, `high`, `xhigh`, and `max`; the selected model must support the requested value
- follow-up rescue requests can continue the latest Copilot task owned by the current Claude session
- Claude's ownership ID and the resumable Copilot session ID are stored separately

### `/copilot:ping-pong`

Starts one resident SDK client and Copilot session for the current Claude conversation and repository. Unlike `/copilot:rescue --resume`, it keeps the process and connection alive between turns.

Claude sends the task, watches for the result, checks the actual work, and either finishes or sends one focused follow-up on the same connection. The initial Copilot turn counts toward a **five-round maximum**. After round five, Claude reports what remains and waits; only an explicit user continuation starts another five-round batch. Completed and limit-reached sessions stay idle without submitting new prompts.

```bash
/copilot:ping-pong fix the flaky test and verify the smallest safe patch
/copilot:ping-pong status
/copilot:ping-pong continue address the remaining edge case
/copilot:ping-pong stop
```

Model, effort, and read/write permission are fixed when the resident session starts. Implementation and explicit test-execution requests authorize a write-capable session; diagnosis and research remain read-only. Stop and restart to change these settings. SDK errors and approval requests halt automatic handoffs rather than triggering retries.

Automatic handoffs use Claude's `Monitor` notifications, not a second Claude process. Without Monitor, the slash command does not start automatic work. If a watch is denied or becomes unavailable after launch, Claude pauses handoffs and reports the job ID for `/copilot:status` and `/copilot:result`; the current turn can still finish. Concurrent submissions are rejected, and continuation requests name the completed turn so a repeated notification cannot send it twice.

`/copilot:cancel <turn-job-id>` stops that resident session as well as its active turn. Normal Claude `SessionEnd` stops both busy and idle workers owned by that conversation while preserving finished results. A force-kill that bypasses hooks can leave a worker behind; stop it before forcibly closing Claude, or resume the owning Claude conversation to run `ping-pong stop`.

The internal helper also exposes `send --after <completed-job-id>` and `finish --after <completed-job-id>` for Claude's controller. Ordinary rescue continuation never reopens a session that belongs to the Ping-pong controller.

### `/copilot:status`

Shows running and recent Copilot jobs for the current repository and Claude session. Without a Claude session ID, the runtime falls back to repository-wide selection.

Examples:

```bash
/copilot:status
/copilot:status task-abc123
```

Use it to:

- check progress on background work
- see the latest completed job
- confirm whether a task is still running

### `/copilot:result`

Shows the final stored Copilot output for a finished job.
When available, it also includes the Copilot session ID so you can reopen that run directly in Copilot with `copilot resume <session-id>`.

Examples:

```bash
/copilot:result
/copilot:result task-abc123
```

### `/copilot:cancel`

Cancels an active background Copilot job.

Examples:

```bash
/copilot:cancel
/copilot:cancel task-abc123
```

### `/copilot:setup`

Checks whether Copilot is installed and authenticated.
If Copilot is missing and npm is available, it can offer to install Copilot for you.

You can also use `/copilot:setup` to manage the optional review gate.

#### Enabling review gate

```bash
/copilot:setup --enable-review-gate
/copilot:setup --disable-review-gate
```

When enabled, `UserPromptSubmit` captures a Git tree snapshot and `Stop` reviews only the changes made during that turn's time window. Pre-existing changes are excluded; changes made by delegated or external processes during that window are included, even if committed before Claude stops. Claude's final response is context, not the review scope.

No-change turns skip Copilot. Each turn is reviewed at most once, and an active stop hook cannot recursively trigger the gate. Findings, authentication failures, and invalid verdicts block the stop once; this is not an unlimited auto-fix loop or a guarantee that Claude's subsequent fixes are re-reviewed.

While a Ping-pong turn is actively running, the gate defers review without consuming its snapshot, avoiding a review of files Copilot is still editing.

Snapshots use a temporary Git index and leave your real index and working tree unchanged, but write objects into Git's object database. Git-ignored files and uncommitted changes inside submodules are outside this tree-diff scope. The gate adds review latency and Copilot usage; enable it deliberately. After first enabling it, tracking begins with the next user prompt.

## Typical Flows

### Review Before Shipping

```bash
/copilot:review
```

### Hand A Problem To Copilot

```bash
/copilot:rescue investigate why the build is failing in CI
```

### Start Something Long-Running

```bash
/copilot:adversarial-review --background
/copilot:rescue --background investigate the flaky test
```

Then check in with:

```bash
/copilot:status
/copilot:result
```

When `Monitor` is available and permitted, the main conversation watches that job's file and reads the result once it finishes. Watches are scoped to individual jobs, not broadcast to every Claude session. By default, Monitor watches last five minutes; Claude caps them at 30 minutes, or 10 minutes in single-prompt `-p` runs. If monitoring is unavailable, denied, or expires, the job keeps running and `/copilot:status` and `/copilot:result` remain available. A forwarding subagent that returns a detached job cannot arm Monitor itself, so use those commands unless the main conversation starts the watch.

Jobs belong to the Claude session that started them. Ending that session cancels its active jobs but keeps completed history and the Copilot session IDs.

## Copilot Integration

The plugin uses `@github/copilot-sdk` and its managed Copilot runtime over SDK RPC. The installed plugin declares and locks its own dependencies; the runtime does not depend on finding the SDK in the marketplace repository's parent directory.

### Models and Effort

Use `--model <model-id>` and `--effort <value>` on `/copilot:rescue` or when starting `/copilot:ping-pong` to choose task settings explicitly:

```bash
/copilot:rescue --model gpt-5.4 --effort high investigate the flaky test
```

Model availability and supported effort levels depend on Copilot and your account. Omitted settings use the SDK/runtime defaults. The plugin does not read `.copilot/config.toml` or translate arbitrary model aliases.

### Permission Boundary

Read-only tasks and reviews expose only built-in file search/view and web lookup tools; they cannot run shell commands, write files, or invoke external tools. Explicit write-capable rescue tasks permit normal Copilot tool requests in the shared checkout. Requests requiring managed human approval or a sandbox bypass are rejected instead of being automatically approved.

Copilot is a separate runtime. It does **not** inherit Claude Code's tool permission rules or sandbox merely because Claude launched it. Review changes before trusting a write-capable task. SDK turns have a 15-minute timeout; this is separate from the shorter Monitor notification deadline.

### Moving The Work Over To Copilot

Delegated tasks can also be resumed inside Copilot by running `copilot resume <copilot-session-id>` with the ID shown by `/copilot:result` or `/copilot:status`. Stop a resident Ping-pong session before opening its Copilot session in another client. Stop-gate reviews do not replace the rescue continuation candidate.

This way you can review the Copilot work or continue the work there.

## FAQ

### Do I need a separate Copilot account for this plugin?

If you are already signed into Copilot on this machine, that account should work immediately here too. This plugin uses your local Copilot CLI authentication.

If you only use Claude Code today and have not used Copilot yet, you will also need to sign in to Copilot with a GitHub account. [Copilot is available with various GitHub subscription plans](https://docs.github.com/en/copilot/about-github-copilot/subscription-plans-for-github-copilot). Run `/copilot:setup` to check readiness, and use `!copilot login` if needed. In a headless environment, use `!copilot login --device-code`. Never paste tokens into Claude messages or command arguments.

### Does the plugin use a separate Copilot runtime?

Yes. Ordinary commands start and stop a managed local Copilot process for each invocation. Ping-pong keeps its own managed process alive for the Claude conversation; neither mode attaches to an already-running interactive Copilot terminal.

That means:

- it uses the SDK's runtime dependency, which can differ from your global CLI version
- it uses the local Copilot authentication state available to that process
- it uses the same repository checkout and machine-local environment

### Will it use the same Copilot config I already have?

Do not assume complete parity with an interactive CLI session. The plugin passes its own session configuration, and SDK configuration discovery is not enabled. Use the plugin's explicit model and effort flags rather than relying on repository config, hooks, or custom agents being loaded.

### Can I keep using my current token or base URL setup?

Authentication methods and provider configuration must be supported by the installed SDK/runtime. `/copilot:setup` checks the SDK's actual authentication status rather than assuming that a global CLI installation is authenticated.

The plugin does not implement a `base_url` override or promise to read Codex-style `config.toml` settings.

### Is this a persistent interactive Ping-pong session?

Use `/copilot:ping-pong` for a persistent SDK connection, serialized turns, and automatic Claude/Copilot handoffs. Follow-up rescue calls still restore history with a new client each time, and ordinary `--background` jobs are not converted into resident sessions.
