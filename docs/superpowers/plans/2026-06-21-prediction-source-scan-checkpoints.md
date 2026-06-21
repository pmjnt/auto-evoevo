# Prediction Source Scan Checkpoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent repeated predictions scans from re-reading source agents already completed inside the same 24-hour scan window, and add a separate cooldown before every predictions-read API call.

**Architecture:** Persist a shared prediction scan window in `WorkflowState`, anchored by `predictionScanStartedAt`. During that window, `runPredictions` filters out `completedPredictionSourceIds`; after 24 hours from the window start, it clears the completed list and begins a new full source scan. A new `predictionReadCooldownSeconds` config throttles `GET /v1/agents/{id}/predictions`, separate from the existing memory POST cooldown.

**Tech Stack:** TypeScript Chrome extension, Zod storage/message schemas, Vitest, existing EvoEvo API client and workflow coordinator.

---

## File Structure

- Modify `extension/src/shared/types.ts`
  - Add `predictionReadCooldownSeconds` to `ExtensionConfig`.
  - Add `completedPredictionSourceIds` and `predictionScanStartedAt` to `WorkflowState`.
  - Allow predictions rate-limit events to include `sourceAgentId`.
- Modify `extension/src/shared/messages.ts`
  - Accept and default `predictionReadCooldownSeconds` in `set-config`.
- Modify `extension/src/background/storage.ts`
  - Persist the new config/state fields.
  - Backfill missing state fields for users with existing stored workflow state.
- Modify `extension/src/ui/popup.html`
  - Add the new numeric setting beside the existing memory API cooldown.
- Modify `extension/src/ui/popup.ts`
  - Load, save, and clamp the new setting.
- Modify `extension/src/ui/workflow-events.ts`
  - Show the source agent when a predictions-read request hits rate limit.
- Modify `extension/src/background/predictions-runner.ts`
  - Add injected config, `sleep`, and `now` dependencies.
  - Initialize and roll the 24-hour scan window.
  - Skip source agents completed in the active scan window.
  - Cool down before every `listAgentPredictions` request.
  - Convert `GET predictions` 429 into the same runner `rate_limited` result.
- Modify `extension/src/background/workflow-coordinator.ts`
  - Use `predictionScanStartedAt` as the full-scan interval anchor when available.
- Modify `extension/src/background/index.ts`
  - Pass prediction runner config from extension config.
- Modify tests under `extension/tests/`
  - Update config fixtures.
  - Add storage/message/UI tests for the new config and state fields.
  - Add runner tests for source checkpoints, 24-hour reset, read cooldown, and GET 429.
  - Add coordinator and workflow event tests for the new behavior.

## Task 1: Config, State, and UI Failing Tests

**Files:**
- Modify: `extension/tests/storage.test.ts`
- Modify: `extension/tests/messages.test.ts`
- Modify: `extension/tests/popup.test.ts`

- [ ] **Step 1: Write failing storage tests**

Add these assertions to `extension/tests/storage.test.ts`. Keep the existing `fakeConfig` fixture, but add `predictionReadCooldownSeconds: 2` after `memoryApiCooldownSeconds`.

```ts
it("defaults prediction read cooldown for older configs", async () => {
  const {
    predictionReadCooldownSeconds: _predictionReadCooldownSeconds,
    ...legacy
  } = fakeConfig;
  await chrome.storage.local.set({ config: legacy });

  await expect(getConfig()).resolves.toMatchObject({
    predictionReadCooldownSeconds: 2,
  });
});

it("defaults prediction scan checkpoint fields for older workflow state", async () => {
  const legacy = structuredClone(DEFAULT_WORKFLOW_STATE) as Partial<typeof DEFAULT_WORKFLOW_STATE>;
  delete legacy.completedPredictionSourceIds;
  delete legacy.predictionScanStartedAt;
  await chrome.storage.local.set({ workflowState: legacy });

  await expect(getWorkflowState()).resolves.toMatchObject({
    completedPredictionSourceIds: [],
    predictionScanStartedAt: null,
  });
});
```

- [ ] **Step 2: Write failing message schema test**

If `extension/tests/messages.test.ts` has a valid set-config payload fixture, add `predictionReadCooldownSeconds: 2` to that fixture and add a parse assertion:

```ts
expect(parsed.config.predictionReadCooldownSeconds).toBe(2);
```

Also add this legacy-default assertion near the other `parseMessage` default tests:

