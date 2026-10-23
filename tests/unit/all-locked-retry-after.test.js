// With every account locked, retryAfter is when the first account can serve this model
// again. Chat holds requests on it, so a lock on some other model must not count, and an
// account only comes back once every lock on it has cleared.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({ rows: [], agQuotas: new Map() }));

vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/network/connectionProxy", () => ({
  pickProxyPoolId: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(async () => ({})),
}));
vi.mock("@/lib/localDb", () => ({
  getProviderConnections: vi.fn(async () => mocks.rows),
  updateProviderConnection: vi.fn(),
  getSettings: vi.fn(async () => ({})),
}));

vi.mock("../../src/sse/services/antigravityQuota.js", () => ({
  getAntigravityQuotaCache: () => mocks.agQuotas,
  getAntigravityModelQuota: (quotas, model) => quotas?.[model] || null,
}));

const { getProviderCredentials } = await import("../../src/sse/services/auth.js");

const NOW = new Date("2026-10-23T01:11:43.000Z").getTime();
const at = (ms) => new Date(NOW + ms).toISOString();

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("all-locked retryAfter", () => {
  it("uses the lock on the requested model, not an earlier lock on another model", async () => {
    mocks.rows = [
      { id: "a", provider: "glm", authType: "apikey", apiKey: "k1", isActive: true, priority: 1,
        "modelLock_glm-5": at(25 * 60_000), "modelLock_glm-4": at(10_000) },
      { id: "b", provider: "glm", authType: "apikey", apiKey: "k2", isActive: true, priority: 2,
        "modelLock_glm-5": at(90_000) },
    ];

    const out = await getProviderCredentials("glm", null, "glm-5");

    expect(out).toMatchObject({ allRateLimited: true, retryAfter: at(90_000) });
  });

  it("counts an account-wide lock", async () => {
    mocks.rows = [
      { id: "a", provider: "glm", authType: "apikey", apiKey: "k1", isActive: true, priority: 1,
        modelLock___all: at(45_000) },
    ];

    const out = await getProviderCredentials("glm", null, "glm-5");

    expect(out).toMatchObject({ allRateLimited: true, retryAfter: at(45_000) });
  });

  it("ignores accounts that never serve the requested model", async () => {
    mocks.rows = [
      { id: "a", provider: "codex", authType: "oauth", accessToken: "t1", isActive: true, priority: 1,
        providerSpecificData: { enabledModels: ["gpt-5"] }, modelLock___all: at(10_000) },
      { id: "b", provider: "codex", authType: "oauth", accessToken: "t2", isActive: true, priority: 2,
        "modelLock_gpt-6": at(90_000) },
    ];

    const out = await getProviderCredentials("codex", null, "gpt-6");

    expect(out).toMatchObject({ allRateLimited: true, retryAfter: at(90_000) });
  });

  it("waits for every lock on an account, and only exhausted quota counts", async () => {
    mocks.agQuotas = new Map([
      // a: model lock clears in 30s but its quota is out for 5 minutes
      ["a", { "gemini-3.8-pro": { remainingPercentage: 0, resetAt: at(5 * 60_000) } }],
      // b: quota left, so its reset time says nothing about when b comes back
      ["b", { "gemini-3.8-pro": { remainingPercentage: 40, resetAt: at(10_000) } }],
    ]);
    mocks.rows = [
      { id: "a", provider: "antigravity", authType: "oauth", accessToken: "t1", isActive: true, priority: 1,
        "modelLock_gemini-3.8-pro": at(30_000) },
      { id: "b", provider: "antigravity", authType: "oauth", accessToken: "t2", isActive: true, priority: 2,
        "modelLock_gemini-3.8-pro": at(2 * 60_000) },
    ];

    const out = await getProviderCredentials("antigravity", null, "gemini-3.8-pro");

    expect(out).toMatchObject({ allRateLimited: true, retryAfter: at(2 * 60_000) });
  });
});
