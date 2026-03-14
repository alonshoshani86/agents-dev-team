/**
 * Unit tests for routes/config.ts utilities
 * Tests: maskKey, findNpx (with filesystem mocking via env)
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { maskKey, findNpx } from "../routes/config.js";

// ─── maskKey ─────────────────────────────────────────────────────────────────

describe("maskKey", () => {
  it("returns empty string for empty input", () => {
    assert.equal(maskKey(""), "");
  });

  it("returns *** for short keys (≤12 chars)", () => {
    assert.equal(maskKey("short"), "***");
    assert.equal(maskKey("12charexact!"), "***");
  });

  it("masks long keys with first-8 + ... + last-4 pattern", () => {
    const key = "sk-ant-api01-ABCDEFGHIJ1234";
    const result = maskKey(key);
    assert.ok(result.includes("..."), "should contain ellipsis");
    assert.ok(result.startsWith("sk-ant-a"), "should start with first 8 chars");
    assert.ok(result.endsWith("1234"), "should end with last 4 chars");
  });

  it("masks a 13-character key (just over the 12-char threshold)", () => {
    const key = "1234567890abc"; // 13 chars
    const result = maskKey(key);
    assert.equal(result, "12345678...0abc");
  });

  it("does not expose the full key for very long keys", () => {
    const key = "sk-ant-api01-" + "x".repeat(50);
    const result = maskKey(key);
    assert.ok(result.length < key.length, "masked version must be shorter than original");
    assert.ok(!result.includes("x".repeat(10)), "should not contain long run of real key chars");
  });

  it("masks a realistic Anthropic API key", () => {
    const key = "sk-ant-api01-ABCDEFGHIJKLMNOP1234";
    const result = maskKey(key);
    assert.equal(result, "sk-ant-a...1234");
  });
});

// ─── findNpx ──────────────────────────────────────────────────────────────────
//
// findNpx() tries hardcoded paths with accessSync first, then falls back to
// `which npx` via execFileSync. We test the function's contract (returns a
// non-empty string or null) without mocking the filesystem, since the actual
// result depends on the host machine's environment.

describe("findNpx", () => {
  it("returns a string or null — never throws", () => {
    let result: string | null;
    assert.doesNotThrow(() => {
      result = findNpx();
    });
    // @ts-expect-error — assigned inside doesNotThrow
    assert.ok(result === null || typeof result === "string");
  });

  it("if a path is returned, it is a non-empty string", () => {
    const result = findNpx();
    if (result !== null) {
      assert.ok(result.length > 0, "returned path must be non-empty");
      assert.ok(result.includes("npx"), "returned path must contain 'npx'");
    }
  });

  it("returns consistent results across consecutive calls", () => {
    const first = findNpx();
    const second = findNpx();
    assert.equal(first, second, "findNpx must be deterministic within a session");
  });
});

// ─── maskKey edge cases ───────────────────────────────────────────────────────

describe("maskKey — edge cases", () => {
  it("handles exactly 13 chars (first above threshold)", () => {
    // 13 chars → length > 12 → masked
    const key = "abcdefghijklm"; // 13 chars
    const result = maskKey(key);
    assert.ok(result.includes("..."));
  });

  it("handles exactly 12 chars (at threshold → not masked, returns ***)", () => {
    const key = "abcdefghijkl"; // 12 chars
    assert.equal(maskKey(key), "***");
  });

  it("handles a single character", () => {
    assert.equal(maskKey("x"), "***");
  });

  it("handles unicode characters in key", () => {
    // Shouldn't throw; any string is valid
    const key = "sk-ant-🔑".padEnd(20, "x");
    const result = maskKey(key);
    assert.ok(typeof result === "string");
  });
});
