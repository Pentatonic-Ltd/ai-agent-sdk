import { normalizeResponse } from "../src/normalizer.js";

describe("normalizeResponse — cache token passthrough (Anthropic)", () => {
  it("passes cache_read_input_tokens through when present", () => {
    const result = normalizeResponse({
      content: [{ type: "text", text: "ok" }],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 1000,
      },
      model: "claude-3-5-sonnet-20241022",
    });
    expect(result.usage.cache_read_input_tokens).toBe(1000);
  });

  it("passes cache_creation_input_tokens through when present", () => {
    const result = normalizeResponse({
      content: [{ type: "text", text: "ok" }],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 200,
      },
    });
    expect(result.usage.cache_creation_input_tokens).toBe(200);
  });

  it("omits cache fields entirely when not present (no zero defaults)", () => {
    // Distinguishing 'no data' from '0' matters for the dashboard's
    // active-segments filter — a zero would render an empty cache band.
    const result = normalizeResponse({
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    expect("cache_read_input_tokens" in result.usage).toBe(false);
    expect("cache_creation_input_tokens" in result.usage).toBe(false);
  });

  it("does not add cache fields for OpenAI responses", () => {
    const result = normalizeResponse({
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    });
    expect("cache_read_input_tokens" in result.usage).toBe(false);
  });
});
