import "../translator/registerAll.js";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { normalizeClaudePassthrough } from "../../open-sse/translator/formats/claude.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { handleNonStreamingResponse } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";
import { handleForcedSSEToJson } from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";

const binding = { prefix_mismatch_behavior: "error" };
const request = (model = "claude-opus-5-5") => ({
  model, max_tokens: 4096, thinking: { type: "adaptive", display: "summarized", block_binding: binding },
  messages: [{ role: "user", content: "hello" }],
});

describe("Claude block binding", () => {
  it.each(["claude-opus-5-5", "claude-haiku-5-5"])("keeps client binding on adaptive %s", model => {
    const result = applyThinking(FORMATS.CLAUDE, model, request(model), "claude");
    expect(result.thinking).toEqual({ type: "adaptive", display: "summarized", block_binding: binding });
  });

  it("keeps client binding on enabled-budget Claude", () => {
    const body = request("claude-3-7-sonnet-20250219");
    body.thinking = { type: "enabled", budget_tokens: 2048, block_binding: binding };
    expect(applyThinking(FORMATS.CLAUDE, body.model, body, "claude").thinking)
      .toEqual({ type: "enabled", budget_tokens: 2048, block_binding: binding });
  });

  it("does not attach a binding to disabled or removed thinking", () => {
    const disabled = request("claude-opus-4-6");
    disabled.thinking = { type: "disabled", block_binding: binding };
    expect(applyThinking(FORMATS.CLAUDE, disabled.model, disabled, "claude").thinking).toEqual({ type: "disabled" });
    const noReasoning = request("unknown-model");
    expect(applyThinking(FORMATS.CLAUDE, noReasoning.model, noReasoning, "claude").thinking).toBeUndefined();
    const omitted = request("claude-opus-5-5(none)");
    delete omitted.thinking.display;
    expect(applyThinking(FORMATS.CLAUDE, omitted.model, omitted, "claude").thinking).toBeUndefined();
    const passthrough = request();
    passthrough.thinking = { type: "disabled", block_binding: binding };
    expect(normalizeClaudePassthrough(passthrough, passthrough.model, "claude").thinking).toEqual({ type: "disabled" });
  });

  it.each([FORMATS.CLAUDE, FORMATS.OPENAI])("does not recover a binding from disabled %s input even when effort enables thinking", source => {
    const body = request("claude-opus-4-6");
    body.thinking = { type: "disabled", block_binding: binding };
    body.output_config = { effort: "high" };
    const out = translateRequest(source, FORMATS.CLAUDE, body.model, body, true, null, "claude");
    expect(out.thinking?.type).toBe("adaptive");
    expect(out.thinking?.block_binding).toBeUndefined();
  });

  it("never adds a binding the client did not send", () => {
    const body = request();
    delete body.thinking.block_binding;
    const result = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, body.model, body, true, null, "claude");
    expect(result.thinking).not.toHaveProperty("block_binding");
  });

  it.each([FORMATS.CLAUDE, FORMATS.OPENAI])("preserves the original binding through %s → Claude", sourceFormat => {
    const body = request();
    const out = translateRequest(sourceFormat, FORMATS.CLAUDE, body.model, body, true, null, "claude");
    expect(out.thinking).toEqual({ type: "adaptive", display: "summarized", block_binding: binding });
  });

  it.each([FORMATS.CLAUDE, FORMATS.OPENAI])("preserves active binding without display through %s → Claude", sourceFormat => {
    const body = request();
    delete body.thinking.display;
    const out = translateRequest(sourceFormat, FORMATS.CLAUDE, body.model, body, true, null, "claude");
    expect(out.thinking).toEqual({ type: "adaptive", block_binding: binding });
  });

  it("keeps the binding when an OpenAI tool result becomes a Claude user turn", () => {
    const body = request();
    body.reasoning_effort = "high";
    body.messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "ok" },
    ];
    const out = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, body.model, body, true, null, "claude");
    expect(out.messages.at(-1).role).toBe("user");
    expect(out.thinking.block_binding).toEqual(binding);
  });

  it("retains binding when native passthrough downgrades to enabled", () => {
    const body = request("claude-haiku-4-5");
    expect(normalizeClaudePassthrough(body, body.model, "claude").thinking)
      .toEqual({ type: "enabled", budget_tokens: 10000, block_binding: binding });
  });

  it("does not add binding to other providers' rebuilt thinking", () => {
    const body = request();
    const out = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, body.model, body, true, null, "anthropic-compatible-custom");
    expect(out.thinking?.block_binding).toBeUndefined();
  });

  it("does not leak Claude display to another provider during translation", () => {
    const body = request();
    const out = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, body.model, body, true, null, "anthropic-compatible-custom");
    expect(out.thinking?.display).toBeUndefined();
  });

  it("forwards the client's beta flag to the Claude upstream headers", () => {
    const headers = new DefaultExecutor("claude").buildHeaders({ apiKey: "test", rawHeaders: { "anthropic-beta": "thinking-binding-controls-2026-08-01" } }, true, undefined, "claude-opus-5-5");
    expect(headers["Anthropic-Beta"].split(",").map(flag => flag.trim())).toContain("thinking-binding-controls-2026-08-01");
  });
});

