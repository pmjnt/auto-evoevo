# Dual Workflow Prediction Intake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add sequential Feed and Square Predictions workflows with shared prediction deduplication, persistent Start/Pause scheduling, configurable scan intervals, and a polished two-workflow extension console.

**Architecture:** A persistent workflow coordinator owns one global execution lock and schedules cycles with `chrome.alarms`. Focused Feed and Predictions runners share authentication and a single intake submitter; checkpoint and registry state live in `chrome.storage.local`, while the popup communicates through typed runtime messages.

**Tech Stack:** TypeScript, Chrome Extension Manifest V3, Chrome Storage and Alarms APIs, ethers 6, Zod, Vitest 3, happy-dom, esbuild.

---

## File Structure

Create or change these focused units:

- `extension/src/shared/types.ts`: workflow modes, config fields, persisted state, progress, and public status types.
- `extension/src/shared/messages.ts`: typed run/pause/status/config runtime commands.
- `extension/src/background/storage.ts`: config migration plus workflow-state and prediction-registry persistence.
- `extension/src/background/evoevo-api.ts`: normalized paginated Square and Predictions API methods.
- `extension/src/background/intake-submitter.ts`: reusable guard/sign/broadcast/receipt transaction boundary extracted from the Feed runner.
- `extension/src/background/direct-runner.ts`: one explicit Feed target per invocation.
- `extension/src/background/feed-workflow.ts`: enumerate wallet-owned agents and run Feed sequentially.
- `extension/src/background/prediction-registry.ts`: shared immutable-ID registry and bounded retry queue operations.
- `extension/src/background/predictions-runner.ts`: incremental and full scans plus prediction-to-memory intake.
- `extension/src/background/workflow-coordinator.ts`: persistent state machine, global lock, pause boundary, alarms, and ordered modes.
- `extension/src/background/index.ts`: construct dependencies and route runtime messages into the coordinator.
- `extension/src/ui/popup.html`: compact operational-console markup and visual system.
- `extension/src/ui/popup.ts`: status rendering, tabs, config validation, and workflow commands.
- `extension/manifest.json`: add the `alarms` permission.
- `extension/tests/fixtures/chrome-api.ts`: fake alarms and resettable runtime listeners.
- Focused tests alongside the existing test suite for every new unit.

## Task 1: Define Workflow Contracts and Persistent Defaults

**Files:**
- Modify: `extension/src/shared/types.ts`
- Modify: `extension/src/shared/messages.ts`
- Modify: `extension/src/background/storage.ts`
- Modify: `extension/tests/messages.test.ts`
- Modify: `extension/tests/storage.test.ts`

- [ ] **Step 1: Write failing config-migration and message-schema tests**

Add tests that require old configs to migrate to the new interval defaults and require the three explicit run commands:

```ts
it("defaults workflow intervals for an old stored config", async () => {
  const { repeatIntervalMinutes: _repeat, reconciliationIntervalMinutes: _full, ...old } =
    fakeConfig;
  await chrome.storage.local.set({ config: old });
  expect(await getConfig()).toMatchObject({
    repeatIntervalMinutes: 120,
    reconciliationIntervalMinutes: 1440,
  });
});

it.each(["run-feed", "run-predictions", "run-both"] as const)(
  "parses %s",
  (type) => expect(parseMessage({ type }).type).toBe(type),
);

it("rejects an interval below 30 minutes", () => {
  expect(() => parseMessage({
    type: "set-config",
    config: { ...fakeConfig, repeatIntervalMinutes: 29 },
  })).toThrow();
});
```

- [ ] **Step 2: Run focused tests and verify the expected failure**

Run: `npm test -- --run tests/messages.test.ts tests/storage.test.ts`

Expected: FAIL because the interval properties and new commands do not exist.

- [ ] **Step 3: Add the exact shared contracts**

Add these types and fields, keeping `agentId` as the selected Predictions target for storage compatibility:

```ts
export type WorkflowMode = "feed" | "predictions" | "both";
export type WorkflowName = "feed" | "predictions";
export type WorkflowStatus = "idle" | "running" | "paused" | "error";

export type WorkflowCounters = {
  ownedAgents: number;
  feedAgentsCompleted: number;
  sourceAgents: number;
  predictionsScanned: number;
  added: number;
  skipped: number;
  failed: number;
  registryBytes: number;
};

export type RetryItem = {
  predictionId: string;
  opinionId: number;
  sourceAgentId: number;
  targetAgentId: number;
  attempts: number;
  retryAfter: number;
};

export type WorkflowState = {
  version: 1;
  mode: WorkflowMode | null;
  status: WorkflowStatus;
  activeWorkflow: WorkflowName | null;
  nextRunAt: number | null;
  lastIncrementalAt: number | null;
  lastReconciliationAt: number | null;
  feedAgentIndex: number;
  feedTab: "recommended" | "weekly" | "monthly" | "all_time" | null;
  squareOffset: number;
  sourceAgentIds: number[];
  predictionOffsets: Record<string, number>;
  retryQueue: RetryItem[];
  blockedPredictionIds: string[];
  counters: WorkflowCounters;
  lastError: string | null;
};
```

