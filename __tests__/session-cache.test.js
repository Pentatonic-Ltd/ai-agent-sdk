import { Session } from "../src/session.js";

const fakeConfig = {
  endpoint: "https://x.test",
  clientId: "c",
  apiKey: "k",
  captureContent: false,
};

describe("Session — cache token accumulation", () => {
  it("accumulates cache_read across rounds and exposes in totalUsage", () => {
    const s = new Session(fakeConfig);
    s.record({
      content: [{ type: "text", text: "a" }],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 1000,
      },
      model: "claude",
    });
    s.record({
      content: [{ type: "text", text: "b" }],
      usage: {
        input_tokens: 12,
        output_tokens: 6,
        cache_read_input_tokens: 800,
      },
      model: "claude",
    });
    expect(s.totalUsage.cache_read_input_tokens).toBe(1800);
    expect(s.totalUsage.prompt_tokens).toBe(22);
    expect(s.totalUsage.completion_tokens).toBe(11);
  });

  it("accumulates cache_create across rounds", () => {
    const s = new Session(fakeConfig);
    s.record({
      content: [{ type: "text", text: "a" }],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 500,
      },
    });
    expect(s.totalUsage.cache_creation_input_tokens).toBe(500);
  });

  it("omits cache fields from totalUsage when never seen", () => {
    const s = new Session(fakeConfig);
    s.record({
      choices: [{ message: { content: "a" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    expect("cache_read_input_tokens" in s.totalUsage).toBe(false);
    expect("cache_creation_input_tokens" in s.totalUsage).toBe(false);
  });

  it("total_tokens includes cache tokens", () => {
    const s = new Session(fakeConfig);
    s.record({
      content: [{ type: "text", text: "a" }],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 100,
      },
    });
    // 10 + 5 + 1000 + 100
    expect(s.totalUsage.total_tokens).toBe(1115);
  });

  it("_reset zeroes cache counters too", () => {
    const s = new Session(fakeConfig);
    s.record({
      content: [{ type: "text", text: "a" }],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 1000,
      },
    });
    s._reset();
    expect(s.totalUsage.total_tokens).toBe(0);
    expect("cache_read_input_tokens" in s.totalUsage).toBe(false);
  });
});
