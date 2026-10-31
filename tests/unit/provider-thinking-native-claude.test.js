import { beforeEach, describe, expect, it, vi } from "vitest";
import "../translator/registerAll.js";

const { executeMock, forcedSSEToJsonMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  forcedSSEToJsonMock: vi.fn(),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({
    noAuth: true,
    execute: executeMock,
  }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));

vi.mock("../../open-sse/handlers/chatCore/sseToJsonHandler.js", () => ({
  handleForcedSSEToJson: forcedSSEToJsonMock,
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

const CLAUDE_CLI_UA = "claude-cli/2.1.316 (external, cli)";

async function runClaude({
  model = "claude-opus-5-5",
  body = { model, max_tokens: 64, messages: [{ role: "user", content: "Reply OK." }] },
  headers = { "user-agent": CLAUDE_CLI_UA },
  providerThinking,
  customPromptEnabled = false,
  customPrompt,
  provider = "claude",
  sourceFormatOverride = "claude",
  endpoint = "/v1/messages",
} = {}) {
  await handleChatCore({
    body,
    modelInfo: { provider, model },
    credentials: { accessToken: "test-token", providerSpecificData: {} },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    connectionId: "test-connection",
    rtkEnabled: false,
    headroomEnabled: false,
    cavemanEnabled: false,
    ponytailEnabled: false,
    pxpipeEnabled: false,
    customPromptEnabled,
    customPrompt,
    providerThinking,
    sourceFormatOverride,
    clientRawRequest: { endpoint, body, headers },
  });

  return executeMock.mock.calls.at(-1)[0].body;
}

describe("provider thinking on native Claude requests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeMock.mockResolvedValue({
      response: new Response("", { status: 200 }),
      url: "https://api.anthropic.com/v1/messages",
      headers: {},
      transformedBody: null,
    });
    forcedSSEToJsonMock.mockResolvedValue({
      success: true,
      response: new Response("{}", { status: 200 }),
    });
  });

  it("sets output_config.effort and never top-level reasoning_effort on a Claude CLI request", async () => {
    const body = await runClaude({ providerThinking: { mode: "xhigh" } });

    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body.output_config.effort).toBe("xhigh");
  });

  it("keeps the client's own output_config.effort", async () => {
    const body = await runClaude({
      providerThinking: { mode: "xhigh" },
      body: { model: "claude-opus-5-5", max_tokens: 64, output_config: { effort: "low" }, messages: [{ role: "user", content: "Reply OK." }] },
    });

    expect(body.output_config.effort).toBe("low");
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("detects Claude Code by x-app: cli alone", async () => {
    const body = await runClaude({
      providerThinking: { mode: "xhigh" },
      headers: { "user-agent": "generic-client/1.0", "x-app": "cli" },
    });

    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("keeps the translation path free of top-level reasoning_effort for Claude-format clients", async () => {
    const body = await runClaude({
      providerThinking: { mode: "xhigh" },
      headers: { "user-agent": "generic-client/1.0" },
    });

    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("keeps output_config.effort for Haiku 5+ (adaptive effort)", async () => {
    const body = await runClaude({
      model: "claude-haiku-5-5",
      providerThinking: { mode: "xhigh" },
    });

    expect(body.output_config.effort).toBe("xhigh");
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("keeps the on mode as body.thinking", async () => {
    const body = await runClaude({ providerThinking: { mode: "on" } });

    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 10000 });
    expect(body).not.toHaveProperty("output_config");
  });

  it("skips the custom prompt when the token-saver header is off", async () => {
    const withHeader = await runClaude({
      customPromptEnabled: true,
      customPrompt: "SENTINEL_CUSTOM_PROMPT",
      headers: { "user-agent": CLAUDE_CLI_UA, "x-9router-token-saver": "off" },
    });
    expect(JSON.stringify(withHeader)).not.toContain("SENTINEL_CUSTOM_PROMPT");

    const withoutHeader = await runClaude({
      customPromptEnabled: true,
      customPrompt: "SENTINEL_CUSTOM_PROMPT",
    });
    expect(JSON.stringify(withoutHeader)).toContain("SENTINEL_CUSTOM_PROMPT");
  });

  it("sets body.reasoning.effort for Responses-format clients and no top-level reasoning_effort", async () => {
    const body = await runClaude({
      provider: "codex",
      model: "gpt-6.1-sol",
      sourceFormatOverride: "openai-responses",
      endpoint: "/v1/responses",
      providerThinking: { mode: "high" },
      body: { model: "gpt-6.1-sol", input: "hello", stream: false },
      headers: { "user-agent": "codex_cli_rs/0.166.0" },
    });

    expect(body.reasoning.effort).toBe("high");
    expect(body).not.toHaveProperty("reasoning_effort");
  });
});
