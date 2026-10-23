// Refreshes made outside the chat path (dashboard Test, usage checks) say which
// token they used, so a login waiting for re-login comes back only when that
// refresh worked, and a stale result never overwrites newer tokens.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
const originalFetch = global.fetch;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-provenance-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

afterEach(() => {
  global.fetch = originalFetch;
});

async function deadClaude(name) {
  const conn = await db.createProviderConnection({
    provider: "claude",
    authType: "oauth",
    name,
    accessToken: `at-${name}`,
    refreshToken: `rt-${name}`,
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    testStatus: "active",
  });
  await db.markConnectionReauthRequired(conn.id, { refreshToken: `rt-${name}` });
  return conn;
}

const json = (status, body) => ({
  ok: status < 400, status, text: () => Promise.resolve(JSON.stringify(body)), json: () => Promise.resolve(body),
});

describe("dashboard Test on a login that needs re-login", () => {
  it("brings it back when the refresh works", async () => {
    const conn = await deadClaude("test-ok");
    const { testSingleConnection } = await import("../../src/app/api/providers/[id]/test/testUtils.js");
    global.fetch = vi.fn().mockResolvedValue(json(200, { access_token: "at-new", refresh_token: "rt-new", expires_in: 3600 }));

    const result = await testSingleConnection(conn.id);

    expect(result.valid).toBe(true);
    const row = await db.getProviderConnectionById(conn.id);
    expect(row.reauthRequiredAt).toBeNull();
    expect(row.testStatus).toBe("active");
    expect(row.refreshToken).toBe("rt-new");
  });

  it("keeps it marked when the refresh is still rejected", async () => {
    const conn = await deadClaude("test-dead");
    const { testSingleConnection } = await import("../../src/app/api/providers/[id]/test/testUtils.js");
    global.fetch = vi.fn().mockResolvedValue(json(400, { error: "invalid_grant" }));

    const result = await testSingleConnection(conn.id);

    expect(result.valid).toBe(false);
    const row = await db.getProviderConnectionById(conn.id);
    expect(row.reauthRequiredAt).toBeTruthy();
    expect(row.testStatus).toBe("expired");
  });
});

describe("usage refresh on a login that needs re-login", () => {
  it("brings it back when the refresh of its current token works", async () => {
    const conn = await deadClaude("usage-ok");
    const proxyAwareFetch = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ access_token: "at-u", refresh_token: "rt-u", expires_in: 3600 }), { status: 200 },
    ));
    vi.doMock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch }));
    const { refreshAndUpdateCredentials } = await import("../../src/app/api/usage/[connectionId]/route.js");

    await refreshAndUpdateCredentials(await db.getProviderConnectionById(conn.id), true);

    const row = await db.getProviderConnectionById(conn.id);
    expect(row.reauthRequiredAt).toBeNull();
    expect(row.refreshToken).toBe("rt-u");
    vi.doUnmock("../../open-sse/utils/proxyFetch.js");
  });
});

async function login(provider, name, extra = {}) {
  return db.createProviderConnection({
    provider,
    authType: "oauth",
    name,
    accessToken: `at-${name}`,
    refreshToken: `rt-${name}`,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    testStatus: "active",
    ...extra,
  });
}

const isTokenUrl = (url) => String(url).includes("/oauth/token");

describe("model list refresh", () => {
  async function listModels(id) {
    const { GET } = await import("@/app/api/providers/[id]/models/route.js");
    return GET(new Request(`http://localhost/api/providers/${id}/models`), { params: Promise.resolve({ id }) });
  }

  it("brings a marked login back when the refresh of its current token works", async () => {
    const conn = await login("codex", "models-ok");
    await db.markConnectionReauthRequired(conn.id, { refreshToken: "rt-models-ok" });
    let modelCalls = 0;
    global.fetch = vi.fn(async (url) => {
      if (isTokenUrl(url)) return json(200, { access_token: "at-m2", refresh_token: "rt-m2", expires_in: 3600 });
      modelCalls += 1;
      return modelCalls === 1 ? json(401, { error: "expired" }) : json(200, { data: [{ id: "gpt-x" }] });
    });

    const res = await listModels(conn.id);

    expect(res.status).toBe(200);
    const row = await db.getProviderConnectionById(conn.id);
    expect(row.reauthRequiredAt).toBeNull();
    expect(row.refreshToken).toBe("rt-m2");
  });

  it("does not overwrite a login that landed while the refresh was running", async () => {
    const conn = await login("codex", "models-race");
    let modelCalls = 0;
    global.fetch = vi.fn(async (url) => {
      if (isTokenUrl(url)) {
        await db.updateProviderConnection(conn.id, { accessToken: "at-login", refreshToken: "rt-login", testStatus: "active" });
        return json(200, { access_token: "at-late", refresh_token: "rt-late", expires_in: 3600 });
      }
      modelCalls += 1;
      return modelCalls === 1 ? json(401, { error: "expired" }) : json(200, { data: [{ id: "gpt-x" }] });
    });

    await listModels(conn.id);

    const row = await db.getProviderConnectionById(conn.id);
    expect(row.refreshToken).toBe("rt-login");
    expect(row.accessToken).toBe("at-login");
  });
});

