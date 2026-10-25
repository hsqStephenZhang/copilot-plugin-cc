---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the Copilot rescue subagent
argument-hint: "[--background|--wait] [--resume|--fresh] [--model <model>] [--effort <low|medium|high|xhigh|max>] [what Copilot should investigate, solve, or continue]"
disable-model-invocation: true
allowed-tools: Bash(node:*), AskUserQuestion
---

Run this request directly through the Copilot companion runtime.
Stay in the main conversation so that continuation questions and `--wait` work.
Do not spawn a forwarding subagent for this slash command.
The final user-visible response must be Copilot's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, pass it to `task`. The runtime starts a background worker and returns a job ID.
- If the request includes `--wait`, pass it to `task` and wait for that Bash call's output.
- If neither flag is present, default to foreground.
- `--background` and `--wait` are runtime execution flags, not part of the natural-language task text. Never also background the Bash call.
- `--model` and `--effort` are runtime-selection flags. Preserve them for the forwarded `task` call, but do not treat them as part of the natural-language task text.
- If the request includes `--resume`, do not ask whether to continue. The user already chose.
- If the request includes `--fresh`, do not ask whether to continue. The user already chose.
- Otherwise, before starting Copilot, check for a resumable rescue thread from this Claude session by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" task-resume-candidate --json
```

- If that helper reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue the current Copilot thread or start a new one.
- The two choices must be:
  - `Continue current Copilot thread`
  - `Start a new Copilot thread`
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current Copilot thread (Recommended)` first.
- Otherwise put `Start a new Copilot thread (Recommended)` first.
- If the user chooses continue, add `--resume`.
- If the user chooses a new thread, add `--fresh`.
- If the helper reports `available: false`, do not ask. Run normally.

Operating rules:

- After the optional continuation check, use one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" task ...`.
- Add `--write` for an explicit implementation or fix request. Omit it for review, diagnosis, planning, and research without edits.
- Keep routing and runtime flags separate from the task text. For complex or multiline task text, use `--prompt-file` rather than embedding unescaped text in a shell command.
- Return the Copilot companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not inspect files, poll status, fetch results, or do independent follow-up work.
- Leave `--effort` unset unless the user explicitly asks for a specific reasoning effort.
- Leave the model unset unless the user explicitly asks for one. If they ask for `codex`, map it to `gpt-5.3-codex`; pass other concrete model IDs unchanged.
- Leave `--resume` and `--fresh` in the runtime arguments.
- On failure, report the error. Never return an empty response or claim success.
- After a background launch, if `Monitor` is available, start one watch for the absolute `Job file` path returned by the helper:
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/job-monitor.mjs" "<job-file>"`
- Launch that watcher with the `Monitor` tool, not foreground Bash. It emits exactly one terminal-status line and exits. Fetch `/copilot:result <job-id>` once when notified.
- If Monitor is unavailable, denied, or reaches its deadline, preserve the job ID and the `/copilot:status` / `/copilot:result` fallback. Do not cancel the worker or repeatedly poll.
- If the helper reports that Copilot is missing or unauthenticated, stop and tell the user to run `/copilot:setup`.
- If the user did not supply a request, ask what Copilot should investigate or fix.
