export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initConsoleLogCapture } = await import("@/lib/consoleLogBuffer");
    initConsoleLogCapture();

    // Server-only: lets capabilities.js read the synced catalog without pulling
    // node:fs into the dashboard's browser bundle.
    const { installCatalogSource } = await import("open-sse/providers/catalogOverride.js");
    await installCatalogSource();

    const { startModelCatalogSync } = await import("@/lib/modelCatalog/sync.js");
    startModelCatalogSync();

    // Quota-aware Claude routing needs fresh quota state even when no
    // dashboard page has been opened (initializeApp runs from the layout).
    import("@/shared/services/claudeQuotaPoller")
      .then(({ startClaudeQuotaPoller }) => startClaudeQuotaPoller())
      .catch((e) => console.log("[ClaudeQuotaPoller] start failed:", e.message));
  }
}
