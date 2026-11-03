import { CODEX_TOOL_IMAGE_MODELS } from "../handlers/imageProviders/codex.js";
import { detectClientTool } from "./clientDetector.js";

export function normalizeNativeCodexImageRequest({ endpoint, headers, body }) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { status: 400, error: "JSON body must be an object" };
  }
  const native = Boolean(headers.get("x-codex-image-turn-id")?.trim()) ||
    detectClientTool(Object.fromEntries(headers.entries()), body) === "codex";
  const normalized = { ...body };

  if (native && typeof normalized.model === "string" && !normalized.model.includes("/") &&
      CODEX_TOOL_IMAGE_MODELS.has(normalized.model)) {
    normalized.model = `cx/${normalized.model}`;
  }

  if (endpoint.endsWith("/images/edits")) {
    if (!Array.isArray(normalized.images) || normalized.images.length === 0) {
      return { status: 400, error: "images is required" };
    }
    const images = [];
    for (const image of normalized.images) {
      if (image && typeof image === "object" && "file_id" in image) {
        return { status: 400, error: "file_id image references are not supported; send image_url data URLs" };
      }
      if (typeof image === "string" && image.trim()) images.push(image);
      else if (image && typeof image.image_url === "string" && image.image_url.trim()) images.push(image.image_url);
      else return { status: 400, error: "images must contain strings or image_url references" };
    }
    normalized.images = images;
  }

  return { body: normalized };
}
