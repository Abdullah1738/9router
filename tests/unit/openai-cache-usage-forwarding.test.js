import { describe, it, expect } from "vitest";
import { addBufferToUsage, filterUsageForFormat } from "../../open-sse/utils/usageTracking.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

// OpenAI-compatible clients (OpenCode, AI SDK) only read cache hits from
// usage.prompt_tokens_details. Claude upstream usage must reach them there.
describe("filterUsageForFormat cache forwarding to OpenAI clients", () => {
  it("synthesizes prompt_tokens_details from Claude-shaped stream state usage", () => {
    // Shape of claude-to-openai state.usage at message_delta (prompt already folded)
    const state = {
      prompt_tokens: 12046,
      completion_tokens: 13,
      total_tokens: 12059,
      input_tokens: 10,
      output_tokens: 13,
      cache_read_input_tokens: 12036,
    };
    const out = filterUsageForFormat(addBufferToUsage(state), FORMATS.OPENAI);
    expect(out.prompt_tokens).toBe(14046);
    expect(out.prompt_tokens_details).toEqual({ cached_tokens: 12036 });
    expect(out.cache_read_input_tokens).toBeUndefined();
  });

  it("forwards cache creation tokens", () => {
    const out = filterUsageForFormat({ prompt_tokens: 500, completion_tokens: 1, cache_creation_input_tokens: 490 }, FORMATS.OPENAI);
    expect(out.prompt_tokens_details).toEqual({ cache_creation_tokens: 490 });
  });

  it("keeps existing prompt_tokens_details untouched", () => {
    const out = filterUsageForFormat({
      prompt_tokens: 100,
      completion_tokens: 1,
      cache_read_input_tokens: 999,
      prompt_tokens_details: { cached_tokens: 80 },
    }, FORMATS.OPENAI);
    expect(out.prompt_tokens_details).toEqual({ cached_tokens: 80 });
  });

  it("adds no details when there is no cache", () => {
    const out = filterUsageForFormat({ prompt_tokens: 100, completion_tokens: 1 }, FORMATS.OPENAI);
    expect(out.prompt_tokens_details).toBeUndefined();
  });

  it("leaves Claude-format clients unchanged", () => {
    const out = filterUsageForFormat({ input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 50 }, FORMATS.CLAUDE);
    expect(out).toEqual({ input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 50 });
  });
});
