// In-memory per-account quota state for Claude OAuth accounts, fed by the
// anthropic-ratelimit-unified-* response headers on every request and by the
// usage endpoint (poller + dashboard refresh). Also holds conversation ->
// account stickiness for the quota-aware strategy.

import { CLAUDE_QUOTA_ROUTING as CFG } from "../config/claudeQuotaRouting.js";

const state = (globalThis.__claudeQuotaTracker ??= {
  accounts: new Map(), // connectionId -> quota record
  sessions: new Map(), // sessionKey -> { connectionId, lastUsedAt }
  explored: new Map(), // connectionId -> last exploration pick ms
});

const H = "anthropic-ratelimit-unified-";

function readHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  return headers[name] ?? null;
}

function num(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Headers carry epoch seconds; tolerate ms in case that ever changes.
function epochSecToMs(v) {
  const n = num(v);
  if (n == null || n <= 0) return null;
  return n > 1e12 ? n : n * 1000;
}

// Headers carry 0-1; tolerate a percent value.
function frac(v) {
  const n = num(v);
  if (n == null) return null;
  return n > 1.5 ? n / 100 : n;
}

function record(connectionId) {
  let r = state.accounts.get(connectionId);
  if (!r) {
    r = { connectionId };
    state.accounts.set(connectionId, r);
  }
  return r;
}

// Returns true when the response carried unified rate limit headers.
export function observeClaudeHeaders(connectionId, headers) {
  if (!connectionId || !headers) return false;
  const u5 = frac(readHeader(headers, `${H}5h-utilization`));
  const u7 = frac(readHeader(headers, `${H}7d-utilization`));
  const status = readHeader(headers, `${H}status`);
  if (u5 == null && u7 == null && !status) return false;

  const r = record(connectionId);
  if (u5 != null) r.u5 = u5;
  if (u7 != null) r.u7 = u7;
  const r5 = epochSecToMs(readHeader(headers, `${H}5h-reset`));
  const r7 = epochSecToMs(readHeader(headers, `${H}7d-reset`));
  if (r5) r.r5 = r5;
  if (r7) r.r7 = r7;
  r.s5 = readHeader(headers, `${H}5h-status`) || r.s5 || null;
  r.s7 = readHeader(headers, `${H}7d-status`) || r.s7 || null;
  r.status = status || null;
  r.claim = readHeader(headers, `${H}representative-claim`) || null;
  r.resetAt = epochSecToMs(readHeader(headers, `${H}reset`));
  r.source = "headers";
  r.updatedAt = Date.now();
  r.authError = null;
  return true;
}

// usage = getClaudeUsage() result ({ quotas: { "session (5h)", "weekly (7d)" } } or { message }).
export function ingestClaudeUsage(connectionId, usage) {
  if (!connectionId || !usage) return false;
  const r = record(connectionId);
  const quotas = usage.quotas;
  if (!quotas) {
    const msg = String(usage.message || "");
    if (/401|unauthor|expired|revoked/i.test(msg)) r.authError = msg.slice(0, 200);
    r.lastPollError = msg.slice(0, 200) || "no quota data";
    r.lastPollErrorAt = Date.now();
    return false;
  }
  const s = quotas["session (5h)"];
  const w = quotas["weekly (7d)"];
  if (!s && !w) return false;
  if (s) {
    r.u5 = (Number(s.used) || 0) / 100;
    r.r5 = s.resetAt ? Date.parse(s.resetAt) || null : null;
    r.s5 = r.u5 >= 1 ? "rejected" : "allowed";
  }
  if (w) {
    r.u7 = (Number(w.used) || 0) / 100;
    r.r7 = w.resetAt ? Date.parse(w.resetAt) || null : null;
    r.s7 = r.u7 >= 1 ? "rejected" : "allowed";
  }
  r.status = r.s5 === "rejected" || r.s7 === "rejected" ? "rejected" : "allowed";
  r.source = "usage";
  r.updatedAt = Date.now();
  r.authError = null;
  r.lastPollError = null;
  return true;
}

export function getAccountQuota(connectionId) {
  return state.accounts.get(connectionId) || null;
}

// Window counts as exhausted when upstream says rejected or utilization hit 100%,
// and its reset is still in the future.
function windowLockedUntil(u, s, reset, now) {
  if (!reset || reset <= now) return 0;
  if (s === "rejected" || (u != null && u >= 1)) return reset;
  return 0;
}

// Claims that mean the whole account is out (as opposed to a model-scoped
// weekly cap, which should only lock that model).
const ACCOUNT_WIDE_CLAIMS = new Set(["five_hour", "seven_day"]);

// Epoch ms until which the whole account is out of quota, or 0 when usable.
export function getQuotaLockUntil(connectionId, now = Date.now()) {
  const r = state.accounts.get(connectionId);
  if (!r) return 0;
  let until = Math.max(
    windowLockedUntil(r.u5, r.s5, r.r5, now),
    windowLockedUntil(r.u7, r.s7, r.r7, now),
  );
  if (!until && r.status === "rejected" && r.resetAt && r.resetAt > now
    && (!r.claim || ACCOUNT_WIDE_CLAIMS.has(r.claim))) {
    until = r.resetAt;
  }
  return until;
}

// For a 429: when it resets and whether the lock should cover every model.
export function getRejectionInfo(connectionId, now = Date.now()) {
  const until = getQuotaLockUntil(connectionId, now);
  if (until) return { resetsAtMs: until, accountWide: true };
  const r = state.accounts.get(connectionId);
  if (r?.status === "rejected" && r.resetAt && r.resetAt > now) {
    return { resetsAtMs: r.resetAt, accountWide: false };
  }
  return { resetsAtMs: null, accountWide: false };
}

// Earliest future reset (5h or 7d) we know about, used by the poller.
export function getNextResetMs(connectionId, now = Date.now()) {
  const r = state.accounts.get(connectionId);
  if (!r) return null;
  const future = [r.r5, r.r7].filter((t) => t && t > now);
  return future.length ? Math.min(...future) : null;
}

// Pick a stable conversation key from OpenCode / Claude Code / generic clients.
export function getSessionKey(headers, body) {
  const h = headers || {};
  const pick = (k) => {
    const v = typeof h.get === "function" ? h.get(k) : h[k];
    return typeof v === "string" && v.trim() && v.length <= 256 ? v.trim() : null;
  };
  const fromHeader =
    pick("x-opencode-session") ||
    pick("x-session-affinity") ||
    pick("x-claude-code-session-id") ||
    pick("x-session-id") ||
    pick("session-id") ||
    pick("session_id");
  if (fromHeader) return fromHeader;
  const b = body || {};
  // metadata.user_id is often a constant per client; only use it when it
  // carries a session (Claude Code style "..._session_<uuid>").
  const userId = typeof b.metadata?.user_id === "string" && b.metadata.user_id.includes("_session_")
    ? b.metadata.user_id : null;
  for (const v of [b.prompt_cache_key, b.session_id, b.conversation_id, userId]) {
    if (typeof v === "string" && v.trim() && v.length <= 256) return v.trim();
  }
  return null;
}

function hoursUntil(ts, now) {
  return Math.max((ts - now) / 3600000, CFG.minHoursToWeeklyReset);
}

const WEEK_HOURS = 168;

// Weekly headroom per hour until that account's weekly reset. Accounts whose
// unused quota expires soonest score highest. Unknown accounts score -1.
// No reset time (no window running) or a reset already past both mean a fresh
// week: the full remaining headroom spread over a whole week.
export function scoreAccount(connectionId, now = Date.now()) {
  const r = state.accounts.get(connectionId);
  if (!r || r.u7 == null) return -1;
  if (!r.r7) return Math.max(0, 1 - r.u7) / WEEK_HOURS;
  if (r.r7 <= now) return 1 / WEEK_HOURS;
  return Math.max(0, 1 - r.u7) / hoursUntil(r.r7, now);
}

function fiveHourOk(connectionId, now) {
  const r = state.accounts.get(connectionId);
  if (!r || r.u5 == null) return true;
  if (r.r5 && r.r5 <= now) return true; // window already rolled over
  return r.u5 < CFG.newSession5hMax;
}

function pruneSessions(now) {
  if (state.sessions.size <= CFG.stickyMaxEntries) return;
  for (const [k, v] of state.sessions) {
    if (now - v.lastUsedAt > CFG.stickyIdleTtlMs) state.sessions.delete(k);
  }
  while (state.sessions.size > CFG.stickyMaxEntries) {
    state.sessions.delete(state.sessions.keys().next().value);
  }
}

/**
 * Choose a connection from `available` (already filtered for DB locks/excludes,
 * sorted by priority). Returns { connection, reason }.
 */
export function selectQuotaAware(available, sessionKey, now = Date.now()) {
  if (!available?.length) return { connection: null, reason: "none" };
  const usable = available.filter((c) => !getQuotaLockUntil(c.id, now));
  const pool0 = usable.length ? usable : available;
  const eligible = pool0.filter((c) => fiveHourOk(c.id, now));

  if (sessionKey) {
    const sticky = state.sessions.get(sessionKey);
    if (sticky && now - sticky.lastUsedAt < CFG.stickyIdleTtlMs) {
      const conn = usable.find((c) => c.id === sticky.connectionId);
      // Stay unless the account is past the 5h threshold and somewhere else has room.
      if (conn && (fiveHourOk(conn.id, now) || eligible.length === 0)) {
        sticky.lastUsedAt = now;
        return { connection: conn, reason: "sticky" };
      }
    }
  }

  const pool = eligible.length ? eligible : pool0;

  let best = null;
  let bestScore = -Infinity;
  let bestU5 = Infinity;
  let reasonOverride = null;
  // Learn unknown accounts: one new conversation gives us full quota headers.
  const unknown = pool.find((c) => {
    const r = state.accounts.get(c.id);
    return (!r || r.u7 == null) && now - (state.explored.get(c.id) || 0) > CFG.exploreIntervalMs;
  });
  if (unknown) {
    state.explored.set(unknown.id, now);
    best = unknown;
    reasonOverride = "explore";
  }
  for (const c of unknown ? [] : pool) {
    const score = scoreAccount(c.id, now);
    const u5 = state.accounts.get(c.id)?.u5 ?? 0;
    if (score > bestScore || (score === bestScore && u5 < bestU5)) {
      best = c;
      bestScore = score;
      bestU5 = u5;
    }
  }

  if (sessionKey && best) {
    state.sessions.delete(sessionKey);
    state.sessions.set(sessionKey, { connectionId: best.id, lastUsedAt: now });
    pruneSessions(now);
  }
  const reason = reasonOverride || (usable.length ? (eligible.length ? "score" : "all-over-5h") : "all-quota-locked");
  return { connection: best, reason, score: bestScore };
}

export function getTrackerSnapshot(now = Date.now()) {
  const accounts = [...state.accounts.values()].map((r) => ({
    ...r,
    lockUntil: getQuotaLockUntil(r.connectionId, now) || null,
    score: scoreAccount(r.connectionId, now),
  }));
  const perAccount = {};
  for (const v of state.sessions.values()) {
    if (now - v.lastUsedAt < CFG.stickyIdleTtlMs) perAccount[v.connectionId] = (perAccount[v.connectionId] || 0) + 1;
  }
  return { accounts, activeSessionsPerAccount: perAccount, sessionCount: state.sessions.size };
}

// Test helper
export function __resetTracker() {
  state.accounts.clear();
  state.sessions.clear();
  state.explored.clear();
}
