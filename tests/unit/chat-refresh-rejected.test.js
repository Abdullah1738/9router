// A login whose refresh token gets rejected mid-request is marked for re-login by
// chat.js and skipped right away, without the usual 401 cooldown.
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  markRefreshTokenRejected: vi.fn(),
  handleChatCore: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ requireApiKey: false }),
  getModelAliases: async () => ({}),
  getComboByName: async () => null,
  getProviderNodes: async () => [],
  getCombos: async () => [],
  getProviderConnections: async () => [],
  getProviderConnectionById: async () => null,
  getCustomModels: async () => [],
}));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: async () => ({}) }));
vi.mock("@/lib/db/repos/combosRepo.js", () => ({ getCombos: async () => [] }));
vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({ getApiKeyByKey: async () => null }));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: vi.fn() }));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: vi.fn(),
  extractApiKey: () => null,
  isValidApiKey: async () => true,
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_p, c) => c,
  updateProviderCredentials: vi.fn(),
  markRefreshTokenRejected: mocks.markRefreshTokenRejected,
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.handleChatCore }));

const { handleChat } = await import("../../src/sse/handlers/chat.js");

const dead = { connectionId: "conn-dead", connectionName: "dead", refreshToken: "rt-dead" };
const live = { connectionId: "conn-live", connectionName: "live", refreshToken: "rt-live" };
const failure = { error: "unrecoverable_refresh_error", code: "invalid_grant" };

const chat = () => handleChat(new Request("http://localhost/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ model: "openai/model-a", messages: [{ role: "user", content: "hi" }] }),
}));

describe("chat with a login whose grant is gone", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true });
    mocks.markRefreshTokenRejected.mockResolvedValue(true);
  });

  it("marks it and moves to the next account without a cooldown", async () => {
    mocks.getProviderCredentials.mockResolvedValueOnce(dead).mockResolvedValueOnce(live);
    mocks.handleChatCore
      .mockImplementationOnce(async ({ onRefreshTokenRejected }) => {
        await onRefreshTokenRejected(failure, "rt-dead");
        return { success: false, status: 401, error: "expired", response: new Response("{}", { status: 401 }) };
      })
      .mockResolvedValueOnce({ success: true, response: new Response("{}", { status: 200 }) });

    const res = await chat();

    expect(res.status).toBe(200);
    expect(mocks.markRefreshTokenRejected).toHaveBeenCalledWith("openai", dead, failure, "rt-dead");
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
    expect([...mocks.getProviderCredentials.mock.calls[1][1]]).toEqual(["conn-dead"]);
  });

  it("still cools down a plain 401", async () => {
    mocks.getProviderCredentials.mockResolvedValueOnce(dead).mockResolvedValueOnce(live);
    mocks.handleChatCore
      .mockResolvedValueOnce({ success: false, status: 401, error: "expired", response: new Response("{}", { status: 401 }) })
      .mockResolvedValueOnce({ success: true, response: new Response("{}", { status: 200 }) });

    const res = await chat();

    expect(res.status).toBe(200);
    expect(mocks.markRefreshTokenRejected).not.toHaveBeenCalled();
    expect(mocks.markAccountUnavailable).toHaveBeenCalledTimes(1);
  });
});
