import { normalizeResponse } from "../src/normalizer.js";

describe("normalizeResponse", () => {
  it("normalizes OpenAI SDK format", () => {
    const result = normalizeResponse({
      choices: [
        {
          message: {
            content: "Hello!",
            tool_calls: [
              {
                id: "call_1",
                function: { name: "search", arguments: '{"q":"shoes"}' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      model: "gpt-4o",
    });

    expect(result.content).toBe("Hello!");
    expect(result.model).toBe("gpt-4o");
    expect(result.usage.prompt_tokens).toBe(100);
    expect(result.usage.completion_tokens).toBe(50);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].tool).toBe("search");
    expect(result.toolCalls[0].args).toEqual({ q: "shoes" });
  });

  it("normalizes Workers AI format", () => {
    const result = normalizeResponse({
      response: "Hi there!",
      tool_calls: [{ name: "lookup", arguments: { id: "123" } }],
      usage: { prompt_tokens: 80, completion_tokens: 30 },
    });

    expect(result.content).toBe("Hi there!");
    expect(result.usage.prompt_tokens).toBe(80);
    expect(result.usage.completion_tokens).toBe(30);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].tool).toBe("lookup");
    expect(result.toolCalls[0].args).toEqual({ id: "123" });
  });

  it("normalizes Anthropic SDK format", () => {
    const result = normalizeResponse({
      content: [
        { type: "text", text: "Let me search." },
        {
          type: "tool_use",
          id: "tu_1",
          name: "search",
          input: { query: "shoes" },
        },
      ],
      usage: { input_tokens: 200, output_tokens: 60 },
      model: "claude-sonnet-4-6-20250514",
    });

    expect(result.content).toBe("Let me search.");
    expect(result.model).toBe("claude-sonnet-4-6-20250514");
    expect(result.usage.prompt_tokens).toBe(200);
    expect(result.usage.completion_tokens).toBe(60);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].tool).toBe("search");
    expect(result.toolCalls[0].args).toEqual({ query: "shoes" });
  });

  it("handles empty/unknown responses gracefully", () => {
    const result = normalizeResponse({});
    expect(result.content).toBe("");
    expect(result.model).toBeNull();
    expect(result.usage.prompt_tokens).toBe(0);
    expect(result.usage.completion_tokens).toBe(0);
    expect(result.toolCalls).toEqual([]);
  });

  it("handles OpenAI response with no tool calls", () => {
    const result = normalizeResponse({
      choices: [{ message: { content: "Just text." } }],
      usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
      model: "gpt-4o-mini",
    });

    expect(result.content).toBe("Just text.");
    expect(result.toolCalls).toEqual([]);
  });

  it("parses stringified tool call arguments", () => {
    const result = normalizeResponse({
      choices: [
        {
          message: {
            content: "",
            tool_calls: [
              {
                function: {
                  name: "fn",
                  arguments: '{"key":"value"}',
                },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });

    expect(result.toolCalls[0].args).toEqual({ key: "value" });
  });
});