Extend `ExtensionConfig` and both Zod config schemas with:

```ts
repeatIntervalMinutes: z.number().int().min(30).max(1440).default(120),
reconciliationIntervalMinutes: z.number().int().min(30).max(1440).default(1440),
```

Replace `start`, `resume`, and `stop` UI command schemas with:

```ts
export const runFeedSchema = z.object({ type: z.literal("run-feed") });
export const runPredictionsSchema = z.object({ type: z.literal("run-predictions") });
export const runBothSchema = z.object({ type: z.literal("run-both") });
```

Add `getWorkflowState()`, `setWorkflowState()`, `getPredictionIds()`, and `setPredictionIds()` to storage. Use keys `workflowState` and `predictionIds`, parse stored state with Zod, return explicit defaults when absent, sort and deduplicate IDs before writing, and allow storage errors to propagate.

Export this testable default:

```ts
export const DEFAULT_WORKFLOW_STATE: WorkflowState = {
  version: 1,
  mode: null,
  status: "idle",
  activeWorkflow: null,
  nextRunAt: null,
  lastIncrementalAt: null,
  lastReconciliationAt: null,
  feedAgentIndex: 0,
  feedTab: null,
  squareOffset: 0,
  sourceAgentIds: [],
  predictionOffsets: {},
  retryQueue: [],
  blockedPredictionIds: [],
  counters: {
    ownedAgents: 0,
    feedAgentsCompleted: 0,
    sourceAgents: 0,
    predictionsScanned: 0,
    added: 0,
    skipped: 0,
    failed: 0,
    registryBytes: 0,
  },
  lastError: null,
};
```

- [ ] **Step 4: Run focused tests**

Run: `npm test -- --run tests/messages.test.ts tests/storage.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit contracts and persistence**

```powershell
git add extension/src/shared/types.ts extension/src/shared/messages.ts extension/src/background/storage.ts extension/tests/messages.test.ts extension/tests/storage.test.ts
git commit -m "feat(extension): add workflow state contracts"
```

## Task 2: Verify and Implement Paginated EvoEvo API Contracts

**Files:**
- Modify: `extension/src/background/evoevo-api.ts`
- Modify: `extension/tests/evoevo-api.test.ts`
- Create: `extension/tests/fixtures/square-feed-page.json`
- Create: `extension/tests/fixtures/agent-predictions-page.json`

- [ ] **Step 1: Capture authenticated response fixtures before writing the parser**

From the logged-in EvoEvo Explore page, capture the response body for these two requests in Chrome DevTools Network:

```text
GET https://api.evoevo.ai/v1/square/feed?limit=20&status=all&min_settled_predictions=3&type=agent&chain_id=16661
GET https://api.evoevo.ai/v1/agents/3314/predictions?limit=20&chain_id=16661
```

Save only the JSON response bodies as the two fixture files. Remove wallet addresses, free-form text, and image URLs not needed by parsing tests. Do not save request headers, cookies, or Bearer tokens. Confirm each fixture still contains the real item envelope, immutable ID, agent/opinion relationship, and pagination metadata.

- [ ] **Step 2: Write failing API tests from the captured shapes**

The tests must assert normalized output rather than leaking the raw envelope:

```ts
function authenticatedClientReturning(body: unknown): EvoEvoApiClient {
  const fetchFn = vi.fn(async (url: string) => {
    if (url.endsWith("/v1/auth/nonce")) return jsonResponse({ message: "m", nonce: "n" });
    if (url.endsWith("/v1/auth/login")) {
      return jsonResponse({ token: TOKEN, expires_at: "3026-01-01T00:00:00Z" });
    }
    return jsonResponse(body);
  }) as unknown as typeof fetch;
  const client = new EvoEvoApiClient({ fetchFn });
  return client;
}

it("normalizes a Square agent page and its continuation", async () => {
  const client = authenticatedClientReturning(squareFixture);
  await client.ensureAuth(ADDR, async () => "0xsig");
  const page = await client.listSquareAgents({ chainId: 16661, limit: 20 });
  expect(page.items[0]).toEqual(expect.objectContaining({
    id: expect.any(Number),
    name: expect.any(String),
  }));
  expect(page.next).toEqual(expect.anything());
});

