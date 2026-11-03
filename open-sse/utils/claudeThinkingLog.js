const REASONS = new Set(["prefix_binding_mismatch", "model_binding_mismatch", "organization_binding_mismatch"]);

// Never interpolate upstream-provided strings: unknown reasons may contain
// arbitrary request content or secrets.
export function observeClaudeTransformations(body, log, reqTag) {
  try {
    const entries = body?.type === "message_start" ? body.message?.input_transformations : body?.input_transformations;
    if (!Array.isArray(entries) || !entries.length) return;
    const dropped = entries.filter((entry) => entry?.type === "thinking_dropped");
    if (!dropped.length) return;
    const counts = new Map();
    for (const entry of dropped) {
      const reason = REASONS.has(entry.reason) ? entry.reason : "other";
      counts.set(reason, (counts.get(reason) || 0) + 1);
    }
    const reasons = [...counts].map(([reason, count]) => `${reason}:${count}`).join(",");
    log?.line?.(reqTag, "⚙", `THINKING dropped=${dropped.length} reasons=${reasons}`);
  } catch { /* observation must never break the request */ }
}

// Observe only event metadata before SSE-to-JSON conversion discards it. SSE data
// fields may span lines and the final event need not have a terminating blank line.
export function observeClaudeSSETransformations(rawSSE, log, reqTag) {
  let data = [];
  const observeEvent = () => {
    if (!data.length) return;
    try {
      const event = JSON.parse(data.join("\n"));
      if (event?.type === "message_start" || event?.type === "message_delta") {
        observeClaudeTransformations(event, log, reqTag);
      }
    } catch { /* ignore malformed SSE data */ }
    data = [];
  };
  for (const line of rawSSE.split(/\r\n|\r|\n/)) {
    if (!line) observeEvent();
    else if (line === "data" || line.startsWith("data:")) {
      data.push(line === "data" ? "" : line.slice(5).replace(/^ /, ""));
    }
  }
  observeEvent();
}
