import { NextResponse } from "next/server";
import { getProviderConnections } from "@/lib/localDb";
import { getTrackerSnapshot } from "open-sse/services/claudeQuotaTracker.js";
import { getClaudePollerState } from "@/shared/services/claudeQuotaPoller";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Snapshot of the quota-aware Claude router: per-account 5h/7d state, score,
// lock and sticky session counts. Protected by the dashboard guard (/api/*).
export async function GET() {
  const now = Date.now();
  const connections = await getProviderConnections({ provider: "claude" });
  const names = Object.fromEntries(connections.map((c) => [c.id, c.name || c.email || c.id]));
  const snapshot = getTrackerSnapshot(now);
  const poller = getClaudePollerState();
  const accounts = snapshot.accounts.map((a) => ({
    ...a,
    name: names[a.connectionId] || a.connectionId,
    activeSessions: snapshot.activeSessionsPerAccount?.[a.connectionId] || 0,
    nextPollAt: poller.nextPollAt?.[a.connectionId] || null,
  }));
  // Accounts whose refresh token was rejected: out of rotation until someone
  // logs them in again from the provider page.
  const needsRelogin = connections
    .filter((c) => c.isActive !== false && c.reauthRequiredAt)
    .map((c) => ({ connectionId: c.id, name: names[c.id], since: c.reauthRequiredAt }));
  return NextResponse.json(
    { now, accounts, sessionCount: snapshot.sessionCount, needsRelogin },
    { headers: { "Cache-Control": "no-store" } }
  );
}