it("normalizes prediction and opinion IDs", async () => {
  const client = authenticatedClientReturning(predictionsFixture);
  await client.ensureAuth(ADDR, async () => "0xsig");
  const page = await client.listAgentPredictions({
    sourceAgentId: 3314,
    chainId: 16661,
    limit: 20,
  });
  expect(page.items[0]).toEqual(expect.objectContaining({
    predictionId: expect.any(String),
    opinionId: expect.any(Number),
    createdAt: expect.any(String),
  }));
});
```

Also test a repeated-page guard: if a server ignores a continuation and returns the same first/last IDs, pagination must throw instead of looping forever. Add tests proving one automatic SIWE re-authentication after a 401 and bounded retry for network errors, HTTP 429, and HTTP 5xx; a second 401 or exhausted transient retry must throw a typed error.

- [ ] **Step 3: Run the tests and verify failure**

Run: `npm test -- --run tests/evoevo-api.test.ts`

Expected: FAIL because the new methods and normalized page types do not exist.

- [ ] **Step 4: Implement typed page normalization and continuation**

Add public normalized types:

```ts
export type PageRequest = { cursor?: string; offset?: number };
export type ApiPage<T> = {
  items: T[];
  next: PageRequest | null;
  fingerprint: string;
};
export type SquareAgent = { id: number; name: string };
export type AgentPrediction = {
  predictionId: string;
  opinionId: number;
  createdAt: string;
};

export class EvoEvoHttpError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) { super(message); }
}
```

Implement `listSquareAgents()` and `listAgentPredictions()` with `URLSearchParams`. Match the exact captured envelope and pagination field names. Prefer a server cursor when present; otherwise advance `offset` by returned item count. Build `fingerprint` from the first and last immutable IDs and reject the same non-null fingerprint twice in the caller. Do not derive any ID from array position or display rank.

Store the latest address/sign callback in an in-memory auth context when `ensureAuth()` succeeds. In `requestJson()`, a first 401 clears auth, performs SIWE once, and retries the request; a second 401 throws `EvoEvoAuthError`. Retry network failures, 429, and 5xx at most three times with injected sleep/random dependencies and capped exponential backoff. Throw `EvoEvoHttpError(status, retryable)` after exhaustion so runners can distinguish global transient failures from permanent item failures.

- [ ] **Step 5: Run API tests**

Run: `npm test -- --run tests/evoevo-api.test.ts`

Expected: PASS, including real fixture parsing and Authorization header assertions.

- [ ] **Step 6: Commit the verified API contract**

```powershell
git add extension/src/background/evoevo-api.ts extension/tests/evoevo-api.test.ts extension/tests/fixtures/square-feed-page.json extension/tests/fixtures/agent-predictions-page.json
git commit -m "feat(extension): add Square prediction pagination API"
```

## Task 3: Extract the Shared Intake Submitter

**Files:**
- Create: `extension/src/background/intake-submitter.ts`
- Create: `extension/tests/intake-submitter.test.ts`
- Modify: `extension/src/background/direct-runner.ts`
- Modify: `extension/tests/direct-runner.test.ts`

- [ ] **Step 1: Write submitter contract tests**

Move the existing guard, gas, nonce retry, signing, broadcast, and receipt expectations into focused tests. Require this public result:

```ts
export type SubmitOutcome =
  | { kind: "approved"; txHash: string }
  | { kind: "dry_run" }
  | { kind: "ambiguous"; txHash: string; reason: string }
  | { kind: "rejected"; reason: string; retryable: boolean };
```

Add tests named:

```text
approves only after a successful receipt
returns dry_run without signing
re-signs once with the refetched nonce
returns ambiguous with the broadcast hash on receipt timeout
marks a reverted receipt permanent
rejects post-jitter fees above maxFeeNative
```

- [ ] **Step 2: Run the new test and verify failure**

Run: `npm test -- --run tests/intake-submitter.test.ts`

Expected: FAIL because `intake-submitter.ts` does not exist.

- [ ] **Step 3: Extract implementation without behavior changes**

Move `applyGasPriceJitter`, `submitIntake`, `SubmitOutcome`, and their private helpers from `direct-runner.ts` into `intake-submitter.ts`. Export:

```ts
export type IntakeSubmitterDeps = Pick<DirectRunnerDeps,
  "config" | "wallet" | "rpc" | "log" | "random"
>;

