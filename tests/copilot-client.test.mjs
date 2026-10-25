import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { FakeCopilotClient } from "./fake-copilot-fixture.mjs";
import { createSession, runPrompt } from "../plugins/copilot/scripts/lib/copilot-client.mjs";

// We test the module's exported functions by mocking the SDK.
// Since the module uses a real import, we test the logic patterns here.

describe("copilot-client patterns", () => {
  let client;

  beforeEach(() => {
    client = new FakeCopilotClient();
  });

  describe("SDK permission and execution contract", () => {
    it("restricts read-only sessions to built-in read tools and rejects shell, write, and MCP requests", async () => {
      const session = await createSession({}, new FakeCopilotClient());
      assert.deepEqual(session.config.availableTools, [
        "builtin:view", "builtin:glob", "builtin:grep", "builtin:web_fetch", "builtin:web_search"
      ]);
      for (const kind of ["write", "shell", "mcp", "custom-tool", "workflow", "unknown"]) {
        assert.equal(session.config.onPermissionRequest({ kind }).kind, "reject");
      }
      assert.equal(session.config.onPermissionRequest({ kind: "read" }).kind, "approved");
    });

    it("permits explicit write tasks but never auto-approves managed or sandbox escalation requests", async () => {
      const session = await createSession({ write: true, reasoningEffort: "high", systemMessage: "Review" }, new FakeCopilotClient());
      assert.equal(session.config.availableTools, undefined);
      assert.equal(session.config.onPermissionRequest({ kind: "write" }).kind, "approved");
      assert.equal(session.config.onPermissionRequest({ kind: "shell", managedApprovalRequired: true }).kind, "reject");
      assert.equal(session.config.onPermissionRequest({ kind: "shell", requestSandboxBypass: true }).kind, "reject");
      assert.equal(session.config.reasoningEffort, "high");
      assert.deepEqual(session.config.systemMessage, { mode: "append", content: "Review" });
    });

    it("waits beyond the SDK's one-minute default and releases session listeners", async () => {
      const session = await createSession({}, new FakeCopilotClient());
      await runPrompt(session, "Review");
      assert.equal(session.timeout, 15 * 60 * 1000);
      assert.equal(session.listeners.length, 0);
      assert.equal(session.disconnected, true);
    });

    it("releases sessions after prompt failures", async () => {
      const session = await createSession({}, new FakeCopilotClient());
      session.sendAndWait = async () => { throw new Error("Disconnected"); };
      await assert.rejects(runPrompt(session, "Review"), /Disconnected/);
      assert.equal(session.listeners.length, 0);
      assert.equal(session.disconnected, true);
    });
  });

  it("client lifecycle: start and stop", async () => {
    await client.start();
    assert.equal(client.started, true);
    await client.stop();
    assert.equal(client.stopped, true);
  });

  it("creates session with config", async () => {
    await client.start();
    const session = await client.createSession({
      model: "gpt-5.4",
      streaming: true,
      sessionId: "test-session"
    });
    assert.equal(session.config.model, "gpt-5.4");
    assert.equal(session.config.sessionId, "test-session");
  });

  it("sendAndWait returns canned response", async () => {
    await client.start();
    client.setSessionConfig({ _cannedResponse: { data: { content: "Hello from Copilot" } } });
    const session = await client.createSession({ model: "gpt-5.4" });
    const response = await session.sendAndWait({ prompt: "test" });
    assert.equal(response.data.content, "Hello from Copilot");
  });

  it("session abort records call", async () => {
    await client.start();
    const session = await client.createSession({});
    await session.abort();
    assert.equal(session.aborted, true);
  });

  it("session emits events to listeners", async () => {
    await client.start();
    const events = [];
    client.setSessionConfig({
      _cannedEvents: [
        { type: { value: "assistant.message_delta" }, data: { deltaContent: "chunk1" } },
        { type: { value: "session.idle" }, data: {} }
      ],
      _cannedResponse: { data: { content: "full response" } }
    });
    const session = await client.createSession({});
    session.on((event) => events.push(event.type.value));
    await session.sendAndWait({ prompt: "test" });
    assert.deepEqual(events, ["assistant.message_delta", "session.idle"]);
  });
});
