# Dual Workflow Prediction Intake Design

## Goal

Extend the Chrome extension with a second workflow that discovers agents from EvoEvo Square, reads their predictions, and adds every supported prediction as memory to one selected owned target agent. Keep the existing Feed workflow, allow either workflow to run independently, and provide a `Run Both` command that executes them sequentially.

## Confirmed Behavior

### Feed workflow

- `Run Feed` loads every agent owned by the authenticated wallet.
- It runs the existing Feed intake behavior for each owned agent in sequence.
- It preserves the existing Feed tab semantics and guardrails.
- It finishes one agent before moving to the next.

### Predictions workflow

- Source agents come from every page of:

  `GET /v1/square/feed?status=all&min_settled_predictions=3&type=agent&chain_id={chainId}`

- Predictions come from every page of:

  `GET /v1/agents/{sourceAgentId}/predictions?chain_id={chainId}`

- The workflow deduplicates predictions by their immutable prediction ID, never by their position in a date-sorted response.
- Every supported, previously undiscovered prediction is converted through the existing memory-from-opinion path and submitted to the selected owned target agent.
- A prediction that cannot be converted or submitted permanently is recorded as skipped so it does not retry forever.
- The first Predictions run performs a complete backfill into the currently selected target.
- If the user later selects another target, previously discovered predictions are not replayed. Only predictions discovered after the target change are submitted to the new target.

### Combined execution

- `Run Both` runs the complete Feed workflow first, then the Predictions workflow.
- After both workflows finish, the coordinator waits for the configured repeat interval and repeats the same sequence while the mode remains running.
- Feed agents, workflows, signing, and transaction submission never run concurrently.
- A single coordinator owns the queue and permits at most one active workflow and one in-flight transaction.

## Architecture

### Workflow coordinator

Add a background coordinator responsible for:

- accepting `Run Feed`, `Run Predictions`, `Run Both`, and `Pause` commands;
- persisting the queued command and active workflow;
- executing jobs in order;
- enforcing a global execution lock;
- exposing unified status and per-workflow progress to the popup;
- resuming an interrupted job from persisted progress after the service worker restarts.

The coordinator invokes two focused runners. Shared authentication, API transport, transaction construction, guardrails, signing, broadcasting, and receipt handling remain common services rather than being duplicated.

### Feed runner

Refactor the current direct runner only as needed to accept an explicit target agent. The coordinator obtains all wallet-owned agents and invokes the runner once for each agent. Existing Feed behavior remains otherwise unchanged.

### Predictions runner

The Predictions runner has four responsibilities:

1. Enumerate all Square source agents using server pagination.
2. Enumerate all prediction pages for each source agent.
3. Compare immutable prediction IDs with the shared registry.
4. Convert and submit new supported predictions to the selected target agent.

API response parsing must use typed structures and explicit pagination metadata. The implementation must not infer pagination or identifiers from display positions.

## Registry and Checkpoints

Persist state in `chrome.storage.local`. Discovery state is shared across target agents, as requested.

The stored state includes:

- schema version;
- active and queued workflow;
- Feed progress by owned agent and Feed tab;
- Square pagination progress during an interrupted full scan;
- prediction pagination progress by source agent during an interrupted full scan;
- a compact set of discovered immutable prediction IDs;
- a bounded retry queue with attempt count and next retry time;
- timestamps for the last incremental scan and full reconciliation;
- counters and the latest operational events for UI display.

Do not use `P1`, `P2`, page position, or the first previously known item as a durable boundary. A date-descending list may contain an unknown prediction after a known prediction.

Version 1 retains discovered IDs indefinitely. Removing an old ID would make it appear new during a later reconciliation and could replay it to a different target. Storage usage must be reported in status, and a storage write failure must pause the workflow instead of silently losing deduplication state.

## Scan Strategy

