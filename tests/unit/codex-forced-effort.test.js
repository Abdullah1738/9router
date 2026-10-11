import { describe, expect, it } from "vitest";

import { CodexExecutor, FORCED_REASONING_EFFORT } from "../../open-sse/executors/codex.js";

const credentials = { connectionId: "fixture", accessToken: "fixture-token" };

function transform(model, extra = {}) {
  return new CodexExecutor().transformRequest(model, {
    model,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
    ...extra,
  }, true, credentials);
}

describe("Codex forced reasoning effort", () => {
  it("pins gpt-6-astra to xhigh", () => {
    expect(FORCED_REASONING_EFFORT["gpt-6-astra"]).toBe("xhigh");
  });

  it.each(["max", "ultra", "high", "medium", "low", "minimal", "none"])(
    "rewrites reasoning.effort=%s to xhigh for gpt-6-astra", (effort) => {
      const body = transform("gpt-6-astra", { reasoning: { effort, summary: "detailed" } });
      expect(body.model).toBe("gpt-6-astra");
      expect(body.reasoning.effort).toBe("xhigh");
      expect(body.reasoning.summary).toBe("detailed");
    });

  it("rewrites the flat reasoning_effort param", () => {
    const body = transform("gpt-6-astra", { reasoning_effort: "max" });
    expect(body.reasoning.effort).toBe("xhigh");
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("uses xhigh when the client sends no effort", () => {
    const body = transform("gpt-6-astra");
    expect(body.reasoning.effort).toBe("xhigh");
  });

  it("applies to the extended-context alias", () => {
    const body = transform("gpt-6-astra[1m]", { reasoning: { effort: "max" } });
    expect(body.model).toBe("gpt-6-astra");
    expect(body.reasoning.effort).toBe("xhigh");
  });

  it("leaves other models alone", () => {
    const body = transform("gpt-6-sol", { reasoning: { effort: "max" } });
    expect(body.reasoning.effort).toBe("max");
  });
});
