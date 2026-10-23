// A refresh token the provider rejected for good (invalid_grant) takes its login
// out of rotation until it logs in again, instead of being retried every request
// and every background tick.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-dead-rt-"));
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

async function claudeLogin(name, refreshToken) {
  return db.createProviderConnection({
    provider: "claude",
    authType: "oauth",
    name,
    accessToken: `at-${name}`,
    refreshToken,
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    testStatus: "active",
  });
}

describe("markConnectionReauthRequired", () => {
  it("marks the login once and keeps it marked through ordinary writes", async () => {
    const conn = await claudeLogin("dead-a", "rt-dead-a");

    const first = await db.markConnectionReauthRequired(conn.id, { refreshToken: "rt-dead-a" });
    expect(first.changed).toBe(true);
    expect(first.connection.reauthRequiredAt).toBeTruthy();
    expect(first.connection.testStatus).toBe("expired");
    expect(first.connection.lastErrorType).toBe("token_expired");

    const again = await db.markConnectionReauthRequired(conn.id, { refreshToken: "rt-dead-a" });
    expect(again.changed).toBe(false);

    // clearAccountError after a request that still rode the old access token
    await db.updateProviderConnection(conn.id, {
      testStatus: "active", lastError: null, lastErrorAt: null, errorCode: null, backoffLevel: 0,
    });
    // markAccountUnavailable after a 401
    await db.updateProviderConnection(conn.id, {
      "modelLock_claude-opus": new Date(Date.now() + 120_000).toISOString(),
      testStatus: "unavailable", lastError: "401", errorCode: 401,
    });

    const row = await db.getProviderConnectionById(conn.id);
    expect(row.reauthRequiredAt).toBe(first.connection.reauthRequiredAt);
    expect(row.testStatus).toBe("expired");
    expect(row.lastErrorType).toBe("token_expired");
    expect(row["modelLock_claude-opus"]).toBeTruthy();
  });

  it("returns to rotation when a refresh of the current token succeeds", async () => {
    const conn = await claudeLogin("dead-b", "rt-dead-b");
    await db.markConnectionReauthRequired(conn.id, { refreshToken: "rt-dead-b" });

    await db.updateProviderConnection(conn.id, {
      accessToken: "at-new", refreshToken: "rt-new-b", expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      testStatus: "active",
    }, { refreshedFrom: "rt-dead-b" });

    const row = await db.getProviderConnectionById(conn.id);
    expect(row.reauthRequiredAt).toBeNull();
    expect(row.lastErrorType).toBeNull();
    expect(row.testStatus).toBe("active");
    expect(row.lastError).toBeNull();
    expect(row.refreshToken).toBe("rt-new-b");
  });

  it("stays marked when a delayed refresh of an older token lands", async () => {
    const conn = await claudeLogin("raced", "rt-1");
    // Another worker rotated rt-1 -> rt-2, then rt-2 was rejected.
    await db.updateProviderConnection(conn.id, { refreshToken: "rt-2" });
    await db.markConnectionReauthRequired(conn.id, { refreshToken: "rt-2" });

    // A slow request that refreshed from rt-1 writes its result afterwards: dropped.
    await db.updateProviderConnection(conn.id, {
      accessToken: "at-late", refreshToken: "rt-late", testStatus: "active",
    }, { refreshedFrom: "rt-1" });
    const row = await db.getProviderConnectionById(conn.id);
    expect(row.refreshToken).toBe("rt-2");
    expect(row.accessToken).toBe("at-raced");
    expect(row.reauthRequiredAt).toBeTruthy();
    expect(row.testStatus).toBe("expired");
    expect(row.lastErrorType).toBe("token_expired");
  });

  // During a reload the old worker keeps serving for a while. It doesn't know the
  // mark, so it merges its writes straight into the stored JSON.
  async function oldWorkerWrite(id, patch) {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const adapter = await getAdapter();
    const row = adapter.get(`SELECT data FROM providerConnections WHERE id = ?`, [id]);
    const data = { ...JSON.parse(row.data), ...patch };
    adapter.run(`UPDATE providerConnections SET data = ? WHERE id = ?`, [JSON.stringify(data), id]);
  }

  it("comes back when other code stores new tokens for it", async () => {
    const conn = await claudeLogin("old-worker", "rt-before");
    await db.markConnectionReauthRequired(conn.id, { refreshToken: "rt-before" });

    await oldWorkerWrite(conn.id, { accessToken: "at-after", refreshToken: "rt-after", testStatus: "active" });

    const row = await db.getProviderConnectionById(conn.id);
    expect(row.reauthRequiredAt).toBeUndefined();
    expect(row.reauthTokenHash).toBeUndefined();
    expect(row.testStatus).toBe("active");
    expect(row.lastErrorType).toBeNull();
    const picked = (await db.getProviderConnections({ provider: "claude", isActive: true }))
      .find((c) => c.id === conn.id);
    expect(picked.reauthRequiredAt).toBeUndefined();
  });

  it("stays out when other code only touches its health fields", async () => {
    const conn = await claudeLogin("old-worker-health", "rt-dead");
    await db.markConnectionReauthRequired(conn.id, { refreshToken: "rt-dead" });

    await oldWorkerWrite(conn.id, { testStatus: "active", lastError: null, errorCode: null, lastErrorType: null });

    const row = await db.getProviderConnectionById(conn.id);
    expect(row.reauthRequiredAt).toBeTruthy();
    expect(row.testStatus).toBe("expired");
    expect(row.lastErrorType).toBe("token_expired");
  });

  it("stays marked after a refresh that hands back the same tokens", async () => {
    // GitHub mints a Copilot token from the stored access token and returns the
    // OAuth tokens unchanged; that says nothing about the rejected grant.
    const conn = await db.createProviderConnection({
      provider: "github", authType: "oauth", name: "gh",
      accessToken: "gho-same", refreshToken: "ghr-dead", testStatus: "active",
    });
    await db.markConnectionReauthRequired(conn.id, { refreshToken: "ghr-dead" });

    await db.updateProviderConnection(conn.id, {
      accessToken: "gho-same", refreshToken: "ghr-dead", copilotToken: "cop-1", testStatus: "active",
    }, { refreshedFrom: "ghr-dead" });

    const row = await db.getProviderConnectionById(conn.id);
    expect(row.reauthRequiredAt).toBeTruthy();
    expect(row.testStatus).toBe("expired");
  });

  it("keeps a fresh login's tokens when a refresh of the old token lands late", async () => {
    const conn = await claudeLogin("late", "rt-old");
    await db.markConnectionReauthRequired(conn.id, { refreshToken: "rt-old" });
    await db.updateProviderConnection(conn.id, {
      accessToken: "at-login", refreshToken: "rt-login", testStatus: "active", reauthRequiredAt: null,
    });

    await db.updateProviderConnection(conn.id, {
      accessToken: "at-stale", refreshToken: "rt-stale",
    }, { refreshedFrom: "rt-old" });

    const row = await db.getProviderConnectionById(conn.id);
    expect(row.reauthRequiredAt).toBeNull();
    expect(row.accessToken).toBe("at-login");
    expect(row.refreshToken).toBe("rt-login");
  });

  it("returns to rotation on an explicit re-login", async () => {
    const conn = await claudeLogin("relogin", "rt-old");
    await db.markConnectionReauthRequired(conn.id, { refreshToken: "rt-old" });

    await db.updateProviderConnection(conn.id, {
      accessToken: "at-fresh", refreshToken: "rt-fresh", testStatus: "active", reauthRequiredAt: null,
    });

    const row = await db.getProviderConnectionById(conn.id);
    expect(row.reauthRequiredAt).toBeNull();
    expect(row.testStatus).toBe("active");
  });

  it("returns to rotation when the same account logs in again", async () => {
    const first = await db.createProviderConnection({
      provider: "gemini-cli", authType: "oauth", email: "dup@example.com",
      accessToken: "at-a", refreshToken: "rt-a", testStatus: "active",
    });
    await db.markConnectionReauthRequired(first.id, { refreshToken: "rt-a" });

    const again = await db.createProviderConnection({
      provider: "gemini-cli", authType: "oauth", email: "dup@example.com",
      accessToken: "at-b", refreshToken: "rt-b", testStatus: "active",
    });

    expect(again.id).toBe(first.id);
    const row = await db.getProviderConnectionById(first.id);
    expect(row.reauthRequiredAt).toBeNull();
    expect(row.testStatus).toBe("active");
  });

  it("does nothing when the row already holds a different refresh token", async () => {
    const conn = await claudeLogin("rotated", "rt-current");
    const res = await db.markConnectionReauthRequired(conn.id, { refreshToken: "rt-stale" });
    expect(res.changed).toBe(false);
    const row = await db.getProviderConnectionById(conn.id);
    expect(row.reauthRequiredAt).toBeUndefined();
    expect(row.testStatus).toBe("active");
  });

  it("ignores a missing row", async () => {
    const res = await db.markConnectionReauthRequired("nope", { refreshToken: "x" });
    expect(res.changed).toBe(false);
  });
});

