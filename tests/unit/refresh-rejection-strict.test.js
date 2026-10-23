// Only an exact rejection code on a 400/401 from the token endpoint takes a login
// out of rotation, for every provider path that can set the mark. Outages and
// unrelated errors leave the login alone.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const originalFetch = global.fetch;
const DEAD = { error: "unrecoverable_refresh_error", code: "invalid_grant" };

function respond(status, body) {
  return { ok: status < 400, status, text: () => Promise.resolve(body), json: () => Promise.resolve(JSON.parse(body)) };
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.doUnmock("../../src/lib/oauth/services/xai.js");
});

describe("codex refresh", () => {
  it("flags an invalid_grant on a 400", async () => {
    global.fetch = vi.fn().mockResolvedValue(respond(400, JSON.stringify({ error: "invalid_grant" })));
    const { refreshCodexToken } = await import("../../open-sse/services/tokenRefresh/providers.js");
    expect(await refreshCodexToken("rt-a")).toEqual(DEAD);
  });

  it("does not flag a server error or a description that only mentions it", async () => {
    const { refreshCodexToken } = await import("../../open-sse/services/tokenRefresh/providers.js");
    global.fetch = vi.fn().mockResolvedValue(respond(503, JSON.stringify({ error: "invalid_grant" })));
    expect(await refreshCodexToken("rt-b")).toBeNull();

    global.fetch = vi.fn().mockResolvedValue(respond(400, JSON.stringify({
      error: "invalid_request", error_description: "see invalid_grant docs",
    })));
    expect(await refreshCodexToken("rt-c")).toBeNull();
  });
});

describe("xai refresh", () => {
  function mockXai(status, body) {
    vi.doMock("../../src/lib/oauth/services/xai.js", () => ({
      XaiService: class {
        async refreshAccessToken() {
          throw Object.assign(new Error(`xAI token refresh failed: ${body}`), { status, body });
        }
      },
    }));
  }

  it("flags an invalid_grant on a 400", async () => {
    mockXai(400, JSON.stringify({ error: "invalid_grant" }));
    const { refreshXaiToken } = await import("../../open-sse/services/tokenRefresh/providers.js");
    expect(await refreshXaiToken("rt-x1")).toEqual(DEAD);
  });

  it("does not flag invalid_request, an outage, or an error without a status", async () => {
    mockXai(400, JSON.stringify({ error: "invalid_request" }));
    let mod = await import("../../open-sse/services/tokenRefresh/providers.js");
    expect(await mod.refreshXaiToken("rt-x2")).toBeNull();

    vi.resetModules();
    mockXai(502, JSON.stringify({ error: "invalid_grant" }));
    mod = await import("../../open-sse/services/tokenRefresh/providers.js");
    expect(await mod.refreshXaiToken("rt-x3")).toBeNull();

    vi.resetModules();
    vi.doMock("../../src/lib/oauth/services/xai.js", () => ({
      XaiService: class {
        async refreshAccessToken() { throw new Error("fetch failed: invalid_grant"); }
      },
    }));
    mod = await import("../../open-sse/services/tokenRefresh/providers.js");
    expect(await mod.refreshXaiToken("rt-x4")).toBeNull();
  });

  it("XaiService keeps the status and body on a failed refresh", async () => {
    const { XaiService } = await import("../../src/lib/oauth/services/xai.js");
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce(respond(400, JSON.stringify({ error: "invalid_grant" })));
    const err = await new XaiService().refreshAccessToken("rt").catch((e) => e);
    expect(err.status).toBe(400);
    expect(JSON.parse(err.body).error).toBe("invalid_grant");
  });
});

describe("refresh single-flight", () => {
  it("tells a caller that joined a running refresh which token the result came from", async () => {
    let release;
    const fetchMock = vi.fn(() => new Promise((resolve) => {
      release = () => resolve(respond(400, JSON.stringify({ error: "invalid_grant" })));
    }));
    global.fetch = fetchMock;
    const { refreshProviderCredentials } = await import("../../open-sse/services/oauthCredentialManager.js");

    // A refresh with the old token is in flight when a new login lands on the row.
    const old = refreshProviderCredentials("codex", { connectionId: "c1", refreshToken: "rt-old" }, null);
    const joined = refreshProviderCredentials("codex", { connectionId: "c1", refreshToken: "rt-login" }, null);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    release();

    const [a, b] = await Promise.all([old, joined]);
    expect(a).toMatchObject({ ...DEAD, refreshedFrom: "rt-old" });
    expect(b.refreshedFrom).toBe("rt-old");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("reactive executor refresh", () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  it("kimi flags an invalid_grant and ignores outages", async () => {
    const proxyAwareFetch = vi.fn();
    vi.doMock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch }));
    const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
    const kimi = new DefaultExecutor("kimi");

    proxyAwareFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    expect(await kimi.refreshCredentials({ refreshToken: "rt" }, log)).toEqual(DEAD);

    proxyAwareFetch.mockResolvedValueOnce(new Response("bad gateway", { status: 502 }));
    expect(await kimi.refreshCredentials({ refreshToken: "rt" }, log)).toBeNull();
    vi.doUnmock("../../open-sse/utils/proxyFetch.js");
  });

  it("github passes a dead grant through instead of swallowing it", async () => {
    const proxyAwareFetch = vi.fn()
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 })) // copilot token
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    vi.doMock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch }));
    const { GithubExecutor } = await import("../../open-sse/executors/github.js");

    const out = await new GithubExecutor().refreshCredentials({ accessToken: "gho", refreshToken: "ghr" }, log);
    expect(out).toEqual(DEAD);
    vi.doUnmock("../../open-sse/utils/proxyFetch.js");
  });
});