describe("a refresh that finishes after the row moved on", () => {
  it("hands the caller the stored tokens, not the stale result", async () => {
    const conn = await login("claude", "chat-race");
    const { checkAndRefreshToken } = await import("../../src/sse/services/tokenRefresh.js");
    global.fetch = vi.fn(async () => {
      await db.updateProviderConnection(conn.id, { accessToken: "at-fresh", refreshToken: "rt-fresh", testStatus: "active" });
      return json(200, { access_token: "at-stale", refresh_token: "rt-stale", expires_in: 3600 });
    });

    const creds = await checkAndRefreshToken("claude", { ...conn, connectionId: conn.id }, { force: true });

    expect(creds.accessToken).toBe("at-fresh");
    expect(creds.refreshToken).toBe("rt-fresh");
    expect(creds.refreshedFrom).toBeUndefined();
    const row = await db.getProviderConnectionById(conn.id);
    expect(row.refreshToken).toBe("rt-fresh");
  });

  it("keeps the request's resolved proxy when it adopts the stored tokens", async () => {
    const conn = await login("claude", "pool-race", { providerSpecificData: { proxyPoolId: "pool-1" } });
    const { checkAndRefreshToken } = await import("../../src/sse/services/tokenRefresh.js");
    global.fetch = vi.fn(async () => {
      await db.updateProviderConnection(conn.id, { accessToken: "at-pool-fresh", refreshToken: "rt-pool-fresh", testStatus: "active" });
      return json(200, { access_token: "at-pool-stale", refresh_token: "rt-pool-stale", expires_in: 3600 });
    });
    const resolved = {
      proxyPoolId: "pool-1",
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://proxy.test:8080",
      connectionNoProxy: "",
      connectionProxyPoolId: "pool-1",
      vercelRelayUrl: "",
    };

    const creds = await checkAndRefreshToken("claude", { ...conn, connectionId: conn.id, providerSpecificData: resolved }, { force: true });

    expect(creds.accessToken).toBe("at-pool-fresh");
    expect(creds.providerSpecificData).toMatchObject(resolved);
  });

  it("takes the stored Copilot bearer too when a GitHub refresh loses", async () => {
    const soon = Math.floor(Date.now() / 1000) + 3600;
    const conn = await login("github", "copilot-race", {
      providerSpecificData: { copilotToken: "cop-old", copilotTokenExpiresAt: soon },
    });
    const { checkAndRefreshToken } = await import("../../src/sse/services/tokenRefresh.js");
    global.fetch = vi.fn(async () => {
      await db.updateProviderConnection(conn.id, {
        accessToken: "at-gh-login",
        refreshToken: "rt-gh-login",
        providerSpecificData: { copilotToken: "cop-login", copilotTokenExpiresAt: soon + 60 },
        testStatus: "active",
      });
      return json(200, { access_token: "at-gh-late", refresh_token: "rt-gh-late", expires_in: 3600 });
    });

    const creds = await checkAndRefreshToken(
      "github",
      { ...conn, connectionId: conn.id, copilotToken: "cop-old" },
      { force: true },
    );

    expect(creds.accessToken).toBe("at-gh-login");
    expect(creds.copilotToken).toBe("cop-login");
    expect(creds.providerSpecificData.copilotToken).toBe("cop-login");
  });

  it("usage refresh returns the stored connection when its write was stale", async () => {
    const conn = await login("claude", "usage-race");
    const proxyAwareFetch = vi.fn(async () => {
      await db.updateProviderConnection(conn.id, { accessToken: "at-u-fresh", refreshToken: "rt-u-fresh", testStatus: "active" });
      return new Response(JSON.stringify({ access_token: "at-u-stale", refresh_token: "rt-u-stale", expires_in: 3600 }), { status: 200 });
    });
    vi.doMock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch }));
    vi.resetModules();
    const { refreshAndUpdateCredentials } = await import("../../src/app/api/usage/[connectionId]/route.js");

    const result = await refreshAndUpdateCredentials(await db.getProviderConnectionById(conn.id), true);

    expect(result.connection.accessToken).toBe("at-u-fresh");
    const row = await db.getProviderConnectionById(conn.id);
    expect(row.refreshToken).toBe("rt-u-fresh");
    vi.doUnmock("../../open-sse/utils/proxyFetch.js");
  });
});

describe("dashboard Test probe that gets a 401", () => {
  it("does not retry the probe when the refresh is rejected", async () => {
    const conn = await login("codex", "probe-dead", { expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(), lastRefreshAt: new Date().toISOString() });
    const { testSingleConnection } = await import("../../src/app/api/providers/[id]/test/testUtils.js");
    const calls = [];
    global.fetch = vi.fn(async (url) => {
      calls.push(String(url));
      return isTokenUrl(url) ? json(400, { error: "invalid_grant" }) : json(401, { error: "expired" });
    });

    const result = await testSingleConnection(conn.id);

    expect(result.valid).toBe(false);
    expect(calls.filter((u) => !isTokenUrl(u))).toHaveLength(1);
    expect(calls.filter(isTokenUrl)).toHaveLength(1);
  });
});
