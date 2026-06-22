# Workflow Mode Switch Interrupt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `Run Feed`, `Run Predictions`, and `Run Both` switch workflows immediately when another workflow is already running, without allowing concurrent runners.

**Architecture:** The coordinator remains the single owner of workflow scheduling and cancellation. A new in-memory `pendingMode` records the latest requested mode while a runner is active; the active runner is asked to stop through the existing `isPaused()` callback, then the coordinator starts exactly one new cycle in the pending mode after the old cycle exits.

**Tech Stack:** TypeScript, Chrome Extension background service worker, Vitest, existing `WorkflowCoordinator` tests.

---

## File Structure

- Modify `extension/src/background/workflow-coordinator.ts`: add pending mode switch state, interrupt active cycles on `start(mode)`, preserve manual pause semantics, and restart the latest pending mode after the interrupted runner exits.
- Modify `extension/tests/workflow-coordinator.test.ts`: add controlled async runner tests for switching modes, pause precedence, last-switch-wins behavior, and global failure behavior.
- No UI file changes are required because the current popup already sends `run-feed`, `run-predictions`, and `run-both` commands to the background coordinator.

## Behavior Contract

- Calling `start("feed")`, `start("predictions")`, or `start("both")` while idle starts the selected mode exactly as today.
- Calling `start(newMode)` while a cycle is running updates persisted state to `mode = newMode`, sets `status = "running"`, clears `activeWorkflow`, clears `nextRunAt`, clears `lastError`, requests the active runner to pause, and stores `newMode` as the only pending restart.
- The active runner must stop at its next existing pause checkpoint because `isPaused()` becomes `true`.
- When the old cycle exits with `{ kind: "paused" }` due to a mode switch, the coordinator does not call the public `pause()` method because that would clear the pending restart.
- If the user clicks `Pause`, `pendingMode` is cleared and no pending workflow starts after the old runner exits.
- If the old cycle fails globally or throws while a pending switch exists, the coordinator pauses with the real error and does not start the pending workflow.
- If multiple run buttons are clicked while one runner is active, only the last selected mode is started after the old runner exits.

### Task 1: Add Failing Tests For Interrupting Active Workflows

**Files:**
- Modify: `extension/tests/workflow-coordinator.test.ts`

- [ ] **Step 1: Add a deferred helper near the existing test helpers**

Add this helper below the existing `coordinator(...)` helper or near the other helper functions:

```ts
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
```

- [ ] **Step 2: Add a failing test for switching from Predictions to Feed**

Append this test in `describe("WorkflowCoordinator", () => { ... })`:

```ts
it("interrupts active Predictions and starts Feed when Run Feed is clicked", async () => {
  const gate = deferred();
  const calls: string[] = [];
  let setup!: ReturnType<typeof coordinator>;
  setup = coordinator({
    runPredictions: async () => {
      calls.push("predictions:start");
      await gate.promise;
      calls.push(`predictions:paused=${setup.value.isPaused()}`);
      return setup.value.isPaused() ? { kind: "paused" } : { kind: "completed" };
    },
    runFeed: async () => {
      calls.push("feed");
      return { kind: "completed" };
    },
  });

  await setup.value.start("predictions");
  await vi.waitFor(() => expect(calls).toEqual(["predictions:start"]));

  await setup.value.start("feed");
  expect(setup.value.isPaused()).toBe(true);

  gate.resolve();
  await setup.value.idle();

  expect(calls).toEqual(["predictions:start", "predictions:paused=true", "feed"]);
  expect(chrome.alarms.create).toHaveBeenCalledWith("evoevo-workflow", { when: 61_000 });
});
```

- [ ] **Step 3: Add a failing test for switching from Feed to Predictions**

Append this test after the previous one:

```ts
it("interrupts active Feed and starts Predictions when Run Predictions is clicked", async () => {
  const gate = deferred();
  const calls: string[] = [];
  let setup!: ReturnType<typeof coordinator>;
  setup = coordinator({
    runFeed: async () => {
      calls.push("feed:start");
      await gate.promise;
      calls.push(`feed:paused=${setup.value.isPaused()}`);
      return setup.value.isPaused() ? { kind: "paused" } : { kind: "completed" };
    },
    runPredictions: async (_targetAgentId, scan) => {
      calls.push(`predictions:${scan}`);
      return { kind: "completed" };
    },
  });

  await setup.value.start("feed");
  await vi.waitFor(() => expect(calls).toEqual(["feed:start"]));

  await setup.value.start("predictions");
  expect(setup.value.isPaused()).toBe(true);

  gate.resolve();
  await setup.value.idle();

  expect(calls).toEqual(["feed:start", "feed:paused=true", "predictions:full"]);
});
```

- [ ] **Step 4: Run the new tests and verify they fail**

Run:

```bash
npm test -- extension/tests/workflow-coordinator.test.ts -t "interrupts active"
```

Expected: both new tests fail because `launchCycle()` currently returns when `this.running !== null`, so the pending mode is never started after the interrupted runner exits.

- [ ] **Step 5: Commit the failing tests**

```bash
git add extension/tests/workflow-coordinator.test.ts
git commit -m "test(extension): cover workflow mode switching"
```

### Task 2: Implement Pending Mode Switch In The Coordinator

**Files:**
- Modify: `extension/src/background/workflow-coordinator.ts`
- Test: `extension/tests/workflow-coordinator.test.ts`

- [ ] **Step 1: Add coordinator fields and helper methods**

In `WorkflowCoordinator`, replace the existing private fields:

```ts
  private running: Promise<void> | null = null;
  private readonly now: () => number;
  private pauseRequested = false;
```

with:

```ts
  private running: Promise<void> | null = null;
  private readonly now: () => number;
  private pauseRequested = false;
  private pendingMode: WorkflowMode | null = null;
```

Add this private helper inside the class, near `start()`:

```ts
  private async activateMode(mode: WorkflowMode): Promise<void> {
    const state = await this.deps.getState();
    state.mode = mode;
    state.status = "running";
    state.activeWorkflow = null;
    state.nextRunAt = null;
    state.lastError = null;
    await this.deps.setState(state);
  }
```

Add this private helper near `pause()`:

```ts
  private async handleRunnerPaused(): Promise<void> {
    if (this.pendingMode !== null) {
      return;
    }
    await this.pause();
  }
```

- [ ] **Step 2: Replace `start(mode)`**

Replace the current `start(mode)` implementation with:

```ts
  async start(mode: WorkflowMode): Promise<{ started: boolean }> {
    await this.activateMode(mode);

    if (this.running !== null) {
      this.pendingMode = mode;
      this.pauseRequested = true;
      await chrome.alarms.clear(WORKFLOW_ALARM_NAME);
      return { started: true };
    }

    this.pauseRequested = false;
    this.launchCycle();
    return { started: true };
  }
```

- [ ] **Step 3: Update `pause()` and `pauseWithError()`**

In `pause()`, add `this.pendingMode = null;` before setting the persisted state:

```ts
  async pause(): Promise<void> {
    this.pendingMode = null;
    const state = await this.deps.getState();
    state.status = "paused";
    state.activeWorkflow = null;
    state.nextRunAt = null;
    await this.deps.setState(state);
    this.pauseRequested = true;
    await chrome.alarms.clear(WORKFLOW_ALARM_NAME);
  }
```

In `pauseWithError(reason)`, add `this.pendingMode = null;` as the first statement:

```ts
  private async pauseWithError(reason: string): Promise<void> {
    this.pendingMode = null;
    const state = await this.deps.getState();
    state.status = "paused";
    state.activeWorkflow = null;
    state.nextRunAt = null;
    state.lastError = reason;
    await this.deps.setState(state);
    this.pauseRequested = true;
    await chrome.alarms.clear(WORKFLOW_ALARM_NAME);
  }
```

- [ ] **Step 4: Replace `launchCycle()` with a loop-backed runner**

Replace the current `launchCycle()` implementation with:

```ts
  private launchCycle(): void {
    if (this.running !== null) return;
    this.running = this.runCycles()
      .catch(async (error: unknown) => {
        await this.pauseWithError(errorMessage(error));
      })
      .finally(() => {
        this.running = null;
      });
  }
```

Add this method after `launchCycle()`:

```ts
  private async runCycles(): Promise<void> {
    while (true) {
      await this.runCycle();

      const pending = this.pendingMode;
      this.pendingMode = null;
      if (pending === null) {
        return;
      }

      const state = await this.deps.getState();
      if (state.status !== "running" || state.mode !== pending) {
        return;
      }

      this.pauseRequested = false;
    }
  }
```

This keeps `idle()` useful in tests because the same `running` promise covers the interrupted cycle and the immediate pending restart.

- [ ] **Step 5: Replace public `pause()` calls for runner-paused results**

In both places where `runCycle()` handles `result.kind === "paused"`, replace:

```ts
        await this.pause();
        return;
```

with:

```ts
        await this.handleRunnerPaused();
        return;
```

There are two locations: the feed runner branch and the predictions runner branch.

- [ ] **Step 6: Run targeted tests**

Run:

```bash
npm test -- extension/tests/workflow-coordinator.test.ts -t "interrupts active"
```

Expected: both tests pass.

- [ ] **Step 7: Run full coordinator tests**

Run:

```bash
npm test -- extension/tests/workflow-coordinator.test.ts
```

Expected: all coordinator tests pass.

- [ ] **Step 8: Commit implementation**

```bash
git add extension/src/background/workflow-coordinator.ts extension/tests/workflow-coordinator.test.ts
git commit -m "fix(extension): interrupt active workflow on mode switch"
```

### Task 3: Add Edge Case Tests For Last Switch, Pause, And Failures

**Files:**
- Modify: `extension/tests/workflow-coordinator.test.ts`
- Modify if needed: `extension/src/background/workflow-coordinator.ts`

- [ ] **Step 1: Add test for latest mode winning during repeated quick switches**

Append this test in `describe("WorkflowCoordinator", () => { ... })`:

```ts
it("starts only the latest pending mode after repeated quick switches", async () => {
  const gate = deferred();
  const calls: string[] = [];
  let setup!: ReturnType<typeof coordinator>;
  setup = coordinator({
    runPredictions: async (_targetAgentId, scan) => {
      calls.push(`predictions:${scan}:start`);
      if (scan === "full") {
        await gate.promise;
        calls.push(`predictions:${scan}:paused=${setup.value.isPaused()}`);
        return setup.value.isPaused() ? { kind: "paused" } : { kind: "completed" };
      }
      return { kind: "completed" };
    },
    runFeed: async () => {
      calls.push("feed");
      return { kind: "completed" };
    },
  });

  await setup.value.start("predictions");
  await vi.waitFor(() => expect(calls).toEqual(["predictions:full:start"]));

  await setup.value.start("feed");
  await setup.value.start("both");

  gate.resolve();
  await setup.value.idle();

  expect(calls).toEqual([
    "predictions:full:start",
    "predictions:full:paused=true",
    "feed",
    "predictions:incremental:start",
  ]);
});
```

This verifies that `feed` is not run as an obsolete pending mode; the final `both` request runs feed and then predictions.

- [ ] **Step 2: Add test for manual pause clearing the pending restart**

Append:

```ts
it("does not start pending mode when the user pauses after switching", async () => {
  const gate = deferred();
  const calls: string[] = [];
  let setup!: ReturnType<typeof coordinator>;
  setup = coordinator({
    runPredictions: async () => {
      calls.push("predictions:start");
      await gate.promise;
      calls.push(`predictions:paused=${setup.value.isPaused()}`);
      return setup.value.isPaused() ? { kind: "paused" } : { kind: "completed" };
    },
    runFeed: async () => {
      calls.push("feed");
      return { kind: "completed" };
    },
  });

  await setup.value.start("predictions");
  await vi.waitFor(() => expect(calls).toEqual(["predictions:start"]));

  await setup.value.start("feed");
  await setup.value.pause();
  gate.resolve();
  await setup.value.idle();

  expect(calls).toEqual(["predictions:start", "predictions:paused=true"]);
  expect((await getWorkflowState()).status).toBe("paused");
});
```

