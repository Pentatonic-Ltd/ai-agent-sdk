const { webcrypto } = require("crypto");

if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
}

// Disable SDK telemetry in tests
process.env.PENTATONIC_TELEMETRY = "0";