describe("checkAndRefreshToken on a dead refresh token", () => {
  const originalFetch = global.fetch;
  let warn;

  beforeEach(() => {
    warn = vi.fn();
    vi.doMock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() }));
  });

  afterAll(() => {
    global.fetch = originalFetch;
    vi.doUnmock("@/sse/utils/logger.js");
  });

  it("marks the login, logs once, and flags the credentials", async () => {
    const conn = await claudeLogin("dead-c", "rt-dead-c");
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve(JSON.stringify({ error: "invalid_grant", error_description: "Refresh token expired" })),
    });
    const { checkAndRefreshToken } = await import("../../src/sse/services/tokenRefresh.js");

    const creds = { ...conn, connectionId: conn.id };
    const out = await checkAndRefreshToken("claude", creds);
    expect(out.needsRelogin).toBe(true);
    expect(out.accessToken).toBe("at-dead-c");

    const row = await db.getProviderConnectionById(conn.id);
    expect(row.reauthRequiredAt).toBeTruthy();
    const reloginLogs = warn.mock.calls.filter(([tag, msg]) => tag === "AUTH" && msg.includes("needs re-login"));
    expect(reloginLogs).toHaveLength(1);
    expect(reloginLogs[0][1]).toContain("dead-c");

    // A second request racing on the same dead token is flagged but not logged again.
    const again = await checkAndRefreshToken("claude", creds);
    expect(again.needsRelogin).toBe(true);
    expect(warn.mock.calls.filter(([tag, msg]) => tag === "AUTH" && msg.includes("needs re-login"))).toHaveLength(1);
  });

  it("leaves the login alone on a transient refresh failure", async () => {
    const conn = await claudeLogin("flaky", "rt-flaky");
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: () => Promise.resolve("upstream unavailable"),
    });
    const { checkAndRefreshToken } = await import("../../src/sse/services/tokenRefresh.js");

    const out = await checkAndRefreshToken("claude", { ...conn, connectionId: conn.id });
    expect(out.needsRelogin).toBeUndefined();
    const row = await db.getProviderConnectionById(conn.id);
    expect(row.reauthRequiredAt).toBeUndefined();
  });
});

