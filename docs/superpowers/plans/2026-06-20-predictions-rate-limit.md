# Predictions Rate Limit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Predictions API throttling and long backoff recovery for exhausted EvoEvo `429` responses.

**Architecture:** Keep `cooldownSeconds` as the post-transaction receipt delay. Add two config fields for `from-opinion` pressure control: `memoryApiCooldownSeconds` and `rateLimitBackoffMinutes`. Predictions will pre-skip `viewer_has_intaken`, wait before `from-opinion`, classify exhausted `429` as a rate-limit runner result, and let the workflow coordinator schedule the next run without overriding manual Pause semantics.

**Tech Stack:** TypeScript, Chrome MV3 background worker, zod schemas, Vitest.

---

## File Structure

- `extension/src/shared/types.ts`: add config fields and a rate-limit prediction activity event.
- `extension/src/shared/messages.ts`: accept the new config fields from UI/background messages.
- `extension/src/background/storage.ts`: persist defaults for the new config fields.
- `extension/src/ui/popup.ts`: default, render, read, and validate the new settings.
- `extension/src/ui/popup.html`: add two numeric inputs near pacing controls.
- `extension/src/ui/workflow-events.ts`: format the rate-limit activity event.
- `extension/src/background/prediction-submitter.ts`: throttle before `from-opinion`, detect exhausted `429`, and return a typed rate-limit outcome.
- `extension/src/background/predictions-runner.ts`: propagate rate-limit outcome as a runner result.
- `extension/src/background/direct-runner.ts`: extend `RunnerResult` with a rate-limit variant.
- `extension/src/background/workflow-coordinator.ts`: schedule `nextRunAt` using `rateLimitBackoffMinutes` when Predictions returns rate-limited.
- Tests: `storage.test.ts`, `popup.test.ts`, `workflow-events.test.ts`, `prediction-submitter.test.ts`, `predictions-runner.test.ts`, `workflow-coordinator.test.ts`.

### Task 1: Config And UI Fields

**Files:**
- Modify: `extension/src/shared/types.ts`
- Modify: `extension/src/shared/messages.ts`
- Modify: `extension/src/background/storage.ts`
- Modify: `extension/src/ui/popup.ts`
- Modify: `extension/src/ui/popup.html`
- Test: `extension/tests/storage.test.ts`
- Test: `extension/tests/popup.test.ts`

- [ ] **Step 1: Write failing config tests**

In `extension/tests/storage.test.ts`, add assertions to the existing config/default tests so a config missing the new fields loads with:

```ts
expect(config?.memoryApiCooldownSeconds).toBe(1);
expect(config?.rateLimitBackoffMinutes).toBe(15);
```

In `extension/tests/popup.test.ts`, extend the static UI/config tests by reading `popup.html` and `popup.ts` exactly like the file already does, then add these assertions:

```ts
expect(html).toContain('id="memoryApiCooldownSeconds"');
expect(html).toContain('id="rateLimitBackoffMinutes"');
expect(source).toContain("memoryApiCooldownSeconds: clampInt");
expect(source).toContain("rateLimitBackoffMinutes: clampInt");
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
npm test -- storage popup
```

Expected: tests fail because fields do not exist in schema/UI code.

- [ ] **Step 3: Add config fields**

In `extension/src/shared/types.ts`, extend `ExtensionConfig`:

```ts
memoryApiCooldownSeconds: number;
rateLimitBackoffMinutes: number;
```

In `extension/src/shared/messages.ts` and `extension/src/background/storage.ts`, extend config schemas:

```ts
memoryApiCooldownSeconds: z.number().int().min(0).max(60).default(1),
rateLimitBackoffMinutes: z.number().int().min(1).max(1440).default(15),
```

In `DEFAULT_CONFIG` inside `extension/src/ui/popup.ts`, add:

```ts
memoryApiCooldownSeconds: 1,
rateLimitBackoffMinutes: 15,
```

In `fillConfig`, add:

```ts
setInput("memoryApiCooldownSeconds", config.memoryApiCooldownSeconds);
setInput("rateLimitBackoffMinutes", config.rateLimitBackoffMinutes);
```

In `currentConfig`, add:

```ts
memoryApiCooldownSeconds: clampInt(elValue("memoryApiCooldownSeconds"), DEFAULT_CONFIG.memoryApiCooldownSeconds, 0, 60),
rateLimitBackoffMinutes: clampInt(elValue("rateLimitBackoffMinutes"), DEFAULT_CONFIG.rateLimitBackoffMinutes, 1, 1440),
```

In `extension/src/ui/popup.html`, add two inputs near the existing cooldown field:

