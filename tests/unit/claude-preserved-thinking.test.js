import "../translator/registerAll.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import signatures from "../fixtures/claude-thinking-signatures.json";
import { DEFAULT_THINKING_CLAUDE_SIGNATURE } from "../../open-sse/config/defaultThinkingSignature.js";
import { isValidClaudeSignature } from "../../open-sse/utils/claudeSignature.js";
import { anchorClaudeCache, normalizeClaudePassthrough, prepareClaudeRequest } from "../../open-sse/translator/formats/claude.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { CodexExecutor } from "../../open-sse/executors/codex.js";
import { observeClaudeTransformations } from "../../open-sse/utils/claudeThinkingLog.js";
import { createSSEStream } from "../../open-sse/utils/stream.js";

describe("Claude signature validation", () => {
  it("accepts two captured current signatures and the older E/R encodings", () => {
    for (const signature of signatures) expect(isValidClaudeSignature(signature)).toBe(true);
    const old = Buffer.from([0x12, 0x01, 0x41]).toString("base64");
    expect(isValidClaudeSignature(old)).toBe(true);
    expect(isValidClaudeSignature(Buffer.from(old).toString("base64"))).toBe(true);
    expect(isValidClaudeSignature(`cache#${signatures[0]}`)).toBe(true);
  });

  it("rejects invalid base64, empty, placeholder and malformed protobuf", () => {
    const b64 = (bytes) => Buffer.from(bytes).toString("base64");
    for (const bad of ["", null, "not base64", `${signatures[0]}!`, DEFAULT_THINKING_CLAUDE_SIGNATURE,
      `cache#${DEFAULT_THINKING_CLAUDE_SIGNATURE}`, "C".repeat(32 * 1024 * 1024 + 1),
      b64([0x08, 0x80]), b64([0x08, 0x04, 0x12, 0x80]),
      b64([0x08, 0x04, 0x12, 0x04, 0x01]), b64([0x08, 0x04, 0x12, 0x00])]) {
      expect(isValidClaudeSignature(bad)).toBe(false);
    }
    expect(isValidClaudeSignature(b64([0x08, 0x80, 0x01, 0x12, 0x01, 0x41]))).toBe(true);
  });
});

describe("Codex encrypted reasoning", () => {
  it("survives the actual executor transformation unchanged", () => {
    const reasoning = { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "summary" }], encrypted_content: "opaque-encrypted-content" };
    const expected = JSON.stringify(reasoning);
    const body = { model: "gpt-6.1-terra", input: [{ role: "user", content: "hello" }, reasoning] };
    const sent = new CodexExecutor().transformRequest(body.model, body, true, { accessToken: "test" });
    expect(JSON.stringify(sent.input.find((item) => item.type === "reasoning"))).toBe(expected);
  });
});

