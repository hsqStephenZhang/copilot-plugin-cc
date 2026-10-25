/**
 * Mock CopilotClient and CopilotSession for testing.
 * Replaces the real @github/copilot-sdk in tests.
 */

import fs from "node:fs";

export class FakeCopilotSession {
  constructor(config = {}) {
    this.config = config;
    this.sessionId = config.sessionId ?? "generated-session";
    this.listeners = [];
    this.aborted = false;
    this.disconnected = false;
    this.messages = [];
    this._cannedResponse = config._cannedResponse ?? { data: { content: "Mock response" } };
    this._cannedEvents = config._cannedEvents ?? [];
  }

  on(handler) {
    this.listeners.push(handler);
    return () => { this.listeners = this.listeners.filter((listener) => listener !== handler); };
  }

  _emit(event) {
    for (const handler of this.listeners) {
      handler(event);
    }
  }

  async send(options) {
    this.messages.push(options);
    for (const event of this._cannedEvents) {
      this._emit(event);
    }
  }

  async sendAndWait(options, timeout) {
    this.timeout = timeout;
    if (process.env.COPILOT_TEST_PROMPT) {
      fs.writeFileSync(process.env.COPILOT_TEST_PROMPT, options.prompt);
    }
    this.messages.push(options);
    for (const event of this._cannedEvents) {
      this._emit(event);
    }
    return this._cannedResponse;
  }

  async abort() {
    this.aborted = true;
  }

  async disconnect() {
    this.disconnected = true;
  }
}

export class FakeCopilotClient {
  constructor() {
    this.started = false;
    this.stopped = false;
    this.sessions = [];
    this._sessionConfig = {};
  }

  setSessionConfig(config) {
    this._sessionConfig = config;
  }

  async start() {
    this.started = true;
  }

  async stop() {
    this.stopped = true;
  }

  async createSession(config) {
    const session = new FakeCopilotSession({ ...config, ...this._sessionConfig });
    this.sessions.push(session);
    return session;
  }

  async resumeSession(sessionId, config) {
    this.resumedSessionId = sessionId;
    return this.createSession({ ...config, sessionId });
  }
}

export class CopilotClient extends FakeCopilotClient {
  async getAuthStatus() {
    return { isAuthenticated: process.env.COPILOT_TEST_AUTH !== "false" };
  }

  async createSession(config) {
    if (process.env.COPILOT_TEST_TRACE) {
      fs.appendFileSync(process.env.COPILOT_TEST_TRACE, `${JSON.stringify(config)}\n`);
    }
    this.setSessionConfig({
      _cannedResponse: { data: { content: process.env.COPILOT_TEST_RESPONSE ?? "Task completed." } }
    });
    return super.createSession(config);
  }
}