```html
<label for="memoryApiCooldownSeconds">Memory API cooldown (s)</label>
<input id="memoryApiCooldownSeconds" class="input" type="number" min="0" max="60" />
<label for="rateLimitBackoffMinutes">Rate limit backoff (m)</label>
<input id="rateLimitBackoffMinutes" class="input" type="number" min="1" max="1440" />
```

- [ ] **Step 4: Run tests to verify pass**

Run:

```bash
npm test -- storage popup
```

Expected: tests pass.

- [ ] **Step 5: Commit**

```bash
git add extension/src/shared/types.ts extension/src/shared/messages.ts extension/src/background/storage.ts extension/src/ui/popup.ts extension/src/ui/popup.html extension/tests/storage.test.ts extension/tests/popup.test.ts
git commit -m "feat(extension): add predictions rate limit config"
```

### Task 2: Throttle And Classify Rate Limits

**Files:**
- Modify: `extension/src/background/prediction-submitter.ts`
- Test: `extension/tests/prediction-submitter.test.ts`

- [ ] **Step 1: Write failing submitter tests**

In `extension/tests/prediction-submitter.test.ts`, add a test that injects `sleep`, calls `preparePredictionIntake` with `memoryApiCooldownSeconds: 1`, and asserts `sleep(1000)` occurs before `memoryFromOpinion`.

Add a second test where `memoryFromOpinion` throws `new EvoEvoHttpError("rate", 429, true)`, and assert the result is:

```ts
{ kind: "rate_limited", retryAfterMs: 15 * 60_000 }
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
npm test -- prediction-submitter
```

Expected: tests fail because `preparePredictionIntake` has no config/sleep args and no `rate_limited` result.

- [ ] **Step 3: Implement submitter changes**

In `extension/src/background/prediction-submitter.ts`, update `PreparedPredictionIntake`:

```ts
export type PreparedPredictionIntake =
  | { kind: "ready"; memory: FromOpinionResponse }
  | { kind: "already_adopted" }
  | { kind: "rate_limited"; retryAfterMs: number };
```

Update args:

```ts
config: Pick<ExtensionConfig, "memoryApiCooldownSeconds" | "rateLimitBackoffMinutes">;
sleep?: (ms: number) => Promise<void>;
```

Before calling `api.memoryFromOpinion`, add:

```ts
const delayMs = Math.max(0, args.config.memoryApiCooldownSeconds) * 1000;
if (delayMs > 0) await (args.sleep ?? sleep)(delayMs);
```

In the catch block, keep `isAlreadyAdoptedError` first. Then classify exhausted rate limits:

```ts
if (isRateLimitError(error)) {
  return {
    kind: "rate_limited",
    retryAfterMs: Math.max(1, args.config.rateLimitBackoffMinutes) * 60_000,
  };
}
```

Add helper:

```ts
function isRateLimitError(error: unknown): boolean {
  return error instanceof EvoEvoHttpError && error.status === 429;
}
```

Import `EvoEvoHttpError` and `ExtensionConfig`.

- [ ] **Step 4: Run test to verify pass**

Run:

```bash
npm test -- prediction-submitter
```

Expected: tests pass.

- [ ] **Step 5: Commit**

```bash
git add extension/src/background/prediction-submitter.ts extension/tests/prediction-submitter.test.ts
git commit -m "feat(extension): throttle prediction memory API"
```

### Task 3: Propagate Rate-Limited Runner Result And Activity

**Files:**
- Modify: `extension/src/shared/types.ts`
- Modify: `extension/src/ui/workflow-events.ts`
- Modify: `extension/src/background/direct-runner.ts`
- Modify: `extension/src/background/predictions-runner.ts`
- Modify: `extension/src/background/index.ts`
- Test: `extension/tests/workflow-events.test.ts`
- Test: `extension/tests/predictions-runner.test.ts`

- [ ] **Step 1: Write failing runner and event tests**

In `extension/tests/workflow-events.test.ts`, assert formatting:

```ts
expect(formatWorkflowEvent({
  type: "predictions-rate-limited",
  retryAfterMs: 900_000,
})).toBe("[Predictions] Rate limited. Retrying in 15 minutes.");
```

In `extension/tests/predictions-runner.test.ts`, add a test where `submitPrediction` returns:

```ts
{ kind: "rate_limited" as const, retryAfterMs: 900_000 }
```

Assert `runPredictions` resolves:

```ts
{ kind: "rate_limited", retryAfterMs: 900_000 }
```

Assert `onProgress` received:

```ts
{ activity: { type: "predictions-rate-limited", retryAfterMs: 900_000 } }
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
npm test -- workflow-events predictions-runner
```

Expected: tests fail because event/result variants do not exist.

- [ ] **Step 3: Implement event and result variants**

