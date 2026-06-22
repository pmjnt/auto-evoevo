# Predictions Workflow Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `409 already adopted` a visible successful skip while streaming prediction progress and synchronized counters to the side panel.

**Architecture:** Parse EvoEvo error bodies into a typed semantic predicate, adapt prediction preparation into explicit outcomes, and let the runner emit awaited structured progress. A focused background progress recorder persists counters and broadcasts activity; a pure UI formatter renders those events without introducing a durable event ledger.

**Tech Stack:** TypeScript, Chrome Extension Manifest V3 APIs, Vitest, happy-dom, Zod, ethers.

---

## File Map

- Modify `extension/src/background/evoevo-api.ts`: retain structured error bodies and classify exact `already adopted` responses.
- Modify `extension/src/background/intake-submitter.ts`: add the semantic `already_adopted` submission outcome.
- Modify `extension/src/background/predictions-runner.ts`: await progress, emit activity, and continue after semantic skips.
- Create `extension/src/background/prediction-submitter.ts`: translate API preparation results into runner outcomes and session-log semantic skips.
- Create `extension/src/background/prediction-progress.ts`: persist prediction counters and broadcast activity events.
- Modify `extension/src/background/index.ts`: wire the new submitter and progress recorder into the coordinator.
- Modify `extension/src/shared/types.ts`: define the cross-boundary prediction activity event contract.
- Create `extension/src/ui/workflow-events.ts`: format structured events into concise activity lines.
- Modify `extension/src/ui/popup.ts`: render prediction activity through the formatter.
- Modify/create focused tests under `extension/tests/` for every boundary above.

### Task 1: Classify EvoEvo `already adopted` Responses

**Files:**
- Modify: `extension/src/background/evoevo-api.ts:233-320`
- Test: `extension/tests/evoevo-api.test.ts`

- [ ] **Step 1: Write failing semantic-error tests**

Add the helper import and these tests inside `describe("EvoEvoApiClient", ...)`:

```ts
import {
  EvoEvoApiClient,
  EvoEvoAuthError,
  EvoEvoHttpError,
  isAlreadyAdoptedError,
} from "../src/background/evoevo-api.js";

it("classifies an exact 409 already adopted response", async () => {
  const fetchFn = vi.fn(async (called: string) => {
    if (called.endsWith("/v1/auth/nonce")) return jsonResponse({ message: "m", nonce: "n" });
    if (called.endsWith("/v1/auth/login")) {
      return jsonResponse({ token: TOKEN, expires_at: "3026-01-01T00:00:00Z" });
    }
    return jsonResponse({ error: "already adopted" }, 409);
  }) as unknown as typeof fetch;
  const client = new EvoEvoApiClient({ fetchFn });
  await client.ensureAuth(ADDR, async () => "0xsig");

  let captured: unknown;
  try {
    await client.memoryFromOpinion(8359, 4325811);
  } catch (error) {
    captured = error;
  }

  expect(isAlreadyAdoptedError(captured)).toBe(true);
  expect(captured).toMatchObject({
    status: 409,
    retryable: false,
    responseBody: { error: "already adopted" },
  });
});

it("does not classify other 409 responses as already adopted", () => {
  const error = new EvoEvoHttpError(
    "conflict",
    409,
    false,
    { error: "nonce conflict" },
  );
  expect(isAlreadyAdoptedError(error)).toBe(false);
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `npm test -- tests/evoevo-api.test.ts`

Expected: FAIL because `isAlreadyAdoptedError` and `responseBody` do not exist.

- [ ] **Step 3: Retain parsed error bodies and add the exact classifier**

Replace the non-OK response block and extend the error class:

```ts
if (!response.ok) {
  const text = await response.text().catch(() => "");
  const responseBody = parseErrorBody(text);
  throw new EvoEvoHttpError(
    `EvoEvo API ${method} ${url} -> ${response.status} ${response.statusText}: ${text.slice(0, 200)}`,
    response.status,
    retryable,
    responseBody,
  );
}

export class EvoEvoHttpError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
    readonly responseBody: unknown = null,
  ) {
    super(message);
    this.name = "EvoEvoHttpError";
  }
}

export function isAlreadyAdoptedError(error: unknown): boolean {
  if (!(error instanceof EvoEvoHttpError) || error.status !== 409) return false;
  const body = error.responseBody;
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
  const value = (body as Record<string, unknown>)["error"];
  return typeof value === "string" && value.trim().toLowerCase() === "already adopted";
}

