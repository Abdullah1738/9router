// Keeps the Claude quota tracker fresh for accounts that are not taking traffic.
// Active accounts update from response headers on every request; this polls
// the usage endpoint for the rest, faster as a reset approaches and once right
// after each reset so a freed account goes back into rotation quickly.
import "open-sse/index.js";

import { getProviderConnections, getProviderConnectionById } from "@/lib/localDb";
import { getClaudeUsage } from "open-sse/services/usage/claude.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { CLAUDE_QUOTA_ROUTING as CFG } from "open-sse/config/claudeQuotaRouting.js";
import { getAccountQuota, getNextResetMs, ingestClaudeUsage } from "open-sse/services/claudeQuotaTracker.js";

const g = (global.__claudeQuotaPoller ??= {
  interval: null,
  running: false,
  lastPollAt: {}, // connectionId -> ms
});

function proxyOptionsFrom(cfg) {
  return {
    connectionProxyEnabled: cfg?.connectionProxyEnabled === true,
    connectionProxyUrl: cfg?.connectionProxyUrl || "",
    connectionNoProxy: cfg?.connectionNoProxy || "",
    vercelRelayUrl: cfg?.vercelRelayUrl || "",
    strictProxy: false,
  };
}

// When the account should next be polled.
export function nextPollAt(connectionId, now = Date.now()) {
  const q = getAccountQuota(connectionId);
  const last = Math.max(q?.updatedAt || 0, g.lastPollAt[connectionId] || 0);
  if (!last) return now;
  let due = last + CFG.maxPollIntervalMs;
  const reset = getNextResetMs(connectionId, last);
  if (reset) due = Math.min(due, reset + CFG.postResetPollDelayMs);
  return Math.max(due, last + CFG.minPollIntervalMs);
}

function withTimeout(promise, ms) {
  let t;
  return Promise.race([
    promise,
    new Promise((resolve) => { t = setTimeout(() => resolve({ message: "usage poll timed out" }), ms); }),
  ]).finally(() => clearTimeout(t));
}

// The poller never refreshes tokens itself: OAuth refresh tokens rotate, and
// the request path / background refresh own that. An account whose token is
// about to expire is skipped until someone else has refreshed it.
export async function pollClaudeConnection(connectionId, { force = true } = {}) {
  g.lastPollAt[connectionId] = Date.now();
  const conn = await getProviderConnectionById(connectionId);
  if (!conn?.accessToken) return null;
  const exp = Date.parse(conn.expiresAt || conn.tokenExpiresAt || "");
  if (Number.isFinite(exp) && exp - Date.now() < CFG.tokenExpirySkipMs) return null;
  const proxyCfg = await resolveConnectionProxyConfig(conn.providerSpecificData || {});
  const usage = await withTimeout(
    getClaudeUsage(conn.accessToken, proxyOptionsFrom(proxyCfg), { force }),
    CFG.pollTimeoutMs,
  );
  ingestClaudeUsage(conn.id, usage);
  return usage;
}

async function tick() {
  if (g.running || globalThis.__9rDraining) return;
  g.running = true;
  try {
    const now = Date.now();
    const conns = await getProviderConnections({ provider: "claude", isActive: true });
    for (const c of conns) {
      if (c.authType !== "oauth" || !c.accessToken) continue;
      if (nextPollAt(c.id, now) > now) continue;
      try {
        await pollClaudeConnection(c.id);
      } catch (e) {
        console.log(`[ClaudeQuotaPoller] ${c.name || c.id.slice(0, 8)}: ${e.message}`);
      }
    }
  } finally {
    g.running = false;
  }
}

export function getClaudePollerState(now = Date.now()) {
  const next = {};
  for (const id of Object.keys(g.lastPollAt)) next[id] = nextPollAt(id, now);
  return { running: !!g.interval, lastPollAt: { ...g.lastPollAt }, nextPollAt: next };
}

export function startClaudeQuotaPoller() {
  if (g.interval) return;
  console.log("[ClaudeQuotaPoller] started");
  g.interval = setInterval(() => tick().catch(() => {}), CFG.pollTickMs);
  g.interval.unref?.();
  setTimeout(() => tick().catch(() => {}), CFG.firstPollDelayMs).unref?.();
}

export function stopClaudeQuotaPoller() {
  if (g.interval) clearInterval(g.interval);
  g.interval = null;
}