In `extension/src/shared/types.ts`, extend `PredictionActivityEvent`:

```ts
| { type: "predictions-rate-limited"; retryAfterMs: number }
```

In `extension/src/ui/workflow-events.ts`, format the event:

```ts
if (typed.type === "predictions-rate-limited") {
  const minutes = Math.max(1, Math.ceil(typed.retryAfterMs / 60_000));
  return `[Predictions] Rate limited. Retrying in ${minutes} minutes.`;
}
```

In `extension/src/background/direct-runner.ts`, extend `RunnerResult`:

```ts
| { kind: "rate_limited"; retryAfterMs: number };
```

In `extension/src/background/predictions-runner.ts`, handle rate limit after `submitPrediction`:

```ts
} else if (outcome.kind === "rate_limited") {
  await deps.onProgress({
    activity: { type: "predictions-rate-limited", retryAfterMs: outcome.retryAfterMs },
  });
  return { kind: "rate_limited", retryAfterMs: outcome.retryAfterMs };
}
```

Also handle the same outcome in `processDueRetries`.

In `extension/src/background/index.ts`, pass `config` into `preparePredictionIntake`, and if the prepared result is `rate_limited`, return it before calling `submitIntake`:

```ts
if (prepared.kind === "rate_limited") return prepared;
```

- [ ] **Step 4: Run tests to verify pass**

Run:

```bash
npm test -- workflow-events predictions-runner
```

Expected: tests pass.

- [ ] **Step 5: Commit**

```bash
git add extension/src/shared/types.ts extension/src/ui/workflow-events.ts extension/src/background/direct-runner.ts extension/src/background/predictions-runner.ts extension/src/background/index.ts extension/tests/workflow-events.test.ts extension/tests/predictions-runner.test.ts
git commit -m "feat(extension): surface prediction rate limits"
```

### Task 4: Schedule Long Backoff In Coordinator

**Files:**
- Modify: `extension/src/background/workflow-coordinator.ts`
- Test: `extension/tests/workflow-coordinator.test.ts`

- [ ] **Step 1: Write failing coordinator test**

In `extension/tests/workflow-coordinator.test.ts`, add a test where mode is `predictions`, `runPredictions` returns `{ kind: "rate_limited", retryAfterMs: 900_000 }`, and `now()` returns `1_000_000`.

Assert state after `await coordinator.idle()`:

```ts
expect(setup.state.status).toBe("running");
expect(setup.state.activeWorkflow).toBe(null);
expect(setup.state.nextRunAt).toBe(1_900_000);
expect(chrome.alarms.create).toHaveBeenCalledWith(WORKFLOW_ALARM_NAME, { when: 1_900_000 });
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
npm test -- workflow-coordinator
```

Expected: test fails because coordinator does not handle `rate_limited`.

- [ ] **Step 3: Implement rate-limit scheduling**

In `extension/src/background/workflow-coordinator.ts`, after the paused/failed handling for predictions:

```ts
if (result.kind === "rate_limited") {
  await this.scheduleRateLimitBackoff(result.retryAfterMs);
  return;
}
```

Add private method:

```ts
private async scheduleRateLimitBackoff(retryAfterMs: number): Promise<void> {
  const state = await this.deps.getState();
  if (state.status !== "running") return;
  state.activeWorkflow = null;
  state.nextRunAt = this.now() + retryAfterMs;
  await this.deps.setState(state);
  await chrome.alarms.create(WORKFLOW_ALARM_NAME, { when: state.nextRunAt });
}
```

Manual Pause already clears alarms and sets `status = "paused"`, so this method must only schedule when status is still `running`.

- [ ] **Step 4: Run test to verify pass**

Run:

```bash
npm test -- workflow-coordinator
```

Expected: tests pass.

- [ ] **Step 5: Commit**

```bash
git add extension/src/background/workflow-coordinator.ts extension/tests/workflow-coordinator.test.ts
git commit -m "feat(extension): reschedule after prediction rate limits"
```

### Task 5: Full Verification

**Files:**
- No new files.

- [ ] **Step 1: Run full test suite**

Run:

```bash
npm test
```

Expected: all test files pass.

- [ ] **Step 2: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: `tsc --noEmit` exits 0.

- [ ] **Step 3: Build extension**

Run:

```bash
npm run build
```

Expected: prints `Built dist/`.

- [ ] **Step 4: Check whitespace**

Run from worktree root:

```bash
git diff --check
```

Expected: no whitespace errors. Existing CRLF warnings are acceptable if present.

- [ ] **Step 5: Report remaining untracked artifacts**

Run:

```bash
git status --short
```

Expected: only intentional untracked artifacts remain, currently `extension/bap_retry.zip` is unrelated and should not be committed.
