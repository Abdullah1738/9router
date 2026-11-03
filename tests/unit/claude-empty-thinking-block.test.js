import "../translator/registerAll.js";
import { describe, it, expect } from "vitest";
import { DEFAULT_THINKING_CLAUDE_SIGNATURE } from "../../open-sse/config/defaultThinkingSignature.js";
import { normalizeClaudePassthrough, prepareClaudeRequest } from "../../open-sse/translator/formats/claude.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import signatures from "../fixtures/claude-thinking-signatures.json";

const block = (text, signature = signatures[0]) => ({ type: "thinking", thinking: text, signature });
const request = (thinkingBlock, withTool = false) => ({
  model: "claude-opus-5-5", max_tokens: 4096,
  thinking: { type: "enabled", budget_tokens: 1024 },
  messages: [
    { role: "user", content: "hi" },
    { role: "assistant", content: [thinkingBlock, ...(withTool ? [{ type: "tool_use", id: "toolu_1", name: "f", input: {} }] : [])] },
    { role: "user", content: withTool ? [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] : "next" },
  ],
});
const thinkingBlocks = body => body.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(b => b.type === "thinking");

describe("Claude omitted thinking", () => {
  const paths = [
    ["native passthrough", body => normalizeClaudePassthrough(body, body.model, "claude")],
    ["Claude translator", body => translateRequest(FORMATS.CLAUDE, FORMATS.CLAUDE, body.model, body, true, null, "claude")],
    ["OpenAI translator", body => translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, body.model, body, true, null, "claude")],
  ];
  for (const [name, run] of paths) {
    it.each(["", "  \n\t "])(`${name} keeps fixture-signed %j thinking unchanged, without a placeholder`, (text) => {
      const input = block(text);
      const expected = structuredClone(input);
      const output = run(request(input, true));
      expect(thinkingBlocks(output)).toEqual([expected]);
    });

    it(`${name} retains a signed thinking-only assistant turn`, () => {
      const input = block("");
      const output = run(request(input));
      expect(output.messages[1].role).toBe("assistant");
      expect(thinkingBlocks(output)).toEqual([input]);
    });

    it.each([
      ["unsigned", { type: "thinking", thinking: "" }],
      ["placeholder", block("", DEFAULT_THINKING_CLAUDE_SIGNATURE)],
      ["wrapped placeholder", block("", Buffer.from(DEFAULT_THINKING_CLAUDE_SIGNATURE).toString("base64"))],
      ["wrapped unpadded placeholder", block("", Buffer.from(DEFAULT_THINKING_CLAUDE_SIGNATURE.replace(/=+$/, "")).toString("base64"))],
      ["foreign", block("", "foreign-signature")],
      ["truncated legacy", block("", "Eg==")],
      ["truncated wrapped legacy", block("", Buffer.from("Eg==").toString("base64"))],
      ["incomplete legacy payload", block("", Buffer.from([0x12, 0x03, 0x41]).toString("base64"))],
    ])(`${name} drops an %s empty block`, (_kind, input) => {
      const body = request(input);
      body.messages[1].content.push({ type: "text", text: "kept" });
      expect(thinkingBlocks(run(body))).toEqual([]);
    });
  }

  it.each(["deepseek", "opencode-go", "anthropic-compatible-custom"])("still drops signed empty blocks on %s", provider => {
    const body = request(block(""));
    if (provider === "opencode-go" || provider === "deepseek") body.model = "deepseek-v4.1-flash";
    body.messages[1].content.push({ type: "text", text: "kept" });
    expect(thinkingBlocks(prepareClaudeRequest(body, provider))).toEqual([]);
  });

  it("does not retain omitted thinking in native compatible-provider passthrough", () => {
    const body = request(block(""));
    body.messages[1].content.push({ type: "text", text: "kept" });
    expect(thinkingBlocks(normalizeClaudePassthrough(body, body.model, "anthropic-compatible-custom"))).toEqual([]);
  });

  it.each(paths)("%s drops signed and invalid empty thinking on a user turn", (_name, run) => {
    const body = request(block(""));
    body.messages[0].content = [block(""), block("", "bad"), { type: "text", text: "hello" }];
    body.messages[1].content.push({ type: "text", text: "answer" });
    const out = run(body);
    expect(out.messages[0].content).toEqual([{ type: "text", text: "hello" }]);
  });
});
