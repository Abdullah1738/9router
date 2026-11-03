import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn().mockResolvedValue(),
  saveRequestDetail: vi.fn().mockResolvedValue(),
  saveRequestUsage: vi.fn().mockResolvedValue(),
}));

import { CodexExecutor } from "../../open-sse/executors/codex.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import { handleChatCore } from "../../open-sse/handlers/chatCore.js";
import { convertResponsesStreamToJson } from "../../open-sse/transformer/streamToJsonConverter.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import * as proxyFetch from "../../open-sse/utils/proxyFetch.js";
import { saveRequestUsage, trackPendingRequest } from "@/lib/usageDb.js";

const model = "gpt-6.1-sol";
const credentials = () => ({ connectionId: "fixture", accessToken: "fixture", refreshToken: "fixture", rawHeaders: { "user-agent": "codex-cli/0.166.0" } });
const body = () => ({ model, input: [{ type: "message", role: "user", content: "hello" }], stream: true, stream_options: { include_usage: true } });
const jsonResponse = (object, status = 200) => new Response(JSON.stringify(object), { status, headers: { "content-type": "application/json" } });
const args = (compact = false) => ({ model, body: body(), stream: !compact, credentials: credentials(), requestContext: { compact } });

function coreOptions(extraBody = {}, headers = {}) {
  const requestBody = { ...body(), _compact: true, ...extraBody };
  return {
    body: requestBody,
    modelInfo: { provider: "codex", model },
    credentials: credentials(),
    connectionId: "fixture",
    sourceFormatOverride: FORMATS.OPENAI_RESPONSES,
    clientRawRequest: { endpoint: "/v1/responses/compact", body: requestBody, headers: { "user-agent": "codex-cli/0.166.0", accept: "application/json", ...headers } },
  };
}

function sse(events) {
  const text = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  return new Response(text, { headers: { "content-type": "text/event-stream" } });
}

afterEach(() => vi.restoreAllMocks());
beforeEach(() => vi.clearAllMocks());

