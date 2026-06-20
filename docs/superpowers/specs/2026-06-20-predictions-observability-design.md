# Predictions Workflow Observability Design

## Problem

The Predictions workflow can appear idle after the user starts it. Progress callbacks are currently discarded, the side panel does not receive prediction-level activity, and a semantic EvoEvo response such as HTTP 409 with `{ "error": "already adopted" }` escapes as an exception. That exception stops the coordinator even though the selected target agent already has the requested memory and no transaction is required.

## Goals

- Treat only the semantic `already adopted` response as a successful skip.
- Continue processing the remaining predictions after that skip.
- Show live, prediction-level activity in the side panel.
- Keep workflow counters synchronized with the activity stream.
- Preserve the existing safety behavior for ambiguous transactions and unexpected errors.

## Non-Goals

- Do not persist a complete, indefinitely retained workflow event ledger.
- Do not change prediction discovery, pagination, reconciliation, or shared bookmark semantics.
- Do not allow Feed and Predictions to run concurrently.
- Do not change transaction receipt polling or retry intervals.

## Architecture

### Semantic API Outcome

The submission boundary will distinguish an exact EvoEvo `already adopted` response from generic HTTP failures. The match requires HTTP status 409 and the normalized API error value `already adopted`; other 409 responses remain errors.

The prediction submission result gains an explicit `already_adopted` outcome. This avoids parsing exception text inside the runner and gives the runner a stable business result to process.

### Runner Behavior

For each prediction, the runner emits structured progress containing the source agent ID, target agent ID, prediction ID, phase, and optional transaction hash or reason.

The relevant phases are:

- `scanning`
- `submitting`
- `confirmed`
- `already_adopted`
- `skipped`
- `failed`

When the result is `already_adopted`, the runner:

1. Marks the prediction ID complete in the shared registry.
2. Increments the skipped counter.
3. Emits an `already_adopted` progress event.
4. Continues to the next prediction without broadcasting a transaction.

### Background Coordination

The background layer connects the runner's progress callback instead of discarding it. Each progress event updates the persisted workflow counters and is broadcast to the open side panel as a workflow event. A concise skipped attempt is also appended to the existing session log so the outcome remains inspectable outside the transient activity list.

### Side Panel

The side panel appends human-readable activity lines as workflow events arrive and refreshes status counters from workflow state. Representative messages are:

```text
[Predictions] Loading Square feed...
[Predictions] Found 20 source agents
[Predictions] Source 3314 - Prediction 859 - Already added, skipped
[Predictions] Source 60062 - Prediction 852 - Submitting...
[Predictions] Source 60062 - Prediction 852 - Confirmed - 0x1234...
```

Closing the panel may discard visible activity lines, but counters and the existing session log remain available. A durable full activity history is intentionally out of scope.

## Error Handling

- Exact `409 already adopted`: mark complete, log, increment skipped, and continue.
- Other HTTP 409 responses: preserve failure behavior and expose the response reason.
- HTTP 429, server failures, and transient network errors: use the existing retry policy.
- Transaction receipt timeout: block the prediction and stop the workflow globally to avoid duplicate submission.
- Transaction revert or non-retryable submission failure: log source agent, prediction ID, and reason; apply the existing skip/failure policy.
- User pause: stop before starting another prediction; an already awaited API or receipt operation is allowed to settle safely.

## Data And State

The existing shared prediction registry remains the source of truth for deduplication across target agents. An `already adopted` prediction is added to that registry because the selected target already owns the memory and the user explicitly chose a shared bookmark.

No new long-lived storage collection is introduced. Existing workflow counters and session logs are reused.

## Testing

Automated tests will cover:

- Exact `409 already adopted` maps to `already_adopted`.
- A different 409 remains an error.
- The runner marks an already-adopted prediction complete and processes the next prediction.
- Skipped counters and structured activity events contain the correct source agent and prediction IDs.
- Submission emits `submitting` before transaction work and `confirmed` only after a successful receipt.
- Receipt timeout still stops the workflow and blocks automatic replay.
- Popup event rendering formats already-adopted, submitting, confirmed, and failed states.

The extension test suite, typecheck, and production build must pass after implementation.
