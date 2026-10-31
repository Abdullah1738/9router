import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));

import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import { getClaudeUsage } from "../../open-sse/services/usage/claude.js";
import {
  __resetTracker,
  getAccountQuota,
  getQuotaLockUntil,
  getRejectionInfo,
  ingestClaudeUsage,
  observeClaudeHeaders,
} from "../../open-sse/services/claudeQuotaTracker.js";

const ID = "conn-lifted";
const T0 = Date.parse("2026-10-30T22:53:00Z");
const HOUR = 3600000;
const H = "anthropic-ratelimit-unified-";

// Header resets are epoch seconds; the tracker stores ms.
const sec = (ms) => String(Math.floor(ms / 1000));
const secMs = (ms) => Math.floor(ms / 1000) * 1000;

function headers(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) out[`${H}${k}`] = v;
  return out;
}

const quota = (used, resetMs) => ({
  used,
  total: 100,
  remaining: 100 - used,
  remainingPercentage: 100 - used,
  resetAt: resetMs ? new Date(resetMs).toISOString() : null,
  unlimited: false,
});

const liftedPoll = (extra = {}) => ({
  plan: "Claude Code",
  fiveHourLimit: "none",
  quotas: { "weekly (7d)": quota(30, T0 + 5 * 24 * HOUR), ...extra },
});

describe("getClaudeUsage fiveHourLimit", () => {
  afterEach(() => vi.mocked(proxyAwareFetch).mockReset());

  const respond = (data) =>
    vi.mocked(proxyAwareFetch).mockResolvedValueOnce({ ok: true, status: 200, json: async () => data });
  const seven = { utilization: 29, resets_at: "2026-11-06T13:00:00Z" };

  it("is none on an explicit five_hour: null, with no session row", async () => {
    respond({ five_hour: null, seven_day: seven, seven_day_opus: null });
    const u = await getClaudeUsage("tok-null", null, { force: true });
    expect(u.fiveHourLimit).toBe("none");
    expect(u.quotas["session (5h)"]).toBeUndefined();
    expect(u.quotas["weekly (7d)"].used).toBe(29);
  });

  it("is limited at 0% with no reset", async () => {
    respond({ five_hour: { utilization: 0, resets_at: null }, seven_day: seven });
    const u = await getClaudeUsage("tok-zero", null, { force: true });
    expect(u.fiveHourLimit).toBe("limited");
    expect(u.quotas["session (5h)"]).toMatchObject({ used: 0, resetAt: null });
  });

  it("is unknown when five_hour is missing or has no utilization", async () => {
    respond({ seven_day: seven });
    expect((await getClaudeUsage("tok-missing", null, { force: true })).fiveHourLimit).toBe("unknown");
    respond({ five_hour: { resets_at: null }, seven_day: seven });
    expect((await getClaudeUsage("tok-shape", null, { force: true })).fiveHourLimit).toBe("unknown");
  });

  it("has no fiveHourLimit when the fetch fails", async () => {
    vi.mocked(proxyAwareFetch).mockRejectedValueOnce(new Error("boom"));
    const u = await getClaudeUsage("tok-fail", null, { force: true });
    expect(u.quotas).toBeUndefined();
    expect(u.fiveHourLimit).toBeUndefined();
  });
});

