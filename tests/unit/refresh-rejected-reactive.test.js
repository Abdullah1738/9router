// An upstream 401 makes chatCore refresh on the spot. When the token endpoint says the
// grant is gone, the caller hears about it (with the refresh token that was used) so the
// login leaves rotation instead of cooling down and coming back.
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  refreshCredentials: vi.fn(),
  proxyAwareFetch: vi.fn(),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({
    noAuth: false,
    execute: mocks.execute,
    refreshCredentials: mocks.refreshCredentials,
  }),
}));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));
vi.mock("../../open-sse/utils/stream.js", () => ({
  COLORS: { red: "", reset: "" },
  createPassthroughStreamWithLogger: vi.fn(() => new TransformStream()),
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.proxyAwareFetch }));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { DefaultExecutor } = await import("../../open-sse/executors/default.js");

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const expired401 = () => ({
  response: new Response(JSON.stringify({ error: { message: "OAuth access token has expired" } }), {
    status: 401,
    headers: { "content-type": "application/json" },
  }),
  url: "https://api.openai.com/v1/chat/completions",
  headers: {},
  transformedBody: null,
});

function runChat(callbacks) {
  return handleChatCore({
    body: { model: "gpt-4o", stream: false, messages: [{ role: "user", content: "hi" }] },
    modelInfo: { provider: "openai", model: "gpt-4o" },
    credentials: { accessToken: "at-old", refreshToken: "rt-dead", providerSpecificData: {} },
    log,
    connectionId: "conn-dead",
    ...callbacks,
  });
}

describe("reactive refresh after an upstream 401", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.execute.mockResolvedValue(expired401());
  });

  it("reports a rejected grant with the refresh token it tried", async () => {
    mocks.refreshCredentials.mockResolvedValue({ error: "unrecoverable_refresh_error", code: "invalid_grant" });
    const onRefreshTokenRejected = vi.fn();
    const onCredentialsRefreshed = vi.fn();

    const result = await runChat({ onRefreshTokenRejected, onCredentialsRefreshed });

    expect(result.success).toBe(false);
    expect(result.status).toBe(401);
    expect(mocks.refreshCredentials).toHaveBeenCalledTimes(1);
    expect(onRefreshTokenRejected).toHaveBeenCalledWith(
      { error: "unrecoverable_refresh_error", code: "invalid_grant" },
      "rt-dead",
    );
    expect(onCredentialsRefreshed).not.toHaveBeenCalled();
  });

  it("leaves the login alone when the refresh fails for another reason", async () => {
    mocks.refreshCredentials.mockResolvedValue(null);
    const onRefreshTokenRejected = vi.fn();

    const result = await runChat({ onRefreshTokenRejected });

    expect(result.status).toBe(401);
    expect(onRefreshTokenRejected).not.toHaveBeenCalled();
  });

  it("passes the refresh token it used along with refreshed credentials", async () => {
    mocks.refreshCredentials.mockResolvedValue({ accessToken: "at-new", refreshToken: "rt-new", expiresIn: 3600 });
    mocks.execute.mockResolvedValueOnce(expired401()).mockResolvedValueOnce(expired401());
    const onCredentialsRefreshed = vi.fn();

    await runChat({ onCredentialsRefreshed });

    expect(onCredentialsRefreshed).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "at-new", refreshToken: "rt-new" }),
      "rt-dead",
    );
  });

  it("retries with the stored tokens when its refresh lost a race", async () => {
    mocks.refreshCredentials.mockResolvedValue({ accessToken: "at-lost", refreshToken: "rt-lost", expiresIn: 3600 });
    mocks.execute.mockResolvedValueOnce(expired401()).mockResolvedValueOnce(expired401());
    const onCredentialsRefreshed = vi.fn(async () => ({ accessToken: "at-stored", refreshToken: "rt-stored" }));

    await runChat({ onCredentialsRefreshed });

    expect(mocks.execute).toHaveBeenCalledTimes(2);
    expect(mocks.execute.mock.calls[1][0].credentials).toMatchObject({
      accessToken: "at-stored",
      refreshToken: "rt-stored",
    });
  });
});