describe("persistent Claude account affinity", () => {
  let db, tracker, sticky, config;
  const available = [{ id: "account-a" }, { id: "account-b" }];
  const sessionKey = "session-with-private-id";
  const now = 1_800_000_000_000;
  const rows = new Map();

  beforeEach(async () => {
    vi.resetModules();
    rows.clear();
    db = {
      exec: vi.fn(),
      get: vi.fn((sql, args) => sql.includes("COUNT(*)") ? { count: rows.size } : rows.has(args[1]) ? { value: rows.get(args[1]) } : undefined),
      all: vi.fn(() => [...rows].map(([key, value]) => ({ key, value }))),
      run: vi.fn((sql, args) => {
        if (sql.startsWith("INSERT")) rows.set(args[1], args[2]);
      }),
    };
    vi.doMock("@/lib/db/driver.js", () => ({ getAdapter: async () => db }));
    tracker = await import("../../open-sse/services/claudeQuotaTracker.js");
    sticky = await import("../../src/sse/services/claudeSticky.js");
    config = (await import("../../open-sse/config/claudeQuotaRouting.js")).CLAUDE_QUOTA_ROUTING;
    tracker.__resetTracker();
  });
  afterEach(() => { vi.doUnmock("@/lib/db/driver.js"); tracker.__resetTracker(); });

  const pick = (now, items = available, classifyUnavailable = () => "disabled") =>
    sticky.selectPersistentClaudeAccount({ available: items, sessionKey, now, classifyUnavailable });

  it("survives restart and two idle hours; moves only for a quota lock", async () => {
    expect(config.stickyIdleTtlMs).toBe(30 * 24 * 3600_000);
    expect(config.stickyMaxEntries).toBe(50000);
    const first = await pick(now);
    const chosen = first.connection.id;
    expect(rows.size).toBe(1);
    expect([...rows.keys()][0]).toMatch(/^claudeSticky:[a-f0-9]{64}$/);
    expect([...rows.keys()][0]).not.toContain(sessionKey);
    expect(Object.keys(JSON.parse([...rows.values()][0])).sort()).toEqual(["connectionId", "lastUsedAt"]);
    tracker.__resetTracker();
    await sticky.loadClaudeStickySessions(now + 2 * 3600_000);
    expect((await pick(now + 2 * 3600_000)).connection.id).toBe(chosen);
    tracker.ingestClaudeUsage(chosen, { quotas: {
      "session (5h)": { used: 100, resetAt: new Date(now + 5 * 3600_000).toISOString() },
      "weekly (7d)": { used: 1, resetAt: new Date(now + 7 * 24 * 3600_000).toISOString() },
    } });
    const moved = await pick(now + 2 * 3600_000);
    expect(moved.connection.id).not.toBe(chosen);
    expect(moved.reason).toMatch(/^moved:quota-locked,/);
  });

  it("ignores the new-session threshold on an existing binding", async () => {
    const previous = config.newSession5hMax;
    try {
      config.newSession5hMax = 0.5;
      const chosen = (await pick(now)).connection.id;
      tracker.ingestClaudeUsage(chosen, { quotas: {
        "session (5h)": { used: 75, resetAt: new Date(now + 6 * 3600_000).toISOString() },
      } });
      const result = await pick(now + 2 * 3600_000);
      expect(result.connection.id).toBe(chosen);
      expect(result.reason).toBe("sticky");
    } finally { config.newSession5hMax = previous; }
  });

  it("does not move on an attempt-only exclusion but moves when disabled", async () => {
    const original = (await pick(now)).connection.id;
    const remaining = available.filter((c) => c.id !== original);
    const excluded = await pick(now + 1, remaining, () => "excluded");
    expect(excluded).toEqual({ connection: null, reason: "sticky-unavailable" });
    expect(JSON.parse([...rows.values()][0]).connectionId).toBe(original);
    const disabled = await pick(now + 2, remaining, () => "disabled");
    expect(disabled.connection.id).not.toBe(original);
    expect(disabled.reason).toMatch(/^moved:disabled,/);
  });
});

describe("thinking drop diagnostics", () => {
  const transformations = [
    { type: "thinking_dropped", path: "private content", reason: "prefix_binding_mismatch" },
    { type: "thinking_dropped", path: "private content", reason: "organization_binding_mismatch" },
  ];
  it("logs only tagged counts and known reasons; ignores empty and unsafe data", () => {
    const log = { line: vi.fn() };
    observeClaudeTransformations({ input_transformations: transformations }, log, "tag");
    expect(log.line).toHaveBeenCalledWith("tag", "⚙", "THINKING dropped=2 reasons=prefix_binding_mismatch:1,organization_binding_mismatch:1");
    observeClaudeTransformations({ input_transformations: [] }, log, "tag");
    expect(log.line).toHaveBeenCalledTimes(1);
    observeClaudeTransformations({ input_transformations: [{ type: "thinking_dropped", reason: "SECRET\nINJECTION" }] }, log, "tag");
    expect(log.line.mock.calls.at(-1)[2]).toBe("THINKING dropped=1 reasons=other:1");
    expect(() => observeClaudeTransformations({ input_transformations: transformations }, { line: () => { throw Error("oops"); } }, "tag")).not.toThrow();
  });

  it.each(["passthrough", "translate"])("observes %s message_start and a split unterminated message_delta", async (mode) => {
    const log = { line: vi.fn() };
    const start = { type: "message_start", message: { id: "msg_1", model: "claude", role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 0 }, input_transformations: transformations } };
    const delta = { type: "message_delta", delta: { stop_reason: "end_turn" }, input_transformations: transformations };
    const raw = `data: ${JSON.stringify(start)}\n\ndata: ${JSON.stringify(delta)}`;
    const bytes = new TextEncoder().encode(raw);
    const input = new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, 32)); controller.enqueue(bytes.slice(32)); controller.close(); } });
    const stream = createSSEStream({
      mode, provider: "claude", targetFormat: FORMATS.CLAUDE, sourceFormat: FORMATS.OPENAI,
      observeThinking: (event) => observeClaudeTransformations(event, log, "request-tag"),
    });
    await new Response(input.pipeThrough(stream)).text();
    expect(log.line).toHaveBeenCalledTimes(2);
    expect(log.line.mock.calls.every((call) => call[0] === "request-tag" && call[2].startsWith("THINKING dropped=2"))).toBe(true);
  });
});

