/**
 * Unit tests for orchestrator/engine.ts
 * Tests: PauseLatch, TaskExecution.choosingAgent, resumeTask/setNextAgent guards
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { PauseLatch, TaskExecution } from "../orchestrator/engine.js";
import type { Pipeline } from "../orchestrator/pipelines.js";

// ─── PauseLatch ──────────────────────────────────────────────────────────────

describe("PauseLatch", () => {
  it("starts unpaused", () => {
    const latch = new PauseLatch();
    assert.equal(latch.paused, false);
  });

  it("pause() sets paused to true", () => {
    const latch = new PauseLatch();
    latch.pause();
    assert.equal(latch.paused, true);
  });

  it("resume() clears paused state", () => {
    const latch = new PauseLatch();
    latch.pause();
    latch.resume();
    assert.equal(latch.paused, false);
  });

  it("double-pause is idempotent — second pause does not create a second promise", () => {
    const latch = new PauseLatch();
    latch.pause();
    latch.pause(); // should not throw or create extra state
    assert.equal(latch.paused, true);
    latch.resume();
    assert.equal(latch.paused, false);
  });

  it("resume() on unpaused latch is a no-op", () => {
    const latch = new PauseLatch();
    // Should not throw
    latch.resume();
    assert.equal(latch.paused, false);
  });

  it("wait() resolves immediately when not paused", async () => {
    const latch = new PauseLatch();
    // Should resolve without blocking
    await latch.wait();
    assert.equal(latch.paused, false);
  });

  it("wait() blocks until resume() is called", async () => {
    const latch = new PauseLatch();
    latch.pause();

    let resolved = false;
    const waiting = latch.wait().then(() => { resolved = true; });

    // Not yet resolved
    assert.equal(resolved, false);

    latch.resume();
    await waiting;

    assert.equal(resolved, true);
    assert.equal(latch.paused, false);
  });

  it("wait() resolves when resumed asynchronously via setTimeout", async () => {
    const latch = new PauseLatch();
    latch.pause();

    setTimeout(() => latch.resume(), 20);
    await latch.wait();

    assert.equal(latch.paused, false);
  });

  it("multiple waiters all resolve when resume() is called", async () => {
    const latch = new PauseLatch();
    latch.pause();

    let count = 0;
    const w1 = latch.wait().then(() => count++);
    const w2 = latch.wait().then(() => count++);

    latch.resume();
    await Promise.all([w1, w2]);

    assert.equal(count, 2);
  });
});

// ─── TaskExecution.choosingAgent ─────────────────────────────────────────────

describe("TaskExecution.choosingAgent", () => {
  const makePipeline = (): Pipeline => ({
    id: "test-pipeline",
    name: "Test Pipeline",
    start_agent: "product",
  });

  it("is false when the task is not paused at all", () => {
    const ex = new TaskExecution("proj1", "task1", makePipeline());
    assert.equal(ex.choosingAgent, false);
  });

  it("is false when paused for a reason other than agent selection (nextAgentChoice already set)", () => {
    const ex = new TaskExecution("proj1", "task1", makePipeline());
    ex.nextAgentChoice = "dev"; // already has a choice set
    ex.pause();
    assert.equal(ex.choosingAgent, false);
  });

  it("is false when nextAgentChoice is null (pipeline end chosen by user)", () => {
    const ex = new TaskExecution("proj1", "task1", makePipeline());
    ex.nextAgentChoice = null; // user explicitly chose to stop
    ex.pause();
    assert.equal(ex.choosingAgent, false);
  });

  it("is true when paused and nextAgentChoice is undefined (awaiting selection)", () => {
    const ex = new TaskExecution("proj1", "task1", makePipeline());
    // nextAgentChoice starts as undefined — this is the choosing_agent state
    ex.pause();
    assert.equal(ex.choosingAgent, true);
  });

  it("transitions to false after resume() is called", () => {
    const ex = new TaskExecution("proj1", "task1", makePipeline());
    ex.pause();
    assert.equal(ex.choosingAgent, true);
    ex.resume();
    assert.equal(ex.choosingAgent, false);
  });

  it("transitions to false once nextAgentChoice is set (even while still paused)", () => {
    const ex = new TaskExecution("proj1", "task1", makePipeline());
    ex.pause();
    assert.equal(ex.choosingAgent, true);
    ex.nextAgentChoice = "architect";
    // Still paused but choice is now set → no longer in choosing state
    assert.equal(ex.choosingAgent, false);
  });
});

// ─── TaskExecution — paused/cancelled state ───────────────────────────────────

describe("TaskExecution state", () => {
  const makePipeline = (): Pipeline => ({
    id: "test-pipeline",
    name: "Test Pipeline",
    start_agent: "product",
  });

  it("starts unpaused and not cancelled", () => {
    const ex = new TaskExecution("p", "t", makePipeline());
    assert.equal(ex.paused, false);
    assert.equal(ex.cancelled, false);
  });

  it("pause/resume cycle works correctly", () => {
    const ex = new TaskExecution("p", "t", makePipeline());
    ex.pause();
    assert.equal(ex.paused, true);
    ex.resume();
    assert.equal(ex.paused, false);
  });

  it("cancel sets cancelled and does not affect paused", () => {
    const ex = new TaskExecution("p", "t", makePipeline());
    ex.cancelled = true;
    assert.equal(ex.cancelled, true);
    assert.equal(ex.paused, false);
  });

  it("extraContext starts null and can be set", () => {
    const ex = new TaskExecution("p", "t", makePipeline());
    assert.equal(ex.extraContext, null);
    ex.extraContext = "some extra context";
    assert.equal(ex.extraContext, "some extra context");
  });

  it("currentRunner starts null", () => {
    const ex = new TaskExecution("p", "t", makePipeline());
    assert.equal(ex.currentRunner, null);
  });
});

// ─── Permission Promise ───────────────────────────────────────────────────────

describe("TaskExecution.createPermissionPromise", () => {
  const makePipeline = (): Pipeline => ({
    id: "test-pipeline",
    name: "Test Pipeline",
    start_agent: "product",
  });

  it("resolves when resolvePermission is called with matching id", async () => {
    const ex = new TaskExecution("p", "t", makePipeline());
    const promise = ex.createPermissionPromise("perm-1");

    const resolved = ex.resolvePermission("perm-1", {
      id: "perm-1",
      behavior: "allow",
    });

    assert.equal(resolved, true);
    const response = await promise;
    assert.equal(response.behavior, "allow");
  });

  it("returns false when resolvePermission called with unknown id", () => {
    const ex = new TaskExecution("p", "t", makePipeline());
    ex.createPermissionPromise("perm-1");
    const resolved = ex.resolvePermission("perm-UNKNOWN", { id: "perm-UNKNOWN", behavior: "deny" });
    assert.equal(resolved, false);
  });

  it("removes permission from pending map after resolution", async () => {
    const ex = new TaskExecution("p", "t", makePipeline());
    const promise = ex.createPermissionPromise("perm-2");

    ex.resolvePermission("perm-2", { id: "perm-2", behavior: "deny" });
    await promise;

    // Second resolve attempt returns false (already removed)
    const second = ex.resolvePermission("perm-2", { id: "perm-2", behavior: "allow" });
    assert.equal(second, false);
  });
});
