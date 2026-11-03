import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModelInfoCore } from "../../open-sse/services/model.js";
import codexImageAdapter from "../../open-sse/handlers/imageProviders/codex.js";
import { normalizeNativeCodexImageRequest } from "../../open-sse/utils/codexImageRequest.js";

const mocks = vi.hoisted(() => ({
  core: vi.fn(),
  keyAccess: vi.fn(),
  credentials: vi.fn(),
  comboModels: null,
}));

vi.mock("../../src/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.credentials,
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
  extractApiKey: () => "client-key",
  isValidApiKey: vi.fn(),
}));
vi.mock("@/lib/localDb", () => ({ getSettings: async () => ({ requireApiKey: false }) }));
vi.mock("../../src/sse/services/model.js", async () => {
  const { getModelInfoCore } = await import("../../open-sse/services/model.js");
  return { getModelInfo: getModelInfoCore, getComboModels: async () => mocks.comboModels };
});
vi.mock("../../src/sse/services/keyAccess.js", () => ({
  getKeyAccessContext: vi.fn(),
  enforceKeyAccess: mocks.keyAccess,
}));
vi.mock("../../open-sse/handlers/imageGenerationCore.js", () => ({ handleImageGenerationCore: mocks.core }));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  updateProviderCredentials: vi.fn(),
  checkAndRefreshToken: async (_provider, credentials) => credentials,
  storedTokensIfStale: vi.fn(),
}));
vi.mock("../../src/sse/utils/logger.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: vi.fn() }));

import { POST, OPTIONS } from "../../src/app/api/v1/images/edits/route.js";

const ref = "data:image/png;base64,AA==";
const normalize = (body, headers = {}, endpoint = "/v1/images/generations") =>
  normalizeNativeCodexImageRequest({ endpoint, headers: new Headers(headers), body });

describe("Codex image request normalization", () => {
  it.each([
    [{ "x-codex-image-turn-id": "turn" }, "gpt-image-2", "cx/gpt-image-2"],
    [{ "user-agent": "codex_cli_rs/0.166.0" }, "gpt-image-2", "cx/gpt-image-2"],
    [{ "user-agent": "curl/8" }, "gpt-image-2", "gpt-image-2"],
    [{ "x-codex-image-turn-id": "turn" }, "openai/gpt-image-2", "openai/gpt-image-2"],
    [{ "x-codex-image-turn-id": "turn" }, "gpt-6-sol-image", "gpt-6-sol-image"],
    [{ "x-codex-image-turn-id": "  " }, "gpt-image-2", "gpt-image-2"],
  ])("routes only native unprefixed tool models (%j, %s)", (headers, model, expected) => {
    const body = { model, prompt: "draw" };
    expect(normalize(body, headers).body.model).toBe(expected);
    expect(body.model).toBe(model);
  });

  it("normalizes supported image references for any client", () => {
    expect(normalize({ images: [{ image_url: ref }, ref] }, {}, "/v1/images/edits").body.images).toEqual([ref, ref]);
  });
  it.each([{ file_id: "file-1" }, { file_id: "file-1", image_url: ref }])("rejects file_id references", (image) => {
    expect(normalize({ images: [image] }, {}, "/v1/images/edits")).toEqual({
      status: 400, error: "file_id image references are not supported; send image_url data URLs",
    });
  });
  it.each([undefined, [], "not-an-array"])("requires a non-empty images array", (images) => {
    expect(normalize({ images }, {}, "/v1/images/edits")).toEqual({ status: 400, error: "images is required" });
  });
  it.each([null, {}, { image_url: 1 }, 123, "", "  ", { image_url: "" }])("rejects malformed references", (image) => {
    expect(normalize({ images: [image] }, {}, "/v1/images/edits")).toMatchObject({ status: 400 });
  });
  it.each([null, [], "text", 1, true])("requires an object body", (body) => {
    expect(normalize(body)).toEqual({ status: 400, error: "JSON body must be an object" });
  });
  it("resolves the Codex image model", async () => {
    expect(await getModelInfoCore("cx/gpt-image-2")).toEqual({ provider: "codex", model: "gpt-image-2" });
    expect(await getModelInfoCore("gpt-image-2")).toMatchObject({ provider: "openai" });
  });
});

describe("edits route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.credentials.mockResolvedValue({ connectionId: "conn", accessToken: "test" });
    mocks.comboModels = null;
    mocks.keyAccess.mockResolvedValue(null);
    mocks.core.mockResolvedValue({ success: true, response: Response.json({ data: [] }) });
  });
  it("normalizes before access checks and reaches the Codex adapter with string refs", async () => {
    const response = await POST(new Request("http://localhost/v1/images/edits", {
      method: "POST",
      headers: { "x-codex-image-turn-id": "turn", "x-openai-actor-authorization": "placeholder" },
      body: JSON.stringify({ model: "gpt-image-2", prompt: "edit", images: [{ image_url: ref }, ref] }),
    }));
    expect(response.status).toBe(200);
    expect(mocks.keyAccess).toHaveBeenCalledWith(undefined, "cx/gpt-image-2");
    expect(mocks.core).toHaveBeenCalledWith(expect.objectContaining({
      modelInfo: { provider: "codex", model: "gpt-image-2" },
      body: { model: "cx/gpt-image-2", prompt: "edit", images: [ref, ref] },
    }));
  });
  it("denies the normalized model before looking up credentials", async () => {
    mocks.keyAccess.mockResolvedValue(new Response(null, { status: 403 }));
    const response = await POST(new Request("http://localhost/v1/images/edits", {
      method: "POST", headers: { "user-agent": "codex_cli_rs/0.166.0" },
      body: JSON.stringify({ model: "gpt-image-2", prompt: "edit", images: [ref] }),
    }));
    expect(response.status).toBe(403);
    expect(mocks.keyAccess).toHaveBeenCalledWith(undefined, "cx/gpt-image-2");
    expect(mocks.credentials).not.toHaveBeenCalled();
  });
  it("rejects invalid JSON values without calling the provider", async () => {
    const response = await POST(new Request("http://localhost/v1/images/edits", { method: "POST", body: "null" }));
    expect(response.status).toBe(400);
    expect(mocks.credentials).not.toHaveBeenCalled();
  });
  it("does not silently send an OpenAI edit as a generation", async () => {
    const response = await POST(new Request("http://localhost/v1/images/edits", {
      method: "POST", body: JSON.stringify({ model: "openai/gpt-image-2", prompt: "edit", images: [ref] }),
    }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toContain("does not support image edits");
    expect(mocks.credentials).not.toHaveBeenCalled();
    expect(mocks.core).not.toHaveBeenCalled();
  });
  it.each([
    ["text/event-stream", 'event: done\ndata: {"data":[{"b64_json":"AA=="}]}\n\n'],
    ["application/json", JSON.stringify({ created: 1, data: [{ b64_json: "AA==" }] })],
  ])("returns the first successful image combo response without chat peeking (%s)", async (contentType, payload) => {
    mocks.comboModels = ["cx/gpt-image-2", "openai/gpt-image-2"];
    mocks.core.mockResolvedValue({
      success: true,
      response: new Response(payload, { headers: { "Content-Type": contentType } }),
    });
    const response = await POST(new Request("http://localhost/v1/images/edits", {
      method: "POST", headers: { accept: contentType },
      body: JSON.stringify({ model: "image-combo", prompt: "edit", images: [ref] }),
    }));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(payload);
    expect(mocks.core).toHaveBeenCalledTimes(1);
    expect(mocks.core.mock.calls[0][0].modelInfo).toEqual({ provider: "codex", model: "gpt-image-2" });
  });
  it("exposes POST and OPTIONS", async () => {
    expect((await OPTIONS()).headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
  });
});

describe("Codex image adapter", () => {
  it("does not send the client's actor authorization header upstream", () => {
    expect(codexImageAdapter.buildHeaders({ accessToken: "test" })).not.toHaveProperty("x-openai-actor-authorization");
  });
  it("uses the edit action with references", () => {
    expect(codexImageAdapter.buildBody("gpt-image-2", { prompt: "edit", images: [ref] }).tools[0])
      .toMatchObject({ action: "edit", model: "gpt-image-2" });
  });
});
