// Release guard: parse router error lines, decide rollback on a burst, judge the canary.
import { describe, expect, it } from "vitest";
import { parseErrorLine, rollbackVerdict, canaryVerdict } from "../../scripts/release-lib.mjs";

const ERR_400 = "[11:07:31] 🟣 ✗ ERROR 400 · claude/claude-opus-5-5 · 488ms";
const NORMAL = "[02:27:07] 🔵 ▶ POST cc/claude-haiku-5-5 → claude/claude-haiku-5-5 · FMT: openai→claude";
const ERR_429 = "[03:10:00] 🟣 ✗ ERROR 429 · claude/claude-opus-5-5 · 120ms";
const ERR_401 = "[03:10:01] 🟣 ✗ ERROR 401 · claude/claude-opus-5-5 · 90ms";

describe("parseErrorLine", () => {
  it("reads status and target from an error line", () => {
    expect(parseErrorLine(ERR_400)).toEqual({ status: 400, target: "claude/claude-opus-5-5" });
  });

  it("returns null for a normal request line", () => {
    expect(parseErrorLine(NORMAL)).toBeNull();
  });
});

describe("rollbackVerdict", () => {
  it("rolls back on three identical 400s and names the key", () => {
    const v = rollbackVerdict([ERR_400, ERR_400, ERR_400]);
    expect(v).toEqual({ rollback: true, key: "400 claude/claude-opus-5-5", count: 3 });
  });

  it("does not roll back on two 400s plus many 429 and 401 lines", () => {
    const lines = [ERR_400, ERR_429, ERR_401, ERR_429, ERR_401, ERR_429, ERR_400, ERR_429, ERR_401, ERR_429];
    expect(rollbackVerdict(lines).rollback).toBe(false);
  });

  it("does not roll back when three errors hit different targets", () => {
    const lines = [
      "[1] ✗ ERROR 400 · claude/claude-opus-5-5 · 1ms",
      "[2] ✗ ERROR 400 · claude/claude-haiku-5-5 · 1ms",
      "[3] ✗ ERROR 400 · codex/gpt-6 · 1ms",
    ];
    expect(rollbackVerdict(lines).rollback).toBe(false);
  });

  it("ignores normal request lines", () => {
    expect(rollbackVerdict([NORMAL, NORMAL, NORMAL]).rollback).toBe(false);
  });
});

describe("canaryVerdict", () => {
  it("passes a 200 whose text says OK, in any case", () => {
    expect(canaryVerdict({ status: 200, text: "OK" })).toBe("pass");
    expect(canaryVerdict({ status: 200, text: "ok." })).toBe("pass");
  });

  it("fails a 200 with empty text", () => {
    expect(canaryVerdict({ status: 200, text: "" })).toBe("fail");
  });

  it("asks for a retry on 429", () => {
    expect(canaryVerdict({ status: 429, text: "" })).toBe("retry");
  });

  it("fails a 400", () => {
    expect(canaryVerdict({ status: 400, text: "Third-party apps now draw from extra usage" })).toBe("fail");
  });
});
