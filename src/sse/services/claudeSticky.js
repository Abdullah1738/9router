import { createHash } from "node:crypto";
import { getAdapter } from "@/lib/db/driver.js";
import { CLAUDE_QUOTA_ROUTING as CFG } from "open-sse/config/claudeQuotaRouting.js";
import { getQuotaLockUntil, hydrateClaudeSessions, selectQuotaAware } from "open-sse/services/claudeQuotaTracker.js";

const SCOPE = "claudeSticky";
const PREFIX = "claudeSticky:";

function keyForSession(sessionKey) {
  return PREFIX + createHash("sha256").update(sessionKey).digest("hex");
}

function parseRecord(value, now) {
  try {
    const row = JSON.parse(value);
    if (typeof row.connectionId === "string" && row.connectionId && Number.isFinite(row.lastUsedAt)
      && now - row.lastUsedAt < CFG.stickyIdleTtlMs) return row;
  } catch {}
  return null;
}

// Hydration is for snapshots; each choice reads the durable row again to cover
// overlapping workers during a release.
export async function loadClaudeStickySessions(now = Date.now()) {
  const db = await getAdapter();
  const rows = db.all("SELECT key, value FROM kv WHERE scope = ?", [SCOPE]);
  hydrateClaudeSessions(rows.map((row) => [row.key, parseRecord(row.value, now)]), now);
}

export async function selectPersistentClaudeAccount({ available, sessionKey, classifyUnavailable, now = Date.now() }) {
  if (!sessionKey) return selectQuotaAware(available, null, now);
  const db = await getAdapter();
  const key = keyForSession(sessionKey);
  let selected;
  // BEGIN IMMEDIATE serializes the read/choose/write across the old and new
  // workers during a release. All operations inside are synchronous.
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.get("SELECT value FROM kv WHERE scope = ? AND key = ?", [SCOPE, key]);
    const sticky = row ? parseRecord(row.value, now) : null;
    const unavailableReason = sticky && getQuotaLockUntil(sticky.connectionId, now)
      ? "quota-locked"
      : sticky && !available.some((c) => c.id === sticky.connectionId)
        ? (classifyUnavailable(sticky.connectionId) || "excluded") : null;
    const usable = available.filter((c) => !getQuotaLockUntil(c.id, now));
    selected = sticky && unavailableReason && !usable.length
      ? { connection: null, reason: "all-quota-locked" }
      : selectQuotaAware(available, key, now, {
        sticky,
        preserveUnavailableSticky: Boolean(unavailableReason && !["quota-locked", "disabled"].includes(unavailableReason)),
        moveReason: unavailableReason || "quota-locked",
      });
    if (selected.connection) {
      db.run("INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value", [
        SCOPE, key, JSON.stringify({ connectionId: selected.connection.id, lastUsedAt: now }),
      ]);
      // Prune only if over budget; the scope index bounds the ordinary count.
      const count = db.get("SELECT COUNT(*) AS count FROM kv WHERE scope = ?", [SCOPE]).count;
      if (count > CFG.stickyMaxEntries) {
        db.run("DELETE FROM kv WHERE scope = ? AND key IN (SELECT key FROM kv WHERE scope = ? ORDER BY CAST(json_extract(value, '$.lastUsedAt') AS INTEGER) ASC LIMIT ?)",
          [SCOPE, SCOPE, count - CFG.stickyMaxEntries]);
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
  return selected;
}
