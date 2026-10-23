/**
 * Re-login of a connection whose refresh token died: the OAuth exchange (and
 * the device-code poll) must put the new tokens on the same row instead of
 * creating a second one, so the account keeps its name and priority.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) => ({
      status: init?.status || 200,
      body,
      json: async () => body,
    }),
  },
}));

vi.mock("@/lib/oauth/providers", () => ({
  getProvider: vi.fn(),
  generateAuthData: vi.fn(),
  exchangeTokens: vi.fn(async () => ({ accessToken: "at-new", refreshToken: "rt-new", expiresIn: 3600 })),
  requestDeviceCode: vi.fn(),
  pollForToken: vi.fn(async () => ({ success: true, tokens: { accessToken: "gh-new", refreshToken: "gh-rt-new" } })),
}));

const rows = new Map();

vi.mock("@/models", () => ({
  createProviderConnection: vi.fn(async (d) => ({ id: "conn-created", ...d })),
  getProviderConnectionById: vi.fn(async (id) => rows.get(id) || null),
  updateProviderConnection: vi.fn(async (id, d) => ({ ...rows.get(id), ...d })),
}));

vi.mock("open-sse/shared/mimoAccount.js", () => ({ readDesktopPassToken: vi.fn() }));
vi.mock("@/lib/oauth/utils/ideDetect", () => ({ detectIdeInstalled: vi.fn() }));
vi.mock("@/lib/oauth/utils/server", () => {
  const noop = () => {};
  const none = () => null;
  return {
    startCodexProxy: noop, stopCodexProxy: noop, registerCodexSession: noop,
    getCodexSessionStatus: none, clearCodexSession: noop,
    startXaiProxy: noop, stopXaiProxy: noop, registerXaiSession: noop,
    getXaiSessionStatus: none, clearXaiSession: noop,
    startTraeProxy: noop, stopTraeProxy: noop, registerTraeSession: noop,
    getTraeSessionStatus: none, clearTraeSession: noop,
    startWindsurfProxy: noop, stopWindsurfProxy: noop, registerWindsurfSession: noop,
    getWindsurfSessionStatus: none, clearWindsurfSession: noop,
    startZedProxy: noop, stopZedProxy: noop, registerZedSession: noop,
    getZedSessionStatus: none, clearZedSession: noop,
    startXiaomiMimoProxy: noop, stopXiaomiMimoProxy: noop, registerXiaomiMimoSession: noop,
    getXiaomiMimoSessionStatus: none, clearXiaomiMimoSession: noop,
  };
});

const models = await import("@/models");
const { POST } = await import("../../src/app/api/oauth/[provider]/[action]/route.js");

const post = (provider, action, body) =>
  POST(
    new Request(`http://localhost/api/oauth/${provider}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ provider, action }) },
  );

const exchangeBody = { code: "c", redirectUri: "http://localhost/cb", codeVerifier: "v", state: "s" };

describe("OAuth re-login of an existing connection", () => {
  beforeEach(() => {
    rows.clear();
    vi.clearAllMocks();
    rows.set("dead-1", {
      id: "dead-1",
      provider: "claude",
      authType: "oauth",
      name: "eq",
      providerSpecificData: { proxyPoolId: "pool-a" },
      reauthRequiredAt: "2026-10-22T06:01:00.000Z",
    });
  });

  it("puts the new tokens on the dead row instead of adding one", async () => {
    const res = await post("claude", "exchange", { ...exchangeBody, reauthConnectionId: "dead-1" });

    expect(res.status).toBe(200);
    expect(res.body.connection.id).toBe("dead-1");
    expect(models.createProviderConnection).not.toHaveBeenCalled();
    const [id, patch] = models.updateProviderConnection.mock.calls[0];
    expect(id).toBe("dead-1");
    expect(patch).toMatchObject({ accessToken: "at-new", refreshToken: "rt-new", testStatus: "active" });
    expect(Date.parse(patch.expiresAt)).toBeGreaterThan(Date.now());
    expect(patch.lastRefreshAt).toBeTruthy();
  });

  it("refuses a re-login aimed at another provider's row", async () => {
    const res = await post("codex", "exchange", { ...exchangeBody, reauthConnectionId: "dead-1" });

    expect(res.status).toBe(404);
    expect(models.updateProviderConnection).not.toHaveBeenCalled();
    expect(models.createProviderConnection).not.toHaveBeenCalled();
  });

  it("still creates a new connection for a normal login", async () => {
    const res = await post("claude", "exchange", exchangeBody);

    expect(res.body.connection.id).toBe("conn-created");
    expect(models.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("re-logs a device-code account in place", async () => {
    rows.set("gh-dead", { id: "gh-dead", provider: "github", authType: "oauth", reauthRequiredAt: "x" });

    const res = await post("github", "poll", { deviceCode: "dc", reauthConnectionId: "gh-dead" });

    expect(res.body.connection.id).toBe("gh-dead");
    expect(models.createProviderConnection).not.toHaveBeenCalled();
    expect(models.updateProviderConnection.mock.calls[0][1]).toMatchObject({ accessToken: "gh-new", testStatus: "active" });
  });
});
