import { afterEach, describe, expect, it, vi } from "vitest";

import { CodexExecutor } from "../../open-sse/executors/codex.js";
import * as proxyFetchModule from "../../open-sse/utils/proxyFetch.js";

const model = "gpt-6.1-sol";
const credentials = (headers = {}) => ({
  connectionId: "fixture",
  accessToken: "fixture-token",
  rawHeaders: headers,
});
const cli = credentials({ "user-agent": "codex-tui/0.166.0" });

async function outbound(body, creds = cli) {
  const fetch = vi.spyOn(proxyFetchModule, "proxyAwareFetch").mockResolvedValue({
    ok: true, status: 200, headers: new Map(),
  });
  const result = await new CodexExecutor().execute({ model, body: structuredClone(body), stream: true, credentials: creds });
  const payload = JSON.parse(fetch.mock.calls.at(-1)[1].body);
  expect(result.transformedBody).toEqual(payload);
  return payload;
}

afterEach(() => vi.restoreAllMocks());

describe("Codex CLI OpenAI-provider fields", () => {
  it("sends encrypted items, compaction controls, stream options and image tools upstream", async () => {
    const input = [
      { type: "message", role: "user", content: [{ type: "encrypted_content", encrypted_content: "encrypted-message-part" }], encrypted_content: "encrypted-message" },
      { type: "function_call", call_id: "call_fixture", name: "run", arguments: "{}", encrypted_content: "encrypted-call", encrypted_function_args: "encrypted-args" },
      { type: "function_call_output", call_id: "call_fixture", output: [{ type: "encrypted_content", encrypted_content: "encrypted-result" }] },
      { type: "reasoning", summary: [], encrypted_content: "encrypted-reasoning" },
      { type: "compaction_trigger" },
      { type: "compaction", encrypted_content: "encrypted-compaction" },
      { type: "context_compaction", encrypted_content: "encrypted-context" },
      { type: "configuration_update", reasoning_effort: "high" },
    ];
    const image = { type: "image_generation", model: "gpt-image-2", quality: "low", name: "image" };
    const run = { type: "function", name: "run", parameters: { type: "object", properties: {} }, strict: false, defer_loading: true, output_schema: { type: "string" } };
    const body = await outbound({
      model, input, tools: [image, run], stream: true,
      reasoning: { effort: "high", summary: "detailed" },
      include: ["output.encrypted_content", "reasoning.encrypted_content", "output.encrypted_content"],
      stream_options: { reasoning_summary_delivery: "sequential_cutoff" },
    });

    expect(body.input).toEqual(input);
    expect(body.tools).toEqual([image, run]);
    expect(body.include).toEqual(["output.encrypted_content", "reasoning.encrypted_content"]);
    expect(body.stream_options).toEqual({ reasoning_summary_delivery: "sequential_cutoff" });
    expect(body.reasoning.effort).toBe("high");
    expect(body.reasoning.summary).toBe("detailed");
  });

  it("keeps native Lite prefix tools when moving them to regular Responses", async () => {
    const image = { type: "image_generation", model: "gpt-image-2", name: "image" };
    const fn = { type: "function", name: "run", parameters: { type: "object", properties: {} }, output_schema: { type: "string" } };
    const body = await outbound({
      model, input: [
        { type: "additional_tools", role: "developer", tools: [image, fn] },
        { type: "compaction", encrypted_content: "opaque" },
      ], tools: null, include: ["output.encrypted_content"], stream_options: { reasoning_summary_delivery: "sequential_cutoff" },
    });
    expect(body.tools).toEqual([image, fn]);
    expect(body.input).toContainEqual({ type: "compaction", encrypted_content: "opaque" });
    expect(body.include).toEqual(["output.encrypted_content", "reasoning.encrypted_content"]);
  });

  it("recognizes the actual Robob Codex app-server originator and user agent", async () => {
    const body = await outbound({
      model, input: "hello", include: ["output.encrypted_content"],
      stream_options: { reasoning_summary_delivery: "sequential_cutoff" },
    }, credentials({
      "user-agent": "T3 Code/0.166.0 (Mac OS 27.0.1; arm64) unknown (T3 Code; 1.0)",
      originator: "T3 Code",
    }));
    expect(body.include).toEqual(["output.encrypted_content", "reasoning.encrypted_content"]);
    expect(body.stream_options).toEqual({ reasoning_summary_delivery: "sequential_cutoff" });
  });

  it("retains prefix and top-level tools on the actual Lite transport, including a forced prefix function", async () => {
    const liteModel = "gpt-6.1-terra";
    const prefix = { type: "additional_tools", role: "developer", tools: [{ type: "function", name: "run", parameters: { type: "object", properties: {} } }] };
    const image = { type: "image_generation", model: "gpt-image-2" };
    const body = new CodexExecutor().transformRequest(liteModel, {
      model: liteModel, input: [prefix, { type: "message", role: "user", content: "hello" }],
      tools: [image], tool_choice: { type: "function", name: "run" },
    }, true, cli);
    expect(body.input[0]).toEqual(prefix);
    expect(body.input[1]).toEqual({ type: "additional_tools", role: "developer", tools: [image] });
    expect(body.tools).toBeNull();
    expect(body.tool_choice).toEqual({ type: "function", name: "run" });
  });

  it.each([
    ["reasoning", 'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","delta":"thinking"}\n\n'],
    ["image", 'event: response.image_generation_call.partial_image\ndata: {"type":"response.image_generation_call.partial_image"}\n\n'],
  ])("does not buffer streamed %s output until upstream EOF", async (_kind, event) => {
    const encoder = new TextEncoder();
    let controller;
    const stream = new ReadableStream({ start(c) { controller = c; c.enqueue(encoder.encode(event)); } });
    const peek = await new CodexExecutor()._peekSseTransientError(new Response(stream, { headers: { "Content-Type": "text/event-stream" } }));
    expect(peek.matched).toBeNull();
    const reader = peek.replacementBody.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe(event);
    controller.close();
    expect((await reader.read()).done).toBe(true);
  });

  it("does not duplicate the required include across retries", () => {
    const executor = new CodexExecutor();
    const body = { model, input: "hi", include: ["output.encrypted_content", "output.encrypted_content"] };
    executor.transformRequest(model, body, true, cli);
    executor.transformRequest(model, body, true, cli);
    expect(body.include).toEqual(["output.encrypted_content", "reasoning.encrypted_content"]);
  });

  it("keeps a native include with no reasoning effort without inventing reasoning encryption", () => {
    const unforced = { model: "gpt-5.5", input: "hi", reasoning: { effort: "none" }, include: ["output.encrypted_content", "output.encrypted_content"] };
    new CodexExecutor().transformRequest(unforced.model, unforced, true, cli);
    expect(unforced.include).toEqual(["output.encrypted_content"]);
  });

  it.each([
    ["Cursor", { "user-agent": "cursor/1.0" }],
    ["anonymous Responses client", {}],
    ["T3-branded client without Codex originator", { "user-agent": "T3 Code/0.166.0" }],
    ["T3-originated non-Codex client", { "user-agent": "example/1.0", originator: "T3 Code" }],
    ["Copilot taking precedence", { "user-agent": "codex-cli/0.166.0 githubcopilotchat" }],
  ])("leaves %s normalization unchanged", async (_name, headers) => {
    const body = await outbound({
      model, input: "hi", reasoning: { effort: "high" },
      include: ["output.encrypted_content"], stream_options: { include_usage: true },
      tools: [{ type: "image_generation", name: "image" }, { type: "function", name: "run", parameters: { type: "object", properties: {} }, defer_loading: true }],
    }, credentials(headers));
    expect(body.stream_options).toBeUndefined();
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
    expect(body.tools).toEqual([{ type: "function", name: "run", parameters: { type: "object", properties: {} } }]);
  });
});
