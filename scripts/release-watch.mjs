#!/usr/bin/env node
// Watch the router log for N minutes from a byte offset; exit 3 on a burst of the same upstream error.
// Exit 4 when the log cannot be read: an unmonitored release is not a healthy one.
// Usage: node scripts/release-watch.mjs --log <path> --offset <bytes> --minutes <n>
import { openSync, readSync, closeSync, statSync } from "node:fs";
import { rollbackVerdict } from "./release-lib.mjs";

const POLL_MS = 5_000;

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

// Read bytes appended after `from`. A shrunken file was truncated or rotated: restart at byte 0.
// `pending` is the trailing partial line from the previous read, kept until its newline arrives.
// Throws when the log cannot be stat'ed or read.
export function readNew(path, from, pending = "") {
  const size = statSync(path).size;
  const start = size < from ? 0 : from;
  const carry = size < from ? "" : pending;
  if (size === start) return { offset: start, lines: [], pending: carry };
  const fd = openSync(path, "r");
  let text;
  try {
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    text = carry + buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
  const parts = text.split("\n");
  const rest = parts.pop();
  return { offset: size, lines: parts, pending: rest };
}

export async function watch({
  log,
  offset,
  minutes,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
}) {
  let pos = offset;
  let pending = "";
  const end = now() + minutes * 60_000;
  const seen = [];
  for (;;) {
    let r;
    try {
      r = readNew(log, pos, pending);
    } catch (err) {
      return { code: 4, reason: `cannot read ${log}: ${err.code ?? err.message}` };
    }
    pos = r.offset;
    pending = r.pending;
    seen.push(...r.lines);
    const v = rollbackVerdict(seen);
    if (v.rollback) return { code: 3, reason: `${v.count}x ${v.key} in the log` };
    if (now() >= end) return { code: 0 };
    await sleep(POLL_MS);
  }
}

async function main() {
  const log = arg("log");
  const offset = Number(arg("offset") ?? 0);
  const minutes = Number(arg("minutes") ?? 5);
  if (!log) {
    console.error("usage: release-watch.mjs --log <path> --offset <bytes> --minutes <n>");
    process.exit(2);
  }
  const r = await watch({ log, offset, minutes });
  if (r.code === 3) console.log(`rollback: ${r.reason}`);
  else if (r.code === 4) console.log(`watch failed: ${r.reason}`);
  else console.log(`watched ${minutes} min, no error burst`);
  process.exit(r.code);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