- `Run Feed` selects Feed mode, runs immediately, and repeats Feed after the configured repeat interval until the user pauses.
- `Run Predictions` selects Predictions mode, runs immediately, and repeats Predictions after the configured repeat interval until the user pauses.
- `Run Both` selects Both mode, runs Feed and then Predictions immediately, and repeats that ordered pair after the configured repeat interval until the user pauses.
- The repeat interval is configurable from 30 minutes through 24 hours and defaults to two hours.
- The interval starts after the current cycle completes, so a long cycle cannot overlap the next cycle.
- A changed interval takes effect when scheduling the next cycle.
- While Predictions or Both mode is running, Predictions performs a fast incremental scan on each repeat cycle.
- While Predictions or Both mode remains running, Predictions performs a complete reconciliation of every source and prediction page when its independently configured reconciliation interval is due.
- The reconciliation interval is configurable from 30 minutes through 24 hours and defaults to 24 hours.
- `Pause` prevents the next item from starting but does not interrupt an in-flight transaction.
- A user Pause cancels the next scheduled cycle and persists the paused state. Browser or extension restart must not resume automatically.
- Work resumes only after the user explicitly presses `Run Feed`, `Run Predictions`, or `Run Both`.
- All timers are advisory. Persisted timestamps determine whether work is due after a service worker restart.

Incremental scans inspect the newest prediction pages and deduplicate by ID. They must not stop solely because one known ID is encountered. The scheduled complete reconciliation is the correctness mechanism for late insertion and unknown-known-unknown gaps.

## Target Semantics

- Feed has no single selected target; it processes all agents owned by the wallet.
- Predictions has exactly one selected target agent, validated against the wallet-owned agent list before execution.
- Discovery and deduplication are global across target changes.
- Changing the Predictions target does not trigger historical replay or a new backfill.

## Failure Handling

- Transient network failures and HTTP 429 responses retry with bounded exponential backoff and jitter.
- Authentication failure triggers one re-authentication attempt. If it still fails, the coordinator pauses and surfaces the error.
- Permanent unsupported-item errors are recorded as skipped and processing continues.
- A prediction is marked completed only after a successful receipt.
- Before retrying an ambiguous transaction result, check whether the target already intook the item. Do not knowingly submit a duplicate transaction.
- One source agent or prediction failure does not abort unrelated items unless the error is global, such as invalid authentication, invalid chain configuration, or unavailable signing credentials.
- Retry state is bounded. Exhausted retries become visible failures instead of looping indefinitely.

## Popup UI Direction

Use a compact operational console in the existing extension popup.

- Show one shared status strip with wallet, active workflow, queue state, and current action.
- Use a segmented `Feed` / `Predictions` control for workflow-specific status and configuration.
- Feed displays owned-agent progress without an active-agent selector.
- Predictions displays the target-agent selector and counts for sources scanned, predictions discovered, added, skipped, and failed.
- Provide compact numeric controls for the repeat interval and full-reconciliation interval, with clear hour/minute units and range validation.
- Provide clear commands for `Run Feed`, `Run Predictions`, `Run Both`, and `Pause`.
- Disable incompatible run commands while a job is active so duplicate jobs cannot be queued accidentally.
- Move network, guardrail, and low-frequency controls into a compact collapsible Advanced section.
- Fix existing text-encoding artifacts.

The visual direction is a restrained work console: neutral graphite surfaces, warm orange as a limited brand accent, and green/yellow/red reserved for status. Avoid decorative gradients, nested cards, excessive pills, oversized typography, and generic dashboard composition. Controls must remain legible and stable at the popup's actual width.

The implementation UI skill sequence is:

`design-taste-frontend -> frontend-ui-engineering -> impeccable`

## Testing and Verification

Automated tests should cover:

- pagination across all Square agent pages;
- pagination across every source agent's predictions;
- deduplication by immutable prediction ID;
- an unknown-known-unknown prediction ordering;
- initial backfill and incremental discovery;
- no historical replay after changing the target;
- sequential Feed execution for all wallet-owned agents;
- strict Feed-before-Predictions ordering for `Run Both`;
- global exclusion of concurrent workflow or transaction execution;
- repeat and reconciliation interval validation, rescheduling, and non-overlap;
- pause/resume boundaries;
- persisted recovery after service worker restart;
- transient retry, exhausted retry, skipped item, authentication failure, and ambiguous receipt handling.

Before completion, run the repository's unit tests, typecheck, and build. Load the built extension and verify the popup at its real dimensions, including tab switching, command disabled states, progress updates, error states, text overflow, and absence of console errors.

## Out of Scope

- Running Feed and Predictions concurrently.
- Replaying historical predictions into a newly selected target.
- Adding arbitrary source agents outside the Square feed query.
- Replacing EvoEvo APIs or the existing on-chain intake contract flow.
- A separate full-page dashboard or options application.
