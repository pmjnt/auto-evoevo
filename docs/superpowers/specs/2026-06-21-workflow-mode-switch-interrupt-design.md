# Workflow Mode Switch Interrupt Design

## Problem

The popup exposes three run buttons: `Run Feed`, `Run Predictions`, and `Run Both`. Today, pressing one of those buttons while another workflow cycle is already active updates `workflowState.mode`, but it does not interrupt the in-flight cycle.

That makes the UI misleading. For example, if Predictions is currently running and the user presses `Run Feed`, the stored mode becomes `feed`, but the old Predictions runner can keep processing because `WorkflowCoordinator.launchCycle()` ignores the new request while `this.running !== null`, and `pauseRequested` remains `false`.

## Goal

When the user presses a run button while a workflow is active, the extension should switch to that mode immediately:

- Pressing `Run Feed` stops the active Predictions/Both cycle and then starts Feed-only.
- Pressing `Run Predictions` stops the active Feed/Both cycle and then starts Predictions-only.
- Pressing `Run Both` stops the active single-mode cycle and then starts Both.
- Pressing `Pause` still means stop completely; it must not auto-restart.

## Non-Goals

- Do not add a confirmation dialog.
- Do not force-kill JavaScript execution. Runners stop cooperatively at existing pause checkpoints.
- Do not reset prediction scan checkpoints as part of switching modes.
- Do not change feed or predictions business logic beyond respecting the switch.

## Current Behavior

`WorkflowCoordinator.start(mode)` currently:

1. writes `state.mode = mode`,
2. sets `status = "running"`,
3. clears `activeWorkflow`, `nextRunAt`, and `lastError`,
4. sets `pauseRequested = false`,
5. calls `launchCycle()`.

`launchCycle()` returns early when `this.running !== null`. Therefore, if a cycle is already running, the new mode is stored but no new cycle starts. The old cycle continues because `pauseRequested` was set to `false`.

Inside `runCycle()`, the coordinator reads state after Feed finishes and can then decide whether Predictions should run. However, this does not help if the old active runner is already inside `runPredictions()`: that runner only stops when `deps.isPaused()` returns true or when it naturally completes.

## Proposed Behavior

Add cooperative mode switching to `WorkflowCoordinator`:

- `start(mode)` with no active cycle behaves as it does today.
- `start(mode)` with an active cycle records the requested mode as `pendingMode`, sets `pauseRequested = true`, clears any scheduled alarm, and leaves the current runner to return `{ kind: "paused" }` at its next checkpoint.
- When the active cycle exits, the coordinator consumes `pendingMode`, writes the new mode to state, resets `pauseRequested = false`, and launches a new cycle.
- If multiple run buttons are pressed quickly, only the last requested mode is kept.
- `pause()` clears `pendingMode`, sets status to `paused`, and prevents restart.

## State Model

This should be internal coordinator state, not persisted workflow state:

```ts
private pendingMode: WorkflowMode | null = null;
```

The persisted `WorkflowState.mode` remains the currently selected mode. During an active switch, it can be updated immediately for UI feedback, but restart behavior must be driven by the internal `pendingMode` to avoid confusing user pause with mode switch.

## Coordinator Flow

### `start(mode)`

If `this.running === null`:

```ts
await this.activateMode(mode);
this.pauseRequested = false;
this.launchCycle();
return { started: true };
```

If `this.running !== null`:

```ts
this.pendingMode = mode;
await this.activateMode(mode);
this.pauseRequested = true;
await chrome.alarms.clear(WORKFLOW_ALARM_NAME);
return { started: true };
```

`activateMode(mode)` is a small helper that applies the standard state transition:

```ts
state.mode = mode;
state.status = "running";
state.activeWorkflow = null;
state.nextRunAt = null;
state.lastError = null;
```

### `pause()`

`pause()` must cancel pending mode switches:

```ts
this.pendingMode = null;
this.pauseRequested = true;
state.status = "paused";
state.activeWorkflow = null;
state.nextRunAt = null;
```

### Cycle Finalization

When a cycle finishes, the `.finally(...)` handler should:

1. set `this.running = null`,
2. read and clear `pendingMode`,
3. if a pending mode exists, reset `pauseRequested = false`,
4. launch a new cycle for that mode.

This restart must happen only after the old cycle has unwound, so the coordinator never runs Feed and Predictions concurrently.

## Interaction With Existing Runners

Both Feed and Predictions already receive `isPaused()` from the coordinator. This design relies on that existing cooperative cancellation path.

For Predictions:

- If switching modes during a source scan, `processSource()` returns `paused` at the next page/prediction checkpoint.
- The current source is not marked complete unless `processSource()` returns `completed`.
- Existing checkpoint behavior stays correct.

For Feed:

- Feed runner should stop at its existing pause checkpoints.
- A mode switch should not count as a user pause, because the coordinator will auto-start the pending mode afterward.

## Error Handling

- If the old cycle fails globally while a mode switch is pending, the coordinator should pause with the error and clear `pendingMode`. A real failure should not be hidden by auto-restart.
- If the old cycle returns `paused` because of mode switch, the coordinator should not call `pause()` in a way that clears pending restart.
- If the user presses `Pause` after pressing another run button, `pause()` wins and clears `pendingMode`.

## UI Behavior

The popup can keep the existing buttons. No new controls are required.

After clicking `Run Feed` while Predictions is active:

- the button request returns `{ ok: true, started: true }`,
- state mode becomes `feed`,
- active workflow may briefly still be `predictions` until the runner reaches a checkpoint,
- then active workflow switches to `feed`.

This is acceptable. The event log can later be improved with a "Switching to Feed..." line, but that is not required for the first fix.

## Testing

Add coordinator tests:

1. Active Predictions interrupted by `start("feed")`:
   - `runPredictions` should observe `coordinator.isPaused() === true`,
   - return `{ kind: "paused" }`,
   - then `runFeed` should execute,
   - `runPredictions` should not run again in the restarted feed-only cycle.

2. Active Feed interrupted by `start("predictions")`:
   - old feed returns paused,
   - restarted cycle runs predictions-only.

3. Multiple quick switches:
   - `start("feed")`, then `start("both")` while old cycle is still unwinding,
   - final restarted mode is `both`.

4. User pause wins:
   - while a pending switch exists, call `pause()`,
   - no restarted cycle runs.

5. Existing normal start behavior remains unchanged when no cycle is active.

## Acceptance Criteria

- Pressing `Run Feed` while Predictions is running stops Predictions at the next checkpoint and starts Feed.
- Pressing `Run Predictions` while Feed is running stops Feed at the next checkpoint and starts Predictions.
- Pressing `Run Both` while another mode is running stops the current cycle and starts Both.
- Feed and Predictions never run concurrently.
- User `Pause` still stops completely and does not auto-restart.
- Existing repeat scheduling remains unchanged after the newly selected mode completes.
- Full test suite, typecheck, and build pass.

## Notes

This design intentionally keeps cancellation cooperative. It avoids trying to abort in-flight HTTP/RPC calls, because the existing runners already have pause checks around meaningful units of work. The visible switch may therefore take until the current API call or transaction wait completes, but it will not start the new mode concurrently with the old one.