const history = () => ({
  model: "claude-opus-5-5", max_tokens: 4000,
  thinking: { type: "enabled", budget_tokens: 1024 },
  messages: [
    { role: "user", content: "one" },
    { role: "assistant", content: [
      { signature: signatures[0], type: "thinking", thinking: "first" },
      { type: "redacted_thinking", data: "opaque redacted data" },
      { type: "tool_use", id: "toolu_1", name: "lookup", input: {} },
    ] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
    { role: "assistant", content: [
      { type: "thinking", thinking: "second", signature: signatures[1] },
      { type: "text", text: "answer" },
    ] },
    { role: "user", content: "next" },
  ],
});
const thinkingBlocks = (body) => body.messages.flatMap((m) => Array.isArray(m.content) ? m.content : [])
  .filter((b) => b.type === "thinking" || b.type === "redacted_thinking");

describe("Claude history preservation", () => {
  for (const [name, run] of [
    ["native passthrough", (body) => normalizeClaudePassthrough(body, body.model)],
    ["translated", (body) => prepareClaudeRequest(body, "claude")],
    ["same-format translator", (body) => translateRequest(FORMATS.CLAUDE, FORMATS.CLAUDE, body.model, body, true, null, "claude")],
  ]) {
    it(`${name} retains thinking and redacted data byte-for-byte without a placeholder`, () => {
      const body = history();
      const before = JSON.stringify(thinkingBlocks(body));
      const output = run(body);
      expect(JSON.stringify(thinkingBlocks(output))).toBe(before);
      expect(thinkingBlocks(output)).toHaveLength(3);
      expect(output.messages[1].content[0].signature).toBe(signatures[0]);
    });

    it(`${name} drops a foreign signature and still replaces a lost tool-turn block`, () => {
      const body = history();
      body.messages[1].content = [
        { type: "thinking", thinking: "foreign", signature: "not-a-claude-signature" },
        { type: "tool_use", id: "toolu_1", name: "lookup", input: {} },
      ];
      const result = run(body);
      if (result.thinking?.type === "enabled") {
        expect(result.messages[1].content[0]).toEqual({ type: "thinking", thinking: ".", signature: DEFAULT_THINKING_CLAUDE_SIGNATURE });
      }
      expect(thinkingBlocks(result).some((b) => b.signature === "not-a-claude-signature")).toBe(false);
    });
  }

  it("keeps a thinking-only assistant message on the translated path", () => {
    const body = history();
    body.messages[1].content = [{ type: "thinking", thinking: "real", signature: signatures[0] }];
    body.messages[2].content = "next";
    const out = prepareClaudeRequest(body, "claude");
    expect(thinkingBlocks(out)[0]).toEqual({ type: "thinking", thinking: "real", signature: signatures[0] });
  });

  it("keeps OpenAI-content-array thinking and redacted blocks through the registered translator", () => {
    const blocks = [{ type: "thinking", thinking: "real", signature: signatures[0] }, { type: "redacted_thinking", data: "opaque" }];
    const body = { model: "claude-opus-5-5", messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: [...blocks, { type: "text", text: "answer" }] },
      { role: "user", content: "next" },
    ] };
    const expected = JSON.stringify(blocks);
    const out = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, body.model, body, true, null, "claude");
    expect(JSON.stringify(thinkingBlocks(out))).toBe(expected);
  });

  it("does not add a placeholder to an earlier unsigned tool turn when a later real block exists", () => {
    for (const run of [normalizeClaudePassthrough, (body) => prepareClaudeRequest(body, "claude")]) {
      const body = history();
      body.messages[1].content = [{ type: "tool_use", id: "toolu_1", name: "lookup", input: {} }];
      const out = run(body);
      expect(out.messages[1].content.some((block) => block.type === "thinking")).toBe(false);
      expect(thinkingBlocks(out)).toHaveLength(1);
    }
  });

  it("does not anchor or mutate thinking blocks, even at the cache-marker limit", () => {
    for (const withBudget of [false, true]) {
      const body = history();
      body.messages[3].content = [{ signature: signatures[1], thinking: "second", type: "thinking" }];
      if (withBudget) {
        body.system = [{ type: "text", text: "system" }];
        body.tools = [{ name: "lookup", input_schema: { type: "object" } }];
        body.messages[2].content[0].cache_control = { type: "ephemeral" };
        body.messages[0].content = [{ type: "text", text: "one", cache_control: { type: "ephemeral" } }];
      }
      const before = JSON.stringify(thinkingBlocks(body));
      anchorClaudeCache(body);
      expect(JSON.stringify(thinkingBlocks(body))).toBe(before);
    }
  });
});