export async function submitIntake(
  payload: ReasoningIntakeWithSig,
  deps: IntakeSubmitterDeps,
): Promise<SubmitOutcome>;
```

Map a pre-broadcast transport failure to `retryable: true`. Once a transaction hash exists, map receipt timeout to `ambiguous` and never automatically submit the same intake again. Map guard rejection and on-chain revert to `retryable: false`. Keep attempt logging byte-for-byte compatible with existing status counters.

- [ ] **Step 4: Make Feed call the extracted submitter and run regression tests**

Run: `npm test -- --run tests/intake-submitter.test.ts tests/direct-runner.test.ts`

Expected: PASS with the existing 12 direct-runner tests still green.

- [ ] **Step 5: Commit the extraction**

```powershell
git add extension/src/background/intake-submitter.ts extension/src/background/direct-runner.ts extension/tests/intake-submitter.test.ts extension/tests/direct-runner.test.ts
git commit -m "refactor(extension): share memory intake submission"
```

## Task 4: Run Feed Sequentially for Every Owned Agent

**Files:**
- Modify: `extension/src/background/direct-runner.ts`
- Create: `extension/src/background/feed-workflow.ts`
- Create: `extension/tests/feed-workflow.test.ts`
- Modify: `extension/tests/direct-runner.test.ts`

- [ ] **Step 1: Write failing sequential fan-out tests**

Use a fake API returning agents `11`, `22`, and `33`, and a fake single-agent runner that records calls:

```ts
it("runs every owned agent in wallet order without overlap", async () => {
  const calls: number[] = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  await runFeedWorkflow({
    api: {
      listAgents: vi.fn(async () => [
        { id: 11, name: "A", active: true, onchain_identity: null },
        { id: 22, name: "B", active: true, onchain_identity: null },
        { id: 33, name: "C", active: true, onchain_identity: null },
      ]),
    },
    walletAddress: "0x" + "11".repeat(20),
    chainId: 16661,
    isPaused: () => false,
    onProgress: () => undefined,
    runAgent: async (agentId) => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      calls.push(agentId);
      concurrent -= 1;
      return { kind: "completed" };
    },
  });
  expect(calls).toEqual([11, 22, 33]);
  expect(maxConcurrent).toBe(1);
});
```

Add tests that Pause prevents the next agent, an ineligible agent is reported as skipped without aborting later agents, and a global auth error stops the workflow.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test -- --run tests/feed-workflow.test.ts tests/direct-runner.test.ts`

Expected: FAIL because Feed still reads `config.agentId` and no fan-out runner exists.

- [ ] **Step 3: Make the direct runner explicit and result-bearing**

Change the entry point to:

```ts
export type RunnerResult =
  | { kind: "completed" }
  | { kind: "paused" }
  | { kind: "failed"; reason: string; global: boolean };

export async function runFeedForAgent(
  deps: DirectRunnerDeps,
  agentId: number,
): Promise<RunnerResult>;
```

Use the explicit `agentId` in `listFeed()` and `memoryFromOpinion()`. Do not mutate the shared config. Return structured failure information while continuing to emit existing progress events.

- [ ] **Step 4: Implement `runFeedWorkflow`**

```ts
export async function runFeedWorkflow(deps: FeedWorkflowDeps): Promise<RunnerResult> {
  const agents = await deps.api.listAgents(deps.walletAddress, deps.chainId);
  deps.onProgress({ ownedAgents: agents.length, completed: 0 });
  for (const [index, agent] of agents.entries()) {
    if (deps.isPaused()) return { kind: "paused" };
    const result = await deps.runAgent(agent.id);
    deps.onProgress({ ownedAgents: agents.length, completed: index + 1 });
    if (result.kind === "failed" && result.global) return result;
  }
  return { kind: "completed" };
}
```

The production dependency calls `runFeedForAgent`; tests inject a recorder. Emit the active agent index and every Feed tab transition through `onProgress`; the coordinator persists them as `feedAgentIndex` and `feedTab`. On recovery, restarting the current agent is safe because Feed requests use `include_intaken=false`, while already confirmed opinions are skipped.

- [ ] **Step 5: Run Feed tests**

Run: `npm test -- --run tests/feed-workflow.test.ts tests/direct-runner.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit Feed fan-out**

```powershell
git add extension/src/background/direct-runner.ts extension/src/background/feed-workflow.ts extension/tests/direct-runner.test.ts extension/tests/feed-workflow.test.ts
git commit -m "feat(extension): run Feed for all owned agents"
```

## Task 5: Add Shared Prediction Registry and Retry Policy

**Files:**
- Create: `extension/src/background/prediction-registry.ts`
- Create: `extension/tests/prediction-registry.test.ts`
- Modify: `extension/src/background/storage.ts`
- Modify: `extension/tests/storage.test.ts`

- [ ] **Step 1: Write failing registry tests**

Cover global target-independent membership, permanent completion, target-bound retries, deduplication, retry limit, and storage failures:

```ts
it("does not replay a completed ID after the target changes", async () => {
  await registry.complete("p-100");
  expect(await registry.has("p-100")).toBe(true);
  expect(await registry.claim("p-100", 999)).toBe(false);
});

it("keeps retry target fixed to the target at discovery", async () => {
  await registry.retry({
    predictionId: "p-101", opinionId: 55, sourceAgentId: 3314,
    targetAgentId: 700, attempts: 1, retryAfter: 123,
  });
  expect((await registry.dueRetries(123))[0]!.targetAgentId).toBe(700);
});

