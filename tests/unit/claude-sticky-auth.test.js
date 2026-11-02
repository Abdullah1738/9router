import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ rows: new Map(), connections: [], settings: {}, logs: [], db: null }));
vi.mock("@/lib/localDb", () => ({
  getProviderConnections: async ({ isActive } = {}) => mock.connections.filter((c) => isActive === undefined || c.isActive === isActive),
  getSettings: async () => mock.settings,
  getProxyPools: async () => [], validateApiKey: vi.fn(),
  updateProviderConnection: async (id, patch) => Object.assign(mock.connections.find((c) => c.id === id), patch),
}));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: async () => ({}), pickProxyPoolId: vi.fn() }));
vi.mock("@/shared/constants/providers.js", () => ({ FREE_PROVIDERS: {}, resolveProviderId: (p) => p }));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: (...args) => mock.logs.push(args), warn: vi.fn() }));
vi.mock("@/sse/services/antigravityQuota.js", () => ({ getAntigravityQuotaCache: () => new Map(), getAntigravityModelQuota: vi.fn() }));
vi.mock("@/lib/db/driver.js", () => ({ getAdapter: async () => mock.db }));

const { getProviderCredentials, markAccountUnavailable, clearAccountError } = await import("@/sse/services/auth.js");
const tracker = await import("open-sse/services/claudeQuotaTracker.js");
const model = "claude-haiku-5-5";
const options = { sessionKey: "test-session" };
const account = (id, authType = "oauth") => ({ id, isActive: true, authType });
const persisted = () => JSON.parse([...mock.rows.values()][0]);

beforeEach(() => {
  tracker.__resetTracker();
  mock.rows.clear();
  mock.logs.length = 0;
  mock.settings = {};
  mock.connections = [account("account-a"), account("account-b")];
  mock.db = {
    exec: vi.fn(),
    get: (sql, args) => sql.includes("COUNT(*)") ? { count: mock.rows.size } : mock.rows.has(args[1]) ? { value: mock.rows.get(args[1]) } : undefined,
    all: () => [...mock.rows].map(([key, value]) => ({ key, value })),
    run: (sql, args) => { if (sql.startsWith("INSERT")) mock.rows.set(args[1], args[2]); },
  };
});

