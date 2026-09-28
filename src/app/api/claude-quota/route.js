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
  return NextResponse.json(
    { now, accounts, sessionCount: snapshot.sessionCount },
    { headers: { "Cache-Control": "no-store" } }
  );
}
