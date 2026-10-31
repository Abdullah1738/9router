import { describe, expect, it } from "vitest";

import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import codex from "../../open-sse/providers/registry/codex.js";

// The harnesses address models by plain id. Each advertised window must sit above
// 500k: Claude 5.5 at 1M, the GPT-6.1 extended ids at the Codex maximum (872k).
describe("harness plain ids and extended windows", () => {
  it("advertises the Codex extended Sol/Terra [1m] ids at 872000", () => {
    expect(getCapabilitiesForModel("codex", "gpt-6.1-sol[1m]").contextWindow).toBe(872000);
    expect(getCapabilitiesForModel("codex", "gpt-6.1-terra[1m]").contextWindow).toBe(872000);
  });

  it("keeps the plain Codex Terra row at 500000", () => {
    expect(getCapabilitiesForModel("codex", "gpt-6.1-terra").contextWindow).toBe(500000);
  });

  it("gives claude-haiku-5-5 a 1M adaptive window on the claude provider", () => {
    const caps = getCapabilitiesForModel("claude", "claude-haiku-5-5");
    expect(caps.contextWindow).toBe(1000000);
    expect(caps.thinkingFormat).toBe("claude-adaptive");
  });

  it("strips the provider prefix for claude-haiku-5-5", () => {
    const caps = getCapabilitiesForModel("claude", "cc/claude-haiku-5-5");
    expect(caps.contextWindow).toBe(1000000);
    expect(caps.thinkingFormat).toBe("claude-adaptive");
  });

  it("keeps the commandcode thinking format for claude-haiku-5-5", () => {
    expect(getCapabilitiesForModel("commandcode", "claude-haiku-5-5").thinkingFormat).toBe("commandcode");
  });

  it("points the new Codex [1m] registry entries at the bare upstream ids", () => {
    const byId = Object.fromEntries(codex.models.map((m) => [m.id, m]));
    expect(byId["gpt-6.1-sol[1m]"].upstreamModelId).toBe("gpt-6.1-sol");
    expect(byId["gpt-6.1-terra[1m]"].upstreamModelId).toBe("gpt-6.1-terra");
  });
});
