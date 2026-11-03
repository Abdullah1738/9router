// Claude thinking signature validation (ported from CLIProxyAPI internal/signature).
// E-form: single-layer base64, decoded[0] == 0x12 (Claude marker).
// R-form: double-layer base64, outer decoded[0] == 'E', inner decoded[0] == 0x12.
// Current form: protobuf version field followed by a length-delimited field 2.
// Cache prefix "...#sig" stripped before validation.

import { DEFAULT_THINKING_CLAUDE_SIGNATURE } from "../config/defaultThinkingSignature.js";

const MAX_CLAUDE_SIGNATURE_LEN = 32 * 1024 * 1024;
const CLAUDE_SIGNATURE_MARKER = 0x12;

function stripCachePrefix(rawSignature) {
  const sig = typeof rawSignature === "string" ? rawSignature.trim() : "";
  if (!sig) return "";
  const idx = sig.indexOf("#");
  return idx >= 0 ? sig.slice(idx + 1).trim() : sig;
}

export function hasClaudeSignaturePrefix(rawSignature) {
  const sig = stripCachePrefix(rawSignature);
  return sig.length > 0 && (sig[0] === "E" || sig[0] === "R" || sig[0] === "C");
}

function decodeBase64(value) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/.test(value)) return null;
  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64").replace(/=+$/, "") === value.replace(/=+$/, "") ? decoded : null;
}

function readVarint(bytes, offset) {
  let value = 0n;
  for (let i = 0; i < 10 && offset + i < bytes.length; i++) {
    const byte = bytes[offset + i];
    // A protobuf uint64 has at most one payload bit in its tenth byte.
    if (i === 9 && byte > 1) return null;
    value |= BigInt(byte & 0x7f) << BigInt(i * 7);
    if ((byte & 0x80) === 0) return { value, next: offset + i + 1 };
  }
  return null;
}

export function isValidClaudeSignature(rawSignature, { requireCompleteLegacy = false } = {}) {
  const sig = stripCachePrefix(rawSignature);
  if (!sig || sig.length > MAX_CLAUDE_SIGNATURE_LEN || sig === DEFAULT_THINKING_CLAUDE_SIGNATURE) return false;

  try {
    const decoded = decodeBase64(sig);
    if (!decoded?.length) return false;
    const validLegacy = bytes => {
      if (bytes[0] !== CLAUDE_SIGNATURE_MARKER) return false;
      if (!requireCompleteLegacy) return true;
      const length = readVarint(bytes, 1);
      return !!length && length.value > 0n && length.value <= BigInt(bytes.length - length.next);
    };
    if (sig[0] === "E") {
      return validLegacy(decoded);
    }
    if (sig[0] === "R") {
      if (decoded[0] !== 0x45) return false; // 'E'
      const innerText = decoded.toString();
      if (requireCompleteLegacy && innerText.replace(/=+$/, "") === DEFAULT_THINKING_CLAUDE_SIGNATURE.replace(/=+$/, "")) return false;
      const inner = decodeBase64(innerText);
      return !!inner?.length && validLegacy(inner);
    }
    if (decoded[0] !== 0x08) return false;
    const version = readVarint(decoded, 1);
    if (!version || decoded[version.next] !== CLAUDE_SIGNATURE_MARKER) return false;
    const length = readVarint(decoded, version.next + 1);
    return !!length && length.value > 0n && length.value <= BigInt(decoded.length - length.next);
  } catch {
    return false;
  }
}
