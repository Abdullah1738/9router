#!/usr/bin/env node
// Watch the router log for N minutes from a byte offset; exit 3 on a burst of the same upstream error.
// Usage: node scripts/release-watch.mjs --log <path> --offset <bytes> --minutes <n>
import { openSync, readSync, closeSync, statSync } from "node:fs";
import { rollbackVerdict } from "./release-lib.mjs";

const POLL_MS = 5_000;

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

// Read only bytes appended after `from`; returns the new offset and complete lines.
export function readNew(path, from) {
  let size;
  try {
    size = statSync(path).size;
  } catch {
    return { offset: from, lines: [] };
  }
  if (size <= from) return { offset: size < from ? size : from, lines: [] };
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(size - from);
    readSync(fd, buf, 0, buf.length, from);
    return { offset: size, lines: buf.toString("utf8").split("\n") };
  } finally {
    closeSync(fd);
  }
}

export async function watch({ log, offset, minutes, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now }) {
  let pos = offset;
  const end = now() + minutes * 60_000;
  const seen = [];
  while (now() < end) {
    await sleep(POLL_MS);
    const r = readNew(log, pos);
    pos = r.offset;
    seen.push(...r.lines);
    const v = rollbackVerdict(seen);
    if (v.rollback) return { code: 3, reason: `${v.count}x ${v.key} in the log` };
  }
  return { code: 0 };
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
  else console.log(`watched ${minutes} min, no error burst`);
  process.exit(r.code);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
