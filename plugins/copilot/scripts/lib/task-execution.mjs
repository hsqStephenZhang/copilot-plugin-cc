import { runPrompt } from "./copilot-client.mjs";
import { renderTaskResult } from "./render.mjs";

export async function executeTaskPrompt(session, request, options = {}) {
  const result = await runPrompt(session, request.prompt, {
    onProgress: request.onProgress,
    keepAlive: Boolean(options.keepAlive)
  });
  const rawOutput = result.content ?? "";
  const title = options.title ?? (request.resumeLast ? "Copilot Resume" : "Copilot Task");
  const reasoningSummary = result.reasoning ? [result.reasoning] : [];
  return {
    exitStatus: rawOutput ? 0 : 1,
    copilotSessionId: result.sessionId,
    payload: {
      status: rawOutput ? 0 : 1,
      sessionId: result.sessionId,
      rawOutput,
      touchedFiles: [],
      reasoningSummary
    },
    rendered: renderTaskResult(
      { rawOutput, failureMessage: "", reasoningSummary },
      { title, jobId: request.jobId ?? null, write: Boolean(request.write) }
    ),
    summary: rawOutput.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? `${title} finished.`,
    jobTitle: title,
    jobClass: "task",
    write: Boolean(request.write)
  };
}
