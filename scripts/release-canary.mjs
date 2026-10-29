#!/usr/bin/env node
// Real model call against the new build right after a switch. Exit 0 when every model passes.
// Usage: node scripts/release-canary.mjs   (env: CANARY_MODELS="claude-opus-5-5 cc/claude-haiku-5-5")
import { canaryVerdict } from "./release-lib.mjs";

const URL_ = "http://127.0.0.1:20128/v1/chat/completions";
const TIMEOUT_MS = 60_000;
const RETRY_WAIT_MS = 15_000;
const MAX_RETRIES = 2;

const body = (model) => ({
  model,
  stream: true,
  max_tokens: 16,
  messages: [
    { role: "system", content: "You are a release canary." },
    { role: "user", content: "Reply with the word OK." },
  ],
  tools: [{ type: "function", function: { name: "noop", description: "Does nothing.", parameters: { type: "object", properties: {} } } }],
});

// Collect delta text from an SSE stream; ignore [DONE] and non-JSON lines.
export function extractDeltaText(sse) {
  let text = "";
  for (const line of String(sse).split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const delta = JSON.parse(payload).choices?.[0]?.delta?.content;
      if (typeof delta === "string") text += delta;
    } catch {
      // partial or non-JSON frame: skip
    }
  }
  return text;
}

async function callOnce(model) {
  const started = Date.now();
  const res = await fetch(URL_, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body(model)),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const raw = await res.text();
  const text = extractDeltaText(raw);
  return { status: res.status, text, raw, ms: Date.now() - started };
}

export async function checkModel(model, { sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let attempt = 0;
  for (;;) {
    let result;
    try {
      result = await callOnce(model);
    } catch (err) {
      result = { status: 0, text: "", raw: String(err?.message ?? err), ms: 0 };
    }
    const verdict = canaryVerdict(result);
    if (verdict === "retry" && attempt < MAX_RETRIES) {
      attempt += 1;
      await sleep(RETRY_WAIT_MS);
      continue;
    }
    if (verdict === "retry") {
      return { model, verdict: "pass", status: result.status, ms: result.ms, warning: "still 429 after retries; treated as pass" };
    }
    return { model, verdict, status: result.status, ms: result.ms, body: verdict === "fail" ? result.raw.slice(0, 300) : undefined };
  }
}

async function main() {
  const models = (process.env.CANARY_MODELS || "claude-opus-5-5 cc/claude-haiku-5-5").split(/\s+/).filter(Boolean);
  let failed = false;
  for (const model of models) {
    const r = await checkModel(model);
    const secs = (r.ms / 1000).toFixed(1);
    if (r.verdict === "pass") {
      console.log(`canary ${model}: pass ${r.status} in ${secs}s${r.warning ? ` (warning: ${r.warning})` : ""}`);
    } else {
      failed = true;
      console.log(`canary ${model}: fail ${r.status} in ${secs}s`);
      if (r.body) console.log(`  body: ${r.body}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
