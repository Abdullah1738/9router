// Pure helpers for release.sh: parse router error lines, decide rollback, judge canaries.
// No dependencies, no I/O.

const ERROR_RE = /✗ ERROR (\d{3}) · (\S+) ·/;

// "[11:07:31] 🟣 ✗ ERROR 400 · claude/claude-opus-5-5 · 488ms" -> { status: 400, target: "claude/claude-opus-5-5" }
export function parseErrorLine(line) {
  const m = ERROR_RE.exec(String(line));
  if (!m) return null;
  return { status: Number(m[1]), target: m[2] };
}

// Rollback only on a burst of the same non-ignored upstream error inside the watched lines.
// 429 and 401 are normal background noise and never count.
export function rollbackVerdict(lines, { threshold = 3, ignore = [401, 429] } = {}) {
  const counts = new Map();
  for (const line of lines) {
    const parsed = parseErrorLine(line);
    if (!parsed || ignore.includes(parsed.status)) continue;
    const key = `${parsed.status} ${parsed.target}`;
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    if (count >= threshold) return { rollback: true, key, count };
  }
  return { rollback: false };
}

// "pass" = 200 with "ok" in the text, "retry" = 429, anything else "fail".
export function canaryVerdict({ status, text }) {
  if (status === 200 && /ok/i.test(String(text ?? ""))) return "pass";
  if (status === 429) return "retry";
  return "fail";
}