```ts
const parsed = parseMessage({
  type: "set-config",
  config: {
    ...validConfig,
    predictionReadCooldownSeconds: undefined,
  },
});

expect(parsed.config.predictionReadCooldownSeconds).toBe(2);
```

Use the existing local fixture name instead of `validConfig` if the file already uses a different name.

- [ ] **Step 3: Write failing popup tests**

Update the static UI assertions in `extension/tests/popup.test.ts`:

```ts
expect(popupHtml).toContain('id="predictionReadCooldownSeconds"');
expect(popupSource).toContain("predictionReadCooldownSeconds: clampInt");
```

Update the `config` fixture:

```ts
predictionReadCooldownSeconds: 2,
```

- [ ] **Step 4: Run tests and verify failure**

Run:

```powershell
npm test -- extension/tests/storage.test.ts extension/tests/messages.test.ts extension/tests/popup.test.ts
```

Expected: FAIL because `predictionReadCooldownSeconds`, `completedPredictionSourceIds`, and `predictionScanStartedAt` are not implemented yet.

## Task 2: Config, State, and UI Implementation

**Files:**
- Modify: `extension/src/shared/types.ts`
- Modify: `extension/src/shared/messages.ts`
- Modify: `extension/src/background/storage.ts`
- Modify: `extension/src/ui/popup.html`
- Modify: `extension/src/ui/popup.ts`
- Test: `extension/tests/storage.test.ts`
- Test: `extension/tests/messages.test.ts`
- Test: `extension/tests/popup.test.ts`

- [ ] **Step 1: Add shared types**

In `extension/src/shared/types.ts`, add the config field after `memoryApiCooldownSeconds`:

```ts
predictionReadCooldownSeconds: number;
```

Change the rate-limit event type from:

```ts
| { type: "predictions-rate-limited"; retryAfterMs: number }
```

to:

```ts
| { type: "predictions-rate-limited"; retryAfterMs: number; sourceAgentId?: number }
```

Add workflow state fields after `sourceAgentIds`:

```ts
completedPredictionSourceIds: number[];
predictionScanStartedAt: number | null;
```

- [ ] **Step 2: Add schema defaults**

In `extension/src/shared/messages.ts`, add this to `setConfigSchema.config` after `memoryApiCooldownSeconds`:

```ts
predictionReadCooldownSeconds: z.number().int().min(0).max(60).default(2),
```

In `extension/src/background/storage.ts`, add the same field to `configSchema` after `memoryApiCooldownSeconds`:

```ts
predictionReadCooldownSeconds: z.number().int().min(0).max(60).default(2),
```

In `workflowStateSchema`, add these fields after `sourceAgentIds`:

```ts
completedPredictionSourceIds: z.array(z.number().int().positive()).default([]),
predictionScanStartedAt: z.number().nonnegative().nullable().default(null),
```

In `DEFAULT_WORKFLOW_STATE`, add:

```ts
completedPredictionSourceIds: [],
predictionScanStartedAt: null,
```

- [ ] **Step 3: Add popup input markup**

In `extension/src/ui/popup.html`, add this field in Settings near `memoryApiCooldownSeconds`:

```html
<div class="field">
  <label for="predictionReadCooldownSeconds">Prediction read cooldown (s)</label>
  <input id="predictionReadCooldownSeconds" class="input" type="number" min="0" max="60" />
</div>
```

- [ ] **Step 4: Wire popup config**

In `extension/src/ui/popup.ts`, add to `DEFAULT_CONFIG` after `memoryApiCooldownSeconds`:

```ts
predictionReadCooldownSeconds: 2,
```

In `fillConfig`, add:

```ts
setInput("predictionReadCooldownSeconds", config.predictionReadCooldownSeconds);
```

In `currentConfig`, add after `memoryApiCooldownSeconds`:

```ts
predictionReadCooldownSeconds: clampInt(
  elValue("predictionReadCooldownSeconds"),
  DEFAULT_CONFIG.predictionReadCooldownSeconds,
  0,
  60,
),
```

- [ ] **Step 5: Run tests and commit**

Run:

```powershell
npm test -- extension/tests/storage.test.ts extension/tests/messages.test.ts extension/tests/popup.test.ts
```

Expected: PASS.

Commit:

```powershell
git add extension/src/shared/types.ts extension/src/shared/messages.ts extension/src/background/storage.ts extension/src/ui/popup.html extension/src/ui/popup.ts extension/tests/storage.test.ts extension/tests/messages.test.ts extension/tests/popup.test.ts
git commit -m "feat(extension): add prediction scan settings state"
```

## Task 3: Runner and Coordinator Failing Tests

**Files:**
- Modify: `extension/tests/predictions-runner.test.ts`
- Modify: `extension/tests/workflow-coordinator.test.ts`
- Modify: test config fixtures that fail typecheck because of the new config field

- [ ] **Step 1: Update predictions runner harness**

In `extension/tests/predictions-runner.test.ts`, import the HTTP error:

```ts
import { EvoEvoHttpError } from "../src/background/evoevo-api.js";
```

Update `harness` to support config, now, and sleep:

```ts
function harness(options: {
  known?: string[];
  state?: Partial<WorkflowState>;
  now?: number;
  predictionReadCooldownSeconds?: number;
} = {}) {
  const sleep = vi.fn(async (_ms: number) => undefined);
  const now = vi.fn(() => options.now ?? 1_000_000);
  let state: WorkflowState = {
    ...structuredClone(DEFAULT_WORKFLOW_STATE),
    ...options.state,
  };
  // keep the existing body, then add these deps:
  // config: { predictionReadCooldownSeconds: options.predictionReadCooldownSeconds ?? 0, rateLimitBackoffMinutes: 15 },
  // sleep,
  // now,
  // and return sleep from the harness object
}
```

When applying this, preserve the existing `submitted`, `requestedSources`, API mocks, registry, checkpoint, and `predictionPages` behavior.

- [ ] **Step 2: Add source checkpoint tests**

Add these tests to `extension/tests/predictions-runner.test.ts`:

```ts
it("marks a source agent completed only after all prediction pages finish", async () => {
  const setup = harness({ now: 10_000 });

  await expect(
    runPredictions(setup.deps, { scan: "full", targetAgentId: 900 }),
  ).resolves.toEqual({ kind: "completed" });

  expect(setup.state.predictionScanStartedAt).toBe(10_000);
  expect(setup.state.completedPredictionSourceIds).toEqual([3314]);
});

it("skips source agents completed in the active scan window", async () => {
  const setup = harness({
    state: {
      sourceAgentIds: [3314, 60062],
      completedPredictionSourceIds: [3314],
      predictionScanStartedAt: 10_000,
    },
    now: 20_000,
  });
  setup.predictionPages.set(60062, [page([prediction("fresh-60062", 60062)], null)]);

  await expect(
    runPredictions(setup.deps, { scan: "incremental", targetAgentId: 900 }),
  ).resolves.toEqual({ kind: "completed" });

  expect(setup.requestedSources).toEqual([60062]);
  expect(setup.submitted).toEqual(["fresh-60062"]);
  expect(setup.state.completedPredictionSourceIds).toEqual([3314, 60062]);
});

it("starts a new prediction source scan window after 24 hours from scan start", async () => {
  const dayMs = 24 * 60 * 60 * 1000;
  const setup = harness({
    state: {
      sourceAgentIds: [3314],
      completedPredictionSourceIds: [3314],
      predictionScanStartedAt: 50_000,
    },
    now: 50_000 + dayMs,
  });

  await expect(
    runPredictions(setup.deps, { scan: "full", targetAgentId: 900 }),
  ).resolves.toEqual({ kind: "completed" });

  expect(setup.requestedSources).toEqual([3314, 3314]);
  expect(setup.state.predictionScanStartedAt).toBe(50_000 + dayMs);
  expect(setup.state.completedPredictionSourceIds).toEqual([3314]);
});
```

- [ ] **Step 3: Add prediction read cooldown test**

Add:

```ts
it("waits before each predictions read request", async () => {
  const setup = harness({ predictionReadCooldownSeconds: 2 });

  await expect(
    runPredictions(setup.deps, { scan: "full", targetAgentId: 900 }),
  ).resolves.toEqual({ kind: "completed" });

  expect(setup.sleep).toHaveBeenCalledTimes(2);
  expect(setup.sleep).toHaveBeenNthCalledWith(1, 2_000);
  expect(setup.sleep).toHaveBeenNthCalledWith(2, 2_000);
});
```

- [ ] **Step 4: Add GET predictions 429 test**

Add:

```ts
it("returns rate_limited when reading predictions hits the API limit", async () => {
  const setup = harness();
  const updates: PredictionProgressUpdate[] = [];
  setup.deps.onProgress = vi.fn(async (update) => { updates.push(update); });
  setup.deps.api.listAgentPredictions = vi.fn(async () => {
    throw new EvoEvoHttpError(
      "EvoEvo API GET https://api.evoevo.ai/v1/agents/6714/predictions -> 429 : {\"error\":\"rate limit exceeded\"}",
      429,
      "rate limit exceeded",
    );
  });

  await expect(
    runPredictions(setup.deps, { scan: "full", targetAgentId: 900 }),
  ).resolves.toEqual({ kind: "rate_limited", retryAfterMs: 900_000 });

  expect(setup.state.completedPredictionSourceIds).toEqual([]);
  expect(updates).toContainEqual({
    activity: {
      type: "predictions-rate-limited",
      retryAfterMs: 900_000,
      sourceAgentId: 3314,
    },
  });
});
```

- [ ] **Step 5: Add coordinator 24-hour anchor test**

In `extension/tests/workflow-coordinator.test.ts`, add `predictionReadCooldownSeconds: 2` to the `config` fixture, then add:

```ts
it("uses prediction scan start as the full scan interval anchor", async () => {
  const dayMs = 24 * 60 * 60 * 1000;
  const calls: string[] = [];
  await setWorkflowState({
    ...structuredClone(DEFAULT_WORKFLOW_STATE),
    status: "running",
    mode: "predictions",
    predictionScanStartedAt: 10_000,
    lastReconciliationAt: 20_000,
  });
  const setup = coordinator({
    now: () => 10_000 + dayMs,
    runPredictions: async (_target, scan) => {
      calls.push(`predictions:${scan}`);
      return { kind: "completed" };
    },
  });

  await setup.value.recover();
  await setup.value.idle();

  expect(calls).toEqual(["predictions:full"]);
});
```

- [ ] **Step 6: Run tests and verify failure**

Run:

```powershell
npm test -- extension/tests/predictions-runner.test.ts extension/tests/workflow-coordinator.test.ts
```

Expected: FAIL because the runner does not have source checkpoints, read cooldown, or GET 429 handling yet, and the coordinator still anchors full scans on `lastReconciliationAt`.

## Task 4: Runner and Coordinator Implementation

**Files:**
- Modify: `extension/src/background/predictions-runner.ts`
- Modify: `extension/src/background/workflow-coordinator.ts`
- Modify: `extension/src/background/index.ts`
- Test: `extension/tests/predictions-runner.test.ts`
- Test: `extension/tests/workflow-coordinator.test.ts`

- [ ] **Step 1: Extend runner dependencies**

In `extension/src/background/predictions-runner.ts`, update imports:

```ts
import { EvoEvoHttpError } from "./evoevo-api.js";
import type { ExtensionConfig } from "../shared/types.js";
```

Change `PredictionsRunnerDeps` to include:

```ts
config: Pick<ExtensionConfig, "predictionReadCooldownSeconds" | "rateLimitBackoffMinutes">;
sleep?: (ms: number) => Promise<void>;
now?: () => number;
```

Add constants near the top:

```ts
const PREDICTION_SCAN_WINDOW_MS = 24 * 60 * 60 * 1000;
```

- [ ] **Step 2: Initialize the scan window before source collection**

In `runPredictions`, after `processDueRetries` completes and before `predictions-loading`, add:

```ts
await preparePredictionScanWindow(deps);
```

Add this helper near the bottom:

```ts
async function preparePredictionScanWindow(deps: PredictionsRunnerDeps): Promise<void> {
  const now = (deps.now ?? Date.now)();
  const state = await deps.checkpoint.load();
  if (
    state.predictionScanStartedAt === null ||
    now - state.predictionScanStartedAt >= PREDICTION_SCAN_WINDOW_MS
  ) {
    state.predictionScanStartedAt = now;
    state.completedPredictionSourceIds = [];
    await deps.checkpoint.save(state);
  }
}
```

- [ ] **Step 3: Filter completed source agents in the active window**

After collecting `sourceAgentIds`, load state and compute pending IDs:

```ts
const checkpoint = await deps.checkpoint.load();
const completedSourceIds = new Set(checkpoint.completedPredictionSourceIds);
const pendingSourceAgentIds = sourceAgentIds.filter((id) => !completedSourceIds.has(id));
```

Keep the existing progress count based on `sourceAgentIds.length`, then change the loop to:

```ts
for (const sourceAgentId of pendingSourceAgentIds) {
  if (deps.isPaused()) return { kind: "paused" };
  const result = await processSource(deps, {
    sourceAgentId,
    targetAgentId: args.targetAgentId,
    full: args.scan === "full",
  });
  if (result.kind !== "completed") return result;
  await markSourceComplete(deps, sourceAgentId);
}
```

Add helper:

```ts
async function markSourceComplete(
  deps: PredictionsRunnerDeps,
  sourceAgentId: number,
): Promise<void> {
  const state = await deps.checkpoint.load();
  state.completedPredictionSourceIds = uniqueNumbers([
    ...state.completedPredictionSourceIds,
    sourceAgentId,
  ]);
  await deps.checkpoint.save(state);
}
```

- [ ] **Step 4: Cool down before each predictions read**

At the beginning of the `while (true)` loop inside `processSource`, before `listAgentPredictions`, add:

```ts
const delayMs = Math.max(0, deps.config.predictionReadCooldownSeconds) * 1000;
if (delayMs > 0) {
  await (deps.sleep ?? sleep)(delayMs);
}
```

Add helper:

```ts
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

- [ ] **Step 5: Handle GET predictions 429**

Wrap the `listAgentPredictions` call:

```ts
let page: ApiPage<AgentPrediction>;
try {
  page = await deps.api.listAgentPredictions({
    sourceAgentId: args.sourceAgentId,
    chainId: deps.chainId,
    limit: 20,
    before,
  });
} catch (error) {
  if (error instanceof EvoEvoHttpError && error.status === 429) {
    const retryAfterMs = Math.max(1, deps.config.rateLimitBackoffMinutes) * 60_000;
    return await reportRateLimit(deps, retryAfterMs, args.sourceAgentId);
  }
  throw error;
}
```

Change `reportRateLimit` signature and event:

```ts
async function reportRateLimit(
  deps: PredictionsRunnerDeps,
  retryAfterMs: number,
  sourceAgentId?: number,
): Promise<RunnerResult> {
  await deps.onProgress({
    activity: { type: "predictions-rate-limited", retryAfterMs, sourceAgentId },
  });
  return { kind: "rate_limited", retryAfterMs };
}
```

Update existing calls from submission rate limits:

```ts
return await reportRateLimit(deps, outcome.retryAfterMs, args.sourceAgentId);
```

and in `processDueRetries`:

```ts
return await reportRateLimit(deps, outcome.retryAfterMs, item.sourceAgentId);
```

- [ ] **Step 6: Anchor full scan due on scan start**

In `extension/src/background/workflow-coordinator.ts`, replace `fullScanDue` with:

```ts
function fullScanDue(
  state: WorkflowState,
  config: ExtensionConfig,
  now: number,
): boolean {
  const anchor = state.predictionScanStartedAt ?? state.lastReconciliationAt;
  return anchor === null ||
    now - anchor >= config.reconciliationIntervalMinutes * 60_000;
}
```

- [ ] **Step 7: Pass config from the background router**

In `extension/src/background/index.ts`, inside the `runPredictions({ ... })` dependency object, add:

```ts
config,
```

- [ ] **Step 8: Run tests and commit**

Run:

```powershell
npm test -- extension/tests/predictions-runner.test.ts extension/tests/workflow-coordinator.test.ts
```

Expected: PASS.

Commit:

```powershell
git add extension/src/background/predictions-runner.ts extension/src/background/workflow-coordinator.ts extension/src/background/index.ts extension/tests/predictions-runner.test.ts extension/tests/workflow-coordinator.test.ts
git commit -m "feat(extension): checkpoint prediction source scans"
```

## Task 5: Rate-Limit Event and Fixture Cleanup

**Files:**
- Modify: `extension/src/ui/workflow-events.ts`
- Modify: `extension/tests/workflow-events.test.ts`
- Modify: any remaining test fixtures with missing `predictionReadCooldownSeconds`

- [ ] **Step 1: Add workflow event test**

In `extension/tests/workflow-events.test.ts`, add:

```ts
it("formats predictions read rate limits with source agent context", () => {
  expect(formatWorkflowEvent({
    type: "predictions-rate-limited",
    retryAfterMs: 900_000,
    sourceAgentId: 6714,
  })).toBe("[Predictions] Source 6714 rate limited. Retrying in 15 minutes.");
});
```

- [ ] **Step 2: Implement event formatting**

In `extension/src/ui/workflow-events.ts`, update the `predictions-rate-limited` branch:

```ts
if (event.type === "predictions-rate-limited") {
  const typed = event as PredictionActivityEvent & { type: "predictions-rate-limited" };
  const minutes = Math.max(1, Math.ceil(typed.retryAfterMs / 60_000));
  if (typed.sourceAgentId !== undefined) {
    return `[Predictions] Source ${typed.sourceAgentId} rate limited. Retrying in ${minutes} minutes.`;
  }
  return `[Predictions] Rate limited. Retrying in ${minutes} minutes.`;
}
```

- [ ] **Step 3: Update all config fixtures**

Run:

```powershell
rg -n "memoryApiCooldownSeconds: 1" extension/tests
```

Every `ExtensionConfig` fixture must include:

```ts
predictionReadCooldownSeconds: 2,
```

Place it after `memoryApiCooldownSeconds: 1`. The likely files are:

```text
extension/tests/background-router.test.ts
extension/tests/direct-runner.test.ts
extension/tests/guard.test.ts
extension/tests/intake-submitter.test.ts
extension/tests/prediction-submitter.test.ts
extension/tests/popup.test.ts
extension/tests/storage.test.ts
extension/tests/workflow-coordinator.test.ts
```

- [ ] **Step 4: Run focused tests and commit**

Run:

```powershell
npm test -- extension/tests/workflow-events.test.ts extension/tests/background-router.test.ts extension/tests/direct-runner.test.ts extension/tests/guard.test.ts extension/tests/intake-submitter.test.ts extension/tests/prediction-submitter.test.ts
```

Expected: PASS.

Commit:

```powershell
git add extension/src/ui/workflow-events.ts extension/tests
git commit -m "chore(extension): update prediction scan fixtures"
```

## Task 6: Full Verification

**Files:**
- Verify all touched extension files

- [ ] **Step 1: Run full automated checks**

Run:

```powershell
npm test
npm run typecheck
npm run build
```

Expected:

```text
Test Files  all passed
Tests       all passed
typecheck exits 0
build exits 0
```

- [ ] **Step 2: Inspect git diff**

Run:

```powershell
git diff --stat
git diff -- extension/src/background/predictions-runner.ts extension/src/background/workflow-coordinator.ts extension/src/background/storage.ts extension/src/ui/popup.ts extension/src/ui/popup.html
```

Confirm:

```text
predictionReadCooldownSeconds is only used for GET predictions cooldown.
memoryApiCooldownSeconds remains used for POST memories/from-opinion cooldown.
completedPredictionSourceIds is updated only after a source finishes without pause, failure, or rate limit.
predictionScanStartedAt is set when a new 24-hour scan window starts and is not cleared on successful completion.
GET predictions 429 returns rate_limited and keeps the current source uncompleted.
```

- [ ] **Step 3: Commit final verification notes if tests required fixture cleanup**

If Task 6 changed files, commit:

```powershell
git add extension/src extension/tests
git commit -m "test(extension): verify prediction scan checkpoints"
```

If Task 6 changed no files, do not create an empty commit.

## Self-Review

- Spec coverage:
  - Shared scan bookmark for target agents: covered by `completedPredictionSourceIds` and filtering in Task 4.
  - New scan only after 24 hours from first scan start: covered by `predictionScanStartedAt`, `PREDICTION_SCAN_WINDOW_MS`, and coordinator anchor in Task 4.
  - Cooldown during source scan to reduce rate limit: covered by `predictionReadCooldownSeconds` in Tasks 1, 2, and 4.
  - Do not skip a source forever: covered by the 24-hour reset test and implementation in Task 3 and Task 4.
  - User pause stops repeating: preserved because the runner returns `paused`, coordinator calls `pause()`, and the new logic does not create alarms directly.
  - Existing memory POST cooldown remains intact: called out in verification and no task changes `prediction-submitter.ts`.
- Placeholder scan: no unfinished markers or vague implementation instructions remain in this plan.
- Type consistency:
  - `predictionReadCooldownSeconds` is used consistently in config schema, UI, runner deps, and tests.
  - `completedPredictionSourceIds` and `predictionScanStartedAt` are used consistently in `WorkflowState`, storage schema, runner, and coordinator.
  - Rate-limit event shape remains backward-compatible because `sourceAgentId` is optional.
