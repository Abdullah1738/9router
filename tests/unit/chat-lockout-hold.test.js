// When every account is locked and the first lock clears within a few minutes, a chat
// request waits for it instead of failing right away. Long lockouts, multi-model combos
// and client disconnects still fail fast.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fx = vi.hoisted(() => ({
  combos: [
    { id: "c1", name: "Solo", models: ["openai/model-a"] },
    { id: "c2", name: "Duo", models: ["openai/model-a", "openai/model-b"] },
  ],
}));
const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  handleChatCore: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ requireApiKey: false, comboStrategy: "fallback" }),
  getModelAliases: async () => ({}),
  getComboByName: async (name) => fx.combos.find((c) => c.name === name) || null,
  getProviderNodes: async () => [],
  getCombos: async () => fx.combos,
  getProviderConnections: async () => [],
  getProviderConnectionById: async () => null,
  getCustomModels: async () => [],
}));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: async () => ({}) }));
vi.mock("@/lib/db/repos/combosRepo.js", () => ({ getCombos: async () => fx.combos }));
vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({ getApiKeyByKey: async () => null }));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: vi.fn() }));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: false })),
  clearAccountError: vi.fn(),
  extractApiKey: () => null,
  isValidApiKey: async () => true,
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_p, c) => c,
  updateProviderCredentials: vi.fn(),
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.handleChatCore }));

const { handleChat } = await import("../../src/sse/handlers/chat.js");

const ok = () => ({
  success: true,
  response: new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }),
});
const locked = (inMs) => ({
  allRateLimited: true,
  retryAfter: new Date(Date.now() + inMs).toISOString(),
  retryAfterHuman: `reset after ${Math.ceil(inMs / 1000)}s`,
  lastError: "locked",
});
const creds = { connectionId: "conn-1", connectionName: "one" };

const chat = (model, signal) => handleChat(new Request("http://localhost/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
  signal,
}));

// Drive fake timers until the request settles.
async function settle(promise) {
  let done = false;
  promise.finally(() => { done = true; });
  for (let i = 0; i < 500; i++) {
    await vi.advanceTimersByTimeAsync(0);
    if (done) break;
    await vi.advanceTimersByTimeAsync(1_000);
  }
  return promise;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ now: new Date("2026-10-23T01:11:43Z") });
  vi.spyOn(Math, "random").mockReturnValue(0);
  mocks.handleChatCore.mockResolvedValue(ok());
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("chat holds short all-locked spells", () => {
  it("waits for the first lock to clear, then serves the request", async () => {
    const start = Date.now();
    mocks.getProviderCredentials.mockResolvedValueOnce(locked(104_000)).mockResolvedValueOnce(creds);

    const res = await settle(chat("openai/model-a"));

    expect(res.status).toBe(200);
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(2);
    expect(Date.now() - start).toBeGreaterThanOrEqual(104_000);
    expect(Date.now() - start).toBeLessThan(110_000);
  });

  it("tries accounts that failed before the hold again after it", async () => {
    mocks.getProviderCredentials
      .mockResolvedValueOnce(creds)
      .mockResolvedValueOnce(locked(30_000))
      .mockResolvedValueOnce(creds);
    mocks.handleChatCore
      .mockResolvedValueOnce({ success: false, status: 401, error: "expired", response: new Response("{}", { status: 401 }) })
      .mockResolvedValueOnce(ok());
    const auth = await import("@/sse/services/auth.js");
    auth.markAccountUnavailable.mockResolvedValueOnce({ shouldFallback: true });

    const res = await settle(chat("openai/model-a"));

    expect(res.status).toBe(200);
    const excludeAfterHold = mocks.getProviderCredentials.mock.calls[2][1];
    expect(excludeAfterHold.size).toBe(0);
  });

  it("fails right away when the earliest reset is past the hold cap", async () => {
    mocks.getProviderCredentials.mockResolvedValue(locked(10 * 60_000));
    const start = Date.now();

    const res = await settle(chat("openai/model-a"));

    expect(res.status).toBe(503);
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(1);
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  it("stops holding once the per-request budget is spent", async () => {
    const start = Date.now();
    mocks.getProviderCredentials.mockImplementation(async () => locked(90_000));

    const res = await settle(chat("openai/model-a"));

    expect(res.status).toBe(503);
    // One 90s hold fits in the 3 min budget, a second one does not.
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(2);
    expect(Date.now() - start).toBeLessThanOrEqual(3 * 60_000);
  });

  it("holds inside a single-model combo", async () => {
    mocks.getProviderCredentials.mockResolvedValueOnce(locked(20_000)).mockResolvedValueOnce(creds);

    const res = await settle(chat("Solo"));

    expect(res.status).toBe(200);
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(2);
  });

  it("moves to the next model of a multi-model combo instead of holding", async () => {
    mocks.getProviderCredentials.mockImplementation(async (_provider, _exclude, model) => (
      model === "model-a" ? locked(20_000) : creds
    ));
    const start = Date.now();

    const res = await settle(chat("Duo"));

    expect(res.status).toBe(200);
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(1);
    expect(mocks.handleChatCore.mock.calls[0][0].modelInfo.model).toBe("model-b");
    expect(Date.now() - start).toBeLessThan(10_000);
  });

  it("gives up the hold when the client goes away", async () => {
    mocks.getProviderCredentials.mockResolvedValue(locked(120_000));
    const controller = new AbortController();
    const start = Date.now();

    const pending = chat("openai/model-a", controller.signal);
    await vi.advanceTimersByTimeAsync(5_000);
    controller.abort();
    const res = await settle(pending);

    expect(res.status).toBe(503);
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(1);
    expect(Date.now() - start).toBeLessThan(15_000);
  });
});
