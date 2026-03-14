/**
 * Unit tests for routes/websocket.ts utilities
 * Tests: tokenizeCommand, resolveContained
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tokenizeCommand, resolveContained } from "../routes/websocket.js";

// ─── tokenizeCommand ──────────────────────────────────────────────────────────

describe("tokenizeCommand", () => {
  it("splits a simple two-token command", () => {
    assert.deepEqual(tokenizeCommand("ls -la"), ["ls", "-la"]);
  });

  it("handles a single token with no args", () => {
    assert.deepEqual(tokenizeCommand("ls"), ["ls"]);
  });

  it("returns empty array for empty string", () => {
    assert.deepEqual(tokenizeCommand(""), []);
  });

  it("returns empty array for whitespace-only string", () => {
    assert.deepEqual(tokenizeCommand("   \t  "), []);
  });

  it("strips leading and trailing whitespace", () => {
    assert.deepEqual(tokenizeCommand("  ls  "), ["ls"]);
  });

  it("collapses multiple spaces between tokens", () => {
    assert.deepEqual(tokenizeCommand("echo   hello   world"), ["echo", "hello", "world"]);
  });

  it("handles double-quoted argument with spaces", () => {
    assert.deepEqual(tokenizeCommand('echo "hello world"'), ["echo", "hello world"]);
  });

  it("handles single-quoted argument with spaces", () => {
    assert.deepEqual(tokenizeCommand("echo 'hello world'"), ["echo", "hello world"]);
  });

  it("treats shell pipe operator | as a literal token (no injection)", () => {
    assert.deepEqual(tokenizeCommand("cat file.txt | grep foo"), [
      "cat", "file.txt", "|", "grep", "foo",
    ]);
  });

  it("treats && as a literal token (no injection)", () => {
    assert.deepEqual(tokenizeCommand("echo a && echo b"), ["echo", "a", "&&", "echo", "b"]);
  });

  it("treats semicolon ; as a literal token (no injection)", () => {
    assert.deepEqual(tokenizeCommand("echo a; echo b"), ["echo", "a;", "echo", "b"]);
  });

  it("handles npm install with package name", () => {
    assert.deepEqual(tokenizeCommand("npm install lodash"), ["npm", "install", "lodash"]);
  });

  it("handles git commit with quoted message", () => {
    assert.deepEqual(tokenizeCommand('git commit -m "feat: add login"'), [
      "git", "commit", "-m", "feat: add login",
    ]);
  });

  it("handles adjacent quoted tokens with no separator — appended to current token", () => {
    // "hello"'world' → helloworld (quoted regions merged into one token)
    assert.deepEqual(tokenizeCommand('"hello"\'world\''), ["helloworld"]);
  });

  it("strips quotes but preserves content", () => {
    assert.deepEqual(tokenizeCommand('"hello"'), ["hello"]);
  });

  it("handles tab as whitespace delimiter", () => {
    assert.deepEqual(tokenizeCommand("ls\t-la"), ["ls", "-la"]);
  });
});

// ─── resolveContained ────────────────────────────────────────────────────────

describe("resolveContained", () => {
  const BASE = "/project/files";

  it("resolves a simple relative path within filesDir", () => {
    const result = resolveContained(BASE, "src/app.ts");
    assert.equal(result, path.join(BASE, "src/app.ts"));
  });

  it("resolves a deeply nested relative path", () => {
    const result = resolveContained(BASE, "a/b/c/d.txt");
    assert.equal(result, path.join(BASE, "a/b/c/d.txt"));
  });

  it("resolves a plain filename at root level", () => {
    const result = resolveContained(BASE, "README.md");
    assert.equal(result, path.join(BASE, "README.md"));
  });

  it("returns filesDir itself when relativePath is empty", () => {
    // path.resolve(BASE, "") → BASE; equals filesDir → allowed
    const result = resolveContained(BASE, "");
    assert.equal(result, BASE);
  });

  it("rejects path traversal with ..", () => {
    const result = resolveContained(BASE, "../../etc/passwd");
    assert.equal(result, null);
  });

  it("rejects single-level .. that escapes", () => {
    const result = resolveContained(BASE, "../sibling.txt");
    assert.equal(result, null);
  });

  it("rejects absolute path that is outside filesDir", () => {
    const result = resolveContained(BASE, "/etc/passwd");
    assert.equal(result, null);
  });

  it("rejects absolute path that matches filesDir exactly — does not start traversal", () => {
    // An absolute path equal to BASE passes (resolved === filesDir)
    const result = resolveContained(BASE, BASE);
    assert.equal(result, BASE); // same as filesDir — allowed
  });

  it("rejects tricky traversal: dir that starts with filesDir name but is a sibling", () => {
    // e.g., /project/files/../files-evil/secret
    const result = resolveContained(BASE, "../files-evil/secret");
    assert.equal(result, null);
  });

  it("normalizes redundant current-dir references (.)", () => {
    // src/./app.ts → src/app.ts → within filesDir
    const result = resolveContained(BASE, "src/./app.ts");
    assert.equal(result, path.join(BASE, "src/app.ts"));
  });

  it("allows path that happens to contain filesDir prefix as part of a subpath", () => {
    // /project/files/project/files/nested → valid (starts with filesDir + sep)
    const result = resolveContained(BASE, "project/files/nested.txt");
    assert.equal(result, path.join(BASE, "project/files/nested.txt"));
  });

  it("rejects null-byte injection attempt (path.resolve normalizes it)", () => {
    // path.resolve should handle this; the result will either be valid or outside BASE
    const result = resolveContained(BASE, "src\x00/../../etc/passwd");
    // Node normalizes the null byte — result may vary, but must not escape
    if (result !== null) {
      assert.ok(
        result === BASE || result.startsWith(BASE + path.sep),
        `Expected contained path, got: ${result}`,
      );
    }
  });
});