- [ ] **Step 3: Add test for global failure preventing pending restart**

Append:

```ts
it("keeps global runner failures from starting a pending mode", async () => {
  const gate = deferred();
  const calls: string[] = [];
  let setup!: ReturnType<typeof coordinator>;
  setup = coordinator({
    runPredictions: async () => {
      calls.push("predictions:start");
      await gate.promise;
      calls.push("predictions:failed");
      return { kind: "failed", reason: "backend rejected tx", global: true };
    },
    runFeed: async () => {
      calls.push("feed");
      return { kind: "completed" };
    },
  });

  await setup.value.start("predictions");
  await vi.waitFor(() => expect(calls).toEqual(["predictions:start"]));

  await setup.value.start("feed");
  gate.resolve();
  await setup.value.idle();

  expect(calls).toEqual(["predictions:start", "predictions:failed"]);
  expect(await getWorkflowState()).toMatchObject({
    status: "paused",
    mode: "feed",
    lastError: "backend rejected tx",
  });
});
```

- [ ] **Step 4: Run the edge case tests**

Run:

```bash
npm test -- extension/tests/workflow-coordinator.test.ts -t "latest pending|user pauses|global runner"
```

Expected: all three tests pass. If the global failure test fails because the pending mode starts, update the `runCycles()` loop so it checks persisted state after each `runCycle()` and returns when `status !== "running"`.

- [ ] **Step 5: Run full test and typecheck suite**

Run:

```bash
npm test
npm run typecheck
```

Expected: all tests pass and TypeScript reports no errors.

- [ ] **Step 6: Commit edge case coverage**

```bash
git add extension/tests/workflow-coordinator.test.ts extension/src/background/workflow-coordinator.ts
git commit -m "test(extension): cover workflow switch edge cases"
```

### Task 4: Build Verification And Manual Chrome Check

**Files:**
- No source files expected unless verification exposes a bug.

- [ ] **Step 1: Build extension**

Run:

```bash
npm run build
```

Expected: build completes successfully and emits the extension bundle without TypeScript or bundler errors.

- [ ] **Step 2: Load the built extension manually**

Open Chrome at:

```text
chrome://extensions
```

Enable Developer mode, click `Load unpacked`, and select:

```text
C:\Users\pMjn\Documents\Auto EvoEvo\.worktrees\dual-workflow-predictions\extension\dist
```

- [ ] **Step 3: Verify switch from Predictions to Feed**

Use the popup:

1. Click `Run Predictions`.
2. Wait until the status panel shows Predictions activity or logs an EvoEvo predictions request.
3. Click `Run Feed`.
4. Confirm the old predictions run logs a paused or interrupted state and the next active work is feed.
5. Confirm no predictions and feed requests run concurrently.

- [ ] **Step 4: Verify manual Pause stops pending switch**

Use the popup:

1. Click `Run Predictions`.
2. Click `Run Feed`.
3. Click `Pause` before the old predictions runner finishes.
4. Confirm status remains paused and no feed work starts afterward.

- [ ] **Step 5: Capture final git state**

Run:

```bash
git status --short
git log --oneline -5
```

Expected: only intentional files are modified or committed. The existing untracked `extension/tèo lun.zip` may remain untracked and must not be added.

## Self-Review

- Spec coverage: The plan covers immediate interrupt, non-concurrent runners, last selected mode wins, manual pause cancellation, global failure preservation, and repeat scheduling staying in the coordinator.
- Placeholder scan: The plan contains exact file paths, exact test code, exact implementation snippets, exact commands, and expected outcomes.
- Type consistency: The plan uses existing `WorkflowMode`, `WorkflowCoordinator`, `start(mode)`, `pause()`, `idle()`, `runFeed`, `runPredictions`, `isPaused()`, `WORKFLOW_ALARM_NAME`, and result shapes already present in the codebase.