it("blocks an ambiguous broadcast from automatic replay", async () => {
  await registry.block("p-102");
  expect(await registry.has("p-102")).toBe(true);
  expect(await registry.isBlocked("p-102")).toBe(true);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test -- --run tests/prediction-registry.test.ts tests/storage.test.ts`

Expected: FAIL because the registry does not exist.

- [ ] **Step 3: Implement registry operations**

Use an in-memory `Set` loaded once per run and persist sorted unique IDs after each completed page, not after every comparison. Define:

```ts
export interface PredictionRegistry {
  has(predictionId: string): Promise<boolean>;
  complete(predictionId: string): Promise<void>;
  completePage(predictionIds: string[]): Promise<void>;
  block(predictionId: string): Promise<void>;
  isBlocked(predictionId: string): Promise<boolean>;
  retry(item: RetryItem): Promise<void>;
  dueRetries(now: number): Promise<RetryItem[]>;
  removeRetry(predictionId: string): Promise<void>;
  storageBytes(): Promise<number>;
}
```

Use maximum 5 attempts. Calculate retry delays as `min(30 minutes, 30 seconds * 2 ** attempts)` plus injected jitter. Store blocked ambiguous IDs separately from completed IDs, but treat both as known during discovery. A storage write rejection must propagate so the coordinator can Pause; never continue with an in-memory-only completion. Update `WorkflowCounters.registryBytes` after each persisted page.

- [ ] **Step 4: Run registry tests**

Run: `npm test -- --run tests/prediction-registry.test.ts tests/storage.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit registry support**

```powershell
git add extension/src/background/prediction-registry.ts extension/src/background/storage.ts extension/tests/prediction-registry.test.ts extension/tests/storage.test.ts
git commit -m "feat(extension): persist shared prediction registry"
```

## Task 6: Implement Incremental and Full Predictions Runs

**Files:**
- Create: `extension/src/background/predictions-runner.ts`
- Create: `extension/tests/predictions-runner.test.ts`

- [ ] **Step 1: Write failing scan-policy tests**

Use paginated fakes to cover every critical ordering rule:

```ts
const prediction = (predictionId: string): AgentPrediction => ({
  predictionId,
  opinionId: predictionId.length,
  createdAt: "2026-06-20T00:00:00Z",
});
const page = (items: AgentPrediction[], next: PageRequest | null): ApiPage<AgentPrediction> => ({
  items,
  next,
  fingerprint: items.map((item) => item.predictionId).join(":"),
});
function inMemoryRegistry(known = new Set<string>()): PredictionRegistry {
  const blocked = new Set<string>();
  const retries: RetryItem[] = [];
  return {
    has: async (id) => known.has(id) || blocked.has(id),
    complete: async (id) => { known.add(id); },
    completePage: async (ids) => { ids.forEach((id) => known.add(id)); },
    block: async (id) => { blocked.add(id); },
    isBlocked: async (id) => blocked.has(id),
    retry: async (item) => { retries.push(item); },
    dueRetries: async (now) => retries.filter((item) => item.retryAfter <= now),
    removeRetry: async (id) => {
      const index = retries.findIndex((item) => item.predictionId === id);
      if (index >= 0) retries.splice(index, 1);
    },
    storageBytes: async () => JSON.stringify([...known, ...blocked]).length,
  };
}

it("full scan finds an unknown ID after a known ID", async () => {
  const known = new Set(["known-middle"]);
  const submittedIds: string[] = [];
  let state = structuredClone(DEFAULT_WORKFLOW_STATE);
  const predictionPages = [
    page([prediction("new-first"), prediction("known-middle")], { offset: 2 }),
    page([prediction("new-after-known")], null),
  ];
  await runPredictions({
    api: {
      listAgents: async () => [{ id: 900, name: "Target", active: true, onchain_identity: null }],
      listSquareAgents: async () => ({
        items: [{ id: 3314, name: "Source" }], next: null, fingerprint: "3314",
      }),
      listAgentPredictions: async ({ offset = 0 }) => predictionPages[offset === 0 ? 0 : 1]!,
    },
    walletAddress: "0x" + "11".repeat(20),
    chainId: 16661,
    registry: inMemoryRegistry(known),
    checkpoint: {
      load: async () => state,
      save: async (next) => { state = structuredClone(next); },
    },
    submitPrediction: async (_target, item) => {
      submittedIds.push(item.predictionId);
      return { kind: "approved", txHash: `0x${item.opinionId}` };
    },
    isPaused: () => false,
    onProgress: () => undefined,
  }, { scan: "full", targetAgentId: 900 });
  expect(submittedIds).toEqual(["new-first", "new-after-known"]);
});

```

Export `DEFAULT_WORKFLOW_STATE` from storage for deterministic tests. Extend the same concrete fakes to cover: incremental reads page zero for persisted sources `3314` and `4420`; all Square pages during full scan; repeated-page rejection; persisted resume from `squareOffset` and `predictionOffsets`; target ownership validation; successful completion; permanent skip; retryable failure; ambiguous blocking; dry-run not completing an ID; and Pause between items.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test -- --run tests/predictions-runner.test.ts`

Expected: FAIL because the runner does not exist.

- [ ] **Step 3: Implement full source enumeration and scan selection**

Define the entry point:

```ts
export type PredictionScan = "incremental" | "full";

export type PredictionsRunnerDeps = {
  api: Pick<EvoEvoApiClient,
    "listAgents" | "listSquareAgents" | "listAgentPredictions"
  >;
  walletAddress: string;
  chainId: number;
  registry: PredictionRegistry;
  checkpoint: {
    load: () => Promise<WorkflowState>;
    save: (state: WorkflowState) => Promise<void>;
  };
  submitPrediction: (
    targetAgentId: number,
    prediction: AgentPrediction,
  ) => Promise<SubmitOutcome>;
  isPaused: () => boolean;
  onProgress: (update: {
    sourceAgents?: number;
    scannedDelta?: number;
    addedDelta?: number;
    skippedDelta?: number;
    failedDelta?: number;
  }) => void;
};

export async function runPredictions(
  deps: PredictionsRunnerDeps,
  args: { targetAgentId: number; scan: PredictionScan },
): Promise<RunnerResult>;
```

For `full`, enumerate every Square page and persist the complete `sourceAgentIds` set. Persist `squareOffset` after each Square page and `predictionOffsets[sourceAgentId]` after each prediction page, then clear those offsets only when the corresponding scan completes. Resume from stored offsets after interruption. For `incremental`, fetch the newest Square page to discover recent sources and merge it with persisted sources. Query page zero for every known source; continue through additional pages only while the page contains an unknown ID or the API continuation is required by a pending retry. Do not stop inside a page at the first known ID. The scheduled full scan remains responsible for unknown IDs beyond an all-known incremental page.

- [ ] **Step 4: Implement per-prediction processing**

For each unknown normalized prediction:

```ts
const outcome = await deps.submitPrediction(targetAgentId, prediction);
if (outcome.kind === "approved") await deps.registry.complete(prediction.predictionId);
if (outcome.kind === "dry_run") continue;
if (outcome.kind === "rejected" && outcome.retryable) {
  await deps.registry.retry(makeRetry(prediction, targetAgentId));
}
if (outcome.kind === "rejected" && !outcome.retryable) {
  await deps.registry.complete(prediction.predictionId);
  deps.onProgress({ skippedDelta: 1 });
}
if (outcome.kind === "ambiguous") {
  await deps.registry.block(prediction.predictionId);
  return { kind: "failed", reason: outcome.reason, global: true };
}
```

The production `submitPrediction` calls `memoryFromOpinion(targetAgentId, prediction.opinionId)` and then the shared `submitIntake`. It converts exhausted transient API errors into retryable outcomes and permanent conversion errors into non-retryable outcomes.

Process due retries before discovering new items. Bind each retry to its original `targetAgentId`. Batch newly completed IDs at a page boundary, but persist a successful ID before allowing a target change or finishing the cycle. An ambiguous broadcast is blocked from automatic replay and surfaced as a visible failure requiring manual chain/API inspection.

- [ ] **Step 5: Run Predictions tests**

Run: `npm test -- --run tests/predictions-runner.test.ts`

Expected: PASS, including unknown-known-unknown and no replay after target change.

- [ ] **Step 6: Commit Predictions runner**

```powershell
git add extension/src/background/predictions-runner.ts extension/tests/predictions-runner.test.ts
git commit -m "feat(extension): add prediction memory workflow"
```

## Task 7: Build the Persistent Sequential Coordinator

**Files:**
- Create: `extension/src/background/workflow-coordinator.ts`
- Create: `extension/tests/workflow-coordinator.test.ts`
- Modify: `extension/tests/fixtures/chrome-api.ts`
- Modify: `extension/manifest.json`
- Modify: `extension/tests/manifest.test.ts`

- [ ] **Step 1: Extend fake Chrome with deterministic alarms**

Add an alarm store and listener dispatcher supporting `create`, `clear`, `get`, and `_fire(name)`. Add the real manifest permission assertion:

```ts
expect(manifest.permissions).toContain("alarms");
```

- [ ] **Step 2: Write failing coordinator state-machine tests**

Test these named behaviors:

```text
Run Feed executes Feed and schedules one next cycle
Run Predictions selects incremental unless reconciliation is due
Run Both awaits Feed before starting Predictions
two Run commands never overlap
interval starts after cycle completion
changed interval applies to the next alarm
Pause clears the alarm and stops before the next item
Pause remains paused after coordinator recreation
running state recreates a missing alarm after worker restart
storage failure changes status to paused with a visible error
```

Use deferred promises to prove max concurrency is one:

```ts
expect(callOrder).toEqual(["feed:start"]);
feed.resolve();
await running;
expect(callOrder).toEqual(["feed:start", "feed:end", "predictions:start"]);
```

- [ ] **Step 3: Run tests and verify failure**

Run: `npm test -- --run tests/workflow-coordinator.test.ts tests/manifest.test.ts`

Expected: FAIL because the coordinator and alarms permission do not exist.

- [ ] **Step 4: Implement the coordinator with one promise lock**

Expose:

```ts
export class WorkflowCoordinator {
  start(mode: WorkflowMode): Promise<{ started: boolean }>;
  pause(): Promise<void>;
  status(): Promise<WorkflowState>;
  recover(): Promise<void>;
  handleAlarm(name: string): Promise<void>;
}
```

Use alarm name `workflow-cycle`. `start()` persists `running` before launching. `runCycle()` reuses one `runningPromise`; Both awaits Feed and then Predictions. At cycle completion, read the latest config and schedule `Date.now() + repeatIntervalMinutes * 60_000`. Determine a full Predictions run with:

```ts
const fullDue = state.lastReconciliationAt === null ||
  now - state.lastReconciliationAt >= config.reconciliationIntervalMinutes * 60_000;
```

`pause()` persists `paused`, clears the alarm, and makes `isPaused()` true. The active transaction finishes; runners stop before their next item. `recover()` does nothing when persisted state is paused, recreates the alarm for future `nextRunAt`, and immediately runs a due cycle when persisted state is running.

Persist Feed progress events and both runners' counters as they arrive. Update `lastIncrementalAt` or `lastReconciliationAt` only after the corresponding Predictions run completes. A global runner failure, exhausted auth/API retry, ambiguous broadcast, or storage failure sets `status: "paused"`, clears the alarm, and exposes `lastError`; Both must not start Predictions after a global Feed failure.

- [ ] **Step 5: Run coordinator and manifest tests**

Run: `npm test -- --run tests/workflow-coordinator.test.ts tests/manifest.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit scheduling and coordination**

```powershell
git add extension/src/background/workflow-coordinator.ts extension/tests/workflow-coordinator.test.ts extension/tests/fixtures/chrome-api.ts extension/manifest.json extension/tests/manifest.test.ts
git commit -m "feat(extension): coordinate sequential workflow modes"
```

## Task 8: Wire the Background Router and Recovery Lifecycle

**Files:**
- Modify: `extension/src/background/index.ts`
- Modify: `extension/tests/background-router.test.ts`

- [ ] **Step 1: Write failing router tests for the new commands**

Inject or spy on the coordinator and assert exact routing:

```ts
it.each([
  ["run-feed", "feed"],
  ["run-predictions", "predictions"],
  ["run-both", "both"],
] as const)("routes %s to mode %s", async (type, mode) => {
  expect(await controller.handleMessage({ type })).toMatchObject({ ok: true });
  expect(coordinator.start).toHaveBeenLastCalledWith(mode);
});
```

Also assert `get-status` returns coordinator state and counters, Pause calls `coordinator.pause()`, invalid target/config refuses Predictions, alarm events call `handleAlarm`, and startup calls `recover()`.

- [ ] **Step 2: Run router tests and verify failure**

Run: `npm test -- --run tests/background-router.test.ts`

Expected: FAIL because `index.ts` still owns the old 30-second loop.

- [ ] **Step 3: Replace the old loop with a constructed controller**

Delete `ROUND_INTERVAL_MS`, `directLoopRunning`, `stopResolve`, and `startAutomation()`. Construct shared wallet, API, RPC factory, registry, runners, and coordinator once. Keep SIWE token persistence in `chrome.storage.session`.

Register:

```ts
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  controller.handleMessage(message).then(sendResponse);
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  void coordinator.handleAlarm(alarm.name);
});

void coordinator.recover();
```

Broadcast one typed `workflow-event` message for progress changes. Catch `sendMessage` rejection because the side panel may be closed.

- [ ] **Step 4: Run all background tests**

Run: `npm test -- --run tests/background-router.test.ts tests/workflow-coordinator.test.ts tests/feed-workflow.test.ts tests/predictions-runner.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit background integration**

```powershell
git add extension/src/background/index.ts extension/tests/background-router.test.ts
git commit -m "feat(extension): route dual workflow controls"
```

## Task 9: Build the Taste-Led Operational Console

**Required skills before editing:** `design-taste-frontend`, then `frontend-ui-engineering`; use `impeccable` for the final polish pass.

**Files:**
- Modify: `extension/src/ui/popup.html`
- Modify: `extension/src/ui/popup.ts`
- Create: `extension/tests/popup.test.ts`

- [ ] **Step 1: Write failing happy-dom interaction tests**

Add `// @vitest-environment happy-dom` and mock `chrome.runtime.sendMessage`. Test:

```text
Feed tab hides the target selector and shows owned-agent progress
Predictions tab shows the target selector and prediction counters
Run Both sends set-config before run-both
Pause sends pause and disables no unrelated settings
running status disables all Run commands
30 and 1440 are accepted interval boundaries
29 and 1441 show inline validation and send no command
long agent names and errors remain text content, never innerHTML
```

- [ ] **Step 2: Run the UI test and verify failure**

Run: `npm test -- --run tests/popup.test.ts`

Expected: FAIL because the operational-console controls do not exist.

- [ ] **Step 3: Replace the popup information architecture**

Keep setup/key import as a separate state. In ready state, use this hierarchy:

```html
<header class="app-header">wallet identity + compact status</header>
<nav class="workflow-tabs" aria-label="Workflow view">
  <button role="tab" data-tab="feed">Feed</button>
  <button role="tab" data-tab="predictions">Predictions</button>
</nav>
<section id="feed-panel" role="tabpanel">agent progress + Feed counters</section>
<section id="predictions-panel" role="tabpanel">target + scan counters</section>
<details class="advanced">network, intervals, guardrails, dry-run</details>
<footer class="command-bar">Run Feed, Run Predictions, Run Both, Pause</footer>
```

Do not nest cards. Use full-width bands, hairline separators, stable two-column metric rows, 7px maximum radii, and familiar controls. Use neutral graphite surfaces, off-white text, restrained orange accent, and semantic green/yellow/red. Remove the radial and linear decorative gradients and fix every mojibake string.

- [ ] **Step 4: Implement typed rendering and command wiring**

Create small functions with no framework:

```ts
function renderStatus(status: WorkflowPublicStatus): void;
function selectTab(tab: "feed" | "predictions"): void;
function readConfig(): ExtensionConfig;
function validateIntervals(config: ExtensionConfig): string | null;
async function saveThenRun(type: "run-feed" | "run-predictions" | "run-both"): Promise<void>;
```

Use `textContent` for API-derived labels and events. Poll `get-status` every two seconds while the panel is open and also react to `workflow-event`. Preserve the selected UI tab locally without changing workflow execution.

- [ ] **Step 5: Run UI tests and build**

Run separately:

```powershell
npm test -- --run tests/popup.test.ts
npm run typecheck
npm run build
```

Expected: popup tests PASS, TypeScript exits 0, and build prints `Built dist/`.

- [ ] **Step 6: Perform the Impeccable polish pass**

Audit actual 380px width for text clipping, control height shifts, focus visibility, disabled states, scroll behavior, contrast, label alignment, and status color misuse. Keep command labels concise and remove explanatory feature copy from the visible UI.

- [ ] **Step 7: Commit the console**

```powershell
git add extension/src/ui/popup.html extension/src/ui/popup.ts extension/tests/popup.test.ts
git commit -m "feat(extension): add dual workflow console"
```

## Task 10: End-to-End Regression and Extension Verification

**Files:**
- Modify only if a verification failure requires a scoped fix.

- [ ] **Step 1: Run the complete automated suite**

Run: `npm test`

Expected: all test files and tests PASS.

- [ ] **Step 2: Run static verification**

Run separately:

```powershell
npm run typecheck
npm run build
```

Expected: both commands exit 0 and `extension/dist` contains `background.js`, `popup.js`, `popup.html`, and `manifest.json`.

- [ ] **Step 3: Load and inspect the unpacked extension**

Load `extension/dist` through `chrome://extensions` with Developer mode enabled. Open the side panel and verify:

```text
setup and ready states render without encoding artifacts
Feed and Predictions tabs switch without layout shift
interval controls enforce 30-1440 minutes
Run buttons become disabled while active
Run Both reports Feed before Predictions
Pause waits for the current transaction and then remains paused
closing and reopening the panel preserves state
restarting the extension does not resume a user-paused workflow
no popup or service-worker console errors appear
```

- [ ] **Step 4: Verify one dry-run cycle with authenticated API data**

Enable Dry-run, choose a Predictions target, set both intervals to safe values, and run Both. Confirm all owned Feed agents execute sequentially, Square pagination discovers source agents, Predictions emits no signed transaction, and no Bearer token or private key appears in logs or persisted workflow events.

- [ ] **Step 5: Inspect repository scope and commit final scoped fixes**

Run separately from the repository root:

```powershell
git status --short
git diff --check
git diff --stat 8f29b75..HEAD
```

Expected: no whitespace errors, no generated `dist` files staged, and changes remain limited to the extension plus approved docs.

If Step 3 or 4 required a fix, rerun Steps 1-4 and commit only that fix:

```powershell
git add extension/src extension/tests extension/manifest.json
git commit -m "fix(extension): address dual workflow verification"
```
