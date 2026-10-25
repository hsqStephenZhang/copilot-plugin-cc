import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { FakeCopilotClient } from "./fake-copilot-fixture.mjs";
import { buildPersistentTaskSessionId, createSession, parseStructuredOutput, runPrompt } from "../plugins/copilot/scripts/lib/copilot-client.mjs";

describe("runtime: buildPersistentTaskSessionId", () => {
  it("returns session ID with task prefix", () => {
    const id = buildPersistentTaskSessionId("Fix the authentication bug");
    assert.match(id, /^copilot-companion-task-fix-the-authentication-bug-/);
    assert.notEqual(id, buildPersistentTaskSessionId("Fix the authentication bug"));
  });

  it("handles empty prompt", () => {
    const id = buildPersistentTaskSessionId("");
    assert.match(id, /^copilot-companion-task-[a-f0-9-]+$/);
    assert.notEqual(id, buildPersistentTaskSessionId(""));
  });

  it("shortens long prompts", () => {
    const longPrompt = "A".repeat(100);
    const id = buildPersistentTaskSessionId(longPrompt);
    assert.ok(id.length < 120);
  });

  it("does not collide for non-Latin prompts", () => {
    assert.notEqual(buildPersistentTaskSessionId("修复"), buildPersistentTaskSessionId("检查"));
  });
});

describe("runtime: session routing", () => {
  it("resumes the Copilot session with its working directory", async () => {
    const client = new FakeCopilotClient();
    const session = await createSession({
      sessionId: "copilot-123", resume: true, cwd: "/workspace/isolated-worktree"
    }, client);
    assert.equal(client.resumedSessionId, "copilot-123");
    assert.equal(session.config.workingDirectory, "/workspace/isolated-worktree");
    const result = await runPrompt(session, "Continue");
    assert.equal(result.sessionId, "copilot-123");
  });
});

describe("runtime: parseStructuredOutput", () => {
  it("parses valid JSON", () => {
    const result = parseStructuredOutput('{"verdict":"pass","summary":"All good"}');
    assert.equal(result.parsed.verdict, "pass");
    assert.equal(result.parseError, null);
  });

  it("handles invalid JSON", () => {
    const result = parseStructuredOutput("not json");
    assert.equal(result.parsed, null);
    assert.ok(result.parseError);
  });

  it("handles empty output", () => {
    const result = parseStructuredOutput("");
    assert.equal(result.parsed, null);
    assert.ok(result.parseError);
  });
});

describe("runtime: FakeCopilotClient end-to-end flow", () => {
  it("full task flow: start -> session -> prompt -> response", async () => {
    const client = new FakeCopilotClient();
    client.setSessionConfig({
      _cannedResponse: { data: { content: "Task completed successfully." } }
    });

    await client.start();
    const session = await client.createSession({
      model: "gpt-5.4",
      sessionId: "task-session-1"
    });

    const response = await session.sendAndWait({ prompt: "Fix the bug" });
    assert.equal(response.data.content, "Task completed successfully.");

    await client.stop();
    assert.equal(client.stopped, true);
  });

  it("full review flow with streaming events", async () => {
    const client = new FakeCopilotClient();
    const collectedEvents = [];

    client.setSessionConfig({
      _cannedEvents: [
        { type: { value: "tool.execution_start" }, data: { toolName: "read_file" } },
        { type: { value: "assistant.message_delta" }, data: { deltaContent: "Review: " } },
        { type: { value: "session.idle" }, data: {} }
      ],
      _cannedResponse: { data: { content: '{"verdict":"pass","summary":"LGTM"}' } }
    });

    await client.start();
    const session = await client.createSession({ model: "gpt-5.4" });
    session.on((event) => collectedEvents.push(event.type.value));

    const response = await session.sendAndWait({ prompt: "Review this diff" });
    const parsed = parseStructuredOutput(response.data.content);

    assert.equal(parsed.parsed.verdict, "pass");
    assert.deepEqual(collectedEvents, ["tool.execution_start", "assistant.message_delta", "session.idle"]);
  });
});