describe("Claude affinity at credential selection", () => {
  it.each([
    [503, 429, false],
    [429, 503, true],
  ])("classifies a Haiku %s lock after a Sonnet %s lock by Haiku's cause", async (haikuStatus, sonnetStatus, shouldMove) => {
    const first = await getProviderCredentials("claude", null, model, options);
    await markAccountUnavailable(first.connectionId, haikuStatus, "test failure", "claude", model);
    await markAccountUnavailable(first.connectionId, sonnetStatus, "test failure", "claude", "claude-sonnet-5-5");
    const conn = mock.connections.find((c) => c.id === first.connectionId);
    expect(conn.errorCode).toBe(sonnetStatus);
    expect(tracker.getQuotaLockUntil(first.connectionId)).toBe(0);
    const next = await getProviderCredentials("claude", new Set([first.connectionId]), model, options);
    if (shouldMove) {
      expect(next?.connectionId).not.toBe(first.connectionId);
      expect(next?.connectionId).toBeTruthy();
      expect(persisted().connectionId).toBe(next.connectionId);
    } else {
      expect(next).toBeNull();
      expect(persisted().connectionId).toBe(first.connectionId);
    }
  });

  it("uses the cause of an active account-wide lock and clears that cause on success", async () => {
    const first = await getProviderCredentials("claude", null, model, options);
    await markAccountUnavailable(first.connectionId, 429, "quota", "claude", null);
    await markAccountUnavailable(first.connectionId, 503, "temporary", "claude", "claude-sonnet-5-5");
    const next = await getProviderCredentials("claude", null, model, options);
    expect(next?.connectionId).not.toBe(first.connectionId);
    expect(persisted().connectionId).toBe(next.connectionId);
    const conn = mock.connections.find((c) => c.id === first.connectionId);
    await clearAccountError(first.connectionId, conn, model);
    expect(conn.modelLock___all).toBeNull();
    expect(conn.modelLockCause___all).toBeNull();
    expect(conn["modelLockCause_claude-sonnet-5-5"]).toMatchObject({ status: 503 });
  });

  it("does not confuse expired or legacy lock causes with an active quota lock", async () => {
    const first = await getProviderCredentials("claude", null, model, options);
    const conn = mock.connections.find((c) => c.id === first.connectionId);
    conn[`modelLock_${model}`] = new Date(Date.now() + 60_000).toISOString();
    conn[`modelLockCause_${model}`] = { status: 429, until: new Date(Date.now() - 60_000).toISOString() };
    conn.errorCode = 429;
    expect(await getProviderCredentials("claude", null, model, options)).toBeNull();
    expect(persisted().connectionId).toBe(first.connectionId);
    delete conn[`modelLockCause_${model}`];
    expect(await getProviderCredentials("claude", null, model, options)).toBeNull();
    expect(persisted().connectionId).toBe(first.connectionId);
  });

  it("does not let an expired model lock hide an active account-wide quota lock", async () => {
    const first = await getProviderCredentials("claude", null, model, options);
    const conn = mock.connections.find((c) => c.id === first.connectionId);
    conn[`modelLock_${model}`] = new Date(Date.now() - 60_000).toISOString();
    await markAccountUnavailable(first.connectionId, 429, "quota", "claude", null);
    const next = await getProviderCredentials("claude", null, model, options);
    expect(next?.connectionId).toBeTruthy();
    expect(next.connectionId).not.toBe(first.connectionId);
  });

  it("retains the binding through a transient 503 cooldown and retry", async () => {
    const first = await getProviderCredentials("claude", null, model, options);
    await markAccountUnavailable(first.connectionId, 503, "temporary upstream failure", "claude", model);
    expect(await getProviderCredentials("claude", new Set([first.connectionId]), model, options)).toBeNull();
    expect(persisted().connectionId).toBe(first.connectionId);
    mock.connections.find((c) => c.id === first.connectionId)[`modelLock_${model}`] = null;
    expect((await getProviderCredentials("claude", null, model, options)).connectionId).toBe(first.connectionId);
  });

  it("persists an API-key fallback after a quota lock and keeps it after OAuth recovers", async () => {
    mock.connections = [account("account-a"), account("api-account", "apiKey")];
    const first = await getProviderCredentials("claude", null, model, options);
    expect(first.connectionId).toBe("account-a");
    const quota = (used) => ({ quotas: { "session (5h)": { used, resetAt: new Date(Date.now() + 3600_000).toISOString() } } });
    tracker.ingestClaudeUsage("account-a", quota(100));
    const fallback = await getProviderCredentials("claude", null, model, options);
    expect(fallback.connectionId).toBe("api-account");
    expect(persisted().connectionId).toBe("api-account");
    expect(mock.logs.some((entry) => entry[1].includes("moved:quota-locked"))).toBe(true);
    tracker.ingestClaudeUsage("account-a", quota(1));
    expect((await getProviderCredentials("claude", null, model, options)).connectionId).toBe("api-account");
  });

  it("moves after an actual 429 model quota lock", async () => {
    const first = await getProviderCredentials("claude", null, model, options);
    await markAccountUnavailable(first.connectionId, 429, "rate limited", "claude", model);
    const next = await getProviderCredentials("claude", new Set([first.connectionId]), model, options);
    expect(next.connectionId).not.toBe(first.connectionId);
    expect(persisted().connectionId).toBe(next.connectionId);
    expect(mock.logs.some((entry) => entry[1].includes("moved:quota-locked"))).toBe(true);
  });

  it("moves from a disabled binding even when preference points to it", async () => {
    const first = await getProviderCredentials("claude", null, model, options);
    mock.connections.find((c) => c.id === first.connectionId).isActive = false;
    const next = await getProviderCredentials("claude", null, model, { ...options, preferredConnectionId: first.connectionId });
    expect(next.connectionId).not.toBe(first.connectionId);
    expect(persisted().connectionId).toBe(next.connectionId);
    expect(mock.logs.some((entry) => entry[1].includes("moved:disabled"))).toBe(true);
  });

  it.each(["fill-first", "round-robin"])("honors the binding when strategy changes to %s", async (strategy) => {
    const first = await getProviderCredentials("claude", null, model, options);
    mock.settings = { providerStrategies: { claude: { fallbackStrategy: strategy } } };
    mock.connections.reverse();
    expect((await getProviderCredentials("claude", null, model, options)).connectionId).toBe(first.connectionId);
  });

  it("honors a healthy binding before an explicit preferred connection", async () => {
    const first = await getProviderCredentials("claude", null, model, options);
    const other = mock.connections.find((c) => c.id !== first.connectionId).id;
    const next = await getProviderCredentials("claude", null, model, { ...options, preferredConnectionId: other });
    expect(next.connectionId).toBe(first.connectionId);
    expect(persisted().connectionId).toBe(first.connectionId);
  });

  it("respects preference for a new session and persists that choice", async () => {
    const first = await getProviderCredentials("claude", null, model, { ...options, preferredConnectionId: "account-b" });
    expect(first.connectionId).toBe("account-b");
    expect(persisted().connectionId).toBe("account-b");
  });
});
