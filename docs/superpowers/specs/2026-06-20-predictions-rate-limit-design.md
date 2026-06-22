# Predictions Rate Limit Design

## Goal

Reduce `POST /v1/agents/{targetAgentId}/memories/from-opinion` pressure in the Predictions workflow and recover cleanly when EvoEvo still returns rate limiting.

## Current Behavior

Predictions already skips items that are known in the local registry or have `viewer_has_intaken === true` in `/v1/agents/{sourceAgentId}/predictions`. Items that pass those filters call `from-opinion`. The shared EvoEvo API client retries HTTP `429` three times with short exponential backoff. If those retries are exhausted, the error currently bubbles through the workflow path instead of becoming a long cooldown/resume state.

`cooldownSeconds` is already used after a successful on-chain receipt. That setting remains post-transaction pacing and should not be reused for API throttling.

## Required Behavior

The Predictions workflow should use this order for every prediction:

```text
if local registry already knows prediction:
  skip

if prediction.viewer_has_intaken === true:
  mark completed
  log skipped viewer_has_intaken
  do not call from-opinion
  continue

wait memoryApiCooldownSeconds

POST /v1/agents/{targetAgentId}/memories/from-opinion

if 409 already adopted:
  mark completed
  log skipped already_adopted
  continue

if 429 persists after API-client retries:
  save current checkpoint/state
  set nextRunAt = now + rateLimitBackoffMinutes
  stop the current run
  allow automatic resume only if the user has not pressed Pause

if ready:
  sign + broadcast tx
  wait receipt success
  wait cooldownSeconds
  continue
```

## Config

Add two config fields:

- `memoryApiCooldownSeconds`: integer seconds, min `0`, max `60`, default `1`.
- `rateLimitBackoffMinutes`: integer minutes, min `1`, max `1440`, default `15`.

Keep existing `cooldownSeconds` unchanged as the post-receipt transaction cooldown.

## Rate Limit Detection

Use `EvoEvoHttpError` with `status === 429` after the API client's internal retries are exhausted. Other retryable errors can continue to use the existing retry queue behavior unless they are explicitly identified as `429`.

## Workflow State

When rate limited, the workflow should preserve enough state to resume without reprocessing completed predictions:

- already completed/skipped predictions remain in the registry
- source-agent list remains in workflow state
- workflow scheduler sets `nextRunAt` using `rateLimitBackoffMinutes`

If the user presses Pause, the existing manual pause semantics win: no automatic resume should be scheduled or executed from that pause.

## UI

Expose both new settings near existing pacing controls:

- `Memory API cooldown (s)`
- `Rate limit backoff (m)`

The activity log should show a concise event when rate limited, for example:

```text
[Predictions] Rate limited. Retrying in 15 minutes.
```

## Testing

Add tests for:

- predictions with `viewer_has_intaken === true` do not call `from-opinion`
- `memoryApiCooldownSeconds` waits before `from-opinion` for items that need API submission
- exhausted `429` produces a rate-limit result instead of continuing to spam calls
- coordinator schedules `nextRunAt` for rate-limit outcomes unless the user paused
- config schema accepts defaults and persists the new fields