describe("ingestClaudeUsage on a lifted five-hour limit", () => {
  beforeEach(() => {
    __resetTracker();
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => vi.useRealTimers());

  it("clears a stale 92% reading", () => {
    observeClaudeHeaders(ID, headers({
      "5h-utilization": "0.92", "5h-reset": sec(T0 + HOUR), "5h-status": "allowed",
      "7d-utilization": "0.28", "7d-reset": sec(T0 + 5 * 24 * HOUR), "7d-status": "allowed",
      status: "allowed", "representative-claim": "five_hour", reset: sec(T0 + HOUR),
    }));
    expect(ingestClaudeUsage(ID, liftedPoll())).toBe(true);
    const r = getAccountQuota(ID);
    expect([r.u5, r.r5, r.s5]).toEqual([null, null, null]);
    expect(r.u7).toBe(0.3);
    expect([r.claim, r.resetAt, r.status]).toEqual([null, null, "allowed"]);
  });

  it("clears a stale five_hour rejection", () => {
    observeClaudeHeaders(ID, headers({
      "5h-utilization": "1", "5h-reset": sec(T0 + 2 * HOUR), "5h-status": "rejected",
      "7d-utilization": "0.3", "7d-status": "allowed",
      status: "rejected", "representative-claim": "five_hour", reset: sec(T0 + 2 * HOUR),
    }));
    expect(getQuotaLockUntil(ID)).toBe(secMs(T0 + 2 * HOUR));
    ingestClaudeUsage(ID, liftedPoll());
    expect(getQuotaLockUntil(ID)).toBe(0);
    expect(getRejectionInfo(ID)).toEqual({ resetsAtMs: null, accountWide: false });
    expect(getAccountQuota(ID).status).toBe("allowed");
  });

  it("keeps a limited 0% window with no reset as limited", () => {
    ingestClaudeUsage(ID, {
      fiveHourLimit: "limited",
      quotas: { "session (5h)": quota(0, null), "weekly (7d)": quota(82, T0 + 24 * HOUR) },
    });
    const r = getAccountQuota(ID);
    expect([r.u5, r.r5, r.s5]).toEqual([0, null, "allowed"]);
  });

  it("leaves a limited account's 5h reading as before", () => {
    ingestClaudeUsage(ID, {
      fiveHourLimit: "limited",
      quotas: { "session (5h)": quota(40, T0 + HOUR), "weekly (7d)": quota(50, T0 + 24 * HOUR) },
    });
    const r = getAccountQuota(ID);
    expect([r.u5, r.r5, r.s5, r.status]).toEqual([0.4, T0 + HOUR, "allowed", "allowed"]);
  });

  it("clears nothing on a failed, partial or unknown poll, or absent headers", () => {
    observeClaudeHeaders(ID, headers({
      "5h-utilization": "0.92", "5h-reset": sec(T0 + HOUR), "5h-status": "allowed",
      "7d-utilization": "0.28", status: "allowed", "representative-claim": "five_hour", reset: sec(T0 + HOUR),
    }));
    const before = { u5: 0.92, r5: secMs(T0 + HOUR), s5: "allowed", claim: "five_hour" };
    const pick = () => {
      const r = getAccountQuota(ID);
      return { u5: r.u5, r5: r.r5, s5: r.s5, claim: r.claim };
    };

    expect(ingestClaudeUsage(ID, { message: "usage poll timed out" })).toBe(false);
    expect(pick()).toEqual(before);
    expect(ingestClaudeUsage(ID, { fiveHourLimit: "none", quotas: {} })).toBe(false);
    expect(pick()).toEqual(before);
    ingestClaudeUsage(ID, { fiveHourLimit: "unknown", quotas: { "weekly (7d)": quota(30, null) } });
    expect(pick()).toEqual(before);
    ingestClaudeUsage(ID, { quotas: { "weekly (7d)": quota(30, null) } });
    expect(pick()).toEqual(before);
    expect(observeClaudeHeaders(ID, {})).toBe(false);
    expect(pick()).toEqual(before);
  });

  it("keeps a weekly account rejection locked", () => {
    const r7 = T0 + 10 * HOUR;
    observeClaudeHeaders(ID, headers({
      "5h-utilization": "0.5", "5h-reset": sec(T0 + HOUR),
      "7d-utilization": "1", "7d-reset": sec(r7), "7d-status": "rejected",
      status: "rejected", "representative-claim": "seven_day", reset: sec(r7),
    }));
    ingestClaudeUsage(ID, { fiveHourLimit: "none", quotas: { "weekly (7d)": quota(100, r7) } });
    const r = getAccountQuota(ID);
    expect(r.u5).toBeNull();
    expect([r.s7, r.status, r.claim]).toEqual(["rejected", "rejected", "seven_day"]);
    expect(getQuotaLockUntil(ID)).toBe(r7);
    expect(getRejectionInfo(ID)).toEqual({ resetsAtMs: r7, accountWide: true });
  });
});

describe("ingestClaudeUsage keeps a model-scoped rejection", () => {
  const scopedReset = T0 + 3 * HOUR;
  const opusPoll = (opusUsed = 100) =>
    liftedPoll({ "weekly opus (7d)": quota(opusUsed, scopedReset) });

  beforeEach(() => {
    __resetTracker();
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    // A five-hour rejection, then a seven_day_opus rejection header that carries
    // no 5h status, so the stale rejected s5 survives into the next poll.
    observeClaudeHeaders(ID, headers({
      "5h-utilization": "1", "5h-reset": sec(T0 + 2 * HOUR), "5h-status": "rejected",
      "7d-utilization": "0.3", "7d-reset": sec(T0 + 5 * 24 * HOUR), "7d-status": "allowed",
      status: "rejected", "representative-claim": "five_hour", reset: sec(T0 + 2 * HOUR),
    }));
    observeClaudeHeaders(ID, headers({
      "7d-utilization": "0.3", status: "rejected",
      "representative-claim": "seven_day_opus", reset: sec(scopedReset),
    }));
  });
  afterEach(() => vi.useRealTimers());

  it("clears 5h fields but keeps the scoped claim, reset and rejected status", () => {
    expect(getAccountQuota(ID).s5).toBe("rejected");
    ingestClaudeUsage(ID, opusPoll());
    const r = getAccountQuota(ID);
    expect([r.u5, r.r5, r.s5]).toEqual([null, null, null]);
    expect([r.claim, r.resetAt, r.status]).toEqual(["seven_day_opus", secMs(scopedReset), "rejected"]);
    expect(getQuotaLockUntil(ID)).toBe(0);
    expect(getRejectionInfo(ID)).toEqual({ resetsAtMs: secMs(scopedReset), accountWide: false });

    ingestClaudeUsage(ID, opusPoll());
    expect(getAccountQuota(ID).status).toBe("rejected");
    expect(getRejectionInfo(ID)).toEqual({ resetsAtMs: secMs(scopedReset), accountWide: false });
  });

  it("has no rejection at or after the scoped reset", () => {
    ingestClaudeUsage(ID, opusPoll());
    const at = secMs(scopedReset);
    expect(getRejectionInfo(ID, at)).toEqual({ resetsAtMs: null, accountWide: false });
    vi.setSystemTime(at + 1000);
    ingestClaudeUsage(ID, opusPoll(0));
    expect(getAccountQuota(ID).status).toBe("allowed");
    expect(getRejectionInfo(ID)).toEqual({ resetsAtMs: null, accountWide: false });
  });

  it("does not keep a scoped claim that already expired", () => {
    observeClaudeHeaders(ID, headers({
      "7d-utilization": "0.3", status: "rejected",
      "representative-claim": "seven_day_opus", reset: sec(T0 - 60000),
    }));
    ingestClaudeUsage(ID, opusPoll());
    expect(getAccountQuota(ID).status).toBe("allowed");
    expect(getRejectionInfo(ID)).toEqual({ resetsAtMs: null, accountWide: false });
  });

  it("lets a fresh allowed header clear the kept status", () => {
    ingestClaudeUsage(ID, opusPoll());
    observeClaudeHeaders(ID, headers({ "7d-utilization": "0.31", "7d-status": "allowed", status: "allowed" }));
    expect(getRejectionInfo(ID)).toEqual({ resetsAtMs: null, accountWide: false });
    ingestClaudeUsage(ID, opusPoll());
    expect(getAccountQuota(ID).status).toBe("allowed");
  });

  it("still reports a weekly account rejection as account-wide", () => {
    const r7 = T0 + 20 * HOUR;
    ingestClaudeUsage(ID, {
      fiveHourLimit: "none",
      quotas: { "weekly (7d)": quota(100, r7), "weekly opus (7d)": quota(100, scopedReset) },
    });
    expect(getQuotaLockUntil(ID)).toBe(r7);
    expect(getRejectionInfo(ID)).toEqual({ resetsAtMs: r7, accountWide: true });
  });
});
