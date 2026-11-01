import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-sticky-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  // Leave this isolated test data in place; it never contains real account data.
});

describe("Claude sticky SQLite storage", () => {
  it("reopens a persisted row after a restart and moves it after a quota lock", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const tracker = await import("../../open-sse/services/claudeQuotaTracker.js");
    const sticky = await import("../../src/sse/services/claudeSticky.js");
    tracker.__resetTracker();
    const opts = { available: [{ id: "account-a" }, { id: "account-b" }], sessionKey: "test-session", classifyUnavailable: () => "disabled" };
    const now = Date.now();
    const first = await sticky.selectPersistentClaudeAccount({ ...opts, now });
    const db = await getAdapter();
    const row = db.get("SELECT key,value FROM kv WHERE scope = ?", ["claudeSticky"]);
    expect(row.key).toMatch(/^claudeSticky:[a-f0-9]{64}$/);
    expect(JSON.parse(row.value)).toEqual({ connectionId: first.connection.id, lastUsedAt: now });
    db.close();
    delete global._dbAdapter;
    vi.resetModules();
    const nextTracker = await import("../../open-sse/services/claudeQuotaTracker.js");
    nextTracker.__resetTracker();
    const afterRestart = await import("../../src/sse/services/claudeSticky.js");
    await afterRestart.loadClaudeStickySessions(now + 2 * 3600_000);
    expect((await afterRestart.selectPersistentClaudeAccount({ ...opts, now: now + 2 * 3600_000 })).connection.id).toBe(first.connection.id);
    nextTracker.ingestClaudeUsage(first.connection.id, { quotas: {
      "session (5h)": { used: 100, resetAt: new Date(now + 4 * 3600_000).toISOString() },
    } });
    const moved = await afterRestart.selectPersistentClaudeAccount({ ...opts, now: now + 2 * 3600_000 });
    expect(moved.connection.id).not.toBe(first.connection.id);
    expect(moved.reason).toMatch(/^moved:quota-locked,/);
    nextTracker.__resetTracker();
  });
});