describe("rotation skips logins that need re-login", () => {
  it("getProviderCredentials never picks them and says so when none are left", async () => {
    vi.resetModules();
    const warn = vi.fn();
    vi.doMock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() }));
    vi.doMock("@/lib/network/connectionProxy", () => ({
      pickProxyPoolId: vi.fn(),
      resolveConnectionProxyConfig: vi.fn(async () => ({})),
    }));
    const rows = [
      { id: "dead", provider: "glm", authType: "apikey", apiKey: "k1", isActive: true, priority: 1, reauthRequiredAt: "2026-10-23T00:00:00.000Z" },
      { id: "live", provider: "glm", authType: "apikey", apiKey: "k2", isActive: true, priority: 2 },
    ];
    vi.doMock("@/lib/localDb", () => ({
      getProviderConnections: vi.fn(async () => rows),
      updateProviderConnection: vi.fn(),
      getSettings: vi.fn(async () => ({})),
    }));
    const { getProviderCredentials } = await import("../../src/sse/services/auth.js");

    const picked = await getProviderCredentials("glm", null, "glm-5");
    expect(picked.connectionId).toBe("live");

    rows.pop();
    const none = await getProviderCredentials("glm", null, "glm-5");
    expect(none).toBeNull();
    expect(warn).toHaveBeenCalledWith("AUTH", "glm | all 1 accounts need re-login");

    vi.doUnmock("@/lib/localDb");
    vi.doUnmock("@/lib/network/connectionProxy");
    vi.doUnmock("@/sse/utils/logger.js");
  });

  it("background refresh skips them", async () => {
    const { selectConnectionsNeedingRefresh } = await import("../../src/sse/services/backgroundTokenRefresh.js");
    const now = Date.now();
    const base = { provider: "claude", authType: "oauth", refreshToken: "rt", expiresAt: new Date(now + 60_000).toISOString() };
    const out = selectConnectionsNeedingRefresh([
      { ...base, id: "dead", reauthRequiredAt: new Date(now).toISOString() },
      { ...base, id: "live" },
    ], now);
    expect(out.map(c => c.id)).toEqual(["live"]);
  });
});