function parseErrorBody(text: string): unknown {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
```

- [ ] **Step 4: Run the focused test and verify success**

Run: `npm test -- tests/evoevo-api.test.ts`

Expected: all `evoevo-api` tests PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/src/background/evoevo-api.ts extension/tests/evoevo-api.test.ts
git commit -m "fix(extension): classify already adopted responses"
```

### Task 2: Add Semantic Runner Outcomes And Awaited Activity

**Files:**
- Modify: `extension/src/shared/types.ts:41-55`
- Modify: `extension/src/background/intake-submitter.ts:41-45`
- Modify: `extension/src/background/predictions-runner.ts:13-193`
- Test: `extension/tests/predictions-runner.test.ts`

- [ ] **Step 1: Write a failing runner continuation test**

Import `PredictionProgressUpdate`, capture updates, and add this test:

```ts
import {
  runPredictions,
  type PredictionProgressUpdate,
} from "../src/background/predictions-runner.js";

it("logs and continues after an already-adopted prediction", async () => {
  const setup = harness();
  setup.predictionPages.set(3314, [
    page([prediction("already", 1), prediction("fresh", 2)], null),
  ]);
  const updates: PredictionProgressUpdate[] = [];
  setup.deps.onProgress = vi.fn(async (update) => { updates.push(update); });
  setup.deps.submitPrediction = vi.fn(async (
    _sourceAgentId: number,
    _targetAgentId: number,
    item: AgentPrediction,
  ) => item.predictionId === "already"
    ? { kind: "already_adopted" as const }
    : { kind: "approved" as const, txHash: "0xfresh" });

  await expect(
    runPredictions(setup.deps, { scan: "full", targetAgentId: 900 }),
  ).resolves.toEqual({ kind: "completed" });

  expect(setup.deps.submitPrediction).toHaveBeenCalledTimes(2);
  expect(await setup.deps.registry.has("already")).toBe(true);
  expect(updates).toContainEqual(expect.objectContaining({
    skippedDelta: 1,
    activity: {
      type: "prediction",
      phase: "already_adopted",
      sourceAgentId: 3314,
      targetAgentId: 900,
      predictionId: "already",
    },
  }));
  expect(updates).toContainEqual(expect.objectContaining({
    addedDelta: 1,
    activity: expect.objectContaining({
      type: "prediction",
      phase: "confirmed",
      txHash: "0xfresh",
    }),
  }));
});
```

Update the harness default callback and submitter signatures to return promises and accept `sourceAgentId`:

```ts
onProgress: async () => undefined,
submitPrediction: async (
  _sourceAgentId: number,
  _targetAgentId: number,
  item: AgentPrediction,
) => {
  submitted.push(item.predictionId);
  return { kind: "approved" as const, txHash: `0x${item.opinionId}` };
},
```

- [ ] **Step 2: Run the runner test and verify failure**

Run: `npm test -- tests/predictions-runner.test.ts`

Expected: FAIL on missing semantic outcome/progress types and incompatible callback signatures.

- [ ] **Step 3: Define the shared activity contract and semantic outcome**

Add to `shared/types.ts`:

```ts
export type PredictionActivityEvent =
  | { type: "predictions-loading" }
  | { type: "predictions-sources"; count: number }
  | {
      type: "prediction";
      phase: "submitting" | "confirmed" | "already_adopted" | "skipped" | "failed";
      sourceAgentId: number;
      targetAgentId: number;
      predictionId: string;
      txHash?: string;
      reason?: string;
    };
```

Add to `SubmitOutcome` in `intake-submitter.ts`:

```ts
export type SubmitOutcome =
  | { kind: "approved"; txHash: string }
  | { kind: "already_adopted" }
  | { kind: "dry_run" }
  | { kind: "ambiguous"; txHash: string; reason: string }
  | { kind: "rejected"; reason: string; retryable: boolean };
```

- [ ] **Step 4: Make runner progress awaited and emit every material phase**

Define and use this update type:

```ts
export type PredictionProgressUpdate = {
  sourceAgents?: number;
  scannedDelta?: number;
  addedDelta?: number;
  skippedDelta?: number;
  failedDelta?: number;
  activity?: PredictionActivityEvent;
};

// In PredictionsRunnerDeps:
submitPrediction: (
  sourceAgentId: number,
  targetAgentId: number,
  prediction: AgentPrediction,
) => Promise<SubmitOutcome>;
onProgress: (update: PredictionProgressUpdate) => Promise<void>;
```

Before source discovery and after discovery, emit:

```ts
await deps.onProgress({ activity: { type: "predictions-loading" } });
const sourceAgentIds = args.scan === "full"
  ? await collectAllSourceAgents(deps)
  : await collectIncrementalSourceAgents(deps);
await deps.onProgress({
  sourceAgents: sourceAgentIds.length,
  activity: { type: "predictions-sources", count: sourceAgentIds.length },
});
```

Replace the per-prediction submission branch with:

```ts
await deps.onProgress({ scannedDelta: 1 });
if (await deps.registry.has(prediction.predictionId)) continue;
sawUnknown = true;
const context = {
  sourceAgentId: args.sourceAgentId,
  targetAgentId: args.targetAgentId,
  predictionId: prediction.predictionId,
};
await deps.onProgress({
  activity: { type: "prediction", phase: "submitting", ...context },
});
const outcome = await deps.submitPrediction(
  args.sourceAgentId,
  args.targetAgentId,
  prediction,
);
if (outcome.kind === "approved") {
  completed.push(prediction.predictionId);
  await deps.onProgress({
    addedDelta: 1,
    activity: {
      type: "prediction",
      phase: "confirmed",
      ...context,
      txHash: outcome.txHash,
    },
  });
} else if (outcome.kind === "already_adopted") {
  await deps.registry.complete(prediction.predictionId);
  await deps.onProgress({
    skippedDelta: 1,
    activity: { type: "prediction", phase: "already_adopted", ...context },
  });
} else if (outcome.kind === "dry_run") {
  continue;
} else if (outcome.kind === "ambiguous") {
  await deps.registry.block(prediction.predictionId);
  await deps.onProgress({
    failedDelta: 1,
    activity: { type: "prediction", phase: "failed", ...context, reason: outcome.reason },
  });
  return { kind: "failed", reason: outcome.reason, global: true };
} else if (outcome.retryable) {
  await deps.registry.retry({
    predictionId: prediction.predictionId,
    opinionId: prediction.opinionId,
    sourceAgentId: args.sourceAgentId,
    targetAgentId: args.targetAgentId,
    attempts: 1,
    retryAfter: Date.now() + 30_000,
  });
  await deps.onProgress({
    failedDelta: 1,
    activity: { type: "prediction", phase: "failed", ...context, reason: outcome.reason },
  });
} else {
  completed.push(prediction.predictionId);
  await deps.onProgress({
    skippedDelta: 1,
    activity: { type: "prediction", phase: "skipped", ...context, reason: outcome.reason },
  });
}
```

Replace the outcome block in `processDueRetries` with:

```ts
const context = {
  sourceAgentId: item.sourceAgentId,
  targetAgentId: item.targetAgentId,
  predictionId: item.predictionId,
};
await deps.onProgress({
  activity: { type: "prediction", phase: "submitting", ...context },
});
const outcome = await deps.submitPrediction(
  item.sourceAgentId,
  item.targetAgentId,
  {
    predictionId: item.predictionId,
    opinionId: item.opinionId,
    createdAt: "",
  },
);
if (outcome.kind === "approved") {
  await deps.registry.complete(item.predictionId);
  await deps.registry.removeRetry(item.predictionId);
  await deps.onProgress({
    addedDelta: 1,
    activity: {
      type: "prediction",
      phase: "confirmed",
      ...context,
      txHash: outcome.txHash,
    },
  });
} else if (outcome.kind === "already_adopted") {
  await deps.registry.complete(item.predictionId);
  await deps.registry.removeRetry(item.predictionId);
  await deps.onProgress({
    skippedDelta: 1,
    activity: { type: "prediction", phase: "already_adopted", ...context },
  });
} else if (outcome.kind === "ambiguous") {
  await deps.registry.block(item.predictionId);
  await deps.onProgress({
    failedDelta: 1,
    activity: { type: "prediction", phase: "failed", ...context, reason: outcome.reason },
  });
  return { kind: "failed", reason: outcome.reason, global: true };
} else if (outcome.kind === "rejected" && outcome.retryable) {
  await deps.registry.retry({ ...item, attempts: item.attempts + 1 });
  await deps.onProgress({
    failedDelta: 1,
    activity: { type: "prediction", phase: "failed", ...context, reason: outcome.reason },
  });
} else if (outcome.kind === "rejected") {
  await deps.registry.complete(item.predictionId);
  await deps.registry.removeRetry(item.predictionId);
  await deps.onProgress({
    skippedDelta: 1,
    activity: { type: "prediction", phase: "skipped", ...context, reason: outcome.reason },
  });
}
```

- [ ] **Step 5: Run the runner tests and verify success**

Run: `npm test -- tests/predictions-runner.test.ts`

Expected: all predictions runner tests PASS, including continuation after `already_adopted`.

- [ ] **Step 6: Commit**

```bash
git add extension/src/shared/types.ts extension/src/background/intake-submitter.ts extension/src/background/predictions-runner.ts extension/tests/predictions-runner.test.ts
git commit -m "feat(extension): stream prediction activity outcomes"
```

### Task 3: Prepare Predictions And Record Progress In The Background

**Files:**
- Create: `extension/src/background/prediction-submitter.ts`
- Create: `extension/src/background/prediction-progress.ts`
- Modify: `extension/src/background/index.ts:1-127`
- Test: `extension/tests/prediction-submitter.test.ts`
- Test: `extension/tests/prediction-progress.test.ts`

- [ ] **Step 1: Write failing tests for semantic preparation and progress persistence**

Create `prediction-submitter.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { EvoEvoHttpError } from "../src/background/evoevo-api.js";
import { preparePredictionIntake } from "../src/background/prediction-submitter.js";

describe("preparePredictionIntake", () => {
  it("logs and returns already_adopted for the exact semantic conflict", async () => {
    const append = vi.fn(async () => undefined);
    const api = {
      memoryFromOpinion: vi.fn(async () => {
        throw new EvoEvoHttpError("already adopted", 409, false, {
          error: "already adopted",
        });
      }),
    };

    await expect(preparePredictionIntake({
      api,
      log: { append },
      sourceAgentId: 3314,
      targetAgentId: 8359,
      predictionId: "859",
      opinionId: 4325811,
    })).resolves.toEqual({ kind: "already_adopted" });
    expect(append).toHaveBeenCalledWith(expect.objectContaining({
      status: "skipped",
      reason: "Predictions source 3314 prediction 859: already adopted",
    }));
  });

  it("rethrows unrelated conflicts", async () => {
    const error = new EvoEvoHttpError("other", 409, false, { error: "other" });
    await expect(preparePredictionIntake({
      api: { memoryFromOpinion: vi.fn(async () => { throw error; }) },
      log: { append: vi.fn(async () => undefined) },
      sourceAgentId: 3314,
      targetAgentId: 8359,
      predictionId: "859",
      opinionId: 4325811,
    })).rejects.toBe(error);
  });
});
```

Create `prediction-progress.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { recordPredictionProgress } from "../src/background/prediction-progress.js";
import { DEFAULT_WORKFLOW_STATE } from "../src/background/storage.js";

it("persists deltas and broadcasts activity", async () => {
  let state = structuredClone(DEFAULT_WORKFLOW_STATE);
  const sendEvent = vi.fn();
  await recordPredictionProgress({
    sourceAgents: 20,
    scannedDelta: 1,
    skippedDelta: 1,
    activity: {
      type: "prediction",
      phase: "already_adopted",
      sourceAgentId: 3314,
      targetAgentId: 8359,
      predictionId: "859",
    },
  }, {
    getState: async () => state,
    setState: async (next) => { state = structuredClone(next); },
    sendEvent,
  });

  expect(state.counters).toMatchObject({
    sourceAgents: 20,
    predictionsScanned: 1,
    skipped: 1,
  });
  expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({
    phase: "already_adopted",
  }));
});
```

- [ ] **Step 2: Run both tests and verify failure**

Run: `npm test -- tests/prediction-submitter.test.ts tests/prediction-progress.test.ts`

Expected: FAIL because both modules are missing.

- [ ] **Step 3: Implement the semantic preparation boundary**

Create `prediction-submitter.ts`:

```ts
import type { EvoEvoApiClient, FromOpinionResponse } from "./evoevo-api.js";
import { isAlreadyAdoptedError } from "./evoevo-api.js";
import { makeAttemptLog } from "./intake-submitter.js";
import type { AttemptLog } from "../shared/types.js";

export type PreparedPredictionIntake =
  | { kind: "ready"; memory: FromOpinionResponse }
  | { kind: "already_adopted" };

export async function preparePredictionIntake(args: {
  api: Pick<EvoEvoApiClient, "memoryFromOpinion">;
  log: { append: (entry: AttemptLog) => Promise<void> };
  sourceAgentId: number;
  targetAgentId: number;
  predictionId: string;
  opinionId: number;
}): Promise<PreparedPredictionIntake> {
  try {
    const memory = await args.api.memoryFromOpinion(args.targetAgentId, args.opinionId);
    return { kind: "ready", memory };
  } catch (error) {
    if (!isAlreadyAdoptedError(error)) throw error;
    await args.log.append(makeAttemptLog({
      status: "skipped",
      reason: `Predictions source ${args.sourceAgentId} prediction ${args.predictionId}: already adopted`,
    }));
    return { kind: "already_adopted" };
  }
}
```

- [ ] **Step 4: Implement the awaited progress recorder**

Create `prediction-progress.ts`:

```ts
import type { PredictionProgressUpdate } from "./predictions-runner.js";
import type { WorkflowState } from "../shared/types.js";

export async function recordPredictionProgress(
  update: PredictionProgressUpdate,
  deps: {
    getState: () => Promise<WorkflowState>;
    setState: (state: WorkflowState) => Promise<void>;
    sendEvent: (event: NonNullable<PredictionProgressUpdate["activity"]>) => void;
  },
): Promise<void> {
  const state = await deps.getState();
  if (update.sourceAgents !== undefined) state.counters.sourceAgents = update.sourceAgents;
  state.counters.predictionsScanned += update.scannedDelta ?? 0;
  state.counters.added += update.addedDelta ?? 0;
  state.counters.skipped += update.skippedDelta ?? 0;
  state.counters.failed += update.failedDelta ?? 0;
  await deps.setState(state);
  if (update.activity) deps.sendEvent(update.activity);
}
```

- [ ] **Step 5: Wire both boundaries into `background/index.ts`**

Add imports:

```ts
import { preparePredictionIntake } from "./prediction-submitter.js";
import { recordPredictionProgress } from "./prediction-progress.js";
```

Replace the Predictions callbacks with:

```ts
onProgress: async (update) => await recordPredictionProgress(update, {
  getState: getWorkflowState,
  setState: setWorkflowState,
  sendEvent: sendWorkflowEvent,
}),
submitPrediction: async (sourceAgentId, agentId, prediction) => {
  const prepared = await preparePredictionIntake({
    api: evoEvoApi,
    log,
    sourceAgentId,
    targetAgentId: agentId,
    predictionId: prediction.predictionId,
    opinionId: prediction.opinionId,
  });
  if (prepared.kind === "already_adopted") return prepared;
  return await submitIntake(prepared.memory.reasoning_intake_with_sig, {
    config: { ...config, agentId },
    wallet: {
      address: wallet.address,
      signTransaction: (tx) => wallet.signTransaction(tx),
    },
    rpc,
    log,
  });
},
```

- [ ] **Step 6: Run focused and neighboring tests**

Run: `npm test -- tests/prediction-submitter.test.ts tests/prediction-progress.test.ts tests/predictions-runner.test.ts tests/background-router.test.ts tests/session-log.test.ts`

Expected: all listed tests PASS.

- [ ] **Step 7: Commit**

```bash
git add extension/src/background/prediction-submitter.ts extension/src/background/prediction-progress.ts extension/src/background/index.ts extension/tests/prediction-submitter.test.ts extension/tests/prediction-progress.test.ts
git commit -m "feat(extension): persist and broadcast prediction progress"
```

### Task 4: Render Prediction Activity In The Side Panel

**Files:**
- Create: `extension/src/ui/workflow-events.ts`
- Modify: `extension/src/ui/popup.ts:354-389`
- Create: `extension/tests/workflow-events.test.ts`
- Modify: `extension/tests/popup.test.ts`

- [ ] **Step 1: Write failing formatter tests**

Create `workflow-events.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatWorkflowEvent } from "../src/ui/workflow-events.js";

describe("formatWorkflowEvent", () => {
  it("formats prediction lifecycle events", () => {
    expect(formatWorkflowEvent({ type: "predictions-loading" })).toBe(
      "[Predictions] Loading Square feed...",
    );
    expect(formatWorkflowEvent({ type: "predictions-sources", count: 20 })).toBe(
      "[Predictions] Found 20 source agents",
    );
    expect(formatWorkflowEvent({
      type: "prediction",
      phase: "already_adopted",
      sourceAgentId: 3314,
      targetAgentId: 8359,
      predictionId: "859",
    })).toBe(
      "[Predictions] Source 3314 - Prediction 859 - Already added, skipped",
    );
    expect(formatWorkflowEvent({
      type: "prediction",
      phase: "confirmed",
      sourceAgentId: 60062,
      targetAgentId: 8359,
      predictionId: "852",
      txHash: "0x1234567890abcdef",
    })).toBe(
      "[Predictions] Source 60062 - Prediction 852 - Confirmed - 0x1234567890...",
    );
  });
});
```

- [ ] **Step 2: Run the formatter test and verify failure**

Run: `npm test -- tests/workflow-events.test.ts`

Expected: FAIL because `workflow-events.ts` is missing.

- [ ] **Step 3: Implement the pure formatter**

Create `workflow-events.ts`:

```ts
import type { PredictionActivityEvent } from "../shared/types.js";

export function formatWorkflowEvent(event: Record<string, unknown>): string | null {
  if (event.type === "predictions-loading") return "[Predictions] Loading Square feed...";
  if (event.type === "predictions-sources") {
    return `[Predictions] Found ${String(event.count)} source agents`;
  }
  if (event.type === "prediction") {
    const typed = event as PredictionActivityEvent & { type: "prediction" };
    const prefix = `[Predictions] Source ${typed.sourceAgentId} - Prediction ${typed.predictionId}`;
    switch (typed.phase) {
      case "submitting": return `${prefix} - Submitting...`;
      case "confirmed": return `${prefix} - Confirmed - ${shortHash(typed.txHash)}`;
      case "already_adopted": return `${prefix} - Already added, skipped`;
      case "skipped": return `${prefix} - Skipped${typed.reason ? ` - ${typed.reason}` : ""}`;
      case "failed": return `${prefix} - Failed${typed.reason ? ` - ${typed.reason}` : ""}`;
    }
  }
  return null;
}

function shortHash(hash: string | undefined): string {
  if (!hash) return "unknown tx";
  return hash.length > 12 ? `${hash.slice(0, 12)}...` : hash;
}
```

- [ ] **Step 4: Route popup runtime events through the formatter**

Import the formatter:

```ts
import { formatWorkflowEvent } from "./workflow-events.js";
```

At the start of the runtime listener, add:

```ts
const formatted = formatWorkflowEvent(event);
if (formatted !== null) {
  appendEventLog(formatted);
  void refreshStatus();
  return;
}
```

Keep the existing Feed event switch as the fallback. Add a static assertion to `popup.test.ts` so the production popup module cannot silently drop the formatter integration:

```ts
it("routes workflow activity through the event formatter", () => {
  const popupSource = readFileSync(resolve("src/ui/popup.ts"), "utf8");
  expect(popupSource).toContain("formatWorkflowEvent(event)");
});
```

- [ ] **Step 5: Run UI tests and verify success**

Run: `npm test -- tests/workflow-events.test.ts tests/popup.test.ts`

Expected: both test files PASS.

- [ ] **Step 6: Commit**

```bash
git add extension/src/ui/workflow-events.ts extension/src/ui/popup.ts extension/tests/workflow-events.test.ts extension/tests/popup.test.ts
git commit -m "feat(extension): show live prediction activity"
```

### Task 5: Verify The Complete Extension

**Files:**
- Verify only; modify implementation files only if a failing check identifies a defect covered by this spec.

- [ ] **Step 1: Run the complete test suite**

Run: `npm test`

Expected: all test files and tests PASS.

- [ ] **Step 2: Run TypeScript validation**

Run: `npm run typecheck`

Expected: exit code 0 with no TypeScript errors.

- [ ] **Step 3: Build the unpacked Chrome extension**

Run: `npm run build`

Expected: exit code 0 and refreshed output under `extension/dist/`.

- [ ] **Step 4: Manually verify in Chrome**

Reload the unpacked extension from `extension/dist`, select target agent `8359`, and start Predictions against data containing an already-adopted opinion.

Expected visible sequence:

```text
[Predictions] Loading Square feed...
[Predictions] Found <N> source agents
[Predictions] Source <source> - Prediction <id> - Submitting...
[Predictions] Source <source> - Prediction <id> - Already added, skipped
```

Expected behavior: Skipped increments, the next prediction starts, and no transaction is broadcast for the already-adopted item.

- [ ] **Step 5: Review the final diff and commit any verification-only corrections**

```bash
git diff --check
git status --short
```

Expected: no whitespace errors and no unintended files. If verification required a scoped correction, commit it with:

```bash
git add extension/src extension/tests
git commit -m "fix(extension): finalize prediction activity handling"
```
