import { describe, expect, it, vi } from "vitest";

import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import codex from "../../open-sse/providers/registry/codex.js";

const db = vi.hoisted(() => ({
  getProviderConnections: vi.fn(async () => [{
    id: 1,
    provider: "codex",
    isActive: true,
    providerSpecificData: { enabledModels: ["gpt-6.1-terra", "gpt-6.1-terra[1m]", "gpt-6.1-sol[1m]"] },
  }]),
  getCombos: vi.fn(async () => [{ name: "terra-combo", models: ["cx/gpt-6.1-terra"] }]),
  getCustomModels: vi.fn(async () => []),
  getModelAliases: vi.fn(async () => ({})),
}));

vi.mock("@/lib/localDb", () => db);
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: vi.fn(async () => ({})) }));

const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");

// The harnesses address models by plain id. Each advertised window must sit above
// 500k: Claude 5.5 at 1M, Sol [1m] at 872k, and Terra at its measured 1.05M.
describe("harness plain ids and extended windows", () => {
  it("advertises Codex Sol [1m] at 872000 and Terra [1m] at 1050000", () => {
    expect(getCapabilitiesForModel("codex", "gpt-6.1-sol[1m]").contextWindow).toBe(872000);
    expect(getCapabilitiesForModel("codex", "gpt-6.1-terra[1m]")).toMatchObject({
      vision: true,
      reasoning: true,
      search: true,
      thinkingFormat: "openai",
      contextWindow: 1050000,
      maxOutput: 128000,
    });
  });

  it("advertises the plain Codex Terra row at 1050000", () => {
    expect(getCapabilitiesForModel("codex", "gpt-6.1-terra").contextWindow).toBe(1050000);
  });

  it("publishes the Terra windows and output limits in /v1/models", async () => {
    const models = await buildModelsList(["llm"], { skipDynamicFetch: true });
    for (const id of ["cx/gpt-6.1-terra", "cx/gpt-6.1-terra[1m]", "terra-combo"]) {
      expect(models.find((model) => model.id === id), id).toMatchObject({
        context_length: 1050000,
        max_completion_tokens: 128000,
      });
    }
    expect(models.find((model) => model.id === "cx/gpt-6.1-sol[1m]")).toMatchObject({
      context_length: 872000,
      max_completion_tokens: 128000,
    });
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
