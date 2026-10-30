import { describe, it, expect } from "vitest";
import "../translator/registerAll.js";
import { translateResponse, initState } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const OVERFLOW = "Your input exceeds the context window of this model. Please adjust your input and try again.";

// Same call shape as tests/translator/golden-response-stream.test.js runStream:
// translateResponse(OPENAI_RESPONSES, <client>, chunk, initState(<client>)).
function run(clientFormat, events) {
  const state = initState(clientFormat);
  const out = [];
  for (const ev of events) {
    const res = translateResponse(FORMATS.OPENAI_RESPONSES, clientFormat, ev, state);
    if (res == null) continue;
    if (Array.isArray(res)) out.push(...res.filter((x) => x != null));
    else out.push(res);
  }
  return out;
}

const failed = {
  type: "response.failed",
  response: { error: { code: "context_length_exceeded", message: OVERFLOW } },
};

describe("Responses error events reach OpenAI-format clients as errors", () => {
  it("a) response.failed becomes one chunk with a top-level error", () => {
    const outs = run(FORMATS.OPENAI, [failed]);
    expect(outs).toHaveLength(1);
    const chunk = outs[0];
    expect(chunk.error).toEqual({
      message: OVERFLOW,
      type: "upstream_error",
      code: "context_length_exceeded",
    });
    expect(chunk.choices[0].delta.content).toBe("[Error] " + OVERFLOW);
    expect(chunk.choices[0].finish_reason).toBe("stop");
  });

  it("b) error followed by response.failed yields a single chunk (dedupe holds)", () => {
    const outs = run(FORMATS.OPENAI, [
      { type: "error", error: { message: OVERFLOW } },
      failed,
    ]);
    expect(outs).toHaveLength(1);
    expect(outs[0].error.code).toBeNull();
  });

  it("c) error type from the upstream is passed through", () => {
    const outs = run(FORMATS.OPENAI, [
      {
        type: "error",
        error: { type: "server_error", message: "Our servers are currently overloaded. Please try again later." },
      },
    ]);
    expect(outs).toHaveLength(1);
    expect(outs[0].error.type).toBe("server_error");
  });

  it("d) Claude clients keep the text and get no top-level error key", () => {
    const outs = run(FORMATS.CLAUDE, [failed]);
    expect(JSON.stringify(outs)).toContain("[Error] Your input exceeds the context window");
    for (const o of outs) {
      expect(Object.prototype.hasOwnProperty.call(o, "error")).toBe(false);
    }
  });

  it("e) ordinary text streams carry no error key", () => {
    const outs = run(FORMATS.OPENAI, [
      { type: "response.output_text.delta", delta: "Hello" },
      { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5 } } },
    ]);
    expect(outs.length).toBeGreaterThan(0);
    for (const o of outs) {
      expect(Object.prototype.hasOwnProperty.call(o, "error")).toBe(false);
    }
  });
});