describe("Codex legacy compact endpoint", () => {
  it("routes sequential compact and normal requests independently and shapes the compact body", async () => {
    const fetch = vi.spyOn(proxyFetch, "proxyAwareFetch").mockImplementation(async () => jsonResponse({ output: [] }));
    const executor = new CodexExecutor();
    await executor.execute(args(true));
    await executor.execute(args(false));
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://chatgpt.com/backend-api/codex/responses/compact",
      "https://chatgpt.com/backend-api/codex/responses",
    ]);
    const compactBody = JSON.parse(fetch.mock.calls[0][1].body);
    expect(compactBody).not.toHaveProperty("stream");
    expect(compactBody).not.toHaveProperty("stream_options");
    expect(compactBody.store).toBe(false);
    expect(compactBody.model).toBe(model);
    expect(compactBody.input).toHaveLength(1);
    expect(compactBody.instructions).toBeTruthy();
    expect(JSON.parse(fetch.mock.calls[1][1].body).stream).toBe(true);
  });

  it("routes concurrent requests independently while both fetches are pending", async () => {
    const releases = [];
    const fetch = vi.spyOn(proxyFetch, "proxyAwareFetch").mockImplementation(() => new Promise(resolve => releases.push(resolve)));
    const executor = new CodexExecutor();
    const pending = [executor.execute(args(true)), executor.execute(args(false))];
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    expect(fetch.mock.calls.map(([url]) => url).sort()).toEqual([
      "https://chatgpt.com/backend-api/codex/responses",
      "https://chatgpt.com/backend-api/codex/responses/compact",
    ]);
    releases.forEach(resolve => resolve(jsonResponse({ output: [] })));
    await Promise.all(pending);
  });

  it("keeps the compact URL and body through an upstream 503 retry", async () => {
    const fetch = vi.spyOn(proxyFetch, "proxyAwareFetch")
      .mockResolvedValueOnce(jsonResponse({ error: "busy" }, 503))
      .mockResolvedValueOnce(jsonResponse({ output: [] }));
    const executor = new CodexExecutor();
    executor.config = { ...executor.config, retry: { ...executor.config.retry, 503: { attempts: 1, delayMs: 1 } } };
    await executor.execute(args(true));
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [url, options] of fetch.mock.calls) {
      expect(url).toBe("https://chatgpt.com/backend-api/codex/responses/compact");
      expect(JSON.parse(options.body)).not.toHaveProperty("stream");
    }
  });

  it("keeps the compact URL through an SSE overloaded retry", async () => {
    const fetch = vi.spyOn(proxyFetch, "proxyAwareFetch")
      .mockResolvedValueOnce(sse([["error", { message: "server_is_overloaded" }]]))
      .mockResolvedValueOnce(jsonResponse({ output: [] }));
    const executor = new CodexExecutor();
    executor.config = { ...executor.config, retry: { ...executor.config.retry, 503: { attempts: 1, delayMs: 1 } } };
    await executor.execute(args(true));
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(Array(2).fill("https://chatgpt.com/backend-api/codex/responses/compact"));
  });

  it("passes compact context through the refresh retry and returns the exact JSON", async () => {
    const compactReply = { output: [{ type: "compaction", encrypted_content: "enc" }], usage: { input_tokens: 5, input_tokens_details: { cached_tokens: 2 }, output_tokens: 3, total_tokens: 8 }, extra: { retained: true } };
    const fetch = vi.spyOn(proxyFetch, "proxyAwareFetch")
      .mockResolvedValueOnce(jsonResponse({ error: "expired" }, 401))
      .mockResolvedValueOnce(jsonResponse(compactReply, 201));
    const executor = getExecutor("codex");
    const execute = vi.spyOn(executor, "execute");
    vi.spyOn(executor, "refreshCredentials").mockResolvedValue({ accessToken: "refreshed" });
    const options = coreOptions();
    const result = await handleChatCore(options);
    expect(execute).toHaveBeenCalledTimes(2);
    for (const [call] of execute.mock.calls) {
      expect(call.requestContext).toEqual({ compact: true });
      expect(call.stream).toBe(false);
      expect(call.body).not.toHaveProperty("_compact");
    }
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(Array(2).fill("https://chatgpt.com/backend-api/codex/responses/compact"));
    expect(result.success).toBe(true);
    expect(result.response.status).toBe(201);
    expect(result.response.headers.get("content-type")).toContain("application/json");
    expect(await result.response.json()).toEqual(compactReply);
    expect(saveRequestUsage).toHaveBeenCalledWith(expect.objectContaining({ tokens: expect.objectContaining({ prompt_tokens: 5, completion_tokens: 3, cached_tokens: 2 }) }));
    expect(trackPendingRequest).toHaveBeenLastCalledWith(model, "codex", "fixture", false);
  });

  it("converts unexpected SSE to JSON even if the compact client requested a stream", async () => {
    const completed = { id: "resp_done", model, status: "completed", output: [{ type: "compaction", encrypted_content: "enc" }], usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } };
    vi.spyOn(proxyFetch, "proxyAwareFetch").mockResolvedValue(sse([["response.completed", { response: completed }]]));
    const result = await handleChatCore(coreOptions({ stream: true }, { accept: "text/event-stream" }));
    expect(result.response.headers.get("content-type")).toContain("application/json");
    expect(await result.response.json()).toEqual(completed);
  });

  it("returns the exact compact JSON bytes without treating JSON text as an SSE error", async () => {
    const raw = '{ "output" : [{"type":"compaction","encrypted_content":"server_is_overloaded"}], "usage":{"input_tokens":5,"output_tokens":3} }\n';
    const fetch = vi.spyOn(proxyFetch, "proxyAwareFetch").mockResolvedValue(new Response(raw, { status: 200, headers: { "content-type": "application/json; charset=utf-8" } }));
    const result = await handleChatCore(coreOptions({ stream: false }));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.response.status).toBe(200);
    expect(result.response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await result.response.text()).toBe(raw);
  });

  it("keeps Codex 0.166 remote compaction on regular Responses", async () => {
    const fetch = vi.spyOn(proxyFetch, "proxyAwareFetch").mockResolvedValue(sse([["response.completed", { response: { id: "resp_regular", status: "completed", output: [] } }]]));
    const options = coreOptions({ _compact: false, input: [{ type: "compaction_trigger" }], stream: true });
    options.clientRawRequest.endpoint = "/v1/responses";
    const result = await handleChatCore(options);
    expect(fetch.mock.calls[0][0]).toBe("https://chatgpt.com/backend-api/codex/responses");
    const sent = JSON.parse(fetch.mock.calls[0][1].body);
    expect(sent.stream).toBe(true);
    expect(sent.input).toContainEqual({ type: "compaction_trigger" });
    expect(result.response.headers.get("content-type")).toContain("text/event-stream");
    await result.response.text();
  });

  it("leaves other executors' URLs alone when passed the context", async () => {
    const fetch = vi.spyOn(proxyFetch, "proxyAwareFetch").mockResolvedValue(jsonResponse({}));
    const executor = new DefaultExecutor("openai-compatible-fixture");
    await executor.execute({ model, body: { model, messages: [] }, stream: false, credentials: { apiKey: "fixture", providerSpecificData: { baseUrl: "https://example.test/v1" } }, requestContext: { compact: true } });
    expect(fetch.mock.calls[0][0]).toBe("https://example.test/v1/chat/completions");
  });
});

describe("Responses stream-to-JSON completion", () => {
  it.each(["response.completed", "response.done"])("preserves the full %s response", async (event) => {
    const completed = { id: "resp_1", model, status: "completed", output: [{ type: "reasoning", encrypted_content: "x" }], usage: { input_tokens: 5, input_tokens_details: { cached_tokens: 2 }, output_tokens: 3, total_tokens: 8 } };
    const result = await convertResponsesStreamToJson(sse([[event, { response: completed }]]).body);
    expect(result).toEqual(completed);
  });

  it.each([["missing", undefined], ["empty", []]])("uses accumulated items when completed output is %s", async (_label, output) => {
    const item = { type: "reasoning", encrypted_content: "accumulated" };
    const completed = { id: "resp_1", status: "completed", ...(output ? { output } : {}), usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } };
    const result = await convertResponsesStreamToJson(sse([
      ["response.output_item.done", { output_index: 0, item }],
      ["response.completed", { response: completed }],
    ]).body);
    expect(result).toEqual({ ...completed, output: [item] });
  });

  it("retains the legacy fallback when there is no completed event", async () => {
    const item = { type: "reasoning", encrypted_content: "accumulated" };
    const result = await convertResponsesStreamToJson(sse([
      ["response.created", { response: { id: "resp_created", created_at: 123 } }],
      ["response.output_item.done", { output_index: 0, item }],
    ]).body);
    expect(result).toEqual({ id: "resp_created", object: "response", created_at: 123, status: "in_progress", output: [item], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } });
  });
});