describe("storedTokensIfStale", () => {
  it("hands back the row's tokens only when the write was dropped", async () => {
    const { storedTokensIfStale } = await import("../../src/sse/services/tokenRefresh.js");
    const resolved = { connectionProxyEnabled: true, connectionProxyUrl: "http://proxy:1", strictProxy: true };

    expect(storedTokensIfStale(null, { accessToken: "a" })).toBeNull();
    expect(storedTokensIfStale({ accessToken: "a" }, { accessToken: "a" })).toBeNull();
    expect(storedTokensIfStale(
      { accessToken: "at-row", refreshToken: "rt-row", expiresAt: "x", providerSpecificData: { region: "eu" } },
      { accessToken: "at-mine" },
      resolved,
    )).toEqual({
      accessToken: "at-row",
      apiKey: undefined,
      refreshToken: "rt-row",
      expiresAt: "x",
      lastRefreshAt: undefined,
      copilotToken: null,
      copilotTokenExpiresAt: null,
      providerSpecificData: { region: "eu", ...resolved },
    });
  });

  it("keeps strict proxy mode and the winning row's apiKey when adopting a stale refresh", async () => {
    const { storedTokensIfStale } = await import("../../src/sse/services/tokenRefresh.js");
    const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
    const resolved = { connectionProxyEnabled: true, connectionProxyUrl: "http://proxy:1", strictProxy: true };
    const adopted = storedTokensIfStale(
      { accessToken: "at-row", apiKey: "nous-key-row", refreshToken: "rt-row", providerSpecificData: { proxyPoolId: "pool-1" } },
      { accessToken: "at-mine", apiKey: "nous-key-mine" },
      resolved,
    );

    expect(adopted.providerSpecificData).toMatchObject({ strictProxy: true, connectionProxyUrl: "http://proxy:1" });
    expect(adopted.apiKey).toBe("nous-key-row");
    expect(new DefaultExecutor("nous").buildHeaders(adopted).Authorization).toBe("Bearer nous-key-row");
  });

  it("sends GitHub's stored Copilot bearer on the retry, not the losing one", async () => {
    const { storedTokensIfStale } = await import("../../src/sse/services/tokenRefresh.js");
    const { GithubExecutor } = await import("../../open-sse/executors/github.js");
    mocks.execute.mockReset();
    mocks.execute.mockResolvedValueOnce(expired401()).mockResolvedValueOnce(expired401());
    mocks.refreshCredentials.mockResolvedValue({
      accessToken: "at-late",
      refreshToken: "rt-late",
      copilotToken: "cop-late",
      copilotTokenExpiresAt: 2000000000,
    });
    const stored = {
      accessToken: "at-login",
      refreshToken: "rt-login",
      providerSpecificData: { copilotToken: "cop-login", copilotTokenExpiresAt: 2000000001 },
    };
    const onCredentialsRefreshed = vi.fn(async (refreshed) => storedTokensIfStale(stored, refreshed, {}));

    await runChat({ onCredentialsRefreshed });

    const retry = mocks.execute.mock.calls[1][0].credentials;
    expect(new GithubExecutor().buildHeaders(retry).Authorization).toBe("Bearer cop-login");
    expect(retry.copilotTokenExpiresAt).toBe(2000000001);
  });
});

describe("DefaultExecutor refresh", () => {
  beforeEach(() => vi.clearAllMocks());

  const refresh = () => new DefaultExecutor("claude").refreshCredentials({ refreshToken: "rt" }, log);

  it("flags an expired grant from the token endpoint", async () => {
    mocks.proxyAwareFetch.mockResolvedValue(new Response(
      JSON.stringify({ error: "invalid_grant", error_description: "Refresh token expired" }),
      { status: 400 },
    ));

    expect(await refresh()).toEqual({ error: "unrecoverable_refresh_error", code: "invalid_grant" });
    expect(log.info).not.toHaveBeenCalled();
  });

  it("returns null for a server error even if the body mentions invalid_grant", async () => {
    mocks.proxyAwareFetch.mockResolvedValue(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 503 }));

    expect(await refresh()).toBeNull();
  });

  it("returns the new tokens on success", async () => {
    mocks.proxyAwareFetch.mockResolvedValue(new Response(
      JSON.stringify({ access_token: "at", refresh_token: "rt-2", expires_in: 3600 }),
      { status: 200 },
    ));

    expect(await refresh()).toEqual({ accessToken: "at", refreshToken: "rt-2", expiresIn: 3600 });
  });
});
