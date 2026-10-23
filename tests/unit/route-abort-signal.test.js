// Routes that rebuild the request before handing it to handleChat keep the client's
// abort signal, so a held request stops when the client goes away.
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ handleChat: vi.fn() }));

vi.mock("@/sse/handlers/chat.js", () => ({ handleChat: mocks.handleChat }));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: vi.fn(),
  isValidApiKey: vi.fn(async () => true),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
}));
vi.mock("@/lib/localDb", () => ({ getSettings: vi.fn(async () => ({ requireApiKey: false })) }));

const compact = await import("../../src/app/api/v1/responses/compact/route.js");
const gemini = await import("../../src/app/api/v1beta/models/[...path]/route.js");

const post = (url, body, signal) => new Request(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
  signal,
});

describe("rebuilt requests keep the client's abort signal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handleChat.mockResolvedValue(Response.json({ ok: true }));
  });

  it("compact", async () => {
    const controller = new AbortController();
    await compact.POST(post("http://localhost/v1/responses/compact", { model: "m", input: [] }, controller.signal));

    const forwarded = mocks.handleChat.mock.calls[0][0];
    expect(forwarded.signal.aborted).toBe(false);
    controller.abort();
    expect(forwarded.signal.aborted).toBe(true);
  });

  it("gemini generateContent", async () => {
    const controller = new AbortController();
    await gemini.POST(
      post("http://localhost/v1beta/models/gemini-2.5-pro:generateContent", { contents: [{ parts: [{ text: "hi" }] }] }, controller.signal),
      { params: Promise.resolve({ path: ["gemini-2.5-pro:generateContent"] }) },
    );

    const forwarded = mocks.handleChat.mock.calls[0][0];
    expect(forwarded.signal.aborted).toBe(false);
    controller.abort();
    expect(forwarded.signal.aborted).toBe(true);
  });
});