describe("Claude non-stream SSE diagnostics", () => {
  const entries = [
    { type: "thinking_dropped", reason: "prefix_binding_mismatch", path: "private-content" },
    { type: "thinking_dropped", reason: "unknown-private-content", path: "private-content" },
  ];
  const sse = entries => `event: message_start\r\ndata: ${JSON.stringify({ type: "message_start", message: { input_transformations: entries, content: "private-content" } })}\r\n\r\n`
    + `data: ${JSON.stringify({ choices: [{ delta: { content: "answer" }, finish_reason: "stop" }] })}\n\n`;
  const nativeSSE = entries => [
    { type: "message_start", message: { id: "msg_1", role: "assistant", model: "claude-opus-5-5", content: [], usage: { input_tokens: 1, output_tokens: 0 }, input_transformations: entries } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "answer" } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  const context = raw => ({
    providerResponse: new Response(raw, { headers: { "content-type": "text/event-stream" } }),
    provider: "claude", model: "claude-opus-5-5", sourceFormat: FORMATS.OPENAI, targetFormat: FORMATS.CLAUDE,
    body: { messages: [] }, stream: false, requestStartTime: Date.now(), reqTag: "tag",
    trackDone: vi.fn(), appendLog: vi.fn(), reqLogger: { logProviderResponse: vi.fn(), logConvertedResponse: vi.fn() },
    log: { line: vi.fn() }, observeClaudeThinking: true,
  });
  for (const [name, handler] of [["non-streaming", handleNonStreamingResponse], ["forced SSE", handleForcedSSEToJson]]) {
    it(`${name} logs only the two dropped counts once`, async () => {
      const ctx = context(sse(entries));
      expect((await handler(ctx)).success).toBe(true);
      const diagnostics = ctx.log.line.mock.calls.filter(call => call[2].startsWith("THINKING"));
      expect(diagnostics).toEqual([["tag", "⚙", "THINKING dropped=2 reasons=prefix_binding_mismatch:1,other:1"]]);
      expect(JSON.stringify(ctx.log.line.mock.calls)).not.toContain("private-content");
    });

    it(`${name} does not log an empty transformation array`, async () => {
      const ctx = context(sse([]));
      expect((await handler(ctx)).success).toBe(true);
      expect(ctx.log.line.mock.calls.some(call => call[2].startsWith("THINKING"))).toBe(false);
    });

    it(`${name} observes an unterminated message_delta`, async () => {
      const ctx = context(`data: ${JSON.stringify({ type: "message_delta", input_transformations: entries })}`);
      await handler(ctx);
      expect(ctx.log.line.mock.calls.filter(call => call[2].startsWith("THINKING"))).toHaveLength(1);
    });

    it(`${name} leaves observation off when the provider is not Claude`, async () => {
      const ctx = context(sse(entries));
      ctx.observeClaudeThinking = false;
      await handler(ctx);
      expect(ctx.log.line.mock.calls.some(call => call[2].startsWith("THINKING"))).toBe(false);
    });

    it(`${name} observes a real Claude-shaped event stream before conversion`, async () => {
      const ctx = context(nativeSSE(entries));
      expect((await handler(ctx)).success).toBe(true);
      expect(ctx.log.line.mock.calls.filter(call => call[2].startsWith("THINKING")))
        .toEqual([["tag", "⚙", "THINKING dropped=2 reasons=prefix_binding_mismatch:1,other:1"]]);
    });
  }
});
