/**
 * Generic OAuth2 token refresh — config-driven profiles.
 *
 * Verifies refreshAccessToken() handles the 4 foldable providers
 * (iflow, github, kimi, claude) via a REFRESH_PROFILES table,
 * while preserving the legacy generic path for unknown providers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const originalFetch = global.fetch;

function mockFetchOnce(payload, { ok = true, status = 200 } = {}) {
  const fn = vi.fn().mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(JSON.stringify(payload)),
  });
  global.fetch = fn;
  return fn;
}

describe("refreshAccessToken — config-driven profiles", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.resetModules(); global.fetch = originalFetch; });
  afterEach(() => { global.fetch = originalFetch; });

  it("iflow: Basic Auth header from clientId:clientSecret, form body keeps client_secret", async () => {
    const fm = mockFetchOnce({ access_token: "if-acc", refresh_token: "if-rot", expires_in: 3600 });
    const { refreshAccessToken } = await import("open-sse/services/tokenRefresh/providers.js");

    await refreshAccessToken("iflow", "if-old", {}, console);

    const [, init] = fm.mock.calls[0];
    expect(init.headers["Authorization"]).toMatch(/^Basic /);
    const body = new URLSearchParams(init.body);
    expect(body.get("client_id")).toBeTruthy();
    expect(body.get("client_secret")).toBeTruthy();
  });

  it("github: omits client_secret when config has none", async () => {
    const fm = mockFetchOnce({ access_token: "gh-acc", expires_in: 28800 });
    const { refreshAccessToken } = await import("open-sse/services/tokenRefresh/providers.js");

    const out = await refreshAccessToken("github", "gh-old", {}, console);

    const body = new URLSearchParams(fm.mock.calls[0][1].body);
    expect(body.get("client_secret")).toBeNull();
    expect(out.accessToken).toBe("gh-acc");
    expect(out.refreshToken).toBe("gh-old");
  });

  it("kimi: merges X-Msh-* headers from credentials.providerSpecificData.deviceId", async () => {
    const fm = mockFetchOnce({ access_token: "km-acc", expires_in: 86400 });
    const { refreshAccessToken } = await import("open-sse/services/tokenRefresh/providers.js");

    await refreshAccessToken("kimi", "km-old", {
      providerSpecificData: { deviceId: "dev-xyz" },
    }, console);

    const headers = fm.mock.calls[0][1].headers;
    // Kimi's buildKimiHeaders must contribute at least one X-Msh- header
    const mshKeys = Object.keys(headers).filter((k) => k.toLowerCase().startsWith("x-msh-"));
    expect(mshKeys.length).toBeGreaterThan(0);
  });

  it("claude: JSON body, client_id only (no client_secret)", async () => {
    const fm = mockFetchOnce({ access_token: "cl-acc", refresh_token: "cl-rot", expires_in: 3600 });
    const { refreshAccessToken } = await import("open-sse/services/tokenRefresh/providers.js");

    await refreshAccessToken("claude", "cl-old", {}, console);

    const [, init] = fm.mock.calls[0];
    expect(init.headers["Content-Type"]).toBe("application/json");
    const parsed = JSON.parse(init.body);
    expect(parsed.grant_type).toBe("refresh_token");
    expect(parsed.client_id).toBeTruthy();
    expect(parsed).not.toHaveProperty("client_secret");
  });

  it("returns null on a transient non-ok response", async () => {
    mockFetchOnce({ error: "server_error" }, { ok: false, status: 503 });
    const { refreshAccessToken } = await import("open-sse/services/tokenRefresh/providers.js");
    const out = await refreshAccessToken("iflow", "flaky", {}, console);
    expect(out).toBeNull();
  });

  it("flags an expired refresh token as unrecoverable", async () => {
    mockFetchOnce(
      { error: "invalid_grant", error_description: "Refresh token expired" },
      { ok: false, status: 400 },
    );
    const { refreshAccessToken } = await import("open-sse/services/tokenRefresh/providers.js");
    const { isUnrecoverableRefreshError } = await import("open-sse/services/tokenRefresh.js");
    const out = await refreshAccessToken("claude", "dead", {}, console);
    expect(out).toEqual({ error: "unrecoverable_refresh_error", code: "invalid_grant" });
    expect(isUnrecoverableRefreshError(out)).toBe(true);
  });

  it("only treats an exact rejection code on a 400/401 as permanent", async () => {
    const { getPermanentRefreshRejection } = await import("open-sse/services/tokenRefresh/providers.js");
    const body = (o) => JSON.stringify(o);

    expect(getPermanentRefreshRejection(400, body({ error: "invalid_grant" }))).toBe("invalid_grant");
    expect(getPermanentRefreshRejection(401, body({ error: { code: "refresh_token_reused" } }))).toBe("refresh_token_reused");
    // Upstream outage whose text happens to mention the marker
    expect(getPermanentRefreshRejection(503, body({ error: "invalid_grant" }))).toBeNull();
    // Other error code, marker only in the description
    expect(getPermanentRefreshRejection(400, body({ error: "invalid_request", error_description: "not an invalid_grant" }))).toBeNull();
    // Non-JSON body
    expect(getPermanentRefreshRejection(400, "invalid_grant")).toBeNull();
    expect(getPermanentRefreshRejection(400, "")).toBeNull();
  });

  it("returns null for a 5xx even when the body says invalid_grant", async () => {
    mockFetchOnce({ error: "invalid_grant" }, { ok: false, status: 502 });
    const { refreshAccessToken } = await import("open-sse/services/tokenRefresh/providers.js");
    const out = await refreshAccessToken("claude", "maybe-dead", {}, console);
    expect(out).toBeNull();
  });

  it("returns null when refreshToken missing", async () => {
    const { refreshAccessToken } = await import("open-sse/services/tokenRefresh/providers.js");
    const out = await refreshAccessToken("iflow", "", {}, console);
    expect(out).toBeNull();
  });

  it("dedupes concurrent calls with same refresh token (same dedupKey)", async () => {
    const fm = mockFetchOnce({ access_token: "dd-acc", expires_in: 3600 });
    const { refreshAccessToken } = await import("open-sse/services/tokenRefresh/providers.js");
    const creds = { providerSpecificData: { deviceId: "d" } };
    await Promise.all([
      refreshAccessToken("kimi", "dup-refresh", creds, console),
      refreshAccessToken("kimi", "dup-refresh", creds, console),
    ]);
    expect(fm).toHaveBeenCalledTimes(1);
  });
});
describe("Cline refresh", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.resetModules(); global.fetch = originalFetch; });
  afterEach(() => { global.fetch = originalFetch; });

  it("uses the extension JSON refresh contract", async () => {
    const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
    const fm = mockFetchOnce({
      data: {
        accessToken: "cline-acc",
        refreshToken: "cline-rot",
        expiresAt,
      },
    });
    const { refreshTokenByProvider } = await import(
      "open-sse/services/tokenRefresh.js"
    );

    const out = await refreshTokenByProvider(
      "cline",
      { refreshToken: "cline-old" },
      console
    );

    const [, init] = fm.mock.calls[0];
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({
      refreshToken: "cline-old",
      grantType: "refresh_token",
      clientType: "extension",
    });
    expect(out.accessToken).toBe("cline-acc");
    expect(out.refreshToken).toBe("cline-rot");
    expect(out.expiresIn).toBeGreaterThan(0);
  });
});
