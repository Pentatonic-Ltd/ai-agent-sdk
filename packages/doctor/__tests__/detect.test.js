import { detectPath, detectPaths, PATHS } from "../src/detect.js";

describe("detectPaths", () => {
  it("returns explicit override when set", () => {
    const paths = detectPaths({ path: PATHS.HOSTED, env: {} });
    expect(paths).toEqual(new Set([PATHS.HOSTED]));
  });

  it("respects PENTATONIC_DOCTOR_PATH env", () => {
    const paths = detectPaths({ env: { PENTATONIC_DOCTOR_PATH: PATHS.LOCAL } });
    expect(paths).toEqual(new Set([PATHS.LOCAL]));
  });

  it("rejects invalid override", () => {
    expect(() => detectPaths({ path: "fake", env: {} })).toThrow(/Unknown path/);
  });

  it("treats 'auto' as no override", () => {
    const paths = detectPaths({ path: "auto", env: {} });
    expect(paths).toEqual(new Set([PATHS.UNKNOWN]));
  });

  it("detects hosted from TES env vars", () => {
    const paths = detectPaths({
      env: { TES_ENDPOINT: "https://x", TES_API_KEY: "k" },
    });
    expect(paths.has(PATHS.HOSTED)).toBe(true);
  });

  it("does not detect hosted with only one TES var", () => {
    const paths = detectPaths({ env: { TES_ENDPOINT: "https://x" } });
    expect(paths.has(PATHS.HOSTED)).toBe(false);
  });

  it("detects platform from HYBRIDRAG_URL", () => {
    const paths = detectPaths({
      env: { HYBRIDRAG_URL: "http://hybridrag:8031" },
    });
    expect(paths.has(PATHS.PLATFORM)).toBe(true);
  });

  it("detects local from MEMORY_ENGINE_URL", () => {
    const paths = detectPaths({
      env: { MEMORY_ENGINE_URL: "http://localhost:8099" },
    });
    expect(paths.has(PATHS.LOCAL)).toBe(true);
  });

  it("can detect multiple paths simultaneously", () => {
    const paths = detectPaths({
      env: {
        TES_ENDPOINT: "https://x",
        TES_API_KEY: "k",
        HYBRIDRAG_URL: "http://h",
      },
    });
    expect(paths.has(PATHS.HOSTED)).toBe(true);
    expect(paths.has(PATHS.PLATFORM)).toBe(true);
  });

  it("falls back to UNKNOWN when nothing matches", () => {
    const paths = detectPaths({ env: {} });
    expect(paths).toEqual(new Set([PATHS.UNKNOWN]));
  });
});

describe("detectPath", () => {
  it("prefers platform over hosted over local", () => {
    expect(
      detectPath({
        env: {
          HYBRIDRAG_URL: "http://h",
          TES_ENDPOINT: "x",
          TES_API_KEY: "k",
        },
      })
    ).toBe(PATHS.PLATFORM);
  });

  it("prefers hosted over local", () => {
    expect(
      detectPath({
        env: {
          TES_ENDPOINT: "x",
          TES_API_KEY: "k",
          DATABASE_URL: "postgres://x",
          EMBEDDING_URL: "http://x/v1",
          LLM_URL: "http://x/v1",
        },
      })
    ).toBe(PATHS.HOSTED);
  });

  it("returns UNKNOWN with no signals", () => {
    expect(detectPath({ env: {} })).toBe(PATHS.UNKNOWN);
  });
});
