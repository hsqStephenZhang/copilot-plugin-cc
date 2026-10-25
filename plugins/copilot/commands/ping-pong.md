---
description: Keep Copilot resident and automatically hand work back and forth with Claude, up to five rounds
argument-hint: "[start|continue|status|stop] [--model <id>] [--effort <value>] [task]"
disable-model-invocation: true
allowed-tools: Read, Write, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a session-owned, automatic Claude/Copilot Ping-pong task in this main conversation. Do not fork a subagent or start another Claude CLI. Copilot stays connected between turns; you inspect its work and decide the next step. The resident process exits when this Claude session ends.

User request:
$ARGUMENTS

## Starting and user controls

- `status` and `stop`: run the corresponding helper action and report its output. These do not require Monitor.
- A new task, optionally prefixed `start`: start automatic handoffs only if the `Monitor` tool is available. If it is unavailable, explain that automatic Ping-pong requires Monitor; do not silently start an unattended task.
- If there is no task text, ask what the user wants done.
- Run the helper in normal foreground Bash; the helper owns the resident worker. Do not background Bash or wrap it in another background task.
- Add `--write` only when the user authorizes implementation, fixes, or test execution. Diagnosis, planning, and research stay read-only.
- Preserve explicit `--model` and `--effort`; otherwise leave them unset. They and write permission stay fixed for the resident session. To change them, stop the old session and start a new one; never escalate permissions during an automatic handoff.
- For complex instructions, use `--prompt-file` with a literal instruction file under the plugin data directory. Do not embed unescaped user text in a shell command.

Helper:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" ping-pong start --json <task-and-authorized-flags>
```

It returns the resident session, turn job ID, and absolute job file. If a session already has an open task, read its status instead of replacing it. A finished task can start a new batch on the same resident connection with unchanged execution settings.

## Automatic handoff loop

1. Arm exactly one `Monitor` watch for the returned job file:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/job-monitor.mjs" "<absolute-job-file>"`
   Never run this watcher in foreground Bash. Use a deadline covering one SDK turn, up to 15 minutes. If a watch expires while the job is active, re-arm a watch for that same job; do not submit a second turn or busy-poll.
2. On its terminal notification, read that job's result and `ping-pong status --json` once. Ignore old notifications when their job ID is not the session's `lastJobId`, when another turn is active, or when this task was already marked complete.
3. If the job failed, was cancelled, or needs approval, pause automation and report the concrete issue. Do not retry automatically or open another session to bypass an approval.
4. Inspect the actual result and relevant changes; perform focused verification when authorized. Judge against the user's original goal, not only Copilot's claim that it is done.
5. If complete, run `ping-pong finish --after <completed-job-id>` and report the outcome. The Copilot connection remains idle for a later request.
6. If incomplete and fewer than five rounds have been submitted, prepare one concrete follow-up with your findings and run:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" ping-pong send --after <completed-job-id> --json <follow-up>`
   Do not re-send model, effort, or write flags. Return to step 1 for its new job file.
7. After round five, stop sending, report what remains, and wait for the user. Keep the resident session idle. Never use `start`, `continue`, `finish`, or a new Claude/Copilot session to reset the budget automatically.

The five-round limit counts the initial Copilot turn. Only an explicit user continuation can start another five-round batch using `ping-pong continue <new-instructions>`. If the user says continue before the current batch is exhausted, use a normal `send --after <last-job-id>` instead of resetting the budget.

If Monitor is denied or becomes unavailable after launch, stop automatic handoffs and report the job ID with `/copilot:status` and `/copilot:result` fallbacks. Do not claim the task finished. Do not repeatedly retry a denied watch. Stop immediately when the user requests it.
